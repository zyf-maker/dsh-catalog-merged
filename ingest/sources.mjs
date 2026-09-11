/**
 * Source registry — every place the market reads plugin data from.
 *
 * Two kinds, and the difference matters:
 *   - `catalog`: a machine-readable catalog (json snapshot or API) published by
 *     a community directory. These are what the market merges.
 *   - `harvest`: a raw discovery channel (GitHub topic, npm keyword) that finds
 *     plugins nobody has cataloged yet.
 *
 * `discoverSources()` adds new `catalog` sources at runtime: mainstream
 * directories appear and disappear faster than any hand-written list, so the
 * market watches GitHub for repositories that look like a plugin directory and
 * probes each one for a machine-readable catalog before trusting it.
 */

/** Catalogs with a known, stable machine-readable address. */
export const SEED_SOURCES = [
  {
    id: 'awesome-dsh-plugin',
    name: 'awesome-dsh-plugin (curated)',
    kind: 'catalog',
    url: 'https://awesome-dsh-plugin.com/plugins.json',
    pick: (r) => r.plugins,
    note: 'curated list; every entry installs with `dsh plugin add`',
  },
  {
    id: 'dshget',
    name: 'DSH Get',
    kind: 'catalog',
    url: 'https://raw.githubusercontent.com/bobby-sheng/dshget-data/main/catalog.json',
    pick: (r) => r.plugins,
    note: 'normalized snapshot of 4 public catalogs',
  },
  {
    id: 'unified-market',
    name: 'dsh-unified-market',
    kind: 'catalog',
    url: 'https://raw.githubusercontent.com/jing-hy/dsh-unified-market/main/data/catalog-snapshot.json',
    pick: (r) => r.plugins,
    note: 'curated snapshot used by the EAC desktop market',
  },
  {
    id: 'oh-my-dsh',
    name: 'Oh-My-DSH',
    kind: 'catalog',
    url: 'https://raw.githubusercontent.com/JohnXu22786/Oh-My-DSH/main/data/plugins.json',
    pick: (r) => r.items ?? (Array.isArray(r) ? r : null),
    // Oh-My is a GitHub-topic scrape; only its own curated `type === 插件`
    // subset is a real plugin, the rest is 项目/渠道/技能/合集/教程.
    requireType: '插件',
    note: 'topic scrape, curated subset only',
  },
  {
    id: 'dshmarketplace',
    name: 'DSH Marketplace',
    kind: 'catalog',
    url: 'https://dshmarketplace.dev/api/v1/plugins?limit=96',
    pick: (r) => r.results ?? r.plugins ?? (Array.isArray(r) ? r : null),
    // Its API caps a page at 96 entries but reports the full total, so the
    // harvester walks pages until the total is reached.
    paginate: { param: 'page', pageSize: 96, totalFrom: (r) => r.total ?? null, firstPage: 1 },
    note: 'public API of the bilingual directory (7.7k entries)',
  },
  {
    id: 'deepseek1024',
    name: 'deepseek1024 (1024 Store)',
    kind: 'catalog',
    url: 'https://api.deepseek1024.com/api/v1/registry',
    pick: (r) => (Array.isArray(r) ? r : r?.plugins ?? r?.items ?? r?.data),
    // Its public registry endpoint answered 404 on every documented path when
    // this list was written (the site still serves its own UI). Kept in the
    // registry so a future endpoint is picked up without a code change, but
    // disabled so a dead host does not spend the run's budget.
    enabled: false,
    note: 'registry API currently 404 — enable when it answers',
  },
]

/** Raw discovery channels. These find plugins, not catalogs. */
export const HARVEST_SOURCES = [
  {
    id: 'github-topic',
    name: 'GitHub topic: dsh-plugin',
    kind: 'harvest',
    url: 'https://api.github.com/search/repositories?q=topic:dsh-plugin&sort=stars&order=desc',
    note: 'the tag the whole ecosystem publishes under',
  },
  {
    id: 'github-topic-dsh',
    name: 'GitHub topic: deepseek-harness',
    kind: 'harvest',
    url: 'https://api.github.com/search/repositories?q=topic:deepseek-harness&sort=stars&order=desc',
    note: 'secondary tag, catches repos that miss dsh-plugin',
  },
  {
    id: 'npm-keyword',
    name: 'npm keywords: dsh-plugin',
    kind: 'harvest',
    url: 'https://registry.npmjs.org/-/v1/search?text=keywords:dsh-plugin&size=250',
    note: 'plugins distributed as npm packages',
  },
]

/**
 * Repositories that are the platform itself, never a plugin. A topic scrape
 * always surfaces these and a plugin market must never rank them.
 */
export const DENY_REPOS = new Set([
  'deepseek-ai/deepseek-harness',
  'deepseek-ai/dsh',
  'deepseek-ai/dsh-base',
  'deepseek-ai/dsh-web-app',
])

/** Entries tagged by their own curator as something that is not a plugin. */
export const DENY_TYPES = new Set(['项目', '渠道', '技能', '合集', '教程', 'project', 'docs'])

/** Repository names that look like a directory worth probing for a catalog. */
const DIRECTORY_HINTS = /(awesome|market|marketplace|store|catalog|directory|hub|list|registry)/i

/** Paths a community directory commonly publishes its machine-readable data at. */
const CATALOG_PROBE_PATHS = [
  'plugins.json',
  'catalog.json',
  'data/plugins.json',
  'data/catalog.json',
  'public/plugins.json',
  'dist/plugins.json',
]

/**
 * Find catalogs the seed list does not know about yet.
 *
 * Deliberately conservative: a repository must look like a directory by name,
 * must not be on the deny list, and must actually serve a catalog with a
 * `plugins`/`items` array before it is enrolled. Two independent signals
 * (name shape + real payload) is what keeps an unrelated repo that merely
 * mentions "marketplace" out of the merge.
 *
 * @param options - `token` for GitHub, `fetchImpl` for tests, `log` for progress.
 * @returns the catalogs found, each ready to be added to the source table.
 */
export async function discoverSources({ token, fetchImpl = fetch, log = () => {}, max = 40 } = {}) {
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'dsh-market-discovery' }
  if (token) headers.authorization = `Bearer ${token}`
  const query = encodeURIComponent('topic:dsh-plugin sort:stars')
  const found = []
  try {
    const res = await fetchImpl(
      `https://api.github.com/search/repositories?q=${query}&sort=stars&order=desc&per_page=${max}`,
      { headers },
    )
    if (!res.ok) { log(`discovery: GitHub search HTTP ${res.status}`); return found }
    const json = await res.json()
    for (const repo of json.items ?? []) {
      const full = repo.full_name ?? ''
      if (!full || DENY_REPOS.has(full)) continue
      if (repo.archived === true) continue
      const name = full.split('/').pop() ?? ''
      const desc = `${repo.description ?? ''} ${name}`
      if (!DIRECTORY_HINTS.test(desc)) continue
      const branch = repo.default_branch ?? 'main'
      for (const path of CATALOG_PROBE_PATHS) {
        const url = `https://raw.githubusercontent.com/${full}/${branch}/${path}`
        const catalog = await probeCatalog(url, fetchImpl)
        if (catalog === null) continue
        found.push({
          id: `discovered:${full.toLowerCase()}`,
          name: full,
          kind: 'catalog',
          url,
          pick: (r) => (Array.isArray(r) ? r : r?.plugins ?? r?.items ?? r?.data),
          discoveredFrom: `github:${full}`,
          note: `auto-discovered directory (${catalog} entries)`,
        })
        log(`discovery: adopted ${full} -> ${path} (${catalog} entries)`)
        break
      }
    }
  } catch (error) {
    log(`discovery: ERR ${error.message}`)
  }
  return found
}

/** Probe one candidate URL; returns the entry count when it is a usable catalog. */
async function probeCatalog(url, fetchImpl) {
  try {
    const res = await fetchImpl(url, { headers: { accept: 'application/json', 'user-agent': 'dsh-market-discovery' } })
    if (!res.ok) return null
    const json = await res.json()
    const list = Array.isArray(json) ? json : json?.plugins ?? json?.items ?? json?.data
    if (!Array.isArray(list) || list.length < 5) return null
    const first = list[0]
    if (first === null || typeof first !== 'object') return null
    // A real plugin entry names itself somehow; this rejects random arrays.
    const looksLikePlugins = ['name', 'url', 'repo', 'full_name', 'npm'].some((k) => k in first)
    return looksLikePlugins ? list.length : null
  } catch {
    return null
  }
}

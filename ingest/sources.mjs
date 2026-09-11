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
    // The catalog lives on the site host, NOT on the developer-API host.
    // `api.deepseek1024.com/v1/…` is documented to serve only the search
    // endpoint and `/v1/health`; every other path there 404s **by design**
    // (verified 2026-09-11), which is why the first source URL never worked and
    // looked like a dead service. The Worker's own API reference states that
    // internal routes under `deepseek1024.com/api/v1/` are backward compatible
    // within their major version, and `/api/v1/plugins` is the view documented
    // "for external consumers": installable-only, star-ranked, and every entry
    // carries a working npm install command.
    url: 'https://deepseek1024.com/api/v1/plugins',
    pick: (r) => r.packages ?? r.plugins ?? (Array.isArray(r) ? r : null),
    // Its own cap, not ours: `meta.total` is 500 while `meta.catalogTotal` is
    // ~13.6k, so the source is capped upstream and there is nothing to page.
    note: 'installable view, upstream-capped at 500 of ~13.6k (documented)',
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

/**
 * Repository names that look like a directory worth probing for a catalog.
 *
 * Bilingual on purpose: the Chinese ecosystem names these things 市场 / 商店 /
 * 目录 / 聚合 / 精选, and an English-only pattern is why the first version
 * discovered nothing at all despite Oh-My-DSH and DSH Get being exactly that.
 */
const DIRECTORY_HINTS = /(awesome|market|marketplace|store|catalog|directory|hub|list|registry|plugins?|市场|商店|目录|聚合|精选|索引|合集)/i

/**
 * Search queries used to look for directories.
 *
 * Several narrow queries beat one broad one: `topic:dsh-plugin sort:stars`
 * returns the biggest *projects*, which for this ecosystem means the harness
 * itself and its satellites, so a directory has to be searched for by name
 * shape rather than by popularity.
 */
const DISCOVERY_QUERIES = [
  'topic:dsh-plugin marketplace in:name,description',
  'topic:dsh-plugin awesome in:name',
  'topic:dsh-plugin catalog in:name,description',
  'topic:dsh-plugin 插件市场 in:name,description,readme',
  'dsh plugin directory in:name,description',
]

/** Paths a community directory commonly publishes its machine-readable data at. */
const CATALOG_PROBE_PATHS = [
  'plugins.json',
  'catalog.json',
  'data/plugins.json',
  'data/catalog.json',
  'public/plugins.json',
  'dist/plugins.json',
  'catalog/catalog.json',
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
export async function discoverSources({ token, fetchImpl = fetch, log = () => {}, max = 30 } = {}) {
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'dsh-market-discovery' }
  if (token) headers.authorization = `Bearer ${token}`
  const found = []
  const tried = new Set()
  for (const rawQuery of DISCOVERY_QUERIES) {
    try {
      const res = await fetchImpl(
        `https://api.github.com/search/repositories?q=${encodeURIComponent(rawQuery)}&sort=stars&order=desc&per_page=${max}`,
        { headers },
      )
      if (!res.ok) { log(`discovery: "${rawQuery}" HTTP ${res.status}`); continue }
      const json = await res.json()
      for (const repo of json.items ?? []) {
        const full = repo.full_name ?? ''
        if (!full || DENY_REPOS.has(full) || tried.has(full)) continue
        if (repo.archived === true) continue
        const name = full.split('/').pop() ?? ''
        const haystack = `${repo.description ?? ''} ${name}`
        if (!DIRECTORY_HINTS.test(haystack)) continue
        tried.add(full)
        const branch = repo.default_branch ?? 'HEAD'
        for (const path of CATALOG_PROBE_PATHS) {
          const url = `https://raw.githubusercontent.com/${full}/${branch}/${path}`
          const count = await probeCatalog(url, fetchImpl)
          if (count === null) continue
          found.push({
            id: `discovered:${full.toLowerCase()}`,
            name: full,
            kind: 'catalog',
            url,
            pick: (r) => (Array.isArray(r) ? r : r?.plugins ?? r?.items ?? r?.results ?? r?.data),
            discoveredFrom: `github-search:"${rawQuery}":${full}`,
            note: `auto-discovered directory (${count} entries)`,
          })
          log(`discovery: adopted ${full} -> ${path} (${count} entries)`)
          break
        }
      }
    } catch (error) {
      log(`discovery: "${rawQuery}" ERR ${error.message}`)
    }
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

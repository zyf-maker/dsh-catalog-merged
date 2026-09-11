// Merges mainstream DeepSeek Harness catalogs into one plugins.json that the
// dsh-market plugin market can read via DSHM_REGISTRY_URL. No deps, runs on
// GitHub Actions on a schedule. Node 22+ (global fetch).
import { writeFileSync } from 'node:fs'
const OUT = 'plugins.json'

const SOURCES = [
  {
    name: 'awesome-dsh-plugin (official)',
    url: 'https://awesome-dsh-plugin.com/plugins.json',
    pick: (r) => r.plugins,
  },
  {
    name: 'dshget (bobby-sheng)',
    url: 'https://raw.githubusercontent.com/bobby-sheng/dshget-data/main/catalog.json',
    pick: (r) => r.plugins,
  },
  {
    name: 'unified-market (jing-hy)',
    url: 'https://raw.githubusercontent.com/jing-hy/dsh-unified-market/main/data/catalog-snapshot.json',
    pick: (r) => r.plugins,
  },
  {
    name: 'Oh-My-DSH',
    url: 'https://raw.githubusercontent.com/JohnXu22786/Oh-My-DSH/main/data/plugins.json',
    pick: (r) => r.items ?? (Array.isArray(r) ? r : null),
  },
  {
    name: 'deepseek1024 (dsh-1024store)',
    url: 'https://api.deepseek1024.com/api/v1/registry',
    pick: (r) => (Array.isArray(r) ? r : r?.plugins ?? r?.items ?? r?.data),
  },
]

const normalize = (e, src) => {
  const desc = (v) => {
    if (!v) return { en: '' }
    if (typeof v === 'string') return { en: v }
    return { en: v.en ?? v.English ?? '', zh: v['zh-Hans'] ?? v.zh ?? '' }
  }
  const s = e.stars ?? e.starsCount ?? 0
  const d = e.downloads ?? e.downloads30d ?? e.download ?? 0
  const name = e.name ?? (e.repo ? String(e.repo).split('/').pop() : '')
  const url = e.url ?? e.page ?? e.homepage ?? (e.repo ? `https://github.com/${e.repo}` : '')
  const stars = Number.isFinite(s) ? s : 0
  const downloads = Number.isFinite(d) ? d : 0
  return {
    name: String(name ?? ''),
    owner: e.owner ?? (e.repo ? String(e.repo).split('/')[0] : ''),
    url,
    category: e.category ?? e.cat ?? '',
    description: desc(e.description ?? e.desc ?? e.note),
    npm: e.npm ?? e.pkg ?? null,
    tarball: e.tarball ?? null,
    stars,
    downloads,
    // Composite ranking: stars dominate, downloads as the tiebeaker. Mirrors
    // the sort used below and is kept on each record for the market to read.
    score: Math.round(stars * 1000 + downloads),
    install: String(e.install ?? e.cmd ?? '').trim() || null,
    added: e.added ?? '',
    source: src,
  }
}

const keyOf = (p) => {
  if (p.npm && /^(@[a-z0-9][-a-z0-9._]*\/)?[a-z0-9][-a-z0-9._]*$/.test(p.npm)) return p.npm.toLowerCase()
  const url = p.url || ''
  const gh = /github\.com\/([^/]+\/[^/]+?)(?:\/|$).*/.exec(url)
  if (gh) return gh[1].toLowerCase()
  if (p.name) return p.name.toLowerCase()
  return (p.npm || p.name || url).toLowerCase()
}

const log = []
const seen = new Map()
let fetched = 0
for (const s of SOURCES) {
  try {
    const r = await fetch(s.url, { headers: { accept: 'application/json', 'user-agent': 'dsh-catalog-merge/1.0' } })
    if (!r.ok) { log.push(`${s.name}: HTTP ${r.status}`); continue }
    const json = await r.json()
    const list = s.pick(json)
    if (!Array.isArray(list)) { log.push(`${s.name}: no list`); continue }
    let ok = 0
    for (const e of list) {
      if (!e || typeof e !== 'object') continue
      const p = normalize(e, s.name)
      if (!p.name && !p.npm) continue
      const key = keyOf(p)
      if (!key) continue
      // Keep the newest/hottest duplicate: stars then downloads.
      const dedupRank = (p.stars ?? 0) * 1000000 + (p.downloads ?? 0)
      const prev = seen.get(key)
      if (!prev || dedupRank > prev._rank) { seen.set(key, { ...p, _rank: dedupRank }) }
      ok++
    }
    fetched += ok
    log.push(`${s.name}: fetched ${list.length}, usable ${ok}`)
  } catch (e) { log.push(`${s.name}: ERR ${e.message}`) }
}

const plugins = [...seen.values()].map(({ _rank, ...p }) => p) // drop internal dedup key, keep score
// Rank: composite score (stars*1000 + downloads), then stars, then downloads, then name.
plugins.sort((a, b) =>
  (b.score ?? 0) - (a.score ?? 0) ||
  (b.stars ?? 0) - (a.stars ?? 0) ||
  (b.downloads ?? 0) - (a.downloads ?? 0) ||
  a.name.localeCompare(b.name)
)
const dedupedDrop = [...seen.keys()].length

// Minimal category dictionary; market renders ids, keep as-is when unknown.
const cats = ['tools','utility','session','orchestration','ui','llm','acp','skills','sandbox','code','data','agent','vision','skin','webui','browser','channel','memory','eco','docs','devtools','remote','git'].reduce((m, c) => (m[c] = { en: c, zh: c }, m), {})

const output = {
  schema: 'dsh-market/catalog-v1',
  name: 'merged-mainstream-dsh-catalogs',
  url: 'https://github.com/zyf-maker/dsh-catalog-merged',
  updated: new Date().toISOString(),
  count: plugins.length,
  categories: cats,
  plugins,
}
writeFileSync(OUT, JSON.stringify(output, null, 2))
console.log(`merged ${plugins.length} plugins (${seen.size} identity keys); wrote ${OUT}`)
log.forEach((l) => console.log(' - ' + l))
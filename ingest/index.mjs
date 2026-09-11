/**
 * Ingest orchestrator.
 *
 * One run is: discover sources → harvest every source → normalize → merge
 * (dedupe, keep newest) → rank → emit. It writes plain files, because the
 * consumer is a static host plus an optional database import — no server has to
 * be running for the market to be readable.
 *
 * Usage:
 *   node ingest/index.mjs                 # full run
 *   node ingest/index.mjs --no-discover   # skip source discovery
 *   node ingest/index.mjs --out out/      # write somewhere else
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { SEED_SOURCES, HARVEST_SOURCES, discoverSources } from './sources.mjs'
import { harvesterFor } from './harvest.mjs'
import { normalize, mergeInto, byRank, STARS_WEIGHT } from './normalize.mjs'

const ROOT = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const args = process.argv.slice(2)
const OUT = (() => { const i = args.indexOf('--out'); return i === -1 ? join(ROOT, '..', 'data') : args[i + 1] })()
const DISCOVER = !args.includes('--no-discover')
const TOKEN = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? undefined

const started = Date.now()
const lines = []
const log = (message) => { lines.push(message); console.log(message) }

// ---------------------------------------------------------------- discovery
let sources = [...SEED_SOURCES]
if (DISCOVER) {
  const found = await discoverSources({ token: TOKEN, log })
  const known = new Set(sources.map((s) => s.id))
  sources = [...sources, ...found.filter((s) => !known.has(s.id))]
  log(`discovery: ${found.length} candidate(s) probed, ${sources.length} catalog sources total`)
}

// ------------------------------------------------------------------ harvest
const seen = new Map()
const sourceHealth = []
let rawTotal = 0

for (const source of [...sources, ...HARVEST_SOURCES]) {
  // A source disabled in the registry is skipped rather than attempted: a host
  // that is known to be down should not spend the run's request budget.
  if (source.enabled === false) {
    sourceHealth.push({
      id: source.id, name: source.name, kind: source.kind, url: source.url,
      discoveredFrom: source.discoveredFrom ?? null, ok: false, items: 0, ms: 0,
      error: 'disabled', at: new Date().toISOString(),
    })
    continue
  }
  const harvest = harvesterFor(source)
  const result = await harvest(source, { token: TOKEN, log })
  rawTotal += result.items.length
  sourceHealth.push({
    id: source.id,
    name: source.name,
    kind: source.kind,
    url: source.url,
    discoveredFrom: source.discoveredFrom ?? null,
    ok: result.ok,
    items: result.items.length,
    ms: result.ms,
    error: result.error ?? null,
    at: new Date().toISOString(),
  })
  if (!result.ok) log(`  ! ${result.error}`)

  for (const { raw, sourceId, requireType } of result.items) {
    const plugin = normalize(raw, sourceId, requireType)
    if (plugin !== null) mergeInto(seen, plugin)
  }
}

// --------------------------------------------------------------- rank/emit
const plugins = [...seen.values()].sort(byRank)
const updated = new Date().toISOString()

const byKind = plugins.reduce((acc, p) => { acc[p.targetKind] = (acc[p.targetKind] ?? 0) + 1; return acc }, {})
const byCategory = plugins.reduce((acc, p) => { const c = p.category || 'uncategorized'; acc[c] = (acc[c] ?? 0) + 1; return acc }, {})
const multiSource = plugins.filter((p) => p.sources.length > 1).length

/** Category dictionary for the market UI; ids stay as the sources wrote them. */
const categories = Object.fromEntries(Object.keys(byCategory).sort().map((id) => [id, { en: id, zh: id }]))

const catalog = {
  schema: 'dsh-market/catalog-v2',
  name: 'dsh-market (own)',
  url: 'https://github.com/zyf-maker/dsh-catalog-merged',
  updated,
  count: plugins.length,
  categories,
  ranking: { formula: `stars*${STARS_WEIGHT} + downloads`, order: ['score', 'stars', 'downloads', 'name'] },
  stats: { rawEntries: rawTotal, sources: sourceHealth.length, multiSource, byTargetKind: byKind, byCategory },
  plugins,
}

write(join(OUT, 'catalog.json'), catalog)

// The compatibility contract for consumers that only read one file.
write(join(OUT, 'plugins.json'), {
  name: 'dsh-market',
  url: catalog.url,
  updated,
  count: plugins.length,
  categories,
  plugins: plugins.map((p) => ({
    name: p.name,
    owner: p.owner,
    url: p.url,
    category: p.category,
    description: p.description,
    npm: p.npm,
    tarball: p.tarball,
    stars: p.stars,
    downloads: p.downloads,
    score: p.score,
    install: p.install,
    added: p.added,
  })),
})

write(join(OUT, 'sources.json'), { updated, sources: sourceHealth })
write(join(OUT, 'rankings.json'), {
  updated,
  score: plugins.slice(0, 100).map(rank),
  stars: [...plugins].sort((a, b) => b.stars - a.stars).slice(0, 100).map(rank),
  downloads: [...plugins].sort((a, b) => b.downloads - a.downloads).slice(0, 100).map(rank),
})
write(join(OUT, 'health.json'), {
  updated,
  durationMs: Date.now() - started,
  counts: { plugins: plugins.length, raw: rawTotal, sources: sourceHealth.length, failing: sourceHealth.filter((s) => !s.ok).length },
  sources: sourceHealth.map(({ id, name, ok, items, ms, error }) => ({ id, name, ok, items, ms, error })),
})

// Newly appeared plugins, so a consumer can announce them.
const previousPath = join(OUT, 'catalog.json')
const previousIds = existsSync(join(OUT, 'previous-ids.json'))
  ? new Set(JSON.parse(readFileSync(join(OUT, 'previous-ids.json'), 'utf8')))
  : null
if (previousIds !== null) {
  const added = plugins.filter((p) => !previousIds.has(p.install)).slice(0, 200)
  write(join(OUT, 'new.json'), { updated, count: added.length, plugins: added.map(rank) })
}
write(join(OUT, 'previous-ids.json'), plugins.map((p) => p.install))

log(`merged ${plugins.length} plugins from ${rawTotal} raw entries across ${sourceHealth.length} sources`)
log(`  target kinds: ${Object.entries(byKind).map(([k, v]) => `${k}=${v}`).join(' ')}`)
log(`  multi-source (deduped): ${multiSource}`)
log(`  wrote ${OUT}/{catalog,plugins,sources,rankings,health}.json in ${Date.now() - started}ms`)
void previousPath

/** One ranked row, with its position, for the rankings/newest files. */
function rank(plugin, index) {
  return {
    rank: index + 1,
    name: plugin.name,
    owner: plugin.owner,
    url: plugin.url,
    category: plugin.category,
    description: plugin.description,
    install: plugin.install,
    targetKind: plugin.targetKind,
    stars: plugin.stars,
    downloads: plugin.downloads,
    score: plugin.score,
  }
}

/** Write one artifact, creating its directory. */
function write(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2))
}

/**
 * Ingest orchestrator.
 *
 * One run is: discover sources → harvest → normalize → **resolve identity** →
 * merge (dedupe, keep the winner) → **verify admission** → rank → emit.
 *
 * It writes plain files, because the consumer is a static host plus an optional
 * database import — no server has to be running for the market to be readable.
 *
 * Usage:
 *   node ingest/index.mjs                 # full run
 *   node ingest/index.mjs --no-discover   # skip source discovery
 *   node ingest/index.mjs --no-admission  # skip manifest verification (fast, unsafe)
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { SEED_SOURCES, HARVEST_SOURCES, discoverSources } from './sources.mjs'
import { harvesterFor } from './harvest.mjs'
import { normalize, betterRecord, byRank } from './normalize.mjs'
import { buildIdentityIndex } from './identity.mjs'
import { AdmissionCache, verifyAll } from './admission.mjs'
import { planRepair } from './compat.mjs'

const ROOT = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const args = process.argv.slice(2)
const OUT = (() => { const i = args.indexOf('--out'); return i === -1 ? join(ROOT, '..', 'data') : args[i + 1] })()
const DISCOVER = !args.includes('--no-discover')
const ADMISSION = !args.includes('--no-admission')
const TOKEN = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? undefined

const started = Date.now()
const log = (message) => console.log(message)

// ---------------------------------------------------------------- discovery
let sources = [...SEED_SOURCES]
if (DISCOVER) {
  const found = await discoverSources({ token: TOKEN, log })
  const known = new Set(sources.map((s) => s.id))
  sources = [...sources, ...found.filter((s) => !known.has(s.id))]
  log(`discovery: ${found.length} adopted, ${sources.length} catalog sources`)
}

// ------------------------------------------------------------------ harvest
const records = []
const sourceHealth = []
let rawTotal = 0

for (const source of [...sources, ...HARVEST_SOURCES]) {
  if (source.enabled === false) {
    sourceHealth.push(health(source, false, 0, 0, 'disabled'))
    continue
  }
  const harvest = harvesterFor(source)
  const result = await harvest(source, { token: TOKEN, log })
  rawTotal += result.items.length
  sourceHealth.push(health(source, result.ok, result.items.length, result.ms, result.error ?? null))
  if (!result.ok) log(`  ! ${result.error}`)
  for (const { raw, sourceId, requireType } of result.items) {
    const record = normalize(raw, sourceId, requireType)
    if (record !== null) records.push(record)
  }
}

// -------------------------------------------------- identity resolution
// Done over the whole corpus at once, because the evidence that two keys denote
// one plugin is a record that carries both — which may come from any source.
const identity = buildIdentityIndex(records)
/** @type {Map<string, {id: string, winner: object, sources: Set<string>, members: object[]}>} */
const classes = new Map()

for (const record of records) {
  const id = identity.idFor(record)
  if (id === null) continue
  const existing = classes.get(id)
  if (existing === undefined) {
    classes.set(id, { id, winner: record, sources: new Set([record.sourceId]), members: [record] })
    continue
  }
  existing.sources.add(record.sourceId)
  existing.members.push(record)
  if (betterRecord(record, existing.winner)) existing.winner = record
}

// Fill gaps from the duplicates: a losing record often holds the description,
// category or version the winner lacks.
const merged = []
let targetless = 0
for (const entry of classes.values()) {
  const winner = { ...entry.winner, id: entry.id }
  for (const member of entry.members) {
    winner.description.en ||= member.description.en
    winner.description.zh ||= member.description.zh
    winner.category ||= member.category
    winner.version ||= member.version
    winner.added ||= member.added
    winner.npm ??= member.npm
    winner.tarball ??= member.tarball
    // A member that can be installed upgrades the class: one source knowing the
    // npm package is enough for the whole class to be installable.
    if (!winner.hasTarget && member.hasTarget) {
      winner.hasTarget = true
      winner.install = member.install
      winner.target = member.target
      winner.targetKind = member.targetKind
      winner.needsEvidence = member.needsEvidence
      winner.installable = member.needsEvidence ? null : true
    }
    if (winner.riskFlags.length === 0 && member.riskFlags.length > 0) winner.riskFlags = member.riskFlags
  }
  winner.sources = [...entry.sources].sort()
  // No member could produce an install target, so this is a directory entry or
  // a project, not a plugin. Listing it would put a dead install button in a
  // market, which is exactly what the market exists to avoid.
  if (!winner.hasTarget) { targetless += 1; continue }
  merged.push(winner)
}

// ---------------------------------------------------------------- admission
// A target inferred from a repository alone is a claim; the manifest decides.
// The same read also answers the compatibility question, so one probe serves
// admission and repair planning instead of two network passes.
let admitted = merged
const admissionStats = { checked: 0, admitted: 0, rejected: 0, unproven: 0, repaired: 0, cached: 0, byReason: {} }
if (ADMISSION) {
  const candidates = merged.filter((p) => p.needsEvidence && p.repoPath !== null)
  const cache = new AdmissionCache(join(OUT, 'admission-cache.json'))
  const verdicts = await verifyAll(
    candidates.map((p) => ({ repoPath: p.repoPath, subpath: p.repoSubpath, cacheKey: `${p.repoPath}@${p.added}` })),
    { cache, token: TOKEN, log },
  )
  admitted = []
  for (const plugin of merged) {
    if (!plugin.needsEvidence || plugin.repoPath === null) { admitted.push(plugin); continue }
    const verdict = verdicts.get(`${plugin.repoPath}@${plugin.added}`)
    admissionStats.checked += 1
    if (verdict?.ok === true) {
      plugin.installable = true
      plugin.evidence = verdict.reason
      // Repair planning from the manifest already in hand.
      if (verdict.manifest !== undefined) {
        const plan = planRepair({ plugin, manifest: verdict.manifest, treePaths: null, hostVersion: null })
        if (plan.needed) {
          plugin.compat = { issues: plan.issues, overlay: plan.overlay, notes: plan.notes }
          admissionStats.repaired += 1
        }
      }
      admissionStats.admitted += 1
      admitted.push(plugin)
      continue
    }
    if (verdict?.reason === 'probe-error') {
      // The question could not be answered. Listing it without a one-click
      // install is the honest outcome; deleting a plugin because the network
      // hiccuped is not.
      plugin.installable = null
      plugin.evidence = 'unproven'
      admissionStats.unproven += 1
      admitted.push(plugin)
      continue
    }
    admissionStats.rejected += 1
    const reason = verdict?.reason ?? 'not-probed'
    admissionStats.byReason[reason] = (admissionStats.byReason[reason] ?? 0) + 1
  }
  // Verdicts for repos that errored are not cached, so the next run retries.
  cache.save(candidates
    .filter((p) => verdicts.get(`${p.repoPath}@${p.added}`)?.reason !== 'probe-error')
    .map((p) => `${p.repoPath}@${p.added}`))
  admissionStats.cached = cache.stats.hits
  log(`admission: ${admissionStats.checked} inferred targets checked, ${admissionStats.admitted} admitted, ${admissionStats.rejected} rejected, ${admissionStats.unproven} unproven (kept), ${admissionStats.repaired} repaired`)
  log(`  rejected by reason: ${JSON.stringify(admissionStats.byReason)}`)
}

// --------------------------------------------------------------- rank/emit
const plugins = admitted.sort(byRank)
const updated = new Date().toISOString()
const byKind = plugins.reduce((acc, p) => { acc[p.targetKind] = (acc[p.targetKind] ?? 0) + 1; return acc }, {})
const byCategory = plugins.reduce((acc, p) => { const c = p.category || 'uncategorized'; acc[c] = (acc[c] ?? 0) + 1; return acc }, {})
const multiSource = plugins.filter((p) => p.sources.length > 1).length
const duplicatesCollapsed = records.length - classes.size
const categories = Object.fromEntries(Object.keys(byCategory).sort().map((id) => [id, { en: id, zh: id }]))

write(join(OUT, 'catalog.json'), {
  schema: 'dsh-market/catalog-v3',
  name: 'dsh-market (own)',
  url: 'https://github.com/zyf-maker/dsh-catalog-merged',
  updated,
  count: plugins.length,
  categories,
  ranking: { formula: 'stars*1000 + downloads', order: ['score', 'stars', 'downloads', 'name'] },
  stats: {
    normalized: records.length,
    identityClasses: classes.size,
    duplicatesCollapsed,
    rawEntries: rawTotal,
    sources: sourceHealth.length,
    multiSource,
    admission: admissionStats,
    byTargetKind: byKind,
    byCategory,
  },
  plugins,
})

write(join(OUT, 'plugins.json'), {
  name: 'dsh-market',
  url: 'https://github.com/zyf-maker/dsh-catalog-merged',
  updated,
  count: plugins.length,
  categories,
  plugins: plugins.map((p) => ({
    name: p.name,
    owner: p.owner,
    url: p.url,
    // The repository is shipped so the installer can re-read the manifest
    // against the host's own version — the one fact the ingest run cannot know.
    repo: p.repoPath,
    subpath: p.repoSubpath,
    category: p.category,
    description: p.description,
    npm: p.npm,
    tarball: p.tarball,
    stars: p.stars,
    downloads: p.downloads,
    score: p.score,
    install: p.install,
    installable: p.installable,
    compat: p.compat ?? null,
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
  counts: {
    plugins: plugins.length,
    raw: rawTotal,
    normalized: records.length,
    duplicatesCollapsed,
    sources: sourceHealth.length,
    failing: sourceHealth.filter((s) => !s.ok).length,
    rejectedByAdmission: admissionStats.rejected,
  },
  sources: sourceHealth.map(({ id, name, ok, items, ms, error }) => ({ id, name, ok, items, ms, error })),
})

// New records, diffed by canonical id so a changed install command does not
// masquerade as a new plugin (which keying on the command did).
const previousPath = join(OUT, 'previous-ids.json')
if (existsSync(previousPath)) {
  const previous = new Set(JSON.parse(readFileSync(previousPath, 'utf8')))
  const added = plugins.filter((p) => !previous.has(p.id)).slice(0, 200)
  write(join(OUT, 'new.json'), { updated, count: added.length, plugins: added.map(rank) })
}
write(previousPath, plugins.map((p) => p.id))

log(`merged ${plugins.length} plugins from ${rawTotal} raw entries across ${sourceHealth.length} sources`)
log(`  identity: ${records.length} records -> ${classes.size} classes (${duplicatesCollapsed} duplicates collapsed)`)
log(`  target kinds: ${Object.entries(byKind).map(([k, v]) => `${k}=${v}`).join(' ')}`)
log(`  multi-source: ${multiSource}`)
log(`  wrote ${OUT}/{catalog,plugins,sources,rankings,health}.json in ${Date.now() - started}ms`)

/** One ranked row for the rankings/newest files. */
function rank(plugin, index) {
  return {
    rank: index + 1,
    id: plugin.id,
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

/** A source-health row. */
function health(source, ok, items, ms, error) {
  return {
    id: source.id,
    name: source.name,
    kind: source.kind,
    url: source.url,
    discoveredFrom: source.discoveredFrom ?? null,
    ok,
    items,
    ms,
    error,
    at: new Date().toISOString(),
  }
}

/** Write one artifact, creating its directory. */
function write(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2))
}

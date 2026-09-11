/**
 * Ingest orchestrator.
 *
 * One run is: discover sources → harvest → normalize → **resolve identity** →
 * merge (dedupe, keep the winner) → **verify admission** → rank → emit.
 *
 * It writes plain files, because the consumer is a static host plus an optional
 * database import — no server has to be running for the market to be readable.
 *
 * The pipeline is a function, and the CLI wrapper is at the bottom, because a
 * module that harvests the internet the moment it is imported cannot be tested
 * and cannot be reused.
 *
 * Usage:
 *   node ingest/index.mjs                 # full run
 *   node ingest/index.mjs --no-discover   # skip source discovery
 *   node ingest/index.mjs --no-admission  # skip manifest verification (fast, unsafe)
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { SEED_SOURCES, HARVEST_SOURCES, discoverSources } from './sources.mjs'
import { harvesterFor } from './harvest.mjs'
import { normalize, betterRecord, byRank, UNCATEGORIZED } from './normalize.mjs'
import { CATEGORIES, GENERIC_CATEGORIES, categoryCounts } from './classify.mjs'
import { buildIdentityIndex } from './identity.mjs'
import { AdmissionCache, verifyAll } from './admission.mjs'
import { planRepair } from './compat.mjs'
import { assertCatalogAcceptable } from './catalog-contract.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * Run one full ingest.
 *
 * @param options - `out` (artifact directory), `discover`, `admission`, `token`,
 *   `log`, and `fetchImpl` for tests.
 * @returns the emitted catalog plus its run statistics.
 */
export async function runIngest({
  out = join(HERE, '..', 'data'),
  discover = true,
  admission = true,
  token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? undefined,
  log = (message) => console.log(message),
  fetchImpl = fetch,
} = {}) {
  const started = Date.now()

  // -------------------------------------------------------------- discovery
  let sources = [...SEED_SOURCES]
  if (discover) {
    const found = await discoverSources({ token, log, fetchImpl })
    const known = new Set(sources.map((s) => s.id))
    sources = [...sources, ...found.filter((s) => !known.has(s.id))]
    log(`discovery: ${found.length} adopted, ${sources.length} catalog sources`)
  }

  // ---------------------------------------------------------------- harvest
  const records = []
  const sourceHealth = []
  let rawTotal = 0

  for (const source of [...sources, ...HARVEST_SOURCES]) {
    if (source.enabled === false) {
      sourceHealth.push(health(source, false, 0, 0, 'disabled'))
      continue
    }
    const harvest = harvesterFor(source)
    const result = await harvest(source, { token, log, fetchImpl })
    rawTotal += result.items.length
    sourceHealth.push(health(source, result.ok, result.items.length, result.ms, result.error ?? null))
    if (!result.ok) log(`  ! ${result.error}`)
    for (const { raw, sourceId, requireType } of result.items) {
      const record = normalize(raw, sourceId, requireType)
      if (record !== null) records.push(record)
    }
  }

  // ------------------------------------------------------ identity folding
  // Over the whole corpus at once, because the evidence that a repository and
  // an npm package denote one plugin is a record carrying both — and whether
  // that evidence is usable depends on how many packages claim the repository.
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
  // category or version the winner lacks, and a class is installable as soon as
  // any one of its records names a target.
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
    // No member produced an install target: this is a directory entry or a
    // project, not a plugin. Listing it would put a dead install button in a
    // market, which is the one thing a market must not do.
    if (!winner.hasTarget) { targetless += 1; continue }
    merged.push(winner)
  }

  // -------------------------------------------------------------- admission
  // A target inferred from a repository alone is a claim; the manifest decides.
  // The same read also answers the compatibility question, so one probe serves
  // admission and repair planning instead of two network passes.
  let admitted = merged
  const admissionStats = { checked: 0, admitted: 0, rejected: 0, unproven: 0, repaired: 0, cached: 0, expired: 0, byReason: {} }
  /**
   * The cache key for one plugin's admission verdict.
   *
   * `added` doubles as the revision: for GitHub topics it is the last push date,
   * so a changed repository gets a different key and is re-asked at once. An
   * entry with no revision keeps a constant key and is re-asked once the verdict
   * expires (see VERDICT_MAX_AGE_MS).
   *
   * Defined once and used for both the write and the read: two copies of this
   * expression is how a lookup silently stops matching its own writes.
   */
  const admissionKeyOf = (plugin) => `${plugin.repoPath}@${plugin.added === '' ? 'unversioned' : plugin.added}`
  if (admission) {
    const candidates = merged.filter((p) => p.needsEvidence && p.repoPath !== null)
    const cache = new AdmissionCache(join(out, 'admission-cache.json'))
    const verdicts = await verifyAll(
      candidates.map((p) => ({ repoPath: p.repoPath, subpath: p.repoSubpath, cacheKey: admissionKeyOf(p) })),
      { cache, token, log, fetchImpl },
    )
    admitted = []
    for (const plugin of merged) {
      if (!plugin.needsEvidence || plugin.repoPath === null) { admitted.push(plugin); continue }
      const verdict = verdicts.get(admissionKeyOf(plugin))
      admissionStats.checked += 1
      if (verdict?.ok === true) {
        plugin.installable = true
        plugin.evidence = verdict.reason
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
    // Verdicts for repositories that errored are not cached, so the next run
    // asks again instead of remembering a network failure as a fact.
    cache.save(candidates
      .filter((p) => verdicts.get(admissionKeyOf(p))?.reason !== 'probe-error')
      .map(admissionKeyOf))
    admissionStats.cached = cache.stats.hits
    admissionStats.expired = cache.stats.expired
    log(`admission: ${admissionStats.checked} inferred targets checked, ${admissionStats.admitted} admitted, ${admissionStats.rejected} rejected, ${admissionStats.unproven} unproven (kept), ${admissionStats.repaired} repaired`)
    log(`  rejected by reason: ${JSON.stringify(admissionStats.byReason)}`)
  }

  // ------------------------------------------------------------- rank/emit
  const plugins = admitted.sort(byRank)
  const updated = new Date().toISOString()
  const byKind = plugins.reduce((acc, p) => { acc[p.targetKind] = (acc[p.targetKind] ?? 0) + 1; return acc }, {})
  const multiSource = plugins.filter((p) => p.sources.length > 1).length
  const duplicatesCollapsed = records.length - classes.size
  /**
   * Category statistics, counted over the FINAL set and in taxonomy order: a count
   * taken before admission would advertise plugins the market does not show, and a
   * dictionary ordered by frequency would reshuffle itself on every run.
   */
  const inTaxonomy = categoryCounts(plugins)
  const categories = Object.fromEntries(
    inTaxonomy.filter((c) => c.count > 0).map(({ id, en, zh, count }) => [id, { en, zh, count }]),
  )
  const byCategory = Object.fromEntries(inTaxonomy.filter((c) => c.count > 0).map((c) => [c.id, c.count]))
  /** How each placement happened, so "自动归类" is measurable rather than claimed. */
  const byCategorySource = plugins.reduce((acc, p) => {
    const key = p.categorySource ?? 'unknown'
    acc[key] = (acc[key] ?? 0) + 1
    return acc
  }, {})
  const categoryStats = {
    taxonomy: CATEGORIES.length,
    used: Object.keys(categories).length,
    counts: inTaxonomy.filter((c) => c.count > 0),
    // Entries whose raw catalog value was a non-answer word (`cordis-plugin`,
    // `插件`, `uncategorized`) — the bucket automatic classification exists to empty.
    rawGeneric: plugins.filter((p) => GENERIC_CATEGORIES.has(String(p.rawCategory ?? '').toLowerCase())).length,
    // Entries no rule could place: the honest measure of classification quality,
    // because it is what a reader would otherwise have to browse by hand.
    unclassified: plugins.filter((p) => p.category === 'other').length,
    bySource: byCategorySource,
  }

  const stats = {
    normalized: records.length,
    identityClasses: classes.size,
    duplicatesCollapsed,
    targetlessClasses: targetless,
    // Repositories whose links were refused because more than one package claims
    // them. Reported because it is the number that decides whether the merge is
    // collapsing siblings (a low count) or being correctly conservative.
    ambiguousRepos: identity.ambiguousRepos,
    rawEntries: rawTotal,
    sources: sourceHealth.length,
    multiSource,
    admission: admissionStats,
    category: categoryStats,
    byTargetKind: byKind,
    byCategory,
  }

  const catalog = {
    schema: 'dsh-market/catalog-v3',
    name: 'dsh-market (own)',
    url: 'https://github.com/zyf-maker/dsh-catalog-merged',
    updated,
    count: plugins.length,
    categories,
    ranking: { formula: 'stars*1000 + downloads', order: ['score', 'stars', 'downloads', 'name'] },
    stats,
    plugins,
  }

  const marketCatalog = {
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
      // dshmarket refuses the whole catalog over one unusable category, so a
      // plugin without one is placed in the labelled fallback bucket rather
      // than published with `""`.
      category: p.category === '' ? UNCATEGORIZED : p.category,
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
  }

  // Before anything is written: a catalog the market would refuse must fail in
  // the run that produced it, where the reason is readable, instead of inside
  // the user's settings window as "插件目录加载失败".
  assertCatalogAcceptable(marketCatalog, log)

  write(join(out, 'catalog.json'), catalog)
  write(join(out, 'plugins.json'), marketCatalog)

  write(join(out, 'sources.json'), { updated, sources: sourceHealth })
  write(join(out, 'rankings.json'), {
    updated,
    score: plugins.slice(0, 100).map(rank),
    stars: [...plugins].sort((a, b) => b.stars - a.stars).slice(0, 100).map(rank),
    downloads: [...plugins].sort((a, b) => b.downloads - a.downloads).slice(0, 100).map(rank),
  })
  write(join(out, 'health.json'), {
    updated,
    durationMs: Date.now() - started,
    counts: {
      plugins: plugins.length,
      raw: rawTotal,
      normalized: records.length,
      duplicatesCollapsed,
      targetlessClasses: targetless,
      sources: sourceHealth.length,
      failing: sourceHealth.filter((s) => !s.ok).length,
      rejectedByAdmission: admissionStats.rejected,
    },
    sources: sourceHealth.map(({ id, name, ok, items, ms, error }) => ({ id, name, ok, items, ms, error })),
  })

  // New records, diffed by canonical id so a changed install command does not
  // masquerade as a new plugin (which keying on the command did).
  const previousPath = join(out, 'previous-ids.json')
  if (existsSync(previousPath)) {
    const previous = new Set(JSON.parse(readFileSync(previousPath, 'utf8')))
    const added = plugins.filter((p) => !previous.has(p.id)).slice(0, 200)
    write(join(out, 'new.json'), { updated, count: added.length, plugins: added.map(rank) })
  }
  write(previousPath, plugins.map((p) => p.id))

  log(`merged ${plugins.length} plugins from ${rawTotal} raw entries across ${sourceHealth.length} sources`)
  log(`  identity: ${records.length} records -> ${classes.size} classes (${duplicatesCollapsed} duplicates collapsed, ${targetless} without an install target, ${identity.ambiguousRepos} ambiguous repos left unlinked)`)
  log(`  target kinds: ${Object.entries(byKind).map(([k, v]) => `${k}=${v}`).join(' ')}`)
  log(`  multi-source: ${multiSource}`)
  log(`  wrote ${out}/{catalog,plugins,sources,rankings,health}.json in ${Date.now() - started}ms`)

  return { updated, count: plugins.length, stats, plugins }
}

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

// ------------------------------------------------------------------ CLI
// Only when this file IS the program. Importing it (a test, another script)
// must never harvest anything.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  const valueOf = (flag) => { const i = args.indexOf(flag); return i === -1 ? undefined : args[i + 1] }
  await runIngest({
    out: valueOf('--out') ?? join(HERE, '..', 'data'),
    discover: !args.includes('--no-discover'),
    admission: !args.includes('--no-admission'),
  })
}

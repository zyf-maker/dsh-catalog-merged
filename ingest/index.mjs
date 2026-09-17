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
import { CATEGORIES, GENERIC_CATEGORIES, categoryCounts, classify } from './classify.mjs'
import {
  DEFAULT_OPTIONS as CATEGORY_OPTIONS, dictionaryFor, discoverCategories, loadLabels, loadState,
  mergeDiscovered, promotedTermsOf, rulesFor, saveState, surveyCandidates, termPattern,
} from './categories.mjs'
import { buildIdentityIndex } from './identity.mjs'
import { AdmissionCache, verifyAll } from './admission.mjs'
import { planRepair } from './compat.mjs'
import { assertCatalogAcceptable } from './catalog-contract.mjs'
// Every reader of the catalog — the settings-section market and the published
// web page — reads the fields this module produces, so the two cannot disagree
// about which rows are shells or how the rest are ordered.
import { annotateCatalog } from '../shared/quality.mjs'

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
  /** Threshold overrides for category discovery; see `categories.mjs`. */
  categoryOptions = {},
} = {}) {
  const started = Date.now()

  // --------------------------------------------------- persisted categories
  // Loaded before harvesting, because a category created on an earlier run is part
  // of how records are classified — not something applied afterwards. Reading it
  // here is what makes discovery additive instead of a second pass every time.
  const categoriesPath = join(out, 'categories.json')
  const labelsPath = join(out, 'category-labels.json')
  let categoryState = loadState(categoriesPath)
  const categoryLabels = loadLabels(labelsPath)
  let discoveredRules = rulesFor(categoryState)
  log(`categories: ${discoveredRules.length} discovered rule(s) from ${categoryState.updated ?? 'a fresh state'}`)

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
      const record = normalize(raw, sourceId, requireType, { discovered: discoveredRules })
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
  // Bump the namespace whenever the probe contract changes. Otherwise a cache
  // written by the old manifest-only check would silently bypass the new
  // runtime-file probe for seven days.
  //
  // `probe-v4` scopes a verdict to the row's install target: v3 stored a verdict
  // for a row that carried an npm name, but the rule now decides whether that
  // name may answer at all. Reusing v3 entries re-admitted the 64 repositories
  // whose package belongs to someone else — the run that changed the rule
  // reported `cached: 12897` and dropped exactly one row.
  //
  // The npm name is part of the key as well as the revision: a row whose
  // repository stays put while its published package changes is a different
  // install target, and one verdict cannot stand for both.
  const admissionKeyOf = (plugin) => `probe-v4:${plugin.repoPath ?? 'no-repo'}+${plugin.npm ?? 'no-npm'}@${plugin.added === '' ? 'unversioned' : plugin.added}`
  if (admission) {
    // An explicit install command is not proof that a repository is a plugin.
    // Probe every candidate that names something to install, not only the
    // targets `normalize()` inferred, so a source catalog cannot bypass
    // admission by shipping its own `dsh plugin add` command. Measured before
    // this rule: 4565 of 11653 rows were probed and 8343 were published on a
    // directory's word alone, which is how `reactive-resume` — a resume builder
    // — reached the top of the market with a one-click install button that
    // could only fail.
    //
    // A package is a candidate on its own: `coding-agents` installs
    // `@vectorize-io/hindsight-coding-agents`, whose registry manifest declares
    // `dsh.bundle` while its repository root declares nothing.
    //
    // The package may only answer for a row that installs it. Plenty of rows
    // carry an npm name pointing at a plugin someone else wrote for the same
    // repository — `Molunerfinn/PicGo` installs `github:Molunerfinn/PicGo` while
    // carrying `@picgo/dsh-plugin`, and `Tencent/WeKnora` carries
    // `@wxg-prc-cpg/dsh-weknora` — so letting that package prove the row puts a
    // one-click button on a repository that is not a plugin. Measured on the
    // first run that allowed it: 64 of 464 package-admitted rows were that
    // mistake, and they were the highest-star rows on the page.
    const installsPackage = (p) => p.targetKind === 'npm' && typeof p.npm === 'string' && p.npm.trim() !== ''
    const candidates = merged.filter((p) => p.repoPath !== null || installsPackage(p))
    const cache = new AdmissionCache(join(out, 'admission-cache.json'))
    const verdicts = await verifyAll(
      candidates.map((p) => ({
        repoPath: p.repoPath,
        subpath: p.repoSubpath,
        npm: installsPackage(p) ? p.npm : null,
        cacheKey: admissionKeyOf(p),
      })),
      { cache, token, log, fetchImpl },
    )
    admitted = []
    for (const plugin of merged) {
      if (plugin.repoPath === null && !installsPackage(plugin)) {
        // Nothing to probe: a release archive or a bare command has no manifest
        // to read. Keep it without a one-click install rather than reading the
        // source's command as proof or inventing a rejection out of silence.
        plugin.installable = null
        plugin.evidence = 'unproven'
        admissionStats.unproven += 1
        admitted.push(plugin)
        continue
      }
      const verdict = verdicts.get(admissionKeyOf(plugin))
      admissionStats.checked += 1
      if (verdict?.ok === true) {
        plugin.installable = true
        plugin.evidence = verdict.reason
        if (verdict.probe !== undefined) plugin.probe = verdict.probe
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
    log(`admission: ${admissionStats.checked} targets checked, ${admissionStats.admitted} admitted, ${admissionStats.rejected} rejected, ${admissionStats.unproven} unproven (kept), ${admissionStats.repaired} repaired`)
    log(`  rejected by reason: ${JSON.stringify(admissionStats.byReason)}`)
  }

  // ------------------------------------------------- category discovery
  // Runs over the emitted set, so a category is created for plugins the market
  // actually shows. Whatever it creates is applied to this run immediately — a
  // category that only takes effect next run would leave the sidebar and the
  // catalog disagreeing for an hour.
  const updated = new Date().toISOString()
  const categoryRun = { created: [], revived: [], retired: [], updated: [], proposals: [], survey: [] }
  if (categoryOptions.discover !== false) {
    const options = { ...CATEGORY_OPTIONS, ...categoryOptions, knownCategoryIds: CATEGORIES.map((c) => c.id) }
    // A term a human promoted in the labels file may create a category even though
    // the automatic path would not: the cross-cutting channel is proposal-only by
    // measurement, and promotion is how a person acts on one.
    options.promoteTerms = promotedTermsOf(categoryLabels)
    categoryRun.proposals = discoverCategories(admitted, options)
    // The survey is written every run so a promotion is a decision made from
    // numbers rather than from a guess about what the leftovers contain.
    categoryRun.survey = surveyCandidates(admitted, { ...options, limit: 60 })
    const merged = mergeDiscovered(categoryState, categoryRun.proposals, {
      now: updated,
      options: { ...CATEGORY_OPTIONS, ...categoryOptions },
      labels: categoryLabels,
      // Retirement is decided from THIS catalog, not from the count stored last
      // run: a category can stop qualifying because its term became a stopword or
      // because curation started covering it, and in both cases the stored count
      // is stale by definition.
      membersOf: (term) => {
        const pattern = termPattern(term)
        return admitted.filter((p) => pattern.test(`${p.name} ${p.description?.en ?? ''} ${p.description?.zh ?? ''} ${(p.topics ?? []).join(' ')}`)).length
      },
    })
    categoryState = merged.state
    categoryRun.created = merged.created
    categoryRun.revived = merged.revived
    categoryRun.retired = merged.retired
    categoryRun.updated = merged.updated
    saveState(categoriesPath, categoryState)
    discoveredRules = rulesFor(categoryState)
    write(join(out, 'category-proposals.json'), {
      updated,
      note: 'Evidence for category discovery. `automatic` entries were created by the pipeline; `promotable` entries need a human to add them to category-labels.json with "promote": true, because measurement showed cross-cutting tokens describe what a plugin integrates with rather than what it is.',
      thresholds: { ...CATEGORY_OPTIONS, ...categoryOptions },
      counts: {
        automatic: categoryRun.survey.filter((row) => row.qualifies === 'automatic').length,
        promotable: categoryRun.survey.filter((row) => row.qualifies === 'promotable').length,
        belowThreshold: categoryRun.survey.filter((row) => row.qualifies === 'below-threshold').length,
      },
      candidates: categoryRun.survey,
    })
    log(`categories: ${categoryRun.proposals.length} proposal(s), ${categoryRun.created.length} created, ${categoryRun.revived.length} revived, ${categoryRun.retired.length} retired`)
    log(`  survey: ${categoryRun.survey.filter((r) => r.qualifies === 'promotable').length} promotable, ${categoryRun.survey.filter((r) => r.qualifies === 'below-threshold').length} below threshold`)
    if (categoryRun.created.length > 0) log(`  created: ${categoryRun.created.join(', ')}`)

    // Re-place what the new buckets claim. Only entries still in `other` are
    // revisited: a plugin the curated rules placed is not re-litigated by an
    // emergent rule, which keeps curation authoritative.
    if (categoryRun.created.length > 0 || categoryRun.revived.length > 0) {
      let moved = 0
      for (const plugin of admitted) {
        if (plugin.category !== 'other') continue
        const again = classify({
          rawCategory: plugin.rawCategory,
          name: plugin.name,
          description: plugin.description,
          topics: plugin.topics ?? [],
          discovered: discoveredRules,
        })
        if (again.category !== 'other') {
          plugin.category = again.category
          plugin.categorySource = 'discovered'
          moved += 1
        }
      }
      if (moved > 0) log(`  re-placed ${moved} leftover plugin(s) into discovered categories`)
    }
  }

  // ------------------------------------------------------------- rank/emit
  /**
   * Quality is decided here, once, and published with the rows.
   *
   * The market and the web page both need "is this a shell?" and "in what
   * order?". Computing it in each UI produced two answers — the plugin showed
   * 10333 rows and the page 11538, and a 7613-star plugin sat at position 10376
   * behind rows whose only advantage was a manifest the pipeline happened to
   * probe. A screen is a fact about the data, so it is stated once, here.
   */
  const { catalog: annotated, counts: qualityCounts } = annotateCatalog({ plugins: admitted.sort(byRank) })
  const plugins = annotated.plugins
  const byKind = plugins.reduce((acc, p) => { acc[p.targetKind] = (acc[p.targetKind] ?? 0) + 1; return acc }, {})
  const multiSource = plugins.filter((p) => p.sources.length > 1).length
  const duplicatesCollapsed = records.length - classes.size
  /**
   * Category statistics, counted over the FINAL set, in taxonomy order, with the
   * discovered buckets before `other`: a count taken before admission would
   * advertise plugins the market does not show, and a dictionary ordered by
   * frequency would reshuffle itself on every run.
   */
  const discoveredDictionary = dictionaryFor(categoryState)
  const inTaxonomy = categoryCounts(plugins, Object.entries(discoveredDictionary).map(([id, meta]) => ({ id, en: meta.en, zh: meta.zh })))
  const categories = Object.fromEntries(
    inTaxonomy.filter((c) => c.count > 0).map(({ id, en, zh, count }) => {
      const auto = discoveredDictionary[id]
      return [id, auto === undefined ? { en, zh, count } : { en, zh, count, auto: true }]
    }),
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
    /**
     * What discovery did this run. `created: []` over many runs is the mechanism
     * working, not failing: the thresholds are set so a category is created only
     * when the evidence is a real cluster, and the leftovers are one-offs.
     */
    discovery: {
      thresholds: { ...CATEGORY_OPTIONS, ...categoryOptions, knownCategoryIds: undefined, promoteTerms: undefined },
      proposals: categoryRun.proposals.map((p) => ({ term: p.term, members: p.members, channel: p.channel, path: p.path, share: p.share })),
      created: categoryRun.created,
      revived: categoryRun.revived,
      retired: categoryRun.retired,
      active: Object.keys(discoveredDictionary).length,
      /**
       * Counts for the review file. `promotable` is the size of the queue a human
       * can act on; a non-zero `promotable` with an empty `created` is the intended
       * steady state, not a failure.
       */
      survey: {
        automatic: categoryRun.survey.filter((r) => r.qualifies === 'automatic').length,
        promotable: categoryRun.survey.filter((r) => r.qualifies === 'promotable').length,
        belowThreshold: categoryRun.survey.filter((r) => r.qualifies === 'below-threshold').length,
      },
    },
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
    /** How many rows each reader will show, and how many the screen drops. */
    quality: qualityCounts,
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
      // The verdict a reader needs to tell a probed plugin from a row that only
      // carries an install target. Published rather than recomputed, so the
      // settings section and the published page cannot disagree.
      evidence: p.evidence ?? null,
      probe: p.probe ?? null,
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
      // The whole verdict table, not only the rejections: "how many rows were
      // never probed" is the number that was missing while a market full of
      // uninstallable rows still looked healthy.
      admission: admissionStats,
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

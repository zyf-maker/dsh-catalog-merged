/**
 * Category-discovery tests.
 *
 * The point of discovery is a category that does not exist yet, so today's catalog
 * cannot test it — the leftovers are one-offs and the cross-cutting terms are
 * generic words. These tests therefore do two things:
 *
 *   1. pin the threshold behaviour on the SHAPES today's data actually produces
 *      (one-offs must not become categories; nor must platform and metric words);
 *   2. inject a synthetic future cluster and assert it is discovered, created,
 *      persisted, applied on the next run, and eventually retired when it decays.
 *
 * That second group is the real specification: "以备后续有新的类别" is only true if a
 * wave of new plugins creates its own bucket without anyone editing code.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_OPTIONS, STOPWORDS, candidateTerms, dictionaryFor, discoverCategories, loadLabels,
  loadState, mergeDiscovered, promotedTermsOf, rulesFor, saveState, surveyCandidates, termPattern,
} from '../ingest/categories.mjs'
import { classify, categoryCounts } from '../ingest/classify.mjs'
import { normalize } from '../ingest/normalize.mjs'

const KNOWN = ['ui', 'theme', 'tools', 'dev', 'agent', 'memory', 'model', 'vision', 'voice', 'data', 'session', 'notify', 'browser', 'security', 'market', 'desktop', 'docs', 'fun', 'other']

/** A synthetic plugin record, minimal for discovery. */
const plugin = (name, category, description = { en: '', zh: '' }, topics = []) =>
  ({ name, category, description, topics, install: `dsh plugin add ${name}` })

const discover = (plugins, options = {}) => discoverCategories(plugins, { ...options, knownCategoryIds: KNOWN })

// ---------------------------------------------------------------- thresholds

test('platform, metric and generic words can never become categories', () => {
  for (const term of ['cordis', 'plugin', 'harness', 'token', 'cost', 'workspace', 'task', 'hub', 'monitor', 'whale', 'pick']) {
    assert.ok(STOPWORDS.has(term), `${term} must be a stopword`)
    const members = Array.from({ length: 200 }, (_, i) => plugin(`dsh-${term}-${i}`, i % 7 === 0 ? 'other' : 'tools'))
    assert.deepEqual(discover(members), [], `${term} must not be proposable`)
  }
})

test('a token the curated rules already match is not a missing category', () => {
  // `vision`, `memory`, `pdf` and `ssh` are handled by the keyword table, so
  // discovery must not propose a second bucket for them.
  const members = Array.from({ length: 200 }, (_, i) => plugin(`pdf-tool-${i}`, i % 7 === 0 ? 'other' : 'tools'))
  assert.deepEqual(discover(members), [])
})

test('one-off leftovers are not categories', () => {
  // Today's real shape: the unclassified set is one-offs, each appearing once.
  const leftovers = ['relay', 'forge', 'doctor', 'fleet', 'workbench', 'lanchat', 'tailscale', 'univer', 'talebook', 'preset']
    .map((name) => plugin(name, 'other'))
  assert.deepEqual(discover(leftovers), [], 'no term reaches the member floor')
})

test('a term mostly found among classified plugins is not a leftover cluster', () => {
  // 30 members, but only 10 of them unclassified: share 0.33 < 0.75.
  const plugins = [
    ...Array.from({ length: 10 }, (_, i) => plugin(`alpha-${i}`, 'other')),
    ...Array.from({ length: 20 }, (_, i) => plugin(`alpha-x-${i}`, 'tools')),
  ]
  assert.deepEqual(discover(plugins), [])
})

// ------------------------------------------------------- a future category

test('a new domain arriving in the leftovers creates its own category', () => {
  // The "future": 30 plugins about one new subject, none of which any rule knows,
  // so every one of them lands in `other`.
  const wave = Array.from({ length: 30 }, (_, i) => plugin(`dsh-quantum-${i}`, 'other', { zh: `量子计算工具 ${i}` }))
  const proposals = discover([...wave, ...Array.from({ length: 50 }, (_, i) => plugin(`dsh-other-${i}`, 'ui'))])
  assert.equal(proposals.length, 1)
  assert.equal(proposals[0].term, 'quantum')
  assert.equal(proposals[0].channel, 'leftover')
  assert.equal(proposals[0].members, 30)
  assert.equal(proposals[0].share, 1)
  assert.equal(proposals[0].samples.length > 0, true, 'a proposal carries samples so a human can review it')
})

test('a cross-cutting term is proposal-only, and a promotion creates it', () => {
  // This is the case that changed the design. A wave can land in the catch-alls
  // (`tools`, `dev`, `ui`…) instead of the leftovers, and the first version created
  // a category for it automatically. Measuring the real catalog showed those terms
  // are ATTRIBUTES — `codex`, `claude`, `xby` (a publisher prefix), `management`,
  // `sync` — i.e. what a plugin integrates with or how it is built, not what it is.
  // So such a term becomes a *proposal* a human can promote, never a bucket that
  // appears on its own.
  const wave = Array.from({ length: 150 }, (_, i) =>
    plugin(`dsh-warp-${i}`, ['tools', 'dev', 'ui', 'data', 'session', 'desktop'][i % 6]))

  assert.deepEqual(discover(wave), [], 'nothing is created without a human asking')

  const survey = surveyCandidates(wave, { knownCategoryIds: KNOWN, limit: 10 })
  const row = survey.find((r) => r.term === 'warp')
  assert.equal(row.qualifies, 'promotable', 'but it is visible as promotable')
  assert.equal(row.members, 150)
  assert.equal(row.spread, 6)

  // Promotion is one line in the labels file.
  const promoted = new Set(promotedTermsOf({ warp: { en: 'Warp drive', zh: '曲速', promote: true } }))
  const proposals = discover(wave, { promoteTerms: promoted })
  assert.equal(proposals.length, 1)
  assert.equal(proposals[0].term, 'warp')
  assert.equal(proposals[0].path, 'promoted', 'and it is recorded as human-requested')

  // A promoted term still needs a real cluster behind it.
  const tiny = Array.from({ length: 5 }, (_, i) => plugin(`dsh-warp-${i}`, 'tools'))
  assert.deepEqual(discover(tiny, { promoteTerms: promoted }), [], 'promotion is not a way to create a 5-plugin bucket')
})

test('the whole lifecycle: create, persist, apply, retire, revive', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cat-'))
  try {
    const statePath = join(dir, 'categories.json')
    const wave = Array.from({ length: 30 }, (_, i) => plugin(`dsh-quantum-${i}`, 'other'))
    const other = Array.from({ length: 20 }, (_, i) => plugin(`plain-${i}`, 'ui'))

    // 1. discover and persist
    let state = loadState(statePath)
    const first = mergeDiscovered(state, discover([...wave, ...other]), { now: '2026-01-01T00:00:00.000Z', membersOf: () => 30 })
    state = first.state
    saveState(statePath, state)
    assert.deepEqual(first.created, ['quantum'])
    assert.equal(rulesFor(state).length, 1)

    // 2. a fresh run reads it back and classifies with it from the start
    const reloaded = loadState(statePath)
    const rules = rulesFor(reloaded)
    const placed = normalize({ name: 'dsh-quantum-sim', url: 'https://github.com/o/dsh-quantum-sim', install: 'dsh plugin add github:o/dsh-quantum-sim' }, 'test', undefined, { discovered: rules })
    assert.equal(placed.category, 'quantum')
    assert.equal(placed.categorySource, 'discovered')

    // 3. the bucket appears in the counts, before `other`
    const counts = categoryCounts([{ category: 'quantum' }, { category: 'other' }], Object.entries(dictionaryFor(reloaded)).map(([id, meta]) => ({ id, en: meta.en, zh: meta.zh })))
    assert.equal(counts.at(-1).id, 'other', 'other stays last')
    assert.equal(counts.at(-2).id, 'quantum', 'discovered buckets sit before other')
    assert.equal(counts.at(-2).count, 1)

    // 4. decay: the wave disappears, so the category is retired but remembered
    const retiredRun = mergeDiscovered(reloaded, [], { now: '2026-02-01T00:00:00.000Z', membersOf: () => 2 })
    assert.deepEqual(retiredRun.retired, ['quantum'])
    assert.equal(retiredRun.state.discovered[0].status, 'retired')
    assert.deepEqual(rulesFor(retiredRun.state), [], 'a retired category stops classifying')
    assert.deepEqual(dictionaryFor(retiredRun.state), {}, 'and stops appearing in the index')

    // 5. it comes back without being re-learned
    const revivedRun = mergeDiscovered(retiredRun.state, discover([...wave, ...other]), { now: '2026-03-01T00:00:00.000Z', membersOf: () => 30 })
    assert.deepEqual(revivedRun.revived, ['quantum'])
    assert.deepEqual(revivedRun.created, [], 'a revival is not a creation')
    assert.equal(revivedRun.state.discovered[0].firstSeen, '2026-01-01T00:00:00.000Z', 'the original sighting is preserved')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ------------------------------------------------------------- human control

test('the labels file can rename, hide and merge without touching code', () => {
  const wave = Array.from({ length: 30 }, (_, i) => plugin(`dsh-quantum-${i}`, 'other'))
  const proposals = discover(wave)

  const renamed = mergeDiscovered(null, proposals, { labels: { quantum: { en: 'Quantum computing', zh: '量子计算' } } })
  assert.deepEqual(renamed.state.discovered[0].label, { en: 'Quantum computing', zh: '量子计算' })

  const hidden = mergeDiscovered(null, proposals, { labels: { quantum: { hidden: true } } })
  assert.deepEqual(rulesFor(hidden.state), [], 'hidden means it neither classifies nor shows')
  assert.deepEqual(dictionaryFor(hidden.state), {})

  // Merging folds an emergent bucket into an existing category.
  const merged = mergeDiscovered(null, proposals, { labels: { quantum: { mergeInto: 'tools' } } })
  const rules = rulesFor(merged.state)
  assert.equal(rules[0].id, 'tools', 'the term classifies into the merge target')
  assert.deepEqual(dictionaryFor(merged.state), {}, 'and does not own a bucket of its own')
})

test('hand overrides can also be applied to a category that already exists', () => {
  const wave = Array.from({ length: 30 }, (_, i) => plugin(`dsh-quantum-${i}`, 'other'))
  const first = mergeDiscovered(null, discover(wave), {})
  const second = mergeDiscovered(first.state, discover(wave), { labels: { quantum: { zh: '量子', en: 'QUANTUM' } } })
  assert.deepEqual(second.state.discovered[0].label, { zh: '量子', en: 'QUANTUM' })
})

test('a corrupt state file does not stop a run', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cat-'))
  try {
    const path = join(dir, 'categories.json')
    saveState(path, { schema: 'x', discovered: [] })
    assert.deepEqual(loadState(path).discovered, [])
    assert.deepEqual(loadState(join(dir, 'missing.json')).discovered, [])
    assert.deepEqual(loadLabels(join(dir, 'missing.json')), {})
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('curated rules win over a discovered one', () => {
  const rules = [{ id: 'quantum', patterns: [termPattern('quantum')] }]
  // Both match; the curated `vision` rule runs first, so curation stays authoritative.
  const result = classify({ rawCategory: 'cordis-plugin', name: 'quantum-vision', description: { zh: '看图识图' }, discovered: rules })
  assert.equal(result.category, 'vision')
  assert.equal(result.source, 'keyword')
})

test('the defaults are the tightened set the measurements produced', () => {
  assert.equal(DEFAULT_OPTIONS.leftoverMinMembers, 25)
  assert.equal(DEFAULT_OPTIONS.leftoverMinShare, 0.75)
  assert.equal(DEFAULT_OPTIONS.crossMinMembers, 120)
  assert.equal(DEFAULT_OPTIONS.crossMinCategories, 6)
  assert.equal(DEFAULT_OPTIONS.maxNewPerRun, 2, 'a run cannot flood the sidebar')
})

test('candidate terms come from names and topics, never from prose', () => {
  const terms = candidateTerms({ name: 'dsh-remote-ssh', topics: ['devops'], description: { zh: '无需联网即可使用' } })
  assert.ok(terms.has('ssh'))
  assert.ok(terms.has('devops'))
  assert.equal(terms.has('无需联网即可使用'), false, 'a sentence fragment is not a category name')
})

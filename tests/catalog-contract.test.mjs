/**
 * Catalog contract tests.
 *
 * These exist because the published catalog was unusable in production: 3895 of
 * 10693 entries carried `category: ""` and dshmarket refuses the whole file over
 * one of them, so the market showed "插件目录加载失败 — catalog plugin 140 carries
 * no usable category". A unit test on `normalize` would not have caught that; a
 * test that runs the market's own acceptance rule over the emitted artifact does.
 *
 * The validator is dshmarket's real `pluginCategories` when the package is
 * installed on this machine (the authoritative behaviour), and the mirrored rule
 * otherwise (which is what CI uses, and what the pipeline asserts against).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { contractPluginCategories, entryProblems, validateCatalog, assertCatalogAcceptable } from '../ingest/catalog-contract.mjs'
import { normalize, UNCATEGORIZED } from '../ingest/normalize.mjs'
import { CATEGORY_IDS } from '../ingest/classify.mjs'

const installed = join(process.env.DSH_HOME ?? join('D:', 'software', 'deepseek', 'dsh-data'),
  'profiles', 'web', 'node_modules', 'dshmarket', 'lib', 'registry.js')

/** The market's validator: the real one when present, else the mirror. */
async function marketValidator() {
  if (existsSync(installed)) {
    const module = await import(pathToFileURL(installed).href)
    if (typeof module.pluginCategories === 'function') {
      return { pluginCategories: module.pluginCategories, source: 'dshmarket (installed)' }
    }
  }
  return { pluginCategories: contractPluginCategories, source: 'mirrored rule' }
}

test('an entry with no category is unacceptable to the market', async () => {
  const { pluginCategories } = await marketValidator()
  assert.deepEqual(pluginCategories({ category: '' }), [])
  assert.deepEqual(pluginCategories({}), [])
  assert.deepEqual(pluginCategories({ category: [] }), [])
  assert.deepEqual(pluginCategories({ category: null }), [])
  assert.deepEqual(pluginCategories({ category: 'ui' }), ['ui'])
  assert.deepEqual(pluginCategories({ category: ['', 'memory'] }), ['memory'])
})

test('normalize never emits an empty category', async () => {
  const cases = [
    { name: 'a', install: 'dsh plugin add x' },
    { name: 'b', install: 'dsh plugin add y', category: '' },
    { name: 'c', install: 'dsh plugin add z', category: [] },
    { name: 'd', install: 'dsh plugin add w', category: ['', '  '] },
    { name: 'e', install: 'dsh plugin add v', category: 'Memory' },
  ]
  const { pluginCategories } = await marketValidator()
  for (const raw of cases) {
    const plugin = normalize(raw, 'test')
    assert.notEqual(plugin.category, '', `${raw.name} must not carry an empty category`)
    assert.equal(pluginCategories({ category: plugin.category }).length, 1,
      `${raw.name} must satisfy the market's own rule`)
    // Every category is now a taxonomy id: the auto-classifier replaced the
    // free-text field, so an unknown or empty raw value lands in a real bucket
    // rather than in a placeholder the UI would have to interpret.
    assert.ok(CATEGORY_IDS.has(plugin.category), `${raw.name} got "${plugin.category}", not a taxonomy id`)
  }
  assert.equal(normalize(cases[2], 'test').category, 'other', 'nothing to go on lands in other')
  assert.equal(normalize(cases[4], 'test').category, 'memory', 'a real category is folded into the taxonomy')
})

test('the emitted catalog passes the market validator end to end', async () => {
  // Built through the same path the pipeline uses, then validated with the
  // market's rule — this is the test the production failure would have failed.
  const records = [
    { name: 'with-category', owner: 'o', url: 'https://github.com/o/a', install: 'dsh plugin --profile web add a', category: 'ui', stars: 5 },
    { name: 'without-category', owner: 'o', url: 'https://github.com/o/b', install: 'dsh plugin --profile web add b', stars: 3 },
    { name: 'blank-category', owner: 'o', url: 'https://github.com/o/c', install: 'dsh plugin --profile web add c', category: '', stars: 1 },
  ].map((raw) => normalize(raw, 'fixture'))
  const catalog = {
    plugins: records.map((p) => ({
      name: p.name, owner: p.owner, url: p.url,
      category: p.category === '' ? UNCATEGORIZED : p.category,
      description: p.description, install: p.install, added: p.added,
      stars: p.stars, downloads: p.downloads,
    })),
  }
  const { pluginCategories, source } = await marketValidator()
  const result = validateCatalog(catalog, pluginCategories)
  assert.equal(result.ok, true, `catalog rejected by ${source}: ${JSON.stringify(result.distinct)}`)
  assert.equal(result.invalid, 0)
})

test('assertCatalogAcceptable refuses to publish a rejected catalog', () => {
  const bad = { plugins: [{ name: 'x', owner: 'o', url: 'u', category: '', description: { en: '' }, install: 'i', added: '' }] }
  const lines = []
  assert.throws(() => assertCatalogAcceptable(bad, (line) => lines.push(line)), /catalog contract violated/)
  assert.ok(lines.some((line) => line.includes('unacceptable to dshmarket')), 'the summary names the problem')
})

test('entryProblems reports every rule, so one pass fixes them all', () => {
  const problems = entryProblems({ name: '', owner: null, url: 42, category: '', description: [], install: '', added: 7, stars: 'x' })
  const joined = problems.join(' | ')
  assert.match(joined, /category/)
  assert.match(joined, /name/)
  assert.match(joined, /owner/)
  assert.match(joined, /url/)
  assert.match(joined, /description/)
  assert.match(joined, /install/)
  assert.match(joined, /added/)
  assert.match(joined, /stars/)
})

test('validateCatalog groups violations instead of listing one per entry', () => {
  // Two distinct rules broken across 50 entries: the summary must read
  // "50 empty categories, 50 bad added" rather than 100 lines.
  const catalog = { plugins: Array.from({ length: 50 }, (_, i) => ({
    name: `p${i}`, owner: 'o', url: 'u', category: '', description: { en: '' }, install: 'i', added: 7,
  })) }
  const result = validateCatalog(catalog)
  assert.equal(result.invalid, 50)
  assert.equal(Object.keys(result.distinct).length, 2, 'one line per rule, not per entry')
  assert.equal(result.distinct['category yields nothing usable'], 50)
  assert.equal(result.problems.length, 20, 'detail is capped')
})

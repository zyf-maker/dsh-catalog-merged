/**
 * Import smoke test.
 *
 * CI caught a broken export (`load-sqlite.mjs` importing an `identityOf` that no
 * longer existed) that a syntax check could not see and that no local run had
 * exercised. Importing every module makes that class of break fail here instead
 * of in a scheduled run that has already spent its network budget.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const MODULES = [
  '../ingest/sources.mjs',
  '../ingest/harvest.mjs',
  '../ingest/normalize.mjs',
  '../ingest/identity.mjs',
  '../ingest/admission.mjs',
  '../ingest/compat.mjs',
  '../ingest/index.mjs',
]

test('every ingest module imports and exposes what its consumers use', async () => {
  for (const specifier of MODULES) {
    const module = await import(specifier)
    assert.ok(module !== undefined, `${specifier} did not import`)
  }
})

test('the modules the loader and the plugin depend on export their entry points', async () => {
  const identity = await import('../ingest/identity.mjs')
  assert.equal(typeof identity.buildIdentityIndex, 'function')
  assert.equal(typeof identity.candidateKeys, 'function')

  const compat = await import('../ingest/compat.mjs')
  assert.equal(typeof compat.inspectManifest, 'function')
  assert.equal(typeof compat.planRepair, 'function')

  const normalize = await import('../ingest/normalize.mjs')
  assert.equal(typeof normalize.normalize, 'function')
  assert.equal(typeof normalize.classifyTarget, 'function')
})

test('the loader consumes catalog ids rather than recomputing identity', async () => {
  const source = await import('node:fs').then((fs) => fs.readFileSync(new URL('../ingest/load-sqlite.mjs', import.meta.url), 'utf8'))
  assert.ok(source.includes('plugin.id'), 'the loader must read the catalog id')
  assert.ok(!source.includes('identityOf'), 'the loader must not recompute identity')
})

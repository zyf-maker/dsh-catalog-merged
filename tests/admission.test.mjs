import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AdmissionCache, verifyPlugin } from '../ingest/admission.mjs'

function fetchFiles(files) {
  return async (url) => {
    const marker = '/HEAD/'
    const path = url.slice(url.indexOf(marker) + marker.length).split('?')[0]
    const body = files[path]
    if (body === undefined) return { ok: false, status: 404, text: async () => '' }
    return { ok: true, status: 200, text: async () => body }
  }
}

test('the admission probe requires a real patch or executable entrypoint', async () => {
  const result = await verifyPlugin({
    repoPath: 'owner/real-plugin',
    fetchImpl: fetchFiles({
      'package.json': JSON.stringify({
        name: 'real-plugin',
        main: './lib/index.js',
        dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } },
      }),
      'cordis.patch.yml': '- insert:\n    - id: real-plugin\n      name: real-plugin\n',
      'lib/index.js': 'export function apply() { return true }\n',
    }),
  })

  assert.equal(result.ok, true)
  assert.equal(result.reason, 'dsh.bundle')
  assert.equal(result.probe.patch.meaningful, true)
  // The meaningful patch is sufficient, so the bounded probe does not fan out
  // into every export path for this package.
  assert.deepEqual(result.probe.entrypoints, [])
})

test('a manifest with an empty patch and no runtime entry is rejected', async () => {
  const result = await verifyPlugin({
    repoPath: 'owner/empty-plugin',
    fetchImpl: fetchFiles({
      'package.json': JSON.stringify({ name: 'empty-plugin', dsh: { bundle: { patch: './cordis.patch.yml' } } }),
      'cordis.patch.yml': '# placeholder only\n',
    }),
  })

  assert.equal(result.ok, false)
  assert.equal(result.reason, 'empty-plugin-entry')
  assert.equal(result.probe.patch.meaningful, false)
})

test('a client-only plugin passes when its declared entrypoint contains code', async () => {
  const result = await verifyPlugin({
    repoPath: 'owner/client-plugin',
    fetchImpl: fetchFiles({
      'package.json': JSON.stringify({ name: 'client-plugin', main: './lib/client.js', dsh: { client: { platform: 'web' } } }),
      'lib/client.js': 'export const inject = []\n',
    }),
  })

  assert.equal(result.ok, true)
  assert.deepEqual(result.probe.entrypoints, ['lib/client.js'])
})

test('a transient repository probe is not recorded as a rejection', async () => {
  const result = await verifyPlugin({
    repoPath: 'owner/unreachable',
    fetchImpl: async () => { throw new Error('network reset') },
  })

  assert.equal(result.ok, false)
  assert.equal(result.reason, 'probe-error')
})

test('cached admission keeps the probe and manifest needed for later repair', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-admission-'))
  try {
    const cache = new AdmissionCache(join(directory, 'cache.json'))
    const verdict = { ok: true, reason: 'dsh.bundle', manifest: { name: 'x' }, probe: { patch: { meaningful: true } } }
    cache.set('owner/x@rev', verdict)
    cache.save(['owner/x@rev'])
    const loaded = new AdmissionCache(join(directory, 'cache.json')).get('owner/x@rev')
    assert.deepEqual(loaded.manifest, verdict.manifest)
    assert.deepEqual(loaded.probe, verdict.probe)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

/**
 * Tests for the pieces that decide what the market contains: identity folding,
 * target classification, and compatibility repair.
 *
 * Run with `node --test tests/`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildIdentityIndex, candidateKeys, parseRepo } from '../ingest/identity.mjs'
import { normalize, classifyTarget, betterRecord } from '../ingest/normalize.mjs'
import { inspectManifest, planRepair, ISSUE } from '../ingest/compat.mjs'

const record = (fields) => ({
  name: '', owner: '', npm: null, repoPath: null, repoSubpath: null, ...fields,
})

test('a repo field that is only a bare name is joined with its owner', () => {
  assert.deepEqual(parseRepo({ repo: 'archify', owner: 'tt-a1i' }), { path: 'tt-a1i/archify', subpath: null })
  assert.deepEqual(parseRepo({ repo: 'tt-a1i/archify' }), { path: 'tt-a1i/archify', subpath: null })
  assert.deepEqual(parseRepo({ fullName: 'volcengine/OpenViking#examples/dsh-memory-plugin' }),
    { path: 'volcengine/OpenViking', subpath: 'examples/dsh-memory-plugin' })
  assert.equal(parseRepo({ repo: 'not-a-repo' }), null, 'a bare name with no owner is not a repository')
  assert.equal(parseRepo({ repo: 'a/b', subpath: '../escape' }), null, 'a traversing subpath is refused')
})

test('monorepo siblings keep distinct identities', () => {
  const a = record({ npm: null, repoPath: 'o/mono', repoSubpath: 'packages/one', name: 'one' })
  const b = record({ npm: null, repoPath: 'o/mono', repoSubpath: 'packages/two', name: 'two' })
  assert.notDeepEqual(candidateKeys(a), candidateKeys(b))
  const index = buildIdentityIndex([a, b])
  assert.notEqual(index.idFor(a), index.idFor(b))
})

test('npm and repo keys fold into one class when a record carries both', () => {
  const withBoth = record({ npm: 'open-design', repoPath: 'nexu-io/open-design', name: 'open-design' })
  const repoOnly = record({ repoPath: 'nexu-io/open-design', name: 'open-design' })
  const index = buildIdentityIndex([withBoth, repoOnly])
  assert.equal(index.idFor(withBoth), index.idFor(repoOnly))
})

test('the class representative does not depend on input order', () => {
  const a = record({ npm: 'x', repoPath: 'o/x', name: 'x' })
  const b = record({ repoPath: 'o/x', name: 'x' })
  const forward = buildIdentityIndex([a, b]).idFor(a)
  const backward = buildIdentityIndex([b, a]).idFor(a)
  assert.equal(forward, backward)
})

test('two plugins are never merged by a shared URL alone', () => {
  const root = record({ repoPath: 'volcengine/OpenViking', name: 'OpenViking' })
  const sub = record({ npm: '@openviking/dsh-memory-plugin', repoPath: 'volcengine/OpenViking', repoSubpath: 'examples/dsh-memory-plugin', name: 'dsh-memory-plugin' })
  const index = buildIdentityIndex([root, sub])
  assert.notEqual(index.idFor(root), index.idFor(sub), 'a repo-root entry and a subpath plugin are different plugins')
})

test('a target inferred from a repository needs evidence; an explicit one does not', () => {
  assert.equal(classifyTarget({ npm: 'x' }).needsEvidence, false)
  assert.equal(classifyTarget({ install: 'dsh plugin add github:o/r' }).needsEvidence, false)
  assert.equal(classifyTarget({ repoPath: 'o/r' }).needsEvidence, true)
  assert.equal(classifyTarget({ repoPath: 'o/r', installable: false }).kind, 'unknown',
    'a source that says the entry is not installable is believed')
})

test('every install spec shape found in production is classified correctly', () => {
  const cases = [
    // [install command, expected kind]
    ['dsh plugin --profile web add @linxin666/dsh-web-ui-all@0.1.10', 'npm'],
    ['dsh plugin --profile web add dsh-codex-connect@alpha', 'npm'],
    ['dsh plugin --profile web add dsh-web-plugin-manager@latest', 'npm'],
    ['dsh plugin --profile web add npm:dsh-plugins-store', 'npm'],
    ['dsh plugin --profile web add @openviking/dsh-memory-plugin', 'npm'],
    ['dsh plugin --profile web add "github:Aisland-SJL/dsh-usage"', 'github'],
    ['dsh plugin --profile web add "github:JimmyLv/bibigpt-skill#path:/dsh-plugin"', 'github'],
    ['dsh plugin add github:nexu-io/open-design', 'github'],
    ['dsh plugin add https://github.com/o/r/releases/download/v1/p.tgz', 'tarball'],
  ]
  for (const [command, kind] of cases) {
    assert.equal(classifyTarget({ install: command }).kind, kind, command)
  }
})

test('a quoted spec is unwrapped so the target itself stays installable', () => {
  const target = classifyTarget({ install: 'dsh plugin --profile web add "github:Aisland-SJL/dsh-usage"' })
  assert.equal(target.target, 'github:Aisland-SJL/dsh-usage', 'quotes must not survive into the target')
  assert.ok(!target.target.includes('"'))
})

test('a version on an npm spec is part of the target, not the kind', () => {
  const target = classifyTarget({ install: 'dsh plugin --profile web add @linxin666/dsh-web-ui-all@0.1.10' })
  assert.equal(target.kind, 'npm')
  assert.equal(target.target, '@linxin666/dsh-web-ui-all@0.1.10')
})

test('normalize reads camelCase, summary fields and split summaries', () => {
  const plugin = normalize({
    fullName: 'tt-a1i/archify#integrations/deepseek-harness',
    name: 'deepseek-harness',
    owner: 'tt-a1i',
    repo: 'archify',
    subpath: 'integrations/deepseek-harness',
    summary: 'Generate diagrams.',
    summaryZh: '生成图表。',
    stars: 37259,
    npmPackage: null,
    install: null,
    installable: false,
    url: 'https://github.com/tt-a1i/archify',
  }, 'dshmarketplace')
  assert.equal(plugin.repoPath, 'tt-a1i/archify')
  assert.equal(plugin.repoSubpath, 'integrations/deepseek-harness')
  assert.equal(plugin.description.en, 'Generate diagrams.')
  assert.equal(plugin.description.zh, '生成图表。')
  assert.equal(plugin.name, 'deepseek-harness')
})

test('a raw npm search score is never turned into stars', () => {
  const plugin = normalize({ name: 'x', npm: 'x', score: 53.6, downloads: 100 }, 'npm-keyword')
  assert.equal(plugin.stars, 0)
  assert.equal(plugin.score, 100)
})

test('the winner of a duplicate pair is the one that ranks higher', () => {
  const rich = normalize({ name: 'x', repo: 'o/x', stars: 10, downloads: 5 }, 's')
  const poor = normalize({ name: 'x', repo: 'o/x', stars: 1, downloads: 0 }, 's')
  assert.equal(betterRecord(rich, poor), true)
  assert.equal(betterRecord(poor, rich), false)
})

test('inspectManifest reports each break the ecosystem actually ships', () => {
  assert.deepEqual(inspectManifest(null).map((i) => i.code), [ISSUE.MISSING_MANIFEST])
  assert.ok(inspectManifest({ name: 'x' }).some((i) => i.code === ISSUE.MISSING_MANIFEST))
  assert.ok(inspectManifest({ name: 'x', dsh: { bundle: {} } }).some((i) => i.code === ISSUE.MISSING_BUNDLE_PATCH))
  assert.ok(inspectManifest({ name: 'x', dsh: { client: {} } }).some((i) => i.code === ISSUE.MISSING_CLIENT_PLATFORM))
  const treeMiss = inspectManifest({ name: 'x', dsh: { bundle: { patch: './nope.yml' } } }, { treePaths: ['cordis.patch.yml'] })
  assert.ok(treeMiss.some((i) => i.code === ISSUE.PATCH_NOT_IN_TREE))
  const peer = inspectManifest(
    { name: 'x', dsh: { bundle: { patch: './cordis.patch.yml' } }, peerDependencies: { '@deepseek-ai/cordis': '^4.0.1' } },
    { treePaths: ['cordis.patch.yml'], hostVersion: '5.0.0' },
  )
  assert.ok(peer.some((i) => i.code === ISSUE.PEER_VERSION_MISMATCH))
})

test('planRepair produces an installable overlay for a fixable plugin', () => {
  const plugin = { name: 'broken', npm: 'broken-pkg', target: 'github:o/broken', install: 'dsh plugin add github:o/broken' }
  const manifest = { name: 'broken-pkg', version: '1.2.3', dsh: { bundle: {} } }
  const plan = planRepair({ plugin, manifest, treePaths: ['cordis.patch.yml'] })
  assert.equal(plan.needed, true)
  assert.equal(plan.overlay.name, 'dsh-market-fixed-broken-pkg')
  assert.equal(plan.overlay.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(plan.overlay.dependencies['broken-pkg'], '>=1.2.3')
  assert.ok(plan.notes.length > 0)
})

test('planRepair leaves a healthy plugin alone', () => {
  const plugin = { name: 'fine', npm: 'fine', target: 'npm:fine', install: 'dsh plugin add fine' }
  const plan = planRepair({ plugin, manifest: { name: 'fine', dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } } }, treePaths: ['cordis.patch.yml'] })
  assert.equal(plan.needed, false)
  assert.equal(plan.overlay, null)
})

test('planRepair refuses to invent a target it cannot install', () => {
  const plugin = { name: 'x', npm: null, target: 'github:o/x', install: 'dsh plugin add github:o/x' }
  const plan = planRepair({ plugin, manifest: { name: 'x', version: '1.0.0', dsh: {} } })
  assert.equal(plan.needed, false, 'a missing manifest is reported, not papered over')
  assert.ok(plan.issues.length > 0)
})

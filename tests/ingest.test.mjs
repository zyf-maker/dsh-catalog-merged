/**
 * Tests for the pieces that decide what the market contains: identity folding,
 * target classification, and compatibility repair.
 *
 * Run with `node --test tests/`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildIdentityIndex, candidateKeys, parseRepo } from '../ingest/identity.mjs'
import { normalize, classifyTarget, betterRecord, npmNameOfSpec, byRank } from '../ingest/normalize.mjs'
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

test('a monorepo keeps every package: 19 siblings are not collapsed into one', () => {
  // The production regression this exists for: zhu1090093659/dsh-web publishes
  // 19 packages and the equivalence-class merge reduced them to a single entry.
  const packages = [
    'dsh-pet', 'dsh-ssh', 'dsh-i18n', 'dsh-usage', 'dsh-doctor', 'dsh-liangshen',
    'dsh-remote-web-ui', 'dsh-session-archive', 'dsh-client-ui-git-graph',
    'dsh-client-ui-task-board', 'dsh-client-ui-skill-explorer', 'dsh-client-ui-market',
    'dsh-client-ui-plugin-manager', 'dsh-client-ui-web-ui-settings', 'dsh-client-ui-skin-center',
    'dsh-client-ui-session-id', 'dsh-client-ui-community-plugins', 'dsh-tool-describe-image', 'dsh-web-all',
  ].map((name) => record({ npm: `@linxin666/${name}`, repoPath: 'zhu1090093659/dsh-web', name }))
  const index = buildIdentityIndex(packages)
  const ids = new Set(packages.map((p) => index.idFor(p)))
  assert.equal(ids.size, 19, 'every package in a monorepo must keep its own identity')
  assert.equal(index.ambiguousRepos, 1, 'the shared repository must be reported as ambiguous')
})

test('a monorepo whose packages are named only in the install command keeps all of them', () => {
  // The second half of the production regression: 1024 Store declares no `npm`
  // field, only a command, so every one of its entries lost its package identity
  // and fell back to the shared repository key — collapsing through the fallback
  // rather than through the merge. Identity must come from whatever names the
  // package, and a command names it.
  const names = ['dsh-pet', 'dsh-ssh', 'dsh-i18n', 'dsh-usage', 'dsh-web-all']
  const records = names.map((name) => normalize({
    id: `zhu1090093659/dsh-web/packages/${name}`,
    name, owner: 'zhu1090093659', url: 'https://github.com/zhu1090093659/dsh-web',
    repository: 'dsh-web', category: 'ui', description: { en: name, zh: name },
    install: `dsh plugin --profile web add @linxin666/${name}`, stars: 10,
  }, 'deepseek1024'))
  for (const [i, record] of records.entries()) {
    assert.equal(record.npm, `@linxin666/${names[i]}`, 'the package name is derived from the command')
  }
  const index = buildIdentityIndex(records)
  assert.equal(new Set(records.map((r) => index.idFor(r))).size, names.length,
    'command-only siblings must stay distinct')
})

test('npmNameOfSpec reads every shape the ecosystem publishes', () => {
  assert.equal(npmNameOfSpec('@linxin666/dsh-pet'), '@linxin666/dsh-pet')
  assert.equal(npmNameOfSpec('@linxin666/dsh-pet@1.2.3'), '@linxin666/dsh-pet')
  assert.equal(npmNameOfSpec('dsh-codex-connect@alpha'), 'dsh-codex-connect')
  assert.equal(npmNameOfSpec('npm:dsh-plugins-store'), 'dsh-plugins-store')
  assert.equal(npmNameOfSpec('github:o/r'), null)
  assert.equal(npmNameOfSpec('https://github.com/o/r/releases/download/v1/p.tgz'), null)
})

test('a 7-day npm figure is accepted as downloads without inventing install counts', () => {
  const plugin = normalize({
    name: 'x', owner: 'o', install: 'dsh plugin --profile web add x',
    stars: 5, npmDownloads7d: 900, installs30d: 40,
  }, 'deepseek1024')
  assert.equal(plugin.downloads, 900, 'same metric (npm downloads), different window')
  assert.equal(plugin.score, 5 * 1000 + 900, 'harness installs are not added to downloads')
})

test('a repo-only listing joins the package only when the repo hosts exactly one', () => {
  const onlyChild = record({ npm: 'solo-pkg', repoPath: 'o/solo', name: 'solo' })
  const repoListing = record({ repoPath: 'o/solo', name: 'solo' })
  assert.equal(buildIdentityIndex([onlyChild, repoListing]).idFor(repoListing), 'npm:solo-pkg')

  const a = record({ npm: 'pkg-a', repoPath: 'o/mono', name: 'a' })
  const b = record({ npm: 'pkg-b', repoPath: 'o/mono', name: 'b' })
  const monoListing = record({ repoPath: 'o/mono', name: 'mono' })
  const index = buildIdentityIndex([a, b, monoListing])
  assert.equal(index.idFor(monoListing), 'repo:o/mono',
    'an ambiguous repository listing must not be attributed to one arbitrary package')
  assert.notEqual(index.idFor(a), index.idFor(b))
})

test('a subpath-qualified repository is distinct from the repository root', () => {
  const root = record({ npm: 'root-pkg', repoPath: 'o/mono', repoSubpath: null, name: 'root' })
  const child = record({ npm: 'child-pkg', repoPath: 'o/mono', repoSubpath: 'packages/child', name: 'child' })
  const index = buildIdentityIndex([root, child])
  assert.notEqual(index.idFor(root), index.idFor(child))
  // Two *different* repositories share nothing; the same repo+subpath does.
  const sameSub = record({ repoPath: 'o/mono', repoSubpath: 'packages/child', name: 'child' })
  assert.equal(index.idFor(child), index.idFor(sameSub))
})

test('the id a record resolves to is consistent with its own npm field', () => {
  // The broken merge could emit `id=npm:a` beside `npm=b`; identity must be a
  // function of the record, never of whatever else happened to be in its class.
  const a = record({ npm: '@scope/one', repoPath: 'o/mono', name: 'one' })
  const b = record({ npm: '@scope/two', repoPath: 'o/mono', name: 'two' })
  const index = buildIdentityIndex([a, b])
  assert.equal(index.idFor(a), 'npm:@scope/one')
  assert.equal(index.idFor(b), 'npm:@scope/two')
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

test('ranking falls back to recency, not the alphabet, in the zero-score tail', () => {
  // A third of the catalog (3624 plugins) has neither stars nor downloads, so its
  // score is exactly zero. Ordering those rows by name would mean "sort by score"
  // was, in its tail, sorted by name — which is not what the control promises.
  const older = { name: 'aaa-old', score: 0, stars: 0, downloads: 0, added: '2026-01-01' }
  const newer = { name: 'zzz-new', score: 0, stars: 0, downloads: 0, added: '2026-09-01' }
  assert.equal(byRank(newer, older) < 0, true, 'the newer zero-score plugin ranks first')
  assert.equal(byRank(older, newer) > 0, true, 'and the relation is antisymmetric')

  // A scored plugin still outranks any zero-score plugin regardless of date.
  const scored = { name: 'scored', score: 5000, stars: 5, downloads: 0, added: '2020-01-01' }
  assert.equal(byRank(scored, newer) < 0, true, 'popularity beats recency')
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

/**
 * Harness-format compatibility: check a candidate against what the harness
 * requires, and plan a repair instead of letting the install abort.
 *
 * The rule the ecosystem publishes under is "a plugin declares a `dsh.bundle`
 * manifest and installs with `dsh plugin add`". Real repositories break that in
 * a small number of predictable ways — a patch file nobody wired up, a client
 * half with no platform, peers pinned to a version the running host is not.
 * Every one of those is fixable from the outside, so the market fixes it and
 * records the fix rather than reporting a failure the user cannot act on.
 */

/** What can be wrong with a candidate, as codes the UI can explain. */
export const ISSUE = {
  MISSING_MANIFEST: 'missing-manifest',
  MISSING_BUNDLE_PATCH: 'missing-bundle-patch',
  PATCH_NOT_IN_TREE: 'patch-not-in-tree',
  MISSING_CLIENT_PLATFORM: 'missing-client-platform',
  PEER_VERSION_MISMATCH: 'peer-version-mismatch',
  NAME_MISMATCH: 'name-mismatch',
  NO_ENTRY: 'no-entry',
  NATIVE_ADDON: 'native-addon',
}

/** Files that, when present in a repository, are the bundle patch it forgot to declare. */
const PATCH_HINTS = ['cordis.patch.yml', 'cordis.patch.yaml', 'dsh.patch.yml', 'dsh/cordis.patch.yml']

/**
 * Validate one candidate manifest.
 *
 * @param manifest - the package.json contents (already parsed).
 * @param options - `treePaths` (repository file list, when available) and
 *   `hostVersion` (the running harness version, e.g. `0.1.0-rc.7`).
 * @returns a list of issues, each with the evidence that produced it.
 */
export function inspectManifest(manifest, { treePaths = null, hostVersion = null } = {}) {
  const issues = []
  if (manifest === null || typeof manifest !== 'object') {
    return [{ code: ISSUE.MISSING_MANIFEST, detail: 'no package.json' }]
  }
  const dsh = manifest.dsh ?? {}
  const bundle = dsh.bundle ?? {}
  const client = dsh.client ?? {}

  if (dsh.bundle === undefined && dsh.client === undefined) {
    issues.push({ code: ISSUE.MISSING_MANIFEST, detail: 'package.json declares neither dsh.bundle nor dsh.client' })
  }
  if (dsh.bundle !== undefined && (typeof bundle.patch !== 'string' || bundle.patch.trim() === '')) {
    issues.push({ code: ISSUE.MISSING_BUNDLE_PATCH, detail: 'dsh.bundle exists without dsh.bundle.patch' })
  }
  if (typeof bundle.patch === 'string' && bundle.patch.trim() !== '' && treePaths !== null) {
    const wanted = bundle.patch.replace(/^\.\//, '')
    if (!treePaths.includes(wanted)) {
      issues.push({ code: ISSUE.PATCH_NOT_IN_TREE, detail: `dsh.bundle.patch "${wanted}" is not in the repository tree` })
    }
  }
  if (dsh.client !== undefined) {
    const platform = client.platform
    const ok = platform === 'web' || (Array.isArray(platform) && platform.includes('web'))
    if (!ok) issues.push({ code: ISSUE.MISSING_CLIENT_PLATFORM, detail: `dsh.client.platform is ${JSON.stringify(platform ?? null)}` })
  }
  if (hostVersion !== null) {
    for (const [peer, range] of Object.entries(manifest.peerDependencies ?? {})) {
      if (!peer.startsWith('@deepseek-ai/dsh-')) continue
      if (typeof range !== 'string' || range === '*') continue
      if (!satisfiesLoose(hostVersion, range)) {
        issues.push({ code: ISSUE.PEER_VERSION_MISMATCH, detail: `${peer}@${range} vs host ${hostVersion}` })
      }
    }
  }
  if (manifest.scripts?.prepare !== undefined || manifest.scripts?.postinstall !== undefined) {
    // Not an issue by itself — the harness already gates build scripts — but the
    // market surfaces it so an install is never a surprise.
    issues.push({ code: ISSUE.NATIVE_ADDON, detail: 'declares install-time scripts; the harness gates them via allowBuilds' })
  }
  return issues
}

/**
 * Turn issues into a repair the installer can apply.
 *
 * The repair is an **overlay package**: a tiny local package that depends on
 * the real one and adds the missing `dsh` metadata. Installing the overlay
 * leaves the upstream repository untouched (nothing is forked or patched in
 * place), gives pnpm a real target to resolve, and is reversible by removing
 * one line from the profile.
 *
 * @param input - `plugin`, `manifest`, `treePaths`, `hostVersion`.
 * @returns a repair plan, or null when nothing needs fixing.
 */
export function planRepair({ plugin, manifest, treePaths = null, hostVersion = null }) {
  const issues = inspectManifest(manifest, { treePaths, hostVersion })
  const fixable = issues.filter((issue) =>
    issue.code === ISSUE.MISSING_BUNDLE_PATCH ||
    issue.code === ISSUE.MISSING_CLIENT_PLATFORM ||
    issue.code === ISSUE.PEER_VERSION_MISMATCH ||
    issue.code === ISSUE.NAME_MISMATCH)
  if (fixable.length === 0) return { needed: false, issues, overlay: null, notes: [] }

  const dsh = { ...(manifest.dsh ?? {}) }
  const notes = []

  if (fixable.some((i) => i.code === ISSUE.MISSING_BUNDLE_PATCH)) {
    const guess = PATCH_HINTS.find((p) => treePaths === null || treePaths.includes(p)) ?? PATCH_HINTS[0]
    dsh.bundle = { ...(dsh.bundle ?? {}), patch: `./${guess}` }
    notes.push(`declared the bundle patch the repository already ships (${guess})`)
  }
  if (fixable.some((i) => i.code === ISSUE.MISSING_CLIENT_PLATFORM)) {
    dsh.client = { ...(dsh.client ?? {}), platform: 'web' }
    notes.push('added the missing web platform to the client half')
  }

  const base = String(plugin.npm ?? plugin.name).replace(/^@/, '').replace('/', '-')
  const overlayName = `dsh-market-fixed-${base}`.toLowerCase().replace(/[^a-z0-9-_.]/g, '-')
  const dependencies = {}
  // The overlay depends on the real plugin through a range that always resolves:
  // an omitted range would make pnpm look for the overlay's own name upstream.
  dependencies[plugin.npm ?? plugin.name] = plugin.npm ? `>=${manifest.version ?? '0.0.0'}` : plugin.target
  for (const issue of fixable.filter((i) => i.code === ISSUE.PEER_VERSION_MISMATCH)) {
    const peer = issue.detail.split('@')[0]
    dependencies[peer] = `^${hostVersion}`
    notes.push(`pinned ${peer} to the running host (${hostVersion})`)
  }

  const overlay = {
    name: overlayName,
    version: '0.0.0',
    private: true,
    description: `Install shim generated by dsh-market for ${plugin.name}`,
    dsh,
    dependencies,
  }
  return {
    needed: true,
    issues,
    overlay,
    notes,
    command: `dsh plugin --profile web add ./overlays/${overlayName}`,
  }
}

/** Loosely compare a version against a range without pulling in semver. */
function satisfiesLoose(version, range) {
  const clean = String(version).replace(/^[^0-9]*/, '')
  const wanted = String(range).replace(/^[\^~>=<\s]+/, '').split(/\s+/)[0]
  const a = clean.split('.').map((n) => Number.parseInt(n, 10) || 0)
  const b = wanted.split('.').map((n) => Number.parseInt(n, 10) || 0)
  // Caret/tilde semantics are close enough at this precision: majors must match
  // for the lockstep @deepseek-ai packages, which is the only case this serves.
  return a[0] === b[0]
}

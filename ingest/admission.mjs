/**
 * Admission control: is this repository actually an installable plugin?
 *
 * A topic tag is a claim, not evidence. Measured on production data: 53 of the
 * top 100 entries had been admitted by a raw `topic:dsh-plugin` harvest with no
 * verification at all, which is how `cherry-studio`, `PicGo` and `nocobase` —
 * real projects that merely carry the tag — came to sit in a plugin market next
 * to a one-click install button.
 *
 * The evidence the ecosystem itself publishes is the manifest rule: a plugin
 * declares `dsh.bundle` (or `dsh.client`) in its `package.json` and installs
 * with `dsh plugin add`. So admission reads that file and requires the field.
 *
 * The probe is cached by `owner/repo@pushedAt`, so a run only pays for
 * repositories that are new or have actually changed.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { posix } from 'node:path'

/** Files a monorepo plugin may declare its manifest in, cheapest first. */
const MANIFEST_PATHS = ['package.json']

/** Fallback bundle patch names used by real plugins that forgot to wire one. */
const PATCH_HINTS = ['cordis.patch.yml', 'cordis.patch.yaml', 'dsh.patch.yml', 'dsh/cordis.patch.yml']

/** A bounded set keeps one bad manifest from causing an unbounded probe. */
const MAX_ENTRYPOINT_PROBES = 8

/**
 * Read one manifest. Prefers raw.githubusercontent (no API quota, no auth) and
 * falls back to the contents API for private or unusually named branches.
 *
 * `branch` defaults to `HEAD`, which raw resolves to the repository's default
 * branch — guessing `main` would reject every repository that still uses
 * `master`, and reading the wrong branch is indistinguishable from a repository
 * that genuinely has no manifest.
 *
 * The distinction between "no such file" and "could not ask" is the whole point
 * of the return shape: a 404 is evidence of absence and may reject a plugin, a
 * network failure is not evidence of anything and must never do so.
 *
 * @returns `{ status: 'found', manifest, path }` | `{ status: 'absent' }` | `{ status: 'error', detail }`.
 */
async function readManifest({ repoPath, subpath, branch, fetchImpl, token }) {
  const candidates = subpath === null
    ? [...MANIFEST_PATHS]
    : [...MANIFEST_PATHS.map((p) => `${subpath}/${p}`), ...MANIFEST_PATHS]
  let sawError = null
  for (const path of candidates) {
    // One retry: a transient reset on a 13k-repository run must not be read as
    // "this plugin does not exist".
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const res = await fetchImpl(`https://raw.githubusercontent.com/${repoPath}/${branch}/${path}`, {
          headers: { 'user-agent': 'dsh-market-admission' },
        })
        if (res.status === 404) break
        if (!res.ok) { sawError = `HTTP ${res.status}`; continue }
        const text = await res.text()
        // A proxy can serve an HTML error page with status 200, so a manifest
        // must actually parse before it is trusted.
        try { return { status: 'found', manifest: JSON.parse(text), path } } catch { sawError = 'unparsable'; continue }
      } catch (error) {
        sawError = String(error?.message ?? error)
      }
    }
  }
  if (token !== undefined) {
    for (const path of candidates) {
      try {
        const res = await fetchImpl(
          `https://api.github.com/repos/${repoPath}/contents/${path}?ref=${encodeURIComponent(branch)}`,
          { headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'user-agent': 'dsh-market-admission' } },
        )
        if (res.status === 404) continue
        if (!res.ok) { sawError = `api HTTP ${res.status}`; continue }
        const json = await res.json()
        if (typeof json.content !== 'string') continue
        return { status: 'found', manifest: JSON.parse(Buffer.from(json.content, 'base64').toString('utf8')), path }
      } catch (error) {
        sawError = String(error?.message ?? error)
      }
    }
  }
  return sawError === null ? { status: 'absent' } : { status: 'error', detail: sawError }
}

/**
 * Decide whether a repository is an installable plugin.
 *
 * @param input - `repoPath`, `subpath`, `branch`, `fetchImpl`, `token`.
 * @returns `{ ok, reason, manifest, manifestPath }`. `ok: false` with a reason
 *   other than `probe-error` is a decision; `probe-error` means the question
 *   could not be answered, and callers must keep the record and retry later
 *   rather than treating silence as a rejection.
 */
export async function verifyPlugin({ repoPath, subpath = null, branch = 'HEAD', fetchImpl = fetch, token }) {
  if (typeof repoPath !== 'string' || repoPath === '') return { ok: false, reason: 'no-repo' }
  const read = await readManifest({ repoPath, subpath, branch, fetchImpl, token })
  if (read.status === 'error') return { ok: false, reason: 'probe-error', detail: read.detail }
  if (read.status === 'absent') return { ok: false, reason: 'no-manifest' }
  const { manifest, path } = read
  const dsh = manifest.dsh
  if (dsh === null || typeof dsh !== 'object') return { ok: false, reason: 'no-dsh-field', manifest, manifestPath: path }
  const declaresBundle = typeof dsh.bundle === 'object' && dsh.bundle !== null
  const declaresClient = typeof dsh.client === 'object' && dsh.client !== null
  if (!declaresBundle && !declaresClient) return { ok: false, reason: 'no-bundle-or-client', manifest, manifestPath: path }
  const probe = await probeRuntime({
    repoPath, branch, manifest, manifestPath: path, fetchImpl, token, declaresBundle, declaresClient,
  })
  if (probe.status === 'error') return { ok: false, reason: 'probe-error', detail: probe.detail, manifest, manifestPath: path }
  if (!probe.ok) return { ok: false, reason: probe.reason, manifest, manifestPath: path, probe: probe.details }
  return {
    ok: true,
    reason: declaresBundle ? 'dsh.bundle' : 'dsh.client',
    manifest,
    manifestPath: path,
    probe: probe.details,
  }
}

/**
 * Probe the files that make a declared plugin real.
 *
 * A manifest field is only a claim. A bundle must point to a non-empty patch
 * containing at least one Loader insertion, or expose an actual entry file;
 * a client must expose an entry file or a non-empty injection list. This is a
 * read-only static probe: the market never executes untrusted repository code
 * during ingestion.
 */
async function probeRuntime({ repoPath, branch, manifest, manifestPath, fetchImpl, token, declaresBundle, declaresClient }) {
  const packageDir = posix.dirname(manifestPath) === '.' ? '' : posix.dirname(manifestPath)
  const details = { manifestPath, patch: null, entrypoints: [], clientInjects: 0 }
  let sawProbeError = null
  let sawConcreteRuntime = false

  const read = async (relativePath) => {
    const path = packageRelativePath(packageDir, relativePath)
    if (path === '') return { status: 'absent', path }
    const result = await readRepositoryFile({ repoPath, branch, path, fetchImpl, token })
    if (result.status === 'error') sawProbeError = result.detail
    return { ...result, path }
  }

  if (declaresBundle) {
    const declaredPatch = typeof manifest.dsh.bundle.patch === 'string' ? manifest.dsh.bundle.patch.trim() : ''
    const candidates = declaredPatch === '' ? PATCH_HINTS : [declaredPatch, ...PATCH_HINTS]
    const seen = new Set()
    for (const candidate of candidates) {
      const result = await read(candidate)
      if (seen.has(result.path)) continue
      seen.add(result.path)
      if (result.status !== 'found') continue
      const meaningful = hasLoaderInsertion(result.text)
      details.patch = { path: result.path, meaningful }
      if (meaningful) sawConcreteRuntime = true
      break
    }
  }

  const clientInject = manifest.dsh.client?.inject
  if (declaresClient && Array.isArray(clientInject) && clientInject.some((item) => String(item).trim() !== '')) {
    details.clientInjects = clientInject.filter((item) => String(item).trim() !== '').length
    sawConcreteRuntime = true
  }

  // A meaningful bundle patch is already a runtime proof. Only fan out to
  // package entrypoint probes when the manifest has no usable patch/inject
  // signal; this keeps a full catalog run bounded to roughly one extra read
  // for a valid bundle instead of probing every export path as well.
  if (!sawConcreteRuntime) {
    const paths = entrypointPaths(manifest)
    for (const candidate of paths.slice(0, MAX_ENTRYPOINT_PROBES)) {
      const result = await read(candidate)
      if (result.status !== 'found') continue
      if (!hasExecutableText(result.text)) continue
      details.entrypoints.push(result.path)
      sawConcreteRuntime = true
    }
  }

  if (sawConcreteRuntime) return { ok: true, details }
  if (sawProbeError !== null) return { status: 'error', detail: sawProbeError }
  return { ok: false, reason: 'empty-plugin-entry', details }
}

/** Resolve a manifest-relative path without allowing a repository traversal. */
function packageRelativePath(packageDir, value) {
  const clean = String(value ?? '').trim().replace(/^\.\//, '')
  const resolved = posix.normalize(posix.join(packageDir, clean))
  return resolved === '..' || resolved.startsWith('../') ? '' : resolved
}

/** Export values in package.json, including conditional/nested exports. */
function entrypointPaths(manifest) {
  const values = []
  const add = (value) => {
    if (typeof value === 'string' && value.startsWith('.') && !/(?:^|\/)package\.json$|\.(?:json|map|d\.ts|md)$/i.test(value)) values.push(value)
    else if (Array.isArray(value)) value.forEach(add)
    else if (value !== null && typeof value === 'object') Object.values(value).forEach(add)
  }
  add(manifest.main)
  add(manifest.module)
  add(manifest.browser)
  add(manifest.exports)
  return [...new Set(values)]
}

/** A non-empty patch must actually add at least one Loader entry. */
function hasLoaderInsertion(text) {
  const body = String(text ?? '').replace(/^\s*#.*$/gm, '').trim()
  if (!/(?:^|\n)\s*-\s*insert\s*:/m.test(body)) return false
  return /^\s*name\s*:\s*['"]?[^'"\n#]+['"]?\s*$/m.test(body)
}

/** Reject files containing only whitespace/comments, not normal source code. */
function hasExecutableText(text) {
  const body = String(text ?? '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1')
    .replace(/(^|\s)#.*$/gm, '$1')
    .trim()
  return body.length > 0
}

/** Read a repository file with transient-error semantics and API fallback. */
async function readRepositoryFile({ repoPath, branch, path, fetchImpl, token }) {
  let sawError = null
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await fetchImpl(`https://raw.githubusercontent.com/${repoPath}/${branch}/${path}`, {
        headers: { 'user-agent': 'dsh-market-admission' },
      })
      if (res.status === 404) return { status: 'absent' }
      if (!res.ok) { sawError = `HTTP ${res.status}`; continue }
      return { status: 'found', text: await res.text() }
    } catch (error) {
      sawError = String(error?.message ?? error)
    }
  }
  if (token !== undefined) {
    try {
      const res = await fetchImpl(
        `https://api.github.com/repos/${repoPath}/contents/${path}?ref=${encodeURIComponent(branch)}`,
        { headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'user-agent': 'dsh-market-admission' } },
      )
      if (res.status === 404) return { status: 'absent' }
      if (!res.ok) return { status: 'error', detail: `api HTTP ${res.status}` }
      const json = await res.json()
      if (typeof json.content !== 'string') return { status: 'absent' }
      return { status: 'found', text: Buffer.from(json.content, 'base64').toString('utf8') }
    } catch (error) {
      sawError = String(error?.message ?? error)
    }
  }
  return { status: 'error', detail: sawError ?? 'unknown probe error' }
}

/**
 * How long an admission verdict is trusted.
 *
 * A verdict keyed only by revision never expires for a repository that reports
 * no revision at all (`repo@pushedAt` where `pushedAt` is empty), so a plugin
 * rejected once because its manifest was missing would stay rejected forever —
 * including after it ships the manifest. Expiring verdicts means every
 * repository is re-asked eventually, and a changed revision is re-asked
 * immediately because it produces a different key.
 */
export const VERDICT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/**
 * A cache of admission verdicts, keyed by `repo@revision`.
 *
 * Keyed by revision rather than by repo on purpose: a repository that adds a
 * manifest should be admitted on the next run, and one that removes it should
 * be dropped, without a human clearing anything.
 */
export class AdmissionCache {
  #entries
  #hits = 0
  #misses = 0
  #expired = 0

  constructor(path, { maxAgeMs = VERDICT_MAX_AGE_MS } = {}) {
    this.path = path
    this.maxAgeMs = maxAgeMs
    this.#entries = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
  }

  /** Look up a verdict, or undefined when it is missing or too old to trust. */
  get(key) {
    const hit = this.#entries[key]
    if (hit === undefined) { this.#misses += 1; return undefined }
    const age = Date.now() - (Number(hit.at) || 0)
    if (!Number.isFinite(age) || age > this.maxAgeMs) { this.#expired += 1; this.#misses += 1; return undefined }
    this.#hits += 1
    return hit
  }

  /** Record a verdict, stamped so it can expire. */
  set(key, value) {
    this.#entries[key] = { ...value, at: Date.now() }
  }

  /** Persist, pruning verdicts for revisions no longer current. */
  save(currentKeys) {
    const keep = new Set(currentKeys)
    for (const key of Object.keys(this.#entries)) if (!keep.has(key)) delete this.#entries[key]
    writeFileSync(this.path, JSON.stringify(this.#entries, null, 0))
  }

  get stats() {
    return { hits: this.#hits, misses: this.#misses, expired: this.#expired, size: Object.keys(this.#entries).length }
  }
}

/**
 * Verify many candidates with bounded concurrency.
 *
 * @param candidates - `{ repoPath, subpath, branch, cacheKey }` entries.
 * @returns a `Map<cacheKey, verdict>`.
 */
export async function verifyAll(candidates, { cache, fetchImpl = fetch, token, log = () => {}, concurrency = 32 }) {
  const verdicts = new Map()
  const queue = [...candidates]
  let done = 0
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (;;) {
      const item = queue.shift()
      if (item === undefined) return
      const cached = cache.get(item.cacheKey)
      if (cached !== undefined) { verdicts.set(item.cacheKey, cached); continue }
      const verdict = await verifyPlugin({ repoPath: item.repoPath, subpath: item.subpath, branch: item.branch, fetchImpl, token })
      // Keep the manifest and static probe details with the verdict. A cached
      // admission must remain able to produce the same compatibility plan as a
      // fresh probe; caching only ok/reason silently disabled repairs on later
      // runs.
      cache.set(item.cacheKey, verdict)
      verdicts.set(item.cacheKey, verdict)
      done += 1
      if (done % 50 === 0) log(`  admission: ${done}/${candidates.length} probed`)
    }
  })
  await Promise.all(workers)
  return verdicts
}

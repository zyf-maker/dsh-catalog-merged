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

/** Files a monorepo plugin may declare its manifest in, cheapest first. */
const MANIFEST_PATHS = ['package.json']

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
  return { ok: true, reason: declaresBundle ? 'dsh.bundle' : 'dsh.client', manifest, manifestPath: path }
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
export async function verifyAll(candidates, { cache, fetchImpl = fetch, token, log = () => {}, concurrency = 8 }) {
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
      cache.set(item.cacheKey, { ok: verdict.ok, reason: verdict.reason })
      verdicts.set(item.cacheKey, verdict)
      done += 1
      if (done % 50 === 0) log(`  admission: ${done}/${candidates.length} probed`)
    }
  })
  await Promise.all(workers)
  return verdicts
}

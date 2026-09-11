/**
 * Identity resolution.
 *
 * The same plugin arrives from different sources through different namespaces:
 * one catalog knows its npm package, another only its repository, a third only
 * a display name. Keying each record independently puts one plugin into several
 * namespaces at once, so the market lists it several times (measured: 3398 such
 * groups on production data).
 *
 * The first fix for that modelled identity as an *equivalence* class over the
 * keys a record carries — if one record names both `npm:x` and `repo:o/r`, those
 * two keys must denote the same plugin. That is wrong, and it silently deleted
 * plugins: `npm ↔ repo` is **many-to-one**, because a monorepo publishes many
 * packages from one repository. On production data `zhu1090093659/dsh-web`
 * publishes 19 packages (`@linxin666/dsh-pet`, `dsh-ssh`, `dsh-i18n`, …) and
 * equivalence collapsed all 19 into one entry, losing 18; four other monorepos
 * lost every one of their packages.
 *
 * So identity is a *precedence*, and a repository link is used only when it is
 * unambiguous:
 *
 *   1. `npm:<name>` — globally unique, always wins.
 *   2. `repo:<owner>/<name>#<subpath>` — unique per directory, for repo-only listings.
 *   3. `repo:<owner>/<name>` — only when the repository hosts exactly one known plugin.
 *   4. `name:<name>` — last resort, groups only what nothing else could.
 *
 * A repository claimed by two or more npm packages proves nothing about which
 * package a repo-only listing refers to, so its links are refused rather than
 * guessed at. An extra duplicate entry is recoverable; a deleted plugin is not.
 */

/** npm package names the harness accepts. */
export const NPM_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/

/** `owner/name`, the only shape accepted as a repository identity. */
const OWNER_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

/**
 * Normalize the several shapes a repository path arrives in.
 *
 * Sources disagree about what "repo" means: some send `owner/name`, some send a
 * bare name beside a separate owner (measured: 6593 records), some fold a
 * monorepo subpath into the same string. Every shape collapses to
 * `{ path, subpath }` or null, so nothing downstream has to guess.
 *
 * @param input - `fullName`/`full_name`/`repo`, plus `owner`/`subpath` when separate.
 */
export function parseRepo({ fullName, full_name, repo, owner, subpath }) {
  const raw = String(fullName ?? full_name ?? '').trim()
  if (raw !== '') {
    const [pathPart, ...rest] = raw.split('#')
    const inline = rest.join('#').trim()
    return finalize(pathPart, inline !== '' ? inline : subpath ?? null)
  }
  const bare = String(repo ?? '').trim()
  if (bare === '') return null
  // `owner/name` in the repo field; the owner field is a fallback, never a
  // prefix for a name that already carries one.
  if (bare.includes('/')) {
    const [pathPart, ...rest] = bare.split('#')
    const inline = rest.join('#').trim()
    return finalize(pathPart, inline !== '' ? inline : subpath ?? null)
  }
  const withOwner = String(owner ?? '').trim() !== '' ? `${String(owner).trim()}/${bare}` : ''
  return finalize(withOwner, subpath ?? null)
}

/** Validate a repository path and its subpath together. */
function finalize(path, subpath) {
  const clean = String(path ?? '').trim().replace(/\.git$/i, '')
  if (!OWNER_REPO.test(clean)) return null
  const sub = subpath === null || subpath === undefined ? '' : String(subpath).trim().replace(/^\/+|\/+$/g, '')
  // `..` would escape the repository when a consumer builds a URL from this.
  if (sub !== '' && sub.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) return null
  return { path: clean, subpath: sub === '' ? null : sub }
}

/** GitHub `owner/name` out of any URL shape, ignoring tree/branch noise. */
export function repoFromUrl(url) {
  const match = /github\.com\/([^/\s]+\/[^/\s#?]+?)(?:\.git)?(?:[/#?]|$)/.exec(String(url ?? ''))
  if (match === null) return null
  return parseRepo({ repo: match[1] })
}

/** The npm identity of a record, or null. */
export function npmKeyOf(record) {
  return record.npm && NPM_NAME.test(record.npm) ? `npm:${record.npm.toLowerCase()}` : null
}

/**
 * The repository key of a record: the subpath-qualified form when there is one,
 * because a subpath names a directory and a bare path only names the repository.
 */
export function repoKeyOf(record) {
  if (!record.repoPath) return null
  const base = record.repoPath.toLowerCase()
  return record.repoSubpath === null ? `repo:${base}` : `repo:${base}#${record.repoSubpath.toLowerCase()}`
}

/**
 * Every key this record could be identified by, strongest first.
 *
 * Kept as a public view (tooling and tests read it) but no longer the basis of
 * the merge: the keys of one record are not an equivalence class.
 */
export function candidateKeys(record) {
  const keys = []
  const npm = npmKeyOf(record)
  if (npm !== null) keys.push(npm)
  const repo = repoKeyOf(record)
  if (repo !== null) keys.push(repo)
  if (keys.length === 0 && record.name) keys.push(`name:${String(record.name).toLowerCase()}`)
  return keys
}

/**
 * Build the identity resolver for a corpus.
 *
 * @param records - records carrying `npm`/`repoPath`/`repoSubpath`/`name`.
 * @returns `{ idFor, ambiguousRepos, claimedRepos }`; `ambiguousRepos` counts the
 *   repositories whose links were refused because more than one package claims
 *   them, which is the number this module exists to get right.
 */
export function buildIdentityIndex(records) {
  // Which npm packages claim each repository. Two or more means a monorepo, and
  // then the repository key cannot say which package a repo-only listing means.
  /** @type {Map<string, Set<string>>} */
  const claims = new Map()
  for (const record of records) {
    const npmKey = npmKeyOf(record)
    const repoKey = repoKeyOf(record)
    if (npmKey === null || repoKey === null) continue
    if (!claims.has(repoKey)) claims.set(repoKey, new Set())
    claims.get(repoKey).add(npmKey)
  }

  let ambiguousRepos = 0
  for (const owners of claims.values()) if (owners.size > 1) ambiguousRepos += 1

  /**
   * The class a record belongs to. Derived from the record's own keys, so the
   * id and the record's fields can never disagree — the previous version could
   * emit `id=npm:a` beside `npm=b` when a class had been wrongly merged.
   */
  const idFor = (record) => {
    const npmKey = npmKeyOf(record)
    if (npmKey !== null) return npmKey
    const repoKey = repoKeyOf(record)
    if (repoKey !== null) {
      const owners = claims.get(repoKey)
      // Exactly one claimant: the repo-only listing is that plugin.
      if (owners !== undefined && owners.size === 1) return [...owners][0]
      // None, or several: the repository is the most specific thing we know.
      return repoKey
    }
    return record.name ? `name:${String(record.name).toLowerCase()}` : null
  }

  return { idFor, ambiguousRepos, claimedRepos: claims.size }
}

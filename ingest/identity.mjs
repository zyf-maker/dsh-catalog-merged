/**
 * Identity resolution.
 *
 * The same plugin arrives from different sources through different namespaces:
 * one catalog knows its npm package, another only its repository, a third only
 * a display name. Keying each record independently (which the first version
 * did) puts one plugin into several namespaces at once, and the market then
 * lists it several times — measured on production data: 3398 such groups.
 *
 * The fix is to stop treating identity as a property of a record and treat it
 * as an equivalence class over the keys a record *does* carry: a record that
 * names both its npm package and its repository is the evidence that those two
 * keys denote the same plugin. Union-find folds that evidence transitively, and
 * a deterministic representative keeps ids stable across runs.
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

/**
 * Every key that could denote this record, strongest first.
 *
 * Order is the precedence used when no equivalence evidence exists: an npm name
 * is globally unique, a repository path (with its subpath) is unique on GitHub,
 * and a display name is a last resort that only ever groups records nothing
 * else could group.
 *
 * A repository key WITHOUT a subpath and one WITH a subpath are deliberately
 * distinct keys: a monorepo can publish several plugins, and collapsing them
 * would silently delete all but one.
 */
export function candidateKeys(record) {
  const keys = []
  if (record.npm && NPM_NAME.test(record.npm)) keys.push(`npm:${record.npm.toLowerCase()}`)
  if (record.repoPath) {
    const base = record.repoPath.toLowerCase()
    keys.push(record.repoSubpath === null ? `repo:${base}` : `repo:${base}#${record.repoSubpath.toLowerCase()}`)
  }
  if (keys.length === 0 && record.name) keys.push(`name:${record.name.toLowerCase()}`)
  return keys
}

/** Union-find over identity keys. */
class DisjointSet {
  #parent = new Map()

  find(key) {
    if (!this.#parent.has(key)) { this.#parent.set(key, key); return key }
    let root = key
    while (this.#parent.get(root) !== root) root = this.#parent.get(root)
    // Path compression: repeated lookups are the common case in a 13k merge.
    let cursor = key
    while (this.#parent.get(cursor) !== root) {
      const next = this.#parent.get(cursor)
      this.#parent.set(cursor, root)
      cursor = next
    }
    return root
  }

  union(a, b) {
    const rootA = this.find(a)
    const rootB = this.find(b)
    if (rootA === rootB) return
    // The smaller key wins, so the representative never depends on input order
    // and ids stay stable between runs.
    if (rootA < rootB) this.#parent.set(rootB, rootA)
    else this.#parent.set(rootA, rootB)
  }

  /** Canonical, order-independent id for the class containing `key`. */
  representative(key) {
    return this.find(key)
  }
}

/**
 * Fold every record's keys into equivalence classes.
 *
 * @param records - records carrying `npm`/`repoPath`/`repoSubpath`/`name`.
 * @returns a resolver mapping any of a record's keys to its canonical id.
 */
export function buildIdentityIndex(records) {
  const set = new DisjointSet()
  for (const record of records) {
    const keys = candidateKeys(record)
    if (keys.length === 0) continue
    for (const key of keys) set.find(key)
    // The evidence: this record claims these keys are the same plugin. Only
    // keys that co-occur in one record are joined, so two plugins that happen
    // to share a monorepo URL are never merged by coincidence.
    for (let i = 1; i < keys.length; i += 1) set.union(keys[0], keys[i])
  }
  return {
    idFor(record) {
      const keys = candidateKeys(record)
      return keys.length === 0 ? null : set.representative(keys[0])
    },
    /** Merge two already-computed ids (used when a winner adopts a loser's keys). */
    union: (a, b) => set.union(a, b),
  }
}

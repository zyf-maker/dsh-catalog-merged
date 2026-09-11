/**
 * Normalization and ranking.
 *
 * Every source invents its own field names — snake_case, camelCase, `summary`
 * beside `description`, a `repo` that is sometimes `owner/name` and sometimes a
 * bare name — and one of them (DSH Marketplace) returns `summary`/`summaryZh`
 * only. The first version read one assumed spelling, so every one of that
 * source's 7741 descriptions was silently empty and its repository identity
 * collapsed to a bare name.
 *
 * So mapping is explicit and multi-spelling here, and nothing downstream has to
 * know which source a record came from.
 */
import { parseRepo, repoFromUrl, NPM_NAME } from './identity.mjs'
import { DENY_REPOS, DENY_TYPES } from './sources.mjs'

/** Composite ranking weight: stars dominate, downloads break ties and lift. */
export const STARS_WEIGHT = 1000

/** First defined value among the spellings a source might use. */
function pick(raw, ...names) {
  for (const name of names) {
    const value = raw[name]
    if (value !== undefined && value !== null && value !== '') return value
  }
  return undefined
}

/** Localized description from a string, an object, or the split summary fields. */
function descriptionOf(raw) {
  const value = pick(raw, 'description', 'desc', 'note', 'summary')
  const zhValue = pick(raw, 'descriptionZh', 'descZh', 'summaryZh', 'noteZh')
  if (value !== undefined && typeof value === 'object' && !Array.isArray(value)) {
    return {
      en: String(value.en ?? value.English ?? '').trim(),
      zh: String(value['zh-Hans'] ?? value.zh ?? value.zh_CN ?? zhValue ?? '').trim(),
    }
  }
  return {
    en: String(value ?? '').trim(),
    zh: String(zhValue ?? '').trim(),
  }
}

/** Category as one id, from a string or an array. */
function categoryOf(raw) {
  const value = pick(raw, 'category', 'cat', 'categories')
  if (Array.isArray(value)) return String(value[0] ?? '')
  return String(value ?? '')
}

/** A finite, non-negative number, or 0. */
function numberOf(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0
}

/**
 * A full npm spec: an optional `npm:` alias prefix, a name (optionally scoped),
 * and an optional `@version` or `@dist-tag`.
 *
 * Production data contains all of these — `@linxin666/dsh-web-ui-all@0.1.10`,
 * `dsh-codex-connect@alpha`, `npm:dsh-plugins-store` — and the first version's
 * name-only pattern typed every one of them as `other`, which silently drops
 * them from any consumer that filters on the install kind.
 */
const NPM_SPEC = /^(?:npm:)?((?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*)(?:@[^\s]+)?$/i

/** Strip the quotes a source may have included around its install spec. */
function unquote(value) {
  const text = String(value ?? '').trim()
  if (text.length >= 2 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))) {
    return text.slice(1, -1).trim()
  }
  return text
}

/** GitHub-family targets, including the harness's own `#path:` monorepo selector. */
function isGitTarget(spec) {
  if (spec.startsWith('github:') || spec.startsWith('git+') || spec.startsWith('git:')) return true
  if (/^https?:\/\/github\.com\//.test(spec)) return true
  // `github:owner/repo#path:/sub` names a package inside a monorepo.
  if (spec.startsWith('github:') || /^[^\s/]+\/[^\s/]+#path:/.test(spec)) return true
  return false
}

/** A release archive hosted on GitHub, which the market binds to its own repo. */
function isTarball(spec) {
  return /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\/.+\.(tgz|tar\.gz)$/.test(spec)
}

/**
 * Classify an install target the way the harness does.
 *
 * @param input - `install`, `npm`, `tarball`, `repoPath`, `url`, `installable`.
 * @returns `{ kind, target, command, needsEvidence }`. `needsEvidence` marks a
 *   target inferred from a repository alone: those must pass admission before
 *   the market shows them, because a repository URL is not proof of a plugin.
 */
export function classifyTarget({ install = '', npm = null, tarball = null, repoPath = null, url = '', installable }) {
  const command = String(install ?? '').trim()
  // `installable: false` is a source's own verdict that the entry cannot be
  // installed; it is honoured for everything except an explicit target, which
  // is stronger evidence than the flag.
  const spec = unquote(/add\s+(.+?)\s*$/.exec(command)?.[1] ?? '')
  if (spec !== '' && spec !== 'null' && spec !== 'undefined' && !spec.startsWith('-')) {
    if (isTarball(spec)) return { kind: 'tarball', target: spec, command, needsEvidence: false }
    if (isGitTarget(spec)) return { kind: 'github', target: spec, command, needsEvidence: false }
    if (NPM_SPEC.test(spec)) return { kind: 'npm', target: spec, command, needsEvidence: false }
    return { kind: 'other', target: spec, command, needsEvidence: false }
  }
  if (npm !== null && NPM_NAME.test(String(npm))) {
    return { kind: 'npm', target: String(npm), command: command === '' ? `dsh plugin --profile web add ${npm}` : command, needsEvidence: false }
  }
  const tarballSpec = unquote(tarball ?? '')
  if (tarballSpec !== '' && isTarball(tarballSpec)) {
    return { kind: 'tarball', target: tarballSpec, command: `dsh plugin add ${tarballSpec}`, needsEvidence: false }
  }
  // Last resort: the repository itself, which requires admission evidence.
  const fromRepo = repoPath ?? (url === '' ? null : repoFromUrl(url)?.path ?? null)
  if (fromRepo !== null && installable !== false) {
    return { kind: 'github', target: `github:${fromRepo}`, command: `dsh plugin add github:${fromRepo}`, needsEvidence: true }
  }
  return { kind: 'unknown', target: '', command: '', needsEvidence: false }
}

/**
 * Turn one raw source entry into a canonical record, or null when the entry
 * cannot become an installable plugin.
 *
 * @param raw - the source's own entry object.
 * @param sourceId - provenance.
 * @param requireType - when set, the source's own `type` must equal it.
 */
export function normalize(raw, sourceId, requireType) {
  if (raw === null || typeof raw !== 'object') return null
  const type = String(pick(raw, 'type', 'kind') ?? '').trim()
  if (requireType !== undefined && type !== requireType) return null
  if (DENY_TYPES.has(type)) return null

  const repo = parseRepo({
    fullName: pick(raw, 'fullName', 'full_name'),
    repo: pick(raw, 'repo'),
    owner: pick(raw, 'owner'),
    subpath: pick(raw, 'subpath', 'path'),
  }) ?? repoFromUrl(pick(raw, 'url', 'page', 'homepage', 'repoUrl'))
  if (repo !== null && DENY_REPOS.has(repo.path.toLowerCase())) return null

  const npm = pick(raw, 'npm', 'npmPackage', 'pkg') ?? null
  const installRaw = pick(raw, 'install', 'cmd') ?? ''
  const tarball = pick(raw, 'tarball') ?? null
  const url = String(pick(raw, 'url', 'page', 'homepage', 'repoUrl')
    ?? (repo === null ? '' : `https://github.com/${repo.path}`))
  const target = classifyTarget({
    install: installRaw, npm, tarball, repoPath: repo?.path ?? null, url,
    installable: pick(raw, 'installable'),
  })
  // A record with no usable target is still kept: it may be one source's view
  // of a plugin another source can install, and dropping it here would throw
  // away its stars, its localized description and its provenance. The runner
  // drops a plugin only when no record for it has a target.
  const hasTarget = target.kind !== 'unknown'

  const name = String(pick(raw, 'name') ?? (repo === null ? '' : repo.subpath === null ? repo.path.split('/').pop() : repo.subpath.split('/').pop())).trim()
  if (name === '' && npm === null) return null

  const stars = numberOf(pick(raw, 'stars', 'starsCount', 'stargazers_count'))
  const downloads = numberOf(pick(raw, 'downloads', 'downloads30d', 'download', 'downloadCount'))

  return {
    name,
    owner: String(pick(raw, 'owner') ?? (repo === null ? '' : repo.path.split('/')[0])).trim(),
    url,
    repoPath: repo?.path ?? null,
    repoSubpath: repo?.subpath ?? null,
    category: categoryOf(raw),
    description: descriptionOf(raw),
    npm: npm === null ? null : String(npm),
    tarball: tarball === null ? null : String(tarball),
    install: target.command,
    target: target.target,
    targetKind: target.kind === 'unknown' ? 'github' : target.kind,
    hasTarget,
    // A target inferred from a repository has to be verified before the market
    // offers it as one-click installable.
    needsEvidence: target.needsEvidence,
    installable: !hasTarget ? false : (target.needsEvidence ? null : true),
    riskFlags: Array.isArray(pick(raw, 'riskFlags')) ? raw.riskFlags : [],
    stars,
    downloads,
    score: Math.round(stars * STARS_WEIGHT + downloads),
    version: String(pick(raw, 'version') ?? ''),
    added: String(pick(raw, 'added', 'pushedAt', 'pushed_at') ?? '').slice(0, 10),
    sourceId,
  }
}

/** Rank order: score, then stars, then downloads, then name (stable). */
export function byRank(a, b) {
  return (
    b.score - a.score ||
    b.stars - a.stars ||
    b.downloads - a.downloads ||
    a.name.localeCompare(b.name)
  )
}

/**
 * Which of two records for the same plugin should survive.
 *
 * Deliberately not "the newest timestamp": a source that stopped updating has
 * an old timestamp, and the ranking is built on stars and downloads, so the
 * record that wins the ranking is the one worth keeping. Ties fall back to the
 * record that carries more install-relevant information, so provenance and a
 * richer install command are never thrown away for an equally ranked duplicate.
 */
export function betterRecord(candidate, existing) {
  if (existing === undefined) return true
  // A record that can actually be installed beats one that cannot, whatever the
  // popularity numbers say: the market's job is to install plugins.
  if (candidate.hasTarget !== existing.hasTarget) return candidate.hasTarget
  if (candidate.stars !== existing.stars) return candidate.stars > existing.stars
  if (candidate.downloads !== existing.downloads) return candidate.downloads > existing.downloads
  if ((candidate.npm !== null) !== (existing.npm !== null)) return candidate.npm !== null
  if (candidate.install.length !== existing.install.length) return candidate.install.length > existing.install.length
  return candidate.name.length > existing.name.length
}

/**
 * Normalization and ranking.
 *
 * Every source invents its own field names; the market needs one record shape
 * and one identity, because identity is what makes deduplication possible.
 */
import { DENY_REPOS, DENY_TYPES } from './sources.mjs'

/** npm package names the harness accepts as an install target. */
const NPM_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/

/** Composite ranking weight: stars dominate, downloads break ties and lift. */
export const STARS_WEIGHT = 1000

/** Localized description, from whatever shape the source used. */
function description(value) {
  if (value === null || value === undefined) return { en: '', zh: '' }
  if (typeof value === 'string') return { en: value, zh: '' }
  return {
    en: value.en ?? value.English ?? '',
    zh: value['zh-Hans'] ?? value.zh ?? value.zh_CN ?? '',
  }
}

/** GitHub `owner/repo` out of any of the URL shapes a source might use. */
export function ghRepo(url) {
  const match = /github\.com\/([^/]+\/[^/]+?)(?:\.git)?(?:\/|$)/.exec(String(url ?? ''))
  return match ? match[1] : ''
}

/**
 * Classify an install target the way the harness does, so the market can show
 * what an install will actually pull and which repositories it must trust.
 *
 * @param entry - `install` command, `npm` name, `tarball` URL, `url` of the page.
 */
export function classifyTarget({ install = '', npm = null, tarball = null, url = '' }) {
  const command = String(install ?? '')
  const spec = /add\s+(\S+)\s*$/.exec(command)?.[1] ?? ''
  if (tarball && /^https:\/\/github\.com\//.test(tarball)) {
    return { kind: 'tarball', target: tarball, command: `dsh plugin add ${tarball}` }
  }
  if (spec.startsWith('github:') || spec.startsWith('git+') || /^https?:\/\/github\.com\//.test(spec)) {
    return { kind: 'github', target: spec, command: command || `dsh plugin add ${spec}` }
  }
  if (spec !== '' && !spec.startsWith('-')) {
    return { kind: NPM_NAME.test(spec) ? 'npm' : 'other', target: spec, command }
  }
  if (npm && NPM_NAME.test(npm)) {
    return { kind: 'npm', target: npm, command: `dsh plugin --profile web add ${npm}` }
  }
  const repo = ghRepo(url)
  if (repo) return { kind: 'github', target: `github:${repo}`, command: `dsh plugin add github:${repo}` }
  return { kind: 'unknown', target: '', command }
}

/**
 * Turn one raw source entry into a canonical plugin record, or null when the
 * entry is not a plugin at all.
 *
 * @param raw - the source's own entry object.
 * @param sourceId - which source it came from (provenance).
 * @param requireType - when set, the source's `type` must equal it.
 */
export function normalize(raw, sourceId, requireType) {
  if (raw === null || typeof raw !== 'object') return null
  const type = String(raw.type ?? raw.kind ?? '').trim()
  if (requireType !== undefined && type !== requireType) return null
  if (DENY_TYPES.has(type)) return null

  const repo = raw.full_name ?? raw.repo ?? ghRepo(raw.url ?? raw.page ?? raw.homepage)
  if (DENY_REPOS.has(repo)) return null

  const name = String(raw.name ?? (repo ? String(repo).split('/').pop() : '')).trim()
  const npm = raw.npm ?? raw.pkg ?? null
  if (name === '' && !npm) return null

  const url = raw.url ?? raw.page ?? raw.homepage ?? (repo ? `https://github.com/${repo}` : '')
  const target = classifyTarget({ install: raw.install ?? raw.cmd, npm, tarball: raw.tarball ?? null, url })
  if (target.kind === 'unknown') return null
  const stars = Number(raw.stars ?? raw.starsCount ?? 0) || 0
  const downloads = Number(raw.downloads ?? raw.downloads30d ?? raw.download ?? 0) || 0
  const category = Array.isArray(raw.category) ? raw.category[0] ?? '' : String(raw.category ?? raw.cat ?? '')

  return {
    name,
    owner: String(raw.owner ?? (repo ? String(repo).split('/')[0] : '')).trim(),
    url,
    repo,
    category,
    description: description(raw.description ?? raw.desc ?? raw.note),
    npm: npm ?? null,
    tarball: raw.tarball ?? null,
    install: target.command,
    target: target.target,
    targetKind: target.kind,
    stars,
    downloads,
    score: Math.round(stars * STARS_WEIGHT + downloads),
    version: raw.version ?? '',
    added: String(raw.added ?? raw.pushed_at ?? '').slice(0, 10),
    sourceId,
  }
}

/**
 * The identity key that decides two entries are the same plugin.
 *
 * Ordered by certainty: an npm name is a globally unique package identity, a
 * repository path is unique on GitHub, and a bare name is a last resort. Using
 * one key for the whole merge is what makes "keep the newest" well defined.
 */
export function identityOf(plugin) {
  if (plugin.npm && NPM_NAME.test(plugin.npm)) return `npm:${plugin.npm.toLowerCase()}`
  if (plugin.repo) return `repo:${plugin.repo.toLowerCase()}`
  return `name:${String(plugin.name).toLowerCase()}`
}

/**
 * Merge one entry into the accumulator, keeping the newest/hottest duplicate.
 *
 * "Newest" is deliberately ordered rather than a timestamp: a source that
 * stopped updating has an old `version`, and stars/downloads are what the
 * ranking is built on, so the surviving record is the one that wins the
 * ranking. Provenance is unioned instead of replaced — a plugin listed by
 * three sources keeps all three.
 *
 * @param seen - the `Map<identity, record>` accumulator.
 * @param plugin - the normalized candidate.
 * @returns whether the candidate replaced an existing record.
 */
export function mergeInto(seen, plugin) {
  const key = identityOf(plugin)
  const existing = seen.get(key)
  if (existing === undefined) {
    seen.set(key, { ...plugin, sources: [plugin.sourceId] })
    return true
  }
  const better =
    plugin.stars > existing.stars ||
    (plugin.stars === existing.stars && plugin.downloads > existing.downloads) ||
    (plugin.stars === existing.stars && plugin.downloads === existing.downloads && plugin.install.length > existing.install.length)
  if (!better) {
    if (!existing.sources.includes(plugin.sourceId)) existing.sources.push(plugin.sourceId)
    // Fill gaps: a duplicate often carries a field the winner lacks.
    existing.description.en ||= plugin.description.en
    existing.description.zh ||= plugin.description.zh
    existing.category ||= plugin.category
    existing.version ||= plugin.version
    existing.npm ??= plugin.npm
    return false
  }
  const sources = existing.sources.includes(plugin.sourceId) ? existing.sources : [...existing.sources, plugin.sourceId]
  seen.set(key, { ...plugin, sources })
  return true
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

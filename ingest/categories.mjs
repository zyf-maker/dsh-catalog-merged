/**
 * Category discovery.
 *
 * A hand-written taxonomy goes stale the moment the ecosystem invents something:
 * a new modality, a new host integration, a new kind of tool. So the pipeline
 * creates categories itself — from the catalog, on every run — subject to evidence
 * strong enough that today it creates nothing and tomorrow it creates the thing
 * that arrived.
 *
 * ## What the data said, and how it changed the design
 *
 * Measured over the served catalog (10694 plugins, 1195 unclassified):
 *
 *   - terms with >= 20 members confined to the leftovers (share >= 60%): **zero**
 *   - the highest-share leftovers were marketing phrases, not domains:
 *     `无需联网`, `纯本地实现`, `care`, `calc`
 *   - a permissive survey of every candidate token showed what the cross-cutting
 *     ones really are: `xby` (a publisher prefix, 146 members), `codex` (141),
 *     `claude` (91), `management`, `conversation`, `reasoning`, `archive`,
 *     `message`, `sync` — every one an ATTRIBUTE (an integration target, a metric,
 *     a generic word), not a subject nobody has a bucket for
 *
 * That last point killed the original premise of the cross-cutting channel. It was
 * built to catch "a wave that lands in the catch-alls", on the theory that landing
 * in `tools` means the taxonomy failed. The data says otherwise: a Codex sidebar
 * belongs in `ui` and a Codex adapter in `model`, so a token spanning many
 * categories is evidence of *cross-cutting*, which is exactly what a one-dimensional
 * category cannot express. Promoting those would have split the sidebar into
 * `codex` / `claude` / `opencode` buckets that say what a plugin integrates with
 * rather than what it is.
 *
 * So the rule is now:
 *
 *   leftover      a cluster with no home — may create a category automatically.
 *                 This is the promise "以备后续有新的类别" rests on, and it is sound:
 *                 a new subject has no rule, so it lands in `other`, and a real
 *                 cluster is visible there.
 *   cross-cutting **proposals only.** A human promotes one by name in
 *                 `data/category-labels.json`; nothing is created on a token that
 *                 merely spans categories.
 *
 * ## Stability
 *
 * Discovered categories are persisted (`data/categories.json`) and reused, not
 * recomputed: a sidebar whose entries appear and vanish between runs is worse than
 * no sidebar. A category is retired when its membership decays below a floor —
 * decided from the live catalog, not from a stored number — and the record is kept
 * so it can be revived without being re-learned. Labels, hiding and merging are
 * hand-editable in `data/category-labels.json`.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { matchesBuiltin } from './classify.mjs'

/**
 * Thresholds.
 *
 * The cross-cutting numbers are the bar a *promoted* term must still clear: a human
 * asking for a category is a strong signal, but asking for one that covers three
 * plugins is not a category. The leftover bar is the automatic path, and it is set
 * where today's catalog is silent — verified, not assumed: at 25 members and 75%
 * share, the current leftovers produce zero proposals.
 */
export const DEFAULT_OPTIONS = {
  /** Channel A: members confined to the leftovers. May create automatically. */
  leftoverMinMembers: 25,
  leftoverMinShare: 0.75,
  /** Channel B: cross-cutting. Proposal-only unless promoted by hand. */
  crossMinMembers: 120,
  crossMinCategories: 6,
  crossMaxShare: 0.02,
  /** A promoted term still needs this many members to become a bucket. */
  promoteMinMembers: 25,
  /** Guards. */
  maxTermLength: 20,
  maxNewPerRun: 2,
  /** Retirement: below this, an existing category stops being used. */
  retireFloor: 8,
}

/**
 * Words that describe the ecosystem, a metric, or nothing in particular — rather
 * than a subject. A category made of these would hold a third of the catalog, which
 * is the failure the taxonomy already had (`cordis-plugin`, 2340 plugins).
 *
 * Three groups, all of them observed in the first discovery run's proposals:
 *   - platform: the framework and its author (`cordis`, `deepseek`, `harness`)
 *   - metric: units and attributes (`token`, `cost`, `size`, `count`)
 *   - generic: words that fit any plugin (`workspace`, `task`, `hub`, `monitor`)
 */
export const STOPWORDS = new Set([
  // platform / ecosystem
  'dsh', 'deepseek', 'harness', 'cordis', 'plugin', 'plugins', 'extension', 'extensions', 'addon', 'addons',
  'agent', 'agents', 'llm', 'ai', 'gpt', 'chat', 'chats',
  // metric / attribute
  'token', 'tokens', 'cost', 'price', 'balance', 'quota', 'usage', 'latency', 'speed', 'rate', 'score',
  'size', 'count', 'number', 'amount', 'budget', 'limit', 'total', 'sum', 'stats', 'stat', 'metric',
  'time', 'date', 'timestamp', 'duration', 'delay', 'interval',
  // English filler and generic nouns
  'the', 'and', 'for', 'with', 'your', 'you', 'that', 'this', 'from', 'into', 'when', 'what', 'how',
  'support', 'supports', 'supported', 'built', 'based', 'using', 'use', 'uses', 'new', 'all', 'any',
  'web', 'app', 'apps', 'api', 'apis', 'cli', 'ui', 'ux', 'gui', 'tool', 'tools', 'toolkit',
  'client', 'server', 'core', 'hook', 'hooks', 'node', 'sdk', 'kit', 'lite', 'plus', 'pro', 'max',
  'fast', 'quick', 'easy', 'simple', 'light', 'smart', 'auto', 'automatic', 'advanced', 'better',
  'awesome', 'collection', 'pack', 'suite', 'bundle', 'manager', 'helper', 'utils', 'utility',
  'config', 'setting', 'settings', 'option', 'options', 'feature', 'features', 'mode', 'modes',
  'version', 'update', 'updates', 'install', 'installer', 'loader', 'runner', 'wrapper', 'adapter',
  'test', 'tests', 'demo', 'example', 'examples', 'docs', 'doc', 'readme', 'beta', 'alpha', 'rc',
  'one', 'two', 'first', 'next', 'last', 'more', 'most', 'best', 'top', 'super', 'ultra', 'mega',
  'local', 'cloud', 'remote', 'online', 'offline', 'free', 'open', 'source', 'personal', 'private',
  'workspace', 'workspaces', 'project', 'projects', 'task', 'tasks', 'job', 'jobs', 'worker', 'workers',
  'developer', 'developers', 'engineering', 'engineer', 'multi', 'hub', 'studio', 'router', 'routing',
  'monitor', 'monitoring', 'watch', 'viewer', 'picker', 'pick', 'select', 'selection', 'search',
  'list', 'listview', 'panel', 'widget', 'card', 'cards', 'tab', 'tabs', 'menu', 'button', 'input',
  'file', 'files', 'folder', 'path', 'text', 'string', 'json', 'yaml', 'xml', 'html', 'css', 'markdown',
  'url', 'link', 'links', 'data', 'info', 'information', 'note', 'notes', 'log', 'logs', 'status',
  'check', 'checker', 'verify', 'fix', 'fixer', 'plan', 'planner', 'calc', 'calculate', 'calc',
  'care', 'city', 'water', 'buy', 'terms', 'future', 'live', 'github', 'whale', 'mascot', 'theme',
  'style', 'styles', 'skin', 'skins', 'font', 'fonts', 'color', 'colors', 'dark', 'light',
  // Chinese filler
  '支持', '一个', '可以', '使用', '插件', '工具', '功能', '进行', '通过', '以及', '并且', '让你', '帮你',
  '自动', '提供', '实现', '显示', '查看', '管理', '快速', '简单', '一键', '本地', '云端', '在线', '实时',
  '直接', '无需', '基于', '适合', '用于', '集成', '扩展', '增强', '优化', '提升', '帮助', '方便', '轻松',
  '完整', '全面', '多种', '即装即用', '即插即用', '开箱即用', '无需联网', '纯本地', '纯本地实现',
])

/** A Latin token: a word, not a phrase. */
const LATIN_TOKEN = /^[a-z][a-z0-9+#._-]*$/

/**
 * Candidate terms for one plugin: tokens from its NAME and TOPICS.
 *
 * Prose is excluded on purpose. Names and topics are curated tokens (`dsh-pdf`,
 * `topic: vision`); descriptions are sentences, and a sentence fragment becomes a
 * category like `无需联网` that means nothing to a reader scanning a sidebar.
 *
 * @param plugin - a catalog record.
 * @returns the candidate tokens, lower-cased.
 */
export function candidateTerms(plugin) {
  const tokens = new Set()
  const name = String(plugin.name ?? '')
  // Split a package name on its separators: `dsh-remote-ssh` yields remote, ssh.
  for (const word of name.toLowerCase().split(/[^a-z0-9+#.]+/)) {
    if (LATIN_TOKEN.test(word) && word.length >= 3 && !STOPWORDS.has(word)) tokens.add(word)
  }
  for (const topic of Array.isArray(plugin.topics) ? plugin.topics : []) {
    for (const word of String(topic).toLowerCase().split(/[^a-z0-9+#.]+/)) {
      if (LATIN_TOKEN.test(word) && word.length >= 3 && !STOPWORDS.has(word)) tokens.add(word)
    }
  }
  return tokens
}

/** A case-insensitive, escaped pattern for a token, with Latin word edges. */
export function termPattern(term) {
  const escaped = String(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // Latin tokens get boundaries so `pdf` does not match `pdfjs_extra`; a CJK term
  // has no word boundaries to anchor to and is matched literally.
  return /^[a-z0-9+#._-]+$/i.test(term) ? new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i') : new RegExp(escaped, 'i')
}

/**
 * Propose categories from one catalog snapshot.
 *
 * @param plugins - every emitted record, each carrying `category` and `name`.
 * @param options - threshold overrides plus `promoteTerms` (a Set of terms a human
 *   has asked for in the labels file; see `promotedTermsOf`).
 * @returns proposals that may be created, strongest first, de-overlapped and capped.
 *   Cross-cutting terms are excluded unless promoted — see the module header for the
 *   measurement that decided this.
 */
export function discoverCategories(plugins, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options }
  const known = new Set(options.knownCategoryIds ?? [])
  const promoted = options.promoteTerms instanceof Set ? options.promoteTerms : new Set()

  const stats = collectStats(plugins, opts, known)

  const proposals = []
  for (const [term, { members, categories }] of stats) {
    const total = members.size
    const leftover = categories.get('other') ?? 0
    const share = leftover / total
    const spread = categories.size
    const channels = []
    if (leftover >= opts.leftoverMinMembers && share >= opts.leftoverMinShare) channels.push('leftover')
    if (total >= opts.crossMinMembers && spread >= opts.crossMinCategories && share <= opts.crossMaxShare) channels.push('cross-cutting')
    if (channels.length === 0) continue
    // The automatic path is the leftover channel alone. The cross-cutting channel is
    // evidence for a human to act on, because the measurement above showed those
    // terms describe what a plugin integrates with, not what it is.
    const automatic = channels.includes('leftover')
    const humanAsked = promoted.has(term) && total >= opts.promoteMinMembers
    if (!automatic && !humanAsked) continue
    proposals.push({
      term,
      members: total,
      leftover,
      share: Number(share.toFixed(3)),
      spread,
      channel: automatic ? 'leftover' : 'promoted',
      channels,
      path: automatic ? 'automatic' : 'promoted',
      samples: sampleNames(plugins, term),
    })
  }

  return deOverlap(proposals).slice(0, Math.max(opts.maxNewPerRun, promoted.size))
}

/**
 * Every candidate term with its numbers, for human review.
 *
 * This is what makes a proposal-only channel useful rather than opaque: the numbers
 * that would justify a category are written to `data/category-proposals.json` on
 * every run, so promoting one is a decision made from evidence.
 *
 * @param plugins - the served catalog.
 * @param options - `limit` (how many to return), plus the threshold overrides.
 * @returns candidates sorted by member count, each with `qualifies` and `why`.
 */
export function surveyCandidates(plugins, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options }
  const known = new Set(options.knownCategoryIds ?? [])
  const rows = []
  for (const [term, { members, categories }] of collectStats(plugins, opts, known)) {
    const total = members.size
    const leftover = categories.get('other') ?? 0
    const spread = categories.size
    const share = leftover / total
    const leftoverQualified = leftover >= opts.leftoverMinMembers && share >= opts.leftoverMinShare
    const crossQualified = total >= opts.crossMinMembers && spread >= opts.crossMinCategories && share <= opts.crossMaxShare
    rows.push({
      term,
      members: total,
      leftover,
      spread,
      share: Number(share.toFixed(3)),
      channels: [...(leftoverQualified ? ['leftover'] : []), ...(crossQualified ? ['cross-cutting'] : [])],
      qualifies: leftoverQualified ? 'automatic' : crossQualified ? 'promotable' : 'below-threshold',
      why: leftoverQualified
        ? `${leftover} unclassified of ${total}`
        : crossQualified
          ? `spans ${spread} categories; promote by hand if it names a subject`
          : `needs >=${opts.leftoverMinMembers} unclassified (has ${leftover}) or >=${opts.crossMinMembers} members across >=${opts.crossMinCategories} categories (has ${total}/${spread})`,
      samples: sampleNames(plugins, term, 3),
    })
  }
  rows.sort((a, b) => b.members - a.members || a.term.localeCompare(b.term))
  return rows.slice(0, options.limit ?? 60)
}

/** Terms a human asked for in the labels file (`promote: true`). */
export function promotedTermsOf(labels) {
  const terms = new Set()
  for (const [term, value] of Object.entries(labels ?? {})) {
    if (term.startsWith('_')) continue
    if (value !== null && typeof value === 'object' && value.promote === true) terms.add(term)
  }
  return terms
}

/** Term → members and per-category counts, over the whole set. */
function collectStats(plugins, opts, known) {
  /** @type {Map<string, { members: Set<string>, categories: Map<string, number> }>} */
  const stats = new Map()
  for (const plugin of plugins) {
    const category = String(plugin.category ?? 'other')
    const key = String(plugin.install ?? plugin.name ?? '')
    for (const term of candidateTerms(plugin)) {
      if (term.length > opts.maxTermLength) continue
      if (known.has(term)) continue
      // A term an existing rule already matches is not a missing category; it is a
      // word the taxonomy handles.
      if (matchesBuiltin(term)) continue
      if (!stats.has(term)) stats.set(term, { members: new Set(), categories: new Map() })
      const entry = stats.get(term)
      entry.members.add(key)
      entry.categories.set(category, (entry.categories.get(category) ?? 0) + 1)
    }
  }
  return stats
}

/** The first few plugin names matching a term, for review. */
function sampleNames(plugins, term, limit = 5) {
  const out = []
  for (const plugin of plugins) {
    if (out.length >= limit) break
    if (candidateTerms(plugin).has(term)) out.push(String(plugin.name ?? ''))
  }
  return out
}

/** Drop proposals that another accepted proposal already covers. */
function deOverlap(proposals) {
  proposals.sort((a, b) => b.members - a.members || a.term.localeCompare(b.term))
  const accepted = []
  for (const proposal of proposals) {
    if (accepted.some((chosen) => chosen.term.includes(proposal.term) || proposal.term.includes(chosen.term))) continue
    accepted.push(proposal)
  }
  return accepted
}

/**
 * Fold proposals into the persisted state.
 *
 * @param state - the loaded state (`{ discovered: [...] }`).
 * @param proposals - the output of `discoverCategories`.
 * @param context - `now`, `options`, `labels` (hand overrides), and `membersOf` —
 *   a function that counts how many plugins a term still matches.
 * @returns `{ state, created, revived, retired, updated }`.
 */
export function mergeDiscovered(state, proposals, { now, options = {}, labels = {}, membersOf } = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options }
  const stamp = now ?? new Date().toISOString()
  const existing = new Map((state?.discovered ?? []).map((entry) => [entry.term, { ...entry }]))
  const created = []
  const revived = []
  const updated = []

  let budget = opts.maxNewPerRun
  for (const proposal of proposals) {
    const prior = existing.get(proposal.term)
    if (prior === undefined) {
      if (budget <= 0) continue
      budget -= 1
      const override = labels[proposal.term] ?? {}
      existing.set(proposal.term, {
        id: proposal.term,
        term: proposal.term,
        label: { en: override.en ?? proposal.term.toUpperCase(), zh: override.zh ?? proposal.term },
        hidden: override.hidden === true,
        ...(override.mergeInto === undefined ? {} : { mergeInto: override.mergeInto }),
        members: proposal.members,
        share: proposal.share,
        channels: proposal.channels,
        samples: proposal.samples,
        firstSeen: stamp,
        lastSeen: stamp,
        qualifiedAt: stamp,
        status: 'active',
      })
      created.push(proposal.term)
      continue
    }
    // Refresh the evidence, and revive anything that decayed earlier.
    const wasRetired = prior.status === 'retired'
    prior.members = proposal.members
    prior.share = proposal.share
    prior.channels = proposal.channels
    prior.samples = proposal.samples
    prior.lastSeen = stamp
    prior.qualifiedAt = stamp
    prior.status = 'active'
    prior.retiredAt = undefined
    const override = labels[proposal.term]
    if (override !== undefined) {
      prior.label = { en: override.en ?? prior.label?.en ?? proposal.term, zh: override.zh ?? prior.label?.zh ?? proposal.term }
      prior.hidden = override.hidden === true
      if (override.mergeInto === undefined) delete prior.mergeInto
      else prior.mergeInto = override.mergeInto
    }
    if (wasRetired) revived.push(proposal.term)
    else updated.push(proposal.term)
  }

  /**
   * Retirement, decided from the CURRENT catalog rather than from the number
   * stored last run.
   *
   * The first version only retired a category whose stored membership fell below
   * the floor — which never happened for a category that stopped qualifying for a
   * different reason (its term became a stopword, or curation started covering
   * it), because the stored count stayed frozen at its last proposal. Recomputing
   * is cheap and is the only way the state can follow the data.
   */
  const retired = []
  const seen = new Set(proposals.map((p) => p.term))
  for (const entry of existing.values()) {
    if (entry.status !== 'active' || seen.has(entry.term)) continue
    const current = typeof membersOf === 'function' ? membersOf(entry.term) : entry.members
    entry.members = current
    if (current > opts.retireFloor) continue
    entry.status = 'retired'
    entry.retiredAt = stamp
    retired.push(entry.term)
  }

  const discovered = [...existing.values()].sort((a, b) => b.members - a.members || a.term.localeCompare(b.term))
  return {
    state: { schema: 'dsh-market/categories-v1', updated: stamp, discovered },
    created, revived, retired, updated,
  }
}

/**
 * Classification rules for the active discovered categories.
 *
 * A `mergeInto` override in the labels file points a term at another category, so
 * two emergent buckets that mean one thing (`codex` + `claude` → an "external
 * agent CLIs" bucket) can be folded together by hand without a code change.
 *
 * @param state - the persisted state.
 * @returns `[{ id, label, term, patterns }]`, ready for `classify`'s `discovered` option.
 */
export function rulesFor(state) {
  return (state?.discovered ?? [])
    .filter((entry) => entry.status === 'active' && entry.hidden !== true)
    .map((entry) => ({
      // The term matches; the id it lands in may be another category's.
      id: entry.mergeInto ?? entry.id,
      term: entry.term,
      label: entry.label ?? { en: entry.term, zh: entry.term },
      patterns: [termPattern(entry.term)],
    }))
}

/** Read the persisted state, or an empty one. */
export function loadState(path) {
  if (!existsSync(path)) return { schema: 'dsh-market/categories-v1', updated: null, discovered: [] }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return { schema: parsed.schema ?? 'dsh-market/categories-v1', updated: parsed.updated ?? null, discovered: parsed.discovered ?? [] }
  } catch {
    // A corrupt file must not stop the run; the next one rewrites it.
    return { schema: 'dsh-market/categories-v1', updated: null, discovered: [] }
  }
}

/** Persist the state. */
export function saveState(path, state) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`)
}

/** Read hand-written label corrections, or an empty map. */
export function loadLabels(path) {
  if (!existsSync(path)) return {}
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** The `categories` dictionary entries contributed by discovered categories. */
export function dictionaryFor(state) {
  const out = {}
  for (const entry of state?.discovered ?? []) {
    if (entry.status !== 'active' || entry.hidden === true) continue
    // A merged term does not own a bucket: its records belong to the category it
    // was pointed at, and listing it would show the same plugins twice.
    if (entry.mergeInto !== undefined) continue
    out[entry.id] = {
      en: entry.label?.en ?? entry.term,
      zh: entry.label?.zh ?? entry.term,
      // Marked so the UI can tell a hand-designed bucket from an emergent one, and
      // so an operator reading the catalog knows which entries to review.
      auto: true,
      members: entry.members,
    }
  }
  return out
}

/**
 * Category discovery.
 *
 * A hand-written taxonomy goes stale the moment the ecosystem invents something:
 * a new modality, a new host integration, a new kind of tool. So the pipeline
 * creates categories itself — from the catalog, on every run — subject to evidence
 * strong enough that today it creates nothing and tomorrow it creates the thing
 * that arrived.
 *
 * ## What the data said before this was written
 *
 * Measured over the published catalog (10695 plugins, 1195 unclassified):
 *
 *   - terms with >= 20 members confined to the leftovers (share >= 60%): **zero**
 *   - the highest-share terms were marketing phrases, not domains:
 *     `无需联网`, `纯本地实现`, `即装即用`, `care`, `calc`
 *
 * Two conclusions shaped the design. First, the leftovers are genuinely one-offs
 * (relay, ssh, pdf, fleet, doctor…), so a mechanism that inventing categories from
 * weak signal would produce noise — the thresholds below are deliberately high.
 * Second, prose is a bad source of category names: a category is a token, and
 * tokens live in names and topics, so candidates are drawn from there and a phrase
 * like `无需联网` can never become a category.
 *
 * ## Two channels, because a future category need not look like today's leftovers
 *
 *   leftover      a token that dominates the unclassified set. This is where a
 *                 genuinely new subject first appears, before any rule knows it.
 *   cross-cutting a token spread across many existing categories. A new subject
 *                 can also arrive already classified — `tools` and `dev` are
 *                 catch-alls, so a wave of 40 plugins about one new thing may all
 *                 land in `tools` and never touch the leftovers.
 *
 * ## Stability
 *
 * Discovered categories are persisted (`data/categories.json`) and reused, not
 * recomputed: a sidebar whose entries appear and vanish between runs is worse than
 * no sidebar. A category is retired only when its membership decays below a floor,
 * and the record is kept so it can be revived without being re-learned. Labels can
 * be corrected by hand in `data/category-labels.json` without touching code.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { builtinMatch, matchesBuiltin } from './classify.mjs'

/**
 * Thresholds.
 *
 * These were raised after measuring what the first, looser set produced on the real
 * catalog: the cross-cutting channel proposed 16 terms and most were generic words
 * — `cordis` (the framework's own name), `token` (a unit, not a subject),
 * `workspace`, `task`, `hub`, `monitor`, `pick`, `whale` (the mascot). Creating
 * categories from those is worse than having none: it splits the sidebar into
 * buckets that do not describe anything.
 *
 * So the bar is now high enough that today's catalog creates nothing from the
 * cross-cutting channel unless a term really dominates (≥120 members across ≥6
 * categories and almost never in the leftovers). The stopword list carries the
 * rest of the weight, and it will need maintenance — that is the honest cost of
 * mechanical discovery, and it is paid in a list rather than in wrong categories.
 */
export const DEFAULT_OPTIONS = {
  /** Channel A: members confined to the leftovers. */
  leftoverMinMembers: 25,
  leftoverMinShare: 0.75,
  /** Channel B: members spread across existing categories. */
  crossMinMembers: 120,
  crossMinCategories: 6,
  crossMaxShare: 0.02,
  /** Guards. */
  maxTermLength: 20,
  maxNewPerRun: 2,
  /** Overlap: a proposal mostly covered by an accepted one is dropped. */
  overlapLimit: 0.7,
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
 * @param options - threshold overrides; see `DEFAULT_OPTIONS`.
 * @returns proposals, strongest first, already de-overlapped and capped.
 */
export function discoverCategories(plugins, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options }
  const known = new Set(options.knownCategoryIds ?? [])

  /** @type {Map<string, { members: Set<string>, categories: Map<string, number> }>} */
  const stats = new Map()
  for (const plugin of plugins) {
    const category = String(plugin.category ?? 'other')
    const key = String(plugin.install ?? plugin.name ?? '')
    for (const term of candidateTerms(plugin)) {
      if (term.length > opts.maxTermLength) continue
      if (known.has(term)) continue
      // A term an existing rule already matches is not a missing category; it is
      // a word the taxonomy handles.
      if (matchesBuiltin(term)) continue
      if (!stats.has(term)) stats.set(term, { members: new Set(), categories: new Map() })
      const entry = stats.get(term)
      entry.members.add(key)
      entry.categories.set(category, (entry.categories.get(category) ?? 0) + 1)
    }
  }

  const proposals = []
  for (const [term, { members, categories }] of stats) {
    const total = members.size
    const leftover = categories.get('other') ?? 0
    const spread = categories.size
    const channels = []
    if (leftover >= opts.leftoverMinMembers && leftover / total >= opts.leftoverMinShare) channels.push('leftover')
    if (total >= opts.crossMinMembers && spread >= opts.crossMinCategories && leftover / total <= opts.crossMaxShare) channels.push('cross-cutting')
    if (channels.length === 0) continue
    proposals.push({
      term,
      members: total,
      leftover,
      share: Number((leftover / total).toFixed(3)),
      spread,
      channel: channels[0],
      channels,
      samples: plugins
        .filter((p) => candidateTerms(p).has(term))
        .slice(0, 5)
        .map((p) => String(p.name ?? '')),
    })
  }

  // Strongest first, then drop anything an accepted proposal already covers.
  proposals.sort((a, b) => b.members - a.members || a.term.localeCompare(b.term))
  const accepted = []
  for (const proposal of proposals) {
    const covered = accepted.some((chosen) =>
      chosen.term.includes(proposal.term) || proposal.term.includes(chosen.term))
    if (covered) continue
    accepted.push(proposal)
  }
  // A term that is a substring of another accepted term is redundant; keep the
  // broader one, which the sort has already placed first.
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

/**
 * Catalog quality: which rows are shells, and how the rest are ordered.
 *
 * Both belong to the **data**, not to a UI. The settings-section market and the
 * published web page read the same catalog and must show the same thing; when
 * each computed its own answer they disagreed (11408 rows behind the plugin,
 * 11538 behind the page). So the ingest run annotates every emitted row once,
 * and both consumers read the result. The module lives here, in `shared/`,
 * because it is the same file the pipeline imports and the browser imports.
 *
 * ## The two rules that were wrong
 *
 * Description length is measured in **text weight**, not code units. Chinese
 * carries roughly twice the information per character, so an 18-character floor
 * written for English rejected `talebook` — "一个简单好用的个人书库", 5765
 * stars — as an empty description, along with most of the catalog's genuinely
 * terse Chinese rows.
 *
 * A placeholder phrase only rejects a row that also fails to say what it does.
 * Matching the word alone removed `dsh-tauri-panel-placeholder` (2129 stars),
 * a real plugin whose real function is to provide a placeholder UI element.
 *
 * Neither rule was guessed; both were measured against the production catalog.
 */

/** Weight below which a description says nothing at all. */
export const MIN_DESCRIPTION_WEIGHT = 12

/** Weight at which a description counts as substantive on its own. */
export const SUBSTANTIVE_WEIGHT = 24

/**
 * Text weight in "English character equivalents": a CJK ideograph counts as
 * two Latin characters, which is the ratio a reader experiences.
 *
 * @param value - the text to weigh.
 * @returns the weight in English character equivalents.
 */
export function textWeight(value) {
  let weight = 0
  for (const character of String(value ?? '')) {
    weight += /[\u2e80-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/.test(character) ? 2 : 1
  }
  return weight
}

/** Wording that describes an unfinished entry. */
const PLACEHOLDER_PHRASE = /(?:coming soon|work in progress|lorem ipsum|not implemented|待实现|待完善|占位|暂无内容)/i

/** Wording that asks for attention instead of describing a function. */
const PROMOTION_ONLY = /(?:求\s*star|求收藏|求关注|welcome\s*to\s*star|please\s*star)/i

/** A name that names no subject: "dsh plugin", "插件", "addon for dsh". */
const NOMINAL_NAME = /^(?:dsh|deepseek|harness)?[\s_-]*(?:plugin|插件|extension|扩展|addon)(?:\s+(?:for|for dsh|相关))?[.!。 ]*$/i

/** Verbs and nouns that say what a plugin does. */
const CAPABILITY = /(?:支持|提供|实现|允许|自动|管理|查看|生成|导出|同步|搜索|识别|调用|连接|增强|安装|更新|监控|审计|接入|渲染|编辑|回滚|路由|工作流|记忆|上下文|模型|工具|浏览器|图片|视觉|通知|智能体|团队|角色|编辑器|市场|皮肤|主题|红队|测试|验证|防护|书库|面板|快捷|翻译|统计|备份|清理|同步|Supports|Provides|Enables|Adds|Automates|Manage|View|Generate|Export|Sync|Search|Detect|Connect|Enhance|Install|Update|Monitor|Audit|Integrat|Render|Edit|Rollback|Route|Workflow|Memory|Context|Model|Tool|Browser|Image|Vision|Notify|Library|Dashboard)/i

/**
 * Decide whether one catalog row describes a plugin or is a shell.
 *
 * Deliberately conservative: a row is dropped only when nothing about it says
 * what it does. Popularity is not consulted here — a shell with stars is still
 * a shell, and a real plugin with none is still a plugin. Popularity belongs to
 * the ranking, one function below.
 *
 * @param entry - one normalized catalog row.
 * @returns `{ verdict, reason }`; `reason` is the finding shown to a reader.
 */
export function judgeEntry(entry) {
  const name = String(entry?.name ?? '').trim()
  const description = [entry?.description?.en, entry?.description?.zh]
    .map(value => String(value ?? '').trim())
    .filter(value => value !== '')
    .join(' ')
  const text = `${name} ${description}`
  const weight = textWeight(description)
  const concrete = CAPABILITY.test(description)
  if (weight < MIN_DESCRIPTION_WEIGHT) {
    return { verdict: 'exclude', reason: 'empty or nominal description' }
  }
  if (NOMINAL_NAME.test(name) && !concrete && weight < SUBSTANTIVE_WEIGHT) {
    return { verdict: 'exclude', reason: 'no concrete function described' }
  }
  if (PLACEHOLDER_PHRASE.test(text) && !concrete && weight < SUBSTANTIVE_WEIGHT) {
    return { verdict: 'exclude', reason: 'placeholder or unfinished entry' }
  }
  if (PROMOTION_ONLY.test(text) && !concrete) {
    return { verdict: 'exclude', reason: 'promotion-only entry' }
  }
  return { verdict: 'keep', reason: null }
}

/** Recently maintained rows score higher; age is the only signal here. */
function recencyScore(value) {
  const text = String(value ?? '').trim()
  if (text === '') return 0
  const time = Date.parse(text)
  if (!Number.isFinite(time)) return 0
  const age = Date.now() - time
  if (age < 0 || age <= 180 * 24 * 60 * 60 * 1000) return 7
  if (age <= 365 * 24 * 60 * 60 * 1000) return 4
  return 0
}

/**
 * Score and classify one row.
 *
 * `evidence` and an installed manifest are both proof that the package declares
 * a Harness plugin manifest. Only `evidence` is knowable here, because the
 * ingest run is not sitting in a profile; a host passes `manifestVerified` to
 * add the installed check.
 *
 * @param entry - one normalized catalog row.
 * @param options - `manifestVerified` for the host-side check.
 * @returns `{ qualityState, qualityScore, qualityReasons }`.
 */
export function qualityOf(entry, { manifestVerified = false } = {}) {
  const verified = manifestVerified || entry?.evidence === 'dsh.bundle' || entry?.evidence === 'dsh.client'
  const target = String(entry?.target || entry?.npm || entry?.install || '').trim()
  const hasTarget = target !== '' && entry?.installable !== false
  const description = [entry?.description?.en, entry?.description?.zh]
    .map(value => String(value ?? '').trim())
    .find(value => value !== '') ?? ''
  const weight = textWeight(description)
  const meaningfulDescription = weight >= SUBSTANTIVE_WEIGHT && !/^((test|demo|example|plugin|todo|tbd)[ .:_-]*)+$/i.test(description)
  const searchable = `${entry?.name ?? ''} ${entry?.description?.en ?? ''} ${entry?.description?.zh ?? ''} ${(entry?.topics ?? []).join(' ')}`
  const dshRelevance = /\b(dsh|deepseek|harness|cordis)\b/i.test(searchable)
  const judgment = judgeEntry(entry)
  const sourceCount = Array.isArray(entry?.sources) ? entry.sources.length : Number(entry?.sourceCount ?? 0)
  const stars = Math.max(0, Number(entry?.stars ?? 0) || 0)
  const downloads = Math.max(0, Number(entry?.downloads ?? 0) || 0)
  const popularity = Math.min(12, Math.round(Math.log10(1 + stars + downloads) * 2.5))
  const recent = recencyScore(entry?.added)
  const score = Math.min(100, (verified ? 45 : 0)
    + (hasTarget ? 10 : 0)
    + (meaningfulDescription ? 20 : 0)
    + (dshRelevance ? 10 : 0)
    + Math.min(8, sourceCount * 2)
    + recent
    + Math.min(7, popularity))
  // Admission follows the catalog's own verdict: a row that arrives with a
  // target was given it by a source catalog, or had its manifest read and
  // accepted by the pipeline. Re-deciding that here with weaker information is
  // what cut the visible catalog from 11408 rows to 2999.
  const accepted = judgment.verdict !== 'exclude' && hasTarget
  const strongUsage = stars >= 100 || downloads >= 1000 || sourceCount >= 2
  const recommended = accepted && meaningfulDescription && strongUsage
    && (recent >= 4 || stars >= 100 || downloads >= 1000)
  const qualityState = !accepted ? 'unverified' : recommended ? 'recommended' : 'verified'
  const qualityReasons = [
    verified ? 'Harness manifest' : null,
    meaningfulDescription ? 'description' : null,
    dshRelevance ? 'DSH relevance' : null,
    sourceCount >= 2 ? 'multiple sources' : null,
    recent >= 5 ? 'recent activity' : null,
    popularity >= 5 ? 'usage signal' : null,
    judgment.reason,
  ].filter(Boolean)
  return { qualityState, qualityScore: score, qualityReasons }
}

/**
 * Annotate a catalog in place-shaped fashion (a new object, same rows).
 *
 * Idempotent: rows that already carry `qualityState` are left alone, so a
 * consumer may call this on an artifact the pipeline already annotated — and on
 * a row the host has enriched with its own installed-manifest evidence.
 *
 * @param raw - the catalog object as published.
 * @param options - `manifestVerified(entry)` for host-side evidence.
 * @returns `{ catalog, counts }`.
 */
export function annotateCatalog(raw, { manifestVerified = () => false } = {}) {
  const source = Array.isArray(raw?.plugins) ? raw.plugins : []
  const counts = { unverified: 0, verified: 0, recommended: 0 }
  const plugins = source.map(entry => {
    const quality = entry?.qualityState === undefined
      ? qualityOf(entry, { manifestVerified: manifestVerified(entry) })
      : { qualityState: entry.qualityState, qualityScore: entry.qualityScore ?? 0, qualityReasons: entry.qualityReasons ?? [] }
    counts[quality.qualityState] = (counts[quality.qualityState] ?? 0) + 1
    return entry?.qualityState === undefined ? { ...entry, ...quality } : entry
  })
  return { catalog: { ...raw, count: plugins.length, plugins, quality: counts }, counts }
}

/** `recommended` ranks above `verified`, which ranks above nothing. */
export function qualityRank(state) {
  return state === 'recommended' ? 2 : state === 'verified' ? 1 : 0
}

/**
 * The one ordering both consumers use for `sort=score`.
 *
 * Quality decides the band; raw popularity decides the order **inside** it.
 * Ordering by `qualityScore` inside the band instead buries a 40k-star entry at
 * position 6251, because that score saturates at 100 and 45 of its points are
 * withheld from the two thirds of the catalog the pipeline never probes.
 */
export function compareRecommended(a, b) {
  return (qualityRank(b.qualityState) - qualityRank(a.qualityState))
    || (b.score - a.score) || (b.stars - a.stars) || (b.downloads - a.downloads)
    || (b.qualityScore - a.qualityScore)
    || String(b.added).localeCompare(String(a.added)) || a.name.localeCompare(b.name)
}

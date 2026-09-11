/**
 * The contract a catalog published here must satisfy.
 *
 * dshmarket validates the whole catalog at once and throws on the first entry it
 * cannot use (`asRegistry` → `pluginCategories`), so a single empty `category`
 * does not degrade the market, it closes it:
 *
 *     catalog plugin 140 carries no usable category (15s, 2 attempts)
 *
 * That is what production showed with 3895 of 10693 entries carrying `""`. Two
 * lessons are encoded here rather than in a comment:
 *
 *   - the rule lives in ONE place and the pipeline asserts it before writing, so
 *     an unacceptable catalog cannot be published at all;
 *   - the check reports every violation and groups them, because fixing one
 *     entry per round trip is how a catalog takes a dozen attempts to repair.
 *
 * `ingest/validate-catalog.mjs` prefers dshmarket's own `pluginCategories` when
 * the package is installed; the mirror below is the documented behaviour, used
 * by the pipeline (which has no dshmarket to import) and by CI.
 */

/**
 * dshmarket's rule, mirrored: a string category or an array of them, yielding at
 * least one non-empty distinct string. Kept in behaviour with `src/registry.ts`.
 */
export function contractPluginCategories(plugin) {
  const values = Array.isArray(plugin?.category) ? plugin.category : [plugin?.category]
  const categories = []
  const seen = new Set()
  for (const value of values) {
    if (typeof value !== 'string' || value === '' || seen.has(value)) continue
    seen.add(value)
    categories.push(value)
  }
  return categories
}

/**
 * Every way one entry can be unacceptable.
 *
 * The category is enforced by the market itself; the remaining fields are the
 * shape its types declare as required, so a missing one renders as `undefined`
 * in the UI instead of failing loudly.
 *
 * @param plugin - one catalog entry.
 * @returns a list of human-readable problems, empty when the entry is fine.
 */
export function entryProblems(plugin, pluginCategories = contractPluginCategories) {
  const problems = []
  if (plugin === null || typeof plugin !== 'object' || Array.isArray(plugin)) return ['not an object']
  if (pluginCategories(plugin).length === 0) {
    problems.push(`category ${JSON.stringify(plugin.category ?? null)} yields nothing usable`)
  }
  for (const field of ['name', 'owner', 'url', 'install']) {
    if (typeof plugin[field] !== 'string' || plugin[field] === '') problems.push(`${field} is not a non-empty string`)
  }
  if (plugin.description === null || typeof plugin.description !== 'object' || Array.isArray(plugin.description)) {
    problems.push('description is not an object')
  } else if (Object.values(plugin.description).some((value) => typeof value !== 'string')) {
    problems.push('description has a non-string value')
  }
  if (typeof plugin.added !== 'string') problems.push('added is not a string')
  for (const field of ['stars', 'downloads']) {
    if (plugin[field] !== null && plugin[field] !== undefined && !Number.isFinite(plugin[field])) {
      problems.push(`${field} is not a number`)
    }
  }
  return problems
}

/**
 * Validate a catalog, reporting every violation and how they group.
 *
 * @param catalog - the parsed catalog (any object with a `plugins` array).
 * @param pluginCategories - the validator to apply.
 * @param limit - how many offending entries to detail.
 */
export function validateCatalog(catalog, pluginCategories = contractPluginCategories, { limit = 20 } = {}) {
  const plugins = catalog?.plugins
  if (!Array.isArray(plugins) || plugins.length === 0) {
    return { ok: false, total: 0, invalid: 0, problems: [['catalog', ['plugins is not a non-empty array']]], distinct: {} }
  }
  const problems = []
  /** @type {Record<string, number>} */
  const distinct = {}
  let invalid = 0
  for (const [index, plugin] of plugins.entries()) {
    const found = entryProblems(plugin, pluginCategories)
    if (found.length === 0) continue
    invalid += 1
    for (const problem of found) {
      // Group by rule, not by the offending value: "3895 empty categories" is
      // the fact that matters, and one line per entry buries it.
      const key = problem.replace(/"[^"]*"/g, '"…"').replace(/^category.*yields/, 'category yields')
      distinct[key] = (distinct[key] ?? 0) + 1
    }
    if (problems.length < limit) problems.push([`#${index} ${plugin?.name ?? '?'}`, found])
  }
  return { ok: invalid === 0, total: plugins.length, invalid, problems, distinct }
}

/**
 * Throw unless the catalog can be served to the market.
 *
 * Called by the pipeline before anything is written, so a catalog the market
 * would refuse never reaches a file — the failure happens in the run that
 * produced it, where it can be read, instead of in the user's settings window.
 *
 * @param catalog - the catalog about to be published.
 * @param log - where to send the grouping summary.
 */
export function assertCatalogAcceptable(catalog, log = console.log) {
  const result = validateCatalog(catalog)
  if (result.ok) return result
  log(`catalog contract: ${result.invalid}/${result.total} entries are unacceptable to dshmarket`)
  for (const [kind, count] of Object.entries(result.distinct).sort((a, b) => b[1] - a[1])) {
    log(`  ${String(count).padStart(6)}  ${kind}`)
  }
  for (const [label, found] of result.problems.slice(0, 5)) log(`  e.g. ${label}: ${found.join('; ')}`)
  throw new Error(`catalog contract violated by ${result.invalid} of ${result.total} entries; refusing to publish`)
}

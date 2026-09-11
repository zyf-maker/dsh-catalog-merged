/**
 * Catalog contract check.
 *
 * The market refuses the ENTIRE catalog when a single entry is unacceptable —
 * `asRegistry` throws on the first entry whose `category` yields nothing usable —
 * so one empty category is not a cosmetic flaw, it is a market that cannot open
 * at all. That is exactly what production showed:
 *
 *     catalog plugin 140 carries no usable category (15s, 2 attempts)
 *
 * This script applies **dshmarket's own validator** (imported from the installed
 * package, not a reimplementation) to a generated catalog and reports every
 * violation found rather than the first, because reporting one at a time is how
 * a catalog gets fixed in a dozen round trips.
 *
 * Usage:
 *   node ingest/validate-catalog.mjs [path-to-plugins.json]
 *   node ingest/validate-catalog.mjs --catalog data/catalog.json --market <pkg-dir>
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Load the real `pluginCategories` from an installed dshmarket.
 *
 * Located by walking the usual places a DSH profile keeps it, and overridable,
 * so this check runs in CI (where `--market` is absent and it falls back to the
 * documented rule) and on a machine that has the market installed (where the
 * authoritative code is used).
 */
async function loadRealValidator(explicit) {
  const candidates = []
  if (explicit !== undefined) candidates.push(explicit)
  if (process.env.DSH_MARKET_PACKAGE !== undefined) candidates.push(process.env.DSH_MARKET_PACKAGE)
  const home = process.env.DSH_HOME ?? join('D:', 'software', 'deepseek', 'dsh-data')
  candidates.push(join(home, 'profiles', 'web', 'node_modules', 'dshmarket'))
  for (const dir of candidates) {
    const entry = join(dir, 'lib', 'registry.js')
    if (!existsSync(entry)) continue
    try {
      const module = await import(pathToFileURL(entry).href)
      if (typeof module.pluginCategories === 'function') return { pluginCategories: module.pluginCategories, from: entry }
    } catch { /* try the next candidate */ }
  }
  return { pluginCategories: mirroredPluginCategories, from: '(mirrored rule: dshmarket not installed here)' }
}

/**
 * A mirror of dshmarket's rule, used only when the package is not available.
 * Kept byte-for-byte in behaviour with `src/registry.ts`: a string category, or
 * an array, yielding at least one non-empty distinct string.
 */
function mirroredPluginCategories(plugin) {
  const values = Array.isArray(plugin.category) ? plugin.category : [plugin.category]
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
 * Every way one entry can be unacceptable to the market.
 *
 * `asRegistry` enforces the category; the remaining fields are the shape the
 * market's own types declare as required, so an entry missing one renders as
 * `undefined` in the UI rather than failing loudly.
 *
 * @param plugin - one catalog entry.
 * @returns a list of human-readable problems, empty when the entry is fine.
 */
export function entryProblems(plugin, pluginCategories) {
  const problems = []
  if (plugin === null || typeof plugin !== 'object') return ['not an object']
  if (pluginCategories(plugin).length === 0) {
    problems.push(`category ${JSON.stringify(plugin.category ?? null)} yields nothing usable`)
  }
  for (const field of ['name', 'owner', 'url', 'install']) {
    if (typeof plugin[field] !== 'string' || plugin[field] === '') problems.push(`${field} is not a non-empty string`)
  }
  if (plugin.description === null || typeof plugin.description !== 'object' || Array.isArray(plugin.description)) {
    problems.push('description is not an object')
  } else if (Object.values(plugin.description).some((v) => typeof v !== 'string')) {
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
 * Validate a whole catalog and report every violation.
 *
 * @param catalog - the parsed catalog (any shape with a `plugins` array).
 * @param pluginCategories - the market's own validator.
 * @param limit - how many offending entries to detail.
 */
export function validateCatalog(catalog, pluginCategories, { limit = 20 } = {}) {
  const plugins = catalog?.plugins
  if (!Array.isArray(plugins) || plugins.length === 0) {
    return { ok: false, total: 0, invalid: 0, problems: [['catalog', ['plugins is not a non-empty array']]], distinct: {} }
  }
  const problems = []
  /** @type {Record<string, number>} */
  const distinct = {}
  for (const [index, plugin] of plugins.entries()) {
    const found = entryProblems(plugin, pluginCategories)
    if (found.length === 0) continue
    for (const problem of found) {
      const key = problem.replace(/"[^"]*"/g, '"…"')
      distinct[key] = (distinct[key] ?? 0) + 1
    }
    if (problems.length < limit) problems.push([`#${index} ${plugin?.name ?? '?'}`, found])
  }
  const invalid = plugins.reduce((count, plugin) => count + (entryProblems(plugin, pluginCategories).length > 0 ? 1 : 0), 0)
  return { ok: invalid === 0, total: plugins.length, invalid, problems, distinct }
}

/** CLI: validate a file and exit non-zero when the market would refuse it. */
async function main() {
  const args = process.argv.slice(2)
  const valueOf = (flag) => { const i = args.indexOf(flag); return i === -1 ? undefined : args[i + 1] }
  const path = resolve(valueOf('--catalog') ?? join('data', 'plugins.json'))
  if (!existsSync(path)) {
    console.error(`validate-catalog: no catalog at ${path}`)
    process.exit(1)
  }
  const catalog = JSON.parse(readFileSync(path, 'utf8'))
  const { pluginCategories, from } = await loadRealValidator(valueOf('--market'))
  console.log(`validate-catalog: ${path}`)
  console.log(`  validator: ${from}`)
  const result = validateCatalog(catalog, pluginCategories)
  console.log(`  entries: ${result.total}, unacceptable: ${result.invalid}`)
  if (result.ok) {
    console.log('  OK — the market will accept this catalog')
    return
  }
  console.log('  by kind:')
  for (const [kind, count] of Object.entries(result.distinct).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(count).padStart(6)}  ${kind}`)
  }
  console.log('  examples:')
  for (const [label, found] of result.problems.slice(0, 10)) {
    console.log(`    ${label}: ${found.join('; ')}`)
  }
  process.exit(1)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) await main()

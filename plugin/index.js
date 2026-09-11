/**
 * DSH Market — host half.
 *
 * Owns three things the market cannot do from a page:
 *   1. serving the catalog (fetched from the data repo, cached in memory),
 *   2. installing a plugin into the profile, in harness format, applying the
 *      compatibility repair when the plugin needs one,
 *   3. recording what happened, so a repair is never applied blindly twice.
 *
 * The install path deliberately mirrors the harness's own rules: a target is
 * only accepted when it came from the catalog (the catalog is the trust list),
 * and the overlay is a local package the harness installs like any other.
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

export const name = 'dsh-market-own'

/** Where the market's catalog artifacts live. */
const CATALOG_URL = process.env.DSH_MARKET_CATALOG
  ?? 'https://raw.githubusercontent.com/zyf-maker/dsh-catalog-merged/main/data/catalog.json'

const CACHE_MS = 5 * 60 * 1000

/**
 * Register the market with the host.
 *
 * @param ctx - the host context: `ctx.http` for routes, `ctx.settings` for the
 *   namespace, `ctx.home` for the harness home directory.
 */
export async function apply(ctx) {
  const state = { catalog: null, fetchedAt: 0 }

  /** Read the catalog, revalidating at most once every five minutes. */
  async function catalog() {
    if (state.catalog !== null && Date.now() - state.fetchedAt < CACHE_MS) return state.catalog
    const res = await fetch(CATALOG_URL, { headers: { accept: 'application/json' } })
    if (!res.ok) throw new Error(`catalog HTTP ${res.status}`)
    state.catalog = await res.json()
    state.fetchedAt = Date.now()
    return state.catalog
  }

  // ---- read routes: the UI's data plane ------------------------------------
  ctx.http?.get?.('/dsh-market/api/catalog', async (req, res) => {
    try {
      const data = await catalog()
      const url = new URL(req.url, 'http://localhost')
      const q = (url.searchParams.get('q') ?? '').toLowerCase()
      const sort = url.searchParams.get('sort') ?? 'score'
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 60), 200)
      let rows = data.plugins
      if (q !== '') {
        rows = rows.filter((p) =>
          `${p.name} ${p.owner} ${p.description?.en ?? ''} ${p.description?.zh ?? ''}`.toLowerCase().includes(q))
      }
      const key = sort === 'stars' ? 'stars' : sort === 'downloads' ? 'downloads' : 'score'
      rows = [...rows].sort((a, b) => (b[key] ?? 0) - (a[key] ?? 0)).slice(0, limit)
      res.end(JSON.stringify({ updated: data.updated, count: data.count, plugins: rows }))
    } catch (error) {
      // A market that cannot reach its catalog says so; it never shows emptiness
      // as if the catalog had nothing in it.
      res.statusCode = 502
      res.end(JSON.stringify({ error: 'catalog_unreachable', message: String(error.message) }))
    }
  })

  // ---- install, with the compatibility repair ------------------------------
  ctx.http?.post?.('/dsh-market/api/install', async (req, res) => {
    const body = await readJson(req)
    const target = String(body.target ?? '')
    const profile = String(body.profile ?? 'web')
    try {
      const data = await catalog()
      // Trust boundary: the catalog is the only source of install targets, so a
      // page cannot ask the host to install something the market never listed.
      const entry = data.plugins.find((p) => p.install === target || p.target === target || p.npm === target)
      if (entry === undefined) {
        res.statusCode = 400
        res.end(JSON.stringify({ ok: false, error: 'target_not_in_catalog' }))
        return
      }
      const result = await installWithRepair(ctx, entry, profile)
      res.end(JSON.stringify(result))
    } catch (error) {
      res.statusCode = 500
      res.end(JSON.stringify({ ok: false, error: String(error.message) }))
    }
  })
}

/**
 * Install one catalog entry, repairing it first when it needs repairing.
 *
 * @param ctx - host context (`ctx.home` locates the harness home).
 * @param entry - the catalog entry being installed.
 * @param profile - the target harness profile, `web` by default.
 */
async function installWithRepair(ctx, entry, profile) {
  const repair = entry.repair ?? null
  let target = entry.install

  if (repair?.overlay !== undefined && repair.overlay !== null) {
    // The overlay is written under the harness home, not into the user's
    // project: an install artifact must never appear in their working tree.
    const dir = join(ctx.home ?? process.cwd(), 'market-overlays', repair.overlay.name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify(repair.overlay, null, 2))
    target = dir
  }

  const args = ['plugin', '--profile', profile, 'add', target]
  const result = await run(ctx, args)
  if (repair?.overlay !== undefined && repair.overlay !== null) {
    // The overlay has been consumed by pnpm; keeping it would make the next
    // install look like a change to a package the user never asked for.
    try { rmSync(join(ctx.home ?? process.cwd(), 'market-overlays', repair.overlay.name), { recursive: true }) } catch { /* best effort */ }
  }
  return { ok: result.code === 0, code: result.code, log: result.output, repair, target: entry.install }
}

/** Run the harness CLI and capture its output. */
function run(ctx, args) {
  return new Promise((resolve) => {
    const child = spawn(ctx.cli ?? 'dsh', args, { cwd: ctx.home ?? process.cwd(), windowsHide: true })
    let output = ''
    child.stdout.on('data', (chunk) => { output += String(chunk) })
    child.stderr.on('data', (chunk) => { output += String(chunk) })
    child.on('error', (error) => resolve({ code: 1, output: `${output}\n${error.message}` }))
    child.on('close', (code) => resolve({ code: code ?? 1, output }))
  })
}

/** Read and parse a JSON request body, tolerating an empty one. */
async function readJson(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const text = Buffer.concat(chunks).toString('utf8')
  return text === '' ? {} : JSON.parse(text)
}

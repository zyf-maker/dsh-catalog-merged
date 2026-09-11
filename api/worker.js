/**
 * DSH Market — read API (Cloudflare Worker + D1).
 *
 * The API is the queryable face of the same catalog the ingest run emits as
 * JSON, so it can be deployed next to the data or skipped entirely: the static
 * `data/*.json` files on GitHub Pages answer the same questions for the market
 * UI, and the Worker exists for search, pagination and ranking at scale.
 *
 * Routes (all GET unless noted):
 *   /api/v1/health
 *   /api/v1/sources
 *   /api/v1/plugins?q=&category=&kind=&sort=&page=&limit=
 *   /api/v1/plugins/:id
 *   /api/v1/rankings?kind=score|stars|downloads&limit=
 *   /api/v1/new
 *   POST /api/v1/ingest/run      (Bearer INGEST_TOKEN) — dispatch the workflow
 */

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type,authorization',
  'cache-control': 'public, max-age=300',
}

const SORTS = {
  score: 'p.score DESC, p.stars DESC, p.downloads DESC',
  stars: 'p.stars DESC, p.downloads DESC, p.score DESC',
  downloads: 'p.downloads DESC, p.stars DESC, p.score DESC',
  newest: 'p.added_at DESC, p.score DESC',
  name: 'p.name ASC',
}

/** Entry point. */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: JSON_HEADERS })
    try {
      const route = `${request.method} ${url.pathname}`
      if (route === 'GET /api/v1/health') return await health(env)
      if (route === 'GET /api/v1/sources') return await sources(env)
      if (route === 'GET /api/v1/plugins') return await plugins(url, env)
      if (route === 'GET /api/v1/rankings') return await rankings(url, env)
      if (route === 'GET /api/v1/new') return await newest(url, env)
      if (request.method === 'GET' && /^\/api\/v1\/plugins\/.+$/.test(url.pathname)) {
        return await pluginDetail(decodeURIComponent(url.pathname.split('/').pop()), env)
      }
      if (route === 'POST /api/v1/ingest/run') return await triggerIngest(request, env)
      return json({ error: 'not_found', path: url.pathname }, 404)
    } catch (error) {
      return json({ error: 'internal', message: String(error?.message ?? error) }, 500)
    }
  },
}

/** Freshness of the data, so a consumer can tell "empty" from "stale". */
async function health(env) {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS plugins,
            MAX(updated_at) AS updated,
            SUM(CASE WHEN target_kind = 'npm' THEN 1 ELSE 0 END) AS npm,
            SUM(CASE WHEN target_kind = 'github' THEN 1 ELSE 0 END) AS github,
            SUM(CASE WHEN target_kind = 'tarball' THEN 1 ELSE 0 END) AS tarball
       FROM plugins`,
  ).first()
  const lastRun = await env.DB.prepare(
    `SELECT source_id, started_at, status, items, error FROM source_runs ORDER BY started_at DESC LIMIT 5`,
  ).all()
  return json({ ok: true, counts: row, lastRuns: lastRun.results ?? [] })
}

/** Source table with health, including self-discovered catalogs. */
async function sources(env) {
  const rows = await env.DB.prepare(
    `SELECT s.id, s.name, s.kind, s.url, s.discovered_from, s.enabled,
            s.first_seen, s.last_ok, s.last_error, s.ok_count, s.fail_count,
            (SELECT COUNT(*) FROM plugin_sources ps WHERE ps.source_id = s.id) AS plugins
       FROM sources s ORDER BY s.kind DESC, plugins DESC`,
  ).all()
  return json({ updated: new Date().toISOString(), sources: rows.results ?? [] })
}

/** Search + filter + paginate. */
async function plugins(url, env) {
  const limit = clamp(Number(url.searchParams.get('limit') ?? 50), 1, 200)
  const page = clamp(Number(url.searchParams.get('page') ?? 1), 1, 500)
  const sort = SORTS[url.searchParams.get('sort') ?? 'score'] ?? SORTS.score
  const q = (url.searchParams.get('q') ?? '').trim()
  const category = url.searchParams.get('category')
  const kind = url.searchParams.get('kind')

  const where = []
  const params = []
  if (q !== '') {
    where.push('(p.name LIKE ?1 OR p.owner LIKE ?1 OR p.desc_en LIKE ?1 OR p.desc_zh LIKE ?1)')
    params.push(`%${q}%`)
  }
  if (category) { where.push(`p.category = ?${params.length + 1}`); params.push(category) }
  if (kind) { where.push(`p.target_kind = ?${params.length + 1}`); params.push(kind) }
  const clause = where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`

  const statement = env.DB.prepare(
    `SELECT p.id, p.name, p.owner, p.url, p.category, p.desc_en, p.desc_zh, p.npm, p.tarball,
            p.install_target, p.target_kind, p.stars, p.downloads, p.score, p.version, p.added_at,
            (SELECT COUNT(*) FROM plugin_sources ps WHERE ps.plugin_id = p.id) AS source_count
       FROM plugins p ${clause} ORDER BY ${sort} LIMIT ?${params.length + 1} OFFSET ?${params.length + 2}`,
  )
  const rows = await statement.bind(...params, limit, (page - 1) * limit).all()
  const total = await env.DB.prepare(`SELECT COUNT(*) AS n FROM plugins p ${clause}`).bind(...params).first()
  return json({ page, limit, total: total?.n ?? 0, plugins: rows.results ?? [] })
}

/** One plugin, with provenance and its recorded repairs. */
async function pluginDetail(id, env) {
  const plugin = await env.DB.prepare(
    `SELECT p.*, (SELECT json_group_array(source_id) FROM plugin_sources ps WHERE ps.plugin_id = p.id) AS sources
       FROM plugins p WHERE p.id = ?1`,
  ).bind(id).first()
  if (plugin === null || plugin === undefined) return json({ error: 'not_found', id }, 404)
  const fixes = await env.DB.prepare(
    `SELECT id, target, issues, fix_kind, overlay, notes, created_at, verified
       FROM compat_fixes WHERE plugin_id = ?1 ORDER BY created_at DESC LIMIT 10`,
  ).bind(id).all()
  return json({ plugin, fixes: fixes.results ?? [] })
}

/** Leaderboards. */
async function rankings(url, env) {
  const kind = url.searchParams.get('kind') ?? 'score'
  const limit = clamp(Number(url.searchParams.get('limit') ?? 100), 1, 500)
  const column = kind === 'stars' ? 'stars' : kind === 'downloads' ? 'downloads' : 'score'
  const rows = await env.DB.prepare(
    `SELECT id, name, owner, url, category, target_kind, stars, downloads, score, install_target
       FROM plugins ORDER BY ${column} DESC, stars DESC LIMIT ?1`,
  ).bind(limit).all()
  return json({ kind, limit, plugins: (rows.results ?? []).map((p, i) => ({ rank: i + 1, ...p })) })
}

/** Recently added, ordered by catalog `added` date. */
async function newest(url, env) {
  const limit = clamp(Number(url.searchParams.get('limit') ?? 50), 1, 200)
  const rows = await env.DB.prepare(
    `SELECT id, name, owner, url, category, target_kind, stars, downloads, score, added_at, install_target
       FROM plugins WHERE added_at <> '' ORDER BY added_at DESC, score DESC LIMIT ?1`,
  ).bind(limit).all()
  return json({ plugins: rows.results ?? [] })
}

/**
 * Ask GitHub to run the ingest workflow.
 *
 * Guarded by a bearer token: the endpoint's job is to spend the operator's
 * GitHub quota, so it must not be callable by a page the user merely visited.
 */
async function triggerIngest(request, env) {
  const auth = request.headers.get('authorization') ?? ''
  if (env.INGEST_TOKEN === undefined || auth !== `Bearer ${env.INGEST_TOKEN}`) {
    return json({ error: 'forbidden' }, 403)
  }
  const res = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/ingest.yml/dispatches`,
    {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${env.GITHUB_TOKEN}`,
        'user-agent': 'dsh-market-api',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ref: env.GITHUB_REF ?? 'main' }),
    },
  )
  return json({ dispatched: res.ok, status: res.status }, res.ok ? 202 : 502)
}

/** JSON response helper. */
function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS })
}

/** Keep a query parameter inside a sane range. */
function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/**
 * Harvesters — one per channel kind. Each returns raw entries plus its own
 * health record, and never throws: a dead source is recorded, not fatal, so a
 * single broken mirror can never blank the market.
 */
import { DENY_REPOS } from './sources.mjs'

const UA = 'dsh-market-ingest/1.0 (+https://github.com/zyf-maker/dsh-catalog-merged)'

/** Fetch one JSON catalog and hand back its raw entry list. */
export async function harvestCatalog(source, { fetchImpl = fetch, log = () => {}, maxPages = 120 } = {}) {
  const started = Date.now()
  try {
    const items = []
    let page = source.paginate?.firstPage ?? 1
    for (;;) {
      const url = source.paginate === undefined
        ? source.url
        : `${source.url}&${source.paginate.param}=${page}`
      const res = await fetchImpl(url, { headers: { accept: 'application/json', 'user-agent': UA } })
      if (!res.ok) {
        // A failed first page is a dead source; a failed later page keeps what
        // was already collected, because a partial catalog beats none.
        if (items.length === 0) return fail(`${source.name}: HTTP ${res.status}`, started)
        break
      }
      const json = await res.json()
      const list = source.pick ? source.pick(json) : null
      if (!Array.isArray(list)) {
        if (items.length === 0) return fail(`${source.name}: no entry array`, started)
        break
      }
      items.push(...list.map((raw) => ({ raw, sourceId: source.id, requireType: source.requireType })))
      if (source.paginate === undefined) break
      const total = source.paginate.totalFrom?.(json) ?? null
      const size = source.paginate.pageSize ?? list.length
      if (list.length < size) break
      if (total !== null && items.length >= total) break
      page += 1
      if (page > maxPages) { log(`${source.name}: stopped at the page cap (${maxPages})`); break }
    }
    if (items.length === 0) return fail(`${source.name}: no entries`, started)
    log(`${source.name}: ${items.length} raw entries`)
    return { ok: true, items, ms: Date.now() - started }
  } catch (error) {
    return fail(`${source.name}: ERR ${error.message}`, started)
  }
}

/**
 * GitHub topic harvest. This is the channel that finds plugins no directory
 * has listed yet, which is why it exists alongside the catalogs.
 *
 * @param source - the harvest source row (its `url` carries the query).
 * @param options - `token` lifts the anonymous 10 req/min limit.
 */
export async function harvestGitHubTopic(source, { token, fetchImpl = fetch, log = () => {}, pages = 3 } = {}) {
  const started = Date.now()
  const headers = { accept: 'application/vnd.github+json', 'user-agent': UA }
  if (token) headers.authorization = `Bearer ${token}`
  const items = []
  try {
    for (let page = 1; page <= pages; page += 1) {
      const res = await fetchImpl(`${source.url}&per_page=100&page=${page}`, { headers })
      if (!res.ok) {
        if (items.length === 0) return fail(`${source.name}: HTTP ${res.status}`, started)
        break
      }
      const json = await res.json()
      const batch = json.items ?? []
      for (const repo of batch) {
        if (!repo.full_name || DENY_REPOS.has(repo.full_name) || repo.archived === true || repo.fork === true) continue
        items.push({
          sourceId: source.id,
          raw: {
            full_name: repo.full_name,
            url: repo.html_url,
            description: repo.description ?? '',
            stars: repo.stargazers_count ?? 0,
            owner: (repo.owner ?? {}).login ?? repo.full_name.split('/')[0],
            category: '',
            topics: repo.topics ?? [],
            pushed_at: repo.pushed_at ?? '',
            type: '插件',
            source: 'auto',
          },
        })
      }
      if (batch.length < 100) break
    }
    log(`${source.name}: ${items.length} repos`)
    return { ok: true, items, ms: Date.now() - started }
  } catch (error) {
    return fail(`${source.name}: ERR ${error.message}`, started)
  }
}

/** npm keyword harvest: plugins distributed as npm packages. */
export async function harvestNpmKeyword(source, { fetchImpl = fetch, log = () => {}, pages = 4 } = {}) {
  const started = Date.now()
  const items = []
  try {
    for (let page = 0; page < pages; page += 1) {
      const from = page * 250
      const res = await fetchImpl(`${source.url}&from=${from}`, { headers: { accept: 'application/json', 'user-agent': UA } })
      if (!res.ok) {
        if (items.length === 0) return fail(`${source.name}: HTTP ${res.status}`, started)
        break
      }
      const json = await res.json()
      const batch = json.objects ?? []
      for (const hit of batch) {
        const pkg = hit.package ?? {}
        if (!pkg.name) continue
        items.push({
          sourceId: source.id,
          raw: {
            name: pkg.name,
            npm: pkg.name,
            url: pkg.links?.repository ?? pkg.links?.npm ?? `https://www.npmjs.com/package/${pkg.name}`,
            owner: (pkg.publisher?.username ?? (pkg.name.startsWith('@') ? pkg.name.split('/')[0].slice(1) : '')),
            description: pkg.description ?? '',
            stars: hit.score ? Math.round(hit.score * 1000) : 0,
            downloads: hit.downloads?.monthly ?? 0,
            category: '',
            version: pkg.version ?? '',
            added: (pkg.date ?? '').slice(0, 10),
            type: '插件',
          },
        })
      }
      if (batch.length < 250) break
    }
    log(`${source.name}: ${items.length} packages`)
    return { ok: true, items, ms: Date.now() - started }
  } catch (error) {
    return fail(`${source.name}: ERR ${error.message}`, started)
  }
}

/** Dispatch on the source kind, so the orchestrator stays a loop. */
export function harvesterFor(source) {
  if (source.kind === 'catalog') return harvestCatalog
  if (source.id.startsWith('npm')) return harvestNpmKeyword
  return harvestGitHubTopic
}

function fail(message, started) {
  return { ok: false, items: [], ms: Date.now() - started, error: message }
}

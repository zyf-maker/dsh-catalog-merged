/**
 * Load a catalog artifact into SQLite (or Cloudflare D1) using the schema in
 * db/schema.sql. Kept separate from the ingest run because the same JSON feeds
 * a static host, a local database, and D1 — the loader is the only part that
 * knows about SQL.
 *
 * Usage:
 *   node ingest/load-sqlite.mjs --db data/market.sql       # emits SQL to pipe
 *   node ingest/load-sqlite.mjs --db data/market.sql --apply
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const args = process.argv.slice(2)
const dbPath = valueOf('--db') ?? join(ROOT, 'data', 'market.sql')
const catalogPath = valueOf('--catalog') ?? join(ROOT, 'data', 'catalog.json')
const sourcesPath = join(dirname(catalogPath), 'sources.json')

const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'))
const sources = JSON.parse(readFileSync(sourcesPath, 'utf8'))
const now = new Date().toISOString()

/**
 * The canonical id comes from the catalog, which the ingest run computed by
 * folding every source's keys into an equivalence class.
 *
 * Recomputing it here from a record's own fields is what the first version did,
 * and it is why the loader silently disagreed with the catalog about what the
 * same plugin is: the loader saw one record, the merge had seen all of them.
 * An entry without an id is therefore a format error, not something to guess at.
 */
function idOf(plugin) {
  if (typeof plugin.id === 'string' && plugin.id !== '') return plugin.id
  throw new Error(`catalog entry "${plugin.name ?? '?'}" has no id; regenerate the catalog with the current ingest run`)
}

const statements = []
const q = (value) => (value === null || value === undefined ? 'NULL' : `'${String(value).replace(/'/g, "''")}'`)
const n = (value) => (Number.isFinite(Number(value)) ? String(Math.trunc(Number(value))) : '0')

// Sources first: plugin_sources has a foreign key onto them.
for (const source of sources.sources) {
  statements.push(
    `INSERT INTO sources (id,name,kind,url,discovered_from,enabled,first_seen,last_ok,last_error,ok_count,fail_count) VALUES (` +
    [q(source.id), q(source.name), q(source.kind), q(source.url), q(source.discoveredFrom), '1', q(source.at),
     source.ok ? q(source.at) : 'NULL', source.error ? q(source.error) : 'NULL',
     source.ok ? '1' : '0', source.ok ? '0' : '1'].join(',') + `)
     ON CONFLICT(id) DO UPDATE SET last_ok=excluded.last_ok, last_error=excluded.last_error,
       ok_count=sources.ok_count+excluded.ok_count, fail_count=sources.fail_count+excluded.fail_count;`,
  )
  statements.push(
    `INSERT INTO source_runs (source_id,started_at,finished_at,status,items,error) VALUES (` +
    [q(source.id), q(source.at), q(source.at), q(source.ok ? 'ok' : 'failed'), n(source.items),
     source.error ? q(source.error) : 'NULL'].join(',') + ');',
  )
}

// Plugins, then their provenance, so a re-run updates rather than duplicates.
for (const plugin of catalog.plugins) {
  const id = idOf(plugin)
  statements.push(
    `INSERT INTO plugins (id,name,owner,url,repo,category,desc_en,desc_zh,npm,tarball,install_target,target_kind,
       stars,downloads,score,version,added_at,first_seen,updated_at,deprecated,replacement,content_hash) VALUES (` +
    [q(id), q(plugin.name), q(plugin.owner), q(plugin.url), q(plugin.repo), q(plugin.category),
     q(plugin.description?.en), q(plugin.description?.zh), q(plugin.npm), q(plugin.tarball),
     q(plugin.install), q(plugin.targetKind), n(plugin.stars), n(plugin.downloads), n(plugin.score),
     q(plugin.version), q(plugin.added), q(catalog.updated), q(catalog.updated), '0', 'NULL', q(hash(plugin))].join(',') + `)
     ON CONFLICT(id) DO UPDATE SET stars=excluded.stars, downloads=excluded.downloads, score=excluded.score,
       install_target=excluded.install_target, target_kind=excluded.target_kind, version=excluded.version,
       updated_at=excluded.updated_at, content_hash=excluded.content_hash;`,
  )
  for (const sourceId of plugin.sources ?? []) {
    statements.push(
      `INSERT INTO plugin_sources (plugin_id,source_id,first_seen,last_seen) VALUES (` +
      [q(id), q(sourceId), q(catalog.updated), q(catalog.updated)].join(',') + `)
       ON CONFLICT(plugin_id,source_id) DO UPDATE SET last_seen=excluded.last_seen;`,
    )
  }
  if (plugin.version) {
    statements.push(
      `INSERT INTO versions (plugin_id,version,published_at,downloads) VALUES (` +
      [q(id), q(plugin.version), q(plugin.added), n(plugin.downloads)].join(',') +
      `) ON CONFLICT(plugin_id,version) DO UPDATE SET downloads=excluded.downloads;`,
    )
  }
}

// Rankings are materialized per kind so the API can serve a leaderboard cheaply.
const rankKinds = {
  score: [...catalog.plugins].sort((a, b) => b.score - a.score),
  stars: [...catalog.plugins].sort((a, b) => b.stars - a.stars),
  downloads: [...catalog.plugins].sort((a, b) => b.downloads - a.downloads),
}
for (const [kind, rows] of Object.entries(rankKinds)) {
  rows.slice(0, 500).forEach((plugin, index) => {
    statements.push(
      `INSERT INTO rankings (plugin_id,kind,rank,computed_at) VALUES (` +
      [q(idOf(plugin)), q(kind), String(index + 1), q(now)].join(',') + `)
       ON CONFLICT(plugin_id,kind) DO UPDATE SET rank=excluded.rank, computed_at=excluded.computed_at;`,
    )
  })
}

const sql = `PRAGMA foreign_keys = ON;\nBEGIN;\n${statements.join('\n')}\nCOMMIT;\n`
if (args.includes('--apply')) writeFileSync(dbPath, sql)
else process.stdout.write(sql)
console.error(`load-sqlite: ${catalog.plugins.length} plugins, ${statements.length} statements`)
if (args.includes('--apply')) console.error(`load-sqlite: wrote ${dbPath}`)

/** Content hash so a consumer can tell whether a record actually changed. */
function hash(plugin) {
  const value = `${plugin.install}|${plugin.stars}|${plugin.downloads}|${plugin.version}|${plugin.description?.en ?? ''}`
  let h = 2166136261
  for (let i = 0; i < value.length; i += 1) { h ^= value.charCodeAt(i); h = Math.imul(h, 16777619) }
  return (h >>> 0).toString(16)
}

/** Read `--flag value` from argv. */
function valueOf(flag) {
  const index = args.indexOf(flag)
  return index === -1 ? null : args[index + 1]
}

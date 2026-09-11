/**
 * Loader integration test.
 *
 * The CI run failed twice on this one component — first on a stale import, then
 * because the schema was never applied and every insert hit "no such table".
 * Both were invisible to a syntax check, so the loader is exercised end to end
 * against a fixture, and the emitted SQL is applied to a real SQLite file when
 * the `sqlite3` CLI is available.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** A two-plugin catalog with provenance, enough to exercise every table. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-market-'))
  const updated = new Date().toISOString()
  writeFileSync(join(dir, 'catalog.json'), JSON.stringify({
    updated,
    count: 2,
    plugins: [
      {
        id: 'npm:alpha', name: 'alpha', owner: 'o', url: 'https://github.com/o/alpha',
        repoPath: 'o/alpha', repoSubpath: null, category: 'tools',
        description: { en: 'Alpha.', zh: '阿尔法。' }, npm: 'alpha', tarball: null,
        install: 'dsh plugin --profile web add alpha', target: 'alpha', targetKind: 'npm',
        stars: 10, downloads: 5, score: 10005, version: '1.0.0', added: '2026-01-01',
        sources: ['fixture-a', 'fixture-b'],
      },
      {
        id: 'repo:o/beta', name: 'beta', owner: 'o', url: 'https://github.com/o/beta',
        repoPath: 'o/beta', repoSubpath: 'packages/beta', category: 'ui',
        description: { en: '', zh: '' }, npm: null, tarball: null,
        install: 'dsh plugin add github:o/beta', target: 'github:o/beta', targetKind: 'github',
        stars: 3, downloads: 0, score: 3000, version: '', added: '',
        sources: ['fixture-a'],
      },
    ],
  }), 'utf8')
  writeFileSync(join(dir, 'sources.json'), JSON.stringify({
    sources: [
      { id: 'fixture-a', name: 'Fixture A', kind: 'catalog', url: 'https://example.invalid/a', ok: true, items: 2, ms: 5, error: null, at: updated },
      { id: 'fixture-b', name: 'Fixture B', kind: 'harvest', url: 'https://example.invalid/b', ok: false, items: 0, ms: 1, error: 'HTTP 500', at: updated },
    ],
  }), 'utf8')
  return dir
}

/** Run the loader and return the SQL it emitted. */
function emit(dir) {
  const out = join(dir, 'market.sql')
  execFileSync(process.execPath, [join(ROOT, 'ingest', 'load-sqlite.mjs'), '--catalog', join(dir, 'catalog.json'), '--db', out, '--apply'], { stdio: 'pipe' })
  return readFileSync(out, 'utf8')
}

test('the emitted SQL carries its own schema', () => {
  const sql = emit(fixture())
  assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS plugins'), 'the plugins table must be created')
  assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS rankings'), 'the rankings table must be created')
  assert.ok(sql.includes('CREATE VIRTUAL TABLE IF NOT EXISTS plugins_fts'), 'the search index must be created')
  assert.ok(sql.indexOf('CREATE TABLE IF NOT EXISTS plugins') < sql.indexOf('INSERT INTO plugins'),
    'the schema must precede the data')
  assert.ok(sql.includes('PRAGMA foreign_keys = ON;'), 'foreign keys must be enforced')
})

test('ids, provenance and a failing source survive the round trip', () => {
  const sql = emit(fixture())
  assert.ok(sql.includes("'npm:alpha'"), 'the catalog id is used as the primary key')
  assert.ok(sql.includes("'repo:o/beta'"))
  // Two sources listing one plugin => two provenance rows, one plugin row.
  assert.ok(sql.includes("'npm:alpha','fixture-a'") && sql.includes("'npm:alpha','fixture-b'"))
  assert.ok(sql.includes("'fixture-b','fixture-b'") === false, 'no invented source rows')
  assert.ok(sql.includes("'failed'"), 'a failed source is recorded as failed')
})

test('the SQL applies to a real database', (t) => {
  let sqlite3
  try { sqlite3 = execFileSync('sqlite3', ['--version'], { stdio: 'pipe' }).toString() } catch { t.skip('sqlite3 CLI is not installed here'); return }
  const dir = fixture()
  const sql = emit(dir)
  const db = join(dir, 'market.db')
  execFileSync('sqlite3', [db], { input: sql, stdio: ['pipe', 'pipe', 'pipe'] })
  assert.ok(existsSync(db))
  const count = execFileSync('sqlite3', [db, 'SELECT COUNT(*) FROM plugins;'], { stdio: 'pipe' }).toString().trim()
  assert.equal(count, '2')
  const prov = execFileSync('sqlite3', [db, 'SELECT COUNT(*) FROM plugin_sources;'], { stdio: 'pipe' }).toString().trim()
  assert.equal(prov, '3')
  const leader = execFileSync('sqlite3', [db, 'SELECT name FROM v_leaderboard LIMIT 1;'], { stdio: 'pipe' }).toString().trim()
  assert.equal(leader, 'alpha', 'the leaderboard view orders by score')
})

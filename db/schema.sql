-- DSH Market — data model.
--
-- Dialect: SQLite, which is also what Cloudflare D1 runs, so the same file
-- serves the Worker API and any local `sqlite3 data/market.db`. The catalog
-- itself is emitted as JSON by the ingest run; this schema is the queryable
-- form of the same data, loaded with `ingest/load-sqlite.mjs`.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- sources
-- Every place the market reads from, including ones it discovered by itself.
CREATE TABLE IF NOT EXISTS sources (
  id              TEXT PRIMARY KEY,           -- stable slug, e.g. 'dshget', 'discovered:owner/repo'
  name            TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('catalog', 'harvest')),
  url             TEXT NOT NULL,
  discovered_from TEXT,                       -- NULL for seed sources, else the signal that found it
  enabled         INTEGER NOT NULL DEFAULT 1,
  first_seen      TEXT NOT NULL,
  last_ok         TEXT,
  last_error      TEXT,
  ok_count        INTEGER NOT NULL DEFAULT 0,
  fail_count      INTEGER NOT NULL DEFAULT 0
);

-- One harvest attempt per source. Keeps the market honest about staleness.
CREATE TABLE IF NOT EXISTS source_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id   TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  status      TEXT NOT NULL CHECK (status IN ('running', 'ok', 'failed')),
  items       INTEGER NOT NULL DEFAULT 0,
  error       TEXT
);
CREATE INDEX IF NOT EXISTS source_runs_source_idx ON source_runs (source_id, started_at DESC);

-- ---------------------------------------------------------------- plugins
CREATE TABLE IF NOT EXISTS plugins (
  id           TEXT PRIMARY KEY,              -- identity key: 'npm:x' | 'repo:owner/name' | 'name:x'
  name         TEXT NOT NULL,
  owner        TEXT NOT NULL DEFAULT '',
  url          TEXT NOT NULL,
  repo         TEXT,                          -- owner/name when the plugin lives on GitHub
  category     TEXT NOT NULL DEFAULT '',
  desc_en      TEXT NOT NULL DEFAULT '',
  desc_zh      TEXT NOT NULL DEFAULT '',
  npm          TEXT,
  tarball      TEXT,
  install_target TEXT NOT NULL,               -- the exact spec the harness installs
  target_kind  TEXT NOT NULL CHECK (target_kind IN ('npm', 'github', 'tarball', 'other')),
  stars        INTEGER NOT NULL DEFAULT 0,
  downloads    INTEGER NOT NULL DEFAULT 0,
  score        INTEGER NOT NULL DEFAULT 0,    -- stars*1000 + downloads
  version      TEXT NOT NULL DEFAULT '',
  added_at     TEXT NOT NULL DEFAULT '',
  first_seen   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  deprecated   INTEGER NOT NULL DEFAULT 0,
  replacement  TEXT,
  content_hash TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS plugins_score_idx     ON plugins (score DESC);
CREATE INDEX IF NOT EXISTS plugins_stars_idx     ON plugins (stars DESC);
CREATE INDEX IF NOT EXISTS plugins_downloads_idx ON plugins (downloads DESC);
CREATE INDEX IF NOT EXISTS plugins_category_idx  ON plugins (category);
CREATE INDEX IF NOT EXISTS plugins_kind_idx      ON plugins (target_kind);

-- Provenance: which sources list a plugin. Many-to-many on purpose — a plugin
-- listed by three catalogs is one row in `plugins` and three rows here, which is
-- exactly what "deduplicated but attributed" means.
CREATE TABLE IF NOT EXISTS plugin_sources (
  plugin_id  TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  source_id  TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  first_seen TEXT NOT NULL,
  last_seen  TEXT NOT NULL,
  PRIMARY KEY (plugin_id, source_id)
);

-- Versions seen, so the UI can show whether an installed copy is behind.
CREATE TABLE IF NOT EXISTS versions (
  plugin_id    TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  version      TEXT NOT NULL,
  published_at TEXT,
  downloads    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (plugin_id, version)
);

-- --------------------------------------------------------- compatibility
-- Every install-time repair the market applied, kept so the same fix is not
-- recomputed (and so a repair that caused trouble can be found later).
CREATE TABLE IF NOT EXISTS compat_fixes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  plugin_id  TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  target     TEXT NOT NULL,
  issues     TEXT NOT NULL,                   -- JSON array of {code, detail}
  fix_kind   TEXT NOT NULL,                   -- 'overlay' for generated shims
  overlay    TEXT,                            -- JSON package.json of the shim
  notes      TEXT NOT NULL DEFAULT '',        -- human-readable summary
  created_at TEXT NOT NULL,
  verified   INTEGER NOT NULL DEFAULT 0       -- set once the install succeeded
);
CREATE INDEX IF NOT EXISTS compat_fixes_plugin_idx ON compat_fixes (plugin_id, created_at DESC);

-- One row per install the market performed, with the fix it used (if any).
CREATE TABLE IF NOT EXISTS install_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  plugin_id     TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  target        TEXT NOT NULL,
  compat_fix_id INTEGER REFERENCES compat_fixes(id),
  status        TEXT NOT NULL CHECK (status IN ('started', 'succeeded', 'failed', 'rolled-back')),
  profile       TEXT NOT NULL DEFAULT 'web',
  log           TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS install_events_plugin_idx ON install_events (plugin_id, created_at DESC);

-- ---------------------------------------------------------------- rankings
-- Materialized so the API can answer a leaderboard with one index scan.
CREATE TABLE IF NOT EXISTS rankings (
  plugin_id   TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('score', 'stars', 'downloads', 'new')),
  rank        INTEGER NOT NULL,
  computed_at TEXT NOT NULL,
  PRIMARY KEY (plugin_id, kind)
);
CREATE INDEX IF NOT EXISTS rankings_kind_idx ON rankings (kind, rank);

-- Full-text search over name/description, mirroring what the API exposes.
CREATE VIRTUAL TABLE IF NOT EXISTS plugins_fts USING fts5(
  id UNINDEXED, name, owner, desc_en, desc_zh, category,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- ------------------------------------------------------------------ views
CREATE VIEW IF NOT EXISTS v_leaderboard AS
SELECT p.id, p.name, p.owner, p.category, p.target_kind, p.stars, p.downloads, p.score,
       (SELECT COUNT(*) FROM plugin_sources s WHERE s.plugin_id = p.id) AS source_count
FROM plugins p
ORDER BY p.score DESC, p.stars DESC, p.downloads DESC;

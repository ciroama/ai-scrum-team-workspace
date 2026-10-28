import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

export const SCHEMA_VERSION = 4;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_config (
  agent_id   TEXT PRIMARY KEY,
  enabled    INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workflows (
  id             TEXT PRIMARY KEY,
  request_text   TEXT NOT NULL,
  recipe_id      TEXT,
  title          TEXT NOT NULL,
  status         TEXT NOT NULL,
  stage          TEXT NOT NULL,
  verified       INTEGER NOT NULL DEFAULT 0,
  blocked_reason TEXT,
  error          TEXT,
  state          TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  finished_at    TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id),
  agent_id    TEXT NOT NULL,
  stage       TEXT NOT NULL,
  title       TEXT NOT NULL,
  status      TEXT NOT NULL,
  input       TEXT,
  output      TEXT,
  error       TEXT,
  started_at  TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id TEXT REFERENCES workflows(id),
  ts          TEXT NOT NULL,
  type        TEXT NOT NULL,
  category    TEXT NOT NULL,
  actor       TEXT NOT NULL,
  actor_kind  TEXT NOT NULL,
  from_actor  TEXT,
  to_actor    TEXT,
  summary     TEXT NOT NULL,
  detail      TEXT,
  status      TEXT NOT NULL,
  error       TEXT,
  task_id     TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS events_by_workflow ON events (workflow_id, id);
CREATE INDEX IF NOT EXISTS tasks_by_workflow ON tasks (workflow_id, started_at);
`;

/**
 * Milestone 1 used a different schema (stories/runs). Its database only
 * held demo runs, so instead of migrating it we keep it, renamed, next to
 * the new one.
 */
function backUpLegacyDatabase(file) {
  if (!existsSync(file)) return null;
  const probe = new DatabaseSync(file);
  const legacy = probe.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'stories'`).get();
  probe.close();
  if (!legacy) return null;

  const backup = file.replace(/\.db$/, '') + '.v1.db';
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(file + suffix)) renameSync(file + suffix, backup + suffix);
  }
  return backup;
}

/** Additive migrations for databases created by earlier versions. */
function migrate(db) {
  const agentColumns = db.prepare('PRAGMA table_info(agent_config)').all().map((c) => c.name);
  // v3: how each agent decides: 'scripted' (rules) or 'ai' (model-backed).
  if (!agentColumns.includes('mode')) db.exec(`ALTER TABLE agent_config ADD COLUMN mode TEXT NOT NULL DEFAULT 'scripted'`);

  // v4: workflows belong to a product. A product is identified by the id of
  // its first workflow, whose folder holds the product files, so earlier
  // workflows simply become one-iteration products.
  const workflowColumns = db.prepare('PRAGMA table_info(workflows)').all().map((c) => c.name);
  if (!workflowColumns.includes('product_id')) db.exec('ALTER TABLE workflows ADD COLUMN product_id TEXT');
  db.exec('UPDATE workflows SET product_id = id WHERE product_id IS NULL');
  db.exec('CREATE INDEX IF NOT EXISTS workflows_by_product ON workflows (product_id, created_at)');
}

/**
 * Opens (and creates if needed) the workspace SQLite database.
 * @param {string} file path to the database file, or ':memory:'
 * @returns {{ db: import('node:sqlite').DatabaseSync, legacyBackup: string | null }}
 */
export function openDatabase(file) {
  let legacyBackup = null;
  if (file !== ':memory:') {
    mkdirSync(dirname(file), { recursive: true });
    legacyBackup = backUpLegacyDatabase(file);
  }
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  migrate(db);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  return { db, legacyBackup };
}

import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { SCHEMA_VERSION } from '@reverse/contracts';

const BASE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, target TEXT NOT NULL DEFAULT '',
    authorization_confirmed INTEGER NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS uploads (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL, stored_name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL,
    sha256 TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    adapter TEXT NOT NULL, status TEXT NOT NULL, current_stage TEXT NOT NULL, progress INTEGER NOT NULL DEFAULT 0,
    current_tool TEXT, attempt INTEGER NOT NULL DEFAULT 0, input_hash TEXT NOT NULL,
    options_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    started_at TEXT, ended_at TEXT, error TEXT, pause_requested INTEGER NOT NULL DEFAULT 0,
    cancel_requested INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS stages (
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, name TEXT NOT NULL,
    status TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, started_at TEXT, ended_at TEXT,
    error TEXT, cache_key TEXT, output_json TEXT, PRIMARY KEY(task_id,name));
  CREATE TABLE IF NOT EXISTS evidence (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    kind TEXT NOT NULL, title TEXT NOT NULL, source TEXT NOT NULL, locator TEXT NOT NULL,
    content_json TEXT NOT NULL, sha256 TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS findings (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    title TEXT NOT NULL, category TEXT NOT NULL, severity TEXT NOT NULL, confidence REAL NOT NULL,
    evidence_ids_json TEXT NOT NULL, details TEXT NOT NULL, recommendation TEXT NOT NULL, status TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    level TEXT NOT NULL, message TEXT NOT NULL, tool TEXT, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS artifacts (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    name TEXT NOT NULL, stored_path TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL,
    mime TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(task_id,name));
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, type TEXT NOT NULL,
    payload_json TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS idx_events_id ON events(id);
  CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status,created_at);
  CREATE INDEX IF NOT EXISTS idx_evidence_task ON evidence(task_id);
  CREATE INDEX IF NOT EXISTS idx_logs_task ON logs(task_id);
`;

const PLATFORM_SCHEMA = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL, backup_path TEXT);
  CREATE TABLE IF NOT EXISTS cache_entries (
    key TEXT PRIMARY KEY, scope TEXT NOT NULL, project_id TEXT, adapter TEXT NOT NULL, stage TEXT NOT NULL,
    size_bytes INTEGER NOT NULL, payload_path TEXT NOT NULL, payload_sha256 TEXT NOT NULL,
    hits INTEGER NOT NULL DEFAULT 0, misses INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, last_accessed_at TEXT NOT NULL, expires_at TEXT);
  CREATE INDEX IF NOT EXISTS idx_cache_access ON cache_entries(last_accessed_at);
  CREATE INDEX IF NOT EXISTS idx_cache_project ON cache_entries(project_id);
  CREATE TABLE IF NOT EXISTS cache_stats (
    id INTEGER PRIMARY KEY CHECK(id=1), hits INTEGER NOT NULL DEFAULT 0, misses INTEGER NOT NULL DEFAULT 0,
    writes INTEGER NOT NULL DEFAULT 0, corrupt INTEGER NOT NULL DEFAULT 0, evictions INTEGER NOT NULL DEFAULT 0);
  INSERT OR IGNORE INTO cache_stats (id) VALUES (1);
  CREATE TABLE IF NOT EXISTS resource_samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, snapshot_json TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS idx_resource_created ON resource_samples(created_at);
  CREATE TABLE IF NOT EXISTS task_resources (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE, peak_tree_rss_mb REAL NOT NULL DEFAULT 0,
    peak_heap_mb REAL NOT NULL DEFAULT 0, artifact_bytes INTEGER NOT NULL DEFAULT 0,
    started_at TEXT NOT NULL, ended_at TEXT);
  CREATE TABLE IF NOT EXISTS circuit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
    level TEXT NOT NULL, reason TEXT NOT NULL, snapshot_json TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS retention_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, category TEXT NOT NULL, item_path TEXT NOT NULL,
    reason TEXT NOT NULL, size_bytes INTEGER NOT NULL, created_at TEXT NOT NULL);
`;

export interface MigrationResult { previousVersion: number; version: number; backupPath?: string; applied: number[] }
export function migrateDatabase(raw: DatabaseSync, file: string): MigrationResult {
  const previousVersion = Number((raw.prepare('PRAGMA user_version').get() as {user_version:number}).user_version);
  if (previousVersion > SCHEMA_VERSION) throw new Error(`Database schema ${previousVersion} is newer than supported schema ${SCHEMA_VERSION}`);
  if (previousVersion === SCHEMA_VERSION && raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get()) return {previousVersion,version:SCHEMA_VERSION,applied:[]};
  let backupPath: string | undefined;
  if (file !== ':memory:' && existsSync(file)) {
    const backupDir = path.join(path.dirname(file), 'backups');
    mkdirSync(backupDir, { recursive: true });
    backupPath = path.join(backupDir, `pre-v${SCHEMA_VERSION}-${Date.now()}-${process.pid}.sqlite`);
    raw.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
  }
  const applied: number[] = [];
  try {
    raw.exec('BEGIN IMMEDIATE');
    const actualVersion=Number((raw.prepare('PRAGMA user_version').get() as {user_version:number}).user_version);
    if(actualVersion>=SCHEMA_VERSION){raw.exec('COMMIT');return {previousVersion,version:SCHEMA_VERSION,...(backupPath?{backupPath}:{}),applied:[]};}
    raw.exec(BASE_SCHEMA);
    raw.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL, backup_path TEXT)`);
    if (actualVersion < 1) {
      raw.prepare('INSERT OR REPLACE INTO schema_migrations (version,applied_at,backup_path) VALUES (?,?,?)').run(1,new Date().toISOString(),backupPath??null);
      applied.push(1);
    }
    if (actualVersion < 2) {
      raw.exec(PLATFORM_SCHEMA);
      raw.prepare('INSERT OR REPLACE INTO schema_migrations (version,applied_at,backup_path) VALUES (?,?,?)').run(2,new Date().toISOString(),backupPath??null);
      applied.push(2);
    }
    raw.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
    raw.exec('COMMIT');
  } catch (error) {
    try { raw.exec('ROLLBACK'); } catch { /* preserve original migration error */ }
    throw new Error(`Database migration failed; backup retained at ${backupPath??'not required'}: ${error instanceof Error?error.message:String(error)}`);
  }
  return { previousVersion, version: SCHEMA_VERSION, ...(backupPath?{backupPath}:{}), applied };
}

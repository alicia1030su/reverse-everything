import { existsSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
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
    cancel_requested INTEGER NOT NULL DEFAULT 0, lease_owner TEXT, lease_expires_at TEXT, heartbeat_at TEXT);
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

const REQUIRED_SCHEMA_3: Record<string, readonly string[]> = {
  projects: ['id','name','kind','target','authorization_confirmed','created_at'],
  uploads: ['id','project_id','name','stored_name','mime','size','sha256','created_at'],
  tasks: ['id','project_id','adapter','status','current_stage','progress','current_tool','attempt','input_hash','options_json','created_at','updated_at','started_at','ended_at','error','pause_requested','cancel_requested','lease_owner','lease_expires_at','heartbeat_at'],
  stages: ['task_id','name','status','attempt','started_at','ended_at','error','cache_key','output_json'],
  evidence: ['id','task_id','kind','title','source','locator','content_json','sha256','created_at'],
  findings: ['id','task_id','title','category','severity','confidence','evidence_ids_json','details','recommendation','status'],
  logs: ['id','task_id','level','message','tool','created_at'],
  artifacts: ['id','task_id','name','stored_path','size','sha256','mime','created_at'],
  settings: ['key','value'],
  events: ['id','task_id','type','payload_json','created_at'],
  schema_migrations: ['version','applied_at','backup_path'],
  cache_entries: ['key','scope','project_id','adapter','stage','size_bytes','payload_path','payload_sha256','hits','misses','created_at','last_accessed_at','expires_at','kind','ref_count'],
  cache_stats: ['id','hits','misses','writes','corrupt','evictions'],
  resource_samples: ['id','source','snapshot_json','created_at'],
  task_resources: ['task_id','peak_tree_rss_mb','peak_heap_mb','artifact_bytes','started_at','ended_at','peak_child_rss_mb','peak_cpu_percent'],
  circuit_events: ['id','task_id','level','reason','snapshot_json','created_at'],
  retention_events: ['id','category','item_path','reason','size_bytes','created_at'],
  backups: ['id','created_at','kind','size_bytes','file_count','sha256','database_sha256','schema_version','status','backup_path'],
  backup_events: ['id','backup_id','action','details_json','created_at'],
  agent_runs: ['id','task_id','role','status','iteration','input_json','output_json','error','created_at','updated_at']
};

const REQUIRED_INDEXES_3: Record<string, readonly string[]> = {
  idx_tasks_lease: ['status','lease_expires_at','created_at']
};

const SCHEMA_4 = `
  CREATE TABLE IF NOT EXISTS console_profiles (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
    manufacturer TEXT NOT NULL, series TEXT NOT NULL, model TEXT NOT NULL,
    hardware_version TEXT NOT NULL DEFAULT '', system_version TEXT NOT NULL DEFAULT '',
    user_info_json TEXT NOT NULL, official_interfaces_json TEXT NOT NULL,
    authorized_environments_json TEXT NOT NULL, firmware_samples_json TEXT NOT NULL,
    known_capabilities_json TEXT NOT NULL, actual_access_json TEXT NOT NULL,
    evidence_json TEXT NOT NULL, level INTEGER NOT NULL, limitations_json TEXT NOT NULL, profile_json TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS analysis_plans (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL, mode TEXT NOT NULL,
    target_json TEXT NOT NULL, detection_json TEXT NOT NULL, authorization_id TEXT,
    upload_id TEXT, upload_sha256 TEXT,
    steps_json TEXT NOT NULL, budget_json TEXT NOT NULL, status TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS authorization_scopes (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    target TEXT NOT NULL, scope_json TEXT NOT NULL, allowed_interfaces_json TEXT NOT NULL,
    allowed_operations_json TEXT NOT NULL, data_access_json TEXT NOT NULL,
    remote_ai_allowed INTEGER NOT NULL DEFAULT 0, expires_at TEXT, created_at TEXT NOT NULL, revoked_at TEXT);
  CREATE TABLE IF NOT EXISTS tool_installations (
    id TEXT PRIMARY KEY, tool_name TEXT NOT NULL, version TEXT NOT NULL, source_url TEXT NOT NULL,
    expected_sha256 TEXT NOT NULL, actual_sha256 TEXT, install_dir TEXT NOT NULL,
    status TEXT NOT NULL, progress_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS demo_runs (
    id TEXT PRIMARY KEY, demo_name TEXT NOT NULL, status TEXT NOT NULL, steps_json TEXT NOT NULL,
    result_json TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT);
  CREATE TABLE IF NOT EXISTS project_deletion_intents (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, task_ids_json TEXT NOT NULL,
    paths_json TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS idx_plans_project ON analysis_plans(project_id,created_at);
  CREATE INDEX IF NOT EXISTS idx_auth_project ON authorization_scopes(project_id,created_at);
  CREATE INDEX IF NOT EXISTS idx_demo_status ON demo_runs(status,started_at);
  CREATE INDEX IF NOT EXISTS idx_deletion_status ON project_deletion_intents(status,created_at);
`;

const SCHEMA_5 = `
  CREATE TABLE IF NOT EXISTS game_profiles (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL, genre TEXT NOT NULL, publisher TEXT NOT NULL, region TEXT NOT NULL,
    client_version TEXT NOT NULL, shutdown_date TEXT NOT NULL, engine TEXT NOT NULL,
    source_text TEXT NOT NULL, authorization_scope TEXT NOT NULL, known_protocols_json TEXT NOT NULL,
    retained_materials_json TEXT NOT NULL, existing_implementations_json TEXT NOT NULL,
    level TEXT NOT NULL, unrecovered_features_json TEXT NOT NULL, root_path TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS game_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    path TEXT NOT NULL, size INTEGER NOT NULL, mtime_ms REAL NOT NULL, ctime_ms REAL,
    dev TEXT, ino TEXT, sha256 TEXT NOT NULL,
    kind TEXT NOT NULL, scanned_at TEXT NOT NULL, UNIQUE(project_id,path));
  CREATE TABLE IF NOT EXISTS game_specs (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    spec_json TEXT NOT NULL, evidence_status TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS game_rebuilds (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    spec_id TEXT NOT NULL REFERENCES game_specs(id), status TEXT NOT NULL, level TEXT NOT NULL,
    output_path TEXT, error TEXT, validation_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS idx_game_files_project ON game_files(project_id);
  CREATE INDEX IF NOT EXISTS idx_game_rebuilds_project ON game_rebuilds(project_id,created_at);
`;

const REQUIRED_SCHEMA_4: Record<string, readonly string[]> = {
  ...REQUIRED_SCHEMA_3,
  console_profiles: ['id','project_id','manufacturer','series','model','hardware_version','system_version','user_info_json','official_interfaces_json','authorized_environments_json','firmware_samples_json','known_capabilities_json','actual_access_json','evidence_json','level','limitations_json','profile_json','created_at','updated_at'],
  analysis_plans: ['id','project_id','task_id','mode','target_json','detection_json','authorization_id','upload_id','upload_sha256','steps_json','budget_json','status','created_at','updated_at'],
  authorization_scopes: ['id','project_id','target','scope_json','allowed_interfaces_json','allowed_operations_json','data_access_json','remote_ai_allowed','expires_at','created_at','revoked_at'],
  tool_installations: ['id','tool_name','version','source_url','expected_sha256','actual_sha256','install_dir','status','progress_json','created_at','updated_at'],
  demo_runs: ['id','demo_name','status','steps_json','result_json','started_at','ended_at'],
  project_deletion_intents: ['id','project_id','task_ids_json','paths_json','status','created_at','updated_at']
};

const REQUIRED_SCHEMA_5: Record<string, readonly string[]> = {
  ...REQUIRED_SCHEMA_4,
  game_profiles: ['id','project_id','name','genre','publisher','region','client_version','shutdown_date','engine','source_text','authorization_scope','known_protocols_json','retained_materials_json','existing_implementations_json','level','unrecovered_features_json','root_path','created_at','updated_at'],
  game_files: ['id','project_id','path','size','mtime_ms','ctime_ms','dev','ino','sha256','kind','scanned_at'],
  game_specs: ['id','project_id','spec_json','evidence_status','created_at'],
  game_rebuilds: ['id','project_id','spec_id','status','level','output_path','error','validation_json','created_at','updated_at']
};

function addColumnIfMissing(raw: DatabaseSync, table: string, column: string, definition: string): void {
  const columns = raw.prepare(`PRAGMA table_info("${table}")`).all() as {name:string}[];
  if (!columns.some(item => item.name === column)) raw.exec(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${definition}`);
}

export function assertSchema3(raw: DatabaseSync): void {
  for (const [table, requiredColumns] of Object.entries(REQUIRED_SCHEMA_3)) {
    const present = raw.prepare("SELECT type FROM sqlite_master WHERE name=?").get(table) as {type:string}|undefined;
    if (!present || present.type !== 'table') throw new Error(`Database schema 3 integrity check failed: missing table ${table}`);
    const columns = new Set((raw.prepare(`PRAGMA table_info("${table}")`).all() as {name:string}[]).map(column => column.name));
    const missing = requiredColumns.filter(column => !columns.has(column));
    if (missing.length) throw new Error(`Database schema 3 integrity check failed: missing column(s) ${table}.${missing.join(',')}`);
  }
  for (const [index, requiredColumns] of Object.entries(REQUIRED_INDEXES_3)) {
    const present = raw.prepare("SELECT type FROM sqlite_master WHERE name=?").get(index) as {type:string}|undefined;
    if (!present || present.type !== 'index') throw new Error(`Database schema 3 integrity check failed: missing index ${index}`);
    const columns = (raw.prepare(`PRAGMA index_info("${index}")`).all() as {name:string|null}[]).map(column => column.name ?? '');
    if (columns.join(',') !== requiredColumns.join(',')) throw new Error(`Database schema 3 integrity check failed: invalid index ${index}`);
  }
}

export function assertSchema4(raw: DatabaseSync): void {
  for (const [table, requiredColumns] of Object.entries(REQUIRED_SCHEMA_4)) {
    const present = raw.prepare("SELECT type FROM sqlite_master WHERE name=?").get(table) as {type:string}|undefined;
    if (!present || present.type !== 'table') throw new Error(`Database schema 4 integrity check failed: missing table ${table}`);
    const columns = new Set((raw.prepare(`PRAGMA table_info("${table}")`).all() as {name:string}[]).map(column => column.name));
    const missing = requiredColumns.filter(column => !columns.has(column));
    if (missing.length) throw new Error(`Database schema 4 integrity check failed: missing column(s) ${table}.${missing.join(',')}`);
  }
  for (const [index, requiredColumns] of Object.entries(REQUIRED_INDEXES_3)) {
    const present = raw.prepare("SELECT type FROM sqlite_master WHERE name=?").get(index) as {type:string}|undefined;
    if (!present || present.type !== 'index') throw new Error(`Database schema 4 integrity check failed: missing index ${index}`);
    const columns = (raw.prepare(`PRAGMA index_info("${index}")`).all() as {name:string|null}[]).map(column => column.name ?? '');
    if (columns.join(',') !== requiredColumns.join(',')) throw new Error(`Database schema 4 integrity check failed: invalid index ${index}`);
  }
}

export function assertSchema5(raw: DatabaseSync): void {
  for (const [table, requiredColumns] of Object.entries(REQUIRED_SCHEMA_5)) {
    const present = raw.prepare("SELECT type FROM sqlite_master WHERE name=?").get(table) as {type:string}|undefined;
    if (!present || present.type !== 'table') throw new Error(`Database schema 5 integrity check failed: missing table ${table}`);
    const columns = new Set((raw.prepare(`PRAGMA table_info("${table}")`).all() as {name:string}[]).map(column => column.name));
    const missing = requiredColumns.filter(column => !columns.has(column));
    if (missing.length) throw new Error(`Database schema 5 integrity check failed: missing column(s) ${table}.${missing.join(',')}`);
  }
  for (const [index, requiredColumns] of Object.entries(REQUIRED_INDEXES_3)) {
    const present = raw.prepare("SELECT type FROM sqlite_master WHERE name=?").get(index) as {type:string}|undefined;
    if (!present || present.type !== 'index') throw new Error(`Database schema 5 integrity check failed: missing index ${index}`);
    const columns = (raw.prepare(`PRAGMA index_info("${index}")`).all() as {name:string|null}[]).map(column => column.name ?? '');
    if (columns.join(',') !== requiredColumns.join(',')) throw new Error(`Database schema 5 integrity check failed: invalid index ${index}`);
  }
}

export interface MigrationResult { previousVersion: number; version: number; backupPath?: string; applied: number[] }
function migrationFailure(backupPath: string | undefined, error: unknown): Error {
  const code = typeof error === 'object' && error !== null && 'errcode' in error ? String(error.errcode) : '';
  const safeCode = /^SQLITE_[A-Z0-9_]+$/.test(code) ? ` (${code})` : '';
  const rawMessage = error instanceof Error ? error.message : String(error ?? 'Unknown SQLite error');
  const safeMessage = rawMessage
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+/gi, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|password|secret|token)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[REDACTED]')
    .replace(/\s+/g, ' ').trim().slice(0, 1000);
  return new Error(`Database migration failed${safeCode}: ${safeMessage || 'SQLite error'}; backup retained at ${backupPath??'not required'}`);
}

export function migrateDatabase(raw: DatabaseSync, file: string): MigrationResult {
  const previousVersion = Number((raw.prepare('PRAGMA user_version').get() as {user_version:number}).user_version);
  if (previousVersion > SCHEMA_VERSION) throw new Error(`Database schema ${previousVersion} is newer than supported schema ${SCHEMA_VERSION}`);
  if (previousVersion === SCHEMA_VERSION) {
    addColumnIfMissing(raw, 'game_files', 'ctime_ms', 'REAL');
    addColumnIfMissing(raw, 'game_files', 'dev', 'TEXT');
    addColumnIfMissing(raw, 'game_files', 'ino', 'TEXT');
    assertSchema5(raw);
    return {previousVersion,version:SCHEMA_VERSION,applied:[]};
  }
  let backupPath: string | undefined;
  if (file !== ':memory:' && existsSync(file)) {
    const backupDir = path.join(path.dirname(file), 'backups');
    mkdirSync(backupDir, { recursive: true });
    backupPath = path.join(backupDir, `pre-v${SCHEMA_VERSION}-${Date.now()}-${process.pid}-${randomUUID()}.sqlite`);
    raw.prepare('VACUUM INTO ?').run(backupPath);
  }
  const applied: number[] = [];
  try {
    raw.exec('BEGIN IMMEDIATE');
    const actualVersion=Number((raw.prepare('PRAGMA user_version').get() as {user_version:number}).user_version);
    if (actualVersion >= SCHEMA_VERSION) {
      assertSchema5(raw);
      raw.exec('COMMIT');return {previousVersion,version:SCHEMA_VERSION,...(backupPath?{backupPath}:{}),applied:[]};
    }
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
    if (actualVersion < 3) {
      raw.exec(`ALTER TABLE cache_entries ADD COLUMN kind TEXT NOT NULL DEFAULT 'static-analysis';
        ALTER TABLE cache_entries ADD COLUMN ref_count INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE task_resources ADD COLUMN peak_child_rss_mb REAL NOT NULL DEFAULT 0;
        ALTER TABLE task_resources ADD COLUMN peak_cpu_percent REAL NOT NULL DEFAULT 0;
        CREATE TABLE IF NOT EXISTS backups (
          id TEXT PRIMARY KEY, created_at TEXT NOT NULL, kind TEXT NOT NULL,
          size_bytes INTEGER NOT NULL, file_count INTEGER NOT NULL, sha256 TEXT NOT NULL,
          database_sha256 TEXT NOT NULL, schema_version INTEGER NOT NULL,
          status TEXT NOT NULL, backup_path TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS backup_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT, backup_id TEXT, action TEXT NOT NULL,
          details_json TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS agent_runs (
          id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          role TEXT NOT NULL, status TEXT NOT NULL, iteration INTEGER NOT NULL DEFAULT 0,
          input_json TEXT NOT NULL, output_json TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`);
      addColumnIfMissing(raw, 'tasks', 'lease_owner', 'TEXT');
      addColumnIfMissing(raw, 'tasks', 'lease_expires_at', 'TEXT');
      addColumnIfMissing(raw, 'tasks', 'heartbeat_at', 'TEXT');
      raw.exec('CREATE INDEX IF NOT EXISTS idx_tasks_lease ON tasks(status,lease_expires_at,created_at)');
      raw.prepare('INSERT OR REPLACE INTO schema_migrations (version,applied_at,backup_path) VALUES (?,?,?)').run(3,new Date().toISOString(),backupPath??null);
      applied.push(3);
    }
    if (actualVersion < 4) {
      raw.exec(SCHEMA_4);
      addColumnIfMissing(raw, 'analysis_plans', 'upload_id', 'TEXT');
      addColumnIfMissing(raw, 'analysis_plans', 'upload_sha256', 'TEXT');
      raw.prepare('INSERT OR REPLACE INTO schema_migrations (version,applied_at,backup_path) VALUES (?,?,?)').run(4,new Date().toISOString(),backupPath??null);
      applied.push(4);
    }
    if (actualVersion < 5) {
      addColumnIfMissing(raw, 'analysis_plans', 'upload_id', 'TEXT');
      addColumnIfMissing(raw, 'analysis_plans', 'upload_sha256', 'TEXT');
      raw.exec(SCHEMA_5);
      addColumnIfMissing(raw, 'game_files', 'ctime_ms', 'REAL');
      addColumnIfMissing(raw, 'game_files', 'dev', 'TEXT');
      addColumnIfMissing(raw, 'game_files', 'ino', 'TEXT');
      raw.prepare('INSERT OR REPLACE INTO schema_migrations (version,applied_at,backup_path) VALUES (?,?,?)').run(5,new Date().toISOString(),backupPath??null);
      applied.push(5);
    }
    assertSchema5(raw);
    raw.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
    raw.exec('COMMIT');
  } catch (error) {
    try { raw.exec('ROLLBACK'); } catch { /* preserve original migration error */ }
    throw migrationFailure(backupPath, error);
  }
  return { previousVersion, version: SCHEMA_VERSION, ...(backupPath?{backupPath}:{}), applied };
}

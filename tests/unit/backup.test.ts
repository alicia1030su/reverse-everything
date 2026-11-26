import { DatabaseSync } from 'node:sqlite';
import { appendFile, mkdir, mkdtemp, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackupService, Database, migrateDatabase } from '@reverse/workflow';

const dirs: string[] = [];
const databases: Database[] = [];
afterEach(async () => {
  for (const db of databases.splice(0)) { try { db.close(); } catch { /* already closed by a test */ } }
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function temp(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 're-v003-backup-'));
  dirs.push(dir);
  return dir;
}
function open(file: string): Database {
  const db = new Database(file);
  databases.push(db);
  return db;
}

const V2_SCHEMA = `
PRAGMA user_version=2;
CREATE TABLE projects (id TEXT PRIMARY KEY,name TEXT NOT NULL,kind TEXT NOT NULL,target TEXT NOT NULL DEFAULT '',authorization_confirmed INTEGER NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE uploads (id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,name TEXT NOT NULL,stored_name TEXT NOT NULL,mime TEXT NOT NULL,size INTEGER NOT NULL,sha256 TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE tasks (id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,adapter TEXT NOT NULL,status TEXT NOT NULL,current_stage TEXT NOT NULL,progress INTEGER NOT NULL DEFAULT 0,current_tool TEXT,attempt INTEGER NOT NULL DEFAULT 0,input_hash TEXT NOT NULL,options_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,started_at TEXT,ended_at TEXT,error TEXT,pause_requested INTEGER NOT NULL DEFAULT 0,cancel_requested INTEGER NOT NULL DEFAULT 0);
CREATE TABLE stages (task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,name TEXT NOT NULL,status TEXT NOT NULL,attempt INTEGER NOT NULL DEFAULT 0,started_at TEXT,ended_at TEXT,error TEXT,cache_key TEXT,output_json TEXT,PRIMARY KEY(task_id,name));
CREATE TABLE evidence (id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,kind TEXT NOT NULL,title TEXT NOT NULL,source TEXT NOT NULL,locator TEXT NOT NULL,content_json TEXT NOT NULL,sha256 TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE findings (id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,title TEXT NOT NULL,category TEXT NOT NULL,severity TEXT NOT NULL,confidence REAL NOT NULL,evidence_ids_json TEXT NOT NULL,details TEXT NOT NULL,recommendation TEXT NOT NULL,status TEXT NOT NULL);
CREATE TABLE logs (id INTEGER PRIMARY KEY AUTOINCREMENT,task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,level TEXT NOT NULL,message TEXT NOT NULL,tool TEXT,created_at TEXT NOT NULL);
CREATE TABLE artifacts (id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,name TEXT NOT NULL,stored_path TEXT NOT NULL,size INTEGER NOT NULL,sha256 TEXT NOT NULL,mime TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(task_id,name));
CREATE TABLE settings (key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT,task_id TEXT,type TEXT NOT NULL,payload_json TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL,backup_path TEXT);
CREATE TABLE cache_entries (key TEXT PRIMARY KEY,scope TEXT NOT NULL,project_id TEXT,adapter TEXT NOT NULL,stage TEXT NOT NULL,size_bytes INTEGER NOT NULL,payload_path TEXT NOT NULL,payload_sha256 TEXT NOT NULL,hits INTEGER NOT NULL DEFAULT 0,misses INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,last_accessed_at TEXT NOT NULL,expires_at TEXT);
CREATE TABLE cache_stats (id INTEGER PRIMARY KEY CHECK(id=1),hits INTEGER NOT NULL DEFAULT 0,misses INTEGER NOT NULL DEFAULT 0,writes INTEGER NOT NULL DEFAULT 0,corrupt INTEGER NOT NULL DEFAULT 0,evictions INTEGER NOT NULL DEFAULT 0);
CREATE TABLE resource_samples (id INTEGER PRIMARY KEY AUTOINCREMENT,source TEXT NOT NULL,snapshot_json TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE task_resources (task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,peak_tree_rss_mb REAL NOT NULL DEFAULT 0,peak_heap_mb REAL NOT NULL DEFAULT 0,artifact_bytes INTEGER NOT NULL DEFAULT 0,started_at TEXT NOT NULL,ended_at TEXT);
CREATE TABLE circuit_events (id INTEGER PRIMARY KEY AUTOINCREMENT,task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,level TEXT NOT NULL,reason TEXT NOT NULL,snapshot_json TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE retention_events (id INTEGER PRIMARY KEY AUTOINCREMENT,category TEXT NOT NULL,item_path TEXT NOT NULL,reason TEXT NOT NULL,size_bytes INTEGER NOT NULL,created_at TEXT NOT NULL);
INSERT INTO schema_migrations (version,applied_at) VALUES (1,'2026-01-01T00:00:00.000Z'),(2,'2026-01-02T00:00:00.000Z');
INSERT INTO cache_stats (id) VALUES (1);
`;

function createV2(file: string): void {
  const raw = new DatabaseSync(file);
  raw.exec(V2_SCHEMA);
  raw.prepare('INSERT INTO projects VALUES (?,?,?,?,?,?)').run('p-old','legacy','software','legacy-target',1,'2026-01-01T00:00:00.000Z');
  raw.prepare('INSERT INTO tasks (id,project_id,adapter,status,current_stage,input_hash,options_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('t-old','p-old','file','COMPLETED','COMPLETED','b'.repeat(64),'{}','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
  raw.prepare('INSERT INTO cache_entries (key,scope,project_id,adapter,stage,size_bytes,payload_path,payload_sha256,created_at,last_accessed_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run('cache-old','project','p-old','file','ANALYZE',3,'cache/old.json','c'.repeat(64),'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
  raw.prepare('INSERT INTO task_resources (task_id,started_at) VALUES (?,?)').run('t-old','2026-01-01T00:00:00.000Z');
  raw.close();
}

async function setup() {
  const dir = await temp();
  const file = path.join(dir, 'reverse-everything.sqlite');
  const db = open(file);
  const project = db.project({ name: 'backup-project', kind: 'software', authorizationConfirmed: true });
  return { dir, file, db, project, service: new BackupService(db, dir) };
}

describe('schema 4 plan binding migration integrity', () => {
  it('adds missing upload binding columns to an existing schema 4 database', async () => {
    const dir = await temp(); const file = path.join(dir, 'reverse-everything.sqlite'); const initial = open(file); initial.close();
    const raw = new DatabaseSync(file); raw.exec('ALTER TABLE analysis_plans DROP COLUMN upload_id; ALTER TABLE analysis_plans DROP COLUMN upload_sha256; PRAGMA user_version=4;'); raw.close();
    const migrated = open(file);
    const columns = (migrated.raw.prepare('PRAGMA table_info(analysis_plans)').all() as {name:string}[]).map(column => column.name);
    expect(columns).toEqual(expect.arrayContaining(['upload_id', 'upload_sha256']));
    expect(Number((migrated.raw.prepare('PRAGMA user_version').get() as {user_version:number}).user_version)).toBe(4);
  });
});

describe('schema 3 migration integrity', () => {
  it('upgrades a real v0.0.2 schema and preserves rows with safe column defaults', async () => {
    const dir = await temp();
    const file = path.join(dir, 'reverse-everything.sqlite');
    createV2(file);
    const db = open(file);
    expect(db.migration.previousVersion).toBe(2);
    expect(db.migration.applied).toEqual([3,4]);
    expect(db.getTask('t-old')?.inputHash).toBe('b'.repeat(64));
    expect(db.raw.prepare("SELECT kind,ref_count FROM cache_entries WHERE key='cache-old'").get()).toEqual({ kind: 'static-analysis', ref_count: 0 });
    expect(db.raw.prepare("SELECT peak_child_rss_mb,peak_cpu_percent FROM task_resources WHERE task_id='t-old'").get()).toEqual({ peak_child_rss_mb: 0, peak_cpu_percent: 0 });
    expect(db.raw.prepare("SELECT lease_owner,lease_expires_at,heartbeat_at FROM tasks WHERE id='t-old'").get()).toEqual({ lease_owner: null, lease_expires_at: null, heartbeat_at: null });
    expect((db.raw.prepare('PRAGMA index_info(idx_tasks_lease)').all() as {name:string}[]).map(column => column.name)).toEqual(['status','lease_expires_at','created_at']);
    expect(Number((db.raw.prepare('PRAGMA user_version').get() as {user_version:number}).user_version)).toBe(4);
    expect(db.migration.backupPath).toBeTruthy();
    expect(await readdir(path.join(dir, 'backups'))).toHaveLength(1);
  });

  it('upgrades schema 3 analysis plans with nullable upload binding columns', async () => {
    const dir = await temp(); const file = path.join(dir, 'reverse-everything.sqlite'); createV2(file);
    const raw = new DatabaseSync(file); migrateDatabase(raw, file); raw.exec('DROP TABLE analysis_plans; PRAGMA user_version=3;'); raw.close();
    const db = open(file);
    expect(db.migration).toMatchObject({ previousVersion: 3, version: 4, applied: [4] });
    const columns = db.raw.prepare("SELECT name FROM pragma_table_info('analysis_plans')").all() as {name:string}[];
    expect(columns.map(column => column.name)).toEqual(expect.arrayContaining(['upload_id', 'upload_sha256']));
    expect(Number((db.raw.prepare('PRAGMA user_version').get() as {user_version:number}).user_version)).toBe(4);
  });

  it('rolls back an interrupted migration, retains the original database and redacts trigger errors', async () => {
    const dir = await temp();
    const file = path.join(dir, 'reverse-everything.sqlite');
    createV2(file);
    const raw = new DatabaseSync(file);
    raw.exec(`CREATE TRIGGER fail_v3 BEFORE INSERT ON schema_migrations WHEN NEW.version=3 BEGIN SELECT RAISE(ABORT,'api_key=super-secret-value-123456'); END;`);
    let failure: unknown;
    try { migrateDatabase(raw, file); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toMatch(/Database migration failed/);
    expect(String(failure)).toContain('api_key=[REDACTED]');
    expect(String(failure)).not.toContain('super-secret-value-123456');
    expect(Number((raw.prepare('PRAGMA user_version').get() as {user_version:number}).user_version)).toBe(2);
    expect((raw.prepare("SELECT name FROM pragma_table_info('cache_entries') WHERE name='kind'").all())).toEqual([]);
    expect(raw.prepare("SELECT id FROM tasks WHERE id='t-old'").get()).toEqual({ id: 't-old' });
    const backups = await readdir(path.join(dir, 'backups'));
    expect(backups).toHaveLength(1);
    const snapshot = new DatabaseSync(path.join(dir, 'backups', backups[0]!), { readOnly: true });
    expect(snapshot.prepare('PRAGMA quick_check').get()).toEqual({ quick_check: 'ok' });
    expect(snapshot.prepare("SELECT id FROM tasks WHERE id='t-old'").get()).toEqual({ id: 't-old' });
    snapshot.close();
    raw.close();
  });

  it('rejects schema 3 databases missing a required table', async () => {
    const dir = await temp();
    const file = path.join(dir, 'reverse-everything.sqlite');
    const first = open(file);
    first.close();
    const raw = new DatabaseSync(file);
    raw.exec('DROP TABLE backups');
    expect(() => migrateDatabase(raw, file)).toThrow(/missing table backups/);
    raw.close();
  });

  it('rejects schema 3 databases missing a required column', async () => {
    const dir = await temp();
    const file = path.join(dir, 'reverse-everything.sqlite');
    const first = open(file);
    first.close();
    const raw = new DatabaseSync(file);
    raw.exec('ALTER TABLE cache_entries DROP COLUMN ref_count');
    expect(() => migrateDatabase(raw, file)).toThrow(/cache_entries\.ref_count/);
    raw.close();
  });

  it('rejects schema 3 databases missing the worker lease index', async () => {
    const dir = await temp();
    const file = path.join(dir, 'reverse-everything.sqlite');
    const first = open(file);
    first.close();
    const raw = new DatabaseSync(file);
    raw.exec('DROP INDEX idx_tasks_lease');
    expect(() => migrateDatabase(raw, file)).toThrow(/missing index idx_tasks_lease/);
    raw.close();
  });
});

describe('BackupService', () => {
  it('creates, lists and verifies an online SQLite snapshot with audit events', async () => {
    const { db, project, service } = await setup();
    db.createTask(project.id, 'file', { adapter: 'file' }, 'a'.repeat(64));
    const info = await service.create();
    expect(info.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(info.databaseSha256).toBe(info.sha256);
    expect(info.sizeBytes).toBeGreaterThan(0);
    expect(service.list().map(item => item.id)).toEqual([info.id]);
    expect(await service.verify(info.id)).toMatchObject({ valid: true, issues: [] });
    expect(service.events().some(event => event.action === 'backup.created')).toBe(true);
  });

  it('rejects a backup at the configured count limit without creating an orphan file', async () => {
    const { dir, db, service } = await setup();
    const limited = new BackupService(db, dir, { maxBackups: 1 });
    const first = await limited.create();
    const filesBefore = await readdir(path.join(dir, 'backups'));
    await expect(limited.create()).rejects.toThrow(/Backup count limit exceeded/);
    expect(limited.list().map(backup => backup.id)).toEqual([first.id]);
    expect(await readdir(path.join(dir, 'backups'))).toEqual(filesBefore);
    expect(service.list().map(backup => backup.id)).toEqual([first.id]);
  });

  it('serializes concurrent creates so the count limit cannot be bypassed', async () => {
    const { dir, db } = await setup();
    const limited = new BackupService(db, dir, { maxBackups: 1 });
    const results = await Promise.allSettled([limited.create(), limited.create()]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(result => result.status === 'rejected');
    expect(rejected?.status === 'rejected' ? String(rejected.reason) : '').toMatch(/Backup count limit exceeded/);
    expect(limited.list()).toHaveLength(1);
    expect(await readdir(path.join(dir, 'backups'))).toHaveLength(2);
  });

  it('rejects a backup over the configured total byte limit and removes its snapshot', async () => {
    const { dir, db, service } = await setup();
    const first = await service.create();
    const filesBefore = await readdir(path.join(dir, 'backups'));
    const limited = new BackupService(db, dir, { maxTotalBytes: first.sizeBytes });
    await expect(limited.create()).rejects.toThrow(/Backup total byte limit exceeded/);
    expect(limited.list().map(backup => backup.id)).toEqual([first.id]);
    expect(await readdir(path.join(dir, 'backups'))).toEqual(filesBefore);
  });

  it('prunes expired backups while always retaining the most recent copies', async () => {
    const { dir, db, service } = await setup();
    const created = [await service.create(), await service.create(), await service.create()];
    for (const backup of created) db.raw.prepare('UPDATE backups SET created_at=? WHERE id=?').run('2020-01-01T00:00:00.000Z', backup.id);
    const result = await service.prune({ maxAgeDays: 1, keepRecent: 1 });
    expect(result.deleted.map(backup => backup.id)).toEqual([created[0]!.id, created[1]!.id]);
    expect(result.kept.map(backup => backup.id)).toEqual([created[2]!.id]);
    expect(service.list().map(backup => backup.id)).toEqual([created[2]!.id]);
    const files = await readdir(path.join(dir, 'backups'));
    expect(files).toContain(path.basename(created[2]!.path));
    expect(files).not.toContain(path.basename(created[0]!.path));
    expect(files).not.toContain(path.basename(created[1]!.path));
    expect(service.events().filter(event => event.action === 'backup.pruned')).toHaveLength(2);
  });

  it('never prunes the last known good backup even when newer backups are corrupt', async () => {
    const { db, service } = await setup();
    const created = [await service.create(), await service.create(), await service.create()];
    for (const backup of created) db.raw.prepare('UPDATE backups SET created_at=? WHERE id=?').run('2020-01-01T00:00:00.000Z', backup.id);
    db.raw.prepare("UPDATE backups SET status='corrupt' WHERE id=?").run(created[2]!.id);
    const result = await service.prune({ maxAgeDays: 1, keepRecent: 1 });
    expect(result.deleted.map(backup => backup.id)).toEqual([created[0]!.id]);
    expect(result.kept.map(backup => backup.id)).toEqual([created[2]!.id, created[1]!.id]);
  });

  it('retains backups with SQLite sidecars that may still be in use', async () => {
    const { db, service } = await setup();
    const older = await service.create();
    await service.create();
    db.raw.prepare('UPDATE backups SET created_at=? WHERE id=?').run('2020-01-01T00:00:00.000Z', older.id);
    const sidecar = `${older.path}-wal`;
    await writeFile(sidecar, 'in-use');
    const retained = await service.prune({ maxAgeDays: 1, keepRecent: 0 });
    expect(retained.deleted).toEqual([]);
    expect(retained.kept.map(backup => backup.id)).toContain(older.id);
    await rm(sidecar);
    const pruned = await service.prune({ maxAgeDays: 1, keepRecent: 0 });
    expect(pruned.deleted.map(backup => backup.id)).toEqual([older.id]);
  });

  it('queues pruning until an active restore finishes so the backup cannot be deleted mid-restore', async () => {
    const { dir, db, service } = await setup();
    const older = await service.create();
    await service.create();
    db.raw.prepare('UPDATE backups SET created_at=? WHERE id=?').run('2020-01-01T00:00:00.000Z', older.id);
    let entered!: () => void;
    let release!: () => void;
    const previewEntered = new Promise<void>(resolve => { entered = resolve; });
    const previewRelease = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(service, 'preview').mockImplementationOnce(async () => {
      entered();
      await previewRelease;
      throw new Error('forced preview failure');
    });
    const restoring = service.restore(older.id, dir);
    await previewEntered;
    let pruneSettled = false;
    const pruning = service.prune({ maxAgeDays: 1, keepRecent: 0 }).then(result => {
      pruneSettled = true;
      return result;
    });
    await Promise.resolve();
    expect(pruneSettled).toBe(false);
    expect(service.list().map(backup => backup.id)).toContain(older.id);
    release();
    await expect(restoring).rejects.toThrow(/forced preview failure/);
    const result = await pruning;
    expect(result.deleted.map(backup => backup.id)).toEqual([older.id]);
  });

  it('restores more than 200 tasks into an isolated directory and passes quick_check', async () => {
    const { dir, db, project, service } = await setup();
    for (let index = 0; index < 205; index++) db.createTask(project.id, 'file', { adapter: 'file' }, String(index).padStart(64, '0'));
    const info = await service.create();
    db.raw.exec('DELETE FROM projects');
    expect(db.allTasks()).toHaveLength(0);
    const target = path.join(dir, 'isolated-restore');
    const preview = await service.preview(info.id, target);
    expect(preview.files[0]?.sizeBytes).toBe(info.sizeBytes);
    expect(preview.warnings.length).toBeGreaterThan(0);
    const restored = await service.restore(info.id, target);
    expect(await realpath(restored.targetDir)).toBe(await realpath(target));
    const restoredDb = open(restored.files[0]!.path);
    expect(restoredDb.allTasks()).toHaveLength(205);
    expect(restoredDb.projectTasks(project.id)).toHaveLength(205);
    expect(restoredDb.raw.prepare('PRAGMA quick_check').get()).toEqual({ quick_check: 'ok' });
    expect(restoredDb.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('atomically switches the current database and keeps the backup registered', async () => {
    const { dir, db, project, service } = await setup();
    const original = db.createTask(project.id, 'file', { adapter: 'file' }, '1'.repeat(64));
    db.raw.prepare("UPDATE tasks SET status='COMPLETED' WHERE id=?").run(original.id);
    const info = await service.create();
    db.createTask(project.id, 'file', { adapter: 'file' }, '2'.repeat(64));
    db.raw.prepare("UPDATE tasks SET status='COMPLETED'").run();
    expect(db.allTasks()).toHaveLength(2);
    expect(db.raw.prepare("SELECT id,status FROM tasks WHERE status IN ('QUEUED','RUNNING','PAUSED')").all()).toEqual([]);
    await service.restore(info.id, dir);
    expect(db.allTasks().map(task => task.id)).toEqual([original.id]);
    expect(db.raw.prepare('PRAGMA quick_check').get()).toEqual({ quick_check: 'ok' });
    expect(service.list().map(backup => backup.id)).toContain(info.id);
    expect(service.events().some(event => event.action === 'restore.completed')).toBe(true);
  });

  it('rolls back the active database when post-switch restore auditing fails', async () => {
    const { dir, db, project, service } = await setup();
    db.raw.exec("CREATE TRIGGER fail_restore BEFORE INSERT ON backup_events WHEN NEW.action='restore.completed' BEGIN SELECT RAISE(ABORT,'forced restore audit failure'); END;");
    const info = await service.create();
    const afterBackup = db.createTask(project.id, 'file', { adapter: 'file' }, '4'.repeat(64));
    db.raw.prepare("UPDATE tasks SET status='COMPLETED' WHERE id=?").run(afterBackup.id);
    const tasksBefore = db.allTasks().map(task => task.id);
    await expect(service.restore(info.id, dir)).rejects.toThrow(/forced restore audit failure/);
    expect(db.allTasks().map(task => task.id)).toEqual(tasksBefore);
    expect(db.getTask(afterBackup.id)?.inputHash).toBe('4'.repeat(64));
    expect(db.raw.prepare('PRAGMA quick_check').get()).toEqual({ quick_check: 'ok' });
    expect(service.events().some(event => event.action === 'restore.failed')).toBe(true);
    expect((await readdir(dir)).filter(name => name.startsWith('.restore-rollback-'))).toEqual([]);
  });

  it('preserves the restore failure and reports a failed restore audit', async () => {
    const { dir, db, service } = await setup();
    const info = await service.create();
    const auditable = service as unknown as { audit(backupId: string | null, action: string, details?: Record<string, unknown>): void };
    const audit = auditable.audit.bind(service);
    let calls = 0;
    vi.spyOn(auditable, 'audit').mockImplementation((backupId, action, details) => {
      calls++;
      if (calls === 2) throw new Error('forced audit failure');
      audit(backupId, action, details);
    });
    vi.spyOn(service, 'preview').mockRejectedValueOnce(new Error('forced preview failure'));
    await expect(service.restore(info.id, dir)).rejects.toThrow(/forced preview failure.*restore\.failed audit failed: forced audit failure/s);
    expect(service.events().filter(event => event.action === 'restore.failed')).toEqual([]);
    expect(db.raw.prepare('PRAGMA quick_check').get()).toEqual({ quick_check: 'ok' });
  });

  it('audits restore failure through a fallback connection when reopening fails', async () => {
    const { dir, file, db, service } = await setup();
    const info = await service.create();
    vi.spyOn(db, 'reopen').mockImplementation(() => { throw new Error('forced reopen failure'); });
    await expect(service.restore(info.id, dir)).rejects.toThrow(/forced reopen failure.*Reopen failed: forced reopen failure/s);
    const audited = open(file);
    const event = audited.raw.prepare("SELECT details_json FROM backup_events WHERE backup_id=? AND action='restore.failed'").get(info.id) as {details_json:string};
    const details = JSON.parse(event.details_json) as { reason: string; recoveryDiagnostics: string[] };
    expect(details.reason).toBe('forced reopen failure');
    expect(details.recoveryDiagnostics).toContain('Reopen failed: forced reopen failure');
    expect(audited.raw.prepare('PRAGMA quick_check').get()).toEqual({ quick_check: 'ok' });
  });

  it('reports rollback failures and retains the previous database for recovery', async () => {
    const { dir, service } = await setup();
    const info = await service.create();
    let preservedFile = '';
    vi.spyOn(service as unknown as { registerRestoredBackup(): Promise<void> }, 'registerRestoredBackup')
      .mockImplementationOnce(async () => {
        const rollbackDir = (await readdir(dir)).find(name => name.startsWith('.restore-rollback-'))!;
        preservedFile = path.join(dir, rollbackDir, 'previous-preserved.sqlite');
        await rename(path.join(dir, rollbackDir, 'previous.sqlite'), preservedFile);
        throw new Error('forced registration failure');
      });
    await expect(service.restore(info.id, dir)).rejects.toThrow(/Rollback failed/);
    const preserved = open(preservedFile);
    expect(preserved.raw.prepare('PRAGMA quick_check').get()).toEqual({ quick_check: 'ok' });
    expect(preserved.raw.prepare('SELECT COUNT(*) AS count FROM backups').get()).toEqual({ count: 1 });
  });

  it('rejects a hash-damaged backup without replacing the existing database', async () => {
    const { dir, db, project, service } = await setup();
    const task = db.createTask(project.id, 'file', { adapter: 'file' }, '3'.repeat(64));
    db.raw.prepare("UPDATE tasks SET status='COMPLETED' WHERE id=?").run(task.id);
    const info = await service.create();
    await appendFile(info.path, Buffer.from([0, 1, 2, 3]));
    await expect(service.preview(info.id, path.join(dir, 'corrupt-preview'))).rejects.toThrow(/SHA256 or size mismatch/);
    const verification = await service.verify(info.id);
    expect(verification.valid).toBe(false);
    expect(verification.issues).toContain('Backup SHA256 mismatch');
    await expect(service.restore(info.id, dir)).rejects.toThrow(/Backup is marked corrupt/);
    expect(db.getTask(task.id)?.inputHash).toBe('3'.repeat(64));
    expect(db.raw.prepare('PRAGMA quick_check').get()).toEqual({ quick_check: 'ok' });
  });

  it('refuses non-empty preview targets and dangerous backup paths', async () => {
    const { dir, db, service } = await setup();
    const info = await service.create();
    const target = path.join(dir, 'not-empty');
    await mkdir(target);
    const existing = path.join(target, 'keep.txt');
    await writeFile(existing, 'keep');
    await expect(service.preview(info.id, target)).rejects.toThrow(/must be empty/);
    expect(await readdir(target)).toEqual(['keep.txt']);
    db.raw.prepare('UPDATE backups SET backup_path=? WHERE id=?').run(path.join(dir, 'outside.sqlite'), info.id);
    await expect(service.verify(info.id)).rejects.toThrow(/Unsafe backup path/);
    expect(db.raw.prepare('PRAGMA quick_check').get()).toEqual({ quick_check: 'ok' });
  });

  it('refuses a symbolic-link backup directory', async () => {
    const { dir, service } = await setup();
    const info = await service.create();
    const backupDir = path.join(dir, 'backups');
    const moved = path.join(dir, 'backups-real');
    await rename(backupDir, moved);
    await symlink(moved, backupDir, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(service.verify(info.id)).rejects.toThrow(/symbolic link/);
  });

  it('filters task events before applying the page limit and retains the legacy overload', async () => {
    const db = open(':memory:');
    for (let index = 0; index < 250; index++) db.addEvent('other', 'other.event', { index });
    db.addEvent('wanted', 'wanted.event', { kept: true });
    expect(db.eventsAfter('wanted', 0, 10).map(event => event.type)).toEqual(['wanted.event']);
    expect(db.eventsAfter(0, 10)).toHaveLength(10);
  });
});

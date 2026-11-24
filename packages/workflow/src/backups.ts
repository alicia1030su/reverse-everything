import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream, existsSync } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_VERSION, type BackupInfo, type BackupPreview } from '@reverse/contracts';
import type { Database } from './database.js';
import { assertSchema3 } from './migrations.js';

export interface BackupVerification { backup: BackupInfo; valid: boolean; issues: string[] }
export interface BackupEvent { id: number; backupId: string | null; action: string; details: unknown; createdAt: string }
export interface BackupOptions { maxBackups?: number; maxTotalBytes?: number }
export interface BackupPruneOptions { maxAgeDays?: number; keepRecent?: number }
export interface BackupPruneResult { deleted: BackupInfo[]; kept: BackupInfo[]; freedBytes: number }

type PathKind = 'any' | 'file' | 'directory';
const ECOSYSTEM_SETTING = 'backup_ecosystem_id';
const SIDECAR_SUFFIXES = ['-wal', '-shm', '-journal'] as const;
const DEFAULT_MAX_BACKUPS = 10;
const DEFAULT_MAX_TOTAL_BYTES = 5 * 1024 * 1024 * 1024;
const DEFAULT_PRUNE_MAX_AGE_DAYS = 30;
const DEFAULT_PRUNE_KEEP_RECENT = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

function missing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase() : path.resolve(left) === path.resolve(right);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`);
  return value;
}

async function inspectPath(value: string, kind: PathKind = 'any', allowMissing = false): Promise<string> {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || !path.isAbsolute(value)) throw new Error('Unsafe path: an absolute path is required');
  const resolved = path.resolve(value);
  const parsed = path.parse(resolved);
  if (resolved === parsed.root) throw new Error('Unsafe path: filesystem root is not allowed');
  const segments = path.relative(parsed.root, resolved).split(path.sep).filter(Boolean);
  let current = parsed.root;
  let sawMissing = false;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (!missing(error) || !allowMissing) throw error;
      sawMissing = true;
      break;
    }
    if (info.isSymbolicLink()) throw new Error(`Unsafe path: symbolic link at ${current}`);
    if (index < segments.length - 1 && !info.isDirectory()) throw new Error(`Unsafe path: non-directory parent at ${current}`);
    if (index === segments.length - 1) {
      if (kind === 'file' && !info.isFile()) throw new Error(`Unsafe path: not a regular file at ${current}`);
      if (kind === 'directory' && !info.isDirectory()) throw new Error(`Unsafe path: not a directory at ${current}`);
    }
  }
  if (sawMissing) {
    if (!allowMissing) throw new Error('Path does not exist');
    return resolved;
  }
  return realpath(resolved);
}

async function ensureDirectory(value: string): Promise<string> {
  const resolved = path.resolve(value);
  await inspectPath(resolved, 'directory', true);
  await mkdir(resolved, { recursive: true });
  return inspectPath(resolved, 'directory');
}

async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function inspectDatabase(file: string, ecosystemId: string, integrity: boolean): string[] {
  let raw: DatabaseSync | undefined;
  const issues: string[] = [];
  try {
    raw = new DatabaseSync(file, { readOnly: true, enableForeignKeyConstraints: true });
    raw.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=10000;');
    const version = Number((raw.prepare('PRAGMA user_version').get() as {user_version:number}).user_version);
    if (version !== SCHEMA_VERSION) issues.push(`Unrecognized schema version ${version}`);
    try { assertSchema3(raw); } catch (error) { issues.push(error instanceof Error ? error.message : 'Schema integrity check failed'); }
    try {
      const row = raw.prepare('SELECT value FROM settings WHERE key=?').get(ECOSYSTEM_SETTING) as {value:string}|undefined;
      if (!row || row.value !== ecosystemId) issues.push('Backup belongs to a different database ecosystem');
    } catch { issues.push('Backup ecosystem identity is missing'); }
    if (integrity) {
      try {
        const check = raw.prepare('PRAGMA quick_check').all() as {quick_check:string}[];
        if (check.length !== 1 || check[0]?.quick_check !== 'ok') issues.push('SQLite quick_check failed');
      } catch { issues.push('SQLite quick_check could not be completed'); }
      try {
        if ((raw.prepare('PRAGMA foreign_key_check').all() as unknown[]).length) issues.push('SQLite foreign_key_check failed');
      } catch { issues.push('SQLite foreign_key_check could not be completed'); }
    }
  } catch {
    throw new Error('Backup database cannot be opened as SQLite');
  } finally {
    raw?.close();
  }
  return issues;
}

export class BackupService {
  private readonly root: string;
  private readonly maxBackups: number;
  private readonly maxTotalBytes: number;
  private readonly restoringBackupIds = new Set<string>();
  private mutationQueue: Promise<void> = Promise.resolve();
  constructor(private readonly db: Database, dataDir: string, options: BackupOptions = {}) {
    this.root = path.resolve(dataDir);
    this.maxBackups = positiveInteger(options.maxBackups ?? DEFAULT_MAX_BACKUPS, 'maxBackups');
    this.maxTotalBytes = positiveInteger(options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES, 'maxTotalBytes');
  }

  private ecosystemId(create = false): string {
    const current = this.db.settings()[ECOSYSTEM_SETTING];
    if (current) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(current)) throw new Error('Database ecosystem identity is invalid');
      return current;
    }
    if (!create) throw new Error('Database ecosystem identity is missing');
    const id = randomUUID();
    this.db.setSetting(ECOSYSTEM_SETTING, id);
    return id;
  }

  private async backupDirectory(create = false): Promise<string> {
    const root = await ensureDirectory(this.root);
    const directory = path.join(root, 'backups');
    return create ? ensureDirectory(directory) : inspectPath(directory, 'directory');
  }

  private databaseName(): string {
    return this.db.file === ':memory:' ? 'reverse-everything.sqlite' : path.basename(this.db.file);
  }

  private async validateSourceDatabase(): Promise<void> {
    if (this.db.file === ':memory:') return;
    const root = await ensureDirectory(this.root);
    const file = await inspectPath(this.db.file, 'file');
    if (!samePath(path.dirname(file), root)) throw new Error('Unsafe database path: database must be directly inside dataDir');
  }

  private mapBackup(row: Record<string, unknown>): BackupInfo {
    const kind = String(row.kind);
    const status = String(row.status);
    if (kind !== 'manual' && kind !== 'pre-migration' && kind !== 'scheduled') throw new Error('Backup metadata is invalid');
    if (status !== 'complete' && status !== 'corrupt') throw new Error('Backup metadata is invalid');
    const sha256 = String(row.sha256);
    const databaseSha256 = String(row.database_sha256);
    if (!/^[0-9a-f]{64}$/i.test(sha256) || !/^[0-9a-f]{64}$/i.test(databaseSha256)) throw new Error('Backup metadata is invalid');
    if (Number(row.schema_version) !== SCHEMA_VERSION || Number(row.file_count) !== 1 || Number(row.size_bytes) < 0) throw new Error('Backup metadata is invalid');
    return {
      id: String(row.id), createdAt: String(row.created_at), kind,
      sizeBytes: Number(row.size_bytes), fileCount: Number(row.file_count), sha256, databaseSha256,
      schemaVersion: Number(row.schema_version), status, path: String(row.backup_path)
    };
  }

  private backupRow(id: string): Record<string, unknown> {
    const row = this.db.raw.prepare('SELECT * FROM backups WHERE id=?').get(id) as Record<string, unknown>|undefined;
    if (!row) throw new Error('Backup not found');
    return row;
  }

  private async getBackup(id: string): Promise<BackupInfo> {
    const info = this.mapBackup(this.backupRow(id));
    const directory = await this.backupDirectory();
    if (!path.isAbsolute(info.path) || path.dirname(path.resolve(info.path)) !== directory || path.extname(info.path) !== '.sqlite') throw new Error('Unsafe backup path');
    const file = await inspectPath(info.path, 'file');
    if (!samePath(path.dirname(file), directory)) throw new Error('Unsafe backup path');
    return { ...info, path: file };
  }

  private audit(backupId: string | null, action: string, details: Record<string, unknown> = {}): void {
    this.db.raw.prepare('INSERT INTO backup_events (backup_id,action,details_json,created_at) VALUES (?,?,?,?)')
      .run(backupId, action, JSON.stringify(details), new Date().toISOString());
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation);
    this.mutationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private auditRestoreFailure(id: string, targetDir: string, reason: string, diagnostics: string[]): void {
    const insert = 'INSERT INTO backup_events (backup_id,action,details_json,created_at) VALUES (?,?,?,?)';
    try {
      this.audit(id, 'restore.failed', { targetDir, reason, recoveryDiagnostics: diagnostics });
      return;
    } catch (error) {
      diagnostics.push(`restore.failed audit failed: ${errorMessage(error)}`);
    }
    if (this.db.raw.isOpen || this.db.file === ':memory:' || !existsSync(this.db.file)) return;
    let raw: DatabaseSync | undefined;
    try {
      raw = new DatabaseSync(this.db.file);
      raw.prepare(insert).run(id, 'restore.failed', JSON.stringify({ targetDir, reason, recoveryDiagnostics: diagnostics }), new Date().toISOString());
    } catch (error) {
      diagnostics.push(`restore.failed fallback audit failed: ${errorMessage(error)}`);
    } finally {
      try { raw?.close(); } catch (error) { diagnostics.push(`restore.failed fallback audit close failed: ${errorMessage(error)}`); }
    }
  }

  async create(kind: BackupInfo['kind'] = 'manual'): Promise<BackupInfo> {
    return this.serialize(() => this.createSnapshot(kind));
  }

  private async createSnapshot(kind: BackupInfo['kind']): Promise<BackupInfo> {
    if (kind !== 'manual' && kind !== 'pre-migration' && kind !== 'scheduled') throw new Error('Invalid backup kind');
    await this.validateSourceDatabase();
    const existing = this.list();
    if (existing.length >= this.maxBackups) throw new Error(`Backup count limit exceeded: maximum ${this.maxBackups} backups`);
    const existingBytes = existing.reduce((total, backup) => total + backup.sizeBytes, 0);
    const directory = await this.backupDirectory(true);
    const ecosystemId = this.ecosystemId(true);
    const id = randomUUID();
    const file = path.join(directory, `${id}.sqlite`);
    const createdAt = new Date().toISOString();
    try {
      this.db.raw.prepare('VACUUM INTO ?').run(file);
      const sizeBytes = (await stat(file)).size;
      if (existingBytes + sizeBytes > this.maxTotalBytes) {
        throw new Error(`Backup total byte limit exceeded: maximum ${this.maxTotalBytes} bytes`);
      }
      const issues = inspectDatabase(file, ecosystemId, true);
      if (issues.length) throw new Error(`Created snapshot failed validation: ${issues.join('; ')}`);
      const sha256 = await hashFile(file);
      const info: BackupInfo = { id, createdAt, kind, sizeBytes, fileCount: 1, sha256, databaseSha256: sha256, schemaVersion: SCHEMA_VERSION, status: 'complete', path: file };
      try {
        this.db.raw.exec('BEGIN IMMEDIATE');
        this.db.raw.prepare('INSERT INTO backups (id,created_at,kind,size_bytes,file_count,sha256,database_sha256,schema_version,status,backup_path) VALUES (?,?,?,?,?,?,?,?,?,?)')
          .run(info.id,info.createdAt,info.kind,info.sizeBytes,info.fileCount,info.sha256,info.databaseSha256,info.schemaVersion,info.status,info.path);
        this.audit(id, 'backup.created', { kind, sizeBytes, schemaVersion: SCHEMA_VERSION });
        this.db.raw.exec('COMMIT');
      } catch (error) {
        try { this.db.raw.exec('ROLLBACK'); } catch { /* preserve creation error */ }
        throw error;
      }
      return info;
    } catch (error) {
      await rm(file, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  list(): BackupInfo[] {
    return (this.db.raw.prepare('SELECT * FROM backups ORDER BY created_at DESC, rowid DESC').all() as Record<string, unknown>[]).map(row => this.mapBackup(row));
  }

  async prune(options: BackupPruneOptions = {}): Promise<BackupPruneResult> {
    return this.serialize(() => this.pruneBackups({ ...options }));
  }

  private async pruneBackups(options: BackupPruneOptions): Promise<BackupPruneResult> {
    const maxAgeDays = options.maxAgeDays ?? DEFAULT_PRUNE_MAX_AGE_DAYS;
    if (typeof maxAgeDays !== 'number' || !Number.isFinite(maxAgeDays) || maxAgeDays < 0) throw new Error('maxAgeDays must be a non-negative finite number');
    const keepRecent = nonNegativeInteger(options.keepRecent ?? DEFAULT_PRUNE_KEEP_RECENT, 'keepRecent');
    const backups = this.list();
    const deleted: BackupInfo[] = [];
    if (!backups.length) return { deleted, kept: [], freedBytes: 0 };
    const protectedIds = new Set(backups.slice(0, keepRecent).map(backup => backup.id));
    const lastKnownGood = backups.find(backup => backup.status === 'complete');
    if (lastKnownGood) protectedIds.add(lastKnownGood.id);
    for (const id of this.restoringBackupIds) protectedIds.add(id);
    const migrationPaths = (this.db.raw.prepare('SELECT backup_path FROM schema_migrations WHERE backup_path IS NOT NULL').all() as {backup_path:string}[])
      .map(row => row.backup_path);
    for (const backup of backups) {
      if (migrationPaths.some(migrationPath => samePath(backup.path, migrationPath))) protectedIds.add(backup.id);
    }
    const now = Date.now();
    let remaining = [...backups];
    let remainingBytes = remaining.reduce((total, backup) => total + backup.sizeBytes, 0);
    let freedBytes = 0;
    for (const backup of [...backups].reverse()) {
      if (protectedIds.has(backup.id) || this.restoringBackupIds.has(backup.id)) continue;
      const createdAt = Date.parse(backup.createdAt);
      const expired = Number.isFinite(createdAt) && now - createdAt > maxAgeDays * DAY_MS;
      const overLimit = remaining.length > this.maxBackups || remainingBytes > this.maxTotalBytes;
      if (!expired && !overLimit) continue;
      const file = await this.getBackup(backup.id);
      let inUse = false;
      for (const suffix of SIDECAR_SUFFIXES) {
        try { await lstat(`${file.path}${suffix}`); inUse = true; break; }
        catch (error) { if (!missing(error)) throw error; }
      }
      if (inUse || this.restoringBackupIds.has(backup.id)) continue;
      await rm(file.path, { force: true });
      try {
        this.db.raw.exec('BEGIN IMMEDIATE');
        this.db.raw.prepare('DELETE FROM backups WHERE id=?').run(backup.id);
        this.audit(backup.id, 'backup.pruned', { reason: expired ? 'expired' : 'retention-limit', sizeBytes: backup.sizeBytes });
        this.db.raw.exec('COMMIT');
      } catch (error) {
        try { this.db.raw.exec('ROLLBACK'); } catch { /* preserve pruning error */ }
        throw error;
      }
      deleted.push(backup);
      freedBytes += backup.sizeBytes;
      remaining = remaining.filter(item => item.id !== backup.id);
      remainingBytes -= backup.sizeBytes;
    }
    return { deleted, kept: remaining, freedBytes };
  }

  async verify(id: string): Promise<BackupVerification> {
    this.backupRow(id);
    let info: BackupInfo;
    try {
      info = await this.getBackup(id);
    } catch (error) {
      this.db.raw.prepare("UPDATE backups SET status='corrupt' WHERE id=?").run(id);
      this.audit(id, 'verify.failed', { reason: 'Unsafe or unreadable backup path' });
      throw error;
    }
    const issues: string[] = [];
    try {
      const actual = await hashFile(info.path);
      if (actual !== info.sha256 || actual !== info.databaseSha256) issues.push('Backup SHA256 mismatch');
      const size = (await stat(info.path)).size;
      if (size !== info.sizeBytes) issues.push('Backup file size mismatch');
    } catch { issues.push('Backup file is unreadable'); }
    if (!issues.length) {
      try { issues.push(...inspectDatabase(info.path, this.ecosystemId(), true)); }
      catch (error) { issues.push(error instanceof Error ? error.message : 'Backup database is unreadable'); }
    }
    const status: BackupInfo['status'] = issues.length ? 'corrupt' : 'complete';
    this.db.raw.prepare('UPDATE backups SET status=? WHERE id=?').run(status, id);
    this.audit(id, issues.length ? 'verify.failed' : 'verify.succeeded', { issues });
    return { backup: { ...info, status }, valid: issues.length === 0, issues };
  }

  async preview(id: string, targetDir: string): Promise<BackupPreview> {
    const info = await this.getBackup(id);
    if (info.status === 'corrupt') throw new Error('Backup is marked corrupt');
    const backupDirectory = await this.backupDirectory();
    const resolvedTarget = path.resolve(targetDir);
    if (within(backupDirectory, resolvedTarget)) throw new Error('Unsafe restore target: backup directory cannot be overwritten');
    const target = await inspectPath(resolvedTarget, 'directory', true);
    if (within(backupDirectory, target)) throw new Error('Unsafe restore target: backup directory cannot be overwritten');
    let entries: string[] = [];
    try { entries = await readdir(target); } catch (error) { if (!missing(error)) throw error; }
    if (entries.length) throw new Error('Restore target directory must be empty');
    const targetFile = path.join(target, this.databaseName());
    await inspectPath(targetFile, 'file', true);
    const actualSize = (await stat(info.path)).size;
    const actualHash = await hashFile(info.path);
    if (actualSize !== info.sizeBytes || actualHash !== info.sha256 || actualHash !== info.databaseSha256) {
      this.db.raw.prepare("UPDATE backups SET status='corrupt' WHERE id=?").run(id);
      this.audit(id, 'preview.failed', { reason: 'Backup SHA256 or size mismatch' });
      throw new Error('Backup preview failed: Backup SHA256 or size mismatch');
    }
    const issues = inspectDatabase(info.path, this.ecosystemId(), false);
    if (issues.length) throw new Error(`Backup preview failed: ${issues.join('; ')}`);
    const warnings = [
      'Restore replaces only the SQLite database; uploads, artifacts, cache payloads and key files are not included.',
      'Existing WAL/SHM sidecars are checkpointed and removed before the database file is switched.'
    ];
    return { backup: info, targetDir: target, files: [{ path: targetFile, sizeBytes: actualSize }], totalBytes: actualSize, warnings };
  }

  private checkpoint(raw: DatabaseSync): void {
    const row = raw.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as {busy:number}|undefined;
    if (!row || Number(row.busy) !== 0) throw new Error('Database is busy; restore was not started');
  }

  private async validateTarget(targetFile: string): Promise<boolean> {
    try {
      await inspectPath(targetFile, 'file');
    } catch (error) {
      if (missing(error)) return false;
      throw error;
    }
    const issues = inspectDatabase(targetFile, this.ecosystemId(), false);
    if (issues.length) throw new Error(`Restore target is not compatible: ${issues.join('; ')}`);
    return true;
  }

  private async moveSidecars(targetFile: string, directory: string): Promise<void> {
    for (const suffix of SIDECAR_SUFFIXES) {
      const sidecar = `${targetFile}${suffix}`;
      let info;
      try { info = await lstat(sidecar); } catch (error) { if (missing(error)) continue; throw error; }
      if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Unsafe database sidecar at ${sidecar}`);
      await rename(sidecar, path.join(directory, `previous${suffix}`));
    }
  }

  private async registerRestoredBackup(targetFile: string, info: BackupInfo): Promise<void> {
    const raw = new DatabaseSync(targetFile);
    try {
      raw.exec('PRAGMA foreign_keys=ON;');
      raw.prepare('INSERT OR IGNORE INTO backups (id,created_at,kind,size_bytes,file_count,sha256,database_sha256,schema_version,status,backup_path) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(info.id,info.createdAt,info.kind,info.sizeBytes,info.fileCount,info.sha256,info.databaseSha256,info.schemaVersion,info.status,info.path);
      raw.prepare('INSERT INTO backup_events (backup_id,action,details_json,created_at) VALUES (?,?,?,?)')
        .run(info.id,'restore.completed',JSON.stringify({ targetDir: path.dirname(targetFile), sizeBytes: info.sizeBytes }),new Date().toISOString());
    } finally {
      raw.close();
    }
  }

  async restore(id: string, targetDataDir: string): Promise<BackupPreview> {
    return this.serialize(() => this.restoreBackup(id, targetDataDir));
  }

  private async restoreBackup(id: string, targetDataDir: string): Promise<BackupPreview> {
    const info = await this.getBackup(id);
    const ecosystemId = this.ecosystemId();
    const target = await ensureDirectory(targetDataDir);
    const targetFile = path.join(target, this.databaseName());
    await this.validateTarget(targetFile);
    for (const suffix of SIDECAR_SUFFIXES) await inspectPath(`${targetFile}${suffix}`, 'file', true);
    const activeFile = this.db.file !== ':memory:' ? await realpath(this.db.file).catch(() => this.db.file) : this.db.file;
    const active = activeFile !== ':memory:' && samePath(activeFile, await realpath(targetFile).catch(() => targetFile));
    const activeTasks = active ? this.db.raw.prepare("SELECT id FROM tasks WHERE status IN ('QUEUED','RUNNING','PAUSED') LIMIT 1").get() as {id:string}|undefined : undefined;
    if (activeTasks) throw new Error('Restore refused while tasks are active');
    const stage = path.join(target, `.restore-${randomUUID()}`);
    const rollback = path.join(target, `.restore-rollback-${randomUUID()}`);
    let stageCreated = false;
    let rollbackCreated = false;
    let oldMoved = false;
    let switched = false;
    let activeConnected = active;
    this.restoringBackupIds.add(id);
    try {
      this.audit(id, 'restore.started', { targetDir: target });
      await mkdir(stage);
      stageCreated = true;
      const preview = await this.preview(id, stage);
      const verification = await this.verify(id);
      if (!verification.valid) throw new Error(`Backup verification failed: ${verification.issues.join('; ')}`);
      const stagedFile = preview.files[0]?.path;
      if (!stagedFile) throw new Error('Backup preview did not provide a database file');
      await copyFile(info.path, stagedFile, constants.COPYFILE_EXCL);
      const copiedHash = await hashFile(stagedFile);
      if (copiedHash !== info.sha256 || copiedHash !== info.databaseSha256) throw new Error('Copied backup SHA256 mismatch');
      const stagedIssues = inspectDatabase(stagedFile, ecosystemId, true);
      if (stagedIssues.length) throw new Error(`Staged restore failed validation: ${stagedIssues.join('; ')}`);
      for (const suffix of SIDECAR_SUFFIXES) {
        const sidecar = `${stagedFile}${suffix}`;
        try {
          const sidecarInfo = await lstat(sidecar);
          if (sidecarInfo.isSymbolicLink() || !sidecarInfo.isFile()) throw new Error('Unsafe staged database sidecar');
          if (suffix === '-wal' && sidecarInfo.size !== 0) throw new Error('Staged database contains an unsafe WAL');
          await rm(sidecar, { force: true });
        } catch (error) { if (!missing(error)) throw error; }
      }
      const targetExists = await this.validateTarget(targetFile);
      if (active) {
        this.checkpoint(this.db.raw);
        this.db.close();
        activeConnected = false;
      } else if (targetExists) {
        const existing = new DatabaseSync(targetFile);
        try { this.checkpoint(existing); } finally { existing.close(); }
      }
      await mkdir(rollback);
      rollbackCreated = true;
      try {
        await rename(targetFile, path.join(rollback, 'previous.sqlite'));
        oldMoved = true;
      } catch (error) { if (!missing(error)) throw error; }
      await this.moveSidecars(targetFile, rollback);
      await rename(stagedFile, targetFile);
      switched = true;
      await this.registerRestoredBackup(targetFile, info);
      const finalIssues = inspectDatabase(targetFile, ecosystemId, true);
      if (finalIssues.length) throw new Error(`Restored database failed validation: ${finalIssues.join('; ')}`);
      if (!active) this.audit(id, 'restore.completed', { targetDir: target });
      await rm(stage, { recursive: true, force: true });
      stageCreated = false;
      const actualSize = (await stat(targetFile)).size;
      if (active) {
        this.db.reopen(targetFile);
        activeConnected = true;
      }
      await rm(rollback, { recursive: true, force: true });
      rollbackCreated = false;
      return { ...preview, targetDir: target, files: [{ path: targetFile, sizeBytes: actualSize }], totalBytes: actualSize };
    } catch (error) {
      const reason = errorMessage(error);
      const diagnostics: string[] = [];
      if (active && activeConnected) {
        try {
          this.db.close();
          activeConnected = false;
        } catch (closeError) {
          diagnostics.push(`Active database close failed: ${errorMessage(closeError)}`);
        }
      }
      const canSwitchFiles = !active || !activeConnected;
      if (switched && canSwitchFiles) {
        try {
          await rm(targetFile, { force: true });
          for (const suffix of SIDECAR_SUFFIXES) await rm(`${targetFile}${suffix}`, { force: true });
        } catch (cleanupError) {
          diagnostics.push(`Switched database cleanup failed: ${errorMessage(cleanupError)}`);
        }
      }
      if (oldMoved && canSwitchFiles) {
        try {
          await rename(path.join(rollback, 'previous.sqlite'), targetFile);
          for (const suffix of SIDECAR_SUFFIXES) {
            const previous = path.join(rollback, `previous${suffix}`);
            try { await rename(previous, `${targetFile}${suffix}`); } catch (sidecarError) { if (!missing(sidecarError)) throw sidecarError; }
          }
          oldMoved = false;
        } catch (rollbackError) {
          diagnostics.push(`Rollback failed: ${errorMessage(rollbackError)}; previous database retained at ${rollback}`);
        }
      }
      if (active && !activeConnected && !oldMoved) {
        try { this.db.reopen(targetFile); activeConnected = true; }
        catch (reopenError) { diagnostics.push(`Reopen failed: ${errorMessage(reopenError)}`); }
      }
      this.auditRestoreFailure(id, target, reason, diagnostics);
      if (stageCreated) {
        try { await rm(stage, { recursive: true, force: true }); }
        catch (cleanupError) { diagnostics.push(`Restore staging cleanup failed: ${errorMessage(cleanupError)}`); }
      }
      if (rollbackCreated && !oldMoved) {
        try { await rm(rollback, { recursive: true, force: true }); }
        catch (cleanupError) { diagnostics.push(`Restore rollback cleanup failed: ${errorMessage(cleanupError)}`); }
      }
      throw new Error(`Restore failed: ${reason}${diagnostics.length ? `; recovery: ${diagnostics.join('; ')}` : ''}`, { cause: error });
    } finally {
      this.restoringBackupIds.delete(id);
    }
  }

  events(limit = 100): BackupEvent[] {
    return (this.db.raw.prepare('SELECT * FROM backup_events ORDER BY id DESC LIMIT ?').all(limit) as Record<string, unknown>[]).map(row => ({
      id: Number(row.id), backupId: row.backup_id ? String(row.backup_id) : null, action: String(row.action),
      details: JSON.parse(String(row.details_json)) as unknown, createdAt: String(row.created_at)
    }));
  }
}

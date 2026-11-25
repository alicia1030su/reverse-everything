import { createHash, randomUUID } from 'node:crypto';
import { renameSync, rmSync } from 'node:fs';
import { lstat, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CACHE_POLICY_VERSION, EVIDENCE_MODEL_VERSION, SECURITY_POLICY_VERSION, type AdapterName, type CacheEntry, type CacheKind, type CacheStatistics, type JsonObject, type Stage } from '@reverse/contracts';
import { canonical, sha256 } from '@reverse/evidence';
import type { Database } from './database.js';

export interface CacheIdentity { projectId: string; inputHash: string; adapter: AdapterName; adapterVersion: string; stage: Stage; options: JsonObject; toolVersions?: JsonObject; shareApproved?: boolean }
export interface CacheOptions { maxBytes?: number; ttlDays?: number }
interface CacheRow { key:string; scope:string; project_id:string|null; adapter:string; stage:string; kind:CacheKind; size_bytes:number; payload_path:string; payload_sha256:string; hits:number; misses:number; ref_count:number; created_at:string; last_accessed_at:string; expires_at:string|null }
interface EvictionRow { key:string; size_bytes:number; payload_path:string }
const PURE_STAGES = new Set<Stage>(['CLASSIFY','PREPARE','ANALYZE']);
const REALTIME_ADAPTERS = new Set<AdapterName>(['website','game','security']);
// Only the file adapter can rebuild every downstream artifact from its complete output.
const CACHEABLE_ANALYZE_ADAPTERS = new Set<AdapterName>(['file']);
const CACHEABLE_PREPARE_ADAPTERS = new Set<AdapterName>(['file','network']);
const EXECUTION_OPTION = /^(?:timeoutMs|settleMs|maxMemoryMB|maxDiskMB|pollMs|leaseMs|ghidraTimeoutMs|aiMaxIterations|cacheScope|cacheShareApproved)$/i;
const RANDOM_OPTION = /random|nonce|requestId|traceId|runId|timestamp|^(?:now|requestedAt|startedAt|createdAt)$/i;
const SENSITIVE_FIELD_NAMES = new Set(['apikey','key','accesskey','secretkey','privatekey','clientkey','token','accesstoken','refreshtoken','authtoken','idtoken','secret','clientsecret','password','passwd','pwd','credential','credentials','authorization','auth','cookie','setcookie','session','sessionid','sid','jwt','refresh','access','bearer']);
const SENSITIVE_FIELD_SUFFIX = /(?:apikey|privatekey|clientsecret|token|secret|password|passwd|credential|credentials|authorization|cookie|sessionid|jwt)$/;
const BARE_JWT = /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\b/g;
const SENSITIVE_ASSIGNMENT = /(^|[\s{,;?&"'])([A-Za-z_][A-Za-z0-9_-]*)(["']?\s*[:=]\s*)(?!\/\/)("[^"]*"|'[^']*'|[^\s,;}&]+)/g;
const DANGEROUS_FIELD = /^(?:__proto__|prototype|constructor)$/;
const EVICTION_BATCH_SIZE = 256;

function isSensitiveField(key:string):boolean {
  const normalized=key.replace(/[^a-z0-9]/gi,'').toLowerCase();
  return SENSITIVE_FIELD_NAMES.has(normalized)||SENSITIVE_FIELD_SUFFIX.test(normalized);
}

function redactCacheString(value:string):string {
  return value
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]+/gi,'[REDACTED]')
    .replace(BARE_JWT,'[REDACTED]')
    .replace(SENSITIVE_ASSIGNMENT,(match:string,prefix:string,key:string,separator:string)=>isSensitiveField(key)?`${prefix}${key}${separator}[REDACTED]`:match);
}

function cacheValue(value:unknown, omitSensitiveFields:boolean, omitNonSemanticFields=false):unknown {
  if (typeof value==='string') return redactCacheString(value);
  if (value instanceof Date) return value.toJSON();
  if (value===null||typeof value!=='object') return value;
  if (Array.isArray(value)) return value.map(item=>cacheValue(item,omitSensitiveFields,omitNonSemanticFields));
  const result:Record<string,unknown>={};
  for (const [key,item] of Object.entries(value as Record<string,unknown>)) {
    if (DANGEROUS_FIELD.test(key)||(omitNonSemanticFields&&(EXECUTION_OPTION.test(key)||RANDOM_OPTION.test(key)))) continue;
    if (isSensitiveField(key)) {
      if (!omitSensitiveFields) result[key]='[REDACTED]';
      continue;
    }
    result[key]=cacheValue(item,omitSensitiveFields,omitNonSemanticFields);
  }
  return result;
}

export class AnalysisCache {
  readonly dir: string;
  private maxBytes: number;
  private ttlMs: number;
  private readonly reads = new Map<string, Promise<unknown | undefined>>();
  private readonly writes = new Map<string, Promise<void>>();
  private putTail: Promise<void> = Promise.resolve();

  constructor(private db: Database, dataDir: string, options: CacheOptions = {}) {
    this.dir = path.join(dataDir, 'cache');
    this.maxBytes = Math.max(0, options.maxBytes ?? 2 * 1024 * 1024 * 1024);
    this.ttlMs = (options.ttlDays ?? 30) * 86400000;
  }

  static isCacheable(stage: Stage, adapter?: AdapterName) {
    if (!PURE_STAGES.has(stage)) return false;
    if (adapter===undefined) return true;
    if (REALTIME_ADAPTERS.has(adapter)) return false;
    if (stage==='ANALYZE') return CACHEABLE_ANALYZE_ADAPTERS.has(adapter);
    if (stage==='PREPARE') return CACHEABLE_PREPARE_ADAPTERS.has(adapter);
    return true;
  }

  static cacheOptions(options: JsonObject): JsonObject {
    return cacheValue(options,true,true) as JsonObject;
  }

  static cacheKind(adapter: AdapterName, stage: Stage): CacheKind | undefined {
    if (!this.isCacheable(stage,adapter)) return undefined;
    if (adapter === 'website') return 'web-snapshot';
    if (adapter === 'game') return 'protocol';
    return 'static-analysis';
  }

  configure(options:{maxBytes?:number;ttlDays?:number}) {
    if (options.maxBytes !== undefined) this.maxBytes = Math.max(0, options.maxBytes);
    if (options.ttlDays !== undefined) this.ttlMs = options.ttlDays * 86400000;
  }

  async keyFor(identity: CacheIdentity): Promise<{key:string;scope:'project'|'global';projectId:string|null}> {
    const scope = identity.shareApproved ? 'global' : 'project';
    const projectId = scope === 'global' ? null : identity.projectId;
    const cacheable=AnalysisCache.isCacheable(identity.stage,identity.adapter);
    const key = await sha256(canonical({cachePolicy:CACHE_POLICY_VERSION,evidenceModel:EVIDENCE_MODEL_VERSION,securityPolicy:SECURITY_POLICY_VERSION,cacheable,scope,projectId,inputHash:identity.inputHash,adapter:identity.adapter,adapterVersion:identity.adapterVersion,stage:identity.stage,options:AnalysisCache.cacheOptions(identity.options),toolVersions:AnalysisCache.cacheOptions(identity.toolVersions??{})}));
    return {key, scope, projectId};
  }

  private row(row: CacheRow): CacheEntry {
    return {key:row.key,kind:row.kind,scope:row.scope as CacheEntry['scope'],projectId:row.project_id,adapter:row.adapter as AdapterName,stage:row.stage as Stage,sizeBytes:row.size_bytes,sha256:row.payload_sha256,hits:row.hits,misses:row.misses,refCount:row.ref_count,createdAt:row.created_at,lastAccessedAt:row.last_accessed_at,expiresAt:row.expires_at};
  }

  get(key:string): Promise<unknown | undefined> {
    const active = this.reads.get(key);
    if (active) return active;
    const pending = this.read(key).finally(() => {
      if (this.reads.get(key) === pending) this.reads.delete(key);
    });
    this.reads.set(key, pending);
    return pending;
  }

  private async read(key:string): Promise<unknown | undefined> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const row = this.db.raw.prepare('SELECT * FROM cache_entries WHERE key=?').get(key) as CacheRow | undefined;
      if (!row) { this.bump('misses'); return undefined; }
      if (row.expires_at && Date.parse(row.expires_at) < Date.now()) {
        this.bump('misses');
        const removed = await this.remove(key, row.payload_sha256);
        if (removed) this.bump('evictions');
        return undefined;
      }
      try {
        if (!(await lstat(row.payload_path)).isFile()) throw new Error('Cache payload is not a regular file');
        const bytes = await readFile(row.payload_path);
        const digest = createHash('sha256').update(bytes).digest('hex');
        const latest = this.db.raw.prepare('SELECT payload_sha256 FROM cache_entries WHERE key=?').get(key) as {payload_sha256:string} | undefined;
        if (latest?.payload_sha256 !== row.payload_sha256) continue;
        if (digest !== row.payload_sha256) throw new Error('Cache payload hash mismatch');
        const value = cacheValue(JSON.parse(bytes.toString('utf8')) as unknown,false);
        this.db.raw.prepare("UPDATE cache_entries SET hits=hits+1,last_accessed_at=? WHERE key=? AND payload_sha256=?").run(new Date().toISOString(), key, row.payload_sha256);
        this.bump('hits');
        return value;
      } catch {
        const latest = this.db.raw.prepare('SELECT payload_sha256 FROM cache_entries WHERE key=?').get(key) as {payload_sha256:string} | undefined;
        if (attempt === 0 && latest?.payload_sha256 !== row.payload_sha256) continue;
        this.bump('misses');
        this.bump('corrupt');
        await this.remove(key, row.payload_sha256);
        const after = this.db.raw.prepare('SELECT payload_sha256 FROM cache_entries WHERE key=?').get(key) as {payload_sha256:string} | undefined;
        if (attempt === 0 && after && after.payload_sha256 !== row.payload_sha256) continue;
        return undefined;
      }
    }
    this.bump('misses');
    return undefined;
  }

  put(key:string,scope:'project'|'global',projectId:string|null,adapter:AdapterName,stage:Stage,value:unknown,kindOverride?:CacheKind): Promise<void> {
    const active = this.writes.get(key);
    if (active) return active;
    const pending = this.enqueuePut(() => this.write(key, scope, projectId, adapter, stage, value, kindOverride));
    const tracked = pending.finally(() => {
      if (this.writes.get(key) === tracked) this.writes.delete(key);
    });
    this.writes.set(key, tracked);
    return tracked;
  }

  private enqueuePut(work:() => Promise<void>): Promise<void> {
    const result = this.putTail.then(work, work);
    this.putTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async write(key:string,scope:'project'|'global',projectId:string|null,adapter:AdapterName,stage:Stage,value:unknown,kindOverride?:CacheKind): Promise<void> {
    if (!AnalysisCache.isCacheable(stage,adapter)) return;
    const kind = kindOverride ?? AnalysisCache.cacheKind(adapter, stage);
    if (!kind) return;
    const bytes = Buffer.from(JSON.stringify(cacheValue(value,false)));
    const size = bytes.length;
    if (size > this.maxBytes) return;
    const digest = await sha256(bytes);
    await mkdir(this.dir, {recursive:true});
    const payload = path.join(this.dir, key.slice(0, 2), `${key}.json`);
    await mkdir(path.dirname(payload), {recursive:true});
    const temp = `${payload}.${process.pid}.${randomUUID()}.tmp`;
    const cleanup: string[] = [];
    try {
      await writeFile(temp, bytes, {flag:'wx'});
      const now = new Date().toISOString();
      this.transaction(() => {
        const existing = this.db.raw.prepare('SELECT size_bytes,payload_path FROM cache_entries WHERE key=?').get(key) as {size_bytes:number;payload_path:string} | undefined;
        const current = this.currentBytes() - (existing?.size_bytes ?? 0);
        const target = this.maxBytes - size;
        if (current > target) {
          const evictable = Number((this.db.raw.prepare('SELECT COALESCE(SUM(size_bytes),0) n FROM cache_entries WHERE key<>? AND ref_count=0').get(key) as {n:number}).n);
          if (current - evictable > target) return;
        }
        const evicted = this.evictToFit(target, key, current);
        if (evicted.remaining > target) return;
        if (existing?.payload_path && existing.payload_path !== payload) cleanup.push(existing.payload_path);
        this.db.raw.prepare(`INSERT INTO cache_entries (key,scope,project_id,adapter,stage,kind,size_bytes,payload_path,payload_sha256,hits,misses,ref_count,created_at,last_accessed_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,0,0,0,?,?,?) ON CONFLICT(key) DO UPDATE SET scope=excluded.scope,project_id=excluded.project_id,adapter=excluded.adapter,stage=excluded.stage,kind=excluded.kind,size_bytes=excluded.size_bytes,payload_path=excluded.payload_path,payload_sha256=excluded.payload_sha256,last_accessed_at=excluded.last_accessed_at,expires_at=excluded.expires_at`).run(key,scope,projectId,adapter,stage,kind,size,payload,digest,now,now,new Date(Date.now()+this.ttlMs).toISOString());
        // Keep the rename and row update in one SQLite write transaction. A
        // reader that observes the new file before COMMIT retries on hash change.
        renameSync(temp, payload);
        this.bump('writes');
      });
    } finally {
      await rm(temp, {force:true}).catch(() => undefined);
    }
    await this.deletePayloads(cleanup);
  }

  private transaction<T>(work:() => T): T {
    this.db.raw.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.raw.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.db.raw.exec('ROLLBACK'); } catch { /* preserve the original error */ }
      throw error;
    }
  }

  private bump(kind:'hits'|'misses'|'writes'|'corrupt'|'evictions') {
    this.db.raw.prepare(`UPDATE cache_stats SET ${kind}=${kind}+1 WHERE id=1`).run();
  }

  private currentBytes(): number {
    return Number((this.db.raw.prepare('SELECT COALESCE(SUM(size_bytes),0) n FROM cache_entries').get() as {n:number}).n);
  }

  private evictToFit(target:number, excludeKey:string, initialCurrent:number): {remaining:number} {
    let current = initialCurrent;
    while (current > target) {
      const rows = this.db.raw.prepare('SELECT key,size_bytes,payload_path FROM cache_entries WHERE key<>? AND ref_count=0 ORDER BY last_accessed_at ASC,key ASC LIMIT ?').all(excludeKey, EVICTION_BATCH_SIZE) as unknown as EvictionRow[];
      if (!rows.length) break;
      for (const row of rows) {
        this.db.raw.prepare('DELETE FROM cache_entries WHERE key=? AND ref_count=0').run(row.key);
        this.removePayloadSync(row.payload_path);
        current -= row.size_bytes;
        this.bump('evictions');
      }
    }
    return {remaining:current};
  }

  private removePayloadSync(payloadPath:string) {
    const root = path.resolve(this.dir);
    const target = path.resolve(payloadPath);
    if (target.startsWith(root + path.sep)) {
      try { rmSync(target, {force:true}); } catch { /* metadata cleanup must not fail the transaction */ }
    }
  }

  private async deletePayloads(paths:string[]) {
    const root = path.resolve(this.dir);
    for (const payloadPath of new Set(paths)) {
      const target = path.resolve(payloadPath);
      if (target.startsWith(root + path.sep)) await rm(target, {force:true}).catch(() => undefined);
    }
  }

  private async remove(key:string, expectedSha256?:string): Promise<boolean> {
    return this.transaction(() => {
      const row = this.db.raw.prepare('SELECT payload_path,payload_sha256,ref_count FROM cache_entries WHERE key=?').get(key) as {payload_path:string;payload_sha256:string;ref_count:number} | undefined;
      if (!row || row.ref_count > 0 || (expectedSha256 !== undefined && row.payload_sha256 !== expectedSha256)) return false;
      this.db.raw.prepare('DELETE FROM cache_entries WHERE key=? AND ref_count=0').run(key);
      this.removePayloadSync(row.payload_path);
      return true;
    });
  }

  acquire(key:string): () => void {
    this.transaction(() => {
      this.db.raw.prepare('UPDATE cache_entries SET ref_count=ref_count+1 WHERE key=?').run(key);
    });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.transaction(() => {
        this.db.raw.prepare('UPDATE cache_entries SET ref_count=MAX(ref_count-1,0) WHERE key=?').run(key);
      });
    };
  }

  list(projectId?:string,limit=100,offset=0) {
    const where = projectId ? 'WHERE project_id=?' : '';
    const args = projectId ? [projectId] : [];
    const rows = this.db.raw.prepare(`SELECT * FROM cache_entries ${where} ORDER BY last_accessed_at DESC LIMIT ? OFFSET ?`).all(...args,limit,offset) as unknown as CacheRow[];
    const total = Number((this.db.raw.prepare(`SELECT COUNT(*) n FROM cache_entries ${where}`).get(...args) as {n:number}).n);
    return {items:rows.map(r => this.row(r)),total,limit,offset};
  }

  statistics(): CacheStatistics {
    const row = this.db.raw.prepare('SELECT * FROM cache_stats WHERE id=1').get() as {hits:number;misses:number;writes:number;corrupt:number;evictions:number};
    const size = this.currentBytes();
    const entries = Number((this.db.raw.prepare('SELECT COUNT(*) n FROM cache_entries').get() as {n:number}).n);
    return {...row,sizeBytes:size,entries,hitRate:row.hits+row.misses ? row.hits/(row.hits+row.misses) : 0};
  }

  async clear(options:{projectId?:string;olderThanDays?:number;dryRun?:boolean} = {}) {
    const rows = this.db.raw.prepare('SELECT * FROM cache_entries ORDER BY last_accessed_at').all() as unknown as CacheRow[];
    const cutoff = options.olderThanDays ? Date.now()-options.olderThanDays*86400000 : 0;
    const matched = rows.filter(r => (!options.projectId || r.project_id === options.projectId) && (!cutoff || Date.parse(r.last_accessed_at) < cutoff));
    const skipped = matched.filter(r => r.ref_count > 0);
    const selected = matched.filter(r => r.ref_count === 0);
    if (!options.dryRun) for (const row of selected) await this.remove(row.key);
    return {items:selected.map(r => this.row(r)),skipped:skipped.map(r => this.row(r)),total:selected.length,limit:selected.length,offset:0};
  }

  async verify() {
    const rows = this.db.raw.prepare('SELECT * FROM cache_entries').all() as unknown as CacheRow[];
    let valid = 0, invalid = 0;
    for (const row of rows) {
      try {
        if ((await stat(row.payload_path)).size !== row.size_bytes) throw new Error('size');
        if (await sha256(await readFile(row.payload_path)) !== row.payload_sha256) throw new Error('hash');
        valid++;
      } catch { invalid++; }
    }
    return {valid,invalid};
  }
}

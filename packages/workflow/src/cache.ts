import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CACHE_POLICY_VERSION, EVIDENCE_MODEL_VERSION, SECURITY_POLICY_VERSION, type AdapterName, type CacheEntry, type CacheStatistics, type JsonObject, type Stage } from '@reverse/contracts';
import { canonical, sha256 } from '@reverse/evidence';
import type { Database } from './database.js';

export interface CacheIdentity { projectId: string; inputHash: string; adapter: AdapterName; adapterVersion: string; stage: Stage; options: JsonObject; toolVersions?: JsonObject; shareApproved?: boolean }
export interface CacheOptions { maxBytes?: number; ttlDays?: number }
interface CacheRow { key:string; scope:string; project_id:string|null; adapter:string; stage:string; size_bytes:number; payload_path:string; payload_sha256:string; hits:number; misses:number; created_at:string; last_accessed_at:string; expires_at:string|null }
const PURE_STAGES = new Set<Stage>(['CLASSIFY','PREPARE','ANALYZE']);
export class AnalysisCache {
  readonly dir: string;
  private maxBytes: number;
  private ttlMs: number;
  constructor(private db: Database, dataDir: string, options: CacheOptions = {}) { this.dir=path.join(dataDir,'cache'); this.maxBytes=options.maxBytes??2*1024*1024*1024; this.ttlMs=(options.ttlDays??30)*86400000; }
  static isCacheable(stage: Stage) { return PURE_STAGES.has(stage); }
  configure(options:{maxBytes?:number;ttlDays?:number}){if(options.maxBytes!==undefined)this.maxBytes=options.maxBytes;if(options.ttlDays!==undefined)this.ttlMs=options.ttlDays*86400000;}
  async keyFor(identity: CacheIdentity): Promise<{key:string;scope:'project'|'global';projectId:string|null}> {
    const scope=identity.shareApproved?'global':'project';
    const projectId=scope==='global'?null:identity.projectId;
    const key=await sha256(canonical({cachePolicy:CACHE_POLICY_VERSION,evidenceModel:EVIDENCE_MODEL_VERSION,securityPolicy:SECURITY_POLICY_VERSION,scope,projectId,inputHash:identity.inputHash,adapter:identity.adapter,adapterVersion:identity.adapterVersion,stage:identity.stage,options:identity.options,toolVersions:identity.toolVersions??{}}));
    return {key,scope,projectId};
  }
  private row(row: CacheRow): CacheEntry { return {key:row.key,scope:row.scope as CacheEntry['scope'],projectId:row.project_id,adapter:row.adapter as AdapterName,stage:row.stage as Stage,sizeBytes:row.size_bytes,sha256:row.payload_sha256,hits:row.hits,misses:row.misses,createdAt:row.created_at,lastAccessedAt:row.last_accessed_at,expiresAt:row.expires_at}; }
  async get(key:string): Promise<unknown|undefined> {
    const row=this.db.raw.prepare('SELECT * FROM cache_entries WHERE key=?').get(key) as CacheRow|undefined;
    if(!row)return undefined;
    if(row.expires_at&&Date.parse(row.expires_at)<Date.now()){await this.remove(key);this.bump('evictions');return undefined;}
    try {
      if(!(await lstat(row.payload_path)).isFile())throw new Error('Cache payload is not a regular file');
      const bytes=await readFile(row.payload_path);const digest=createHash('sha256').update(bytes).digest('hex');
      if(digest!==row.payload_sha256)throw new Error('Cache payload hash mismatch');
      const value=JSON.parse(bytes.toString('utf8')) as unknown;
      this.db.raw.prepare("UPDATE cache_entries SET hits=hits+1,last_accessed_at=? WHERE key=?").run(new Date().toISOString(),key);this.bump('hits');return value;
    } catch { await this.remove(key);this.bump('corrupt');return undefined; }
  }
  async put(key:string,scope:'project'|'global',projectId:string|null,adapter:AdapterName,stage:Stage,value:unknown): Promise<void> {
    const serialized=JSON.stringify(value);const bytes=Buffer.from(serialized);const size=bytes.length;
    if(size>this.maxBytes)return;
    await mkdir(this.dir,{recursive:true});const payload=path.join(this.dir,key.slice(0,2),`${key}.json`);await mkdir(path.dirname(payload),{recursive:true});
    const existing=Number((this.db.raw.prepare('SELECT size_bytes n FROM cache_entries WHERE key=?').get(key) as {n:number}|undefined)?.n??0);await this.evictToFit(this.maxBytes-size+existing);
    const temp=`${payload}.${process.pid}.${Date.now()}.tmp`;await writeFile(temp,bytes);const digest=await sha256(bytes);await rename(temp,payload);
    const now=new Date().toISOString();this.db.raw.prepare(`INSERT INTO cache_entries (key,scope,project_id,adapter,stage,size_bytes,payload_path,payload_sha256,hits,misses,created_at,last_accessed_at,expires_at) VALUES (?,?,?,?,?,?,?,?,0,0,?,?,?) ON CONFLICT(key) DO UPDATE SET size_bytes=excluded.size_bytes,payload_path=excluded.payload_path,payload_sha256=excluded.payload_sha256,last_accessed_at=excluded.last_accessed_at,expires_at=excluded.expires_at`).run(key,scope,projectId,adapter,stage,size,payload,digest,now,now,new Date(Date.now()+this.ttlMs).toISOString());
    this.bump('writes');
  }
  private bump(kind:'hits'|'misses'|'writes'|'corrupt'|'evictions') { this.db.raw.prepare(`UPDATE cache_stats SET ${kind}=${kind}+1 WHERE id=1`).run(); }
  private async currentBytes(){return Number((this.db.raw.prepare('SELECT COALESCE(SUM(size_bytes),0) n FROM cache_entries').get() as {n:number}).n);}
  private async evictToFit(target:number){let current=await this.currentBytes();const rows=this.db.raw.prepare('SELECT key,size_bytes FROM cache_entries ORDER BY last_accessed_at LIMIT 1000').all() as {key:string;size_bytes:number}[];for(const row of rows){if(current<=target)break;await this.remove(row.key);current-=row.size_bytes;this.bump('evictions');}}
  private async remove(key:string){const row=this.db.raw.prepare('SELECT payload_path FROM cache_entries WHERE key=?').get(key) as {payload_path:string}|undefined;if(row){const root=path.resolve(this.dir);const target=path.resolve(row.payload_path);if(target.startsWith(root+path.sep))await rm(target,{force:true});}this.db.raw.prepare('DELETE FROM cache_entries WHERE key=?').run(key);}
  list(projectId?:string,limit=100,offset=0){const where=projectId?'WHERE project_id=?':'';const args=projectId?[projectId]:[];const rows=this.db.raw.prepare(`SELECT * FROM cache_entries ${where} ORDER BY last_accessed_at DESC LIMIT ? OFFSET ?`).all(...args,limit,offset) as unknown as CacheRow[];const total=Number((this.db.raw.prepare(`SELECT COUNT(*) n FROM cache_entries ${where}`).get(...args) as {n:number}).n);return {items:rows.map(r=>this.row(r)),total,limit,offset};}
  statistics():CacheStatistics{const row=this.db.raw.prepare('SELECT * FROM cache_stats WHERE id=1').get() as {hits:number;misses:number;writes:number;corrupt:number;evictions:number};const size=Number((this.db.raw.prepare('SELECT COALESCE(SUM(size_bytes),0) n FROM cache_entries').get() as {n:number}).n);const entries=Number((this.db.raw.prepare('SELECT COUNT(*) n FROM cache_entries').get() as {n:number}).n);return {...row,sizeBytes:size,entries,hitRate:row.hits+row.misses?row.hits/(row.hits+row.misses):0};}
  async clear(options:{projectId?:string;olderThanDays?:number;dryRun?:boolean}){const rows=this.db.raw.prepare('SELECT * FROM cache_entries ORDER BY last_accessed_at').all() as unknown as CacheRow[];const cutoff=options.olderThanDays?Date.now()-options.olderThanDays*86400000:0;const matched=rows.filter(r=>(!options.projectId||r.project_id===options.projectId)&&(!cutoff||Date.parse(r.last_accessed_at)<cutoff));if(!options.dryRun)for(const row of matched)await this.remove(row.key);return {items:matched.map(r=>this.row(r)),total:matched.length,limit:matched.length,offset:0};}
  async verify(){const rows=this.db.raw.prepare('SELECT * FROM cache_entries').all() as unknown as CacheRow[];let valid=0,invalid=0;for(const row of rows){try{if((await stat(row.payload_path)).size!==row.size_bytes)throw new Error('size');if(await sha256(await readFile(row.payload_path))!==row.payload_sha256)throw new Error('hash');valid++;}catch{invalid++;}}return {valid,invalid};}
}

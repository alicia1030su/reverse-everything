import { lstat, readdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_RETENTION_POLICY, type CleanupItem, type CleanupPreview, type CleanupResult, type DataCategory, type RetentionPolicy } from '@reverse/contracts';
import type { Database } from './database.js';
import { DEFAULT_RESOURCE_SAMPLE_RETENTION } from './resources.js';

export interface ResourceRetentionPolicy { resourceDays?:number; resourceMaxRows?:number }
type EffectiveRetentionPolicy = RetentionPolicy & Required<ResourceRetentionPolicy>;
interface MetricRow { id:number; task_id:string|null; size:number }

function withinRoot(root:string,target:string){const relative=path.relative(root,target);if(relative==='')return true;if(relative.startsWith('..'+path.sep)||relative==='..'||path.isAbsolute(relative))return false;return process.platform==='win32'?true:!relative.startsWith('..');}

export class RetentionService {
  readonly root: string;
  private canonicalRoot?: Promise<string>;
  constructor(private db: Database, dataDir: string) { this.root=path.resolve(dataDir); }
  private rootPath(){return this.canonicalRoot??=realpath(this.root).catch(()=>this.root);}
  policy(): EffectiveRetentionPolicy {
    const defaults:EffectiveRetentionPolicy={...DEFAULT_RETENTION_POLICY,resourceDays:DEFAULT_RESOURCE_SAMPLE_RETENTION.days,resourceMaxRows:DEFAULT_RESOURCE_SAMPLE_RETENTION.maxRows};
    const s=this.db.settings().retention_policy;
    if(!s)return defaults;
    try{return {...defaults,...JSON.parse(s) as Partial<EffectiveRetentionPolicy>};}catch{return defaults;}
  }
  setPolicy(input: Partial<RetentionPolicy> & ResourceRetentionPolicy): EffectiveRetentionPolicy {
    const next={...this.policy(),...input};
    for(const [key,value] of Object.entries(next)){
      if(typeof value!=='number'||!Number.isFinite(value)||value<0)throw new Error(`Invalid retention value for ${key}`);
    }
    if(!Number.isInteger(next.resourceMaxRows)||next.resourceMaxRows<1)throw new Error('Invalid retention value for resourceMaxRows');
    this.db.setSetting('retention_policy',JSON.stringify(next));
    return next;
  }
  private activeTaskIds():Set<string> {
    return new Set((this.db.raw.prepare("SELECT id FROM tasks WHERE status IN ('RUNNING','QUEUED','PAUSED')").all() as {id:string}[]).map(row=>row.id));
  }
  private async safeFiles(dir:string,category:DataCategory,cutoff:number,reason:string,taskId?:string):Promise<CleanupItem[]>{
    let entries;try{entries=await readdir(dir,{withFileTypes:true});}catch{return [];}const items:CleanupItem[]=[];
    for(const entry of entries){const file=path.join(dir,entry.name);if(entry.isSymbolicLink())continue;if(entry.isDirectory()){items.push(...await this.safeFiles(file,category,cutoff,reason,taskId));continue;}if(!entry.isFile())continue;try{const info=await lstat(file);if(info.mtimeMs>=cutoff)continue;const resolved=await realpath(file);if(!withinRoot(await this.rootPath(),resolved))continue;items.push({path:file,category,sizeBytes:info.size,reason,...(taskId?{taskId}:{})});}catch{/* missing or inaccessible files are reported by verification, never guessed */}}
    return items;
  }
  async preview():Promise<CleanupPreview>{
    const policy=this.policy();
    const now=Date.now();
    const items:CleanupItem[]=[];
    let protectedBytes=0;
    const temporary=await this.safeFiles(path.join(this.root,'tmp'),'temporary',now-policy.temporaryDays*86400000,'Temporary execution data exceeded retention');
    items.push(...temporary);
    for(const entry of await readdir(path.join(this.root,'tasks'),{withFileTypes:true}).catch(()=>[])){
      if(entry.name==='.'||entry.name==='..')continue;
      const base=path.join(this.root,'tasks',entry.name);
      items.push(...await this.safeFiles(path.join(base,'tmp'),'temporary',now-policy.temporaryDays*86400000,'Temporary task data exceeded retention',entry.name));
      items.push(...await this.safeFiles(path.join(base,'browser-cache'),'browser-cache',now-policy.temporaryDays*86400000,'Browser cache exceeded retention',entry.name));
    }
    const active=this.activeTaskIds();
    const protectedFiles=items.filter(item=>item.taskId&&active.has(item.taskId));
    protectedBytes+=protectedFiles.reduce((sum,item)=>sum+item.sizeBytes,0);
    const deletableFiles=items.filter(item=>!item.taskId||!active.has(item.taskId));
    const eventCutoff=new Date(now-policy.logDays*86400000).toISOString();
    const resourceCutoff=new Date(now-policy.resourceDays*86400000).toISOString();
    const oldLogs=this.db.raw.prepare(`SELECT id,task_id,LENGTH(task_id)+LENGTH(level)+LENGTH(message)+LENGTH(COALESCE(tool,''))+LENGTH(created_at) size FROM logs WHERE created_at<?`).all(eventCutoff) as unknown as MetricRow[];
    for(const row of oldLogs){
      if(row.task_id&&active.has(row.task_id)){protectedBytes+=row.size;continue;}
      deletableFiles.push({path:`sqlite:logs:${row.id}`,category:'task-logs',sizeBytes:row.size,reason:'Task log exceeded retention',...(row.task_id?{taskId:row.task_id}:{})});
    }
    const oldEvents=this.db.raw.prepare(`SELECT id,task_id,LENGTH(COALESCE(task_id,''))+LENGTH(type)+LENGTH(payload_json)+LENGTH(created_at) size FROM events WHERE created_at<?`).all(eventCutoff) as unknown as MetricRow[];
    for(const row of oldEvents){
      if(row.task_id&&active.has(row.task_id)){protectedBytes+=row.size;continue;}
      deletableFiles.push({path:`sqlite:events:${row.id}`,category:'metrics',sizeBytes:row.size,reason:'Task event exceeded retention',...(row.task_id?{taskId:row.task_id}:{})});
    }
    const oldCircuits=this.db.raw.prepare(`SELECT id,task_id,LENGTH(COALESCE(task_id,''))+LENGTH(level)+LENGTH(reason)+LENGTH(snapshot_json)+LENGTH(created_at) size FROM circuit_events WHERE created_at<?`).all(eventCutoff) as unknown as MetricRow[];
    for(const row of oldCircuits){
      if(row.task_id&&active.has(row.task_id)){protectedBytes+=row.size;continue;}
      deletableFiles.push({path:`sqlite:circuit_events:${row.id}`,category:'metrics',sizeBytes:row.size,reason:'Circuit event exceeded retention',...(row.task_id?{taskId:row.task_id}:{})});
    }
    const oldSamples=this.db.raw.prepare(`SELECT s.id,NULL task_id,LENGTH(s.source)+LENGTH(s.snapshot_json)+LENGTH(s.created_at) size FROM resource_samples s WHERE (s.created_at<? OR s.id NOT IN (SELECT id FROM resource_samples ORDER BY id DESC LIMIT ?)) AND EXISTS (SELECT 1 FROM resource_samples newer WHERE newer.source=s.source AND newer.id>s.id) ORDER BY s.id`).all(resourceCutoff,policy.resourceMaxRows) as unknown as MetricRow[];
    for(const row of oldSamples)deletableFiles.push({path:`sqlite:resource_samples:${row.id}`,category:'metrics',sizeBytes:row.size,reason:'Resource sample exceeded retention'});
    return {items:deletableFiles,totalBytes:deletableFiles.reduce((sum,item)=>sum+item.sizeBytes,0),protectedBytes,policy};
  }
  async apply():Promise<CleanupResult>{
    const preview=await this.preview();
    const active=this.activeTaskIds();
    const deleted:CleanupItem[]=[];
    const skipped:CleanupItem[]=[];
    const tables:Record<string,'logs'|'events'|'circuit_events'|'resource_samples'>={logs:'logs',events:'events',circuit_events:'circuit_events',resource_samples:'resource_samples'};
    for(const item of preview.items){
      if(item.taskId&&active.has(item.taskId)){skipped.push(item);continue;}
      const match=/^sqlite:(logs|events|circuit_events|resource_samples):(\d+)$/.exec(item.path);
      if(match){
        const table=tables[match[1]!]!;
        const id=Number(match[2]);
        if(!Number.isSafeInteger(id)){skipped.push(item);continue;}
        const latestGuard=table==='resource_samples'?' AND id NOT IN (SELECT MAX(id) FROM resource_samples GROUP BY source)':'';
        const result=this.db.raw.prepare(`DELETE FROM ${table} WHERE id=?${latestGuard}`).run(id);
        if(Number(result.changes)===0){skipped.push(item);continue;}
      }else{
        try{const resolved=await realpath(item.path);if(!withinRoot(await this.rootPath(),resolved)){skipped.push(item);continue;}await rm(item.path,{force:true});}catch{skipped.push(item);continue;}
      }
      deleted.push(item);
      this.db.raw.prepare('INSERT INTO retention_events (category,item_path,reason,size_bytes,created_at) VALUES (?,?,?,?,?)').run(item.category,item.path,item.reason,item.sizeBytes,new Date().toISOString());
    }
    return {deleted,skipped,deletedBytes:deleted.reduce((sum,item)=>sum+item.sizeBytes,0),auditId:randomUUID()};
  }
  events(limit=100){return this.db.raw.prepare('SELECT * FROM retention_events ORDER BY id DESC LIMIT ?').all(limit) as Record<string,unknown>[];}
}

import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { STAGES, type Artifact, type CreateProjectInput, type CreateTaskInput, type Evidence, type Finding, type LogEntry, type Project, type Stage, type Task, type TaskDetail, type TaskStage, type Upload } from '@reverse/contracts';
import { migrateDatabase, type MigrationResult } from './migrations.js';

export interface WorkflowEvent { id:number;taskId:string|null;type:string;payload:unknown;createdAt:string }

export class Database {
  raw: DatabaseSync;
  file: string;
  readonly migration: MigrationResult;
  constructor(file: string) {
    this.file = file;
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
    this.raw = new DatabaseSync(file);
    this.configure();
    this.migration = migrateDatabase(this.raw, file);
  }
  private configure() {
    this.raw.exec('PRAGMA busy_timeout=10000; PRAGMA foreign_keys=ON;');
    for(let attempt=0;attempt<10;attempt++){try{this.raw.exec('PRAGMA journal_mode=WAL;');break;}catch(error){if(attempt===9||!(error instanceof Error)||!error.message.includes('locked'))throw error;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100);}}
  }
  reopen(file = this.file) {
    if (this.raw.isOpen) this.raw.close();
    this.file = file;
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
    this.raw = new DatabaseSync(file);
    this.configure();
  }
  close() { this.raw.close(); }
  project(input: CreateProjectInput): Project {
    const p: Project = { id: randomUUID(), name: input.name, kind: input.kind, target: input.target ?? '', authorizationConfirmed: input.authorizationConfirmed, createdAt: new Date().toISOString() };
    this.raw.prepare('INSERT INTO projects VALUES (?,?,?,?,?,?)').run(p.id,p.name,p.kind,p.target,p.authorizationConfirmed ? 1 : 0,p.createdAt);
    return p;
  }
  getProject(id: string): Project | undefined {
    const r = this.raw.prepare('SELECT * FROM projects WHERE id=?').get(id) as Record<string, unknown> | undefined;
    return r ? this.mapProject(r) : undefined;
  }
  projects(limit=200,offset=0): Project[] { return (this.raw.prepare('SELECT * FROM projects ORDER BY created_at DESC LIMIT ? OFFSET ?').all(limit,offset) as Record<string, unknown>[]).map(r => this.mapProject(r)); }
  mapProject(r: Record<string, unknown>): Project { return { id: String(r.id), name: String(r.name), kind: String(r.kind) as Project['kind'], target: String(r.target), authorizationConfirmed: Boolean(r.authorization_confirmed), createdAt: String(r.created_at) }; }
  addUpload(p: Upload) { this.raw.prepare('INSERT INTO uploads VALUES (?,?,?,?,?,?,?,?)').run(p.id,p.projectId,p.name,p.storedName,p.mime,p.size,p.sha256,p.createdAt); }
  uploads(projectId: string): Upload[] { return (this.raw.prepare('SELECT * FROM uploads WHERE project_id=? ORDER BY created_at').all(projectId) as Record<string, unknown>[]).map(r => ({ id:String(r.id),projectId:String(r.project_id),name:String(r.name),storedName:String(r.stored_name),mime:String(r.mime),size:Number(r.size),sha256:String(r.sha256),createdAt:String(r.created_at) })); }
  createTask(projectId: string, adapter: string, input: CreateTaskInput, inputHash: string): Task {
    const now = new Date().toISOString();
    const t: Task = { id: randomUUID(), projectId, adapter: input.adapter, status:'QUEUED', currentStage:'INTAKE', progress:0, currentTool:null, attempt:0, inputHash, options:input.options ?? {}, createdAt:now, updatedAt:now, pauseRequested:false, cancelRequested:false };
    this.raw.prepare('INSERT INTO tasks (id,project_id,adapter,status,current_stage,progress,current_tool,attempt,input_hash,options_json,created_at,updated_at,started_at,ended_at,error,pause_requested,cancel_requested) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(t.id,t.projectId,t.adapter,t.status,t.currentStage,t.progress,t.currentTool,t.attempt,t.inputHash,JSON.stringify(t.options),t.createdAt,t.updatedAt,null,null,null,0,0);
    const ins = this.raw.prepare('INSERT INTO stages (task_id,name,status,attempt) VALUES (?,?,?,?)');
    for (const name of STAGES) ins.run(t.id,name,'PENDING',0);
    return t;
  }
  getTask(id: string): Task | undefined { const r = this.raw.prepare('SELECT * FROM tasks WHERE id=?').get(id) as Record<string, unknown> | undefined; return r ? this.mapTask(r) : undefined; }
  tasks(limit=200,offset=0): Task[] { return (this.raw.prepare('SELECT * FROM tasks ORDER BY created_at DESC LIMIT ? OFFSET ?').all(limit,offset) as Record<string, unknown>[]).map(r => this.mapTask(r)); }
  allTasks(): Task[] { return (this.raw.prepare('SELECT * FROM tasks ORDER BY created_at DESC, rowid DESC').all() as Record<string, unknown>[]).map(r => this.mapTask(r)); }
  projectTasks(projectId: string): Task[] { return (this.raw.prepare('SELECT * FROM tasks WHERE project_id=? ORDER BY created_at DESC, rowid DESC').all(projectId) as Record<string, unknown>[]).map(r => this.mapTask(r)); }
  mapTask(r: Record<string, unknown>): Task { return { id:String(r.id),projectId:String(r.project_id),adapter:String(r.adapter) as Task['adapter'],status:String(r.status) as Task['status'],currentStage:String(r.current_stage) as Stage,progress:Number(r.progress),currentTool:r.current_tool ? String(r.current_tool) : null,attempt:Number(r.attempt),inputHash:String(r.input_hash),options:JSON.parse(String(r.options_json)) as Record<string,unknown>,createdAt:String(r.created_at),updatedAt:String(r.updated_at),...(r.started_at ? {startedAt:String(r.started_at)} : {}),...(r.ended_at ? {endedAt:String(r.ended_at)} : {}),...(r.error ? {error:String(r.error)} : {}),pauseRequested:Boolean(r.pause_requested),cancelRequested:Boolean(r.cancel_requested) }; }
  updateTask(id: string, values: Partial<Record<'status'|'current_stage'|'progress'|'current_tool'|'attempt'|'updated_at'|'started_at'|'ended_at'|'error'|'pause_requested'|'cancel_requested', SQLInputValue>>) {
    const entries = Object.entries(values).filter(([,v]) => v !== undefined);
    if (!entries.length) return;
    entries.push(['updated_at', new Date().toISOString()]);
    this.raw.prepare(`UPDATE tasks SET ${entries.map(([k]) => `${k}=?`).join(',')} WHERE id=?`).run(...entries.map(([,v]) => v), id);
    this.addEvent(id,'task.updated',this.getTask(id));
  }
  stages(taskId: string): TaskStage[] { return (this.raw.prepare('SELECT * FROM stages WHERE task_id=? ORDER BY rowid').all(taskId) as Record<string,unknown>[]).map(r => ({ name:String(r.name) as Stage,status:String(r.status) as TaskStage['status'],attempt:Number(r.attempt),...(r.started_at?{startedAt:String(r.started_at)}:{}),...(r.ended_at?{endedAt:String(r.ended_at)}:{}),...(r.error?{error:String(r.error)}:{}),...(r.cache_key?{cacheKey:String(r.cache_key)}:{}) })); }
  setStage(taskId: string, name: Stage, values: Record<string, SQLInputValue>) { const entries=Object.entries(values); this.raw.prepare(`UPDATE stages SET ${entries.map(([k])=>`${k}=?`).join(',')} WHERE task_id=? AND name=?`).run(...entries.map(([,v])=>v),taskId,name); this.addEvent(taskId,'stage.updated',{name,status:values.status}); }
  setStageOutput(taskId: string, name: Stage, output: unknown) { this.setStage(taskId,name,{output_json:JSON.stringify(output)}); }
  stageOutput(taskId: string, name: Stage): unknown { const r=this.raw.prepare('SELECT output_json FROM stages WHERE task_id=? AND name=?').get(taskId,name) as {output_json:string|null}|undefined; return r?.output_json ? JSON.parse(r.output_json) : undefined; }
  addEvidence(e: Omit<Evidence,'id'|'createdAt'>): Evidence { const item={...e,id:randomUUID(),createdAt:new Date().toISOString()}; this.raw.prepare('INSERT INTO evidence VALUES (?,?,?,?,?,?,?,?,?)').run(item.id,item.taskId,item.kind,item.title,item.source,item.locator,JSON.stringify(item.content),item.sha256,item.createdAt); return item; }
  evidence(taskId: string,limit=1000,offset=0): Evidence[] { return (this.raw.prepare('SELECT * FROM evidence WHERE task_id=? ORDER BY created_at,rowid LIMIT ? OFFSET ?').all(taskId,limit,offset) as Record<string,unknown>[]).map(r=>({id:String(r.id),taskId:String(r.task_id),kind:String(r.kind) as Evidence['kind'],title:String(r.title),source:String(r.source),locator:String(r.locator),content:JSON.parse(String(r.content_json)),sha256:String(r.sha256),createdAt:String(r.created_at)})); }
  evidenceById(id:string):Evidence|undefined{const r=this.raw.prepare('SELECT * FROM evidence WHERE id=?').get(id) as Record<string,unknown>|undefined;return r?{id:String(r.id),taskId:String(r.task_id),kind:String(r.kind) as Evidence['kind'],title:String(r.title),source:String(r.source),locator:String(r.locator),content:JSON.parse(String(r.content_json)),sha256:String(r.sha256),createdAt:String(r.created_at)}:undefined;}
  addFinding(f: Omit<Finding,'id'>): Finding { const item={...f,id:randomUUID()}; this.raw.prepare('INSERT INTO findings VALUES (?,?,?,?,?,?,?,?,?,?)').run(item.id,item.taskId,item.title,item.category,item.severity,item.confidence,JSON.stringify(item.evidenceIds),item.details,item.recommendation,item.status); return item; }
  findings(taskId: string): Finding[] { return (this.raw.prepare('SELECT * FROM findings WHERE task_id=? ORDER BY severity').all(taskId) as Record<string,unknown>[]).map(r=>({id:String(r.id),taskId:String(r.task_id),title:String(r.title),category:String(r.category),severity:String(r.severity) as Finding['severity'],confidence:Number(r.confidence),evidenceIds:JSON.parse(String(r.evidence_ids_json)) as string[],details:String(r.details),recommendation:String(r.recommendation),status:String(r.status) as Finding['status']})); }
  log(taskId: string, level: LogEntry['level'], message: string, tool?: string): LogEntry { const item:LogEntry={id:0,taskId,level,message,...(tool?{tool}:{}),createdAt:new Date().toISOString()}; const result=this.raw.prepare('INSERT INTO logs (task_id,level,message,tool,created_at) VALUES (?,?,?,?,?)').run(taskId,level,message,tool??null,item.createdAt); item.id=Number(result.lastInsertRowid); this.addEvent(taskId,'log',item); return item; }
  logs(taskId: string): LogEntry[] { return (this.raw.prepare('SELECT * FROM logs WHERE task_id=? ORDER BY id LIMIT 1000').all(taskId) as Record<string,unknown>[]).map(r=>({id:Number(r.id),taskId:String(r.task_id),level:String(r.level) as LogEntry['level'],message:String(r.message),...(r.tool?{tool:String(r.tool)}:{}),createdAt:String(r.created_at)})); }
  addArtifact(taskId: string, name: string, storedPath: string, size: number, sha256: string, mime: string) { this.raw.prepare('INSERT INTO artifacts (id,task_id,name,stored_path,size,sha256,mime,created_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(task_id,name) DO UPDATE SET id=excluded.id,stored_path=excluded.stored_path,size=excluded.size,sha256=excluded.sha256,mime=excluded.mime,created_at=excluded.created_at').run(randomUUID(),taskId,name,storedPath,size,sha256,mime,new Date().toISOString()); }
  artifacts(taskId: string): Artifact[] { return (this.raw.prepare('SELECT * FROM artifacts WHERE task_id=? ORDER BY created_at').all(taskId) as Record<string,unknown>[]).map(r=>({name:String(r.name),size:Number(r.size),sha256:String(r.sha256),mime:String(r.mime),downloadPath:`/api/tasks/${taskId}/artifacts/${encodeURIComponent(String(r.name))}`})); }
  artifactPath(taskId: string, name: string): string | undefined { const r=this.raw.prepare('SELECT stored_path FROM artifacts WHERE task_id=? AND name=?').get(taskId,name) as {stored_path:string}|undefined; return r?.stored_path; }
  addEvent(taskId:string|null,type:string,payload:unknown):number { const result=this.raw.prepare('INSERT INTO events (task_id,type,payload_json,created_at) VALUES (?,?,?,?)').run(taskId,type,JSON.stringify(payload),new Date().toISOString()); return Number(result.lastInsertRowid); }
  eventsAfter(id:number, limit?:number): WorkflowEvent[];
  eventsAfter(taskId:string, id:number, limit?:number): WorkflowEvent[];
  eventsAfter(taskIdOrId:string|number, idOrLimit?:number, limit=200): WorkflowEvent[] {
    const taskScoped = typeof taskIdOrId === 'string';
    const id = taskScoped ? Number(idOrLimit ?? 0) : Number(taskIdOrId);
    const pageSize = taskScoped ? limit : Number(idOrLimit ?? 200);
    const rows = taskScoped
      ? this.raw.prepare('SELECT * FROM events WHERE task_id=? AND id>? ORDER BY id LIMIT ?').all(taskIdOrId,id,pageSize) as Record<string,unknown>[]
      : this.raw.prepare('SELECT * FROM events WHERE id>? ORDER BY id LIMIT ?').all(id,pageSize) as Record<string,unknown>[];
    return rows.map(r=>({id:Number(r.id),taskId:r.task_id?String(r.task_id):null,type:String(r.type),payload:JSON.parse(String(r.payload_json)),createdAt:String(r.created_at)}));
  }
  settings(): Record<string,string> { return Object.fromEntries((this.raw.prepare('SELECT key,value FROM settings').all() as Record<string,unknown>[]).map(r=>[String(r.key),String(r.value)])); }
  setSetting(key: string, value: string) { this.raw.prepare('INSERT OR REPLACE INTO settings VALUES (?,?)').run(key,value); }
  detail(id: string, report?: string): TaskDetail | undefined { const t=this.getTask(id); if(!t) return; const p=this.getProject(t.projectId); if(!p) return; return {...t,stages:this.stages(id),evidence:this.evidence(id),findings:this.findings(id),logs:this.logs(id),artifacts:this.artifacts(id),...(report?{report}:{}),project:p,uploads:this.uploads(p.id)}; }
  stats() { const one=(q:string,p:string[]=[])=>Number((this.raw.prepare(q).get(...p) as {n:number}).n); return {projects:one('SELECT COUNT(*) n FROM projects'),tasks:one('SELECT COUNT(*) n FROM tasks'),running:one("SELECT COUNT(*) n FROM tasks WHERE status='RUNNING'"),completed:one("SELECT COUNT(*) n FROM tasks WHERE status='COMPLETED'"),failed:one("SELECT COUNT(*) n FROM tasks WHERE status IN ('FAILED','BLOCKED')"),evidence:one('SELECT COUNT(*) n FROM evidence'),findings:one('SELECT COUNT(*) n FROM findings'),highFindings:one("SELECT COUNT(*) n FROM findings WHERE severity IN ('high','critical')")}; }
}

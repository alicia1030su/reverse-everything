import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AnalysisCache, Database, ResourceMonitor, DEFAULT_RESOURCE_THRESHOLDS, WorkflowEngine, type AdapterDefinition } from '@reverse/workflow';

const dirs:string[]=[];
afterEach(async()=>{for(const dir of dirs.splice(0))await rm(dir,{recursive:true,force:true});});
async function temp(){const dir=await mkdtemp(path.join(os.tmpdir(),'re-v004-runtime-'));dirs.push(dir);return dir;}
function adapter(overrides:Partial<AdapterDefinition>={}):AdapterDefinition{return {name:'file',version:'test',description:'test',available:async()=>({available:true,detail:'test'}),detect:async()=>({adapter:'file',confidence:1,format:'test',details:{},limitations:[]}),prepare:async()=>({prepared:true}),analyze:async()=>({ok:true}),extractEvidence:async()=>({}),reconstruct:async()=>({}),validate:async()=>({passed:true,checks:[]}),...overrides};}
function project(db:Database){return db.project({name:'runtime-regression',kind:'software',authorizationConfirmed:true});}

describe('workflow runtime regressions',()=>{
  it('applies refreshed artifact budgets to the next task without overriding a smaller task budget',async()=>{
    const dataDir=await temp();const db=new Database(':memory:');
    const engine=new WorkflowEngine(db,{dataDir,adapters:[adapter({prepare:async ctx=>{await ctx.writeArtifact('large.bin',new Uint8Array(512*1024),'application/octet-stream');return {prepared:true};}})],maxDiskMB:1});
    const p=project(db);const first=await engine.create(p.id,{adapter:'file'});await engine.execute(first.id);expect(db.getTask(first.id)?.status).toBe('COMPLETED');
    engine.refreshBudgets({maxDiskMB:0.25});
    const second=await engine.create(p.id,{adapter:'file'});await engine.execute(second.id);expect(db.getTask(second.id)?.status).toBe('FAILED');expect(db.getTask(second.id)?.error).toMatch(/artifact budget/i);
    const explicit=await engine.create(p.id,{adapter:'file',options:{maxDiskMB:0.125}});await engine.execute(explicit.id);expect(db.getTask(explicit.id)?.error).toMatch(/artifact budget/i);
    db.close();
  });

  it('clamps task-supplied budgets to worker hard limits and injects the effective values',async()=>{
    const dataDir=await temp();const db=new Database(':memory:');let effective:{disk?:number;memory?:number;timeout?:number}|undefined;
    const engine=new WorkflowEngine(db,{dataDir,adapters:[adapter({prepare:async ctx=>{effective={disk:ctx.effectiveMaxDiskMB,memory:ctx.effectiveMaxMemoryMB,timeout:ctx.effectiveTimeoutMs};await ctx.writeArtifact('too-large.bin',new Uint8Array(512*1024),'application/octet-stream');return {prepared:true};}})],maxDiskMB:0.25,timeoutMs:1000,thresholds:{softRssMb:50,hardRssMb:100}});
    const p=project(db);const task=await engine.create(p.id,{adapter:'file',options:{maxDiskMB:10,maxMemoryMB:1000,timeoutMs:10000}});await engine.execute(task.id);
    expect(effective).toEqual({disk:0.25,memory:100,timeout:1000});expect(db.getTask(task.id)?.status).toBe('FAILED');expect(db.getTask(task.id)?.error).toMatch(/artifact budget/i);db.close();
  });

  it('does not leave RUNNING with a NULL lease when an owned stage loses its lease without a takeover',async()=>{
    const dataDir=await temp();const db=new Database(':memory:');let release!:()=>void;let entered!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);const started=new Promise<void>(resolve=>entered=resolve);
    const engine=new WorkflowEngine(db,{dataDir,adapters:[adapter({prepare:async()=>{entered();await gate;return {prepared:true};}})],leaseMs:10000});
    const p=project(db);const task=await engine.create(p.id,{adapter:'file'});const running=engine.execute(task.id);await started;
    db.raw.prepare("UPDATE tasks SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(task.id);release();await running;
    expect(db.getTask(task.id)?.status).toBe('FAILED');
    const row=db.raw.prepare('SELECT status,lease_owner,lease_expires_at FROM tasks WHERE id=?').get(task.id) as {status:string;lease_owner:string|null;lease_expires_at:string|null};
    expect(row).toMatchObject({status:'FAILED',lease_owner:null,lease_expires_at:null});expect(db.getTask(task.id)?.error).toMatch(/lease/i);db.close();
  });

  it('does not rewrite cache payloads or refresh absolute TTL on a hit',async()=>{
    const dataDir=await temp();const db=new Database(':memory:');const cache=new AnalysisCache(db,dataDir);const engine=new WorkflowEngine(db,{dataDir,adapters:[adapter()],cache});const p=project(db);
    await engine.execute((await engine.create(p.id,{adapter:'file'})).id);
    const before=cache.list().items.map(item=>({key:item.key,expiresAt:item.expiresAt,path:(db.raw.prepare('SELECT payload_path FROM cache_entries WHERE key=?').get(item.key) as {payload_path:string}).payload_path}));
    const writes=cache.statistics().writes;const mtimes=await Promise.all(before.map(async item=>(await stat(item.path)).mtimeMs));expect(before).toHaveLength(3);expect(writes).toBe(3);
    await engine.execute((await engine.create(p.id,{adapter:'file'})).id);
    expect(cache.statistics().writes).toBe(writes);
    for(const [index,item] of before.entries()){expect(cache.list().items.find(entry=>entry.key===item.key)?.expiresAt).toBe(item.expiresAt);expect((await stat(item.path)).mtimeMs).toBe(mtimes[index]);}
    db.close();
  });

  it('uses complete evidence for reports, manifests and evidence exports beyond the display page',async()=>{
    const dataDir=await temp();const db=new Database(':memory:');const engine=new WorkflowEngine(db,{dataDir,adapters:[adapter()]});const p=project(db);const task=await engine.create(p.id,{adapter:'file'});
    for(let index=0;index<1001;index++)db.addEvidence({taskId:task.id,kind:'EVIDENCE',title:`bulk-${index}`,source:'fixture',locator:`bulk:${index}`,content:{index},sha256:`hash-${index}`});
    await engine.execute(task.id);expect(db.getTask(task.id)?.status).toBe('COMPLETED');
    const manifest=JSON.parse(await readFile(path.join(dataDir,'tasks',task.id,'manifest.json'),'utf8')) as {evidence:unknown[]};
    const exported=JSON.parse(await readFile(db.artifactPath(task.id,'evidence.json')!,'utf8')) as unknown[];
    const report=await readFile(db.artifactPath(task.id,'report.md')!,'utf8');
    expect(manifest.evidence.length).toBeGreaterThanOrEqual(1001);expect(exported).toHaveLength(manifest.evidence.length);expect(report).toContain('bulk-1000');db.close();
  });

  it('hot-refreshes resource row retention and the disk warning threshold',async()=>{
    const dataDir=await temp();const db=new Database(':memory:');let diskAvailable=100;
    const monitor=new ResourceMonitor(db,dataDir,{...DEFAULT_RESOURCE_THRESHOLDS,minDiskFreeBytes:0},{processSampler:async()=>[{pid:process.pid,ppid:process.ppid,rssMB:10,cpuSeconds:0,name:'node'}],diskSampler:async()=>({dataDirBytes:1,diskAvailableBytes:diskAvailable,limitations:[]}),systemSampler:()=>({systemFreeMemoryMB:8192,systemTotalMemoryMB:16384}),resourceRetention:{maxRows:2}});
    for(let index=0;index<4;index++)await monitor.sample('api',{fresh:true});expect((db.raw.prepare('SELECT COUNT(*) n FROM resource_samples').get() as {n:number}).n).toBe(2);
    monitor.refreshRetention({maxRows:1,minDiskFreeBytes:1000});diskAvailable=500;const snapshot=await monitor.sample('api',{fresh:true});
    expect((db.raw.prepare('SELECT COUNT(*) n FROM resource_samples').get() as {n:number}).n).toBe(1);expect(snapshot.pressure).toBe('danger');db.close();
  });
});

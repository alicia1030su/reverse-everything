import { access, mkdir, mkdtemp, readFile, rename, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Database } from '../../packages/workflow/src/database.js';
import { RetentionService } from '../../packages/workflow/src/retention.js';

const rmGate=vi.hoisted(()=>({file:undefined as string|undefined,entered:undefined as (()=>void)|undefined,release:undefined as (()=>void)|undefined,wait:undefined as Promise<void>|undefined,onEnter:undefined as (()=>void|Promise<void>)|undefined}));
vi.mock('node:fs/promises',async importOriginal=>{
  const actual=await importOriginal<typeof import('node:fs/promises')>();
  return {...actual,realpath:async(...args:Parameters<typeof actual.realpath>)=>{
    if(realpathGate.file===String(args[0])&&++realpathGate.calls===2){const entered=realpathGate.entered;const onEnter=realpathGate.onEnter;realpathGate.entered=undefined;realpathGate.onEnter=undefined;entered?.();await onEnter?.();await realpathGate.wait;}
    return actual.realpath(...args);
  },rm:async(...args:Parameters<typeof actual.rm>)=>{
    if(rmGate.file===String(args[0])){
      const entered=rmGate.entered;const onEnter=rmGate.onEnter;rmGate.entered=undefined;rmGate.onEnter=undefined;
      entered?.();await onEnter?.();await rmGate.wait;
    }
    return actual.rm(...args);
  }};
});
const realpathGate=vi.hoisted(()=>({file:undefined as string|undefined,calls:0,entered:undefined as (()=>void)|undefined,release:undefined as (()=>void)|undefined,wait:undefined as Promise<void>|undefined,onEnter:undefined as (()=>void|Promise<void>)|undefined}));
const workerHarness=vi.hoisted(()=>({policy:{cacheMaxBytes:1024,cacheDays:2,resourceDays:3,resourceMaxRows:4,taskArtifactMaxBytes:2*1048576,diskWarningFreeBytes:5*1048576},engineOptions:undefined as Record<string,unknown>|undefined,cacheConfigure:vi.fn(),refreshRetention:vi.fn(),refreshBudgets:vi.fn(),policyReads:vi.fn()}));
vi.mock('@reverse/workflow',()=>{
  class Database{raw={};migration={version:3};settings(){return {};}close(){}}
  class RetentionService{policy(){workerHarness.policyReads();return {...workerHarness.policy};}}
  class AnalysisCache{configure=workerHarness.cacheConfigure;}
  class ResourceMonitor{refreshRetention=workerHarness.refreshRetention;}
  class WorkflowEngine{constructor(_db:unknown,options:Record<string,unknown>){workerHarness.engineOptions=options;}start(){}close=async()=>{};refreshBudgets=workerHarness.refreshBudgets;}
  return {Database,RetentionService,AnalysisCache,ResourceMonitor,WorkflowEngine};
});
vi.mock('@reverse/core',()=>({adapters:[]}));
vi.mock('@reverse/security',()=>({decryptSecret:async()=>'',encryptionKey:async()=>Buffer.alloc(32)}));
const dirs:string[]=[];const originalWorkerDiskMB=process.env.RE_TASK_MAX_DISK_MB;
afterEach(async()=>{rmGate.release?.();realpathGate.release?.();rmGate.release=undefined;rmGate.wait=undefined;rmGate.entered=undefined;rmGate.onEnter=undefined;rmGate.file=undefined;realpathGate.release=undefined;realpathGate.wait=undefined;realpathGate.entered=undefined;realpathGate.onEnter=undefined;realpathGate.file=undefined;realpathGate.calls=0;vi.restoreAllMocks();if(originalWorkerDiskMB===undefined)delete process.env.RE_TASK_MAX_DISK_MB;else process.env.RE_TASK_MAX_DISK_MB=originalWorkerDiskMB;for(const dir of dirs.splice(0))await rm(dir,{recursive:true,force:true});});
async function setup(){
  const dir=await mkdtemp(path.join(os.tmpdir(),'re-retention-'));dirs.push(dir);const db=new Database(':memory:');const retention=new RetentionService(db,dir);retention.setPolicy({logDays:1,temporaryDays:1,resourceDays:1});
  const project=db.project({name:'retention-race',kind:'software',authorizationConfirmed:true});const task=db.createTask(project.id,'file',{adapter:'file'},'hash');db.updateTask(task.id,{status:'COMPLETED'});
  const old=new Date(Date.now()-3*86400000).toISOString();return {dir,db,retention,task,old};
}
function activateDuringDelete(db:Database,table:string,taskId:string){
  const original=db.raw.prepare.bind(db.raw);let injected=false;
  vi.spyOn(db.raw,'prepare').mockImplementation(((sql:string)=>{
    const statement=original(sql);if(!injected&&sql.startsWith(`DELETE FROM ${table} `)){
      const run=statement.run.bind(statement);
      statement.run=((...args:unknown[])=>{if(!injected){injected=true;db.updateTask(taskId,{status:'RUNNING'});}return run(...args);}) as typeof statement.run;
    }
    return statement;
  }) as typeof db.raw.prepare);
}

describe('worker retention hot reload',()=>{
  it('applies the initial policy and refreshes every component at a bounded low frequency',async()=>{
    delete process.env.RE_TASK_MAX_DISK_MB;vi.useFakeTimers();vi.resetModules();workerHarness.engineOptions=undefined;workerHarness.cacheConfigure.mockClear();workerHarness.refreshRetention.mockClear();workerHarness.refreshBudgets.mockClear();workerHarness.policyReads.mockClear();
    await import('../../apps/worker/src/worker.js');
    expect(workerHarness.engineOptions?.maxDiskMB).toBe(2);
    expect(workerHarness.cacheConfigure).toHaveBeenLastCalledWith({maxBytes:1024,ttlDays:2});expect(workerHarness.refreshRetention).toHaveBeenLastCalledWith({days:3,maxRows:4,minDiskFreeBytes:5*1048576});expect(workerHarness.refreshBudgets).toHaveBeenLastCalledWith({maxDiskMB:2});expect(workerHarness.policyReads).toHaveBeenCalledTimes(2);
    workerHarness.cacheConfigure.mockClear();workerHarness.refreshRetention.mockClear();workerHarness.refreshBudgets.mockClear();
    workerHarness.policy={...workerHarness.policy,cacheMaxBytes:2048,cacheDays:4,resourceDays:6,resourceMaxRows:8,taskArtifactMaxBytes:3*1048576};
    await vi.advanceTimersByTimeAsync(29999);expect(workerHarness.policyReads).toHaveBeenCalledTimes(2);expect(workerHarness.cacheConfigure).not.toHaveBeenCalled();expect(workerHarness.refreshRetention).not.toHaveBeenCalled();expect(workerHarness.refreshBudgets).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(workerHarness.cacheConfigure).toHaveBeenLastCalledWith({maxBytes:2048,ttlDays:4});
    expect(workerHarness.refreshRetention).toHaveBeenLastCalledWith({days:6,maxRows:8,minDiskFreeBytes:5*1048576});
    expect(workerHarness.refreshBudgets).toHaveBeenLastCalledWith(expect.objectContaining({maxDiskMB:3}));
    await vi.advanceTimersByTimeAsync(30000);expect(workerHarness.policyReads).toHaveBeenCalledTimes(4);expect(workerHarness.cacheConfigure).toHaveBeenCalledTimes(2);expect(workerHarness.refreshRetention).toHaveBeenCalledTimes(2);expect(workerHarness.refreshBudgets).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});

describe('retention apply races',()=>{
  it.each(['logs','events','circuit_events'] as const)('rechecks active task state in the delete transaction for %s',async table=>{
    const {db,retention,task,old}=await setup();
    if(table==='logs')db.raw.prepare('INSERT INTO logs (task_id,level,message,created_at) VALUES (?,?,?,?)').run(task.id,'info','historical',old);
    if(table==='events')db.raw.prepare('INSERT INTO events (task_id,type,payload_json,created_at) VALUES (?,?,?,?)').run(task.id,'historical','{}',old);
    if(table==='circuit_events')db.raw.prepare('INSERT INTO circuit_events (task_id,level,reason,snapshot_json,created_at) VALUES (?,?,?,?,?)').run(task.id,'pressure','historical','{}',old);
    const before=Number((db.raw.prepare(`SELECT COUNT(*) n FROM ${table} WHERE created_at=?`).get(old) as {n:number}).n);expect(before).toBe(1);
    activateDuringDelete(db,table,task.id);
    const result=await retention.apply();
    const remaining=Number((db.raw.prepare(`SELECT COUNT(*) n FROM ${table} WHERE created_at=?`).get(old) as {n:number}).n);expect(remaining).toBe(1);
    expect(result.deleted).toEqual([]);expect(result.skipped).toHaveLength(1);expect(retention.events()).toEqual([]);
    db.close();
  });

  it('rechecks that a resource sample is not the latest snapshot inside the delete transaction',async()=>{
    const {db,retention,old}=await setup();const recent=new Date().toISOString();
    db.raw.prepare('INSERT INTO resource_samples (source,snapshot_json,created_at) VALUES (?,?,?)').run('api','{}',old);
    db.raw.prepare('INSERT INTO resource_samples (source,snapshot_json,created_at) VALUES (?,?,?)').run('api','{}',recent);
    const original=db.raw.prepare.bind(db.raw);let injected=false;
    vi.spyOn(db.raw,'prepare').mockImplementation(((sql:string)=>{
      const statement=original(sql);if(!injected&&sql.startsWith('DELETE FROM resource_samples ')){
        const run=statement.run.bind(statement);statement.run=((...args:unknown[])=>{if(!injected){injected=true;db.raw.prepare('DELETE FROM resource_samples WHERE id=(SELECT MAX(id) FROM resource_samples)').run();}return run(...args);}) as typeof statement.run;
      }
      return statement;
    }) as typeof db.raw.prepare);
    const result=await retention.apply();
    expect((db.raw.prepare('SELECT COUNT(*) n FROM resource_samples').get() as {n:number}).n).toBe(1);
    expect(result.deleted).toEqual([]);expect(result.skipped).toHaveLength(1);db.close();
  });

  it('rechecks task activity after the path-resolution await before deleting historical task files',async()=>{
    const {dir,db,retention,task,old}=await setup();const tmp=path.join(dir,'tasks',task.id,'tmp');await mkdir(tmp,{recursive:true});const file=path.join(tmp,'history.log');await writeFile(file,'history');const stale=new Date(old);await utimes(file,stale,stale);
    let entered!:()=>void;let release!:()=>void;const enteredPromise=new Promise<void>(resolve=>{entered=resolve;});realpathGate.wait=new Promise<void>(resolve=>{release=resolve;});realpathGate.release=release;realpathGate.file=file;realpathGate.entered=entered;
    const applying=retention.apply();await enteredPromise;db.updateTask(task.id,{status:'RUNNING'});release();const result=await applying;
    expect(await readFile(file,'utf8')).toBe('history');expect(result.deleted).toEqual([]);expect(result.skipped).toHaveLength(1);db.close();
  });

  it('rechecks file identity after path resolution and preserves a replacement at the previewed path',async()=>{
    const {dir,db,retention,old}=await setup();const tmp=path.join(dir,'tmp');await mkdir(tmp,{recursive:true});const file=path.join(tmp,'history.log');await writeFile(file,'history');const stale=new Date(old);await utimes(file,stale,stale);
    let entered!:()=>void;let release!:()=>void;const enteredPromise=new Promise<void>(resolve=>{entered=resolve;});realpathGate.wait=new Promise<void>(resolve=>{release=resolve;});realpathGate.release=release;realpathGate.file=file;realpathGate.entered=entered;realpathGate.onEnter=async()=>{await rename(file,`${file}.moved`);await writeFile(file,'replacement');};
    const applying=retention.apply();await enteredPromise;release();const result=await applying;
    expect(await readFile(file,'utf8')).toBe('replacement');expect(result.deleted).toEqual([]);expect(result.skipped).toHaveLength(1);await expect(access(`${file}.moved`)).resolves.toBeUndefined();db.close();
  });

  it('does not reuse the pre-rm active snapshot for later SQLite deletions',async()=>{
    const {dir,db,retention,task,old}=await setup();const tmp=path.join(dir,'tmp');await mkdir(tmp,{recursive:true});const file=path.join(tmp,'old.tmp');await writeFile(file,'old');const stale=new Date(old);await utimes(file,stale,stale);
    db.raw.prepare('INSERT INTO logs (task_id,level,message,created_at) VALUES (?,?,?,?)').run(task.id,'info','historical',old);
    db.raw.prepare('INSERT INTO events (task_id,type,payload_json,created_at) VALUES (?,?,?,?)').run(task.id,'historical','{}',old);
    let entered!:()=>void;let release!:()=>void;const enteredPromise=new Promise<void>(resolve=>{entered=resolve;});rmGate.wait=new Promise<void>(resolve=>{release=resolve;});rmGate.release=release;rmGate.file=file;rmGate.entered=entered;
    const applying=retention.apply();await enteredPromise;db.updateTask(task.id,{status:'RUNNING'});release();const result=await applying;
    expect(Number((db.raw.prepare('SELECT COUNT(*) n FROM logs WHERE created_at=?').get(old) as {n:number}).n)).toBe(1);
    expect(Number((db.raw.prepare('SELECT COUNT(*) n FROM events WHERE created_at=?').get(old) as {n:number}).n)).toBe(1);
    expect(result.deleted.map(item=>item.path)).toEqual([file]);expect(result.skipped).toHaveLength(2);db.close();
  });
});

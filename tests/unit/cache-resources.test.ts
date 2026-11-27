import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ResourceProcess } from '@reverse/contracts';
import { AnalysisCache } from '../../packages/workflow/src/cache.js';
import { Database } from '../../packages/workflow/src/database.js';
import { DEFAULT_RESOURCE_SAMPLE_RETENTION, DEFAULT_RESOURCE_THRESHOLDS, ResourceMonitor, effectiveResourceThresholds } from '../../packages/workflow/src/resources.js';
import { RetentionService } from '../../packages/workflow/src/retention.js';
import { afterEach, describe, expect, it } from 'vitest';

const dirs:string[]=[];
afterEach(async()=>{for(const dir of dirs.splice(0))await rm(dir,{recursive:true,force:true});});
async function temp(){const dir=await mkdtemp(path.join(os.tmpdir(),'re-v003-cache-resources-'));dirs.push(dir);return dir;}
const diskSample={dataDirBytes:1234,diskAvailableBytes:987654,limitations:[]};
function processSample(rssMB:number,cpuSeconds=0):ResourceProcess[]{return [{pid:process.pid,ppid:process.ppid,rssMB,cpuSeconds,name:'node'}];}

describe('AnalysisCache concurrency and references',()=>{
  it('keeps 500 concurrent cross-instance writes within the byte budget',async()=>{
    const dir=await temp();
    const file=path.join(dir,'shared.sqlite');
    const firstDb=new Database(file);
    const secondDb=new Database(file);
    const first=new AnalysisCache(firstDb,dir,{maxBytes:4096});
    const second=new AnalysisCache(secondDb,dir,{maxBytes:4096});
    await Promise.all(Array.from({length:500},(_,i)=>((i%2?second:first).put(`key-${i}`,'project','p','file','ANALYZE',{i,payload:'x'.repeat(120)}))));
    expect(first.statistics().sizeBytes).toBeLessThanOrEqual(4096);
    expect(second.statistics().sizeBytes).toBe(first.statistics().sizeBytes);
    expect(first.statistics().entries).toBeGreaterThan(0);
    firstDb.close();secondDb.close();
  });

  it('coalesces same-key reads and writes and records one hit or miss per flight',async()=>{
    const dir=await temp();const db=new Database(':memory:');const cache=new AnalysisCache(db,dir);
    const missingA=cache.get('missing');const missingB=cache.get('missing');
    expect(missingA).toBe(missingB);
    await Promise.all([missingA,missingB]);
    expect(cache.statistics().misses).toBe(1);
    const putA=cache.put('same','project','p','file','CLASSIFY',{value:1});
    const putB=cache.put('same','project','p','file','CLASSIFY',{value:2});
    expect(putA).toBe(putB);
    await Promise.all([putA,putB]);
    expect(cache.statistics().writes).toBe(1);
    const reads=Array.from({length:10},()=>cache.get('same'));
    expect(new Set(reads).size).toBe(1);
    expect(await Promise.all(reads)).toEqual(Array.from({length:10},()=>({value:1})));
    expect(cache.statistics().hits).toBe(1);
    expect(cache.statistics().hitRate).toBe(0.5);
    expect(cache.list().items[0]).toMatchObject({kind:'static-analysis',refCount:0});
    db.close();
  });

  it('never evicts referenced entries and reports clear skips until release',async()=>{
    const dir=await temp();const db=new Database(':memory:');const cache=new AnalysisCache(db,dir,{maxBytes:260});
    await cache.put('protected','project','p','file','ANALYZE',{payload:'x'.repeat(100)});
    const release=cache.acquire('protected');
    expect(cache.list().items[0]?.refCount).toBe(1);
    await cache.put('old','project','p','file','PREPARE',{payload:'y'.repeat(100)});
    await cache.put('new','project','p','file','PREPARE',{payload:'z'.repeat(100)});
    expect(cache.list().items.map(item=>item.key).sort()).toEqual(['new','protected']);
    expect(cache.statistics().sizeBytes).toBeLessThanOrEqual(260);
    const preview=await cache.clear({dryRun:true});
    expect(preview.items.map(item=>item.key)).toEqual(['new']);
    expect(preview.skipped.map(item=>item.key)).toEqual(['protected']);
    const cleared=await cache.clear();
    expect(cleared.skipped.map(item=>item.key)).toEqual(['protected']);
    expect(await cache.get('protected')).toEqual({payload:'x'.repeat(100)});
    release();release();
    expect(cache.list().items[0]?.refCount).toBe(0);
    await cache.clear();
    expect(cache.statistics().entries).toBe(0);
    db.close();
  });

  it('allows an explicit kind override without changing the six-argument API',async()=>{
    const dir=await temp();const db=new Database(':memory:');const cache=new AnalysisCache(db,dir);
    await cache.put('override','project','p','file','ANALYZE',{value:1},'ai-inference');
    await cache.put('ignored','project','p','file','REPORT',{value:2},'validation');
    expect(cache.list().items.map(item=>[item.key,item.kind])).toEqual([['override','ai-inference']]);
    db.close();
  });

  it('classifies only pure stages by adapter',()=>{
    expect(AnalysisCache.cacheKind('website','CLASSIFY')).toBeUndefined();
    expect(AnalysisCache.cacheKind('game','PREPARE')).toBeUndefined();
    expect(AnalysisCache.cacheKind('security','ANALYZE')).toBeUndefined();
    expect(AnalysisCache.cacheKind('file','ANALYZE')).toBe('static-analysis');
    expect(AnalysisCache.cacheKind('website','REPORT')).toBeUndefined();
  });
});

describe('ResourceMonitor reliability',()=>{
  it('retries transient process sampler failures and reports exhaustion without hiding real limits',async()=>{
    const dir=await temp();const db=new Database(':memory:');let calls=0;
    const monitor=new ResourceMonitor(db,dir,undefined,{processSampler:async()=>{calls++;if(calls<3)throw new Error('temporary');return processSample(900);},diskSampler:async()=>diskSample,sampleTtlMs:0,maxSamplingAttempts:3,retryDelayMs:0});
    const snapshot=await monitor.sampleOrThrow('worker',{fresh:true});
    expect(calls).toBe(3);expect(snapshot.treeRssMB).toBe(900);expect(snapshot.pressure).toBe('danger');
    const failing=new ResourceMonitor(db,dir,undefined,{processSampler:async()=>{throw new Error('denied');},diskSampler:async()=>diskSample,sampleTtlMs:0,maxSamplingAttempts:2,retryDelayMs:0});
    const failed=await failing.sample('worker',{fresh:true});
    expect(failed.samplingStatus).toBe('unavailable');expect(failed.sampling).toMatchObject({attempts:2,retrying:false});
    await expect(failing.sampleOrThrow('worker',{fresh:true})).rejects.toThrow(/failed closed/);
    db.close();
  });

  it('does not invent CPU history after PID reuse and still reports high load',async()=>{
    const dir=await temp();const db=new Database(':memory:');let now=1000;let startedAt=1;let cpu=0;
    const monitor=new ResourceMonitor(db,dir,{softRssMb:1000,hardRssMb:2000,maxCpuPercent:90},{now:()=>now,processSampler:async()=>[{pid:process.pid,ppid:1,rssMB:100,cpuSeconds:cpu,name:'node',startedAt}],diskSampler:async()=>({...diskSample,diskAvailableBytes:4*1024**3}),sampleTtlMs:0});
    await monitor.sample('worker',{fresh:true});cpu=os.cpus().length;startedAt=2;now+=1000;
    expect((await monitor.sample('worker',{fresh:true})).cpuPercent).toBe(0);
    cpu+=os.cpus().length;now+=1000;expect((await monitor.sample('worker',{fresh:true})).pressure).toBe('danger');
    db.close();
  });

  it('keeps real self-memory limits visible when Windows sampling fails or Chromium exits',async()=>{
    const dir=await temp();const db=new Database(':memory:');const rss=1200;
    const windows=new ResourceMonitor(db,dir,undefined,{processSampler:async()=>{throw new Error('powershell denied');},diskSampler:async()=>diskSample,sampleTtlMs:0,maxSamplingAttempts:2,retryDelayMs:0});
    const unavailable=await windows.sample('worker',{fresh:true});expect(unavailable.samplingStatus).toBe('unavailable');expect(unavailable.treeRssMB).toBeGreaterThan(0);
    const chromium=new ResourceMonitor(db,dir,undefined,{processSampler:async()=>[{pid:process.pid,ppid:1,rssMB:rss,cpuSeconds:0,name:'node'}],diskSampler:async()=>diskSample,sampleTtlMs:0});
    const exited=await chromium.sample('worker',{fresh:true,rootPids:[9001]});expect(exited.samplingStatus).toBe('process-exited');expect(exited.pressure).toBe('danger');
    db.close();
  });

  it('marks registered process exit separately from unavailable and stale metrics',async()=>{
    const dir=await temp();const db=new Database(':memory:');let now=1000;
    const monitor=new ResourceMonitor(db,dir,undefined,{now:()=>now,processSampler:async()=>processSample(50),diskSampler:async()=>diskSample,sampleTtlMs:0});
    await monitor.sample('worker',{fresh:true});now+=60000;
    const exited=await monitor.sample('worker',{fresh:true,rootPids:[999999]});
    expect(exited.samplingStatus).toBe('process-exited');expect(exited.limitations.join(' ')).toContain('exited');
    const staleDb=new Database(':memory:');staleDb.setSetting('resource_snapshot_worker',JSON.stringify({sampledAt:new Date(0).toISOString(),limitations:[]}));
    const stale=new ResourceMonitor(staleDb,dir,undefined,{processSampler:async()=>{throw new Error('denied');},diskSampler:async()=>diskSample,sampleTtlMs:2000,maxSamplingAttempts:1,retryDelayMs:0});
    const failed=await stale.sample('worker');expect(failed.samplingStatus).toBe('unavailable');expect(failed.sampling).toMatchObject({stale:true});
    staleDb.close();db.close();
  });


  it('shares one in-flight snapshot per source',async()=>{
    const dir=await temp();const db=new Database(':memory:');let calls=0;let finish!:(value:ResourceProcess[])=>void;
    const pending=new Promise<ResourceProcess[]>(resolve=>{finish=resolve;});
    const monitor=new ResourceMonitor(db,dir,undefined,{processSampler:async()=>{calls++;return pending;},diskSampler:async()=>diskSample});
    const first=monitor.sample('worker');const second=monitor.sample('worker');
    expect(first).toBe(second);
    finish(processSample(100));
    const snapshot=await first;
    expect(calls).toBe(1);
    expect(snapshot.treeRssMB).toBe(100);
    expect(Number((db.raw.prepare("SELECT COUNT(*) n FROM resource_samples WHERE source='worker'").get() as {n:number}).n)).toBe(1);
    expect(await monitor.sample('worker')).toEqual(snapshot);
    expect(calls).toBe(1);
    db.close();
  });

  it('bypasses the snapshot TTL for fresh task-budget sampling while sharing in-flight work',async()=>{
    const dir=await temp();const db=new Database(':memory:');let calls=0;let rss=100;
    const monitor=new ResourceMonitor(db,dir,undefined,{now:()=>calls*1000,processSampler:async()=>{calls++;return processSample(rss);},diskSampler:async()=>diskSample,sampleTtlMs:5000});
    expect((await monitor.sample('worker')).treeRssMB).toBe(100);
    expect((await monitor.sample('worker')).treeRssMB).toBe(100);
    expect(calls).toBe(1);
    rss=180;
    const freshA=monitor.sample('worker',{fresh:true});const freshB=monitor.sample('worker',{fresh:true});const freshC=monitor.sampleOrThrow('worker',{fresh:true});
    expect(freshA).toBe(freshB);
    const values=await Promise.all([freshA,freshB,freshC]);
    expect(values.map(value=>value.treeRssMB)).toEqual([180,180,180]);
    expect(calls).toBe(2);
    db.close();
  });

  it('includes registered analyzer roots and their descendants in task memory',async()=>{
    const dir=await temp();const db=new Database(':memory:');
    const rows:ResourceProcess[]=[...processSample(100),{pid:9001,ppid:process.pid,rssMB:200,name:'analyzer'},{pid:9002,ppid:9001,rssMB:300,name:'analyzer-child'}];
    const monitor=new ResourceMonitor(db,dir,undefined,{processSampler:async()=>rows,diskSampler:async()=>diskSample});
    const snapshot=await monitor.sampleOrThrow('worker',{fresh:true,rootPids:[9001]});
    expect(snapshot.treeRssMB).toBe(600);
    expect(snapshot.childRssMB).toBe(500);
    expect(snapshot.processes.map(process=>process.pid)).toEqual(expect.arrayContaining([process.pid,9001,9002]));
    db.close();
  });

  it('shares cached disk measurements across sources',async()=>{
    const dir=await temp();const db=new Database(':memory:');let diskCalls=0;
    const monitor=new ResourceMonitor(db,dir,undefined,{processSampler:async()=>processSample(100),diskSampler:async()=>{diskCalls++;return diskSample;}});
    const [api,worker]=await Promise.all([monitor.sample('api'),monitor.sample('worker')]);
    expect(api.dataDirBytes).toBe(1234);
    expect(worker.dataDirBytes).toBe(1234);
    expect(diskCalls).toBe(1);
    db.close();
  });

  it('fails closed only for task workers on process-tree errors without caching background failures as healthy',async()=>{
    const dir=await temp();const db=new Database(':memory:');let calls=0;let fail=true;
    const monitor=new ResourceMonitor(db,dir,undefined,{now:()=>0,processSampler:async()=>{calls++;if(fail)throw new Error('denied');return processSample(100);},diskSampler:async()=>diskSample});
    await expect(monitor.sampleOrThrow('worker')).rejects.toThrow('failed closed');
    const background=await monitor.sampleOrThrow('api');expect(background.samplingStatus).toBe('unavailable');
    const fallback=monitor.stored('api');
    expect(fallback?.limitations.join(' ')).toContain('Process-tree sampling unavailable');
    expect(monitor.samplingHealthy(fallback)).toBe(false);
    fail=false;
    const healthy=await monitor.sampleOrThrow('worker');
    expect(calls).toBe(7); // two three-attempt failures, then one healthy sample
    expect(monitor.samplingHealthy(healthy)).toBe(true);
    db.close();
  });

  it('uses soft and hard recovery hysteresis and records peak CPU and disk metrics',async()=>{
    const dir=await temp();const db=new Database(':memory:');let now=Date.now();let rss=250;const cpu=0;
    const monitor=new ResourceMonitor(db,dir,{softRssMb:100,hardRssMb:200},{now:()=>now,processSampler:async()=>processSample(rss,cpu),diskSampler:async()=>diskSample,sampleTtlMs:0,hysteresis:{pressureSamples:2,dangerSamples:3}});
    expect((await monitor.sample('worker')).pressure).toBe('danger');
    rss=50;now+=10;
    expect((await monitor.sample('worker')).pressure).toBe('danger');
    now+=10;expect((await monitor.sample('worker')).pressure).toBe('danger');
    now+=10;expect((await monitor.sample('worker')).pressure).toBe('normal');
    rss=150;now+=10;expect((await monitor.sample('worker')).pressure).toBe('pressure');
    rss=50;now+=10;expect((await monitor.sample('worker')).pressure).toBe('pressure');
    now+=10;expect((await monitor.sample('worker')).pressure).toBe('normal');
    const latest=monitor.stored('worker')!;
    expect(latest.peakTreeRssMB).toBe(250);
    expect(latest.dataDirBytes).toBe(1234);
    const peak=JSON.parse(db.settings().resource_peak!) as {treeRssMB:number;cpuPercent:number;dataDirBytes:number};
    expect(peak.treeRssMB).toBe(250);
    expect(peak.dataDirBytes).toBe(1234);
    expect(typeof peak.cpuPercent).toBe('number');
    db.close();
  });

  it('uses conservative system defaults',()=>{
    expect(DEFAULT_RESOURCE_THRESHOLDS).toMatchObject({minSystemFreeMemoryMB:1024,minDiskFreeBytes:1024*1024*1024,maxCpuPercent:90});
  });

  it('adapts default memory thresholds to constrained containers without killing normal processes',async()=>{
    const dir=await temp();const db=new Database(':memory:');const systemSampler=()=>({systemFreeMemoryMB:16,systemTotalMemoryMB:64});
    const monitor=new ResourceMonitor(db,dir,undefined,{processSampler:async()=>processSample(100),diskSampler:async()=>({...diskSample,diskAvailableBytes:4*1024*1024*1024}),systemSampler,sampleTtlMs:0});
    expect((await monitor.sampleOrThrow('worker',{fresh:true})).pressure).toBe('normal');
    const adapted=effectiveResourceThresholds(DEFAULT_RESOURCE_THRESHOLDS,64);expect(adapted.softRssMb).toBeGreaterThanOrEqual(256);expect(adapted.hardRssMb).toBeGreaterThan(adapted.softRssMb);expect(adapted.minSystemFreeMemoryMB).toBe(0);
    expect(effectiveResourceThresholds(DEFAULT_RESOURCE_THRESHOLDS,8192)).toMatchObject({softRssMb:700,hardRssMb:950,minSystemFreeMemoryMB:819.2});
    db.close();
  });

  it('escalates low system memory to danger and applies danger recovery hysteresis',async()=>{
    const dir=await temp();const db=new Database(':memory:');let now=Date.now();let freeMemory=400;
    const monitor=new ResourceMonitor(db,dir,{softRssMb:1000,hardRssMb:2000,minSystemFreeMemoryMB:1024},{now:()=>now,processSampler:async()=>processSample(100),diskSampler:async()=>({...diskSample,diskAvailableBytes:4*1024*1024*1024}),systemSampler:()=>({systemFreeMemoryMB:freeMemory,systemTotalMemoryMB:8192}),sampleTtlMs:0,hysteresis:{pressureSamples:2,dangerSamples:3}});
    expect((await monitor.sample('worker')).pressure).toBe('danger');
    freeMemory=2048;
    for(let i=0;i<2;i++){now+=10;expect((await monitor.sample('worker')).pressure).toBe('danger');}
    now+=10;expect((await monitor.sample('worker')).pressure).toBe('normal');
    db.close();
  });

  it('escalates low disk space to pressure and applies pressure recovery hysteresis',async()=>{
    const dir=await temp();const db=new Database(':memory:');let now=Date.now();let freeDisk=768*1024*1024;
    const monitor=new ResourceMonitor(db,dir,{softRssMb:1000,hardRssMb:2000,minDiskFreeBytes:1024*1024*1024},{now:()=>now,processSampler:async()=>processSample(100),diskSampler:async()=>({...diskSample,diskAvailableBytes:freeDisk}),systemSampler:()=>({systemFreeMemoryMB:4096,systemTotalMemoryMB:8192}),sampleTtlMs:0,diskSampleTtlMs:0,hysteresis:{pressureSamples:2,dangerSamples:3}});
    expect((await monitor.sample('worker')).pressure).toBe('pressure');
    freeDisk=4*1024*1024*1024;now+=10;
    expect((await monitor.sample('worker')).pressure).toBe('pressure');
    now+=10;expect((await monitor.sample('worker')).pressure).toBe('normal');
    db.close();
  });

  it('escalates high CPU to pressure and applies pressure recovery hysteresis',async()=>{
    const dir=await temp();const db=new Database(':memory:');let now=Date.now();let cpu=0;
    const monitor=new ResourceMonitor(db,dir,{softRssMb:1000,hardRssMb:2000,maxCpuPercent:90},{now:()=>now,processSampler:async()=>processSample(100,cpu),diskSampler:async()=>({...diskSample,diskAvailableBytes:4*1024*1024*1024}),systemSampler:()=>({systemFreeMemoryMB:4096,systemTotalMemoryMB:8192}),sampleTtlMs:0,hysteresis:{pressureSamples:2,dangerSamples:3}});
    expect((await monitor.sample('worker')).pressure).toBe('normal');
    cpu=os.cpus().length*0.95;now+=1000;
    expect((await monitor.sample('worker')).pressure).toBe('pressure');
    now+=1000;expect((await monitor.sample('worker')).pressure).toBe('pressure');
    now+=1000;expect((await monitor.sample('worker')).pressure).toBe('normal');
    db.close();
  });

  it('bounds 1000 resource samples by row count and keeps the latest API snapshot',async()=>{
    const dir=await temp();const db=new Database(':memory:');let now=Date.now();
    const monitor=new ResourceMonitor(db,dir,undefined,{now:()=>now,processSampler:async()=>processSample(100),diskSampler:async()=>diskSample,sampleTtlMs:0,resourceRetention:{days:365,maxRows:25}});
    let latest='';
    for(let i=0;i<1000;i++){now+=5000;latest=(await monitor.sample('api',{fresh:true})).sampledAt;}
    const rows=db.raw.prepare('SELECT id,snapshot_json FROM resource_samples ORDER BY id').all() as {id:number;snapshot_json:string}[];
    expect(rows).toHaveLength(25);
    expect(rows.at(-1)?.id).toBe(1000);
    expect(JSON.parse(rows.at(-1)!.snapshot_json).sampledAt).toBe(latest);
    expect(monitor.stored('api')?.sampledAt).toBe(latest);
    db.close();
  });

  it('uses seven-day and 10000-row resource retention defaults',async()=>{
    expect(DEFAULT_RESOURCE_SAMPLE_RETENTION).toEqual({days:7,maxRows:10000});
    const dir=await temp();const db=new Database(':memory:');let now=Date.now();
    const monitor=new ResourceMonitor(db,dir,undefined,{now:()=>now,processSampler:async()=>processSample(100),diskSampler:async()=>diskSample,sampleTtlMs:0});
    await monitor.sample('api',{fresh:true});now+=8*86400000;await monitor.sample('api',{fresh:true});
    expect(Number((db.raw.prepare('SELECT COUNT(*) n FROM resource_samples').get() as {n:number}).n)).toBe(1);
    db.close();
  });

  it('expires resource samples by configurable age while retaining the latest snapshot per source',async()=>{
    const dir=await temp();const db=new Database(':memory:');let now=Date.now();
    const monitor=new ResourceMonitor(db,dir,undefined,{now:()=>now,processSampler:async()=>processSample(100),diskSampler:async()=>diskSample,resourceRetention:{days:1,maxRows:100}});
    await monitor.sample('api',{fresh:true});
    now+=2*86400000;
    const latest=await monitor.sample('api',{fresh:true});
    const rows=db.raw.prepare('SELECT snapshot_json FROM resource_samples').all() as {snapshot_json:string}[];
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.snapshot_json).sampledAt).toBe(latest.sampledAt);
    expect(monitor.stored('api')).toEqual(latest);
    db.close();
  });

  it('previews and applies metric retention without deleting recent or active-task data',async()=>{
    const dir=await temp();const db=new Database(':memory:');const retention=new RetentionService(db,dir);
    retention.setPolicy({logDays:30,resourceDays:7,resourceMaxRows:100});
    const project=db.project({name:'retention',kind:'website',target:'https://example.com',authorizationConfirmed:true});
    const activeTasks=(['RUNNING','QUEUED','PAUSED'] as const).map(status=>{
      const task=db.createTask(project.id,'website',{adapter:'website'},'hash');db.updateTask(task.id,{status});return task;
    });
    const completed=db.createTask(project.id,'website',{adapter:'website'},'hash');db.updateTask(completed.id,{status:'COMPLETED'});
    const old=new Date(Date.now()-40*86400000).toISOString();
    const recent=new Date().toISOString();
    const addOldEvent=(taskId:string|null)=>db.raw.prepare('INSERT INTO events (task_id,type,payload_json,created_at) VALUES (?,?,?,?)').run(taskId,'test',JSON.stringify({payload:'x'.repeat(50)}),old);
    addOldEvent(completed.id);addOldEvent(null);addOldEvent(activeTasks[0]!.id);addOldEvent(activeTasks[1]!.id);addOldEvent(activeTasks[2]!.id);
    db.raw.prepare('INSERT INTO events (task_id,type,payload_json,created_at) VALUES (?,?,?,?)').run(completed.id,'test','{"recent":true}',recent);
    for(const task of [...activeTasks,completed])db.raw.prepare('INSERT INTO circuit_events (task_id,level,reason,snapshot_json,created_at) VALUES (?,?,?,?,?)').run(task.id,'pressure','old','{}',old);
    db.raw.prepare('INSERT INTO circuit_events (task_id,level,reason,snapshot_json,created_at) VALUES (?,?,?,?,?)').run(completed.id,'pressure','recent','{}',recent);
    const sample=(source:string,createdAt:string)=>db.raw.prepare('INSERT INTO resource_samples (source,snapshot_json,created_at) VALUES (?,?,?)').run(source,JSON.stringify({source,payload:'x'.repeat(50)}),createdAt);
    sample('api',old);sample('api',recent);sample('worker',old);
    const beforeActive=db.raw.prepare('SELECT COUNT(*) n FROM events WHERE task_id IN (?,?,?)').get(...activeTasks.map(task=>task.id) as [string,string,string]) as {n:number};
    const preview=await retention.preview();
    const metricItems=preview.items.filter(item=>item.path.startsWith('sqlite:'));
    expect(metricItems.map(item=>item.path).filter(item=>item.startsWith('sqlite:resource_samples:'))).toHaveLength(1);
    expect(metricItems.some(item=>item.path.startsWith('sqlite:events:'))).toBe(true);
    expect(metricItems.some(item=>item.path.startsWith('sqlite:circuit_events:'))).toBe(true);
    expect(metricItems.some(item=>item.taskId&&activeTasks.some(task=>task.id===item.taskId))).toBe(false);
    expect(preview.totalBytes).toBe(metricItems.reduce((sum,item)=>sum+item.sizeBytes,0));
    expect(preview.protectedBytes).toBeGreaterThan(0);
    const result=await retention.apply();
    expect(result.skipped).toEqual([]);
    expect(result.deleted).toHaveLength(metricItems.length);
    expect(result.deletedBytes).toBe(preview.totalBytes);
    expect(Number((db.raw.prepare('SELECT COUNT(*) n FROM resource_samples').get() as {n:number}).n)).toBe(2);
    const activeIds=activeTasks.map(task=>task.id) as [string,string,string];
    const afterActive=db.raw.prepare('SELECT COUNT(*) n FROM events WHERE task_id IN (?,?,?)').get(...activeIds) as {n:number};
    const activeCircuits=db.raw.prepare('SELECT COUNT(*) n FROM circuit_events WHERE task_id IN (?,?,?)').get(...activeIds) as {n:number};
    expect(afterActive.n).toBe(beforeActive.n);
    expect(activeCircuits.n).toBe(3);
    expect(Number((db.raw.prepare("SELECT COUNT(*) n FROM events WHERE type='test' AND created_at=?").get(recent) as {n:number}).n)).toBe(1);
    expect(Number((db.raw.prepare("SELECT COUNT(*) n FROM circuit_events WHERE reason='recent'").get() as {n:number}).n)).toBe(1);
    expect(retention.events().length).toBe(result.deleted.length);
    db.close();
  });

  it('deduplicates identical circuit events inside the short window',async()=>{
    const dir=await temp();const db=new Database(':memory:');let now=Date.now();
    const monitor=new ResourceMonitor(db,dir,undefined,{now:()=>now,processSampler:async()=>processSample(100),diskSampler:async()=>diskSample,circuitDedupWindowMs:1000});
    const snapshot=await monitor.sampleOrThrow('worker');
    expect(monitor.circuit('danger','same reason',undefined,snapshot)).toBe(true);
    expect(monitor.circuit('danger','same reason',undefined,snapshot)).toBe(false);
    expect(monitor.circuit('pressure','same reason',undefined,snapshot)).toBe(true);
    now+=1001;
    expect(monitor.circuit('danger','same reason',undefined,snapshot)).toBe(true);
    expect(Number((db.raw.prepare('SELECT COUNT(*) n FROM circuit_events').get() as {n:number}).n)).toBe(3);
    db.close();
  });
});

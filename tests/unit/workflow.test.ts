import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Database, WorkflowEngine, type AdapterDefinition, type TaskContext } from '@reverse/workflow';
const dirs:string[]=[];
afterEach(async()=>{for(const d of dirs.splice(0))await rm(d,{recursive:true,force:true});});
async function setup(){const dataDir=await mkdtemp(path.join(os.tmpdir(),'re-workflow-'));dirs.push(dataDir);const db=new Database(':memory:');return {dataDir,db};}
async function waitUntil(predicate:()=>boolean,timeoutMs=3000){const deadline=Date.now()+timeoutMs;while(!predicate()){if(Date.now()>deadline)throw new Error('Condition timed out');await new Promise(resolve=>setTimeout(resolve,5));}}
function adapter(overrides:Partial<AdapterDefinition>={}):AdapterDefinition{return {name:'file',version:'test',description:'test',available:async()=>({available:true,detail:'test'}),detect:async()=>({adapter:'file',confidence:1,format:'test',details:{},limitations:[]}),prepare:async()=>({prepared:true}),analyze:async()=>({ok:true}),extractEvidence:async()=>({}),reconstruct:async()=>({}),validate:async()=>({passed:true,checks:[]}),...overrides};}
describe('persistent workflow',()=>{
  it('persists stage checkpoints and resumes after pause',async()=>{
    const {dataDir,db}=await setup();
    let release!:()=>void;const gate=new Promise<void>(r=>release=r);
    const engine=new WorkflowEngine(db,{dataDir,adapters:[adapter({prepare:async ctx=>{await gate;await ctx.log('info','prepared');return {prepared:true};}})],pollMs:100000});
    const project=db.project({name:'test',kind:'software',authorizationConfirmed:true});
    const task=await engine.create(project.id,{adapter:'file'});
    const running=engine.execute(task.id);
    while(db.getTask(task.id)?.currentStage!=='PREPARE')await new Promise(r=>setTimeout(r,5));
    expect(engine.pause(task.id)).toBe(true);release();await running;
    expect(db.getTask(task.id)?.status).toBe('PAUSED');
    expect(engine.resume(task.id)).toBe(true);await engine.execute(task.id);
    expect(db.getTask(task.id)?.status).toBe('COMPLETED');
    expect(db.stages(task.id).find(s=>s.name==='COMPLETED')?.status).toBe('SUCCEEDED');
    db.close();
  });
  it('atomically claims queued tasks and recovers only expired leases',async()=>{
    const {dataDir,db}=await setup();
    const first=new WorkflowEngine(db,{dataDir,adapters:[adapter()],workerId:'worker-a',leaseMs:5000});
    const second=new WorkflowEngine(db,{dataDir,adapters:[adapter()],workerId:'worker-b',leaseMs:5000});
    const project=db.project({name:'lease',kind:'software',authorizationConfirmed:true});
    const task=await first.create(project.id,{adapter:'file'});
    expect(first.claimNext()).toBe(task.id);
    second.recover();
    expect(db.getTask(task.id)?.status).toBe('RUNNING');
    expect(second.claimNext()).toBeUndefined();
    db.raw.prepare("UPDATE tasks SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(task.id);
    second.recover();
    expect(db.getTask(task.id)?.status).toBe('QUEUED');
    expect(second.claimNext()).toBe(task.id);
    db.close();
  });
  it('consumes queued work even when maxQueue is an admission cap of one',async()=>{
    const {dataDir,db}=await setup();const engine=new WorkflowEngine(db,{dataDir,adapters:[adapter()],pollMs:10,maxQueue:1});
    const project=db.project({name:'queue-cap',kind:'software',authorizationConfirmed:true});const first=await engine.create(project.id,{adapter:'file'});const second=await engine.create(project.id,{adapter:'file'});
    engine.start();await waitUntil(()=>db.getTask(first.id)?.status==='COMPLETED'&&db.getTask(second.id)?.status==='COMPLETED');await engine.close();db.close();
  });
  it('serializes ticks while resource sampling is in flight',async()=>{
    const {dataDir,db}=await setup();let calls=0;let release!:(value:Record<string,unknown>)=>void;const gate=new Promise<Record<string,unknown>>(resolve=>release=resolve);
    const fake={sampleOrThrow:async()=>{calls++;return gate;},circuit:()=>{}} as unknown as import('@reverse/workflow').ResourceMonitor;
    const engine=new WorkflowEngine(db,{dataDir,adapters:[adapter()],resources:fake,pollMs:10});const project=db.project({name:'tick-lock',kind:'software',authorizationConfirmed:true});const task=await engine.create(project.id,{adapter:'file'});engine.start();
    await waitUntil(()=>calls===1);await new Promise(resolve=>setTimeout(resolve,50));expect(calls).toBe(1);release({treeRssMB:100,childRssMB:0,cpuPercent:0,heapUsedMB:10,pressure:'normal'});await waitUntil(()=>db.getTask(task.id)?.status==='COMPLETED');await engine.close();db.close();
  });
  it('recovers legacy lease-less running tasks only once',async()=>{
    const {dataDir,db}=await setup();const engine=new WorkflowEngine(db,{dataDir,adapters:[adapter()]});const project=db.project({name:'legacy',kind:'software',authorizationConfirmed:true});const task=await engine.create(project.id,{adapter:'file'});
    db.updateTask(task.id,{status:'RUNNING'});engine.recover();expect(db.getTask(task.id)?.status).toBe('QUEUED');db.updateTask(task.id,{status:'RUNNING'});engine.recover();expect(db.getTask(task.id)?.status).toBe('RUNNING');db.close();
  });
  it('aborts a running stage promptly when cancellation is requested',async()=>{
    const {dataDir,db}=await setup();
    const engine=new WorkflowEngine(db,{dataDir,adapters:[adapter({prepare:()=>new Promise(()=>{})})],pollMs:100000});
    const project=db.project({name:'cancel',kind:'software',authorizationConfirmed:true});
    const task=await engine.create(project.id,{adapter:'file'});
    const running=engine.execute(task.id);
    while(db.getTask(task.id)?.currentStage!=='PREPARE')await new Promise(r=>setTimeout(r,5));
    expect(engine.cancel(task.id)).toBe(true);
    await running;
    expect(db.getTask(task.id)?.status).toBe('CANCELLED');
    db.close();
  });
  it('rejects late context writes from a cancelled stage that ignores abort',async()=>{
    const {dataDir,db}=await setup();
    let release!:()=>void;let enteredResolve!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);const entered=new Promise<void>(resolve=>enteredResolve=resolve);
    let signalAborted=false;let attempts:PromiseSettledResult<unknown>[]=[];
    const engine=new WorkflowEngine(db,{dataDir,adapters:[adapter({prepare:async ctx=>{
      enteredResolve();await gate;signalAborted=ctx.signal.aborted;
      attempts=await Promise.allSettled([
        ctx.writeArtifact('late.txt','late artifact','text/plain'),
        ctx.evidence('EVIDENCE','Late evidence','fixture','late',{late:true}),
        ctx.finding({title:'Late finding',category:'fixture',severity:'low',confidence:0.1,evidenceIds:[],details:'late',recommendation:'none'})
      ]);
      return {late:true};
    }})],pollMs:100000});
    const project=db.project({name:'cancel-late-write',kind:'software',authorizationConfirmed:true});const task=await engine.create(project.id,{adapter:'file'});
    const running=engine.execute(task.id);await entered;
    const evidenceBefore=db.evidence(task.id).map(item=>item.id);
    expect(engine.cancel(task.id)).toBe(true);await running;
    expect(db.getTask(task.id)?.status).toBe('CANCELLED');expect(signalAborted).toBe(false);
    release();await waitUntil(()=>attempts.length===3);
    expect(signalAborted).toBe(true);expect(attempts.every(result=>result.status==='rejected')).toBe(true);
    expect(db.artifacts(task.id)).toEqual([]);expect(await readdir(path.join(dataDir,'tasks',task.id,'artifacts'))).toEqual([]);
    expect(db.evidence(task.id).map(item=>item.id)).toEqual(evidenceBefore);expect(db.findings(task.id)).toEqual([]);
    expect(db.stageOutput(task.id,'PREPARE')).toBeUndefined();expect(db.getTask(task.id)?.currentStage).toBe('PREPARE');
    db.close();
  });
  it('invalidates a completed stage context before the next stage runs',async()=>{
    const {dataDir,db}=await setup();let previous!:TaskContext;let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);
    const engine=new WorkflowEngine(db,{dataDir,adapters:[adapter({prepare:ctx=>{previous=ctx;return {prepared:true};},analyze:async()=>{await gate;return {ok:true};}})]});
    const project=db.project({name:'stage-generation',kind:'software',authorizationConfirmed:true});const task=await engine.create(project.id,{adapter:'file'});
    const running=engine.execute(task.id);await waitUntil(()=>db.getTask(task.id)?.currentStage==='ANALYZE');
    const evidenceBefore=db.evidence(task.id).map(item=>item.id);
    const attempts=await Promise.allSettled([previous.writeArtifact('stale.txt','stale','text/plain'),previous.evidence('EVIDENCE','Stale evidence','fixture','stale',{stale:true}),previous.finding({title:'Stale finding',category:'fixture',severity:'low',confidence:0.1,evidenceIds:[],details:'stale',recommendation:'none'})]);
    expect(attempts.every(result=>result.status==='rejected')).toBe(true);expect(db.artifacts(task.id)).toEqual([]);expect(db.evidence(task.id).map(item=>item.id)).toEqual(evidenceBefore);expect(db.findings(task.id)).toEqual([]);
    release();await running;expect(db.getTask(task.id)?.status).toBe('COMPLETED');db.close();
  });
  it('publishes batch artifacts together and rolls back every final file on database failure',async()=>{
    const {dataDir,db}=await setup();const original=db.addArtifact;let calls=0;db.addArtifact=((...args:Parameters<typeof db.addArtifact>)=>{calls++;if(calls===2)throw new Error('injected artifact database failure');return original(...args);}) as typeof db.addArtifact;
    const engine=new WorkflowEngine(db,{dataDir,adapters:[adapter({reconstruct:async ctx=>{await ctx.writeArtifacts!([{name:'first.txt',content:'first',mime:'text/plain'},{name:'second.txt',content:'second',mime:'text/plain'}]);return {generated:true};}})]});
    const project=db.project({name:'batch-artifact-rollback',kind:'software',authorizationConfirmed:true});const task=await engine.create(project.id,{adapter:'file'});await engine.execute(task.id);
    expect(db.getTask(task.id)?.status).toBe('FAILED');expect(db.getTask(task.id)?.currentStage).toBe('RECONSTRUCT');expect(db.artifacts(task.id)).toEqual([]);expect(await readdir(path.join(dataDir,'tasks',task.id,'artifacts'))).toEqual([]);db.close();
  });
  it('restores overwritten artifact files and database rows when a batch commit fails',async()=>{
    const {dataDir,db}=await setup();const original=db.addArtifact.bind(db);let fail=false;db.addArtifact=((...args:Parameters<typeof db.addArtifact>)=>{if(fail)throw new Error('injected replacement failure');return original(...args);}) as typeof db.addArtifact;
    const engine=new WorkflowEngine(db,{dataDir,adapters:[adapter({prepare:async ctx=>{await ctx.writeArtifact('first.txt','old-first','text/plain');await ctx.writeArtifact('second.txt','old-second','text/plain');return {prepared:true};},reconstruct:async ctx=>{fail=true;await ctx.writeArtifacts!([{name:'first.txt',content:'new-first',mime:'text/plain'},{name:'second.txt',content:'new-second',mime:'text/plain'}]);return {generated:true};}})]});
    const project=db.project({name:'batch-artifact-restore',kind:'software',authorizationConfirmed:true});const task=await engine.create(project.id,{adapter:'file'});await engine.execute(task.id);
    expect(db.getTask(task.id)?.error).toContain('injected replacement failure');expect(db.getTask(task.id)?.status).toBe('FAILED');expect(db.getTask(task.id)?.currentStage).toBe('RECONSTRUCT');expect(db.artifacts(task.id).map(item=>item.name).sort()).toEqual(['first.txt','second.txt']);const artifactDir=path.join(dataDir,'tasks',task.id,'artifacts');expect(await readFile(path.join(artifactDir,'first.txt'),'utf8')).toBe('old-first');expect(await readFile(path.join(artifactDir,'second.txt'),'utf8')).toBe('old-second');expect((await readdir(artifactDir)).every(name=>!name.includes('.previous')&&!name.endsWith('.tmp'))).toBe(true);db.close();
  });
  it('keeps artifact, evidence, and finding writes working for an active stage',async()=>{
    const {dataDir,db}=await setup();
    const engine=new WorkflowEngine(db,{dataDir,adapters:[adapter({prepare:async ctx=>{
      await ctx.writeArtifact('prepared.txt','prepared','text/plain');await ctx.evidence('EVIDENCE','Prepared evidence','fixture','prepare',{prepared:true});
      await ctx.finding({title:'Prepared finding',category:'fixture',severity:'low',confidence:1,evidenceIds:[],details:'fixture',recommendation:'none'});return {prepared:true};
    }})]});
    const project=db.project({name:'active-write',kind:'software',authorizationConfirmed:true});const task=await engine.create(project.id,{adapter:'file'});await engine.execute(task.id);
    expect(db.getTask(task.id)?.status).toBe('COMPLETED');expect(db.artifacts(task.id).map(item=>item.name)).toContain('prepared.txt');expect(db.evidence(task.id).some(item=>item.title==='Prepared evidence')).toBe(true);expect(db.findings(task.id).map(item=>item.title)).toContain('Prepared finding');db.close();
  });
  it('rechecks remote AI consent at execution time before sending analysis',async()=>{
    const {dataDir,db}=await setup();
    let consent=true;
    const engine=new WorkflowEngine(db,{dataDir,adapters:[adapter()],getAiConfig:()=>({enabled:true,baseUrl:'https://example.invalid/v1',model:'fixture',allowRemoteData:consent})});
    const project=db.project({name:'ai-consent',kind:'software',authorizationConfirmed:true});
    const task=await engine.create(project.id,{adapter:'file'});
    consent=false;
    await engine.execute(task.id);
    expect(db.getTask(task.id)?.status).toBe('FAILED');
    expect(db.getTask(task.id)?.error).toContain('consent');
    expect(db.getTask(task.id)?.currentStage).toBe('PLAN');
    db.close();
  });
  it('fails closed when process-tree sampling is unavailable',async()=>{
    const {dataDir,db}=await setup();let circuits=0;
    const fake={sampleOrThrow:async()=>{throw new Error('sampling unavailable');},circuit:()=>{circuits++;}} as unknown as import('@reverse/workflow').ResourceMonitor;
    const engine=new WorkflowEngine(db,{dataDir,adapters:[adapter()],resources:fake,pollMs:10});
    const project=db.project({name:'sampling',kind:'software',authorizationConfirmed:true});const task=await engine.create(project.id,{adapter:'file'});engine.start();await new Promise(resolve=>setTimeout(resolve,60));
    expect(db.getTask(task.id)?.status).toBe('QUEUED');expect(circuits).toBeGreaterThan(0);await engine.close();db.close();
  });
  it('runs a bounded planner and validator loop while keeping model output as inference',async()=>{
    const {dataDir,db}=await setup();let validations=0;let reconstructions=0;
    const fake=http.createServer((req,res)=>{let body='';req.on('data',chunk=>body+=chunk.toString());req.on('end',()=>{const request=JSON.parse(body) as {messages:{role:string;content:string}[]};const system=request.messages[0]?.content??'';let content='{"steps":["inspect evidence"],"uncertainties":[]}';if(system.includes('summarize'))content='Summary inference';if(system.includes('validation reviewer')){validations++;content=JSON.stringify({passed:validations>1,checks:[{name:'review',passed:validations>1}],action:validations===1?'reconstruct':'none'});}res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content}}]}));});});
    await new Promise<void>(resolve=>fake.listen(0,'127.0.0.1',resolve));const address=fake.address();if(!address||typeof address==='string')throw new Error('No fake AI port');
    try{
      const engine=new WorkflowEngine(db,{dataDir,adapters:[adapter({reconstruct:async()=>{reconstructions++;return {generated:true};},validate:async()=>({passed:false,checks:[{name:'fixture',passed:false}]})})],getAiConfig:()=>({enabled:true,baseUrl:`http://127.0.0.1:${address.port}/v1`,model:'fixture',allowRemoteData:false})});
      const project=db.project({name:'ai-loop',kind:'software',authorizationConfirmed:true});const task=await engine.create(project.id,{adapter:'file',options:{aiMaxIterations:2}});await engine.execute(task.id);
      expect(db.getTask(task.id)?.status).toBe('COMPLETED');expect(validations).toBe(2);expect(reconstructions).toBe(2);
      const runs=db.raw.prepare('SELECT role,status FROM agent_runs ORDER BY rowid').all() as {role:string;status:string}[];
      expect(runs.map(run=>run.role)).toEqual(['planner','interpreter','validator','validator']);expect(runs.every(run=>run.status==='SUCCEEDED')).toBe(true);
      expect(db.evidence(task.id).filter(item=>item.source.startsWith('model')).every(item=>item.kind==='INFERENCE')).toBe(true);
    }finally{await new Promise<void>(resolve=>fake.close(()=>resolve()));db.close();}
  });
  it('retries only the failed stage and retains prior outputs',async()=>{
    const {dataDir,db}=await setup();let fail=true;
    const engine=new WorkflowEngine(db,{dataDir,adapters:[adapter({analyze:async()=>{if(fail)throw new Error('injected failure');return {ok:true};}})]});
    const project=db.project({name:'test',kind:'software',authorizationConfirmed:true});
    const task=await engine.create(project.id,{adapter:'file'});
    await engine.execute(task.id);
    expect(db.getTask(task.id)?.status).toBe('FAILED');
    expect(db.getTask(task.id)?.currentStage).toBe('ANALYZE');
    fail=false;engine.retry(task.id);await engine.execute(task.id);
    expect(db.getTask(task.id)?.status).toBe('COMPLETED');
    expect(db.stageOutput(task.id,'PREPARE')).toEqual({prepared:true});
    expect(db.stages(task.id).find(s=>s.name==='ANALYZE')?.attempt).toBe(2);
    db.close();
  });
});

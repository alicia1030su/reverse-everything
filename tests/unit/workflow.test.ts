import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { utimesSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Database, WorkflowEngine, type AdapterDefinition, type TaskContext } from '@reverse/workflow';
import { hashFile, safeArtifactName } from '@reverse/evidence';
const dirs:string[]=[];
const artifactWriteGate=vi.hoisted(()=>({size:1024*1024,entered:undefined as (()=>void)|undefined,release:undefined as (()=>void)|undefined}));
const artifactPathGate=vi.hoisted(()=>({file:undefined as string|undefined,onRegular:undefined as (()=>void|Promise<void>)|undefined,override:undefined as (()=>Promise<{isFile():boolean;isSymbolicLink():boolean}>)|undefined,onRegularSync:undefined as (()=>void)|undefined,overrideSync:undefined as (()=>{isFile():boolean;isSymbolicLink():boolean})|undefined}));
const artifactOpenGate=vi.hoisted(()=>({file:undefined as string|undefined,onOpen:undefined as (()=>void|Promise<void>)|undefined}));
const artifactMkdirGate=vi.hoisted(()=>({dir:undefined as string|undefined,onMkdir:undefined as (()=>void|Promise<void>)|undefined}));
const artifactHashGate=vi.hoisted(()=>({reads:0,delayMs:0}));
vi.mock('node:fs',async importOriginal=>{const actual=await importOriginal<typeof import('node:fs')>();return {...actual,readSync:(...args:Parameters<typeof actual.readSync>)=>{if(artifactHashGate.delayMs){artifactHashGate.reads++;const began=performance.now();while(performance.now()-began<artifactHashGate.delayMs){}}return actual.readSync(...args);},lstatSync:(...args:Parameters<typeof actual.lstatSync>)=>{if(artifactPathGate.file===String(args[0])&&artifactPathGate.overrideSync)return artifactPathGate.overrideSync();const result=actual.lstatSync(...args);if(artifactPathGate.file===String(args[0])&&result?.isFile()&&artifactPathGate.onRegularSync){const hook=artifactPathGate.onRegularSync;artifactPathGate.onRegularSync=undefined;hook();}return result;}};});
vi.mock('node:fs/promises',async importOriginal=>{const actual=await importOriginal<typeof import('node:fs/promises')>();return {...actual,writeFile:async(...args:Parameters<typeof actual.writeFile>)=>{const result=await actual.writeFile(...args);if(args[1] instanceof Uint8Array&&args[1].byteLength===artifactWriteGate.size&&artifactWriteGate.entered){const entered=artifactWriteGate.entered;artifactWriteGate.entered=undefined;entered();await new Promise<void>(resolve=>{artifactWriteGate.release=resolve;});}return result;},lstat:async(...args:Parameters<typeof actual.lstat>)=>{if(artifactPathGate.file===String(args[0])&&artifactPathGate.override)return artifactPathGate.override();const result=await actual.lstat(...args);if(artifactPathGate.file===String(args[0])&&result.isFile()&&artifactPathGate.onRegular){const hook=artifactPathGate.onRegular;artifactPathGate.onRegular=undefined;await hook();}return result;},open:async(...args:Parameters<typeof actual.open>)=>{const result=await actual.open(...args);if(artifactHashGate.delayMs&&args[1]!=='wx'){const read=result.read.bind(result);result.read=async(...readArgs:Parameters<typeof result.read>)=>{artifactHashGate.reads++;await new Promise(resolve=>setTimeout(resolve,artifactHashGate.delayMs));return read(...readArgs);};}if(artifactOpenGate.file===String(args[0])&&artifactOpenGate.onOpen){const hook=artifactOpenGate.onOpen;artifactOpenGate.onOpen=undefined;await hook();}return result;},mkdir:async(...args:Parameters<typeof actual.mkdir>)=>{const result=await actual.mkdir(...args);if(artifactMkdirGate.dir===String(args[0])&&artifactMkdirGate.onMkdir){const hook=artifactMkdirGate.onMkdir;artifactMkdirGate.onMkdir=undefined;await hook();}return result;}};});
afterEach(async()=>{vi.useRealTimers();artifactHashGate.reads=0;artifactHashGate.delayMs=0;artifactWriteGate.release?.();artifactWriteGate.release=undefined;artifactWriteGate.entered=undefined;artifactPathGate.file=undefined;artifactPathGate.onRegular=undefined;artifactPathGate.override=undefined;artifactPathGate.onRegularSync=undefined;artifactPathGate.overrideSync=undefined;artifactOpenGate.file=undefined;artifactOpenGate.onOpen=undefined;artifactMkdirGate.dir=undefined;artifactMkdirGate.onMkdir=undefined;for(const d of dirs.splice(0))await rm(d,{recursive:true,force:true});});
async function setup(){const dataDir=await mkdtemp(path.join(os.tmpdir(),'re-workflow-'));dirs.push(dataDir);const db=new Database(':memory:');return {dataDir,db};}
async function waitUntil(predicate:()=>boolean,timeoutMs=3000){const deadline=Date.now()+timeoutMs;while(!predicate()){if(Date.now()>deadline)throw new Error('Condition timed out');await new Promise(resolve=>setTimeout(resolve,5));}}
function objectDir(dataDir:string,taskId:string){return path.join(dataDir,'tasks',taskId,'artifacts','objects');}
function adapter(overrides:Partial<AdapterDefinition>={}):AdapterDefinition{return {name:'file',version:'test',description:'test',available:async()=>({available:true,detail:'test'}),detect:async()=>({adapter:'file',confidence:1,format:'test',details:{},limitations:[]}),prepare:async()=>({prepared:true}),analyze:async()=>({ok:true}),extractEvidence:async()=>({}),reconstruct:async()=>({}),validate:async()=>({passed:true,checks:[]}),...overrides};}
describe('persistent workflow',()=>{
  it('binds direct path tasks to their real hash without selecting a project upload',async()=>{
    const {dataDir,db}=await setup();const project=db.project({name:'direct-path',kind:'software',authorizationConfirmed:true});const uploadDir=path.join(dataDir,'uploads',project.id);await mkdir(uploadDir,{recursive:true});const uploaded=path.join(uploadDir,'first.bin');await writeFile(uploaded,'uploaded');db.addUpload({id:'first-upload',projectId:project.id,name:'first.bin',storedName:'first.bin',mime:'application/octet-stream',size:8,sha256:await hashFile(uploaded),createdAt:new Date().toISOString()});const first=path.join(dataDir,'first-path.bin'),second=path.join(dataDir,'second-path.bin');await writeFile(first,'same');await writeFile(second,'same');let detections=0;let sawUpload=false;const {AnalysisCache}=await import('@reverse/workflow');const cache=new AnalysisCache(db,dataDir);const engine=new WorkflowEngine(db,{dataDir,cache,adapters:[adapter({detect:async ctx=>{sawUpload||=Boolean(ctx.upload);detections++;return {adapter:'file',confidence:1,format:`path-${detections}`,details:{},limitations:[]};}})]});const task=await engine.create(project.id,{adapter:'file',options:{path:first}});expect(task.inputHash).toBe(await hashFile(first));await engine.execute(task.id);expect(db.getTask(task.id)?.status,db.getTask(task.id)?.error).toBe('COMPLETED');expect(sawUpload).toBe(false);expect(db.evidence(task.id).some(item=>item.title==='Direct path identity verified'&&item.locator===`sha256:${task.inputHash}`)).toBe(true);const other=await engine.create(project.id,{adapter:'file',options:{path:second}});expect(other.inputHash).toBe(task.inputHash);await engine.execute(other.id);expect(detections).toBe(2);expect(db.stageOutput(other.id,'CLASSIFY')).toMatchObject({format:'path-2'});await writeFile(first,'changed');db.updateTask(task.id,{status:'QUEUED',current_stage:'INTAKE',error:null});await engine.execute(task.id);expect(db.getTask(task.id)?.status,db.getTask(task.id)?.error).toBe('COMPLETED');expect(db.evidence(task.id).some(item=>item.title==='Direct path identity verified'&&item.content&&typeof item.content==='object'&&'snapshot' in item.content&&item.content.snapshot===true)).toBe(true);db.close();
  });
  it('keeps analyzing an immutable snapshot after the direct source changes',async()=>{
    const {dataDir,db}=await setup();const project=db.project({name:'snapshot-path',kind:'software',authorizationConfirmed:true});const source=path.join(dataDir,'source.bin');await writeFile(source,'original');let seen='',seenPath='';const engine=new WorkflowEngine(db,{dataDir,adapters:[adapter({analyze:async ctx=>{seenPath=String(ctx.options.path);seen=await readFile(seenPath,'utf8');return {seen};}})]});const task=await engine.create(project.id,{adapter:'file',options:{path:source}});await engine.execute(task.id);expect(db.getTask(task.id)?.status,db.getTask(task.id)?.error).toBe('COMPLETED');expect(seen).toBe('original');expect(path.basename(seenPath)).toBe('source.bin');await writeFile(source,'tampered');db.updateTask(task.id,{status:'QUEUED',current_stage:'CLASSIFY',error:null});await engine.execute(task.id);expect(db.getTask(task.id)?.status,db.getTask(task.id)?.error).toBe('COMPLETED');expect(seen).toBe('original');expect(path.basename(seenPath)).toBe('source.bin');db.close();
  });
  it('runs adapter input validation before creating a direct path snapshot',async()=>{
    const {dataDir,db}=await setup();const project=db.project({name:'validated-snapshot-path',kind:'software',authorizationConfirmed:true});const source=path.join(dataDir,'source.ini');await writeFile(source,'[general]\nname=validated\n');let taskId='',validated='';const engine=new WorkflowEngine(db,{dataDir,adapters:[adapter({validateInput:async ctx=>{validated=String(ctx.options.path);if(await lstat(path.join(dataDir,'tasks',taskId,'input-snapshot')).catch(()=>undefined))throw new Error('snapshot existed before input validation');if(validated!==source)throw new Error('adapter did not receive the original path');}})]});const task=await engine.create(project.id,{adapter:'file',options:{path:source}});taskId=task.id;await engine.execute(task.id);expect(db.getTask(task.id)?.status,db.getTask(task.id)?.error).toBe('COMPLETED');expect(validated).toBe(source);db.close();
  });
  it('rejects task creation before hashing when adapter input validation fails',async()=>{
    const {dataDir,db}=await setup();const project=db.project({name:'rejected-snapshot-path',kind:'software',authorizationConfirmed:true});const source=path.join(dataDir,'source.ini');await writeFile(source,'[general]\nname=rejected\n');const engine=new WorkflowEngine(db,{dataDir,adapters:[adapter({validateInput:async()=>{throw new Error('input rejected');}})]});await expect(engine.create(project.id,{adapter:'file',options:{path:source}})).rejects.toThrow(/input rejected/);expect(db.raw.prepare('SELECT COUNT(*) count FROM tasks WHERE project_id=?').get(project.id)).toEqual({count:0});db.close();
  });
  it('resumes INTAKE from a valid snapshot after the original source changes',async()=>{
    const {dataDir,db}=await setup();const project=db.project({name:'resume-intake-snapshot',kind:'software',authorizationConfirmed:true});const source=path.join(dataDir,'source.ini');await writeFile(source,'[general]\nname=original\n');let detections=0,validations=0;const engine=new WorkflowEngine(db,{dataDir,adapters:[adapter({validateInput:async()=>{validations++;},detect:async()=>{if(++detections===1)throw new Error('crash after snapshot');return {adapter:'file',confidence:1,format:'ini',details:{},limitations:[]};}})]});const task=await engine.create(project.id,{adapter:'file',options:{path:source}});await engine.execute(task.id);expect(db.getTask(task.id)?.status).toBe('FAILED');expect(db.getTask(task.id)?.error).toContain('crash after snapshot');await writeFile(source,'[general]\nname=tampered\n');db.updateTask(task.id,{status:'QUEUED',current_stage:'INTAKE',error:null});await engine.execute(task.id);expect(db.getTask(task.id)?.status,db.getTask(task.id)?.error).toBe('COMPLETED');expect(validations).toBe(2);db.close();
  });
  it('hashes identical directory trees independently of their absolute location',async()=>{
    const {dataDir,db}=await setup();const project=db.project({name:'directory-hash',kind:'software',authorizationConfirmed:true});const first=path.join(dataDir,'first'),second=path.join(dataDir,'second');for(const root of [first,second]){await mkdir(path.join(root,'nested'),{recursive:true});await writeFile(path.join(root,'nested','sample.ini'),'[general]\nname=same\n');}const engine=new WorkflowEngine(db,{dataDir,adapters:[adapter()]});const firstTask=await engine.create(project.id,{adapter:'file',options:{path:first}});const secondTask=await engine.create(project.id,{adapter:'file',options:{path:second}});expect(secondTask.inputHash).toBe(firstTask.inputHash);db.close();
  });
  it('persists the only upload binding and rejects ambiguous direct uploads',async()=>{
    const {dataDir,db}=await setup();const project=db.project({name:'upload-binding',kind:'software',authorizationConfirmed:true});const dir=path.join(dataDir,'uploads',project.id);await mkdir(dir,{recursive:true});const file=path.join(dir,'one.bin');await writeFile(file,'one');const digest=await hashFile(file);db.addUpload({id:'one',projectId:project.id,name:'one.bin',storedName:'one.bin',mime:'application/octet-stream',size:3,sha256:digest,createdAt:new Date().toISOString()});const engine=new WorkflowEngine(db,{dataDir,adapters:[adapter()]});const task=await engine.create(project.id,{adapter:'file',options:{}});expect(task.options.uploadId).toBe('one');expect(task.inputHash).toBe(digest);db.addUpload({id:'two',projectId:project.id,name:'two.bin',storedName:'two.bin',mime:'application/octet-stream',size:3,sha256:'two',createdAt:new Date().toISOString()});await expect(engine.create(project.id,{adapter:'file',options:{}})).rejects.toThrow(/ambiguous/);db.close();
  });
  it('fails closed for unsafe direct paths instead of falling back to an upload',async()=>{
    const {dataDir,db}=await setup();const project=db.project({name:'unsafe-path',kind:'software',authorizationConfirmed:true});const engine=new WorkflowEngine(db,{dataDir,adapters:[adapter()]});await expect(engine.create(project.id,{adapter:'file',options:{path:'relative.bin'}})).rejects.toThrow(/absolute/);await expect(engine.create(project.id,{adapter:'file',options:{path:path.join(dataDir,'missing.bin')}})).rejects.toThrow();expect(db.raw.prepare('SELECT COUNT(*) count FROM tasks WHERE project_id=?').get(project.id)).toEqual({count:0});db.close();
  });
  it('loads persisted plan budgets and upload binding instead of client options',async()=>{
    const {dataDir,db}=await setup();const project=db.project({name:'plan-budget',kind:'protocol',authorizationConfirmed:true});const dir=path.join(dataDir,'uploads',project.id);await mkdir(dir,{recursive:true});const file=path.join(dir,'input.har');await writeFile(file,'HAR');const digest=await hashFile(file);db.addUpload({id:'bound-upload',projectId:project.id,name:'input.har',storedName:'input.har',mime:'application/octet-stream',size:3,sha256:digest,createdAt:new Date().toISOString()});db.addUpload({id:'other-upload',projectId:project.id,name:'other.har',storedName:'other.har',mime:'application/octet-stream',size:3,sha256:'other',createdAt:new Date().toISOString()});
    db.raw.prepare("INSERT INTO authorization_scopes (id,project_id,target,scope_json,allowed_interfaces_json,allowed_operations_json,data_access_json,remote_ai_allowed,expires_at,created_at,revoked_at) VALUES ('auth',?,'bound-upload','[]','[\"file\"]','[\"read-target\",\"execute-analyzer\"]','[\"HAR\"]',0,NULL,?,NULL)").run(project.id,new Date().toISOString());
    db.raw.prepare("INSERT INTO analysis_plans (id,project_id,task_id,mode,target_json,detection_json,authorization_id,upload_id,upload_sha256,steps_json,budget_json,status,created_at,updated_at) VALUES ('plan',?,NULL,'beginner','{\"kind\":\"HAR\"}','{}','auth','bound-upload',?,'[{\"id\":\"execution\",\"kind\":\"execution\",\"status\":\"READY\",\"analyzer\":\"file\",\"adapterAllowlist\":[\"file\"]}]',?,'CREATED',?,?)").run(project.id,digest,JSON.stringify({timeoutMs:1000,maxMemoryBytes:104857600,maxDiskBytes:2097152,maxModelIterations:1}),new Date().toISOString(),new Date().toISOString());
    let seenUpload='';let effective=0;const fetchSpy=vi.spyOn(globalThis,'fetch');const engine=new WorkflowEngine(db,{dataDir,adapters:[adapter({prepare:async ctx=>{seenUpload=ctx.upload!.id;effective=ctx.effectiveMaxDiskMB!;return {};}})],getAiConfig:()=>({enabled:true,baseUrl:'https://example.invalid/v1',model:'fixture',allowRemoteData:true})});const task=await engine.create(project.id,{adapter:'file',options:{planId:'plan',uploadId:'other-upload',maxDiskMB:999}});db.raw.prepare("UPDATE analysis_plans SET task_id=? WHERE id='plan'").run(task.id);await engine.execute(task.id);expect(db.getTask(task.id)?.status).toBe('COMPLETED');expect(seenUpload).toBe('bound-upload');expect(effective).toBe(2);expect(fetchSpy).not.toHaveBeenCalled();expect(db.evidence(task.id).some(item=>item.title==='AI interpretation not requested')).toBe(true);db.close();
  });
  it('keeps local AI enabled for a target-bound plan without remote AI consent',async()=>{
    const {dataDir,db}=await setup();const project=db.project({name:'local-ai-plan',kind:'website',target:' HTTPS://EXAMPLE.TEST:443/research#overview ',authorizationConfirmed:true});
    db.raw.prepare("INSERT INTO authorization_scopes (id,project_id,target,scope_json,allowed_interfaces_json,allowed_operations_json,data_access_json,remote_ai_allowed,expires_at,created_at,revoked_at) VALUES ('local-auth',?,'https://example.test/research','[]','[\"website\"]','[\"read-target\",\"execute-analyzer\"]','[\"UNKNOWN\"]',0,NULL,?,NULL)").run(project.id,new Date().toISOString());
    db.raw.prepare("INSERT INTO analysis_plans (id,project_id,task_id,mode,target_json,detection_json,authorization_id,upload_id,upload_sha256,steps_json,budget_json,status,created_at,updated_at) VALUES ('local-plan',?,NULL,'agent','{\"kind\":\"UNKNOWN\"}','{}','local-auth',NULL,NULL,'[{\"id\":\"execution\",\"kind\":\"execution\",\"status\":\"READY\",\"analyzer\":\"website\",\"adapterAllowlist\":[\"website\"]}]',?,'CREATED',?,?)").run(project.id,JSON.stringify({timeoutMs:1000,maxMemoryBytes:104857600,maxDiskBytes:2097152,maxModelIterations:1}),new Date().toISOString(),new Date().toISOString());
    let requests=0;const fake=http.createServer((req,res)=>{requests++;req.resume();req.on('end',()=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:'{"summary":"ok","uncertainties":[],"suggested_checks":[]}'}}]}));});});await new Promise<void>(resolve=>fake.listen(0,'127.0.0.1',resolve));const address=fake.address();if(!address||typeof address==='string')throw new Error('No fake AI port');
    try{const engine=new WorkflowEngine(db,{dataDir,adapters:[adapter({name:'website'})],getAiConfig:()=>({enabled:true,baseUrl:`http://127.0.0.1:${address.port}/v1`,model:'local-fixture'})});const task=await engine.create(project.id,{adapter:'website',options:{planId:'local-plan'}});db.raw.prepare("UPDATE analysis_plans SET task_id=? WHERE id='local-plan'").run(task.id);await engine.execute(task.id);expect(db.getTask(task.id)?.status,db.getTask(task.id)?.error).toBe('COMPLETED');expect(requests).toBeGreaterThan(0);expect(db.evidence(task.id).some(item=>item.title==='AI interpretation (not factual evidence)')).toBe(true);}finally{await new Promise<void>(resolve=>fake.close(()=>resolve()));db.close();}
  });
  it('maps planner analyzer IDs to their real adapter names for APK and USB plans',async()=>{
    for(const [analyzer,adapterName,kind] of [['jadx','apk','APK'],['usb','hardware','PCAP']] as const){
      const {dataDir,db}=await setup();const project=db.project({name:`${analyzer}-mapping`,kind:'software',target:'offline-sample',authorizationConfirmed:true});const dir=path.join(dataDir,'uploads',project.id);await mkdir(dir,{recursive:true});const file=path.join(dir,'sample.bin');await writeFile(file,'sample');const digest=await hashFile(file);db.addUpload({id:'bound-upload',projectId:project.id,name:'sample.bin',storedName:'sample.bin',mime:'application/octet-stream',size:6,sha256:digest,createdAt:new Date().toISOString()});
      db.raw.prepare("INSERT INTO authorization_scopes (id,project_id,target,scope_json,allowed_interfaces_json,allowed_operations_json,data_access_json,remote_ai_allowed,expires_at,created_at,revoked_at) VALUES ('auth',?,'bound-upload','[]',?,'[\"read-target\",\"execute-analyzer\"]',?,0,NULL,?,NULL)").run(project.id,JSON.stringify([analyzer]),JSON.stringify([kind]),new Date().toISOString());
      db.raw.prepare("INSERT INTO analysis_plans (id,project_id,task_id,mode,target_json,detection_json,authorization_id,upload_id,upload_sha256,steps_json,budget_json,status,created_at,updated_at) VALUES ('plan',?,NULL,'beginner',?,'{}','auth','bound-upload',?,?,?,'CREATED',?,?)").run(project.id,JSON.stringify({kind}),digest,JSON.stringify([{id:'execution',kind:'execution',status:'READY',analyzer,adapterAllowlist:[analyzer]}]),JSON.stringify({timeoutMs:1000,maxMemoryBytes:104857600,maxDiskBytes:2097152,maxModelIterations:1}),new Date().toISOString(),new Date().toISOString());
      const engine=new WorkflowEngine(db,{dataDir,adapters:[adapter({name:adapterName})]});const task=await engine.create(project.id,{adapter:adapterName,options:{planId:'plan',uploadId:'bound-upload'}});await engine.execute(task.id);expect(db.getTask(task.id)?.status,db.getTask(task.id)?.error).toBe('COMPLETED');db.close();
    }
  });
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
  it('atomically cancels a PAUSED task and never leaves resume stranded in QUEUED',async()=>{
    const {dataDir,db}=await setup();const engine=new WorkflowEngine(db,{dataDir,adapters:[adapter()],pollMs:100000});
    const project=db.project({name:'paused-cancel',kind:'software',authorizationConfirmed:true});const task=await engine.create(project.id,{adapter:'file'});
    db.updateTask(task.id,{status:'PAUSED',pause_requested:1});
    expect(engine.cancel(task.id)).toBe(true);
    expect(db.getTask(task.id)).toMatchObject({status:'CANCELLED',pauseRequested:false,cancelRequested:false,endedAt:expect.any(String)});
    expect(engine.resume(task.id)).toBe(false);expect(db.getTask(task.id)?.status).toBe('CANCELLED');db.close();
  });

  it('records fresh Detected evidence for each task when CLASSIFY is cached',async()=>{
    const {dataDir,db}=await setup();let detections=0;const {AnalysisCache}=await import('@reverse/workflow');const cache=new AnalysisCache(db,dataDir);
    const engine=new WorkflowEngine(db,{dataDir,adapters:[adapter({detect:async()=>{detections++;return {adapter:'file',confidence:1,format:'test',details:{},limitations:[]};}})],cache,pollMs:100000});
    const project=db.project({name:'classify-evidence',kind:'software',authorizationConfirmed:true});const first=await engine.create(project.id,{adapter:'file'});const second=await engine.create(project.id,{adapter:'file'});
    await engine.execute(first.id);await engine.execute(second.id);
    const evidence=db.evidence(second.id).find(item=>item.title==='Detected test');
    expect(evidence).toMatchObject({taskId:second.id,kind:'VERIFIED',source:'file',locator:'detect'});
    expect(evidence?.id).not.toBe(db.evidence(first.id).find(item=>item.title==='Detected test')?.id);expect(detections).toBe(1);db.close();
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
    expect(db.artifacts(task.id)).toEqual([]);expect(await readdir(objectDir(dataDir,task.id))).toEqual([]);
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
  it('admits only one execution for the same task across engine instances',async()=>{
    const {dataDir,db}=await setup();let calls=0;let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);
    const first=new WorkflowEngine(db,{dataDir,adapters:[adapter({prepare:async()=>{calls++;await gate;return {prepared:true};}})],workerId:'worker-a',leaseMs:5000});
    const second=new WorkflowEngine(db,{dataDir,adapters:[adapter({prepare:async()=>{calls++;return {prepared:true};}})],workerId:'worker-b',leaseMs:5000});
    const project=db.project({name:'single-execution',kind:'software',authorizationConfirmed:true});const task=await first.create(project.id,{adapter:'file'});const running=first.execute(task.id);await waitUntil(()=>db.getTask(task.id)?.currentStage==='PREPARE'&&calls===1);
    await first.execute(task.id);await second.execute(task.id);expect(calls).toBe(1);expect(db.getTask(task.id)?.status).toBe('RUNNING');release();await running;expect(db.getTask(task.id)?.status).toBe('COMPLETED');expect(calls).toBe(1);expect(db.raw.prepare('SELECT COUNT(*) count FROM task_resources WHERE task_id=?').get(task.id)).toEqual({count:1});db.close();
  });
  it('invalidates an expired execution before it can publish or change the replacement result',async()=>{
    const {dataDir,db}=await setup();let releaseOld!:()=>void;const oldGate=new Promise<void>(resolve=>releaseOld=resolve);let oldEntered!:()=>void;const entered=new Promise<void>(resolve=>oldEntered=resolve);const first=new WorkflowEngine(db,{dataDir,adapters:[adapter({prepare:async ctx=>{oldEntered();await oldGate;await ctx.writeArtifact('old.bin','o'.repeat(600_000),'application/octet-stream');return {prepared:true};}})],workerId:'same-worker',leaseMs:50});
    const project=db.project({name:'lease-takeover',kind:'software',authorizationConfirmed:true});const task=await first.create(project.id,{adapter:'file',options:{maxDiskMB:1}});const oldRun=first.execute(task.id);await entered;db.raw.prepare("UPDATE tasks SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(task.id);
    const second=new WorkflowEngine(db,{dataDir,adapters:[adapter({prepare:async ctx=>{await ctx.writeArtifact('new.bin','n'.repeat(600_000),'application/octet-stream');return {prepared:true};}})],workerId:'same-worker',leaseMs:5000});await second.execute(task.id);expect(db.getTask(task.id)?.status).toBe('COMPLETED');releaseOld();await oldRun;expect(db.getTask(task.id)?.status).toBe('COMPLETED');expect(db.artifacts(task.id).some(item=>item.name==='old.bin')).toBe(false);expect(db.artifacts(task.id).some(item=>item.name==='new.bin')).toBe(true);const resources=db.raw.prepare('SELECT artifact_bytes FROM task_resources WHERE task_id=?').get(task.id) as {artifact_bytes:number};expect(resources.artifact_bytes).toBe(db.artifacts(task.id).reduce((sum,item)=>sum+item.size,0));db.close();
  });
  it('does not let an expired execution delete a takeover object with the same digest',async()=>{
    const {dataDir,db}=await setup();const shared='shared immutable payload';const digest=createHash('sha256').update(shared).digest('hex');const large=Buffer.alloc(artifactWriteGate.size,9);const entries=[{name:'shared.txt',content:shared,mime:'text/plain'},{name:'large.bin',content:large,mime:'application/octet-stream'}];let oldSettled=false;let oldWrite!:Promise<void>;let enteredResolve!:()=>void;const entered=new Promise<void>(resolve=>{enteredResolve=resolve;});artifactWriteGate.entered=enteredResolve;
    const first=new WorkflowEngine(db,{dataDir,adapters:[adapter({prepare:async ctx=>{oldWrite=ctx.writeArtifacts!(entries);await oldWrite;return {prepared:true};}})],workerId:'worker-a',leaseMs:5000});const second=new WorkflowEngine(db,{dataDir,adapters:[adapter({prepare:async ctx=>{await ctx.writeArtifact('shared.txt',shared,'text/plain');return {prepared:true};}})],workerId:'worker-b',leaseMs:5000});
    const project=db.project({name:'same-digest-takeover',kind:'software',authorizationConfirmed:true});const task=await first.create(project.id,{adapter:'file',options:{maxDiskMB:8}});const oldRun=first.execute(task.id);void oldRun.then(()=>{oldSettled=true;},()=>{oldSettled=true;});const objects=objectDir(dataDir,task.id);await entered;db.raw.prepare("UPDATE tasks SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(task.id);expect(oldSettled).toBe(false);
    await second.execute(task.id);expect(db.getTask(task.id)?.status).toBe('COMPLETED');expect((await readdir(objects)).some(name=>name.endsWith('.tmp'))).toBe(true);artifactWriteGate.release!();await oldRun;await oldWrite.catch(()=>{});expect(db.getTask(task.id)?.status).toBe('COMPLETED');const artifact=db.artifacts(task.id).find(item=>item.name==='shared.txt');expect(artifact?.sha256).toBe(digest);const file=db.artifactPath(task.id,'shared.txt');expect(file).toBeTruthy();expect(await readFile(file!,'utf8')).toBe(shared);expect(await readdir(objects)).toContain(digest);db.close();
  });
  it('does not admit queued work after close wins the resource-sampling race',async()=>{
    const {dataDir,db}=await setup();let release!:(value:Record<string,unknown>)=>void;const gate=new Promise<Record<string,unknown>>(resolve=>release=resolve);let calls=0;const fake={sampleOrThrow:async()=>{calls++;return gate;},circuit:()=>{}} as unknown as import('@reverse/workflow').ResourceMonitor;const engine=new WorkflowEngine(db,{dataDir,adapters:[adapter()],resources:fake,pollMs:10});const project=db.project({name:'close-race',kind:'software',authorizationConfirmed:true});const task=await engine.create(project.id,{adapter:'file'});engine.start();await waitUntil(()=>calls===1);const closing=engine.close();release({treeRssMB:100,childRssMB:0,cpuPercent:0,heapUsedMB:10,pressure:'normal'});await closing;expect(db.getTask(task.id)?.status).toBe('QUEUED');expect(db.raw.prepare('SELECT lease_owner FROM tasks WHERE id=?').get(task.id)).toEqual({lease_owner:null});db.close();
  });
  it.each([Number.NaN,Number.POSITIVE_INFINITY,0,-1])('rejects invalid maxDiskMB=%s instead of disabling the budget',async maxDiskMB=>{
    const {dataDir,db}=await setup();expect(()=>new WorkflowEngine(db,{dataDir,adapters:[],maxDiskMB})).toThrow(/maxDiskMB/);db.close();
  });
  it('cleans an in-flight temporary artifact when cancellation aborts the write',async()=>{
    const {dataDir,db}=await setup();let writing:Promise<void>|undefined;const engine=new WorkflowEngine(db,{dataDir,adapters:[adapter({prepare:async ctx=>{writing=ctx.writeArtifact('large.bin',Buffer.alloc(128*1024*1024),'application/octet-stream');await writing;return {prepared:true};}})],pollMs:100000});
    const project=db.project({name:'cancel-artifact-write',kind:'software',authorizationConfirmed:true});const task=await engine.create(project.id,{adapter:'file'});const running=engine.execute(task.id);const artifacts=objectDir(dataDir,task.id);const deadline=Date.now()+5000;while(Date.now()<deadline){try{if((await readdir(artifacts)).some(name=>name.endsWith('.tmp')))break;}catch{}await new Promise(resolve=>setTimeout(resolve,5));}expect((await readdir(artifacts)).some(name=>name.endsWith('.tmp'))).toBe(true);
    expect(engine.cancel(task.id)).toBe(true);await running;await writing?.catch(()=>{});expect(db.getTask(task.id)?.status).toBe('CANCELLED');expect(db.artifacts(task.id)).toEqual([]);expect(await readdir(artifacts)).toEqual([]);const resources=db.raw.prepare('SELECT artifact_bytes FROM task_resources WHERE task_id=?').get(task.id) as {artifact_bytes:number};expect(resources.artifact_bytes).toBe(0);db.close();
  });
  it('canonicalizes artifact aliases to one record, file and digest on every platform',async()=>{
    const {dataDir,db}=await setup();expect(safeArtifactName('Same.TXT')).toBe('same.txt');expect(safeArtifactName('CON.txt')).toBe('_con.txt');expect(safeArtifactName('dir\\report.txt','win32')).toBe('report.txt');expect(safeArtifactName('dir\\report.txt','linux')).toBe('report.txt');expect(()=>safeArtifactName('LONGFI~1.TXT')).toThrow(/artifact name/);const engine=new WorkflowEngine(db,{dataDir,adapters:[adapter({prepare:async ctx=>{await ctx.writeArtifact('Same.TXT','old','text/plain');await ctx.writeArtifact('same.txt','new','text/plain');return {prepared:true};}})]});const project=db.project({name:'artifact-alias',kind:'software',authorizationConfirmed:true});const task=await engine.create(project.id,{adapter:'file'});await engine.execute(task.id);
    expect(db.getTask(task.id)?.status).toBe('COMPLETED');const artifacts=db.artifacts(task.id).filter(item=>item.name==='same.txt');expect(artifacts).toHaveLength(1);expect(artifacts[0]).toMatchObject({name:'same.txt',size:3});const file=db.artifactPath(task.id,'same.txt')!;expect(await readFile(file,'utf8')).toBe('new');expect(artifacts[0]?.sha256).toBe(await hashFile(file));expect(await readdir(objectDir(dataDir,task.id))).toContain(path.basename(file));db.close();
  });
  it('rejects case aliases inside one artifact batch before writing',async()=>{
    const {dataDir,db}=await setup();const engine=new WorkflowEngine(db,{dataDir,adapters:[adapter({reconstruct:async ctx=>{await ctx.writeArtifacts!([{name:'Same.TXT',content:'first',mime:'text/plain'},{name:'same.txt',content:'second',mime:'text/plain'}]);return {generated:true};}})]});const project=db.project({name:'artifact-alias-batch',kind:'software',authorizationConfirmed:true});const task=await engine.create(project.id,{adapter:'file'});await engine.execute(task.id);expect(db.getTask(task.id)?.status).toBe('FAILED');expect(db.getTask(task.id)?.error).toContain('Duplicate artifact name');expect(db.artifacts(task.id)).toEqual([]);expect(await readdir(objectDir(dataDir,task.id))).toEqual([]);db.close();
  });
  it('publishes batch artifacts together and rolls back every final file on database failure',async()=>{
    const {dataDir,db}=await setup();const original=db.addArtifact;let calls=0;db.addArtifact=((...args:Parameters<typeof db.addArtifact>)=>{calls++;if(calls===2)throw new Error('injected artifact database failure');return original(...args);}) as typeof db.addArtifact;
    const engine=new WorkflowEngine(db,{dataDir,adapters:[adapter({reconstruct:async ctx=>{await ctx.writeArtifacts!([{name:'first.txt',content:'first',mime:'text/plain'},{name:'second.txt',content:'second',mime:'text/plain'}]);return {generated:true};}})]});
    const project=db.project({name:'batch-artifact-rollback',kind:'software',authorizationConfirmed:true});const task=await engine.create(project.id,{adapter:'file'});await engine.execute(task.id);
    expect(db.getTask(task.id)?.status).toBe('FAILED');expect(db.getTask(task.id)?.currentStage).toBe('RECONSTRUCT');expect(db.artifacts(task.id)).toEqual([]);expect(await readdir(objectDir(dataDir,task.id))).toEqual([]);db.close();
  });
  it('restores overwritten artifact files and database rows when a batch commit fails',async()=>{
    const {dataDir,db}=await setup();const original=db.addArtifact.bind(db);let fail=false;db.addArtifact=((...args:Parameters<typeof db.addArtifact>)=>{if(fail)throw new Error('injected replacement failure');return original(...args);}) as typeof db.addArtifact;
    const engine=new WorkflowEngine(db,{dataDir,adapters:[adapter({prepare:async ctx=>{await ctx.writeArtifact('first.txt','old-first','text/plain');await ctx.writeArtifact('second.txt','old-second','text/plain');return {prepared:true};},reconstruct:async ctx=>{fail=true;await ctx.writeArtifacts!([{name:'first.txt',content:'new-first',mime:'text/plain'},{name:'second.txt',content:'new-second',mime:'text/plain'}]);return {generated:true};}})]});
    const project=db.project({name:'batch-artifact-restore',kind:'software',authorizationConfirmed:true});const task=await engine.create(project.id,{adapter:'file'});await engine.execute(task.id);
    expect(db.getTask(task.id)?.error).toContain('injected replacement failure');expect(db.getTask(task.id)?.status).toBe('FAILED');expect(db.getTask(task.id)?.currentStage).toBe('RECONSTRUCT');expect(db.artifacts(task.id).map(item=>item.name).sort()).toEqual(['first.txt','second.txt']);expect(await readFile(db.artifactPath(task.id,'first.txt')!,'utf8')).toBe('old-first');expect(await readFile(db.artifactPath(task.id,'second.txt')!,'utf8')).toBe('old-second');expect((await readdir(objectDir(dataDir,task.id))).every(name=>/^[a-f0-9]{64}$/.test(name))).toBe(true);db.close();
  });
  it.each(['single','batch','mixed'] as const)('serializes concurrent %s artifact writes against one byte budget',async mode=>{
    const {dataDir,db}=await setup();const content='x'.repeat(600_000);const engine=new WorkflowEngine(db,{dataDir,adapters:[adapter({prepare:async ctx=>{if(mode==='single')await Promise.all([ctx.writeArtifact('first.bin',content,'application/octet-stream'),ctx.writeArtifact('second.bin',content,'application/octet-stream')]);else if(mode==='batch')await Promise.all([ctx.writeArtifacts!([{name:'first.bin',content,mime:'application/octet-stream'}]),ctx.writeArtifacts!([{name:'second.bin',content,mime:'application/octet-stream'}])]);else await Promise.all([ctx.writeArtifact('first.bin',content,'application/octet-stream'),ctx.writeArtifacts!([{name:'second.bin',content,mime:'application/octet-stream'}])]);return {prepared:true};}})],maxDiskMB:1});
    const project=db.project({name:`concurrent-${mode}-budget`,kind:'software',authorizationConfirmed:true});const task=await engine.create(project.id,{adapter:'file'});await engine.execute(task.id);
    expect(db.getTask(task.id)?.status).toBe('FAILED');expect(db.getTask(task.id)?.error).toContain('artifact budget');const artifacts=db.artifacts(task.id);expect(artifacts).toHaveLength(1);expect(artifacts[0]?.size).toBe(600_000);const resources=db.raw.prepare('SELECT artifact_bytes FROM task_resources WHERE task_id=?').get(task.id) as {artifact_bytes:number};expect(resources.artifact_bytes).toBe(600_000);expect(await readdir(objectDir(dataDir,task.id))).toEqual([path.basename(db.artifactPath(task.id,artifacts[0]!.name)!)]);db.close();
  });
  it.each([false,true])('rolls back a single artifact when database publication fails (existing=%s)',async existing=>{
    const {dataDir,db}=await setup();const original=db.addArtifact.bind(db);let fail=false;db.addArtifact=((...args:Parameters<typeof db.addArtifact>)=>{if(fail)throw new Error('injected single artifact failure');return original(...args);}) as typeof db.addArtifact;
    const engine=new WorkflowEngine(db,{dataDir,adapters:[adapter({prepare:async ctx=>{if(existing)await ctx.writeArtifact('target.txt','old','text/plain');return {prepared:true};},analyze:async ctx=>{fail=true;await ctx.writeArtifact('target.txt','new','text/plain');return {ok:true};}})]});
    const project=db.project({name:`single-artifact-rollback-${existing}`,kind:'software',authorizationConfirmed:true});const task=await engine.create(project.id,{adapter:'file'});await engine.execute(task.id);
    expect(db.getTask(task.id)?.status).toBe('FAILED');expect(db.getTask(task.id)?.error).toContain('injected single artifact failure');if(existing){expect(db.artifacts(task.id).map(item=>item.name)).toEqual(['target.txt']);expect(await readFile(db.artifactPath(task.id,'target.txt')!,'utf8')).toBe('old');expect(await readdir(objectDir(dataDir,task.id))).toHaveLength(1);}else{expect(db.artifacts(task.id)).toEqual([]);expect(await readdir(objectDir(dataDir,task.id))).toEqual([]);}const resources=db.raw.prepare('SELECT artifact_bytes FROM task_resources WHERE task_id=?').get(task.id) as {artifact_bytes:number};expect(resources.artifact_bytes).toBe(existing?3:0);db.close();
  });
  it('does not expose a direct artifact directory and reads published bytes through the context',async()=>{
    const {dataDir,db}=await setup();const engine=new WorkflowEngine(db,{dataDir,adapters:[adapter({prepare:async ctx=>{expect(ctx).not.toHaveProperty('artifactDir');await ctx.writeArtifact('readable.txt','controlled','text/plain');expect(Buffer.from(await ctx.readArtifact('readable.txt')).toString()).toBe('controlled');return {prepared:true};}})]});const project=db.project({name:'controlled-artifacts',kind:'software',authorizationConfirmed:true});const task=await engine.create(project.id,{adapter:'file'});await engine.execute(task.id);expect(db.getTask(task.id)?.status).toBe('COMPLETED');db.close();
  });
  it('prunes orphaned immutable objects and stale temporary files before execution',async()=>{
    const {dataDir,db}=await setup();const engine=new WorkflowEngine(db,{dataDir,adapters:[adapter()]});const project=db.project({name:'orphan-artifacts',kind:'software',authorizationConfirmed:true});const task=await engine.create(project.id,{adapter:'file'});const objects=objectDir(dataDir,task.id);await mkdir(objects,{recursive:true});await writeFile(path.join(objects,'a'.repeat(64)),'orphan');const temporary=path.join(objects,'.11111111-1111-4111-8111-111111111111.tmp');await writeFile(temporary,'partial');const stale=new Date(Date.now()-11*60*1000);await utimes(temporary,stale,stale);await engine.execute(task.id);expect(await readdir(objects)).not.toContain('a'.repeat(64));expect(await readdir(objects)).not.toContain('.11111111-1111-4111-8111-111111111111.tmp');db.close();
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
  it('restores artifact usage and peak resource metrics across retries',async()=>{
    const {dataDir,db}=await setup();let fail=true;let treeRssMB=200;
    const fake={sampleOrThrow:async()=>({treeRssMB,childRssMB:treeRssMB/2,cpuPercent:treeRssMB/10,heapUsedMB:treeRssMB/4,pressure:'normal'}),circuit:()=>{}} as unknown as import('@reverse/workflow').ResourceMonitor;
    const engine=new WorkflowEngine(db,{dataDir,adapters:[adapter({prepare:async ctx=>{await ctx.writeArtifact('existing.bin','a'.repeat(600_000),'application/octet-stream');return {prepared:true};},analyze:async ctx=>{if(fail)throw new Error('injected failure');await ctx.writeArtifact('retry.bin','b'.repeat(600_000),'application/octet-stream');return {ok:true};}})],resources:fake,maxDiskMB:1});
    const project=db.project({name:'retry-budget',kind:'software',authorizationConfirmed:true});const task=await engine.create(project.id,{adapter:'file'});
    await engine.execute(task.id);expect(db.getTask(task.id)?.status).toBe('FAILED');const first=db.raw.prepare('SELECT peak_tree_rss_mb,artifact_bytes,started_at FROM task_resources WHERE task_id=?').get(task.id) as {peak_tree_rss_mb:number;artifact_bytes:number;started_at:string};expect(first.artifact_bytes).toBe(600_000);expect(first.peak_tree_rss_mb).toBe(200);
    fail=false;treeRssMB=100;engine.retry(task.id);await engine.execute(task.id);
    expect(db.getTask(task.id)?.status).toBe('FAILED');expect(db.getTask(task.id)?.error).toContain('artifact budget');expect(db.artifacts(task.id).map(item=>item.name)).toEqual(['existing.bin']);const retried=db.raw.prepare('SELECT peak_tree_rss_mb,artifact_bytes,started_at FROM task_resources WHERE task_id=?').get(task.id) as {peak_tree_rss_mb:number;artifact_bytes:number;started_at:string};expect(retried.peak_tree_rss_mb).toBe(200);expect(retried.artifact_bytes).toBe(600_000);expect(retried.started_at).toBe(first.started_at);db.close();
  });
  it('charges batch replacements only for their byte delta',async()=>{
    const {dataDir,db}=await setup();let taskId='';let bytesAfterBatch=0;const engine=new WorkflowEngine(db,{dataDir,adapters:[adapter({prepare:async ctx=>{await ctx.writeArtifact('existing.bin','a'.repeat(600_000),'application/octet-stream');return {prepared:true};},analyze:async ctx=>{await ctx.writeArtifacts!([{name:'existing.bin',content:'b'.repeat(600_000),mime:'application/octet-stream'},{name:'additional.bin',content:'c'.repeat(300_000),mime:'application/octet-stream'}]);bytesAfterBatch=db.artifacts(taskId).reduce((total,item)=>total+item.size,0);return {ok:true};}})],maxDiskMB:1});
    const project=db.project({name:'batch-delta-budget',kind:'software',authorizationConfirmed:true});const task=await engine.create(project.id,{adapter:'file'});taskId=task.id;await engine.execute(task.id);
    expect(db.getTask(task.id)?.status).toBe('COMPLETED');expect(bytesAfterBatch).toBe(900_000);const artifacts=db.artifacts(task.id);expect(artifacts.find(item=>item.name==='existing.bin')?.size).toBe(600_000);expect(artifacts.find(item=>item.name==='additional.bin')?.size).toBe(300_000);const resources=db.raw.prepare('SELECT artifact_bytes FROM task_resources WHERE task_id=?').get(task.id) as {artifact_bytes:number};expect(resources.artifact_bytes).toBe(artifacts.reduce((total,item)=>total+item.size,0));db.close();
  });
  it('does not collide artifact names or immutable paths across tasks',async()=>{
    const {dataDir,db}=await setup();const engine=new WorkflowEngine(db,{dataDir,adapters:[adapter()]});const project=db.project({name:'artifact-task-isolation',kind:'software',authorizationConfirmed:true});const first=await engine.create(project.id,{adapter:'file'});const second=await engine.create(project.id,{adapter:'file'});
    const firstPath=path.join(objectDir(dataDir,first.id),'first');const secondPath=path.join(objectDir(dataDir,second.id),'second');db.addArtifact(first.id,'old.txt',firstPath,4,'a'.repeat(64),'text/plain');db.addArtifact(second.id,'new.txt',secondPath,4,'b'.repeat(64),'text/plain');
    expect(db.artifacts(first.id).map(item=>item.name)).toEqual(['old.txt']);expect(db.artifacts(second.id).map(item=>item.name)).toEqual(['new.txt']);db.close();
  });
  it('rechecks an existing object digest inside the publication transaction',async()=>{
    const {dataDir,db}=await setup();const content='trusted';const digest=createHash('sha256').update(content).digest('hex');const project=db.project({name:'artifact-digest-race',kind:'software',authorizationConfirmed:true});const task=db.createTask(project.id,'file',{adapter:'file'},'fixture');const objects=objectDir(dataDir,task.id);await mkdir(objects,{recursive:true});const file=path.join(objects,digest);await writeFile(file,content);db.addArtifact(task.id,'existing.txt',file,content.length,digest,'text/plain');let beginHook:(()=>void)|undefined;const originalExec=db.raw.exec.bind(db.raw);db.raw.exec=((sql:string)=>{if(sql==='BEGIN IMMEDIATE'&&beginHook){const hook=beginHook;beginHook=undefined;hook();}return originalExec(sql);}) as typeof db.raw.exec;
    const engine=new WorkflowEngine(db,{dataDir,adapters:[adapter({prepare:async ctx=>{beginHook=()=>writeFileSync(file,'tamperd');await ctx.writeArtifact('trusted.txt',content,'text/plain');return {prepared:true};}})]});await engine.execute(task.id);
    expect(db.getTask(task.id)?.status).toBe('FAILED');expect(db.artifacts(task.id).map(item=>item.name)).toEqual(['existing.txt']);expect(db.getTask(task.id)?.error).toContain('integrity');db.close();
  });
  it('detects same-size tampering even when mtime is restored',async()=>{
    const {dataDir,db}=await setup();const content='trusted';const digest=createHash('sha256').update(content).digest('hex');const project=db.project({name:'artifact-same-size-race',kind:'software',authorizationConfirmed:true});const task=db.createTask(project.id,'file',{adapter:'file'},'fixture');const objects=objectDir(dataDir,task.id);await mkdir(objects,{recursive:true});const file=path.join(objects,digest);await writeFile(file,content);const before=await import('node:fs/promises').then(fs=>fs.stat(file));db.addArtifact(task.id,'existing.txt',file,content.length,digest,'text/plain');const original=db.addArtifact.bind(db);db.addArtifact=((...args:Parameters<typeof db.addArtifact>)=>{writeFileSync(file,'tamper');import('node:fs').then(fs=>fs.utimesSync(file,before.atime,before.mtime));return original(...args);}) as typeof db.addArtifact;
    const engine=new WorkflowEngine(db,{dataDir,adapters:[adapter({prepare:async ctx=>{await ctx.writeArtifact('trusted.txt',content,'text/plain');return {prepared:true};}})]});await engine.execute(task.id);
    expect(db.getTask(task.id)?.status).toBe('FAILED');expect(db.getTask(task.id)?.error).toContain('integrity');expect(db.artifacts(task.id).map(item=>item.name)).toEqual(['existing.txt']);db.close();
  });

  it('prehashes legacy in-memory artifacts asynchronously outside the publication lock',async()=>{
    const {dataDir,db}=await setup();artifactHashGate.delayMs=2;let maxLag=0;let last=performance.now();let ticks=0;const timer=setInterval(()=>{const now=performance.now();maxLag=Math.max(maxLag,now-last);last=now;ticks++;},5);timer.unref();
    const engine=new WorkflowEngine(db,{dataDir,adapters:[adapter({prepare:async ctx=>{await ctx.writeArtifact('legacy.bin',Buffer.alloc(8*1024*1024,3),'application/octet-stream');return {prepared:true};}})],maxDiskMB:16});
    const project=db.project({name:'artifact-legacy-performance',kind:'software',authorizationConfirmed:true});const task=await engine.create(project.id,{adapter:'file'});await engine.execute(task.id);clearInterval(timer);
    expect(db.getTask(task.id)?.status).toBe('COMPLETED');expect(artifactHashGate.reads).toBeGreaterThan(0);expect(maxLag).toBeLessThan(150);expect(ticks).toBeGreaterThan(3);db.close();
  });

  it('streams large artifacts outside the publication write lock and keeps the event loop responsive',async()=>{
    const {dataDir,db}=await setup();artifactHashGate.delayMs=2;const size=8*1024*1024;let maxTransactionMs=0;let maxLag=0;let ticks=0;let last=performance.now();
    const timer=setInterval(()=>{const now=performance.now();maxLag=Math.max(maxLag,now-last);last=now;ticks++;},5);timer.unref();
    const engine=new WorkflowEngine(db,{dataDir,adapters:[adapter({prepare:async ctx=>{await ctx.writeArtifactFile!('stream.bin',async stream=>{for(let offset=0;offset<size;offset+=64*1024){await new Promise<void>((resolve,reject)=>stream.write(Buffer.alloc(Math.min(64*1024,size-offset),7),error=>error?reject(error):resolve()));}return size;},'application/octet-stream');return {prepared:true};}})],maxDiskMB:16});
    const original=db.raw.exec.bind(db.raw);let inTransaction=false;let began=0;db.raw.exec=((sql:string)=>{if(sql==='BEGIN IMMEDIATE'){began=performance.now();inTransaction=true;}const result=original(sql);if(inTransaction&&sql==='COMMIT'){maxTransactionMs=Math.max(maxTransactionMs,performance.now()-began);inTransaction=false;}return result;}) as typeof db.raw.exec;
    const project=db.project({name:'artifact-stream-performance',kind:'software',authorizationConfirmed:true});const task=await engine.create(project.id,{adapter:'file'});await engine.execute(task.id);clearInterval(timer);
    expect(db.getTask(task.id)?.status).toBe('COMPLETED');const artifact=db.artifacts(task.id).find(item=>item.name==='stream.bin');expect(artifact?.size).toBe(size);expect(artifact?.sha256).toBe(createHash('sha256').update(Buffer.alloc(size,7)).digest('hex'));expect(artifactHashGate.reads).toBeGreaterThan(0);expect(maxTransactionMs).toBeLessThan(100);expect(maxLag).toBeLessThan(150);expect(ticks).toBeGreaterThan(3);db.close();
  });

  it('rejects a final object path swapped to a symlink after lstat validation',async()=>{
    const {dataDir,db}=await setup();const content='payload';const digest=createHash('sha256').update(content).digest('hex');const project=db.project({name:'artifact-symlink-publication',kind:'software',authorizationConfirmed:true});const task=db.createTask(project.id,'file',{adapter:'file'},'fixture');artifactPathGate.file=path.join(objectDir(dataDir,task.id),digest);const original=db.addArtifact.bind(db);db.addArtifact=((...args:Parameters<typeof db.addArtifact>)=>{artifactPathGate.overrideSync=()=>({isFile:()=>false,isSymbolicLink:()=>true});return original(...args);}) as typeof db.addArtifact;
    const engine=new WorkflowEngine(db,{dataDir,adapters:[adapter({prepare:async ctx=>{await ctx.writeArtifact('payload.txt',content,'text/plain');return {prepared:true};}})]});await engine.execute(task.id);
    expect(db.getTask(task.id)?.status).toBe('FAILED');expect(db.artifacts(task.id)).toEqual([]);expect(db.getTask(task.id)?.error).toContain('integrity');db.close();
  });
  it('refuses to read a published object replaced by a symlink',async()=>{
    const {dataDir,db}=await setup();const content='controlled';const digest=createHash('sha256').update(content).digest('hex');const project=db.project({name:'artifact-symlink-read',kind:'software',authorizationConfirmed:true});const task=db.createTask(project.id,'file',{adapter:'file'},'fixture');artifactPathGate.file=path.join(objectDir(dataDir,task.id),digest);
    const engine=new WorkflowEngine(db,{dataDir,adapters:[adapter({prepare:async ctx=>{await ctx.writeArtifact('readable.txt',content,'text/plain');artifactPathGate.override=async()=>({isFile:()=>false,isSymbolicLink:()=>true});await expect(ctx.readArtifact('readable.txt')).rejects.toThrow(/integrity/);return {prepared:true};}})]});await engine.execute(task.id);
    expect(db.getTask(task.id)?.status).toBe('COMPLETED');db.close();
  });
  it.each(['pause','cancel'] as const)('rechecks %s requests under the publication write lock',async action=>{
    const {dataDir,db}=await setup();const project=db.project({name:`artifact-${action}-gate`,kind:'software',authorizationConfirmed:true});const task=db.createTask(project.id,'file',{adapter:'file'},'fixture');let beginHook:(()=>void)|undefined;const originalExec=db.raw.exec.bind(db.raw);db.raw.exec=((sql:string)=>{if(sql==='BEGIN IMMEDIATE'&&beginHook){const hook=beginHook;beginHook=undefined;hook();}return originalExec(sql);}) as typeof db.raw.exec;
    const engine=new WorkflowEngine(db,{dataDir,adapters:[adapter({prepare:async ctx=>{beginHook=()=>{if(action==='pause')engine.pause(task.id);else engine.cancel(task.id);};await ctx.writeArtifact('blocked.txt','blocked','text/plain');return {prepared:true};}})]});await engine.execute(task.id);
    expect(db.artifacts(task.id)).toEqual([]);expect(await readdir(objectDir(dataDir,task.id))).toEqual([]);expect(db.getTask(task.id)?.status).toBe(action==='pause'?'PAUSED':'CANCELLED');db.close();
  });
  it('executes a claim from its persisted lease token when the process map is lost',async()=>{
    const {dataDir,db}=await setup();const engine=new WorkflowEngine(db,{dataDir,adapters:[adapter()],workerId:'worker-a',leaseMs:5000});const project=db.project({name:'claim-token-recovery',kind:'software',authorizationConfirmed:true});const task=await engine.create(project.id,{adapter:'file'});expect(engine.claimNext()).toBe(task.id);expect(db.raw.prepare('SELECT lease_owner FROM tasks WHERE id=?').get(task.id)).toMatchObject({lease_owner:expect.stringContaining('worker-a:')});const other=new WorkflowEngine(db,{dataDir,adapters:[adapter()],workerId:'worker-b',leaseMs:5000});await other.execute(task.id,true);expect(db.getTask(task.id)?.status).toBe('RUNNING');(engine as unknown as {claimedTokens?:Map<string,string>}).claimedTokens?.clear();await engine.execute(task.id,true);
    expect(db.getTask(task.id)?.status).toBe('COMPLETED');expect(db.raw.prepare('SELECT lease_owner FROM tasks WHERE id=?').get(task.id)).toEqual({lease_owner:null});db.close();
  });
  it('releases the durable claim token when execution fails',async()=>{
    const {dataDir,db}=await setup();const engine=new WorkflowEngine(db,{dataDir,adapters:[adapter({prepare:async()=>{throw new Error('injected claim failure');}})],workerId:'worker-a',leaseMs:5000});const project=db.project({name:'claim-failure',kind:'software',authorizationConfirmed:true});const task=await engine.create(project.id,{adapter:'file'});expect(engine.claimNext()).toBe(task.id);await engine.execute(task.id,true);
    expect(db.getTask(task.id)?.status).toBe('FAILED');expect(db.getTask(task.id)?.error).toContain('injected claim failure');expect(db.raw.prepare('SELECT lease_owner,lease_expires_at FROM tasks WHERE id=?').get(task.id)).toEqual({lease_owner:null,lease_expires_at:null});db.close();
  });
  it('recovers an abandoned claim after lease expiry and executes it with a durable token',async()=>{
    const {dataDir,db}=await setup();const first=new WorkflowEngine(db,{dataDir,adapters:[adapter()],workerId:'worker-a',leaseMs:20});const project=db.project({name:'claim-crash-recovery',kind:'software',authorizationConfirmed:true});const task=await first.create(project.id,{adapter:'file'});expect(first.claimNext()).toBe(task.id);await new Promise(resolve=>setTimeout(resolve,30));const second=new WorkflowEngine(db,{dataDir,adapters:[adapter()],workerId:'worker-b',leaseMs:5000});second.recover();expect(second.claimNext()).toBe(task.id);await second.execute(task.id,true);
    expect(db.getTask(task.id)?.status).toBe('COMPLETED');expect(db.raw.prepare('SELECT lease_owner FROM tasks WHERE id=?').get(task.id)).toEqual({lease_owner:null});db.close();
  });
  it.each([{rss:100,failed:false},{rss:101,failed:true}])('treats maxMemoryMB as MiB at the $rss MiB boundary',async({rss,failed})=>{
    expect(1048576).toBe(1024*1024);const {dataDir,db}=await setup();let enteredResolve!:()=>void;const entered=new Promise<void>(resolve=>{enteredResolve=resolve;});let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});let samples=0,stageEntered=false;const fake={sampleOrThrow:async()=>{samples++;return {treeRssMB:stageEntered?rss:100,childRssMB:0,cpuPercent:0,heapUsedMB:1,pressure:'normal'};},circuit:()=>{}} as unknown as import('@reverse/workflow').ResourceMonitor;
    const engine=new WorkflowEngine(db,{dataDir,adapters:[adapter({prepare:async()=>{stageEntered=true;enteredResolve();await gate;return {prepared:true};}})],resources:fake});const project=db.project({name:'memory-boundary',kind:'software',authorizationConfirmed:true});const task=await engine.create(project.id,{adapter:'file',options:{maxMemoryMB:100}});const running=engine.execute(task.id);await entered;await waitUntil(()=>samples>0,5000);release();await running;
    expect(db.getTask(task.id)?.status).toBe(failed?'FAILED':'COMPLETED');if(failed)expect(db.getTask(task.id)?.error).toContain('memory budget');db.close();
  });
  it('does not reject publication when post-commit orphan GC fails',async()=>{
    const {dataDir,db}=await setup();const engine=new WorkflowEngine(db,{dataDir,adapters:[adapter({prepare:async ctx=>{let rejected=false;try{await ctx.writeArtifact('committed.txt','committed','text/plain');}catch{rejected=true;}expect(rejected).toBe(false);return {prepared:true};}})]});const original=(engine as unknown as {pruneOrphanObjects:(...args:string[])=>Promise<void>}).pruneOrphanObjects.bind(engine);let calls=0;(engine as unknown as {pruneOrphanObjects:(...args:string[])=>Promise<void>}).pruneOrphanObjects=async(...args)=>{calls++;if(calls>1)throw new Error('injected post-commit GC failure');return original(...args);};const project=db.project({name:'post-commit-gc',kind:'software',authorizationConfirmed:true});const task=await engine.create(project.id,{adapter:'file'});await engine.execute(task.id);
    expect(db.getTask(task.id)?.status).toBe('COMPLETED');expect(db.artifacts(task.id).map(item=>item.name)).toContain('committed.txt');expect(db.logs(task.id).some(item=>item.level==='warn'&&item.message.includes('post-commit GC failure'))).toBe(true);db.close();
  });
  it('keeps the database uncommitted when a failed publication hook deletes objects',async()=>{
    const {dataDir,db}=await setup();let taskId='';const original=db.addArtifact.bind(db);let fail=true;db.addArtifact=((...args:Parameters<typeof db.addArtifact>)=>{if(fail){fail=false;throw new Error('injected publication failure');}return original(...args);}) as typeof db.addArtifact;const engine=new WorkflowEngine(db,{dataDir,adapters:[adapter({prepare:async ctx=>{await expect(ctx.writeArtifact('rolled-back.txt','rolled back','text/plain')).rejects.toThrow('injected publication failure');expect(db.artifacts(taskId)).toEqual([]);await rm(objectDir(dataDir,taskId),{recursive:true,force:true});await mkdir(objectDir(dataDir,taskId),{recursive:true});return {prepared:true};}})]});const project=db.project({name:'failed-publication-hook',kind:'software',authorizationConfirmed:true});const task=await engine.create(project.id,{adapter:'file'});taskId=task.id;await engine.execute(task.id);
    expect(db.getTask(task.id)?.status).toBe('COMPLETED');expect(db.artifacts(taskId).some(item=>item.name==='rolled-back.txt')).toBe(false);db.close();
  });
  it('does not yield the artifact write transaction to reentrant database work',async()=>{
    const {dataDir,db}=await setup();const content='transaction-safe';const digest=createHash('sha256').update(content).digest('hex');const project=db.project({name:'artifact-transaction-reentry',kind:'software',authorizationConfirmed:true});const task=db.createTask(project.id,'file',{adapter:'file'},'fixture');let reentered=false;artifactPathGate.file=path.join(objectDir(dataDir,task.id),digest);artifactPathGate.onRegular=async()=>{reentered=true;try{db.raw.exec('BEGIN IMMEDIATE');db.raw.exec('ROLLBACK');}catch{/* model ResourceMonitor BEGIN/catch ROLLBACK */}};
    const engine=new WorkflowEngine(db,{dataDir,adapters:[adapter({prepare:async ctx=>{await ctx.writeArtifact('safe.txt',content,'text/plain');return {prepared:true};}})]});await engine.execute(task.id);
    expect(reentered).toBe(false);expect(db.getTask(task.id)?.status).toBe('COMPLETED');expect(db.artifacts(task.id).map(item=>item.name)).toContain('safe.txt');db.close();
  });
  it.each(['pause','cancel'] as const)('rolls back a publication when %s is requested in the addArtifact hook',async action=>{
    const {dataDir,db}=await setup();const project=db.project({name:`artifact-${action}-after-verify`,kind:'software',authorizationConfirmed:true});const task=db.createTask(project.id,'file',{adapter:'file'},'fixture');const original=db.addArtifact.bind(db);db.addArtifact=((...args:Parameters<typeof db.addArtifact>)=>{if(action==='pause')engine.pause(task.id);else engine.cancel(task.id);return original(...args);}) as typeof db.addArtifact;const engine=new WorkflowEngine(db,{dataDir,adapters:[adapter({prepare:async ctx=>{await ctx.writeArtifact('blocked.txt','blocked','text/plain');return {prepared:true};}})]});await engine.execute(task.id);
    expect(db.artifacts(task.id)).toEqual([]);expect(await readdir(objectDir(dataDir,task.id))).toEqual([]);expect(db.getTask(task.id)?.status).toBe(action==='cancel'?'CANCELLED':'PAUSED');db.close();
  });
  it('revalidates digest after addArtifact and before commit',async()=>{
    const {dataDir,db}=await setup();const content='verified';const original=db.addArtifact.bind(db);db.addArtifact=((...args:Parameters<typeof db.addArtifact>)=>{writeFileSync(args[2],'B'.repeat(args[3]));const changed=new Date(Date.now()+5000);utimesSync(args[2],changed,changed);return original(...args);}) as typeof db.addArtifact;const engine=new WorkflowEngine(db,{dataDir,adapters:[adapter({prepare:async ctx=>{await ctx.writeArtifact('verified.txt',content,'text/plain');return {prepared:true};}})]});const project=db.project({name:'artifact-add-race',kind:'software',authorizationConfirmed:true});const task=await engine.create(project.id,{adapter:'file'});await engine.execute(task.id);
    expect(db.getTask(task.id)?.status).toBe('FAILED');expect(db.getTask(task.id)?.error).toContain('integrity');expect(db.artifacts(task.id).some(item=>item.name==='verified.txt')).toBe(false);db.close();
  });
  it('does not reject committed publication when the GC warning cannot be logged',async()=>{
    const {dataDir,db}=await setup();const engine=new WorkflowEngine(db,{dataDir,adapters:[]});const originalPrune=(engine as unknown as {pruneOrphanObjects:(...args:string[])=>Promise<void>}).pruneOrphanObjects.bind(engine);let pruneCalls=0;(engine as unknown as {pruneOrphanObjects:(...args:string[])=>Promise<void>}).pruneOrphanObjects=async(...args)=>{pruneCalls++;if(pruneCalls>1)throw new Error('injected GC failure');return originalPrune(...args);};const originalLog=db.log.bind(db);let failLog=false;db.log=((...args:Parameters<typeof db.log>)=>{if(failLog)throw new Error('injected log failure');return originalLog(...args);}) as typeof db.log;(engine as unknown as {opts:{adapters:AdapterDefinition[]}}).opts.adapters=[adapter({prepare:async ctx=>{let rejected=false;failLog=true;try{await ctx.writeArtifact('committed.txt','committed','text/plain');}catch{rejected=true;}finally{failLog=false;}expect(rejected).toBe(false);return {prepared:true};}})];const project=db.project({name:'gc-log-failure',kind:'software',authorizationConfirmed:true});const task=await engine.create(project.id,{adapter:'file'});
    await engine.execute(task.id);expect(db.getTask(task.id)?.status).toBe('COMPLETED');expect(db.artifacts(task.id).map(item=>item.name)).toContain('committed.txt');db.close();
  });
  it('stops before stage writes when the lease is lost during artifact setup',async()=>{
    const {dataDir,db}=await setup();let firstCalls=0;let secondCalls=0;let secondEntered!:()=>void;const entered=new Promise<void>(resolve=>{secondEntered=resolve;});let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});let takeover!:Promise<void>;const first=new WorkflowEngine(db,{dataDir,adapters:[adapter({prepare:async()=>{firstCalls++;return {prepared:true};}})],workerId:'worker-a',leaseMs:5000});const second=new WorkflowEngine(db,{dataDir,adapters:[adapter({prepare:async()=>{secondCalls++;secondEntered();await gate;return {prepared:true};}})],workerId:'worker-b',leaseMs:5000});const project=db.project({name:'leading-lease-loss',kind:'software',authorizationConfirmed:true});const task=await first.create(project.id,{adapter:'file'});artifactMkdirGate.dir=objectDir(dataDir,task.id);artifactMkdirGate.onMkdir=async()=>{db.raw.prepare("UPDATE tasks SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(task.id);takeover=second.execute(task.id);await entered;};const firstRun=first.execute(task.id);await firstRun;
    expect(firstCalls).toBe(0);expect(secondCalls).toBe(1);release();await takeover;expect(db.getTask(task.id)?.status).toBe('COMPLETED');db.close();
  });
  it('does not expose a recovered task before its checkpoint is reset',async()=>{
    const {dataDir,db}=await setup();const first=new WorkflowEngine(db,{dataDir,adapters:[adapter()],workerId:'worker-a'});const second=new WorkflowEngine(db,{dataDir,adapters:[adapter()],workerId:'worker-b'});const project=db.project({name:'recover-fencing',kind:'software',authorizationConfirmed:true});const task=await first.create(project.id,{adapter:'file'});db.updateTask(task.id,{status:'RUNNING',lease_owner:'worker-a:old',lease_expires_at:'2000-01-01T00:00:00.000Z'});let claimed:string|undefined;let blocked=false;const original=db.setStage.bind(db);db.setStage=((...args:Parameters<typeof db.setStage>)=>{if(!blocked&&claimed===undefined&&args[1]===task.currentStage&&args[2].status==='PENDING'){try{claimed=second.claimNext();}catch{blocked=true;}}return original(...args);}) as typeof db.setStage;first.recover();
    expect(blocked).toBe(true);expect(claimed).toBeUndefined();expect(db.getTask(task.id)?.status).toBe('QUEUED');expect(db.stages(task.id).find(item=>item.name===task.currentStage)?.status).toBe('PENDING');db.close();
  });
  it.each(['pause','cancel'] as const)('preserves %s requests when recovering an expired lease',async action=>{
    const {dataDir,db}=await setup();const engine=new WorkflowEngine(db,{dataDir,adapters:[adapter()]});const project=db.project({name:`recover-${action}`,kind:'software',authorizationConfirmed:true});const task=await engine.create(project.id,{adapter:'file'});db.updateTask(task.id,{status:'RUNNING',lease_owner:'worker:old',lease_expires_at:'2000-01-01T00:00:00.000Z',...(action==='pause'?{pause_requested:1}:{cancel_requested:1})});engine.recover();
    expect(db.getTask(task.id)?.status).toBe(action==='pause'?'PAUSED':'CANCELLED');expect(db.getTask(task.id)?.pauseRequested).toBe(action==='pause');expect(db.getTask(task.id)?.cancelRequested).toBe(action==='cancel');db.close();
  });
  it('does not expose a retried task before its stage is reset',async()=>{
    const {dataDir,db}=await setup();const first=new WorkflowEngine(db,{dataDir,adapters:[adapter()],workerId:'worker-a'});const second=new WorkflowEngine(db,{dataDir,adapters:[adapter()],workerId:'worker-b'});const project=db.project({name:'retry-fencing',kind:'software',authorizationConfirmed:true});const task=await first.create(project.id,{adapter:'file'});db.updateTask(task.id,{status:'FAILED'});let claimed:string|undefined;let blocked=false;const original=db.setStage.bind(db);db.setStage=((...args:Parameters<typeof db.setStage>)=>{if(!blocked&&claimed===undefined){try{claimed=second.claimNext();}catch{blocked=true;}}return original(...args);}) as typeof db.setStage;expect(first.retry(task.id)).toBe(true);
    expect(blocked).toBe(true);expect(claimed).toBeUndefined();expect(db.getTask(task.id)?.status).toBe('QUEUED');expect(db.stages(task.id).find(item=>item.name===task.currentStage)?.status).toBe('PENDING');db.close();
  });
  it('does not let a replacement claim survive an owned stage failure',async()=>{
    const {dataDir,db}=await setup();const second=new WorkflowEngine(db,{dataDir,adapters:[adapter()],workerId:'worker-b',leaseMs:5000});let replacementToken:string|undefined;let blocked=false;const originalLog=db.log.bind(db);db.log=((...args:Parameters<typeof db.log>)=>{if(args[1]==='error'&&args[2].includes('Stage PREPARE failed')){db.raw.prepare("UPDATE tasks SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(args[0]);try{replacementToken=(second as unknown as {claimExecution(id:string,claimed:boolean):string|undefined}).claimExecution(args[0],false);}catch{blocked=true;}}return originalLog(...args);}) as typeof db.log;const engine=new WorkflowEngine(db,{dataDir,adapters:[adapter({prepare:async()=>{throw new Error('injected stage failure');}})],workerId:'worker-a',leaseMs:5000});const project=db.project({name:'catch-fencing',kind:'software',authorizationConfirmed:true});const task=await engine.create(project.id,{adapter:'file'});await engine.execute(task.id);
    expect(blocked).toBe(true);expect(replacementToken).toBeUndefined();expect(db.getTask(task.id)?.status).toBe('FAILED');expect(db.raw.prepare('SELECT lease_owner FROM tasks WHERE id=?').get(task.id)).toEqual({lease_owner:null});db.close();
  });
  it('preserves referenced immutable objects through path aliases during prune',async()=>{
    const {dataDir,db}=await setup();const content='aliased';const digest=createHash('sha256').update(content).digest('hex');const project=db.project({name:'prune-alias',kind:'software',authorizationConfirmed:true});const task=db.createTask(project.id,'file',{adapter:'file'},'fixture');const objects=objectDir(dataDir,task.id);await mkdir(objects,{recursive:true});const file=path.join(objects,digest);await writeFile(file,content);let alias=file;if(process.platform==='win32')alias=file.replace(/^[A-Za-z]:/,letter=>letter.toLowerCase());else{alias=path.join(path.dirname(objects),'alias-object');await symlink(file,alias);}db.addArtifact(task.id,'aliased.txt',alias,content.length,digest,'text/plain');const engine=new WorkflowEngine(db,{dataDir,adapters:[adapter()]});await engine.execute(task.id);
    await expect(readFile(file,'utf8')).resolves.toBe(content);expect(db.getTask(task.id)?.status).toBe('COMPLETED');db.close();
  });
  it('reads the pinned inode when a concurrent replacement prunes the old path',async()=>{
    const {dataDir,db}=await setup();const engine=new WorkflowEngine(db,{dataDir,adapters:[adapter({prepare:async ctx=>{await ctx.writeArtifact('pinned.txt','old-content','text/plain');const file=db.artifactPath(task.id,'pinned.txt')!;artifactOpenGate.file=file;artifactOpenGate.onOpen=async()=>{await ctx.writeArtifact('pinned.txt','new-content','text/plain');};const bytes=await ctx.readArtifact('pinned.txt');expect(Buffer.from(bytes).toString()).toBe('old-content');return {prepared:true};}})]});const project=db.project({name:'read-pin-prune',kind:'software',authorizationConfirmed:true});const task=await engine.create(project.id,{adapter:'file'});await engine.execute(task.id);
    expect(db.getTask(task.id)?.status,db.getTask(task.id)?.error).toBe('COMPLETED');expect(await readFile(db.artifactPath(task.id,'pinned.txt')!,'utf8')).toBe('new-content');db.close();
  });
  it('heartbeats short leases before another worker can recover them',async()=>{
    const {dataDir,db}=await setup();let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});const first=new WorkflowEngine(db,{dataDir,adapters:[adapter({prepare:async()=>{await gate;return {prepared:true};}})],workerId:'worker-a',leaseMs:50});const second=new WorkflowEngine(db,{dataDir,adapters:[adapter()],workerId:'worker-b',leaseMs:5000});const project=db.project({name:'short-lease-heartbeat',kind:'software',authorizationConfirmed:true});const task=await first.create(project.id,{adapter:'file'});const running=first.execute(task.id);await waitUntil(()=>db.getTask(task.id)?.currentStage==='PREPARE');await new Promise(resolve=>setTimeout(resolve,60));second.recover();expect(second.claimNext()).toBeUndefined();expect(db.getTask(task.id)?.status).toBe('RUNNING');release();await running;    expect(db.getTask(task.id)?.status).toBe('COMPLETED');db.close();
  });
  it.each(['pause','cancel'] as const)('does not strand a heavy task when %s arrives during pressure deferral',async action=>{
    const {dataDir,db}=await setup();const fake={sampleOrThrow:async()=>({treeRssMB:100,childRssMB:0,cpuPercent:0,heapUsedMB:1,pressure:'pressure'}),circuit:()=>{}} as unknown as import('@reverse/workflow').ResourceMonitor;const engine=new WorkflowEngine(db,{dataDir,adapters:[adapter({name:'website'})],resources:fake,workerId:'worker-a',leaseMs:5000});const project=db.project({name:`deferral-${action}`,kind:'software',authorizationConfirmed:true});const task=await engine.create(project.id,{adapter:'website'});const originalGet=db.getTask.bind(db);let injected=false;db.getTask=((id:string)=>{const current=originalGet(id);if(!injected&&id===task.id&&current?.status==='RUNNING'){injected=true;if(action==='pause')engine.pause(task.id);else engine.cancel(task.id);}return current;}) as typeof db.getTask;await (engine as unknown as {tick:()=>Promise<void>}).tick();
    expect(injected).toBe(true);expect(db.getTask(task.id)?.status).toBe(action==='pause'?'PAUSED':'CANCELLED');expect(db.getTask(task.id)?.pauseRequested).toBe(action==='pause');expect(db.getTask(task.id)?.cancelRequested).toBe(action==='cancel');expect(db.raw.prepare('SELECT lease_owner FROM tasks WHERE id=?').get(task.id)).toEqual({lease_owner:null});db.close();
  });
});

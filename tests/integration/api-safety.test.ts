import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../../apps/api/src/server.js';

const token='api-safety-token';const auth={authorization:`Bearer ${token}`};
const dirs:string[]=[];const cleanups:(()=>Promise<void>)[]=[];
afterEach(async()=>{vi.restoreAllMocks();for(const cleanup of cleanups.splice(0).reverse())await cleanup();for(const dir of dirs.splice(0))await rm(dir,{recursive:true,force:true});});
async function setup(){const dataDir=await mkdtemp(path.join(os.tmpdir(),'re-api-safety-'));dirs.push(dataDir);const built=await buildServer({dataDir,token,backgroundResources:false});cleanups.push(async()=>{await built.app.close();built.db.close();});return {...built,dataDir};}
async function withEnv<T>(values:Record<string,string>,operation:()=>Promise<T>){const previous=Object.fromEntries(Object.keys(values).map(name=>[name,process.env[name]]));Object.assign(process.env,values);try{return await operation();}finally{for(const [name,value] of Object.entries(previous)){if(value===undefined)delete process.env[name];else process.env[name]=value;}}}
function within(parent:string,child:string){const relative=path.relative(parent,child);return relative!=='..'&&!relative.startsWith(`..${path.sep}`)&&!path.isAbsolute(relative);}

describe('API safety and recovery boundaries',()=>{
  it('keeps public health minimal and protects resource details',async()=>{
    const {app}=await setup();const health=await app.inject({method:'GET',url:'/api/health'});expect(health.statusCode).toBe(200);expect(health.json()).toEqual({ok:true,product:'reverse-everything',version:'0.0.3',schemaVersion:3});
    expect((await app.inject({method:'GET',url:'/api/resources'})).statusCode).toBe(401);
    expect((await app.inject({method:'GET',url:'/api/resources',headers:auth})).statusCode).toBe(200);
  });
  it('rejects absolute-form and network-path request targets before API routing',async()=>{
    const {app}=await setup();const address=await app.listen({host:'127.0.0.1',port:0});const port=new URL(address).port;
    const raw=(target:string)=>new Promise<string>((resolve,reject)=>{const socket=createConnection({host:'127.0.0.1',port:Number(port)});let data='';socket.setTimeout(5000,()=>{socket.destroy();reject(new Error('Raw request timeout'));});socket.on('connect',()=>socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`));socket.on('data',chunk=>data+=chunk.toString());socket.on('error',reject);socket.on('end',()=>resolve(data));});
    expect(await raw(`http://127.0.0.1:${port}/api/projects`)).toMatch(/^HTTP\/1\.1 400/);
    expect(await raw('//evil.example/api/projects')).toMatch(/^HTTP\/1\.1 400/);
    for(const target of ['/%61pi/settings','/api%2fsettings','/%2561pi/settings','/foo/%2e%2e/api/settings'])expect(await raw(target),target).toMatch(/^HTTP\/1\.1 401/);
    expect(await raw('/api/%zz/settings')).toMatch(/^HTTP\/1\.1 400/);
    expect((await app.inject({method:'GET',url:'/api/projects',headers:auth})).statusCode).toBe(200);
  });
  it('requires HTTPS for remote AI and rejects URL credentials',async()=>{
    const {app}=await setup();const put=(body:unknown)=>app.inject({method:'PUT',url:'/api/settings',headers:{...auth,'content-type':'application/json'},body:JSON.stringify(body)});
    expect((await put({baseUrl:'http://model.example/v1',allowRemoteData:true})).statusCode).toBe(400);
    expect((await put({baseUrl:'https://user:pass@model.example/v1',allowRemoteData:true})).statusCode).toBe(400);
    expect((await put({baseUrl:'http://127.0.0.1:11434/v1'})).statusCode).toBe(200);
    expect((await put({baseUrl:'https://model.example/v1',allowRemoteData:true})).statusCode).toBe(200);
  });
  it('revalidates remote consent and HTTPS when testing stored AI settings',async()=>{
    const {app,db}=await setup();const fetchSpy=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('fetch must not be called'));const test=()=>app.inject({method:'POST',url:'/api/settings/test',headers:auth});
    db.setSetting('ai_base_url','https://model.example/v1');db.setSetting('ai_allow_remote','true');const put=(body:unknown)=>app.inject({method:'PUT',url:'/api/settings',headers:{...auth,'content-type':'application/json'},body:JSON.stringify(body)});expect((await put({allowRemoteData:false})).statusCode).toBe(200);const revoked=await test();expect(revoked.statusCode).toBe(200);expect(revoked.json()).toMatchObject({ok:false,error:expect.stringMatching(/explicitly enabled/i)});expect(fetchSpy).not.toHaveBeenCalled();
    db.setSetting('ai_allow_remote','true');db.setSetting('ai_base_url','http://model.example/v1');const insecure=await test();expect(insecure.statusCode).toBe(200);expect(insecure.json()).toMatchObject({ok:false,error:expect.stringMatching(/HTTPS/i)});expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockResolvedValue(new Response('{}',{status:200}));for(const base of ['http://127.0.0.2:11434/v1','http://localhost:11434/v1','http://[::1]:11434/v1']){db.setSetting('ai_base_url',base);db.setSetting('ai_allow_remote','false');const local=await test();expect(local.json()).toMatchObject({ok:true,status:200});}expect(fetchSpy).toHaveBeenCalledTimes(3);
  });
  it('refuses AI test redirects without contacting the redirect target',async()=>{
    const {app,db}=await setup();let targetHits=0;let firstHits=0;const servers:ReturnType<typeof createServer>[]=[];
    const listen=(server:ReturnType<typeof createServer>)=>new Promise<string>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const address=server.address();if(!address||typeof address==='string')return reject(new Error('Missing test server address'));resolve(`http://127.0.0.1:${address.port}`);});});
    const close=(server:ReturnType<typeof createServer>)=>new Promise<void>((resolve,reject)=>{server.close(error=>error?reject(error):resolve());server.closeAllConnections();});
    try{
      const target=createServer((_req,res)=>{targetHits++;res.end('must not be requested');});servers.push(target);const targetBase=await listen(target);
      const first=createServer((_req,res)=>{firstHits++;res.writeHead(302,{location:`${targetBase}/collect`});res.end();});servers.push(first);const firstBase=await listen(first);db.setSetting('ai_base_url',`${firstBase}/v1`);
      const response=await app.inject({method:'POST',url:'/api/settings/test',headers:auth});expect(response.statusCode).toBe(200);expect(response.json().ok).toBe(false);expect(firstHits).toBe(1);expect(targetHits).toBe(0);
    }finally{for(const server of servers.reverse())await close(server);}
  });
  it('accepts protocol projects and derives task adapters from the registry',async()=>{
    const {app}=await setup();const project=await app.inject({method:'POST',url:'/api/projects',headers:{...auth,'content-type':'application/json'},body:JSON.stringify({name:'protocol',kind:'protocol',authorizationConfirmed:true})});expect(project.statusCode).toBe(201);
    const task=await app.inject({method:'POST',url:`/api/projects/${project.json().id}/tasks`,headers:{...auth,'content-type':'application/json'},body:JSON.stringify({adapter:'network'})});expect([201,409]).toContain(task.statusCode);if(task.statusCode===409)expect(task.json().error.code).toBe('ADAPTER_UNAVAILABLE');
    const capabilities=await app.inject({method:'GET',url:'/api/capabilities',headers:auth});expect(capabilities.json().adapters.map((adapter:{name:string})=>adapter.name)).toEqual(expect.arrayContaining(['network','apk','ghidra']));
  });
  it('deletes every task directory when a project has more than 200 tasks',async()=>{
    const {app,db,dataDir}=await setup();const project=db.project({name:'many tasks',kind:'software',authorizationConfirmed:true});const taskIds:string[]=[];
    for(let index=0;index<201;index++){const task=db.createTask(project.id,'file',{adapter:'file'},`hash-${index}`);db.updateTask(task.id,{status:'COMPLETED',current_stage:'COMPLETED'});taskIds.push(task.id);const dir=path.join(dataDir,'tasks',task.id,'artifacts');await mkdir(dir,{recursive:true});await writeFile(path.join(dir,'marker.txt'),String(index));}
    db.updateTask(taskIds[0]!,{status:'RUNNING'});const blocked=await app.inject({method:'DELETE',url:`/api/projects/${project.id}`,headers:{...auth,'content-type':'application/json'},body:JSON.stringify({confirm:project.name})});expect(blocked.statusCode).toBe(409);db.updateTask(taskIds[0]!,{status:'COMPLETED'});
    const response=await app.inject({method:'DELETE',url:`/api/projects/${project.id}`,headers:{...auth,'content-type':'application/json'},body:JSON.stringify({confirm:project.name})});expect(response.statusCode).toBe(200);expect(db.getProject(project.id)).toBeUndefined();for(const id of taskIds)expect(existsSync(path.join(dataDir,'tasks',id))).toBe(false);
  });
  it('keeps SSE delivery live when other tasks flood the global event log',async()=>{
    const {app,db}=await setup();const project=db.project({name:'events',kind:'software',authorizationConfirmed:true});const target=db.createTask(project.id,'file',{adapter:'file'},'target');const other=db.createTask(project.id,'file',{adapter:'file'},'other');
    for(let index=0;index<250;index++)db.addEvent(other.id,'other.event',{index});db.addEvent(target.id,'target.event',{found:true});
    const address=await app.listen({host:'127.0.0.1',port:0});const response=await fetch(`${address}/api/tasks/${target.id}/events`,{headers:{...auth,'last-event-id':'0'},signal:AbortSignal.timeout(5000)});expect(response.status).toBe(200);const reader=response.body!.getReader();let stream='';
    try{while(!stream.includes('event: target.event')){const chunk=await reader.read();if(chunk.done)break;stream+=new TextDecoder().decode(chunk.value);}}finally{await reader.cancel();}
    expect(stream).toContain('event: target.event');expect(stream).toContain('"found":true');
  });
  it('searches evidence with escaped LIKE input filters and pagination totals',async()=>{
    const {app,db}=await setup();const project=db.project({name:'search project',kind:'software',authorizationConfirmed:true});const task=db.createTask(project.id,'file',{adapter:'file'},'search-task');const otherProject=db.project({name:'other project',kind:'software',authorizationConfirmed:true});const otherTask=db.createTask(otherProject.id,'security',{adapter:'security'},'other-task');
    const add=(taskId:string,kind:'EVIDENCE'|'INFERENCE',title:string,content:unknown)=>db.addEvidence({taskId,kind,title,source:'fixture',locator:'locator',content,sha256:'hash'});
    add(task.id,'EVIDENCE','100%_literal',{value:'first'});add(task.id,'INFERENCE','second inference',{value:'second'});add(otherTask.id,'EVIDENCE','other project',{value:'third'});
    expect((await app.inject({method:'GET',url:'/api/evidence/search'})).statusCode).toBe(401);expect((await app.inject({method:'GET',url:'/api/evidence/search',headers:auth})).statusCode).toBe(400);expect((await app.inject({method:'GET',url:`/api/evidence/search?q=${'x'.repeat(201)}`,headers:auth})).statusCode).toBe(400);
    const search=(params:Record<string,string>)=>app.inject({method:'GET',url:`/api/evidence/search?${new URLSearchParams(params)}`,headers:auth});
    const escaped=await search({q:'100%_'});expect(escaped.statusCode).toBe(200);expect(escaped.json().items.map((item:{title:string})=>item.title)).toEqual(['100%_literal']);expect(escaped.json().items[0]).toMatchObject({projectId:project.id,projectName:'search project',adapter:'file'});
    const percent=await search({q:'%'});expect(percent.json().total).toBe(1);const underscore=await search({q:'_'});expect(underscore.json().total).toBe(1);
    const filtered=await search({q:'no-such-evidence',kind:'INFERENCE',projectId:project.id,taskId:task.id});expect(filtered.json().total).toBe(0);
    const inference=await search({q:'inference',kind:'INFERENCE',projectId:project.id,taskId:task.id});expect(inference.json().total).toBe(1);
    const page=await search({q:'e',projectId:project.id,limit:'1',offset:'1'});expect(page.json()).toMatchObject({total:2,limit:1,offset:1});expect(page.json().items).toHaveLength(1);
  });
  it('enforces backup count and byte quotas without changing source records',async()=>{
    await withEnv({RE_MAX_BACKUPS:'1'},async()=>{const {app,db,backups}=await setup();const project=db.project({name:'count quota',kind:'software',authorizationConfirmed:true});const create=()=>app.inject({method:'POST',url:'/api/backups',headers:{...auth,'content-type':'application/json'},body:JSON.stringify({confirm:'CREATE_BACKUP'})});const results=await Promise.all([create(),create()]);expect(results.map(result=>result.statusCode).sort()).toEqual([201,409]);expect(results.find(result=>result.statusCode===409)?.json().error.code).toBe('CONFLICT');expect(backups.list()).toHaveLength(1);expect(db.getProject(project.id)?.name).toBe('count quota');});
    await withEnv({RE_MAX_BACKUP_BYTES:'1'},async()=>{const {app,db,backups}=await setup();const project=db.project({name:'byte quota',kind:'software',authorizationConfirmed:true});const settingsBefore=db.settings();const blocked=await app.inject({method:'POST',url:'/api/backups',headers:{...auth,'content-type':'application/json'},body:JSON.stringify({confirm:'CREATE_BACKUP'})});expect(blocked.statusCode).toBe(409);expect(blocked.json().error.code).toBe('CONFLICT');expect(backups.list()).toEqual([]);expect(db.settings()).toEqual(settingsBefore);expect(db.getProject(project.id)?.name).toBe('byte quota');});
  });
  it('enforces isolated restore directory and byte quotas without changing source records',async()=>{
    await withEnv({RE_MAX_RESTORE_DIRS:'1'},async()=>{const {app,db,dataDir}=await setup();const project=db.project({name:'restore dir quota',kind:'software',authorizationConfirmed:true});const created=await app.inject({method:'POST',url:'/api/backups',headers:{...auth,'content-type':'application/json'},body:JSON.stringify({confirm:'CREATE_BACKUP'})});const id=created.json().id as string;const preview=await app.inject({method:'POST',url:`/api/backups/${id}/preview`,headers:{...auth,'content-type':'application/json'},body:'{}'});expect(preview.statusCode).toBe(200);const restored=await app.inject({method:'POST',url:`/api/backups/${id}/restore`,headers:{...auth,'content-type':'application/json'},body:JSON.stringify({confirm:'RESTORE_BACKUP'})});expect(restored.statusCode).toBe(200);const blocked=await app.inject({method:'POST',url:`/api/backups/${id}/restore`,headers:{...auth,'content-type':'application/json'},body:JSON.stringify({confirm:'RESTORE_BACKUP'})});expect(blocked.statusCode).toBe(409);expect(blocked.json().error.code).toBe('CONFLICT');expect(existsSync(path.join(dataDir,'restores'))).toBe(true);expect(db.getProject(project.id)?.name).toBe('restore dir quota');});
    await withEnv({RE_MAX_RESTORE_BYTES:'1'},async()=>{const {app,db,dataDir}=await setup();const project=db.project({name:'restore byte quota',kind:'software',authorizationConfirmed:true});const created=await app.inject({method:'POST',url:'/api/backups',headers:{...auth,'content-type':'application/json'},body:JSON.stringify({confirm:'CREATE_BACKUP'})});const id=created.json().id as string;const blocked=await app.inject({method:'POST',url:`/api/backups/${id}/preview`,headers:{...auth,'content-type':'application/json'},body:'{}'});expect(blocked.statusCode).toBe(409);expect(blocked.json().error.code).toBe('CONFLICT');expect(existsSync(path.join(dataDir,'restores'))).toBe(false);expect(db.getProject(project.id)?.name).toBe('restore byte quota');});
  });
  it('creates verifies previews and restores backups only into isolated server directories',async()=>{
    const {app,db,dataDir}=await setup();const project=db.project({name:'backup source',kind:'software',authorizationConfirmed:true});const task=db.createTask(project.id,'file',{adapter:'file'},'backup-task-hash');
    expect((await app.inject({method:'GET',url:'/api/backups'})).statusCode).toBe(401);
    expect((await app.inject({method:'GET',url:'/api/backups/not-a-uuid/verify',headers:auth})).statusCode).toBe(400);
    expect((await app.inject({method:'POST',url:'/api/backups',headers:{...auth,'content-type':'application/json'},body:'{}'})).statusCode).toBe(400);
    const created=await app.inject({method:'POST',url:'/api/backups',headers:{...auth,'content-type':'application/json'},body:JSON.stringify({confirm:'CREATE_BACKUP'})});expect(created.statusCode).toBe(201);const backup=created.json();
    const list=await app.inject({method:'GET',url:'/api/backups',headers:auth});expect(list.json().map((item:{id:string})=>item.id)).toContain(backup.id);
    const verified=await app.inject({method:'GET',url:`/api/backups/${backup.id}/verify`,headers:auth});expect(verified.statusCode).toBe(200);expect(verified.json().valid).toBe(true);
    const events=await app.inject({method:'GET',url:`/api/backups/${backup.id}/events`,headers:auth});expect(events.statusCode).toBe(200);expect(events.json().map((event:{action:string})=>event.action)).toContain('backup.created');
    expect((await app.inject({method:'POST',url:`/api/backups/${backup.id}/preview`,headers:{...auth,'content-type':'application/json'},body:JSON.stringify({targetDir:path.join(dataDir,'unsafe')})})).statusCode).toBe(400);
    const preview=await app.inject({method:'POST',url:`/api/backups/${backup.id}/preview`,headers:{...auth,'content-type':'application/json'},body:'{}'});expect(preview.statusCode).toBe(200);expect(within(path.join(dataDir,'restores'),preview.json().targetDir)).toBe(true);
    expect((await app.inject({method:'POST',url:`/api/backups/${backup.id}/restore`,headers:{...auth,'content-type':'application/json'},body:'{}'})).statusCode).toBe(400);
    expect((await app.inject({method:'POST',url:`/api/backups/${backup.id}/restore`,headers:{...auth,'content-type':'application/json'},body:JSON.stringify({confirm:'RESTORE_BACKUP',targetDir:path.join(dataDir,'unsafe')})})).statusCode).toBe(400);
    const restored=await app.inject({method:'POST',url:`/api/backups/${backup.id}/restore`,headers:{...auth,'content-type':'application/json'},body:JSON.stringify({confirm:'RESTORE_BACKUP'})});expect(restored.statusCode).toBe(200);expect(within(path.join(dataDir,'restores'),restored.json().targetDir)).toBe(true);
    expect(db.getProject(project.id)?.name).toBe('backup source');expect(db.getTask(task.id)?.inputHash).toBe('backup-task-hash');
    const targetFile=restored.json().files[0].path as string;const target=new DatabaseSync(targetFile,{readOnly:true});try{expect(target.prepare('SELECT name FROM projects WHERE id=?').get(project.id)).toEqual({name:'backup source'});expect(target.prepare('SELECT input_hash FROM tasks WHERE id=?').get(task.id)).toEqual({input_hash:'backup-task-hash'});}finally{target.close();}
    await writeFile(backup.path as string,'corrupt');const corrupt=await app.inject({method:'POST',url:`/api/backups/${backup.id}/preview`,headers:{...auth,'content-type':'application/json'},body:'{}'});expect(corrupt.statusCode).toBe(409);
    expect((await app.inject({method:'GET',url:`/api/backups/${randomUUID()}/verify`,headers:auth})).statusCode).toBe(404);
  });
});

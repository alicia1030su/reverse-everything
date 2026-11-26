import http from 'node:http';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { callAgent, type AiRuntimeConfig } from '../../packages/workflow/src/agent.js';
import { Database } from '../../packages/workflow/src/database.js';

vi.mock('node:dns/promises',async(importOriginal)=>{
  const actual=await importOriginal<typeof import('node:dns/promises')>();
  return {...actual,lookup:vi.fn(actual.lookup)};
});
const actualDns=await vi.importActual<typeof import('node:dns/promises')>('node:dns/promises');
function mockDns(address:string):void {
  (vi.mocked(lookup) as unknown as {mockResolvedValueOnce(value:LookupAddress[]):void}).mockResolvedValueOnce([{address,family:address.includes(':')?6:4}]);
}
const apiKey='secret-key';
const analysis='CONFIDENTIAL_AI_PROMPT';
const servers:http.Server[]=[];
const databases:Database[]=[];

afterEach(async()=>{
  vi.mocked(lookup).mockReset();
  vi.mocked(lookup).mockImplementation(actualDns.lookup);
  vi.restoreAllMocks();
  for(const db of databases.splice(0))if(db.raw.isOpen)db.close();
  for(const server of servers.splice(0)){
    server.closeAllConnections();
    await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
});

async function listen(server:http.Server):Promise<number>{
  servers.push(server);
  await new Promise<void>((resolve,reject)=>{
    server.once('error',reject);
    server.listen(0,'127.0.0.1',()=>{server.off('error',reject);resolve();});
  });
  const address=server.address();
  if(!address||typeof address==='string')throw new Error('Fake AI server did not bind a TCP port');
  return address.port;
}

function setup(){
  const db=new Database(':memory:');databases.push(db);
  const project=db.project({name:'agent-security',kind:'software',target:'target',authorizationConfirmed:true});
  const task=db.createTask(project.id,'file',{adapter:'file'},'agent-security-test');
  db.raw.prepare("INSERT INTO authorization_scopes (id,project_id,target,scope_json,allowed_interfaces_json,allowed_operations_json,data_access_json,remote_ai_allowed,expires_at,created_at,revoked_at) VALUES ('remote-auth',?,'target','[]','[\"file\"]','[\"network-access\"]','[]',1,NULL,?,NULL)").run(project.id,new Date().toISOString());
  return {db,taskId:task.id};
}

function input(db:Database,taskId:string,baseUrl:string,overrides:Partial<AiRuntimeConfig>={}){
  return {db,taskId,config:{enabled:true,baseUrl,model:'fixture',apiKey,allowRemoteData:false,...overrides},role:'planner' as const,iteration:1,system:'Return a bounded analysis plan',prompt:analysis,signal:new AbortController().signal};
}

function agentRun(db:Database,taskId:string){
  return db.raw.prepare('SELECT status,error,input_json,output_json FROM agent_runs WHERE task_id=?').get(taskId) as {status:string;error:string|null;input_json:string;output_json:string|null};
}

describe('callAgent security',()=>{
  it.each([302,307])('rejects HTTP %s redirects without connecting to a second server',async(status)=>{
    const {db,taskId}=setup();
    const secondRequests:{method:string|undefined;url:string|undefined;authorization:string|undefined;body:string}[]=[];
    const secondPort=await listen(http.createServer((req,res)=>{
      let body='';req.on('data',chunk=>body+=chunk.toString());req.on('end',()=>{
        secondRequests.push({method:req.method,url:req.url,authorization:req.headers.authorization,body});
        res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:'attacker response'}}]}));
      });
    }));
    const redirectTarget=`http://127.0.0.1:${secondPort}/evil`;
    const providerPort=await listen(http.createServer((_req,res)=>{
      res.writeHead(status,{location:redirectTarget});res.end();
    }));

    await expect(callAgent(input(db,taskId,`http://127.0.0.1:${providerPort}/v1`))).rejects.toMatchObject({code:'REDIRECT_BLOCKED'});

    expect(secondRequests).toEqual([]);
    const run=agentRun(db,taskId);
    expect(run.status).toBe('FAILED');
    expect(run.error).toBeTruthy();
    expect(run.error).not.toContain(apiKey);
    expect(run.error).not.toContain(analysis);
    expect(run.input_json).not.toContain(apiKey);
  });

  it('blocks localtest.me DNS rebinding to loopback before any HTTPS connection',async()=>{
    const {db,taskId}=setup();
    mockDns('127.0.0.1');
    const fetchSpy=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({choices:[{message:{content:'must not be used'}}]}),{status:200,headers:{'content-type':'application/json'}}));
    const requestSpy=vi.spyOn(https,'request');

    await expect(callAgent(input(db,taskId,'https://localtest.me:443/v1',{allowRemoteData:true}))).rejects.toMatchObject({code:'SSRF_BLOCKED'});

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(requestSpy).not.toHaveBeenCalled();
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith('localtest.me',{all:true,verbatim:true});
    const run=agentRun(db,taskId);
    expect(run.status).toBe('FAILED');
    expect(run.error).not.toContain(apiKey);
    expect(run.error).not.toContain(analysis);
  });

  it('pins an approved public DNS address for a normal remote HTTPS request',async()=>{
    const {db,taskId}=setup();
    mockDns('93.184.216.34');
    const fetchSpy=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({choices:[{message:{content:'wrong transport'}}]}),{status:200}));
    const response=new EventEmitter() as http.IncomingMessage;
    Object.assign(response,{statusCode:200,headers:{'content-type':'application/json'},destroy:vi.fn().mockReturnValue(response)});
    const request=new EventEmitter() as http.ClientRequest;
    request.setTimeout=vi.fn().mockReturnValue(request);
    request.destroy=vi.fn().mockReturnValue(request);
    const end=vi.fn((_body?:string|Uint8Array)=>{
      callback(response);
      queueMicrotask(()=>{response.emit('data',Buffer.from(JSON.stringify({choices:[{message:{content:'public provider result'}}]})));response.emit('end');});
      return request;
    });
    request.end=end as unknown as http.ClientRequest['end'];
    let callback:(response:http.IncomingMessage)=>void=()=>{};
    const requestSpy=vi.spyOn(https,'request').mockImplementation(((url:string|URL,options:https.RequestOptions,onResponse:(response:http.IncomingMessage)=>void)=>{
      callback=onResponse;
      return request;
    }) as typeof https.request);

    await expect(callAgent(input(db,taskId,'https://ai.example/v1',{allowRemoteData:true}))).resolves.toBe('public provider result');

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(requestSpy).toHaveBeenCalledTimes(1);
    const call=requestSpy.mock.calls[0] as unknown as [URL,https.RequestOptions,(response:http.IncomingMessage)=>void];
    expect(call[0].toString()).toBe('https://ai.example/v1/chat/completions');
    expect(call[1]).toMatchObject({method:'POST',headers:expect.objectContaining({authorization:`Bearer ${apiKey}`})});
    const sentBody=JSON.parse(String(end.mock.calls[0]?.[0])) as {messages:{role:string;content:string}[]};
    expect(sentBody.messages[1]?.content).toBe(analysis);
    let pinned:unknown;
    const lookupCallback=(call[1].lookup as Exclude<https.RequestOptions['lookup'],boolean|undefined>);
    lookupCallback('ai.example',{all:true},(_error,addresses)=>{pinned=addresses;});
    expect(pinned).toEqual([{address:'93.184.216.34',family:4}]);
    expect(agentRun(db,taskId)).toMatchObject({status:'SUCCEEDED',output_json:JSON.stringify({text:'public provider result'})});
  });

  it('sends a normal 200 response through the provider and records success',async()=>{
    const {db,taskId}=setup();
    let authorization:string|undefined;let requestBody='';let requestUrl:string|undefined;
    const providerPort=await listen(http.createServer((req,res)=>{
      requestUrl=req.url;
      if(req.url!=='/v1/chat/completions?api-version=test'){res.writeHead(404);res.end();return;}
      req.on('data',chunk=>requestBody+=chunk.toString());req.on('end',()=>{
        authorization=req.headers.authorization;
        res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:'provider result'}}]}));
      });
    }));

    await expect(callAgent(input(db,taskId,`http://127.0.0.1:${providerPort}/v1?api-version=test`))).resolves.toBe('provider result');

    expect(requestUrl).toBe('/v1/chat/completions?api-version=test');
    expect(authorization).toBe(`Bearer ${apiKey}`);
    expect(JSON.parse(requestBody)).toMatchObject({model:'fixture',messages:[{role:'system'},{role:'user',content:analysis}]});
    expect(agentRun(db,taskId)).toMatchObject({status:'SUCCEEDED',output_json:JSON.stringify({text:'provider result'})});
  });

  it('rejects an AI endpoint fragment before issuing a request',async()=>{
    const {db,taskId}=setup();let connections=0;
    const providerPort=await listen(http.createServer((_req,res)=>{connections++;res.end(JSON.stringify({choices:[{message:{content:'must not be used'}}]}));}));

    await expect(callAgent(input(db,taskId,`http://127.0.0.1:${providerPort}/v1#fragment`))).rejects.toThrow(/fragment/i);

    expect(connections).toBe(0);
    expect(db.raw.prepare('SELECT COUNT(*) AS count FROM agent_runs WHERE task_id=?').get(taskId)).toEqual({count:0});
  });

  it('rejects remote AI for direct tasks without project authorization',async()=>{
    const {db,taskId}=setup();db.raw.prepare("DELETE FROM authorization_scopes WHERE project_id=(SELECT project_id FROM tasks WHERE id=?)").run(taskId);
    const fetchSpy=vi.spyOn(globalThis,'fetch');const requestSpy=vi.spyOn(https,'request');
    await expect(callAgent(input(db,taskId,'https://example.invalid/v1',{allowRemoteData:true}))).rejects.toThrow(/does not allow remote AI/);
    expect(fetchSpy).not.toHaveBeenCalled();expect(requestSpy).not.toHaveBeenCalled();
  });
  it.each(['target','adapter','operation','expiry'] as const)('rejects remote AI when authorization %s does not match the task',async mismatch=>{
    const {db,taskId}=setup();const projectId=String((db.raw.prepare('SELECT project_id FROM tasks WHERE id=?').get(taskId) as {project_id:string}).project_id);
    if(mismatch==='target')db.raw.prepare("UPDATE authorization_scopes SET target='other-target' WHERE id='remote-auth'").run();
    if(mismatch==='adapter')db.raw.prepare("UPDATE authorization_scopes SET allowed_interfaces_json='[\"website\"]' WHERE id='remote-auth'").run();
    if(mismatch==='operation')db.raw.prepare("UPDATE authorization_scopes SET allowed_operations_json='[\"read-target\"]' WHERE id='remote-auth'").run();
    if(mismatch==='expiry')db.raw.prepare("UPDATE authorization_scopes SET expires_at=? WHERE id='remote-auth'").run(new Date(Date.now()-60_000).toISOString());
    const fetchSpy=vi.spyOn(globalThis,'fetch');const requestSpy=vi.spyOn(https,'request');
    await expect(callAgent(input(db,taskId,'https://example.invalid/v1',{allowRemoteData:true}))).rejects.toThrow(/does not allow remote AI/);
    expect(fetchSpy).not.toHaveBeenCalled();expect(requestSpy).not.toHaveBeenCalled();expect(projectId).toBeTruthy();
  });

  it('rejects a direct local-path task when only another target is authorized',async()=>{
    const {db}=setup();const projectId=String((db.raw.prepare("SELECT project_id FROM authorization_scopes WHERE id='remote-auth'").get() as {project_id:string}).project_id);
    const task=db.createTask(projectId,'legacy',{adapter:'legacy',options:{path:'C:\\unauthorized\\target'}},'a'.repeat(64));
    const fetchSpy=vi.spyOn(globalThis,'fetch');const requestSpy=vi.spyOn(https,'request');
    await expect(callAgent(input(db,task.id,'https://example.invalid/v1',{allowRemoteData:true}))).rejects.toThrow(/does not allow remote AI/);
    expect(fetchSpy).not.toHaveBeenCalled();expect(requestSpy).not.toHaveBeenCalled();
  });
  it('normalizes Windows path targets consistently for authorization',async()=>{
    const {db}=setup();const projectId=String((db.raw.prepare("SELECT project_id FROM authorization_scopes WHERE id='remote-auth'").get() as {project_id:string}).project_id);const task=db.createTask(projectId,'legacy',{adapter:'legacy',options:{path:'C:\\Software\\Target'}},'b'.repeat(64));db.raw.prepare("UPDATE authorization_scopes SET target=? WHERE id='remote-auth'").run('c:\\software\\target');
    const fetchSpy=vi.spyOn(globalThis,'fetch');const requestSpy=vi.spyOn(https,'request');
    await expect(callAgent(input(db,task.id,'https://example.invalid/v1',{allowRemoteData:true}))).rejects.toThrow(/does not allow remote AI/);
    expect(fetchSpy).not.toHaveBeenCalled();expect(requestSpy).not.toHaveBeenCalled();
  });
  it('binds direct uploaded tasks to the selected upload instead of any project upload',async()=>{
    const {db}=setup();const projectId=String((db.raw.prepare("SELECT project_id FROM authorization_scopes WHERE id='remote-auth'").get() as {project_id:string}).project_id);
    for(const id of ['upload-a','upload-b'])db.addUpload({id,projectId,name:`${id}.bin`,storedName:`${id}.stored`,mime:'application/octet-stream',size:1,sha256:id,createdAt:new Date().toISOString()});
    db.raw.prepare("UPDATE authorization_scopes SET target='upload-a' WHERE id='remote-auth'").run();
    const task=db.createTask(projectId,'file',{adapter:'file',options:{uploadId:'upload-b'}},'upload-task');
    const fetchSpy=vi.spyOn(globalThis,'fetch');const requestSpy=vi.spyOn(https,'request');
    await expect(callAgent(input(db,task.id,'https://example.invalid/v1',{allowRemoteData:true}))).rejects.toThrow(/does not allow remote AI/);
    expect(fetchSpy).not.toHaveBeenCalled();expect(requestSpy).not.toHaveBeenCalled();
  });
  it('fails closed when a direct upload task has an ambiguous input',async()=>{
    const {db}=setup();const projectId=String((db.raw.prepare("SELECT project_id FROM authorization_scopes WHERE id='remote-auth'").get() as {project_id:string}).project_id);
    for(const id of ['upload-a','upload-b'])db.addUpload({id,projectId,name:`${id}.bin`,storedName:`${id}.stored`,mime:'application/octet-stream',size:1,sha256:id,createdAt:new Date().toISOString()});
    const task=db.createTask(projectId,'file',{adapter:'file',options:{}},'ambiguous-task');
    const fetchSpy=vi.spyOn(globalThis,'fetch');const requestSpy=vi.spyOn(https,'request');
    await expect(callAgent(input(db,task.id,'https://example.invalid/v1',{allowRemoteData:true}))).rejects.toThrow(/ambiguous|does not allow remote AI/);
    expect(fetchSpy).not.toHaveBeenCalled();expect(requestSpy).not.toHaveBeenCalled();
  });

  it('does not issue a request when remote data consent is revoked',async()=>{
    const {db,taskId}=setup();
    const fetchSpy=vi.spyOn(globalThis,'fetch');
    const requestSpy=vi.spyOn(https,'request');

    await expect(callAgent(input(db,taskId,'https://example.invalid/v1',{allowRemoteData:false}))).rejects.toThrow(/consent/i);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(requestSpy).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
    expect(db.raw.prepare('SELECT COUNT(*) AS count FROM agent_runs WHERE task_id=?').get(taskId)).toEqual({count:0});
  });
});

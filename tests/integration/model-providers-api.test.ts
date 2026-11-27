import http from 'node:http';
import type { AddressInfo } from 'node:net';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { Database } from '@reverse/workflow';
import { AppError } from '@reverse/contracts';
import { registerModelRoutes } from '../../apps/api/src/model-routes.js';
import type { SecretStore } from '../../packages/autopilot/src/providers.js';

const token='model-api-test';
const auth={authorization:`Bearer ${token}`};
const json={...auth,'content-type':'application/json'};
const cleanups:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse())await cleanup();});
const capabilities={chat:true,stream:true,tools:true,structuredOutput:true,vision:false};
const limits={timeoutMs:1000,retries:0,rateLimitPerMinute:60,maxTokensPerRequest:256,maxTokensPerTask:1000,maxCostUsdPerTask:1};
const provider=(baseUrl:string,overrides:Record<string,unknown>={})=>({id:'local',name:'Local',kind:'ollama',baseUrl,model:'test',enabled:true,priority:1,roles:['main','fallback'],capabilities,limits,...overrides});

async function setup(){
  const db=new Database(':memory:');const secrets=new Map<string,string>();
  const secretStore:SecretStore={get:async ref=>secrets.get(ref)??null,set:async(ref,value)=>{secrets.set(ref,value);},delete:async ref=>{secrets.delete(ref);},has:async ref=>secrets.has(ref)};
  const app=Fastify({logger:false});
  app.setErrorHandler((error,_req,reply)=>{const status=error instanceof AppError?error.status:Number((error as {statusCode?:number}).statusCode??500);return reply.code(status).send({error:{code:error instanceof AppError?error.code:'ERROR',message:error.message}});});
  app.addHook('onRequest',async req=>{if(req.headers.authorization!==`Bearer ${token}`)throw Object.assign(new Error('Unauthorized'),{statusCode:401});});
  registerModelRoutes(app,{db,secretStore});await app.ready();
  cleanups.push(async()=>{await app.close();if(db.raw.isOpen)db.close();});
  return {app,db,secrets};
}
async function mockModel(){
  const requests:unknown[]=[];
  const server=http.createServer((req,res)=>{let body='';req.on('data',chunk=>{body+=String(chunk);});req.on('end',()=>{requests.push({url:req.url,body:JSON.parse(body||'{}')});res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({message:{content:'OK'},prompt_eval_count:1,eval_count:1}));});});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));cleanups.push(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));});
  return {baseUrl:`http://127.0.0.1:${(server.address() as AddressInfo).port}`,requests};
}

describe('Model providers V4 API',()=>{
  it('requires authentication and returns an empty provider list',async()=>{
    const {app}=await setup();
    expect((await app.inject({method:'GET',url:'/api/models/providers'})).statusCode).toBe(401);
    const response=await app.inject({method:'GET',url:'/api/models/providers',headers:auth});
    expect(response.statusCode).toBe(200);expect(response.json().items).toEqual([]);
  });
  it('persists profiles and role assignments without returning plaintext keys',async()=>{
    const {app,db,secrets}=await setup();const {baseUrl}=await mockModel();
    const saved=await app.inject({method:'PUT',url:'/api/models/providers',headers:json,body:{providers:[provider(baseUrl)],apiKey:'sk-plaintext-secret'}});
    expect(saved.statusCode).toBe(200);expect(saved.body).not.toContain('sk-plaintext-secret');expect(saved.json().items[0]).toMatchObject({hasApiKey:true,apiKeyRef:'model-provider:local'});
    expect([...secrets.values()]).toEqual(['sk-plaintext-secret']);expect(db.settings().model_providers_v4).not.toContain('sk-plaintext-secret');
    const roles=await app.inject({method:'POST',url:'/api/models/roles',headers:json,body:{roleAssignments:{main:['local'],code:['local']}}});
    expect(roles.statusCode).toBe(200);
    const list=await app.inject({method:'GET',url:'/api/models/providers',headers:auth});expect(list.json().roleAssignments.code).toEqual(['local']);
    const usage=await app.inject({method:'GET',url:'/api/models/usage',headers:auth});expect(usage.json().items).toEqual([]);
  });
  it('rejects unsafe URLs and remote providers without consent',async()=>{
    const {app}=await setup();
    for(const baseUrl of ['file:///etc/passwd','http://user:pass@example.com','http://example.com/v1','https://example.com/v1?key=x']){
      const response=await app.inject({method:'PUT',url:'/api/models/providers',headers:json,body:{providers:[provider(baseUrl)]}});expect(response.statusCode).toBe(400);
    }
    const remote=await app.inject({method:'PUT',url:'/api/models/providers',headers:json,body:{providers:[provider('https://models.example/v1')]}});expect(remote.statusCode).toBe(403);
  });
  it('runs bounded capability probes against the configured local model',async()=>{
    const {app}=await setup();const {baseUrl,requests}=await mockModel();
    expect((await app.inject({method:'PUT',url:'/api/models/providers',headers:json,body:{providers:[provider(baseUrl)]}})).statusCode).toBe(200);
    const response=await app.inject({method:'POST',url:'/api/models/providers/local/test',headers:auth});
    expect(response.statusCode).toBe(200);expect(response.json()).toMatchObject({ok:true,capabilities:{chat:true,stream:true,tools:true,structuredOutput:true}});
    expect(requests).toHaveLength(4);expect(requests[0]).toMatchObject({url:'/api/chat'});
  });
});

import { once } from 'node:events';
import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Database } from '@reverse/workflow';
import { redactDataForAi, stringifyForAi } from '@reverse/ai';
import { aiRoleFor, aiSystemPrompt, callAgent } from '../../packages/workflow/src/agent.js';
afterEach(()=>vi.restoreAllMocks());

describe('AI V3 role routing', () => {
  it('redacts generic credential keys and embedded secrets before outbound serialization', () => {
    const secret='s3cr3t-value-DO-NOT-SEND';
    const redacted=redactDataForAi({proof:secret,auth:secret,nested:{clientSecret:secret},items:[{password:secret}],note:`Bearer ${secret}`,normal:'keep'}) as Record<string,unknown>;
    expect(JSON.stringify(redacted)).not.toContain(secret);
    expect(redacted.note).toBe('[REDACTED]');
    expect(redacted.normal).toBe('keep');
    expect(stringifyForAi({token:secret})).not.toContain(secret);
  });
  it('rechecks project remote AI authorization at the call boundary', async () => {
    const db=new Database(':memory:');const project=db.project({name:'ai policy',kind:'software',authorizationConfirmed:true});const task=db.createTask(project.id,'file',{adapter:'file',options:{planId:'plan'}},'hash');db.raw.prepare("INSERT INTO authorization_scopes (id,project_id,target,scope_json,allowed_interfaces_json,allowed_operations_json,data_access_json,remote_ai_allowed,expires_at,created_at,revoked_at) VALUES ('auth',?,'target','[]','[]','[]','[]',0,NULL,?,NULL)").run(project.id,new Date().toISOString());db.raw.prepare("INSERT INTO analysis_plans (id,project_id,task_id,mode,target_json,detection_json,authorization_id,steps_json,budget_json,status,created_at,updated_at) VALUES ('plan',?,?,'agent','{}','{}','auth','[]','{}','RUNNING',?,?)").run(project.id,task.id,new Date().toISOString(),new Date().toISOString());const fetchSpy=vi.spyOn(globalThis,'fetch');
    await expect(callAgent({db,taskId:task.id,config:{enabled:true,baseUrl:'https://example.invalid/v1',model:'fixture',allowRemoteData:true},role:'planner',iteration:1,system:'test',prompt:'test',signal:new AbortController().signal})).rejects.toThrow(/does not allow remote AI/);expect(fetchSpy).not.toHaveBeenCalled();db.close();
  });
  it('allows a loopback model when project remote sharing is disabled', async () => {
    const server=createServer((req,res)=>{let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({choices:[{message:{content:'{"ok":true}'}}]}));});});server.listen(0,'127.0.0.1');await once(server,'listening');const port=(server.address() as {port:number}).port;
    const db=new Database(':memory:');const project=db.project({name:'local ai policy',kind:'software',authorizationConfirmed:true});const task=db.createTask(project.id,'file',{adapter:'file',options:{planId:'local-plan'}},'hash');db.raw.prepare("INSERT INTO authorization_scopes (id,project_id,target,scope_json,allowed_interfaces_json,allowed_operations_json,data_access_json,remote_ai_allowed,expires_at,created_at,revoked_at) VALUES ('local-auth',?,'target','[]','[]','[]','[]',0,NULL,?,NULL)").run(project.id,new Date().toISOString());db.raw.prepare("INSERT INTO analysis_plans (id,project_id,task_id,mode,target_json,detection_json,authorization_id,steps_json,budget_json,status,created_at,updated_at) VALUES ('local-plan',?,?,'agent','{}','{}','local-auth','[]','{}','RUNNING',?,?)").run(project.id,task.id,new Date().toISOString(),new Date().toISOString());
    try{await expect(callAgent({db,taskId:task.id,config:{enabled:true,baseUrl:`http://127.0.0.1:${port}/v1`,model:'fixture',allowRemoteData:false},role:'planner',iteration:1,system:'test',prompt:'test',signal:new AbortController().signal})).resolves.toContain('ok');}finally{db.close();server.closeAllConnections();server.close();await once(server,'close');}
  });
  it('keeps the legacy planner/interpreter/validator roles when V3 is disabled', () => {
    expect(aiRoleFor('file', 'PLAN', false)).toBe('planner');
    expect(aiRoleFor('file', 'MODEL_BEHAVIOR', false)).toBe('interpreter');
    expect(aiRoleFor('file', 'VALIDATE', false)).toBe('validator');
  });

  it('routes supported adapters to bounded V3 specialist roles', () => {
    expect(aiRoleFor('console', 'MODEL_BEHAVIOR', true)).toBe('device-researcher');
    expect(aiRoleFor('firmware', 'MODEL_BEHAVIOR', true)).toBe('firmware-analyst');
    expect(aiRoleFor('apk', 'MODEL_BEHAVIOR', true)).toBe('android-analyst');
    expect(aiRoleFor('website', 'MODEL_BEHAVIOR', true)).toBe('web-analyst');
    expect(aiRoleFor('network', 'MODEL_BEHAVIOR', true)).toBe('protocol-analyst');
    expect(aiRoleFor('game', 'MODEL_BEHAVIOR', true)).toBe('game-compatibility');
    expect(aiRoleFor('security', 'MODEL_BEHAVIOR', true)).toBe('defensive-security');
    expect(aiRoleFor('ghidra', 'MODEL_BEHAVIOR', true)).toBe('native-analyst');
    expect(aiRoleFor('console', 'VALIDATE', true)).toBe('evidence-validator');
  });

  it('uses specialist system prompts without replacing the safe fallback for legacy roles', () => {
    expect(aiSystemPrompt('device-researcher', 'fallback')).toMatch(/console research/i);
    expect(aiSystemPrompt('planner', 'fallback')).toBe('fallback');
  });
});

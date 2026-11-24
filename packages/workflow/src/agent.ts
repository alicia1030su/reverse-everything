import { isIP } from 'node:net';
import { randomUUID } from 'node:crypto';
import { redactSecrets } from '@reverse/ai';
import { safeFetch } from '@reverse/security';
import type { Database } from './database.js';

export interface AiRuntimeConfig { enabled:boolean;baseUrl:string;model:string;apiKey?:string;allowRemoteData?:boolean;promptVersion?:string }
export function isLoopbackHost(hostname:string):boolean {
  const host=hostname.toLowerCase().replace(/^\[|\]$/g,'');
  if(host==='localhost'||host.endsWith('.localhost'))return true;
  if(isIP(host)===4)return host.startsWith('127.');
  return isIP(host)===6&&host==='::1';
}
export function assertAiEndpoint(config:AiRuntimeConfig):URL {
  let endpoint:URL;
  try{endpoint=new URL(config.baseUrl);}catch{throw new Error('Invalid AI endpoint');}
  if(endpoint.username||endpoint.password)throw new Error('Credentials in AI endpoint URLs are forbidden');
  if(endpoint.hash)throw new Error('Fragments in AI endpoint URLs are forbidden');
  const local=isLoopbackHost(endpoint.hostname);
  if(!local&&config.allowRemoteData!==true)throw new Error('Remote AI data sharing consent has been revoked or was never granted');
  if(!local&&endpoint.protocol!=='https:')throw new Error('Remote AI endpoint must use HTTPS');
  if(local&&!['http:','https:'].includes(endpoint.protocol))throw new Error('Invalid AI endpoint protocol');
  if(!config.model.trim())throw new Error('AI model name is required');
  return endpoint;
}
export async function callAgent(input:{db:Database;taskId:string;config:AiRuntimeConfig;role:'planner'|'interpreter'|'validator';iteration:number;system:string;prompt:string;signal:AbortSignal}):Promise<string>{
  const endpoint=assertAiEndpoint(input.config);const id=randomUUID();const now=new Date().toISOString();
  input.db.raw.prepare('INSERT INTO agent_runs (id,task_id,role,status,iteration,input_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run(id,input.taskId,input.role,'RUNNING',input.iteration,JSON.stringify({model:input.config.model,promptVersion:input.config.promptVersion??'analysis-v1',prompt:redactSecrets(input.prompt).slice(0,120000)}),now,now);
  try{
    endpoint.pathname=`${endpoint.pathname.replace(/\/$/,'')}/chat/completions`;
    const response=await safeFetch(endpoint.toString(),{allowLocal:isLoopbackHost(endpoint.hostname),maxBytes:262144,timeoutMs:60000,method:'POST',headers:{'content-type':'application/json',...(input.config.apiKey?{authorization:`Bearer ${input.config.apiKey}`}:{})},body:JSON.stringify({model:input.config.model,messages:[{role:'system',content:input.system},{role:'user',content:input.prompt}],temperature:0}),followRedirects:false,signal:input.signal});
    if(response.truncated)throw new Error('AI response exceeded bounded size');
    if(response.status<200||response.status>=300)throw new Error(`AI provider returned HTTP ${response.status}`);
    const data=JSON.parse(response.body.toString('utf8')) as {choices?:{message?:{content?:string}}[]};const text=(data.choices?.[0]?.message?.content??'').slice(0,16000);
    input.db.raw.prepare("UPDATE agent_runs SET status='SUCCEEDED',output_json=?,updated_at=? WHERE id=?").run(JSON.stringify({text}),new Date().toISOString(),id);
    return text;
  }catch(error){
    const message=error instanceof Error?error.message:String(error);
    input.db.raw.prepare("UPDATE agent_runs SET status='FAILED',error=?,updated_at=? WHERE id=?").run(redactSecrets(message).slice(0,2000),new Date().toISOString(),id);
    throw error;
  }
}
export function extractJsonObject(text:string):Record<string,unknown>|undefined {
  const cleaned=text.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
  try{const value=JSON.parse(cleaned) as unknown;return value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined;}catch{return undefined;}
}
export function boundedIterations(value:unknown,fallback=2):number { return typeof value==='number'&&Number.isInteger(value)?Math.max(1,Math.min(3,value)):fallback; }

import { isIP } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { AppError } from '@reverse/contracts';
import { ModelProviderError, ModelProviderService, MODEL_ROLES } from '@reverse/autopilot';
import type { FetchLike, ModelProviderSettings, ModelRole, ProviderCapabilities, ProviderLimits, ProviderProfile, RoleAssignments, SecretStore } from '@reverse/autopilot';
import type { Database } from '@reverse/workflow';
import { safeFetch } from '@reverse/security';

const SETTINGS_KEY='model_providers_v4';
const CONSENT_KEY='model_provider_remote_consent_v4';
const USAGE_KEY='model_provider_usage_v4';
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const object=(value:unknown):Record<string,unknown>=>{if(!value||typeof value!=='object'||Array.isArray(value))throw new AppError('BAD_REQUEST','A JSON object body is required',400);return value as Record<string,unknown>;};
const text=(value:unknown,name:string,max=200):string=>{if(typeof value!=='string'||!value.trim()||value.length>max||/[\u0000-\u001f\u007f]/.test(value))throw new AppError('BAD_REQUEST',`${name} must be a bounded string without control characters`,400);return value.trim();};
const bool=(value:unknown,name:string):boolean=>{if(typeof value!=='boolean')throw new AppError('BAD_REQUEST',`${name} must be boolean`,400);return value;};
const number=(value:unknown,name:string,min:number,max:number,integer=false):number=>{if(typeof value!=='number'||!Number.isFinite(value)||value<min||value>max||(integer&&!Number.isSafeInteger(value)))throw new AppError('BAD_REQUEST',`${name} is out of range`,400);return value;};
const localHost=(host:string)=>host==='localhost'||host.endsWith('.localhost')||host==='::1'||(isIP(host)===4&&host.startsWith('127.'));
function modelUrl(value:unknown):URL{
  const raw=text(value,'baseUrl',2048);let url:URL;
  try{url=new URL(raw);}catch{throw new AppError('BAD_REQUEST','Invalid model base URL',400);}
  const host=url.hostname.replace(/^\[|\]$/g,'').toLowerCase();
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.hash||url.search)throw new AppError('BAD_REQUEST','Model URL must be HTTP(S) without credentials, query or fragment',400);
  if(!localHost(host)&&url.protocol!=='https:')throw new AppError('BAD_REQUEST','Remote model base URL must use HTTPS',400);
  if(isIP(host)&&!localHost(host))throw new AppError('BAD_REQUEST','Remote model base URL must use a hostname',400);
  return url;
}
function capabilities(value:unknown):ProviderCapabilities{
  const input=object(value);const result:ProviderCapabilities={chat:bool(input.chat,'capabilities.chat'),stream:bool(input.stream,'capabilities.stream'),tools:bool(input.tools,'capabilities.tools'),structuredOutput:bool(input.structuredOutput,'capabilities.structuredOutput'),vision:bool(input.vision,'capabilities.vision')};
  if(input.maxContextTokens!==undefined)return {...result,maxContextTokens:number(input.maxContextTokens,'capabilities.maxContextTokens',1,10_000_000,true)};
  return result;
}
function limits(value:unknown):ProviderLimits{
  const input=object(value);
  const result:ProviderLimits={timeoutMs:number(input.timeoutMs,'limits.timeoutMs',1,600_000,true),retries:number(input.retries,'limits.retries',0,10,true),rateLimitPerMinute:number(input.rateLimitPerMinute,'limits.rateLimitPerMinute',1,100_000,true),maxTokensPerRequest:number(input.maxTokensPerRequest,'limits.maxTokensPerRequest',1,1_000_000,true),maxTokensPerTask:number(input.maxTokensPerTask,'limits.maxTokensPerTask',1,100_000_000,true),maxCostUsdPerTask:number(input.maxCostUsdPerTask,'limits.maxCostUsdPerTask',0,1_000_000)};
  if(input.inputCostPerMillionUsd!==undefined)result.inputCostPerMillionUsd=number(input.inputCostPerMillionUsd,'limits.inputCostPerMillionUsd',0,1_000_000);
  if(input.outputCostPerMillionUsd!==undefined)result.outputCostPerMillionUsd=number(input.outputCostPerMillionUsd,'limits.outputCostPerMillionUsd',0,1_000_000);
  if(result.maxTokensPerTask<result.maxTokensPerRequest)throw new AppError('BAD_REQUEST','maxTokensPerTask must be at least maxTokensPerRequest',400);
  return result;
}
function safeAdapter():FetchLike{
  return async(url,init)=>{
    const result=await safeFetch(url,{allowLocal:localHost(new URL(url).hostname.replace(/^\[|\]$/g,'').toLowerCase()),maxBytes:65_536,timeoutMs:10_000,method:init?.method??'GET',...(init?.headers?{headers:init.headers}:{}),...(init?.body!==undefined?{body:init.body}:{}),...(init?.signal?{signal:init.signal}:{}),followRedirects:false});
    return {ok:result.status>=200&&result.status<300,status:result.status,text:async()=>result.body.toString('utf8')};
  };
}

export interface ModelRouteOptions { db:Database; secretStore:SecretStore }
export function registerModelRoutes(app:FastifyInstance,{db,secretStore}:ModelRouteOptions):void{
  const load=():ModelProviderSettings|null=>{const raw=db.settings()[SETTINGS_KEY];if(!raw)return null;try{const value=JSON.parse(raw) as ModelProviderSettings;return value.version===4?value:null;}catch{return null;}};
  const settingsStore={load:async()=>load(),save:async(settings:ModelProviderSettings)=>{db.setSetting(SETTINGS_KEY,JSON.stringify(settings));}};
  const service=new ModelProviderService({secretStore,settingsStore,fetchImpl:safeAdapter()});
  let ready:Promise<void>|undefined;
  const initialize=()=>ready??=service.initialize();
  const consents=():Record<string,boolean>=>{try{return JSON.parse(db.settings()[CONSENT_KEY]??'{}') as Record<string,boolean>;}catch{return {};}};
  const saveConsents=(value:Record<string,boolean>)=>db.setSetting(CONSENT_KEY,JSON.stringify(value));
  const profile=(value:unknown,existing?:ProviderProfile):ProviderProfile=>{
    const input=object(value),id=text(input.id,'id',128);
    if(!ID.test(id))throw new AppError('BAD_REQUEST','Provider id contains unsafe characters',400);
    const now=new Date().toISOString();
    if(!Array.isArray(input.roles)||input.roles.length<1||input.roles.length>MODEL_ROLES.length||input.roles.some(role=>!MODEL_ROLES.includes(role as ModelRole)))throw new AppError('BAD_REQUEST','roles must contain valid model roles',400);
    const apiKeyRef=existing?.apiKeyRef??`model-provider:${id}`;
    return {id,name:text(input.name,'name',120),kind:input.kind as ProviderProfile['kind'],baseUrl:modelUrl(input.baseUrl).toString(),model:text(input.model,'model',200),apiKeyRef,enabled:bool(input.enabled,'enabled'),priority:number(input.priority,'priority',0,1_000_000,true),roles:[...new Set(input.roles as ModelRole[])],capabilities:capabilities(input.capabilities),limits:limits(input.limits),createdAt:existing?.createdAt??now,updatedAt:now};
  };

  app.get('/api/models/providers',async()=>{await initialize();return {items:await service.listProviders(),roleAssignments:service.getSettings().roleAssignments};});
  app.put('/api/models/providers',async(_req,reply)=>{await initialize();const body=object(_req.body);const items=Array.isArray(body.providers)?body.providers:[body];if(items.length<1||items.length>50)throw new AppError('BAD_REQUEST','providers must contain 1-50 profiles',400);const existing=new Map((await service.listProviders()).map(item=>[item.id,item]));const approved=consents();const saved=[];for(const item of items){const candidate=profile(item,existing.get(text(object(item).id,'id',128)));if(candidate.kind!== 'openai-compatible'&&candidate.kind!=='ollama'&&candidate.kind!=='custom')throw new AppError('BAD_REQUEST','Invalid provider kind',400);const local=localHost(new URL(candidate.baseUrl).hostname.replace(/^\[|\]$/g,'').toLowerCase());if(!local&&approved[candidate.id]!==true&&body.remoteConsent!==true)throw new AppError('FORBIDDEN','Remote model data sharing requires explicit consent',403);if(!local&&body.remoteConsent===true){approved[candidate.id]=true;saveConsents(approved);}const input=object(item);const apiKey=input.apiKey??body.apiKey;if(typeof apiKey==='string'&&apiKey){if(apiKey.length>16_384)throw new AppError('BAD_REQUEST','apiKey is too long',400);await secretStore.set(candidate.apiKeyRef!,apiKey);}saved.push(await service.upsertProvider(candidate));}return reply.send({items:saved,roleAssignments:service.getSettings().roleAssignments});});
  app.post<{Params:{id:string}}>('/api/models/providers/:id/test',async req=>{
    await initialize();const current=(await service.listProviders()).find(item=>item.id===req.params.id);if(!current)throw new AppError('NOT_FOUND','Model provider not found',404);
    const local=localHost(new URL(current.baseUrl).hostname.replace(/^\[|\]$/g,'').toLowerCase());if(!local&&consents()[current.id]!==true)throw new AppError('FORBIDDEN','Remote model data sharing requires explicit consent',403);
    const bounded={...current,limits:{...current.limits,timeoutMs:Math.min(current.limits.timeoutMs,10_000),retries:0}};
    const probe=new ModelProviderService({providers:[bounded],secretStore,fetchImpl:safeAdapter()});
    try{const detected=await probe.detectCapabilities(current.id);return {ok:detected.chat,capabilities:detected};}catch(error){if(error instanceof ModelProviderError)return {ok:false,error:error.code,capabilities:current.capabilities};throw error;}
  });
  app.post('/api/models/roles',async req=>{await initialize();const body=object(req.body);const input=object(body.roleAssignments??body);const assignments:RoleAssignments={};for(const [role,value] of Object.entries(input)){if(role==='fallback'||!MODEL_ROLES.includes(role as ModelRole)||!Array.isArray(value)||value.length>50||value.some(id=>typeof id!=='string'||!ID.test(id)))throw new AppError('BAD_REQUEST','Invalid role assignments',400);assignments[role as Exclude<ModelRole,'fallback'>]=[...new Set(value as string[])];}await service.setRoleAssignments(assignments);return {roleAssignments:assignments};});
  app.get('/api/models/usage',async()=>{await initialize();let persisted:{taskId:string;tokens:number;costUsd:number}[]=[];try{persisted=JSON.parse(db.settings()[USAGE_KEY]??'[]') as {taskId:string;tokens:number;costUsd:number}[];}catch{}const merged=new Map(persisted.map(item=>[item.taskId,item]));for(const item of service.getUsage())merged.set(item.taskId,item);  return {items:[...merged.values()],scope:'process-and-persisted'};});
}

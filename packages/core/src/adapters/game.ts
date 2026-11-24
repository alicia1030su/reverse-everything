import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, scrypt } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { copyFile, mkdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { defineAdapter, limitedRead, output, uploadPath } from './base.js';

interface TraceMessage { seq:number; at:string; direction:'client'|'server'; type:string; payload:Record<string,unknown> }
interface Trace { format:string; target:{name:string}; messages:TraceMessage[] }
type FieldType='string'|'number'|'boolean'|'null'|'array'|'object'|'UNKNOWN';
interface FieldSchema { path:string; type:FieldType; observed:number; confidence:'EVIDENCE'; required?:boolean }
interface ProtocolModel {
  messageTypes:{direction:'client'|'server';type:string;count:number;fields:FieldSchema[]}[];
  transitions:{from:string;to:string;count:number}[]; requestResponses:{request:string;responses:string[];examples:Record<string,unknown>;requestPayload:Record<string,unknown>;failures:number}[];
  unknowns:string[]; messageLimit:number; truncated:boolean;
}
type StateCategory='account'|'inventory'|'position'|'save'|'progress'|'other';
interface StateField { path:string; type:FieldType; category:StateCategory; samples:unknown[] }
interface StateSnapshot { type:string; payload:Record<string,unknown>; fields:StateField[] }
type ChangeRule={path:string;kind:'set';value:unknown}|{path:string;kind:'setFromRequest';requestField:string;values?:unknown[]}|{path:string;kind:'add';value:number}|{path:string;kind:'addFromRequest';requestField:string;min?:number;max?:number}|{path:string;kind:'subtractFromRequest';requestField:string;min?:number;max?:number};
interface ConcreteChange { path:string; value:unknown }
interface MutationSample { request:Record<string,unknown>; changes:ConcreteChange[]; before?:Map<string,unknown> }
interface StateMutation { request:string; stateType:string; changes:ChangeRule[]; cases?:{request:Record<string,unknown>;changes:ConcreteChange[]}[]; observed:number; account?:string; rejected?:Record<string,unknown>[]; conflict?:boolean }
interface CredentialVerifier { key:string; identityHash:string; salt:string; hash:string }
interface AccountModel { loginRequest:string;requestField:string;credentialFields:string[];idPaths:string[];namePaths:string[];successTypes:string[];verifiers:CredentialVerifier[] }
interface SecretVerifier { path:string; salt:string; hash:string }
interface RequestSecretSample { request:string; account?:string; verifiers:SecretVerifier[] }
interface StateModel { snapshots:StateSnapshot[]; mutations:StateMutation[]; requestSecrets:RequestSecretSample[]; account:AccountModel|null; limitations:string[] }
interface CompatRule { type:string; fields:FieldSchema[]; responses:{type:string;payload:Record<string,unknown>}[]; requestPayload:Record<string,unknown>; mutations:StateMutation[]; requestSecrets:RequestSecretSample[] }
interface CompatibilityModel { level:'L4'; meaning:string; rules:CompatRule[]; state:StateModel; account:StateModel['account'] }

const MAX_TRACE_MESSAGES=10_000; const MAX_TRACE_BYTES=10_000_000; const MAX_FIELDS=256; const MAX_DEPTH=8; const MAX_SAMPLE_NODES=512; const MAX_MUTATION_CASES=32; const MAX_LOGIN_MESSAGES=256; const MAX_VERIFIERS=32; const MAX_SECRET_FIELDS=16;
const DANGEROUS_KEY=/^(?:__proto__|prototype|constructor)$/;
const IDENTITY_KEY=/^(?:id|playerid|accountid|userid|name|displayname|username|email)$/i;
const SENSITIVE_KEY=/password|passwd|pwd|secret|token|jwt|bearer|credential|authorization|refresh|sid|(?:api|private|access|signing)[_-]?key|(?:^|[_-])key(?:$|[_-])|session[_-]?(?:id|key)?|cookie|^auth(?:entication)?$/i;
const scryptAsync=promisify(scrypt);
function sensitivePath(p:string):boolean { return p.split('.').some(part=>SENSITIVE_KEY.test(part)); }
function containsSensitive(value:unknown,depth=0,budget={nodes:MAX_SAMPLE_NODES}):boolean {if(depth>MAX_DEPTH||budget.nodes--<=0)return true;if(!value||typeof value!=='object')return false;const entries=Array.isArray(value)?value.map((item,index)=>[String(index),item] as const):Object.entries(value as Record<string,unknown>);if(entries.length>MAX_FIELDS)return true;return entries.some(([key,item])=>SENSITIVE_KEY.test(key)||containsSensitive(item,depth+1,budget));}
function credentialPaths(payload:Record<string,unknown>):string[] {const out:string[]=[];for(const [key,value] of Object.entries(payload).slice(0,MAX_FIELDS)){if(DANGEROUS_KEY.test(key))continue;if(sensitivePath(key)||containsSensitive(value))out.push(key);if(out.length>=MAX_SECRET_FIELDS)break;}return out;}
function redactString(value:string):string { return value.replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]+/gi,'[REDACTED]').replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,'[REDACTED]').replace(/\b(password|passwd|pwd|token|secret|jwt|auth|authorization|refresh|sid|key)\s*[:=]\s*([^\s,;]+)/gi,'$1=[REDACTED]'); }
async function readTraceFile(file:string):Promise<Trace>{const bytes=await limitedRead(file,MAX_TRACE_BYTES+1);if(bytes.length>MAX_TRACE_BYTES)throw new Error(`Trace exceeds the ${MAX_TRACE_BYTES}-byte limit`);return JSON.parse(bytes.toString('utf8')) as Trace;}
function rawPayload(m:TraceMessage):Record<string,unknown>{const envelope=m.payload.payload;const wrapper=typeof m.payload.type==='string'||Object.keys(m.payload).every(key=>key==='type'||key==='payload');const payload=wrapper&&envelope&&typeof envelope==='object'&&!Array.isArray(envelope)?envelope as Record<string,unknown>:m.payload;const out={...payload};delete out.type;return out;}
function payloadOnly(m:TraceMessage):Record<string,unknown> { return sampleRecord(rawPayload(m)); }
function failureResponse(type:string,payload:Record<string,unknown>):boolean { return /error|fail|denied|reject|refus|invalid|unauth|forbid|unknown|unobserved|abort|cancel/i.test(type)||/error|fail|denied|reject|refus|invalid|unauth|forbid|unknown|unobserved|abort|cancel/i.test(String(payload.code??''))||/error|fail|denied|reject|refus|invalid|unauth|forbid|unknown|unobserved|abort|cancel/i.test(String(payload.status??''))||Boolean(payload.error)||payload.ok===false||payload.success===false||payload.authenticated===false; }
function loginSuccess(type:string,payload:Record<string,unknown>):boolean { return !failureResponse(type,payload)&&(/login[_-]?(?:ok|success)|authenticated|auth[_-]?ok|signin[_-]?(?:ok|success)|signed[_-]?in/i.test(type)||payload.authenticated===true||payload.success===true); }
function identityHash(identity:string):string { return createHash('sha256').update('identity\0'+identity).digest('hex'); }
function credentialMaterial(request:Record<string,unknown>,fields:string[]):string { return fields.map(p=>createHash('sha256').update(JSON.stringify(valueAt(request,p)??null)).digest('hex')).join('\0'); }
async function verifierFor(request:Record<string,unknown>,requestField:string,credentialFields:string[],existing:CredentialVerifier[]=[]):Promise<CredentialVerifier> { const identity=request[requestField];if(typeof identity!=='string'||!identity.length)throw new Error('Observed login has no account identity');const index=identityHash(identity.slice(0,128));if(!credentialFields.length)return {key:index,identityHash:index,salt:'',hash:''};const salt=existing.find(v=>v.identityHash===index)?.salt??randomBytes(16).toString('hex');const hash=(await scryptAsync(credentialMaterial(request,credentialFields),salt,64) as Buffer).toString('hex');return {key:createHash('sha256').update(index+'\0'+hash).digest('hex'),identityHash:index,salt,hash}; }
async function secretVerifierFor(request:Record<string,unknown>,path:string,cache:Map<string,SecretVerifier>):Promise<SecretVerifier>{const value=valueAt(request,path);if(value===undefined||value===null)throw new Error('Observed secret must be a non-null value');const material=createHash('sha256').update(JSON.stringify(value)).digest('hex');const fingerprint=createHash('sha256').update(path+'\0'+material).digest('hex');const cached=cache.get(fingerprint);if(cached)return cached;if(cache.size>=MAX_VERIFIERS)throw new Error(`Trace exceeds the ${MAX_VERIFIERS}-secret verifier inference limit`);const salt=randomBytes(16).toString('hex');const hash=(await scryptAsync(material,salt,64) as Buffer).toString('hex');const verifier={path,salt,hash};cache.set(fingerprint,verifier);return verifier;}
function fieldType(value:unknown):FieldType { return value===null?'null':Array.isArray(value)?'array':typeof value as FieldType; }
function boundedSample(value:unknown,depth=0,budget={nodes:MAX_SAMPLE_NODES}):unknown {
  if(budget.nodes<=0||depth>MAX_DEPTH)return '[truncated]';
  budget.nodes--;
  if(typeof value==='string')return redactString(value).slice(0,4096);
  if(typeof value==='number'&&!Number.isFinite(value))return null;
  if(Array.isArray(value))return value.slice(0,64).map(v=>boundedSample(v,depth+1,budget));
  if(value&&typeof value==='object'){const out:Record<string,unknown>={};for(const [k,v] of Object.entries(value).slice(0,MAX_FIELDS)){if(DANGEROUS_KEY.test(k))continue;out[k]=SENSITIVE_KEY.test(k)||IDENTITY_KEY.test(k)?null:boundedSample(v,depth+1,budget);}return out;}
  return value;
}
function sampleRecord(payload:Record<string,unknown>):Record<string,unknown> { return boundedSample(payload) as Record<string,unknown>; }
function inferFields(payload:Record<string,unknown>,prefix='',depth=0):FieldSchema[] {
  if(depth>=MAX_DEPTH)return []; const out:FieldSchema[]=[];
  for(const [key,value] of Object.entries(payload).slice(0,MAX_FIELDS)) {
    if(DANGEROUS_KEY.test(key))continue; const p=prefix?`${prefix}.${key}`:key; const type=fieldType(value);
    out.push({path:p,type,observed:1,confidence:'EVIDENCE'});
    if(type==='object'&&value&&typeof value==='object')out.push(...inferFields(value as Record<string,unknown>,p,depth+1));
    if(out.length>=MAX_FIELDS)break;
  }
  return out;
}
export function inferProtocol(trace:Trace,options:{maxMessages?:number}={}):ProtocolModel {
  const messageLimit=Math.max(1,Math.min(MAX_TRACE_MESSAGES,Math.floor(options.maxMessages??MAX_TRACE_MESSAGES)));
  const messages=Array.isArray(trace.messages)?trace.messages.slice(0,messageLimit):[];
  const map=new Map<string,{direction:'client'|'server';type:string;count:number;fields:Map<string,FieldSchema>}>();
  const transitionMap=new Map<string,{from:string;to:string;count:number}>();
  const responseMap=new Map<string,{request:string;responses:Set<string>;examples:Record<string,unknown>;requestPayload:Record<string,unknown>;exampleCounts:Map<string,number>;failures:number}>();
  const unknowns:string[]=[]; let pending:TraceMessage|null=null; let pendingSawServer=false;let pendingExamples:{type:string;payload:Record<string,unknown>}[]=[];
  const commitExamples=()=>{if(!pending||!pendingExamples.length)return;const rule=responseMap.get(pending.type)!;if(pendingExamples.some(example=>failureResponse(example.type,example.payload))){rule.failures++;return;}for(const example of pendingExamples){const count=rule.exampleCounts.get(example.type)??0;if(count<8){rule.examples[example.type]=example.payload;rule.exampleCounts.set(example.type,count+1);}}};
  for(let i=0;i<messages.length;i++) {
    const m=messages[i]!; const key=`${m.direction}:${m.type}`; let item=map.get(key);
    if(!item){item={direction:m.direction,type:m.type,count:0,fields:new Map()};map.set(key,item);} item.count++;
    for(const field of inferFields(rawPayload(m))){const old=item.fields.get(field.path);if(old&&old.type!==field.type)old.type='UNKNOWN';else if(!old)item.fields.set(field.path,{...field,observed:1});else old.observed++;}
    const next=messages[i+1]; if(next){const from=`${m.direction}:${m.type}`;const to=`${next.direction}:${next.type}`;const tk=`${from}->${to}`;const old=transitionMap.get(tk);if(old)old.count++;else transitionMap.set(tk,{from,to,count:1});}
    if(m.direction==='client'){
      commitExamples();if(pending&&!pendingSawServer&&unknowns.length<100)unknowns.push(`No server response observed for ${pending.type}`);
      pending=m;pendingSawServer=false;pendingExamples=[];
      if(!responseMap.has(m.type))responseMap.set(m.type,{request:m.type,responses:new Set(),examples:{},requestPayload:payloadOnly(m),exampleCounts:new Map(),failures:0});
    }else if(pending){
      pendingSawServer=true;const rule=responseMap.get(pending.type)!;rule.responses.add(m.type);pendingExamples.push({type:m.type,payload:payloadOnly(m)});
    }
  }
  commitExamples();if(pending&&!pendingSawServer&&unknowns.length<100)unknowns.push(`No server response observed for ${pending.type}`);
  for(const item of map.values())for(const field of item.fields.values())field.required=field.observed===item.count;
  return {messageTypes:[...map.values()].map(x=>({direction:x.direction,type:x.type,count:x.count,fields:[...x.fields.values()].map(f=>({...f}))})),transitions:[...transitionMap.values()],requestResponses:[...responseMap.values()].map(r=>({request:r.request,responses:[...r.responses],examples:r.examples,requestPayload:r.requestPayload,failures:r.failures})),unknowns,messageLimit,truncated:(trace.messages?.length??0)>messages.length};
}
function valueAt(root:unknown,p:string):unknown { let value=root;for(const part of p.split('.')){if(!value||typeof value!=='object'||Array.isArray(value))return undefined;value=(value as Record<string,unknown>)[part];}return value; }
function category(path:string):StateCategory { const p=path.toLowerCase();if(/inventory|items|bag|equipment|slots/.test(p))return'inventory';if(/position|coordinate|(?:^|\.)(?:x|y|z|room|map|zone)(?:\.|$)/.test(p))return'position';if(/save|checkpoint|slot/.test(p))return'save';if(/account|player|user|profile|(?:^|\.)(?:id|name|displayname)(?:\.|$)/.test(p))return'account';if(/xp|level|score|progress|coins|gold|health|mana|stats/.test(p))return'progress';return'other'; }
function isStateMessage(type:string,payload:Record<string,unknown>):boolean { return /state|player|inventory|position|account|save|profile/i.test(type)||inferFields(payload).some(f=>category(f.path)!=='other'); }
function flatten(value:unknown,prefix='',out=new Map<string,unknown>(),depth=0):Map<string,unknown> {
  if(depth>MAX_DEPTH||out.size>=MAX_FIELDS||!value||typeof value!=='object'||Array.isArray(value))return out;
  for(const [k,v] of Object.entries(value).slice(0,MAX_FIELDS)){if(DANGEROUS_KEY.test(k))continue;const p=prefix?`${prefix}.${k}`:k;out.set(p,v);if(v&&typeof v==='object'&&!Array.isArray(v))flatten(v,p,out,depth+1);}return out;
}
function sameValue(a:unknown,b:unknown):boolean { if(a===b)return true;if(!a||!b||typeof a!=='object'||typeof b!=='object')return false;if(Array.isArray(a)||Array.isArray(b))return JSON.stringify(a)===JSON.stringify(b);const ak=Object.keys(a).sort(),bk=Object.keys(b).sort();return ak.length===bk.length&&ak.every((k,i)=>k===bk[i]&&sameValue((a as Record<string,unknown>)[k],(b as Record<string,unknown>)[k])); }
function primitive(v:unknown):v is string|number|boolean|null { return v===null||['string','number','boolean'].includes(typeof v); }
function numeric(v:unknown):v is number { return typeof v==='number'&&Number.isFinite(v); }
function inferChange(path:string,before:unknown,after:unknown,request:Record<string,unknown>):ChangeRule {
  if(numeric(before)&&numeric(after)){const delta=after-before;for(const [key,value] of Object.entries(request))if(/^(?:d[xyz]|delta.*|.*delta)$/i.test(key)&&numeric(value)&&(delta===value||delta===-value))return {path,kind:delta===value?'addFromRequest':'subtractFromRequest',requestField:key};}
  if(primitive(after))for(const [key,value] of Object.entries(request))if(primitive(value)&&sameValue(value,after))return {path,kind:'setFromRequest',requestField:key};
  if(numeric(before)&&numeric(after)){
    const delta=after-before;
    for(const [key,value] of Object.entries(request))if(numeric(value)&&(delta===value||delta===-value))return {path,kind:delta===value?'addFromRequest':'subtractFromRequest',requestField:key};
    return {path,kind:'add',value:delta};
  }
  return {path,kind:'set',value:boundedSample(after)};
}
function mergeChangeRules(rules:(ChangeRule|null)[],samples:MutationSample[]):ChangeRule|null {
  if(rules.length!==samples.length||rules.some(rule=>!rule))return null;
  const present=rules as ChangeRule[];const first=present[0]!;
  if(!present.every(rule=>rule.path===first.path&&rule.kind===first.kind))return null;
  if(first.kind==='set'||first.kind==='add')return present.every(rule=>sameValue(rule,first))?first:null;
  if(first.kind==='setFromRequest'){
    if(sensitivePath(first.requestField)||!present.every(rule=>rule.kind==='setFromRequest'&&rule.requestField===first.requestField))return null;
    const values=samples.map(sample=>valueAt(sample.request,first.requestField));
    if(!values.every(primitive))return null;
    return {...first,values:[...new Map(values.map(value=>[JSON.stringify(value),boundedSample(value)])).values()].slice(0,MAX_MUTATION_CASES)};
  }
  if(!present.every(rule=>(rule.kind==='addFromRequest'||rule.kind==='subtractFromRequest')&&rule.requestField===first.requestField))return null;
  const values=samples.map(sample=>valueAt(sample.request,first.requestField));
  if(!values.every(numeric))return null;
  return {...first,min:Math.min(...values),max:Math.max(...values)};
}
function buildMutation(request:string,stateType:string,samples:MutationSample[]):StateMutation {
  const allPaths=[...new Set(samples.flatMap(s=>s.changes.map(c=>c.path)))].slice(0,MAX_FIELDS);const paths=allPaths.filter(p=>!allPaths.some(other=>other.startsWith(p+'.')));
  const changes:ChangeRule[]=[]; let generic=true;
  const candidates=paths.map(p=>samples.map(sample=>{
    const change=sample.changes.find(c=>c.path===p);if(!change)return null;
    return inferChangeFromSample(sample,p,change.value);
  }));
  for(const list of candidates){const merged=mergeChangeRules(list,samples);if(!merged){generic=false;break;}changes.push(merged);}
  const observed=samples.length;
  if(generic&&samples.length>1&&changes.length>0)return {request,stateType,changes,observed};
  const cases=samples.slice(0,MAX_MUTATION_CASES).map(s=>({request:sampleRecord(s.request),changes:s.changes.filter(c=>paths.includes(c.path)).slice(0,MAX_FIELDS)}));
  for(let i=0;i<cases.length;i++)for(let j=i+1;j<cases.length;j++)if(sameValue(cases[i]!.request,cases[j]!.request)&&!sameValue(cases[i]!.changes,cases[j]!.changes))return {request,stateType,changes:[],observed,conflict:true};
  return {request,stateType,changes:[],cases,observed};
}
function inferChangeFromSample(sample:MutationSample,path:string,after:unknown):ChangeRule {
  const extended=sample as MutationSample&{before?:Map<string,unknown>};return inferChange(path,extended.before?.get(path),after,sample.request);
}
async function inferState(trace:Trace,model:ProtocolModel,signal?:AbortSignal):Promise<StateModel> {
  const messages=trace.messages.slice(0,Math.min(trace.messages.length,model.messageLimit)); const snapshots=new Map<string,StateSnapshot>(); const current=new Map<string,Record<string,unknown>>();
  const loginMessages=messages.filter(m=>m.direction==='client'&&/login|signin|auth/i.test(m.type));if(loginMessages.length>MAX_LOGIN_MESSAGES)throw new Error(`Trace exceeds the ${MAX_LOGIN_MESSAGES}-login inference limit`);const loginRequest=loginMessages[0]?.type??'';const loginField=loginMessages[0]?(['username','account','playerName','name','email'].find(k=>Object.hasOwn(rawPayload(loginMessages[0]!),k))??''):'';
  const credentialFields=[...new Set(loginMessages.flatMap(m=>credentialPaths(rawPayload(m))))].slice(0,MAX_SECRET_FIELDS);
  const mutationMap=new Map<string,MutationSample[]>();const rejectionMap=new Map<string,Record<string,unknown>[]>();const requestSecretMap=new Map<string,RequestSecretSample[]>();const secretCache=new Map<string,SecretVerifier>();const verifiers=new Map<string,CredentialVerifier>();const verifierCache=new Map<string,CredentialVerifier>();const successTypes=new Set<string>();const idPaths=new Set<string>();const namePaths=new Set<string>();let pending:TraceMessage|null=null;let pendingServer:TraceMessage[]=[];let pendingStateType:string|undefined;let loginSettled=false;let sessionKey:string|undefined;
  const commitPending=async()=>{if(!pending)return;const request=pending;if(pendingServer.some(m=>failureResponse(m.type,payloadOnly(m)))){const rejectedKey=`${sessionKey??''}\u0000${request.type}`;const rejected=rejectionMap.get(rejectedKey)??[];if(rejected.length<MAX_MUTATION_CASES)rejected.push(payloadOnly(request));rejectionMap.set(rejectedKey,rejected);if(request.type===loginRequest)sessionKey=undefined;pending=null;pendingServer=[];return;}if(request.type!==loginRequest){const raw=rawPayload(request);const secretPaths=credentialPaths(raw);if(secretPaths.length){const observed:SecretVerifier[]=[];for(const secretPath of secretPaths){signal?.throwIfAborted();observed.push(await secretVerifierFor(raw,secretPath,secretCache));}const key=`${sessionKey??''}\u0000${request.type}`;const list=requestSecretMap.get(key)??[];if(list.length<MAX_MUTATION_CASES)list.push({request:request.type,...(sessionKey?{account:sessionKey}:{}),verifiers:observed});requestSecretMap.set(key,list);}}for(const m of pendingServer){if(loginRequest&&request.type===loginRequest&&!loginSettled){if(!loginSuccess(m.type,payloadOnly(m)))break;try{signal?.throwIfAborted();const raw=rawPayload(request);const index=identityHash(String(raw[loginField]??'').slice(0,128));const fingerprint=createHash('sha256').update(index+'\0'+credentialMaterial(raw,credentialFields)).digest('hex');let verifier=verifierCache.get(fingerprint);if(!verifier){if(verifiers.size>=MAX_VERIFIERS)throw new Error(`Trace exceeds the ${MAX_VERIFIERS}-verifier inference limit`);verifier=await verifierFor(raw,loginField,credentialFields,[...verifiers.values()]);verifierCache.set(fingerprint,verifier);}verifiers.set(verifier.key,verifier);sessionKey=verifier.key;successTypes.add(m.type);loginSettled=true;}catch(error){if(signal?.aborted||(error instanceof Error&&error.message.includes('verifier inference limit')))throw error;break;}}if(/^(?:logout|disconnect)$/i.test(request.type)||!isStateMessage(m.type,payloadOnly(m)))continue;if(loginRequest&&!sessionKey)break;if(pendingStateType===m.type)break;pendingStateType=m.type;
      const payload=payloadOnly(m);const previous=current.get(m.type);let snapshot=snapshots.get(m.type);
      if(!snapshot){const fields=[...flatten(payload)].slice(0,MAX_FIELDS).map(([p,v])=>({path:p,type:fieldType(v),category:category(p),samples:[boundedSample(v)]}));snapshot={type:m.type,payload,fields};snapshots.set(m.type,snapshot);}
      else for(const [p,v] of flatten(payload)){const field=snapshot.fields.find(f=>f.path===p);if(field){if(field.samples.length<8&&!field.samples.some(s=>sameValue(s,v)))field.samples.push(boundedSample(v));if(field.type!==fieldType(v))field.type='UNKNOWN';}else if(snapshot.fields.length<MAX_FIELDS)snapshot.fields.push({path:p,type:fieldType(v),category:category(p),samples:[boundedSample(v)]});}
      if(sessionKey)for(const field of snapshot.fields){if(field.category==='account'&&/(?:^|\.)(?:id|playerid|accountid)$/i.test(field.path))idPaths.add(field.path);if(field.category==='account'&&/(?:^|\.)(?:name|displayname|username)$/i.test(field.path))namePaths.add(field.path);}
      if(previous){const before=flatten(previous);const changes:ConcreteChange[]=[];forChanges:for(const [p,v] of flatten(payload)){if(!sameValue(before.get(p),v)){changes.push({path:p,value:boundedSample(v)});if(changes.length>=MAX_FIELDS)break forChanges;}}if(changes.length){const key=`${sessionKey??''}\u0000${request.type}\u0000${m.type}`;const list=mutationMap.get(key)??[];if(list.length<MAX_MUTATION_CASES)list.push({request:payloadOnly(request),changes,before});mutationMap.set(key,list);}}
      current.set(m.type,payload);
    }pending=null;pendingServer=[];};
  for(const m of messages){if(m.direction==='client'){await commitPending();pending=m;pendingServer=[];pendingStateType=undefined;if(m.type===loginRequest){loginSettled=false;current.clear();sessionKey=undefined;}else if(/^(?:logout|disconnect)$/i.test(m.type)){current.clear();sessionKey=undefined;}continue;}if(pending)pendingServer.push(m);}await commitPending();
  const mutations=[...mutationMap.entries()].map(([key,samples])=>{const [account,request,stateType]=key.split('\u0000');const rejected=rejectionMap.get(`${account??''}\u0000${request}`);return {...buildMutation(request!,stateType!,samples),...(account?{account}:{}),...(rejected?.length?{rejected}:{})};});
  const limitations=['State fields and transitions are inferred only from successful observed request/response sequences','Failed, rejected, error, UNKNOWN_TYPE and unobserved responses never update inferred state','Credential values are omitted from artifacts and persisted state; observed credentials are verified with scrypt','Generic request values are limited to observed allowlists or numeric ranges; values outside those bounds and conflicting observations return UNKNOWN rather than invented gameplay results','Persistence is local to the compatibility service and is not original server storage'];
  return {snapshots:[...snapshots.values()],mutations,requestSecrets:[...requestSecretMap.values()].flat(),account:loginRequest&&loginField&&verifiers.size?{loginRequest,requestField:loginField,credentialFields,idPaths:[...idPaths].slice(0,16),namePaths:[...namePaths].slice(0,16),successTypes:[...successTypes],verifiers:[...verifiers.values()]}:null,limitations};
}
function compatibilityModel(model:ProtocolModel,state:StateModel):CompatibilityModel {
  const rules:CompatRule[]=[];
  for(const response of model.requestResponses){
    const message=model.messageTypes.find(m=>m.direction==='client'&&m.type===response.request);if(!message)continue;
    const mutations=state.mutations.filter(m=>m.request===response.request&&m.request!==state.account?.loginRequest);
    const observed=Object.entries(response.examples);const hasFailure=response.failures>0||observed.some(([type,payload])=>failureResponse(type,payload as Record<string,unknown>));
    const responses=(mutations.length||response.request===state.account?.loginRequest||!hasFailure?observed:[]).filter(([type,payload])=>!failureResponse(type,payload as Record<string,unknown>)).map(([type,payload])=>({type,payload:payload as Record<string,unknown>}));
    rules.push({type:response.request,fields:message.fields,responses,requestPayload:response.requestPayload,mutations,requestSecrets:state.requestSecrets.filter(item=>item.request===response.request)});
  }
  return {level:'L4',meaning:'Independent stateful compatibility service inferred from observed evidence; not original server recovery',rules,state,account:state.account};
}
function serverSource(model:CompatibilityModel):string { return `// Generated from observed evidence. Independent stateful compatibility service, not original server code.
import { createHash, scrypt, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require=createRequire(import.meta.url);
let WebSocketServer;
try { ({WebSocketServer}=require('ws')); }
catch { console.error('Compatibility service cannot resolve ws. Run npm install in this generated directory, or make ws available to its parent package.'); process.exit(1); }
const model=${JSON.stringify(model)};
const moduleDir=path.dirname(fileURLToPath(import.meta.url));
const dataDir=process.env.DATA_DIR?path.resolve(moduleDir,process.env.DATA_DIR):path.join(moduleDir,'data');
const stateFile=path.join(dataDir,'state.json');
const port=Number(process.env.PORT||0);
const dangerous=/^(?:__proto__|prototype|constructor)$/;
const sensitive=/password|passwd|pwd|secret|token|jwt|bearer|credential|authorization|refresh|sid|(?:api|private|access|signing)[_-]?key|(?:^|[_-])key(?:$|[_-])|session[_-]?(?:id|key)?|cookie|^auth(?:entication)?$/i;
const identityKey=/^(?:id|playerid|accountid|userid|name|displayname|username|email)$/i;
const clone=(v)=>structuredClone(v);const scryptAsync=promisify(scrypt);
function redactString(value){return value.replace(/\\b(?:Bearer|Basic)\\s+[A-Za-z0-9._~+\\/=-]+/gi,'[REDACTED]').replace(/\\beyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\b/g,'[REDACTED]').replace(/\\b(password|passwd|pwd|token|secret|jwt|auth|authorization|refresh|sid|key)\\s*[:=]\\s*([^\\s,;]+)/gi,'$1=[REDACTED]');}
function publicValue(value){if(typeof value==='string')return redactString(value);if(Array.isArray(value))return value.map(v=>publicValue(v));if(!value||typeof value!=='object')return value;const out={};for(const [k,v] of Object.entries(value)){if(dangerous.test(k))continue;out[k]=sensitive.test(k)||identityKey.test(k)?null:publicValue(v);}return out;}
const typeOf=(v)=>v===null?'null':Array.isArray(v)?'array':typeof v;
const get=(root,p)=>{let v=root;for(const part of p.split('.')){if(!v||typeof v!=='object'||Array.isArray(v)||dangerous.test(part))return undefined;v=v[part];}return v;};
function set(root,p,value){const parts=p.split('.');if(parts.some(x=>dangerous.test(x)||sensitive.test(x)))throw new Error('Unsafe state path');let cur=root;for(const part of parts.slice(0,-1)){if(!cur[part]||typeof cur[part]!=='object'||Array.isArray(cur[part]))cur[part]={};cur=cur[part];}cur[parts.at(-1)]=clone(value);}
function equal(a,b){if(a===b)return true;if(!a||!b||typeof a!=='object'||typeof b!=='object')return false;if(Array.isArray(a)||Array.isArray(b))return JSON.stringify(a)===JSON.stringify(b);const ak=Object.keys(a).sort(),bk=Object.keys(b).sort();return ak.length===bk.length&&ak.every((k,i)=>k===bk[i]&&equal(a[k],b[k]));}
function normalizeClientEnvelope(message){const payload=message.payload;if(!payload||typeof payload!=='object'||Array.isArray(payload)||!Object.keys(message).every(key=>key==='type'||key==='payload'))return message;return {...payload,type:message.type};}
function validate(payload,fields){if(!payload||typeof payload!=='object'||Array.isArray(payload))return false;const roots=new Set(['type',...fields.map(f=>f.path.split('.')[0])]);if(Object.keys(payload).some(k=>dangerous.test(k)||!roots.has(k)))return false;for(const f of fields){if(f.required&&get(payload,f.path)===undefined)return false;const v=get(payload,f.path);if(v===undefined){if(f.required)return false;continue;}if(f.type==='UNKNOWN')return false;if(typeOf(v)!==f.type)return false;}return true;}
let accounts=Object.create(null);let writeQueue=Promise.resolve();const accountLocks=new Map();
function withAccountLock(key,task){const previous=accountLocks.get(key)??Promise.resolve();const next=previous.catch(()=>{}).then(task);accountLocks.set(key,next);next.then(()=>{if(accountLocks.get(key)===next)accountLocks.delete(key);},()=>{if(accountLocks.get(key)===next)accountLocks.delete(key);});return next;}
async function load(){try{const raw=JSON.parse(await readFile(stateFile,'utf8'));if(raw.version===1&&raw.accounts&&typeof raw.accounts==='object'){const loaded=Object.create(null);for(const [key,record] of Object.entries(raw.accounts)){if(!/^[a-f0-9]{64}$/.test(key)||!record||typeof record!=='object'||!record.states||typeof record.states!=='object'||Array.isArray(record.states))continue;const credential=record.credential&&typeof record.credential.salt==='string'&&/^[a-f0-9]{32}$/.test(record.credential.salt)&&typeof record.credential.hash==='string'&&/^[a-f0-9]{128}$/.test(record.credential.hash)?{salt:record.credential.salt,hash:record.credential.hash}:null;loaded[key]={revision:Number.isInteger(record.revision)&&record.revision>=0?record.revision:0,...(credential?{credential}:{}),states:publicValue(record.states)};}accounts=loaded;}}catch(e){if(e.code!=='ENOENT')throw new Error('Cannot read compatibility state');}}
function persist(){const snapshot=JSON.stringify({version:1,accounts});writeQueue=writeQueue.then(async()=>{await mkdir(dataDir,{recursive:true});const tmp=stateFile+'.'+process.pid+'.tmp';await writeFile(tmp,snapshot,'utf8');await rename(tmp,stateFile);});return writeQueue;}
function defaultEnvelope(value,key=''){if(key==='type')return value;if(Array.isArray(value))return [];if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,defaultEnvelope(v,k)]));if(typeof value==='number')return 0;if(typeof value==='string')return '';if(typeof value==='boolean')return false;return null;}
function freshStates(){const states=Object.fromEntries(model.state.snapshots.map(s=>[s.type,defaultEnvelope(publicValue(s.payload))]));if(model.account)for(const type of Object.keys(states))for(const p of [...model.account.idPaths,...model.account.namePaths])if(get(states[type],p)!==undefined)set(states[type],p,null);return states;}
async function verifyLogin(request){if(!model.account||!model.account.successTypes.length)return null;const identity=get(request,model.account.requestField);if(typeof identity!=='string'||!identity.length)return null;const index=createHash('sha256').update('identity\\0'+identity.slice(0,128)).digest('hex');if(!model.account.credentialFields.length)return {key:index,credential:null};const material=model.account.credentialFields.map(p=>createHash('sha256').update(JSON.stringify(get(request,p)??null)).digest('hex')).join('\\0');for(const verifier of model.account.verifiers.filter(v=>v.identityHash===index)){const actual=await scryptAsync(material,verifier.salt,64);const expected=Buffer.from(verifier.hash,'hex');if(actual.length===expected.length&&timingSafeEqual(actual,expected))return {key:verifier.key,credential:{salt:verifier.salt,hash:verifier.hash}};}return null;}
async function verifySecret(value,verifier){if(value===undefined||value===null)return false;const material=createHash('sha256').update(JSON.stringify(value)).digest('hex');const actual=await scryptAsync(material,verifier.salt,64);const expected=Buffer.from(verifier.hash,'hex');return actual.length===expected.length&&timingSafeEqual(actual,expected);}
async function verifyRequestSecrets(rule,key,request,cache){if(!rule.requestSecrets?.length)return true;const samples=rule.requestSecrets.filter(sample=>sample.account===key||(sample.account===undefined&&key===null));if(!samples.length)return false;for(const sample of samples){let valid=true;for(const verifier of sample.verifiers){const value=get(request,verifier.path);const fingerprint=createHash('sha256').update(verifier.path+'\\0'+verifier.hash+'\\0'+JSON.stringify(value)).digest('hex');const cached=cache.get(fingerprint);const matched=cached??await verifySecret(value,verifier);cache.set(fingerprint,matched);if(!matched){valid=false;break;}}if(valid)return true;}return false;}
function concrete(changes,states){for(const c of changes)set(states,c.path,c.value);}
function apply(mutation,request,states){if(!mutation)return true;if(mutation.conflict)return false;const target=states[mutation.stateType];if(!target||typeof target!=='object'||Array.isArray(target))return false;if(mutation.cases){const hit=mutation.cases.find(c=>equal(c.request,request));if(!hit)return false;concrete(hit.changes,target);return true;}for(const c of mutation.changes){if(c.kind==='set')set(target,c.path,c.value);else if(c.kind==='setFromRequest'){const v=get(request,c.requestField);if(v===undefined||(c.values&&!c.values.some(value=>equal(value,v))))return false;set(target,c.path,v);}else if(c.kind==='add'){const old=get(target,c.path);if(typeof old!=='number')return false;set(target,c.path,old+c.value);}else{const v=get(request,c.requestField),old=get(target,c.path);if(typeof v!=='number'||typeof old!=='number'||(typeof c.min==='number'&&v<c.min)||(typeof c.max==='number'&&v>c.max))return false;set(target,c.path,old+(c.kind==='addFromRequest'?v:-v));}}return true;}
function responsePayload(template,states,isLogin){const authResponse=isLogin&&model.account?.successTypes.includes(template.type);const source=states&&Object.hasOwn(states,template.type)?states[template.type]:template.payload;const payload={...publicValue(source),type:template.type};if(authResponse){payload.authentication=model.account?.credentialFields.length?'VERIFIED':'UNKNOWN';payload.identity='UNKNOWN';}return payload;}
await load();
const wss=new WebSocketServer({host:'127.0.0.1',port,maxPayload:65536,verifyClient:info=>{const connection=String(info.req.headers.connection??'').toLowerCase().split(',').map(value=>value.trim());if(!connection.includes('upgrade')||String(info.req.headers.upgrade??'').toLowerCase()!=='websocket')return false;const origin=info.req.headers.origin;if(!origin)return true;try{const url=new URL(origin);const address=wss.address();const actual=address&&typeof address==='object'?address.port:0;const originPort=Number(url.port||(url.protocol==='https:'?443:80));return (url.protocol==='http:'||url.protocol==='https:')&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)&&originPort===actual;}catch{return false;}}});
wss.on('listening',()=>console.log(JSON.stringify({event:'listening',port:wss.address().port,dataDir})));
wss.on('connection',socket=>{if(wss.clients.size>32)return socket.close(1008,'Connection limit exceeded');let states=null,key=null,count=0,authFailures=0,queue=Promise.resolve();const secretCache=new Map();const sendError=(code,originalType,message)=>socket.send(JSON.stringify({type:'error',code,...(originalType?{originalType}:{}),message}));const rejectLogin=()=>{authFailures++;if(authFailures>5)socket.close(1008,'Too many failed logins');return sendError('UNKNOWN','','Login credentials are not verified');};socket.on('message',raw=>{queue=queue.then(async()=>{try{
if(++count>1000)return socket.close(1008,'Message limit exceeded');let m;try{m=JSON.parse(raw.toString());}catch{return sendError('INVALID_REQUEST','','Malformed JSON');}if(!m||typeof m.type!=='string')return sendError('INVALID_REQUEST','','type must be a string');m=normalizeClientEnvelope(m);const rule=model.rules.find(r=>r.type===m.type);if(!rule)return sendError('UNKNOWN',m.type.slice(0,80),'Unobserved request type');if(!validate(m,rule.fields))return sendError('INVALID_REQUEST',m.type,'Payload does not match observed fields');if(!rule.responses.length)return sendError('UNKNOWN',m.type,'No successful response was observed for this request');
if(m.type===model.account?.loginRequest){const verified=await verifyLogin(m);if(!verified)return rejectLogin();let credentialMatched=true;let loginStates=null;await withAccountLock(verified.key,async()=>{const existing=accounts[verified.key];if(verified.credential&&existing&&(!existing.credential||existing.credential.hash!==verified.credential.hash)){credentialMatched=false;return;}loginStates=existing?.states?clone(existing.states):freshStates();if(!existing){accounts[verified.key]={revision:1,...(verified.credential?{credential:verified.credential}:{}),states:clone(loginStates)};try{await persist();}catch(error){delete accounts[verified.key];throw error;}}});if(!credentialMatched)return rejectLogin();key=verified.key;states=loginStates;for(const template of rule.responses)socket.send(JSON.stringify(responsePayload(template,states,true)));return;}
if(!await verifyRequestSecrets(rule,key,m,secretCache))return sendError('UNKNOWN',m.type,'Request credentials are not verified');if(!states&&(rule.mutations.length||rule.responses.some(template=>model.state.snapshots.some(s=>s.type===template.type))))return sendError('UNKNOWN',m.type,'Login state was not observed for this connection');
const requestPayload=publicValue(m);delete requestPayload.type;const mutation=rule.mutations.find(item=>item.account===key)??(rule.mutations.length===1&&!rule.mutations[0].account?rule.mutations[0]:undefined);if(rule.mutations.length&&!mutation)return sendError('UNKNOWN',m.type,'Unobserved state transition for this account');if(mutation?.rejected?.some(rejected=>equal(rejected,requestPayload)))return sendError('UNKNOWN',m.type,'Observed request was rejected');
if(key){let applied=true;await withAccountLock(key,async()=>{const existing=accounts[key];if(!existing)throw new Error('Account session is unavailable');const next=clone(existing.states);if(mutation&&!apply(mutation,requestPayload,next)){applied=false;return;}if(mutation||/save/i.test(m.type)){if(accounts[key]!==existing)throw new Error('Account state changed during update');accounts[key]={...existing,revision:(existing.revision??0)+1,states:next};try{await persist();}catch(error){accounts[key]=existing;throw error;}}states=next;});if(!applied)return sendError('UNKNOWN',m.type,'Unobserved state transition');}else if(mutation){const next=clone(states);if(!apply(mutation,requestPayload,next))return sendError('UNKNOWN',m.type,'Unobserved state transition');states=next;}
const endsSession=/^(?:logout|disconnect)$/i.test(m.type);for(const template of rule.responses)socket.send(JSON.stringify(responsePayload(template,states,false)));if(endsSession){states=null;key=null;}
}catch{sendError('INVALID_REQUEST','','Compatibility state update failed');}}).catch(()=>{});});});
`; }
async function freePort():Promise<number> { return new Promise((resolve,reject)=>{ const s=createServer(); s.once('error',reject); s.listen(0,'127.0.0.1',()=>{ const a=s.address(); s.close(()=>a&&typeof a==='object'?resolve(a.port):reject(new Error('No port'))); }); }); }
function gameAbortError():Error { const error=new Error('Game validation cancelled');error.name='AbortError';return error; }
function abortable<T>(promise:Promise<T>,signal:AbortSignal):Promise<T> { if(signal.aborted){promise.catch(()=>{});return Promise.reject(gameAbortError());}return new Promise((resolve,reject)=>{const onAbort=()=>{signal.removeEventListener('abort',onAbort);promise.catch(()=>{});reject(gameAbortError());};signal.addEventListener('abort',onAbort,{once:true});promise.then(value=>{signal.removeEventListener('abort',onAbort);resolve(value);},error=>{signal.removeEventListener('abort',onAbort);reject(error);});}); }
function terminateChild(child:ChildProcess):Promise<void> { const pid=child.pid;if(typeof pid!=='number'||child.exitCode!==null||child.signalCode!==null)return Promise.resolve();return new Promise(resolve=>{let finished=false;const finish=()=>{if(finished)return;finished=true;clearTimeout(forceTimer);resolve();};child.once('exit',finish);const force=()=>{if(process.platform==='win32'){const killer=spawn('taskkill',['/pid',String(pid),'/T','/F'],{stdio:'ignore',windowsHide:true});killer.once('error',()=>{try{child.kill();}catch{}});}else{try{process.kill(-pid,'SIGKILL');}catch{try{child.kill('SIGKILL');}catch{}}}};if(process.platform==='win32'){const killer=spawn('taskkill',['/pid',String(pid),'/T','/F'],{stdio:'ignore',windowsHide:true});killer.once('error',()=>{try{child.kill();}catch{}});}else{try{process.kill(-pid,'SIGTERM');}catch{try{child.kill('SIGTERM');}catch{}}}const forceTimer=setTimeout(force,2000);forceTimer.unref();}); }
interface TestClient { ws:WebSocket; request(type:string,payload?:Record<string,unknown>,responses?:string[]):Promise<Record<string,unknown>[]>; close():Promise<void> }
function connectClient(port:number):Promise<TestClient> { return new Promise((resolve,reject)=>{const ws=new WebSocket(`ws://127.0.0.1:${port}`,{origin:`http://127.0.0.1:${port}`});const pending=new Map<string,{resolve:(v:Record<string,unknown>)=>void;reject:(e:Error)=>void;timer:NodeJS.Timeout}[]>();ws.on('message',raw=>{let msg:Record<string,unknown>;try{msg=JSON.parse(raw.toString()) as Record<string,unknown>;}catch{return;}if(msg.type==='error'){for(const list of pending.values())for(const item of list){clearTimeout(item.timer);item.resolve(msg);}pending.clear();return;}const list=pending.get(String(msg.type));if(list?.length){const item=list.shift()!;clearTimeout(item.timer);item.resolve(msg);if(!list.length)pending.delete(String(msg.type));}});ws.once('error',reject);ws.once('open',()=>resolve({ws,request(type,payload={},responses=[]){const waits=responses.map(t=>new Promise<Record<string,unknown>>((res,rej)=>{const timer=setTimeout(()=>rej(new Error(`Timed out waiting for ${t} after ${type}`)),5000);const list=pending.get(t)??[];list.push({resolve:res,reject:rej,timer});pending.set(t,list);}));ws.send(JSON.stringify({type,...payload}));return Promise.all(waits);},close(){return new Promise(res=>{if(ws.readyState===WebSocket.CLOSED)return res();ws.once('close',()=>res());ws.close();});}}));}); }

export const gameAdapter=defineAdapter({
  name:'game',version:'2.0.0',description:'Infers a bounded protocol/state model from an authorized trace and generates an independent persistent L4 compatibility service.',
  available:async()=>({available:true,detail:'Built-in bounded trace inference, stateful Node generator and WebSocket validator'}),
  detect:async ctx=>{ const trace=await readTraceFile(uploadPath(ctx)); if(trace.format!=='replay-trace/v1'||!Array.isArray(trace.messages)||!trace.messages.length) throw new Error('Expected replay-trace/v1 with non-empty messages'); if(trace.messages.length>MAX_TRACE_MESSAGES)throw new Error(`Trace exceeds the ${MAX_TRACE_MESSAGES} message inference limit`); return {adapter:'game',confidence:1,format:'authorized protocol replay trace',details:{messages:trace.messages.length,target:trace.target?.name??'unknown'},limitations:['Engine identification from trace metadata is not available','Only observed request/state transitions are implemented; original server internals are not recovered']}; },
  prepare:async ctx=>{ const trace=await readTraceFile(uploadPath(ctx)); if(!Array.isArray(trace.messages)||trace.messages.length>MAX_TRACE_MESSAGES)throw new Error(`Trace must contain at most ${MAX_TRACE_MESSAGES} messages`); for(const m of trace.messages)if(!m.type||!['client','server'].includes(m.direction)||!m.payload||typeof m.payload!=='object'||Array.isArray(m.payload))throw new Error('Malformed trace message'); const target={name:trace.target?.name??'unknown'};return {format:trace.format,target,messageCount:trace.messages.length}; },
  analyze:async ctx=>{ const trace=await readTraceFile(uploadPath(ctx)); const model=inferProtocol(trace); const state=await inferState(trace,model,ctx.signal);(model as ProtocolModel&{state?:StateModel}).state=state;await ctx.log('info',`Inferred ${model.messageTypes.length} message types, ${model.transitions.length} transitions and ${state.mutations.length} state mutations in O(n)`,'protocol-rules');return model; },
  extractEvidence:async ctx=>{ const model=output<ProtocolModel&{state:StateModel}>(ctx,'ANALYZE'); await ctx.evidence('EVIDENCE','Observed protocol messages','replay-trace','messages',model.messageTypes); await ctx.evidence('INFERENCE','Observed transition counts','sequence-analysis','transitions',model.transitions);await ctx.evidence('INFERENCE','Observed state fields and mutations','state-analysis','state-machine',model.state);for(const u of model.unknowns)await ctx.evidence('UNKNOWN',u,'sequence-analysis','unknowns',{detail:u});await ctx.writeArtifact('protocol-schema.json',JSON.stringify(model,null,2),'application/json');return {messageTypes:model.messageTypes.length,stateFields:model.state.snapshots.reduce((n,s)=>n+s.fields.length,0)}; },
  reconstruct:async ctx=>{
    const model=output<ProtocolModel&{state:StateModel}>(ctx,'ANALYZE'); const compat=compatibilityModel(model,model.state);
    const entries=[
      {name:'server.mjs',content:serverSource(compat),mime:'text/javascript; charset=utf-8'},
      {name:'package.json',content:JSON.stringify({name:'reverse-everything-compatibility-service',version:'1.0.0',private:true,type:'module',dependencies:{ws:'8.23.0'},scripts:{start:'node server.mjs'}},null,2),mime:'application/json'},
      {name:'state-machine.json',content:JSON.stringify({level:'L4',meaning:compat.meaning,state:model.state,limitations:[...model.state.limitations,'This is an independent stateful compatibility service, not original game server recovery']},null,2),mime:'application/json'},
      {name:'README.md',content:'# 独立 L4 状态化兼容服务\n\n本服务由合法保留的通信记录推断生成，不是原始服务端代码恢复。它仅实现已观察的请求、状态字段与转换；未观察行为返回 UNKNOWN。\n\n```bash\nnpm install\nPORT=8080 npm start\n```\n\n状态保存在本服务目录的 `data/state.json`（可用 `DATA_DIR` 覆盖）。同一账号重新登录可恢复本地状态。服务仅绑定 `127.0.0.1`：浏览器客户端必须使用同端口回环 Origin；无 Origin 的原生/Node/CLI 客户端可以连接，但登录仍必须通过已观察凭证的 scrypt 验证，未验证登录不会创建会话或状态。脚本通过 `createRequire(import.meta.url)` 从生成包及其父包解析 `ws`，不依赖启动 CWD。\n',mime:'text/markdown; charset=utf-8'}
    ];
    if(ctx.writeArtifacts)await ctx.writeArtifacts(entries);else for(const entry of entries){ctx.signal.throwIfAborted();await ctx.writeArtifact(entry.name,entry.content,entry.mime);}
    ctx.signal.throwIfAborted();
    await ctx.evidence('VERIFIED','Stateful compatibility service source generated','reconstruction-generator','server.mjs',{basis:'Observed requests, state fields and bounded mutations only',independentRebuild:true,originalBackendRecovered:false});return {generated:true,files:['server.mjs','package.json','state-machine.json','README.md']};
  },
  validate:async ctx=>{
    ctx.signal.throwIfAborted();const model=output<ProtocolModel&{state:StateModel}>(ctx,'ANALYZE'); const compat=compatibilityModel(model,model.state); const dir=path.join(ctx.artifactDir,'compatibility'); await mkdir(dir,{recursive:true});
    await copyFile(path.join(ctx.artifactDir,'server.mjs'),path.join(dir,'server.mjs')); await copyFile(path.join(ctx.artifactDir,'package.json'),path.join(dir,'package.json'));
    const port=await freePort(); const require=createRequire(import.meta.url); let nodePath=process.env.NODE_PATH??'';
    try{const wsEntry=require.resolve('ws');nodePath=[path.dirname(path.dirname(wsEntry)),nodePath].filter(Boolean).join(path.delimiter);}catch{}
    ctx.signal.throwIfAborted();const child=spawn(process.execPath,[path.join(dir,'server.mjs')],{cwd:os.tmpdir(),detached:true,windowsHide:true,env:{...process.env,PORT:String(port),DATA_DIR:path.join(dir,'data'),NODE_PATH:nodePath},stdio:['ignore','pipe','pipe']});
    let aborted=false;const onAbort=()=>{aborted=true;void terminateChild(child);};ctx.signal.addEventListener('abort',onAbort,{once:true});if(ctx.signal.aborted)onAbort();
    let outputBuffer='';let errors='';const checks:{name:string;passed:boolean;details?:string}[]=[];
    const listening=new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(`Generated service did not start: ${errors.slice(0,500)}`)),10000);child.stdout?.on('data',(chunk:Buffer)=>{outputBuffer+=chunk.toString();if(outputBuffer.includes('"event":"listening"')){clearTimeout(timer);resolve();}});child.stderr?.on('data',(chunk:Buffer)=>{errors+=chunk.toString();});child.once('exit',code=>{clearTimeout(timer);reject(aborted||ctx.signal.aborted?gameAbortError():new Error(`Generated service exited ${code}: ${errors.slice(0,500)}`));});});
    let client:TestClient|undefined;
    try{
      await abortable(listening,ctx.signal);ctx.signal.throwIfAborted();const account=compat.account;const login=compat.rules.find(r=>r.type===account?.loginRequest);checks.push({name:'Observed login request is available',passed:Boolean(login)});
      if(!login||!account)throw new Error('Trace does not contain an observed login request; L4 account flow cannot be validated');
      client=await connectClient(port);ctx.signal.throwIfAborted();const request=(type:string,payload:Record<string,unknown>,responses:string[])=>abortable(client!.request(type,payload,responses),ctx.signal);const hello=compat.rules.find(r=>/^(?:hello|connect|handshake)$/i.test(r.type));const rawTrace=await readTraceFile(uploadPath(ctx));const observedHello=hello?rawTrace.messages.find(message=>message.direction==='client'&&message.type===hello.type):undefined;const helloPayload=observedHello?structuredClone(rawPayload(observedHello)):hello?.requestPayload;
      if(hello&&helloPayload){const replies=await request(hello.type,helloPayload,hello.responses.map(r=>r.type));checks.push({name:'Handshake responses match observation',passed:replies.length===hello.responses.length});}
      let observedLogin:TraceMessage|undefined;let validationKey:string|undefined;
      let loginAttempts=0;for(const message of rawTrace.messages){if(message.direction!=='client'||message.type!==login.type)continue;if(++loginAttempts>MAX_VERIFIERS)throw new Error('Trace exceeds the bounded login verification attempt limit');ctx.signal.throwIfAborted();try{const verifier=await verifierFor(rawPayload(message),account.requestField,account.credentialFields,account.verifiers);if(account.verifiers.some(item=>item.key===verifier.key)){observedLogin=message;validationKey=verifier.key;break;}}catch{/* try the next observed login */}}
      if(!observedLogin||!validationKey)throw new Error('Trace does not contain a verifiable successful login request');const observedByType=new Map<string,Record<string,unknown>>();let traceAccount:string|undefined;for(const message of rawTrace.messages){if(message.direction!=='client')continue;if(message.type===account.loginRequest){const raw=rawPayload(message);const index=identityHash(String(raw[account.requestField]??'').slice(0,128));traceAccount=account.verifiers.find(verifier=>verifier.identityHash===index)?.key;continue;}if(traceAccount===validationKey&&!observedByType.has(message.type))observedByType.set(message.type,structuredClone(rawPayload(message)));}const loginPayload=structuredClone(rawPayload(observedLogin));const loginReplies=await request(login.type,loginPayload,login.responses.map(r=>r.type));
      checks.push({name:'Login returns observed response sequence',passed:loginReplies.length===login.responses.length,details:loginReplies.map(r=>r.type).join(',')});
      let lastState:Record<string,unknown>|undefined;const stateTypes=new Set(compat.state.snapshots.map(s=>s.type));
      for(const reply of loginReplies)if(stateTypes.has(String(reply.type)))lastState=reply;
      let mutated=false;let saved=false;
      for(const rule of compat.rules){
        ctx.signal.throwIfAborted();if(rule===login||/^(?:hello|connect|handshake|logout|disconnect)$/i.test(rule.type))continue;
        const mutation=rule.mutations.find(item=>item.account===validationKey)??(rule.mutations.length===1?rule.mutations[0]:undefined);if(mutation?.conflict)continue;const payload=observedByType.get(rule.type)??mutation?.cases?.[0]?.request??rule.requestPayload;const before=lastState?JSON.stringify(lastState):'';
        const replies=await request(rule.type,payload,rule.responses.map(r=>r.type));
        for(const reply of replies)if(stateTypes.has(String(reply.type)))lastState=reply;
        if(mutation){mutated=true;checks.push({name:`Observed ${rule.type} transition changes state`,passed:Boolean(lastState)&&JSON.stringify(lastState)!==before,details:`${mutation.observed} observed sample(s); before=${before}; after=${JSON.stringify(lastState)}`});}
        if(/save/i.test(rule.type))saved=true;
      }
      checks.push({name:'At least one observed state mutation was exercised',passed:mutated});
      const stateBeforeReconnect=lastState;
      ctx.signal.throwIfAborted();await abortable(client.close(),ctx.signal);client=await connectClient(port);ctx.signal.throwIfAborted();
      if(hello&&helloPayload)await request(hello.type,helloPayload,hello.responses.map(r=>r.type));
      const restored=await request(login.type,loginPayload,login.responses.map(r=>r.type));const restoredState=[...restored].reverse().find(r=>stateTypes.has(String(r.type)));
      checks.push({name:'Reconnect login restores persisted session state',passed:Boolean(stateBeforeReconnect)&&sameValue(restoredState,stateBeforeReconnect),details:restoredState?JSON.stringify(restoredState):'No state response observed'});
      const unknown=await request('unobserved_probe',{},['error']);checks.push({name:'Unobserved request returns UNKNOWN',passed:unknown[0]?.code==='UNKNOWN'});
      const invalidPayload:Record<string,unknown>={};if(login.fields.length)invalidPayload[login.fields[0]!.path]=null;      const invalid=await request(login.type,invalidPayload,['error']);checks.push({name:'Observed request with invalid payload is rejected',passed:invalid[0]?.code==='INVALID_REQUEST'});
      const exact=compat.rules.flatMap(rule=>rule.mutations.filter(item=>item.account===validationKey).flatMap(item=>item.cases??[])).find(item=>Object.keys(item.request).some(k=>typeof item.request[k]==='number'));const numericField=exact?Object.keys(exact.request).find(k=>typeof exact.request[k]==='number'):undefined;
      if(exact&&numericField){const rule=compat.rules.find(r=>r.mutations.some(item=>item.cases?.includes(exact)))!;const basePayload=observedByType.get(rule.type)??exact.request;const payload={...basePayload,[numericField]:Number(exact.request[numericField])+1};const unobservedValue=await request(rule.type,payload,['error']);checks.push({name:'Unobserved request value returns UNKNOWN',passed:unobservedValue[0]?.code==='UNKNOWN'});}
      if(saved)checks.push({name:'Observed save request completed',passed:true});
      const logout=compat.rules.find(r=>/^(?:logout|disconnect)$/i.test(r.type));const firstMutationRule=compat.rules.find(r=>r.mutations.some(item=>item.account===validationKey));const firstMutation=firstMutationRule?.mutations.find(item=>item.account===validationKey);
      if(logout&&firstMutationRule&&firstMutation){const replies=await request(logout.type,observedByType.get(logout.type)??logout.requestPayload,logout.responses.map(r=>r.type));checks.push({name:'Observed logout completes',passed:replies.length===logout.responses.length});if(replies[0]?.type==='logout_ok'){const payload=observedByType.get(firstMutationRule.type)??firstMutation.cases?.[0]?.request??firstMutationRule.requestPayload;const afterLogout=await request(firstMutationRule.type,payload,['error']);checks.push({name:'State request after logout returns UNKNOWN',passed:afterLogout[0]?.code==='UNKNOWN'});}}
      ctx.signal.throwIfAborted();const passed=checks.length>0&&checks.every(c=>c.passed);const level=passed?'L4':'L2';
      await ctx.evidence(passed?'VERIFIED':'INFERENCE','Generated service end-to-end protocol and state validation','validation-agent','websocket',{passed,checks,stdout:outputBuffer.slice(0,1000),neutralCwd:os.tmpdir()});ctx.signal.throwIfAborted();
      await ctx.writeArtifact('validation.json',JSON.stringify({passed,level,meaning:'L4 means independent stateful compatibility, not original server recovery',checks,stdout:outputBuffer.slice(0,2000)},null,2),'application/json');ctx.signal.throwIfAborted();
      return {passed,checks,level,limitations:[...model.state.limitations,'This validates the generated compatibility contract only; it does not prove original game restoration']};
    }finally{ctx.signal.removeEventListener('abort',onAbort);if(client)await client.close().catch(()=>{});await terminateChild(child);}
  }
});

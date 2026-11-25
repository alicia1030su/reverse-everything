import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { TaskContext } from '../../packages/workflow/src/types.js';
import { gameAdapter } from '../../packages/core/src/adapters/game.js';

const PROPERTY_SEED=0x5eed004;
const PROPERTY_CASES=12;
type JsonValue=null|boolean|number|string|JsonValue[]|{[key:string]:JsonValue};
interface TraceMessage {seq:number;at:string;direction:'client'|'server';type:string;payload:Record<string,unknown>}
interface GeneratedClient {request(type:string,payload?:Record<string,unknown>,responses?:string[]):Promise<Record<string,unknown>[]>;close():Promise<void>}
interface GeneratedService {connect():Promise<GeneratedClient>;close():Promise<void>;readonly dataFile:string;readonly stdout:string}

const dirs:string[]=[];const services:GeneratedService[]=[];
afterEach(async()=>{for(const service of services.splice(0))await service.close();for(const dir of dirs.splice(0))await rm(dir,{recursive:true,force:true});});

function randomSource(seed:number):()=>number{
  let state=seed>>>0;
  return ()=>{state=(state+0x6d2b79f5)>>>0;let value=state;value=Math.imul(value^(value>>>15),value|1);value^=value+Math.imul(value^(value>>>7),value|61);return ((value^(value>>>14))>>>0)/4294967296;};
}
function randomShortString(random:()=>number):string{
  const alphabet='abcdefghijklmnopqrstuvwxyz';let value='q';
  for(let index=0;index<3+Math.floor(random()*3);index++)value+=alphabet[Math.floor(random()*alphabet.length)];
  return value;
}
function proofFor(seed:number,index:number):JsonValue{
  const random=randomSource((seed^Math.imul(index+1,0x9e3779b1))>>>0);
  switch(index%4){
    case 0:return randomShortString(random);
    case 1:return 1000+Math.floor(random()*9000);
    case 2:return random()>=0.5;
    default:return {z:{enabled:random()>=0.5},a:[randomShortString(random),{nonce:`nonce-${seed}-${index}`}],label:'container-label'};
  }
}
function canonical(value:JsonValue):string{
  if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;
  if(value&&typeof value==='object')return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key]!)}`).join(',')}}`;
  return JSON.stringify(value);
}
function encodedAliases(proof:JsonValue):string[]{
  const container=proof!==null&&typeof proof==='object';const originals=container?[...new Set([JSON.stringify(proof),canonical(proof)])]:[String(proof)];const aliases:string[]=[];
  for(const original of originals){
    const base64url=Buffer.from(original).toString('base64url');
    aliases.push(original,Buffer.from(original).toString('base64'),base64url,base64url+'='.repeat((4-base64url.length%4)%4),Buffer.from(original).toString('hex'),Buffer.from(original).toString('hex').toUpperCase(),encodeURIComponent(original));
  }
  return [...new Set(aliases)];
}
function generatedCases(seed:number):{proof:JsonValue;aliases:string[];forbidden:string[]}[]{
  return Array.from({length:PROPERTY_CASES},(_,index)=>{
    const proof=proofFor(seed,index);const aliases=encodedAliases(proof);const forbidden=new Set<string>();
    if(typeof proof==='string')forbidden.add(proof);
    for(const alias of aliases){
      if(alias.length>=8)forbidden.add(alias);
      forbidden.add(`prefix-${alias}-suffix`);
    }
    return {proof,aliases,forbidden:[...forbidden]};
  });
}
function message(seq:number,direction:'client'|'server',type:string,payload:Record<string,unknown>):TraceMessage{return {seq,at:new Date(seq*1000).toISOString(),direction,type,payload};}
function propertyTrace(proof:JsonValue,aliases:string[]){
  const echoes:Record<string,unknown>={proof};
  aliases.forEach((alias,index)=>{echoes[`echo${index}`]=`prefix-${alias}-suffix`;});
  echoes.nested={observed:aliases.map(alias=>({encoded:alias,list:[alias]}))};
  const state=(x:number)=>({type:'player_state',id:'p-1',name:'tester',position:{x,y:0},inventory:['map'],xp:x*10,savedAt:null,...echoes});
  return {format:'replay-trace/v1',target:{name:'seeded property fixture'},messages:[
    message(1,'client','hello',{protocol:1}),message(2,'server','welcome',{type:'welcome',protocol:1}),
    message(3,'client','login',{username:'tester',proof}),message(4,'server','login_ok',{type:'login_ok',playerId:'p-1',displayName:'tester',...echoes}),message(5,'server','player_state',state(0)),
    message(6,'client','move',{dx:1}),message(7,'server','player_state',state(1)),
    message(8,'client','logout',{}),message(9,'server','logout_ok',{type:'logout_ok'})
  ]};
}
async function context(artifactDir:string):Promise<TaskContext & {artifactDir:string;evidenceRecords:unknown[]}>{
  await mkdir(artifactDir,{recursive:true});const evidenceRecords:unknown[]=[];
  return {taskId:'game-properties',project:{id:'p1',name:'fixture',kind:'game',target:'',authorizationConfirmed:true,createdAt:new Date().toISOString()},options:{},stageOutputs:{},artifactDir,dataDir:artifactDir,evidenceRecords,signal:new AbortController().signal,log:async()=>{},evidence:async(...args)=>{evidenceRecords.push(args);return 'evidence-1';},finding:async()=> 'finding-1',writeArtifact:async(name,content)=>{await writeFile(path.join(artifactDir,name),content);},readArtifact:async name=>readFile(path.join(artifactDir,name))};
}
async function reconstruct(proof:JsonValue,aliases:string[]){
  const dataDir=await mkdtemp(path.join(os.tmpdir(),'re-game-properties-'));dirs.push(dataDir);const artifactDir=path.join(dataDir,'artifacts');const uploadDir=path.join(dataDir,'uploads','project');await mkdir(uploadDir,{recursive:true});await mkdir(artifactDir,{recursive:true});await writeFile(path.join(uploadDir,'trace.json'),JSON.stringify(propertyTrace(proof,aliases)));const ctx=await context(artifactDir);ctx.dataDir=dataDir;ctx.upload={id:'u1',projectId:'project',name:'trace.json',storedName:'trace.json',mime:'application/json',size:1,sha256:'x',createdAt:new Date().toISOString()};ctx.stageOutputs.PREPARE=await gameAdapter.prepare(ctx);ctx.stageOutputs.ANALYZE=await gameAdapter.analyze(ctx);await gameAdapter.extractEvidence(ctx);await gameAdapter.reconstruct(ctx);return ctx;
}
function assertAbsent(surfaces:string[],forbidden:string[],proof:JsonValue):void{
  const values=[...forbidden];if(typeof proof==='boolean')values.push(`"proof":${proof}`);
  for(const value of values)for(const surface of surfaces)expect(surface,`Leaked ${JSON.stringify(value)}`).not.toContain(value);
}
async function freePort():Promise<number>{return new Promise((resolve,reject)=>{const server=createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const address=server.address();server.close(()=>address&&typeof address==='object'?resolve(address.port):reject(new Error('No game property port')));});});}
async function startService(artifactDir:string):Promise<GeneratedService>{
  const port=await freePort();const dataDir=path.join(artifactDir,'property-data');const require=createRequire(import.meta.url);let nodePath=process.env.NODE_PATH??'';try{nodePath=[path.dirname(path.dirname(require.resolve('ws'))),nodePath].filter(Boolean).join(path.delimiter);}catch{}
  const child=spawn(process.execPath,[path.join(artifactDir,'server.mjs')],{cwd:os.tmpdir(),env:{...process.env,PORT:String(port),DATA_DIR:dataDir,NODE_PATH:nodePath},stdio:['ignore','pipe','pipe']});let output='';let errors='';child.stdout?.on('data',(chunk:Buffer)=>{output+=chunk.toString();});child.stderr?.on('data',(chunk:Buffer)=>{errors+=chunk.toString();});
  await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(`Property service did not start: ${errors}`)),5000);child.stdout?.on('data',()=>{if(output.includes('"event":"listening"')){clearTimeout(timer);resolve();}});child.once('exit',code=>{clearTimeout(timer);reject(new Error(`Property service exited ${code}: ${errors}`));});});
  const sockets=new Set<WebSocket>();let closed=false;
  const service:GeneratedService={dataFile:path.join(dataDir,'state.json'),get stdout(){return output+errors;},async connect(){const ws=new WebSocket(`ws://127.0.0.1:${port}`,{origin:`http://127.0.0.1:${port}`});sockets.add(ws);const pending=new Map<string,{resolve:(value:Record<string,unknown>)=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout}[]>();ws.on('message',raw=>{const reply=JSON.parse(raw.toString()) as Record<string,unknown>;if(reply.type==='error'){for(const list of pending.values())for(const item of list){clearTimeout(item.timer);item.resolve(reply);}pending.clear();return;}const list=pending.get(String(reply.type));const item=list?.shift();if(item){clearTimeout(item.timer);item.resolve(reply);if(!list?.length)pending.delete(String(reply.type));}});await new Promise<void>((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});return {async request(type,payload={},responses=[]){const waits=responses.map(response=>new Promise<Record<string,unknown>>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(`Timed out waiting for ${response}`)),3000);const list=pending.get(response)??[];list.push({resolve,reject,timer});pending.set(response,list);}));ws.send(JSON.stringify({type,...payload}));return Promise.all(waits);},async close(){if(ws.readyState===WebSocket.CLOSED)return;await new Promise<void>(resolve=>{ws.once('close',()=>resolve());ws.close();})}};},async close(){if(closed)return;closed=true;for(const ws of sockets)if(ws.readyState!==WebSocket.CLOSED)ws.close();child.kill();await new Promise<void>(resolve=>{if(child.exitCode!==null)resolve();else child.once('exit',()=>resolve());});}};
  services.push(service);return service;
}

describe('deterministic game credential properties',()=>{
  it('reproduces the same nested primitive and container corpus from the published seed',()=>{
    const first=generatedCases(PROPERTY_SEED);const second=generatedCases(PROPERTY_SEED);const other=generatedCases(PROPERTY_SEED+1);
    expect(first).toEqual(second);expect(first).not.toEqual(other);expect(first).toHaveLength(PROPERTY_CASES);
    expect(first.map(item=>typeof item.proof)).toEqual(expect.arrayContaining(['string','number','boolean','object']));
    expect(first.filter(item=>item.proof&&typeof item.proof==='object').every(item=>JSON.stringify(item.proof)!==canonical(item.proof as JsonValue))).toBe(true);
  });
  it.each(Array.from({length:PROPERTY_CASES},(_,index)=>index))('redacts original, canonical and encoded aliases on every surface for seed %#',async index=>{
    const {proof,forbidden}=generatedCases(PROPERTY_SEED)[index]!;const aliases=encodedAliases(proof);const ctx=await reconstruct(proof,aliases);
    const artifacts=await Promise.all(['server.mjs','protocol-schema.json','state-machine.json'].map(name=>readFile(path.join(ctx.artifactDir,name),'utf8')));const staticSurfaces=[JSON.stringify(ctx.stageOutputs),JSON.stringify(ctx.evidenceRecords),...artifacts];assertAbsent(staticSurfaces,forbidden,proof);
    const validation=await gameAdapter.validate(ctx) as {passed:boolean;checks:{name:string;passed:boolean;details?:string}[]};expect(validation.passed,JSON.stringify(validation.checks)).toBe(true);assertAbsent([...staticSurfaces,JSON.stringify(validation),await readFile(path.join(ctx.artifactDir,'validation.json'),'utf8')],forbidden,proof);
    const service=await startService(ctx.artifactDir);const client=await service.connect();const replies=await client.request('login',{username:'tester',proof},['login_ok','player_state']);const persisted=await readFile(service.dataFile,'utf8');assertAbsent([JSON.stringify(replies),persisted,service.stdout],forbidden,proof);expect(replies.map(reply=>reply.type)).toEqual(['login_ok','player_state']);await client.close();
  });
});

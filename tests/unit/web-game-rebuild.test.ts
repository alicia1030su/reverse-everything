import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TaskContext } from '../../packages/workflow/src/types.js';

const playwrightMocks=vi.hoisted(()=>({launchServer:vi.fn(),connect:vi.fn()}));
vi.mock('playwright',()=>({chromium:{launchServer:playwrightMocks.launchServer,connect:playwrightMocks.connect,executablePath:()=>''}}));

import { websiteAdapter } from '../../packages/core/src/adapters/website.js';
import { gameAdapter, inferProtocol } from '../../packages/core/src/adapters/game.js';

const dirs:string[]=[];const servers:Server[]=[];
afterEach(async()=>{for(const server of servers.splice(0))await new Promise<void>(resolve=>server.close(()=>resolve()));for(const dir of dirs.splice(0))await rm(dir,{recursive:true,force:true});playwrightMocks.launchServer.mockReset();playwrightMocks.connect.mockReset();});
async function tempDir(prefix:string){const dir=await mkdtemp(path.join(os.tmpdir(),prefix));dirs.push(dir);return dir;}
async function context(artifactDir:string,options:Record<string,unknown>={},target='http://127.0.0.1:3100/'):Promise<TaskContext>{await mkdir(artifactDir,{recursive:true});return {taskId:'test-task',project:{id:'p1',name:'fixture',kind:'website',target,authorizationConfirmed:true,createdAt:new Date().toISOString()},options,stageOutputs:{},artifactDir,dataDir:artifactDir,signal:new AbortController().signal,log:async()=>{},evidence:async()=> 'evidence-1',finding:async()=> 'finding-1',writeArtifact:async(name,content)=>{await writeFile(path.join(artifactDir,name),content);}};}
async function listen(server:Server):Promise<string>{await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));servers.push(server);const address=server.address();if(!address||typeof address==='string')throw new Error('No test server address');return `http://127.0.0.1:${address.port}`;}

interface FakeDom {title:string;text:string;scripts:string[];stylesheets:string[];links:{href:string;text:string}[];forms:{method:string;action:string;fields:string[];getUrl?:string}[];buttons:string[];explicitButtons:{label:string;url:string}[]}
function fakeBrowser(domFor:(url:string)=>FakeDom,requestsFor:(url:string)=>number,onGoto?:()=>Promise<void>){
  const listeners=new Map<string,((value:never)=>void)[]>();let routeHandler:((route:unknown)=>Promise<void>)|undefined;let current='';const contextClose=vi.fn(async()=>{});const browserClose=vi.fn(async()=>{});
  const page={setDefaultTimeout:vi.fn(),setDefaultNavigationTimeout:vi.fn(),route:vi.fn(async(_pattern:string,handler:(route:unknown)=>Promise<void>)=>{routeHandler=handler;}),routeWebSocket:vi.fn(async()=>{}),on:vi.fn((event:string,handler:(value:never)=>void)=>{listeners.set(event,[...(listeners.get(event)??[]),handler]);}),goto:vi.fn(async(url:string)=>{current=url;if(onGoto)await onGoto();for(let i=0;i<requestsFor(url);i++){const requestUrl=`${new URL(url).origin}/asset-${i}.js`;const request={url:()=>requestUrl,method:()=> 'GET',resourceType:()=> 'script'};await routeHandler?.({request:()=>request,continue:async()=>{},abort:vi.fn()});}for(const handler of listeners.get('response')??[])handler({status:200,request:()=>({url:()=>url}),headers:()=>({'content-length':'100'})} as never);return {status:200};}),waitForTimeout:vi.fn(async()=>{}),content:vi.fn(async()=>{const dom=domFor(current);return `<html><head><title>${dom.title}</title><script src="/app.js"></script><link rel="stylesheet" href="/styles.css"></head><body>${dom.text}${dom.links.map(l=>`<a href="${l.href}">${l.text}</a>`).join('')}</body></html>`;}),evaluate:vi.fn(async()=>domFor(current)),screenshot:vi.fn(async()=>Buffer.from('png')),url:vi.fn(()=>current)};
  const context={newPage:vi.fn(async()=>page),close:contextClose};const browser={newContext:vi.fn(async()=>context),close:browserClose};const serverClose=vi.fn(async()=>{});const server={wsEndpoint:()=> 'ws://127.0.0.1:9222/fixture',process:()=>({pid:4242}),close:serverClose};playwrightMocks.launchServer.mockResolvedValue(server);playwrightMocks.connect.mockResolvedValue(browser);return {contextClose,browserClose,serverClose,browser,page};
}

describe('bounded website compatibility rebuild',()=>{
  it('caps pages and per-page network, preserves assets and emits an offline preview',async()=>{
    const artifactDir=await tempDir('re-web-');const assetServer=createServer((req,res)=>{if(req.url==='/app.js'){res.setHeader('content-type','text/javascript');res.end("fetch('/api/profile')");}else if(req.url==='/styles.css'){res.setHeader('content-type','text/css');res.end('@import url(https://evil.example/import.css);body{color:white;background:url(https://evil.example/pixel.png)}');}else{res.statusCode=404;res.end();}});const base=await listen(assetServer);
    const root=`${base}/`;const two=`${base}/two`;const three=`${base}/three`;
    const fake=fakeBrowser(url=>url===root?{title:'Home',text:'<p>home</p>',scripts:[`${base}/app.js`],stylesheets:[`${base}/styles.css`],links:[{href:two,text:'Two'},{href:three,text:'Three'}],forms:[],buttons:['Inspect'],explicitButtons:[{label:'State',url:`${base}/state`}]}:{title:'Other',text:'<p>other</p>',scripts:[],stylesheets:[],links:[{href:three,text:'Three'}],forms:[],buttons:[],explicitButtons:[]},url=>url===root?5:1);
    const ctx=await context(artifactDir,{allowLocal:true,confirmLocal:true,maxPages:2,maxNetworkPerPage:2,maxTotalNetwork:3,settleMs:0},root);
    ctx.stageOutputs.PREPARE=await websiteAdapter.prepare(ctx);const analysis=await websiteAdapter.analyze(ctx) as {pages:{id:string;network:unknown[];networkTruncated:boolean}[];network:unknown[];stateTransitions:{basis:string;observed:boolean}[];limits:{maxPages:number};compatibility:{pages:unknown[];assets:unknown[]}};
    expect(analysis.pages).toHaveLength(2);expect(analysis.pages[0]!.network).toHaveLength(2);expect(analysis.pages[0]!.networkTruncated).toBe(true);expect(analysis.network).toHaveLength(3);expect(analysis.pages.length).toBeLessThanOrEqual(analysis.limits.maxPages);
    expect(analysis.stateTransitions.some(t=>t.basis==='EVIDENCE'&&t.observed)).toBe(true);expect(analysis.stateTransitions.some(t=>t.basis==='INFERENCE')).toBe(true);
    expect(fake.browser.newContext).toHaveBeenCalledWith(expect.objectContaining({acceptDownloads:false}));
    expect(fake.page.screenshot).toHaveBeenCalledWith(expect.not.objectContaining({path:expect.anything()}));
    ctx.stageOutputs.ANALYZE=analysis;const rebuilt=await websiteAdapter.reconstruct(ctx) as {reconstructed:boolean;files:string[]};ctx.stageOutputs.RECONSTRUCT=rebuilt;
    expect(rebuilt.reconstructed).toBe(true);expect(analysis.compatibility.pages).toHaveLength(2);expect(analysis.compatibility.assets).toHaveLength(2);
    const first=await readFile(path.join(artifactDir,'preview-page-0001.html'),'utf8');expect(first).toContain('./preview-asset-0001.js');expect(first).toContain('./preview-asset-0002.css');expect(first).toContain('./preview-page-0002.html');expect(first).toContain("connect-src 'none'");expect(first).toContain("script-src 'none'");
    const css=await readFile(path.join(artifactDir,'preview-asset-0002.css'),'utf8');expect(css).toContain('body{color:white;background:none}');expect(css).not.toContain('evil.example');
    expect(await readFile(path.join(artifactDir,'preview-index.html'),'utf8')).toContain('不是原始后端恢复');
    ctx.stageOutputs.ANALYZE=analysis;const validation=await websiteAdapter.validate(ctx) as {passed:boolean};expect(validation.passed).toBe(true);expect(fake.contextClose).toHaveBeenCalled();expect(fake.browserClose).toHaveBeenCalled();expect(fake.serverClose).toHaveBeenCalled();
  });
  it('isolates preview iframes and strips executable or escaping resources',async()=>{
    const artifactDir=await tempDir('re-web-isolation-');const base='https://fixture.example';const ctx=await context(artifactDir,{},`${base}/`);
    const hostile=`<!doctype html><html><head><base href="https://evil.example/"><meta http-equiv="refresh" content="0;url=https://evil.example/"><script src="https://evil.example/remote.js"></script><SCRIPT SRC=https://evil.example/unquoted.js></SCRIPT><script>parent.localStorage.setItem('owned','yes')</script><link rel="stylesheet" href="https://evil.example/remote.css"><style>@import url(https://evil.example/import.css);body{background:url(https://evil.example/pixel.png)}</style></head><body onload="alert(1)"><a href="https://evil.example/escape">Escape</a><a href="/two">Local page</a><form action="https://evil.example/submit" method="post" target="_top" onsubmit="alert(1)"><button formaction="https://evil.example/button">Send</button></form><img src="https://evil.example/track.png" onerror="alert(1)"><iframe src="https://evil.example/frame" srcdoc="<script>alert(1)</script>"></iframe><object data="https://evil.example/object"></object><svg onload="alert(1)"></svg></body></html>`;
    const first={id:'page-0001',requestedUrl:`${base}/`,finalUrl:`${base}/`,title:'Hostile',html:hostile,text:'',scripts:[],stylesheets:[],links:[],forms:[],buttons:[],network:[],networkTruncated:false,domTruncated:false,textTruncated:false};
    const second={...first,id:'page-0002',requestedUrl:`${base}/two`,finalUrl:`${base}/two`,title:'Local',html:'<html><body>local</body></html>'};
    const analysis={finalUrl:first.finalUrl,title:first.title,html:first.html,text:'',scripts:[],stylesheets:[],links:[],forms:[],buttons:[],network:[],pages:[first,second],stateTransitions:[],candidates:[],compatibility:{index:'preview-index.html',pages:[],assets:[],limitations:[]},limits:{maxPages:8,maxDomBytes:2_000_000,maxNetworkPerPage:500,maxTotalNetwork:4000,maxTextChars:100_000,totalDurationMs:120_000,maxAssets:64,maxAssetBytes:2_000_000},limitations:['Static compatibility snapshot, not the original backend'],truncated:false,blocked:0,unsafeMethodsBlocked:0,durationMs:0};
    ctx.stageOutputs.ANALYZE=analysis;
    const rebuilt=await websiteAdapter.reconstruct(ctx) as {reconstructed:boolean};expect(rebuilt.reconstructed).toBe(true);
    const preview=await readFile(path.join(artifactDir,'preview-page-0001.html'),'utf8');const index=await readFile(path.join(artifactDir,'preview-index.html'),'utf8');
    const frames=[...index.matchAll(/<iframe\b[^>]*>/gi)].map(match=>match[0]);expect(frames).toHaveLength(2);for(const frame of frames){expect(frame).toMatch(/\ssandbox\s*=\s*["']["']/i);expect(frame).not.toMatch(/allow-same-origin/i);}
    expect(preview).toContain("script-src 'none'");expect(preview).not.toContain('unsafe-inline\'; style-src');expect(preview).not.toContain('evil.example');expect(preview).not.toMatch(/<script\b[^>]*>\s*parent\./i);expect(preview).not.toMatch(/\son[a-z]+\s*=/i);expect(preview).not.toMatch(/<(?:iframe|object|embed|svg|base)\b/i);expect(preview).not.toMatch(/http-equiv\s*=\s*["']refresh["']/i);
    expect(preview).toContain('href="./preview-page-0002.html"');expect(preview).toContain('action="#compatibility-unavailable"');expect(preview).toContain("form-action 'none'");expect(index).toContain("script-src 'none'");
  });
  it('closes browser and context immediately when ctx.signal aborts',async()=>{
    const artifactDir=await tempDir('re-web-cancel-');let entered!:()=>void;let release!:()=>void;const atGoto=new Promise<void>(resolve=>entered=resolve);const gate=new Promise<void>(resolve=>release=resolve);
    const fake=fakeBrowser(()=>({title:'Slow',text:'slow',scripts:[],stylesheets:[],links:[],forms:[],buttons:[],explicitButtons:[]}),()=>0,async()=>{entered();await gate;});
    const controller=new AbortController();const ctx=await context(artifactDir,{allowLocal:true,confirmLocal:true,settleMs:0});ctx.signal=controller.signal;ctx.stageOutputs.PREPARE={origin:'http://127.0.0.1:3100',addresses:['127.0.0.1'],allowLocal:true};
    const running=websiteAdapter.analyze(ctx);await atGoto;controller.abort();await vi.waitFor(()=>{expect(fake.contextClose).toHaveBeenCalledTimes(1);expect(fake.browserClose).toHaveBeenCalledTimes(1);expect(fake.serverClose).toHaveBeenCalledTimes(1);});release();await expect(running).rejects.toMatchObject({name:'AbortError'});
  });
});

interface TraceMessage {seq:number;at:string;direction:'client'|'server';type:string;payload:Record<string,unknown>}
function message(seq:number,direction:'client'|'server',type:string,payload:Record<string,unknown>):TraceMessage{return {seq,at:new Date(seq*1000).toISOString(),direction,type,payload};}
function statefulTrace(){return {format:'replay-trace/v1',target:{name:'stateful fixture'},messages:[
  message(1,'client','hello',{protocol:1}),message(2,'server','welcome',{type:'welcome',server:'fixture',protocol:1}),
  message(3,'client','login',{username:'tester'}),message(4,'server','login_ok',{type:'login_ok',playerId:'p-1',displayName:'tester'}),message(5,'server','player_state',{type:'player_state',id:'p-1',name:'tester',position:{x:0,y:0},inventory:['map'],xp:0,savedAt:null}),
  message(6,'client','move',{dx:1}),message(7,'server','player_state',{type:'player_state',id:'p-1',name:'tester',position:{x:1,y:0},inventory:['map'],xp:10,savedAt:null}),
  message(8,'client','collect',{itemId:'key'}),message(9,'server','player_state',{type:'player_state',id:'p-1',name:'tester',position:{x:1,y:0},inventory:['map','key'],xp:10,savedAt:null}),
  message(10,'client','save',{}),message(11,'server','save_ok',{type:'save_ok',saved:true}),message(12,'server','player_state',{type:'player_state',id:'p-1',name:'tester',position:{x:1,y:0},inventory:['map','key'],xp:10,savedAt:'2026-11-23T00:00:00.000Z'}),
  message(13,'client','logout',{}),message(14,'server','logout_ok',{type:'logout_ok'})
]};}
async function gameContext(){const dataDir=await tempDir('re-game-');const artifactDir=path.join(dataDir,'artifacts');const uploadDir=path.join(dataDir,'uploads','project');await mkdir(uploadDir,{recursive:true});await mkdir(artifactDir,{recursive:true});await writeFile(path.join(uploadDir,'trace.json'),JSON.stringify(statefulTrace()));const ctx=await context(artifactDir);ctx.dataDir=dataDir;ctx.project={...ctx.project,kind:'game',target:''};ctx.upload={id:'u1',projectId:'project',name:'trace.json',storedName:'trace.json',mime:'application/json',size:1,sha256:'x',createdAt:new Date().toISOString()};return ctx;}

describe('stateful L4 game compatibility rebuild',()=>{
  it('infers account/inventory/position/save state and validates move, save and reconnect in a real child process',async()=>{
    const ctx=await gameContext();ctx.stageOutputs.PREPARE=await gameAdapter.prepare(ctx);const analysis=await gameAdapter.analyze(ctx) as {state:{snapshots:{fields:{category:string}[]}[];mutations:unknown[]}};expect(analysis.state.mutations.length).toBeGreaterThanOrEqual(3);const categories=new Set(analysis.state.snapshots.flatMap(s=>s.fields.map(f=>f.category)));expect([...categories]).toEqual(expect.arrayContaining(['account','inventory','position','save']));
    ctx.stageOutputs.ANALYZE=analysis;const rebuilt=await gameAdapter.reconstruct(ctx) as {generated:boolean};expect(rebuilt.generated).toBe(true);ctx.stageOutputs.RECONSTRUCT=rebuilt;
    const validation=await gameAdapter.validate(ctx) as {passed:boolean;level:string;checks:{name:string;passed:boolean;details?:string}[]};expect(validation.passed,JSON.stringify(validation.checks)).toBe(true);expect(validation.level).toBe('L4');expect(validation.checks.map(c=>c.name)).toEqual(expect.arrayContaining(['Observed move transition changes state','Observed save request completed','Reconnect login restores persisted session state','Unobserved request returns UNKNOWN','Unobserved request value returns UNKNOWN','Observed request with invalid payload is rejected','Observed logout completes','State request after logout returns UNKNOWN']));
    const source=await readFile(path.join(ctx.artifactDir,'server.mjs'),'utf8');expect(source).toContain('createRequire(import.meta.url)');expect(source).toContain('not original server code');const persisted=JSON.parse(await readFile(path.join(ctx.artifactDir,'compatibility/data/state.json'),'utf8')) as {accounts:Record<string,unknown>};expect(Object.keys(persisted.accounts)).toHaveLength(1);expect(JSON.stringify(persisted)).not.toContain('tester');
  });
  it('bounds large trace inference to the configured message limit',()=>{
    const messages:TraceMessage[]=[];for(let i=0;i<20_000;i++)messages.push(message(i+1,i%2===0?'client':'server',i%2===0?'hello':'welcome',{protocol:1}));
    const model=inferProtocol({format:'replay-trace/v1',target:{name:'large'},messages});expect(model.truncated).toBe(true);expect(model.messageLimit).toBe(10_000);expect(model.messageTypes.reduce((sum,m)=>sum+m.count,0)).toBe(10_000);expect(model.transitions.length).toBe(2);
    const smaller=inferProtocol({format:'replay-trace/v1',target:{name:'large'},messages},{maxMessages:100});expect(smaller.messageTypes.reduce((sum,m)=>sum+m.count,0)).toBe(100);
  });
});

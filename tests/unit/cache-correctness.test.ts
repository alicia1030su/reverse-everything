import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AnalysisCache } from '../../packages/workflow/src/cache.js';
import { Database } from '../../packages/workflow/src/database.js';
import { WorkflowEngine } from '../../packages/workflow/src/engine.js';
import type { AdapterDefinition } from '../../packages/workflow/src/types.js';

const dirs:string[]=[];
afterEach(async()=>{for(const dir of dirs.splice(0))await rm(dir,{recursive:true,force:true});});
async function temp(){const dir=await mkdtemp(path.join(os.tmpdir(),'re-v003-cache-correctness-'));dirs.push(dir);return dir;}
function adapter(name:AdapterDefinition['name'],overrides:Partial<AdapterDefinition>={}):AdapterDefinition{return {name,version:'test',description:'test',available:async()=>({available:true,detail:'test'}),detect:async()=>({adapter:name,confidence:1,format:'test',details:{},limitations:[]}),prepare:async()=>({prepared:true}),analyze:async()=>({ok:true}),extractEvidence:async()=>({}),reconstruct:async()=>({}),validate:async()=>({passed:true,checks:[]}),...overrides};}
function project(db:Database){return db.project({name:'cache-correctness',kind:'software',authorizationConfirmed:true});}

describe('cache correctness',()=>{
  it('normalizes execution and sensitive options without dropping semantic options',async()=>{
    const db=new Database(':memory:');const cache=new AnalysisCache(db,await temp());
    const identity={projectId:'p',inputHash:'input',adapter:'file' as const,adapterVersion:'test',stage:'ANALYZE' as const};
    const first=await cache.keyFor({...identity,options:{timeoutMs:1000,settleMs:10,maxMemoryMB:100,maxDiskMB:200,nonce:'first',apiKey:'first-api-key',nested:{token:'first-token'},maxPages:2,totalDurationMs:1000},toolVersions:{token:'tool-token',version:'1',runId:'first-tool-run'}});
    const second=await cache.keyFor({...identity,options:{timeoutMs:9000,settleMs:900,maxMemoryMB:900,maxDiskMB:900,nonce:'second',apiKey:'second-api-key',nested:{token:'second-token'},maxPages:2,totalDurationMs:1000},toolVersions:{token:'other-tool-token',version:'1',runId:'second-tool-run'}});
    const semantic=await cache.keyFor({...identity,options:{maxPages:3,totalDurationMs:1000},toolVersions:{version:'1'}});
    const duration=await cache.keyFor({...identity,options:{maxPages:2,totalDurationMs:2000},toolVersions:{version:'1'}});
    expect(second.key).toBe(first.key);
    expect(semantic.key).not.toBe(first.key);
    expect(duration.key).not.toBe(first.key);
    expect(AnalysisCache.cacheOptions({timeoutMs:1,settleMs:2,apiKey:'secret',nested:{token:'secret'},maxPages:2})).toEqual({nested:{},maxPages:2});
    expect(AnalysisCache.cacheOptions({pwd:'secret',jwt:'secret',auth:'secret',refresh:'secret',sid:'secret',key:'secret',access:'secret',client_secret:'secret',private_key:'secret','set-cookie':'secret',monkey:'kept',keyboard:'kept',sessionDurationMs:5})).toEqual({monkey:'kept',keyboard:'kept',sessionDurationMs:5});
    expect(AnalysisCache.cacheOptions({totalDurationMs:1000})).toEqual({totalDurationMs:1000});
    db.close();
  });

  it('rejects realtime adapters and raw game PREPARE outputs at every pure stage',async()=>{
    const db=new Database(':memory:');const cache=new AnalysisCache(db,await temp());
    for(const name of ['website','game','security'] as const){
      for(const stage of ['CLASSIFY','PREPARE','ANALYZE'] as const){
        expect(AnalysisCache.isCacheable(stage,name)).toBe(false);
        const {key}=await cache.keyFor({projectId:'p',inputHash:name,adapter:name,adapterVersion:'test',stage,options:{}});
        await cache.put(key,'project','p',name,stage,{unsafe:true,trace:{password:'raw-password',sessionToken:'raw-session-token'}});
      }
    }
    for(const [name,stage] of [['ghidra','PREPARE'],['ghidra','ANALYZE'],['network','ANALYZE'],['apk','ANALYZE']] as const){
      expect(AnalysisCache.isCacheable(stage,name)).toBe(false);
      const {key}=await cache.keyFor({projectId:'p',inputHash:name,adapter:name,adapterVersion:'test',stage,options:{}});
      await cache.put(key,'project','p',name,stage,{unsafe:true});
    }
    expect(AnalysisCache.isCacheable('ANALYZE','file')).toBe(true);
    expect(AnalysisCache.isCacheable('PREPARE','file')).toBe(true);
    expect(cache.list().items).toEqual([]);
    expect(db.raw.prepare('SELECT * FROM cache_entries').all()).toEqual([]);
    db.close();
  });

  it('re-analyzes website tasks and rebuilds matching evidence and full artifacts each time',async()=>{
    const dir=await temp();const db=new Database(':memory:');const cache=new AnalysisCache(db,dir);let analyses=0;let classifications=0;let preparations=0;
    const website=adapter('website',{
      detect:async()=>{classifications++;return {adapter:'website',confidence:1,format:'test',details:{capture:classifications},limitations:[]};},
      prepare:async()=>{preparations++;return {prepared:true,addresses:[`192.0.2.${preparations}`]};},
      analyze:async()=>{analyses++;const marker=`capture-${analyses}`;return {marker,network:Array.from({length:2001},(_,index)=>({url:`https://example.test/${marker}/${index}`})),pages:[{id:marker}]};},
      extractEvidence:async ctx=>{const analysis=ctx.stageOutputs.ANALYZE as {marker:string;network:{url:string}[];pages:{id:string}[]};await ctx.evidence('EVIDENCE','Observed network','fixture','network.ndjson',analysis.network.slice(0,2000));await ctx.writeArtifact('web-analysis.json',JSON.stringify(analysis,null,2),'application/json');return {requests:analysis.network.length,pages:analysis.pages.length};}
    });
    const engine=new WorkflowEngine(db,{dataDir:dir,adapters:[website],cache});const p=project(db);
    const first=await engine.create(p.id,{adapter:'website'});const second=await engine.create(p.id,{adapter:'website'});
    await engine.execute(first.id);await engine.execute(second.id);
    expect(classifications).toBe(2);expect(preparations).toBe(2);expect(analyses).toBe(2);
    expect(cache.list().items.filter(item=>item.adapter==='website')).toEqual([]);
    expect(db.stageOutput(first.id,'PREPARE')).toEqual({prepared:true,addresses:['192.0.2.1']});
    expect(db.stageOutput(second.id,'PREPARE')).toEqual({prepared:true,addresses:['192.0.2.2']});
    for(const [taskId,marker] of [[first.id,'capture-1'],[second.id,'capture-2']] as const){
      const output=db.stageOutput(taskId,'ANALYZE') as {marker:string;network:{url:string}[]};
      const artifactPath=db.artifactPath(taskId,'web-analysis.json')!;
      const evidence=db.evidence(taskId).find(item=>item.locator==='network.ndjson')!;
      expect(output.marker).toBe(marker);expect(output.network).toHaveLength(2001);
      expect(JSON.parse(await readFile(artifactPath,'utf8'))).toEqual(output);
      expect(evidence.content).toEqual(output.network.slice(0,2000));
    }
    db.close();
  });

  it('hits file ANALYZE cache while rerunning extractEvidence to rebuild task-local outputs',async()=>{
    const dir=await temp();const db=new Database(':memory:');const cache=new AnalysisCache(db,dir);let analyses=0;let extractions=0;
    const analysis={marker:'stable',format:{timestamp:'2020-01-02T03:04:05.000Z'},network:Array.from({length:2001},(_,index)=>({url:`https://example.test/${index}`})),strings:[{value:'alpha'}]};
    const file=adapter('file',{
      analyze:async()=>{analyses++;return analysis;},
      extractEvidence:async ctx=>{extractions++;const output=ctx.stageOutputs.ANALYZE as typeof analysis;await ctx.evidence('EVIDENCE','Bounded network inventory','fixture','network.ndjson',output.network.slice(0,2000));await ctx.writeArtifact('file-analysis.json',JSON.stringify(output,null,2),'application/json');return {evidenceCount:output.strings.length};}
    });
    const engine=new WorkflowEngine(db,{dataDir:dir,adapters:[file],cache});const p=project(db);
    const first=await engine.create(p.id,{adapter:'file',options:{settleMs:10,timeoutMs:5000}});const second=await engine.create(p.id,{adapter:'file',options:{settleMs:900,timeoutMs:9000,nonce:'different-run'}});
    await engine.execute(first.id);await engine.execute(second.id);
    expect(analyses).toBe(1);expect(extractions).toBe(2);
    expect(cache.list().items.filter(item=>item.adapter==='file'&&item.stage==='ANALYZE')).toHaveLength(1);
    expect(cache.list().items.find(item=>item.adapter==='file'&&item.stage==='ANALYZE')?.hits).toBe(1);
    for(const taskId of [first.id,second.id]){
      expect(db.stageOutput(taskId,'ANALYZE')).toEqual(analysis);
      const artifactPath=db.artifactPath(taskId,'file-analysis.json')!;
      expect(JSON.parse(await readFile(artifactPath,'utf8'))).toEqual(analysis);
      expect(db.evidence(taskId).find(item=>item.locator==='network.ndjson')?.content).toEqual(analysis.network.slice(0,2000));
    }
    db.close();
  });

  it('never writes API keys or tokens into cache metadata or payloads',async()=>{
    const dir=await temp();const db=new Database(':memory:');const cache=new AnalysisCache(db,dir);const apiKey='api-key-live-1234567890';const token='token-live-abcdefghijklmnop';
    const file=adapter('file',{analyze:async()=>({safe:true,apiKey,nested:{token},authorization:`Bearer ${token}`,note:`Bearer ${token}`,text:`token=${token}`})});
    const engine=new WorkflowEngine(db,{dataDir:dir,adapters:[file],cache});const p=project(db);
    await engine.execute((await engine.create(p.id,{adapter:'file',options:{apiKey,token,settleMs:10}})).id);
    await engine.execute((await engine.create(p.id,{adapter:'file',options:{apiKey:'different-api-key',token:'different-token',settleMs:900}})).id);
    const rows=db.raw.prepare('SELECT * FROM cache_entries').all() as {payload_path:string}[];
    expect(rows.length).toBeGreaterThan(0);expect(JSON.stringify(rows)).not.toContain(apiKey);expect(JSON.stringify(rows)).not.toContain(token);
    for(const row of rows){const payload=await readFile(row.payload_path,'utf8');expect(payload).not.toContain(apiKey);expect(payload).not.toContain(token);}
    const analyzeEntry=cache.list().items.find(item=>item.stage==='ANALYZE')!;
    expect(await cache.get(analyzeEntry.key)).toMatchObject({safe:true,apiKey:'[REDACTED]',nested:{token:'[REDACTED]'},authorization:'[REDACTED]',note:'[REDACTED]',text:'token=[REDACTED]'});
    db.close();
  });

  it('redacts JWT, auth, cookie and common credential fields from file cache payloads',async()=>{
    const dir=await temp();const db=new Database(':memory:');const cache=new AnalysisCache(db,dir);
    const jwt='eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature-value';
    const secrets={pwd:'pwd-secret-value',auth:'auth-secret-value',refresh:'refresh-secret-value',sid:'sid-secret-value',key:'key-secret-value',access:'access-secret-value',client_secret:'client-secret-value',private_key:'private-key-secret-value','set-cookie':'set-cookie-secret-value'};
    const bearer='bearer-secret-value';const basic='Basic dXNlcjpwYXNzd29yZA==';
    const values=[
      jwt,
      `Bearer ${bearer}`,
      `Authorization: Bearer ${bearer}`,
      basic,
      ...Object.entries(secrets).map(([key,value])=>`${key}=${value}`),
      `Cookie: session=${secrets.sid}; theme=dark`,
      `Set-Cookie: sid=${secrets.sid}; HttpOnly`,
      `https://example.test/?sid=${secrets.sid}&view=full`
    ];
    const file=adapter('file',{analyze:async()=>({safe:true,jwt,...secrets,values})});
    const engine=new WorkflowEngine(db,{dataDir:dir,adapters:[file],cache});const p=project(db);
    await engine.execute((await engine.create(p.id,{adapter:'file',options:{jwt,...secrets}})).id);
    const rows=db.raw.prepare('SELECT * FROM cache_entries').all() as {payload_path:string}[];
    const rawSecrets=[jwt,bearer,...Object.values(secrets),'dXNlcjpwYXNzd29yZA=='];
    expect(rows.length).toBeGreaterThan(0);
    for(const row of rows){
      const payload=await readFile(row.payload_path,'utf8');
      for(const secret of rawSecrets){expect(payload).not.toContain(secret);expect(JSON.stringify(row)).not.toContain(secret);}
    }
    const analyzeEntry=cache.list().items.find(item=>item.stage==='ANALYZE')!;
    const cached=await cache.get(analyzeEntry.key) as {safe:boolean;jwt:string;values:string[]} & Record<string,unknown>;
    expect(cached.safe).toBe(true);
    for(const key of ['jwt',...Object.keys(secrets)])expect(cached[key]).toBe('[REDACTED]');
    for(const value of cached.values){for(const secret of rawSecrets)expect(value).not.toContain(secret);expect(value).toContain('[REDACTED]');}
    expect(cached.values.find(value=>value.startsWith('https://example.test/'))).toContain('view=full');
    db.close();
  });
});

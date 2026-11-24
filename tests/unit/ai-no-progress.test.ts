import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Database, WorkflowEngine, type AdapterDefinition } from '@reverse/workflow';

const dirs:string[]=[];
afterEach(async()=>{for(const dir of dirs.splice(0))await rm(dir,{recursive:true,force:true});});
function adapter():AdapterDefinition{return {name:'file',version:'test',description:'test',available:async()=>({available:true,detail:'test'}),detect:async()=>({adapter:'file',confidence:1,format:'test',details:{},limitations:[]}),prepare:async()=>({prepared:true}),analyze:async()=>({ok:true}),extractEvidence:async()=>({}),reconstruct:async()=>({generated:true}),validate:async()=>({passed:false,checks:[{name:'deterministic',passed:false}]})};}

describe('bounded AI validation progress',()=>{
  it('stops after a repeated false review with unchanged deterministic validation',async()=>{
    const dataDir=await mkdtemp(path.join(os.tmpdir(),'re-ai-progress-'));dirs.push(dataDir);let validatorCalls=0;
    const fake=http.createServer((request,response)=>{let body='';request.on('data',chunk=>body+=chunk.toString());request.on('end',()=>{const payload=JSON.parse(body) as {messages:{content:string}[]};const system=payload.messages[0]?.content??'';let content='{"steps":["inspect"],"uncertainties":[]}';if(system.includes('summarize'))content='summary';if(system.includes('validation reviewer')){validatorCalls++;content=JSON.stringify({passed:false,checks:[{name:'review',passed:false}],action:'none'});}response.setHeader('content-type','application/json');response.end(JSON.stringify({choices:[{message:{content}}]}));});});
    await new Promise<void>(resolve=>fake.listen(0,'127.0.0.1',resolve));const address=fake.address();if(!address||typeof address==='string')throw new Error('No fake AI port');
    const db=new Database(':memory:');
    try{
      const engine=new WorkflowEngine(db,{dataDir,adapters:[adapter()],getAiConfig:()=>({enabled:true,baseUrl:`http://127.0.0.1:${address.port}/v1`,model:'fixture',allowRemoteData:false})});
      const project=db.project({name:'no-progress',kind:'software',authorizationConfirmed:true});const task=await engine.create(project.id,{adapter:'file',options:{aiMaxIterations:3}});await engine.execute(task.id);
      expect(db.getTask(task.id)?.status).toBe('COMPLETED');expect(validatorCalls).toBe(2);
      const runs=db.raw.prepare("SELECT role FROM agent_runs WHERE role='validator' ORDER BY rowid").all();expect(runs).toHaveLength(2);
      expect(db.evidence(task.id).some(item=>item.kind==='UNKNOWN'&&item.title==='AI validation stopped after no progress')).toBe(true);
      expect(db.stageOutput(task.id,'VALIDATE')).toMatchObject({passed:false,limitations:expect.arrayContaining([expect.stringContaining('stopped early')])});
    }finally{db.close();await new Promise<void>(resolve=>fake.close(()=>resolve()));}
  });
});

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Database, WorkflowEngine, type AdapterDefinition } from '@reverse/workflow';
const dirs:string[]=[];
afterEach(async()=>{for(const d of dirs.splice(0))await rm(d,{recursive:true,force:true});});
async function setup(){const dataDir=await mkdtemp(path.join(os.tmpdir(),'re-workflow-'));dirs.push(dataDir);const db=new Database(':memory:');return {dataDir,db};}
function adapter(overrides:Partial<AdapterDefinition>={}):AdapterDefinition{return {name:'file',version:'test',description:'test',available:async()=>({available:true,detail:'test'}),detect:async()=>({adapter:'file',confidence:1,format:'test',details:{},limitations:[]}),prepare:async()=>({prepared:true}),analyze:async()=>({ok:true}),extractEvidence:async()=>({}),reconstruct:async()=>({}),validate:async()=>({passed:true,checks:[]}),...overrides};}
describe('persistent workflow',()=>{
  it('persists stage checkpoints and resumes after pause',async()=>{
    const {dataDir,db}=await setup();
    let release!:()=>void;const gate=new Promise<void>(r=>release=r);
    const engine=new WorkflowEngine(db,{dataDir,adapters:[adapter({prepare:async ctx=>{await gate;await ctx.log('info','prepared');return {prepared:true};}})],pollMs:100000});
    const project=db.project({name:'test',kind:'software',authorizationConfirmed:true});
    const task=await engine.create(project.id,{adapter:'file'});
    const running=engine.execute(task.id);
    while(db.getTask(task.id)?.currentStage!=='PREPARE')await new Promise(r=>setTimeout(r,5));
    expect(engine.pause(task.id)).toBe(true);release();await running;
    expect(db.getTask(task.id)?.status).toBe('PAUSED');
    expect(engine.resume(task.id)).toBe(true);await engine.execute(task.id);
    expect(db.getTask(task.id)?.status).toBe('COMPLETED');
    expect(db.stages(task.id).find(s=>s.name==='COMPLETED')?.status).toBe('SUCCEEDED');
    db.close();
  });
  it('retries only the failed stage and retains prior outputs',async()=>{
    const {dataDir,db}=await setup();let fail=true;
    const engine=new WorkflowEngine(db,{dataDir,adapters:[adapter({analyze:async()=>{if(fail)throw new Error('injected failure');return {ok:true};}})]});
    const project=db.project({name:'test',kind:'software',authorizationConfirmed:true});
    const task=await engine.create(project.id,{adapter:'file'});
    await engine.execute(task.id);
    expect(db.getTask(task.id)?.status).toBe('FAILED');
    expect(db.getTask(task.id)?.currentStage).toBe('ANALYZE');
    fail=false;engine.retry(task.id);await engine.execute(task.id);
    expect(db.getTask(task.id)?.status).toBe('COMPLETED');
    expect(db.stageOutput(task.id,'PREPARE')).toEqual({prepared:true});
    expect(db.stages(task.id).find(s=>s.name==='ANALYZE')?.attempt).toBe(2);
    db.close();
  });
});

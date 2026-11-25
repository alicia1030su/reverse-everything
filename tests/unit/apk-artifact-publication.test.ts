import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AnalysisCache, Database, WorkflowEngine } from '@reverse/workflow';
import { apkAdapter, type ApkAnalysis } from '../../packages/core/src/adapters/apk.js';

const dirs:string[]=[];const previous=process.env.RE_JADX_BIN;
afterEach(async()=>{if(previous===undefined)delete process.env.RE_JADX_BIN;else process.env.RE_JADX_BIN=previous;for(const dir of dirs.splice(0))await rm(dir,{recursive:true,force:true});});

describe('APK production artifact publication',()=>{
  it('publishes same-basename JADX outputs under unique safe names with matching artifact hashes',async()=>{
    const dataDir=await mkdtemp(path.join(os.tmpdir(),'re-apk-publication-'));dirs.push(dataDir);delete process.env.RE_JADX_HOME;delete process.env.RE_JAVA;
    const fake=path.join(dataDir,'fake-jadx.mjs');await writeFile(fake,`import fs from 'node:fs';import path from 'node:path';const args=process.argv.slice(2);if(args.includes('--version')){console.log('jadx 1.5.3');process.exit(0);}const output=args[args.indexOf('-d')+1];for(const [relative,text] of [['sources/com/one/R.java','package com.one; class R { String marker(){return "one";} }'],['sources/com/two/R.java','package com.two; class R { String marker(){return "two";} }'],['sources/com/one/BuildConfig.java','package com.one; class BuildConfig {}']]){const target=path.join(output,relative);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,text);}`,'utf8');process.env.RE_JADX_BIN=fake;
    const db=new Database(':memory:');const project=db.project({name:'apk-publication',kind:'software',authorizationConfirmed:true});const uploadDir=path.join(dataDir,'uploads',project.id);await mkdir(uploadDir,{recursive:true});const archive=await readFile(path.resolve('tests/fixtures/android/minimal.apk'));await writeFile(path.join(uploadDir,'stored.apk'),archive);db.addUpload({id:'upload',projectId:project.id,name:'minimal.apk',storedName:'stored.apk',mime:'application/vnd.android.package-archive',size:archive.length,sha256:createHash('sha256').update(archive).digest('hex'),createdAt:new Date().toISOString()});
    const cache=new AnalysisCache(db,dataDir);const engine=new WorkflowEngine(db,{dataDir,adapters:[apkAdapter],maxDiskMB:10,cache});const task=await engine.create(project.id,{adapter:'apk',options:{apkDecompile:true}});await engine.execute(task.id);expect(db.getTask(task.id)?.status,db.getTask(task.id)?.error).toBe('COMPLETED');
    const analysis=db.stageOutput(task.id,'ANALYZE') as ApkAnalysis;expect(analysis.decompilation.status).toBe('COMPLETED');expect(analysis.decompilation.files).toHaveLength(3);expect(new Set(analysis.decompilation.artifacts).size).toBe(analysis.decompilation.artifacts.length);
    const contents:string[]=[];for(const file of analysis.decompilation.files){expect(file.artifact).toBeTruthy();const object=db.artifactObject(task.id,file.artifact!);expect(object,file.artifact).toBeDefined();const bytes=await readFile(object!.storedPath);expect(bytes.length).toBe(file.artifactSize);expect(createHash('sha256').update(bytes).digest('hex')).toBe(file.artifactSha256);expect(object!.sha256).toBe(file.artifactSha256);if(file.path.endsWith('/R.java'))contents.push(bytes.toString('utf8'));}
    expect(new Set(contents).size).toBe(2);const second=await engine.create(project.id,{adapter:'apk',options:{apkDecompile:true}});await engine.execute(second.id);expect(db.getTask(second.id)?.status,db.getTask(second.id)?.error).toBe('COMPLETED');expect(cache.list().items.filter(item=>item.adapter==='apk'&&item.stage==='PREPARE')).toEqual([]);db.close();
  },30000);
});

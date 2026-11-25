import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { TaskContext } from '@reverse/workflow';
import { apkAdapter, JADX_SHA256, JADX_VERSION, type ApkAnalysis } from '../../packages/core/src/adapters/apk.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const fixtureDir=path.join(root,'tests','fixtures','android');
const dirs:string[]=[];
afterEach(async()=>{for(const dir of dirs.splice(0))await rm(dir,{recursive:true,force:true});});
async function context():Promise<TaskContext>{
  const dataDir=await mkdtemp(path.join(os.tmpdir(),'re-android-real-')),archive=await readFile(path.join(fixtureDir,'minimal.apk')),uploadDir=path.join(dataDir,'uploads','project'),artifactDir=path.join(dataDir,'tasks','task','artifacts');dirs.push(dataDir);await mkdir(uploadDir,{recursive:true});await mkdir(artifactDir,{recursive:true});await writeFile(path.join(uploadDir,'stored.bin'),archive);
  return {taskId:'task',project:{id:'project',name:'android-known-answer',kind:'software',target:'authorized-local-fixture',authorizationConfirmed:true,createdAt:new Date(0).toISOString()},upload:{id:'upload',projectId:'project',name:'minimal.apk',storedName:'stored.bin',mime:'application/vnd.android.package-archive',size:archive.length,sha256:createHash('sha256').update(archive).digest('hex'),createdAt:new Date(0).toISOString()},options:{apkDecompile:true},stageOutputs:{},dataDir,signal:new AbortController().signal,log:async()=>{},evidence:async()=> 'evidence',finding:async()=> 'finding',writeArtifact:async(file,content)=>{const target=path.join(artifactDir,file);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,content);},readArtifact:async file=>readFile(path.join(artifactDir,file))};
}

describe('Android known-answer APK fixture',()=>{
  it('uses timezone-independent ZIP timestamps',async()=>{
    const apk=await readFile(path.join(fixtureDir,'minimal.apk'));
    expect(apk.readUInt32LE(0)).toBe(0x04034b50);
    expect(apk.readUInt16LE(10)).toBe(0);
    expect(apk.readUInt16LE(12)).toBe(0x0021);
    const extraStart=30+apk.readUInt16LE(26),extraEnd=extraStart+apk.readUInt16LE(28);
    let offset=extraStart;
    while(offset<extraEnd){
      const id=apk.readUInt16LE(offset),size=apk.readUInt16LE(offset+2);
      expect(id).not.toBe(0x5455);
      offset+=4+size;
    }
    expect(offset).toBe(extraEnd);
  });
  it('is deterministic and built-in ZIP/AXML/DEX analysis matches every known answer',async()=>{
    execFileSync(process.execPath,[path.join(root,'scripts','verify-jadx.mjs'),'--check-fixture'],{cwd:root,stdio:'pipe'});const ctx=await context(),expected=JSON.parse(await readFile(path.join(fixtureDir,'expected.json'),'utf8')) as {packageName:string;className:string;methodName:string;stringValue:string;resourcePath:string;permission:string;declaredPermission:string};ctx.options.apkDecompile=false;ctx.stageOutputs.PREPARE=await apkAdapter.prepare(ctx);const result=await apkAdapter.analyze(ctx) as ApkAnalysis;
    expect(result.sha256).toBe(ctx.upload?.sha256);expect(result.manifest).toMatchObject({format:'binary-axml',packageName:expected.packageName,permissions:[expected.permission],declaredPermissions:[expected.declaredPermission]});expect(result.entries.names).toContain(expected.resourcePath);expect(result.dexFiles).toHaveLength(1);expect(result.dexFiles[0]?.classDefs.values).toContain(`L${expected.className.replaceAll('.','/')};`);expect(result.dexFiles[0]?.methodIds.values).toEqual(expect.arrayContaining([expect.objectContaining({name:expected.methodName}),expect.objectContaining({name:'<init>'})]));expect(result.dexFiles[0]?.stringIds.values).toContain(expected.stringValue);expect(result.decompilation).toMatchObject({status:'BLOCKED',requested:false});
    const provenance=JSON.parse(await readFile(path.join(fixtureDir,'provenance.json'),'utf8')) as {apkSha256:string;dexSha256:string;jadxVerification:{version:string;officialArchiveSha256:string}};expect(provenance.apkSha256).toBe(result.sha256);expect(provenance.dexSha256).toBe(result.dexFiles[0]?.sha256);expect(provenance.jadxVerification).toMatchObject({version:JADX_VERSION,officialArchiveSha256:JADX_SHA256});
  });
  it.skipIf(process.env.RE_RUN_ANDROID_REAL!=='1')('runs pinned real JADX and compares Java, method, string, manifest and resource outputs',async()=>{
    const ctx=await context();ctx.stageOutputs.PREPARE=await apkAdapter.prepare(ctx);const result=await apkAdapter.analyze(ctx) as ApkAnalysis,expected=JSON.parse(await readFile(path.join(fixtureDir,'expected.json'),'utf8')) as {packageName:string;className:string;methodName:string;stringValue:string;resourcePath:string;resourceValue:string;permission:string;declaredPermission:string};
    expect(result.decompilation).toMatchObject({status:'COMPLETED',engine:'jadx',version:JADX_VERSION,expectedSha256:JADX_SHA256});expect(result.decompilation.classes).toContain(expected.className);expect(result.decompilation.methods).toEqual(expect.arrayContaining([expect.objectContaining({class:expected.className,name:expected.methodName})]));expect(result.decompilation.files.map(file=>file.path)).toEqual(expect.arrayContaining([`sources/${expected.className.replaceAll('.','/')}.java`,`resources/${expected.resourcePath}`,'resources/AndroidManifest.xml']));
    const javaArtifact=result.decompilation.files.find(file=>file.path===`sources/${expected.className.replaceAll('.','/')}.java`)?.artifact,resourceArtifact=result.decompilation.files.find(file=>file.path===`resources/${expected.resourcePath}`)?.artifact,manifestArtifact=result.decompilation.files.find(file=>file.path==='resources/AndroidManifest.xml')?.artifact;expect(javaArtifact).toBeTruthy();expect(resourceArtifact).toBeTruthy();expect(manifestArtifact).toBeTruthy();const java=await ctx.readArtifact(javaArtifact!),resource=await ctx.readArtifact(resourceArtifact!),manifest=await ctx.readArtifact(manifestArtifact!);expect(java.toString('utf8')).toContain(`class ${expected.className.split('.').at(-1)}`);expect(java.toString('utf8')).toContain(`String ${expected.methodName}(`);expect(java.toString('utf8')).toContain(expected.stringValue);expect(resource.toString('utf8')).toBe(expected.resourceValue);for(const value of [expected.packageName,expected.permission,expected.declaredPermission])expect(manifest.toString('utf8')).toContain(value);expect(result.decompilation.smaliFiles).toBe(0);expect(result.decompilation.limitations.join(' ')).toMatch(/does not emit a standalone smali/i);
  },120_000);
});

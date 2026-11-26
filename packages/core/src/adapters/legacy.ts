import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { analyzeLegacySoftware, createReconstructionSpec, generateReconstructionProject, recoverLegacyData, writeReconstructionProject, type LegacyAnalysis, type LegacyReconstructionSpec } from '@reverse/legacy-revival';
import type { TaskContext } from '@reverse/workflow';
import { defineAdapter, output, uploadPath } from './base.js';

const run=promisify(execFile);
function minimalEnv(overrides:NodeJS.ProcessEnv={}):NodeJS.ProcessEnv{const allowed=['PATH','PATHEXT','SystemRoot','SYSTEMROOT','COMSPEC','TEMP','TMP','HOME','USERPROFILE','APPDATA','LOCALAPPDATA','PROCESSOR_ARCHITECTURE','NUMBER_OF_PROCESSORS'];const env:NodeJS.ProcessEnv={};for(const key of allowed)if(process.env[key]!==undefined)env[key]=process.env[key];return{...env,...overrides};}
function isWithin(root:string,candidate:string):boolean{const relative=path.relative(root,candidate);return relative===''||(relative!=='..'&&!relative.startsWith(`..${path.sep}`)&&!path.isAbsolute(relative));}
async function allowedLegacyPath(value:unknown):Promise<string>{
  if(typeof value!=='string'||!path.isAbsolute(value))throw new Error('Legacy analysis requires an uploaded file or absolute local path');const original=await lstat(value);if(original.isSymbolicLink())throw new Error('Legacy path must not be a symbolic link or junction');
  const roots=(process.env.RE_LEGACY_ROOTS??'').split(path.delimiter).map(item=>item.trim()).filter(Boolean);if(!roots.length)throw new Error('RE_LEGACY_ROOTS must explicitly allow local software directories');const resolved=await realpath(value);const allowed=await Promise.all(roots.map(root=>realpath(root)));if(!allowed.some(root=>isWithin(root,resolved)))throw new Error('Legacy path is outside RE_LEGACY_ROOTS');return resolved;
}
async function sourcePath(ctx:TaskContext):Promise<string>{
  const value=ctx.options.path;if(value!==undefined){if(ctx.upload)throw new Error('Legacy path input cannot be combined with an upload');if(typeof value!=='string'||!path.isAbsolute(value))throw new Error('Legacy analysis requires an uploaded file or absolute local path');
  const original=await lstat(value);if(original.isSymbolicLink())throw new Error('Legacy path must not be a symbolic link or junction');
  if(ctx.inputSnapshotPath){
    if(path.resolve(value)!==path.resolve(ctx.inputSnapshotPath))throw new Error('Legacy input snapshot binding mismatch');const snapshotRoot=path.resolve(ctx.dataDir,'tasks',ctx.taskId,'input-snapshot');const snapshot=path.resolve(ctx.inputSnapshotPath);if(!isWithin(snapshotRoot,snapshot))throw new Error('Legacy input snapshot is outside the task snapshot root');
    const rootIdentity=await lstat(snapshotRoot);if(rootIdentity.isSymbolicLink()||(!rootIdentity.isFile()&&!rootIdentity.isDirectory()))throw new Error('Legacy input snapshot root is not a regular file or directory');const resolved=await realpath(snapshot);const resolvedRoot=await realpath(snapshotRoot);if(!isWithin(resolvedRoot,resolved))throw new Error('Legacy input snapshot resolves outside the task snapshot root');return resolved;
  }
  return allowedLegacyPath(value);
  }
  if(ctx.upload)return uploadPath(ctx);
  throw new Error('Legacy analysis requires an uploaded file or absolute local path');
}
async function freePort():Promise<number>{return new Promise((resolve,reject)=>{const server=createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const address=server.address();if(!address||typeof address==='string'){server.close();reject(new Error('No port'));return}server.close(error=>error?reject(error):resolve(address.port));});});}
async function stopChild(child:ReturnType<typeof spawn>):Promise<void>{if(!child.pid||child.exitCode!==null||child.signalCode!==null)return;if(process.platform==='win32'){const killer=spawn('taskkill',['/pid',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});await new Promise<void>(resolve=>{killer.once('error',()=>{child.kill();resolve();});killer.once('close',()=>resolve());});}else{try{process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}}await new Promise<void>(resolve=>{const timer=setTimeout(()=>{child.off('close',onClose);resolve();},3000);const onClose=()=>{clearTimeout(timer);resolve();};child.once('close',onClose);});}

export const legacyAdapter=defineAdapter({
  name:'legacy',version:'1.0.0',description:'Read-only legacy software identification, compatibility and legal license diagnostics, data recovery and independent reconstruction; never executes the original program.',
  available:async()=>({available:true,detail:'Built-in bounded local analyzer; external runtimes are recommendations only'}),
  validateInput:async ctx=>{if(ctx.options.path!==undefined){if(ctx.upload)throw new Error('Legacy path input cannot be combined with an upload');await allowedLegacyPath(ctx.options.path);}},
  detect:async ctx=>{const source=await sourcePath(ctx);const analysis=await analyzeLegacySoftware(source,{signal:ctx.signal});return{adapter:'legacy',confidence:analysis.profile.evidenceStatus==='EVIDENCE'?0.9:0.2,format:analysis.profile.formats.join(',')||'unknown',details:{name:analysis.profile.name,architecture:analysis.profile.architecture},limitations:analysis.profile.limitations};},
  prepare:async ctx=>({sourcePath:await sourcePath(ctx),execution:'disabled'}),
  analyze:async ctx=>analyzeLegacySoftware(await sourcePath(ctx),{signal:ctx.signal}),
  extractEvidence:async ctx=>{
    const analysis=output<LegacyAnalysis>(ctx,'ANALYZE');await ctx.evidence('EVIDENCE','Legacy software profile','legacy-static','profile',analysis.profile);await ctx.evidence('INFERENCE','Compatibility and license diagnostics','legacy-rules','compatibility',analysis.profile.compatibility);await ctx.evidence('VERIFIED','Local privacy boundary','legacy-privacy','privacy',analysis.privacy);await ctx.writeArtifact('legacy-profile.json',JSON.stringify(analysis,null,2),'application/json');return{evidenceCount:3,artifacts:['legacy-profile.json']};
  },
  reconstruct:async ctx=>{
    const analysis=output<LegacyAnalysis>(ctx,'ANALYZE');const input=ctx.options.reconstruction;
    if(ctx.options.recover===true){const outputDir=path.join(ctx.dataDir,'tasks',ctx.taskId,'recovered-data');const result=await recoverLegacyData(analysis.profile.sourcePath,{outputDir,signal:ctx.signal});await ctx.writeArtifact('recovery-manifest.json',JSON.stringify(result,null,2),'application/json');return result;}
    if(!input||typeof input!=='object'||Array.isArray(input))return{reconstructed:false,reason:'No independent reconstruction requested'};
    const value=input as Record<string,unknown>;const kind=value.kind;if(kind!=='ini-editor'&&kind!=='csv-viewer'&&kind!=='text-tool'&&kind!=='data-converter')throw new Error('Unsupported reconstruction kind');
    const requirements=value.requirements;if(!Array.isArray(requirements)||requirements.length<1||requirements.length>32||requirements.some(item=>typeof item!=='string'||!item.trim()||item.length>500))throw new Error('requirements must contain 1-32 bounded strings');
    const spec=createReconstructionSpec({kind,name:typeof value.name==='string'?value.name:analysis.profile.name,requirements:requirements as string[],profile:analysis.profile});const project=generateReconstructionProject(spec);const destination=path.join(ctx.dataDir,'tasks',ctx.taskId,'reconstruction');const files=await writeReconstructionProject(project,destination);await ctx.writeArtifact('reconstruction.json',JSON.stringify({spec,files,outputPath:destination},null,2),'application/json');return{spec,files,outputPath:destination};
  },
  validate:async ctx=>{
    const analysis=output<LegacyAnalysis>(ctx,'ANALYZE');const reconstruction=ctx.stageOutputs.RECONSTRUCT as {outputPath?:string;spec?:LegacyReconstructionSpec}|undefined;const checks:Array<{name:string;passed:boolean;detail:string}>=[{name:'read-only source analysis',passed:analysis.profile.evidenceStatus==='EVIDENCE',detail:analysis.profile.formats.join(',')||'UNKNOWN'},{name:'original execution disabled',passed:true,detail:'No target process was started'}];
    if(reconstruction?.outputPath&&reconstruction.spec){try{await run(process.execPath,['--test'],{cwd:reconstruction.outputPath,timeout:60_000,windowsHide:true,env:minimalEnv()});checks.push({name:'generated project tests',passed:true,detail:'node --test tests'});}catch(error){checks.push({name:'generated project tests',passed:false,detail:error instanceof Error?error.message:String(error)});}
      try{const port=await freePort();const child=spawn(process.execPath,['server.mjs'],{cwd:reconstruction.outputPath,env:minimalEnv({PORT:String(port)}),stdio:'ignore',windowsHide:true,detached:process.platform!=='win32'});try{let ok=false;for(let attempt=0;attempt<30;attempt++){ctx.signal.throwIfAborted();try{const response=await fetch(`http://127.0.0.1:${port}/`,{signal:AbortSignal.timeout(500)});if(response.ok){ok=true;break}}catch{}await new Promise(resolve=>setTimeout(resolve,100));}if(!ok)throw new Error('Generated web app did not start');checks.push({name:'generated app starts',passed:true,detail:`http://127.0.0.1:${port}`});}finally{await stopChild(child);}}catch(error){checks.push({name:'generated app starts',passed:false,detail:error instanceof Error?error.message:String(error)});}
    }
    return{passed:checks.every(check=>check.passed),checks,limitations:analysis.profile.limitations};
  },
});

import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { lstat, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { analyzeLegacySoftware, createReconstructionSpec, generateReconstructionProject, recoverLegacyData, writeReconstructionProject, type LegacyAnalysis, type LegacyReconstructionSpec } from '@reverse/legacy-revival';
import { TaskInputAuthorizationError, type TaskContext } from '@reverse/workflow';
import { defineAdapter, limitedRead, output, uploadPath } from './base.js';

export function minimalProcessEnv(overrides:NodeJS.ProcessEnv={}):NodeJS.ProcessEnv{const allowed=['PATH','PATHEXT','SystemRoot','SYSTEMROOT','COMSPEC','TEMP','TMP','HOME','USERPROFILE','APPDATA','LOCALAPPDATA','PROCESSOR_ARCHITECTURE','NUMBER_OF_PROCESSORS','ELECTRON_RUN_AS_NODE'];const env:NodeJS.ProcessEnv={};for(const key of allowed)if(process.env[key]!==undefined)env[key]=process.env[key];return{...env,...overrides};}
function isWithin(root:string,candidate:string):boolean{const relative=path.relative(root,candidate);return relative===''||(relative!=='..'&&!relative.startsWith(`..${path.sep}`)&&!path.isAbsolute(relative));}
async function allowedLegacyPath(value:unknown):Promise<string>{
  if(typeof value!=='string'||!path.isAbsolute(value))throw new Error('Legacy analysis requires an uploaded file or absolute local path');const original=await lstat(value);if(original.isSymbolicLink())throw new Error('Legacy path must not be a symbolic link or junction');
  const roots=(process.env.RE_LEGACY_ROOTS??'').split(path.delimiter).map(item=>item.trim()).filter(Boolean);if(!roots.length)throw new TaskInputAuthorizationError('RE_LEGACY_ROOTS must explicitly allow local software directories');const resolved=await realpath(value);const allowed=await Promise.all(roots.map(root=>realpath(root)));if(!allowed.some(root=>isWithin(root,resolved)))throw new TaskInputAuthorizationError('Legacy path is outside RE_LEGACY_ROOTS');return resolved;
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
async function stopChild(child:ChildProcess):Promise<void>{if(!child.pid||child.exitCode!==null||child.signalCode!==null)return;if(process.platform==='win32'){const killer=spawn('taskkill',['/pid',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});await new Promise<void>(resolve=>{killer.once('error',()=>{child.kill();resolve();});killer.once('close',()=>resolve());});}else{try{process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}}await new Promise<void>(resolve=>{const timer=setTimeout(()=>{child.off('close',onClose);resolve();},3000);const onClose=()=>{clearTimeout(timer);resolve();};child.once('close',onClose);});}

function runGeneratedTests(ctx:TaskContext,cwd:string):Promise<void>{
  return new Promise((resolve,reject)=>{
    let unregister:(()=>void)|undefined;let settled=false;let outputBytes=0;
    const child=spawn(process.execPath,['--test'],{cwd,windowsHide:true,env:minimalProcessEnv(),detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
    const finish=(error?:Error)=>{if(settled)return;settled=true;clearTimeout(timer);ctx.signal.removeEventListener('abort',onAbort);unregister?.();if(error)reject(error);else resolve();};
    const onAbort=()=>{void stopChild(child).finally(()=>finish(new DOMException('Generated project tests aborted','AbortError')));};
    const onOutput=(chunk:Buffer)=>{outputBytes+=chunk.length;if(outputBytes>1024*1024)void stopChild(child).finally(()=>finish(new Error('Generated project test output exceeded 1MB')));};
    child.stdout.on('data',onOutput);child.stderr.on('data',onOutput);
    child.once('error',error=>finish(error));child.once('close',code=>finish(code===0?undefined:new Error(`Generated project tests exited with code ${code??'unknown'}`)));
    const timer=setTimeout(()=>{void stopChild(child).finally(()=>finish(new Error('Generated project tests timeout')));},60_000);
    if(child.pid)unregister=ctx.registerProcess?.(child.pid);
    if(ctx.signal.aborted)onAbort();else ctx.signal.addEventListener('abort',onAbort,{once:true});
  });
}
export const legacyAdapter=defineAdapter({
  name:'legacy',version:'1.0.0',description:'Read-only legacy software identification, compatibility and legal license diagnostics, data recovery and independent reconstruction; never executes the original program.',
  available:async()=>({available:true,detail:'Built-in bounded local analyzer; external runtimes are recommendations only'}),
  validateInput:async ctx=>{if(ctx.options.path!==undefined){if(ctx.upload)throw new Error('Legacy path input cannot be combined with an upload');await allowedLegacyPath(ctx.options.path);}},
  detect:async ctx=>{const source=await sourcePath(ctx);const analysis=await analyzeLegacySoftware(source,{signal:ctx.signal});return{adapter:'legacy',confidence:analysis.profile.evidenceStatus==='EVIDENCE'?0.9:0.2,format:analysis.profile.formats.join(',')||'unknown',details:{name:analysis.profile.name,architecture:analysis.profile.architecture},limitations:analysis.profile.limitations};},
  prepare:async ctx=>({sourcePath:await sourcePath(ctx),execution:'disabled'}),
  analyze:async ctx=>{const analysis=await analyzeLegacySoftware(await sourcePath(ctx),{signal:ctx.signal});return {...analysis,profile:{...analysis.profile,sourcePath:path.basename(analysis.profile.sourcePath)}};},
  extractEvidence:async ctx=>{
    const analysis=output<LegacyAnalysis>(ctx,'ANALYZE');await ctx.evidence('EVIDENCE','Legacy software profile','legacy-static','profile',analysis.profile);await ctx.evidence('INFERENCE','Compatibility and license diagnostics','legacy-rules','compatibility',analysis.profile.compatibility);await ctx.evidence('VERIFIED','Local privacy boundary','legacy-privacy','privacy',analysis.privacy);await ctx.writeArtifact('legacy-profile.json',JSON.stringify(analysis,null,2),'application/json');return{evidenceCount:3,artifacts:['legacy-profile.json']};
  },
  reconstruct:async ctx=>{
    const analysis=output<LegacyAnalysis>(ctx,'ANALYZE');const input=ctx.options.reconstruction;
    if(ctx.options.recover===true){
      const outputDir=path.join(ctx.dataDir,'tasks',ctx.taskId,'recovered-data');
      try{
        const result=await recoverLegacyData(await sourcePath(ctx),{outputDir,signal:ctx.signal});
        const entries=[] as {name:string;content:string|Uint8Array;mime:string}[];
        for(const file of result.files){
          if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(file.name)||file.size>32*1024*1024+1)throw new Error('Recovered artifact metadata is invalid');
          const content=await limitedRead(path.join(outputDir,file.name),32*1024*1024+1);
          if(content.byteLength!==file.size||createHash('sha256').update(content).digest('hex')!==file.sha256)throw new Error('Recovered artifact changed before publication');
          entries.push({name:file.name,content,mime:file.name.endsWith('.csv')?'text/csv':'application/json'});
        }
        const managedPath=path.relative(ctx.dataDir,path.join(ctx.dataDir,'tasks',ctx.taskId,'artifacts')).split(path.sep).join('/');
        const publicResult={format:result.format,sourceSha256:result.sourceSha256,managedPath,artifact:`/api/tasks/${ctx.taskId}/artifacts/recovery-manifest.json`,records:result.records,fields:result.fields,preview:result.preview,files:result.files.map(file=>({...file,downloadUrl:`/api/tasks/${ctx.taskId}/artifacts/${file.name}`})),integrity:result.integrity,limitations:result.limitations,evidenceStatus:result.evidenceStatus,truncated:result.truncated};
        entries.push({name:'recovery-manifest.json',content:JSON.stringify(publicResult,null,2),mime:'application/json'});
        if(ctx.writeArtifacts)await ctx.writeArtifacts(entries);else for(const entry of entries)await ctx.writeArtifact(entry.name,entry.content,entry.mime);
        return publicResult;
      }finally{await rm(outputDir,{recursive:true,force:true});}
    }
    if(!input||typeof input!=='object'||Array.isArray(input))return{reconstructed:false,reason:'No independent reconstruction requested'};
    const value=input as Record<string,unknown>;const kind=value.kind;if(kind!=='ini-editor'&&kind!=='csv-viewer'&&kind!=='text-tool'&&kind!=='data-converter')throw new Error('Unsupported reconstruction kind');
    const requirements=value.requirements;if(!Array.isArray(requirements)||requirements.length<1||requirements.length>32||requirements.some(item=>typeof item!=='string'||!item.trim()||item.length>500))throw new Error('requirements must contain 1-32 bounded strings');
    const spec=createReconstructionSpec({kind,name:typeof value.name==='string'?value.name:analysis.profile.name,requirements:requirements as string[],profile:analysis.profile});const project=generateReconstructionProject(spec);const destination=path.join(ctx.dataDir,'tasks',ctx.taskId,'reconstruction');const files=await writeReconstructionProject(project,destination);await ctx.writeArtifact('reconstruction.json',JSON.stringify({spec,files,managedPath:path.relative(ctx.dataDir,destination).split(path.sep).join('/')},null,2),'application/json');return{spec,files,outputPath:destination};
  },
  validate:async ctx=>{
    const analysis=output<LegacyAnalysis>(ctx,'ANALYZE');const reconstruction=ctx.stageOutputs.RECONSTRUCT as {outputPath?:string;spec?:LegacyReconstructionSpec}|undefined;const checks:Array<{name:string;passed:boolean;detail:string}>=[{name:'read-only source analysis',passed:analysis.profile.evidenceStatus==='EVIDENCE',detail:analysis.profile.formats.join(',')||'UNKNOWN'},{name:'original execution disabled',passed:true,detail:'No target process was started'}];
    if(reconstruction?.outputPath&&reconstruction.spec){try{await runGeneratedTests(ctx,reconstruction.outputPath);checks.push({name:'generated project tests',passed:true,detail:'node --test tests'});}catch(error){checks.push({name:'generated project tests',passed:false,detail:error instanceof Error?error.message:String(error)});}
      try{ctx.signal.throwIfAborted();const port=await freePort();const child=spawn(process.execPath,['server.mjs'],{cwd:reconstruction.outputPath,env:minimalProcessEnv({PORT:String(port)}),stdio:'ignore',windowsHide:true,detached:process.platform!=='win32'});const unregister=child.pid?ctx.registerProcess?.(child.pid):undefined;try{let ok=false;for(let attempt=0;attempt<30;attempt++){ctx.signal.throwIfAborted();try{const response=await fetch(`http://127.0.0.1:${port}/`,{signal:AbortSignal.timeout(500)});if(response.ok){ok=true;break}}catch{}await new Promise(resolve=>setTimeout(resolve,100));}if(!ok)throw new Error('Generated web app did not start');checks.push({name:'generated app starts',passed:true,detail:`http://127.0.0.1:${port}`});}finally{await stopChild(child);unregister?.();}}catch(error){checks.push({name:'generated app starts',passed:false,detail:error instanceof Error?error.message:String(error)});}
    }
    return{passed:checks.every(check=>check.passed),checks,limitations:analysis.profile.limitations};
  },
});

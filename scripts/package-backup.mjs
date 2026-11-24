import { createHash } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const DATABASE_NAME='reverse-everything.sqlite';

function missing(error){return error&&typeof error==='object'&&'code' in error&&error.code==='ENOENT';}
async function hashFile(file){const hash=createHash('sha256');for await(const chunk of (await import('node:fs')).createReadStream(file))hash.update(chunk);return hash.digest('hex');}
async function inspectRoot(dataDir){const info=await lstat(dataDir);if(info.isSymbolicLink()||!info.isDirectory())throw new Error('Backup dataDir must be a real directory, not a symbolic link');}
async function inspectPath(dataDir,relative,kind,required=true){
  const segments=relative.split(/[\\/]/).filter(Boolean);let current=dataDir;
  for(const [index,segment] of segments.entries()){
    current=path.join(current,segment);let info;
    try{info=await lstat(current);}catch(error){if(missing(error)&&!required)return undefined;throw error;}
    if(info.isSymbolicLink())throw new Error(`Refusing symbolic link in backup source: ${relative}`);
    if(index<segments.length-1&&!info.isDirectory())throw new Error(`Backup source parent is not a directory: ${relative}`);
    if(index===segments.length-1){if(kind==='file'&&!info.isFile())throw new Error(`Backup source is not a regular file: ${relative}`);if(kind==='directory'&&!info.isDirectory())throw new Error(`Backup source is not a directory: ${relative}`);}
  }
  return current;
}
async function collectTree(dataDir,relative){
  const directory=await inspectPath(dataDir,relative,'directory',false);if(!directory)return [];
  const files=[];
  async function walk(dir,prefix){const entries=await readdir(dir,{withFileTypes:true});for(const entry of entries){const child=path.join(dir,entry.name);const childRelative=prefix?`${prefix}/${entry.name}`:entry.name;if(entry.isSymbolicLink())throw new Error(`Refusing symbolic link in backup source: ${childRelative}`);if(entry.isDirectory()){await walk(child,childRelative);continue;}const info=await lstat(child);if(!info.isFile())throw new Error(`Backup source is not a regular file: ${childRelative}`);files.push(childRelative);}}
  await walk(directory,relative);return files.sort();
}
async function snapshotDatabase(dataDir,workDir){
  const source=await inspectPath(dataDir,DATABASE_NAME,'file');const snapshot=path.join(workDir,DATABASE_NAME);const raw=new DatabaseSync(source,{readOnly:true,enableForeignKeyConstraints:true});
  try{raw.exec('PRAGMA busy_timeout=10000;');raw.prepare('VACUUM INTO ?').run(snapshot);}finally{raw.close();}
  const check=new DatabaseSync(snapshot,{readOnly:true});try{const rows=check.prepare('PRAGMA quick_check').all();if(rows.length!==1||rows[0]?.quick_check!=='ok')throw new Error('Database snapshot failed quick_check');}finally{check.close();}
  return snapshot;
}
async function sourceEntry(dataDir,relative,required=true){const source=await inspectPath(dataDir,relative,'file',required);if(!source)return undefined;const info=await stat(source);return {relative,source,sizeBytes:info.size,sha256:await hashFile(source)};}
function safeSegment(value,name){if(!/^[A-Za-z0-9._-]+$/.test(value))throw new Error(`Unsafe ${name}`);return value;}

export async function packageBackup({dataDir,releaseDir,confirm=false,version='0.0.0',timestamp=new Date().toISOString().replace(/[-:.TZ]/g,'')}){
  dataDir=path.resolve(dataDir);releaseDir=path.resolve(releaseDir);version=safeSegment(version,'version');timestamp=safeSegment(timestamp,'timestamp');await inspectRoot(dataDir);
  const required=[await sourceEntry(dataDir,'secret.key'),await sourceEntry(dataDir,'local-token')];if(required.some(entry=>!entry))throw new Error('Backup requires secret.key and local-token');
  const trees=[];for(const relative of ['tasks','uploads'])trees.push(...await collectTree(dataDir,relative));const treeEntries=[];for(const relative of trees){const entry=await sourceEntry(dataDir,relative);if(entry)treeEntries.push(entry);}
  const workDir=await mkdtemp(path.join(os.tmpdir(),'re-package-backup-'));
  try{
    const snapshot=await snapshotDatabase(dataDir,workDir);const snapshotInfo=await stat(snapshot);const entries=[{relative:DATABASE_NAME,source:snapshot,sizeBytes:snapshotInfo.size,sha256:await hashFile(snapshot)},...required,...treeEntries].sort((a,b)=>a.relative.localeCompare(b.relative));
    const files=entries.map(({relative,sizeBytes,sha256})=>({path:relative,sizeBytes,sha256}));const totalBytes=files.reduce((sum,file)=>sum+file.sizeBytes,0);
    if(!confirm)return {dryRun:true,dataDir,version,files,totalBytes};
    await mkdir(releaseDir,{recursive:true});const name=`reverse-everything-backup-${version}-${timestamp}`;const outputDir=path.join(releaseDir,name);await mkdir(outputDir,{mode:0o700});const archivePath=path.join(releaseDir,`${name}.tar.gz`);
    try{
      for(const entry of entries){const destination=path.join(outputDir,...entry.relative.split('/'));await mkdir(path.dirname(destination),{recursive:true});await copyFile(entry.source,destination);await chmod(destination,0o600);const info=await stat(destination);const digest=await hashFile(destination);if(info.size!==entry.sizeBytes||digest!==entry.sha256)throw new Error(`Backup copy changed while packaging: ${entry.relative}`);}
      const sums=files.map(file=>`${file.sha256}  ${file.path}`).join('\n')+'\n';const sumsPath=path.join(outputDir,'SHA256SUMS');await writeFile(sumsPath,sums,{mode:0o600});const sumsInfo=await stat(sumsPath);const outputFiles=[...files,{path:'SHA256SUMS',sizeBytes:sumsInfo.size,sha256:await hashFile(sumsPath)}];
      const archiveHandle=await open(archivePath,'wx',0o600);await archiveHandle.close();await chmod(archivePath,0o600);
      const archived=spawnSync('tar',['-czf',path.basename(archivePath),'-C',releaseDir,name],{cwd:releaseDir,encoding:'utf8'});if(archived.status!==0)throw new Error(`Backup archive failed: ${String(archived.stderr??archived.error??'unknown tar error').trim()}`);
      await chmod(archivePath,0o600);const archiveInfo=await stat(archivePath);return {dryRun:false,dataDir,version,outputDir,archive:{path:archivePath,sizeBytes:archiveInfo.size,sha256:await hashFile(archivePath)},files:outputFiles,totalBytes:outputFiles.reduce((sum,file)=>sum+file.sizeBytes,0)};
    }catch(error){await rm(outputDir,{recursive:true,force:true});await rm(archivePath,{force:true});throw error;}
  }finally{await rm(workDir,{recursive:true,force:true});}
}

export function parseBackupArgs(args){
  const options={dataDir:process.env.RE_DATA_DIR??path.join(ROOT,'data'),releaseDir:path.join(ROOT,'dist/release'),confirm:false};
  for(let index=0;index<args.length;index++){
    const arg=args[index];
    if(arg==='--confirm'){const value=args[++index];if(value!=='BACKUP')throw new Error('Actual backup requires exact --confirm BACKUP');options.confirm=true;continue;}
    if(arg==='--data-dir'||arg==='--out-dir'){const value=args[++index];if(!value)throw new Error(`${arg} requires a path`);if(arg==='--data-dir')options.dataDir=value;else options.releaseDir=value;continue;}
    throw new Error(`Unknown backup argument: ${arg}`);
  }
  return options;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const options=parseBackupArgs(process.argv.slice(2));const pkg=JSON.parse(await readFile(path.join(ROOT,'package.json'),'utf8'));const report=await packageBackup({...options,version:pkg.version});console.log(JSON.stringify(report,null,2));}
  catch(error){console.error(error instanceof Error?error.message:String(error));process.exitCode=1;}
}

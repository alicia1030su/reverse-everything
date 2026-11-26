import { randomUUID } from 'node:crypto';
import { realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { AppError, type GameEvidenceStatus, type GameProfile, type GameRebuildRecord, type GameRevivalLevel } from '@reverse/contracts';
import { createGameServerSpec, generateGameServer, scanGameDirectory, validateGeneratedServer, type EvidenceStatus, type GameFileRecord, type GameObservation, type GameValidationReport } from '@reverse/game-revival';
import type { Database } from '@reverse/workflow';
import { archiveDigest, zipDirectory } from './game-archive.js';

interface Options { db: Database; dataDir: string }
interface ProfileRow { id:string; project_id:string; name:string; genre:string; publisher:string; region:string; client_version:string; shutdown_date:string; engine:string; source_text:string; authorization_scope:string; known_protocols_json:string; retained_materials_json:string; existing_implementations_json:string; level:string; unrecovered_features_json:string; root_path:string|null; created_at:string; updated_at:string }
interface StoredFile { path:string; size:number; mtime_ms:number; ctime_ms:number|null; dev:string|number|null; ino:string|number|null; sha256:string; kind:string }
const MAX_SCANS = 2;
const MAX_REBUILDS = 1;
const MAX_ARCHIVES = 2;
const EVIDENCE_STATUSES = new Set<EvidenceStatus>(['OBSERVED', 'INFERRED', 'VERIFIED', 'UNKNOWN', 'INACCESSIBLE', 'NOT_IMPLEMENTED']);
const OBSERVATION_KINDS = new Set(['fps', 'rpg', 'map', 'rule', 'engine', 'client']);

function project(db:Database,id:string){const value=db.getProject(id);if(!value)throw new AppError('NOT_FOUND','Project not found',404);return value;}
function body(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw new AppError('BAD_REQUEST','A JSON object body is required',400);return value as Record<string,unknown>;}
function text(value:Record<string,unknown>,key:string,max=2048):string{const item=value[key];if(typeof item!=='string'||!item.trim()||item.length>max)throw new AppError('BAD_REQUEST',`${key} must be a non-empty bounded string`,400);return item.trim();}
function strings(value:Record<string,unknown>,key:string):string[]{const item=value[key];if(!Array.isArray(item)||item.length>64||item.some(v=>typeof v!=='string'||!v.trim()||v.length>512))throw new AppError('BAD_REQUEST',`${key} must be a bounded string array`,400);return item as string[];}
function optionalText(value:Record<string,unknown>,key:string,max=2048):string{const item=value[key];if(item===undefined||item==='')return '';if(typeof item!=='string'||item.length>max)throw new AppError('BAD_REQUEST',`${key} must be a bounded string`,400);return item.trim();}
function profile(row:ProfileRow):GameProfile{return{id:row.id,projectId:row.project_id,name:row.name,genre:row.genre,publisher:row.publisher,region:row.region,clientVersion:row.client_version,shutdownDate:row.shutdown_date,engine:row.engine,source:row.source_text,authorizationScope:row.authorization_scope,knownProtocols:JSON.parse(row.known_protocols_json),retainedMaterials:JSON.parse(row.retained_materials_json),existingImplementations:JSON.parse(row.existing_implementations_json),level:row.level as GameRevivalLevel,unrecoveredFeatures:JSON.parse(row.unrecovered_features_json),...(row.root_path?{rootPath:row.root_path}:{}),createdAt:row.created_at,updatedAt:row.updated_at};}
function profileRow(db:Database,id:string):ProfileRow{const row=db.raw.prepare('SELECT * FROM game_profiles WHERE id=?').get(id) as unknown as ProfileRow|undefined;if(!row)throw new AppError('NOT_FOUND','Game profile not found',404);return row;}
function rebuild(row:Record<string,unknown>):GameRebuildRecord{return{id:String(row.id),projectId:String(row.project_id),specId:String(row.spec_id),status:String(row.status) as GameRebuildRecord['status'],level:String(row.level) as GameRevivalLevel,outputPath:row.output_path?String(row.output_path):null,error:row.error?String(row.error):null,validation:row.validation_json?JSON.parse(String(row.validation_json)):null,createdAt:String(row.created_at),updatedAt:String(row.updated_at)};}
function requireRebuild(db:Database,id:string){const row=db.raw.prepare('SELECT * FROM game_rebuilds WHERE id=?').get(id) as Record<string,unknown>|undefined;if(!row)throw new AppError('NOT_FOUND','Game rebuild not found',404);return row;}
async function gameRoot(value:string):Promise<string>{if(!path.isAbsolute(value))throw new AppError('BAD_REQUEST','Game rootPath must be an absolute local path',400);let resolved:string;try{resolved=await realpath(value);}catch{throw new AppError('NOT_FOUND','Game rootPath does not exist or is inaccessible',404);}if(resolved===path.parse(resolved).root)throw new AppError('BAD_REQUEST','Refusing to scan a filesystem root',400);const allowed=process.env.RE_GAME_ROOTS?.split(path.delimiter).map(item=>item.trim()).filter(Boolean);if(!allowed?.length)throw new AppError('FORBIDDEN','RE_GAME_ROOTS must explicitly allow local game directories before scanning',403);const roots=await Promise.all(allowed.map(async item=>{try{return await realpath(item);}catch{throw new AppError('INTERNAL_ERROR','RE_GAME_ROOTS contains an inaccessible path',500);}}));if(!roots.some(root=>{const relative=path.relative(root,resolved);return relative===''||(!relative.startsWith('..')&&!path.isAbsolute(relative));}))throw new AppError('FORBIDDEN','Game rootPath is outside RE_GAME_ROOTS',403);return resolved;}

function observations(value:unknown):GameObservation[]{
  if(value===undefined)return[];
  if(!Array.isArray(value)||value.length>64)throw new AppError('BAD_REQUEST','observations must be a bounded array',400);
  return value.map(item=>{
    if(!item||typeof item!=='object'||Array.isArray(item))throw new AppError('BAD_REQUEST','Each observation must be an object',400);
    const input=item as Record<string,unknown>;
    if(Object.keys(input).some(key=>!['kind','value','ref','detail','status'].includes(key)))throw new AppError('BAD_REQUEST','Observation contains an unknown field',400);
    if(typeof input.kind!=='string'||!OBSERVATION_KINDS.has(input.kind))throw new AppError('BAD_REQUEST','Invalid observation kind',400);
    const ref=text(input,'ref',2048),detail=text(input,'detail',4096);
    if(input.status!==undefined&&(typeof input.status!=='string'||!EVIDENCE_STATUSES.has(input.status as EvidenceStatus)))throw new AppError('BAD_REQUEST','Invalid observation evidence status',400);
    let observationValue:GameObservation['value'];
    if(input.value!==undefined){
      const scalar=(value:unknown):value is string|number|boolean=>typeof value==='string'?value.length<=2048:typeof value==='number'?Number.isFinite(value):typeof value==='boolean';
      if(Array.isArray(input.value)||input.value===null||(typeof input.value==='object'&&(Object.keys(input.value).length>64||Object.values(input.value).some(value=>!scalar(value)))))throw new AppError('BAD_REQUEST','Observation value must be bounded scalar data',400);
      if(!scalar(input.value)&&typeof input.value!=='object')throw new AppError('BAD_REQUEST','Invalid observation value',400);
      observationValue=input.value as GameObservation['value'];
    }
    const requested=input.status as EvidenceStatus|undefined;
    const status=requested==='OBSERVED'||requested==='VERIFIED'?'INFERRED':requested==='NOT_IMPLEMENTED'||requested==='INACCESSIBLE'?'UNKNOWN':requested;
    return {kind:input.kind as GameObservation['kind'],ref,detail,...(observationValue!==undefined?{value:observationValue}:{}),...(status?{status}:{})};
  });
}

function storedFiles(db:Database,projectId:string):GameFileRecord[]{
  return (db.raw.prepare('SELECT path,size,mtime_ms,ctime_ms,dev,ino,sha256,kind FROM game_files WHERE project_id=?').all(projectId) as unknown as StoredFile[]).map(file=>({
    path:file.path,relativePath:file.path,size:file.size,mtimeMs:file.mtime_ms,...(file.ctime_ms!==null?{ctimeMs:file.ctime_ms}:{}),...(file.dev!==null?{dev:file.dev}:{}),...(file.ino!==null?{ino:file.ino}:{}),
    ...(file.sha256?{sha256:file.sha256}:{}),extension:path.extname(file.path).toLowerCase(),evidenceStatus:'INFERRED',evidenceRefs:[{path:file.path,detail:'来自上次扫描的增量文件指纹；本次生成规格未重读文件内容'}],
  }));
}

function specEvidenceStatus(spec:{files:GameFileRecord[];modules:Array<{evidenceStatus:EvidenceStatus}>;map:{evidenceStatus:EvidenceStatus};rules:{evidenceStatus:EvidenceStatus}}):GameEvidenceStatus{
  const statuses=[...spec.modules.map(item=>item.evidenceStatus),spec.map.evidenceStatus,spec.rules.evidenceStatus];
  return statuses.some(status=>status==='OBSERVED'||status==='INFERRED'||status==='VERIFIED')?'INFERRED':'UNKNOWN';
}

function validationLevel(report:GameValidationReport):GameRevivalLevel{
  if(report.schemaVersion!==1||!report.valid)return 'L2';
  const c=report.capabilities;
  if(!c.build)return 'L2';
  if(!c.independentStart||!c.adminAuth)return 'L4';
  if(!c.twoPlayerSameMatch||!c.roomIsolation||!c.serverAuthoritativeState)return 'L5';
  if(!c.persistence||!c.reconnect||!c.settlement||!c.multiRoomConcurrency)return 'L6';
  if(!c.dockerDeployment)return 'L6';
  return 'L7';
}

function rebuildTimeout():number{
  const parsed=Number(process.env.RE_GAME_REBUILD_TIMEOUT_MS??900_000);
  if(!Number.isSafeInteger(parsed))throw new AppError('INTERNAL_ERROR','RE_GAME_REBUILD_TIMEOUT_MS must be an integer',500);
  return Math.min(3_600_000,Math.max(1_000,parsed));
}

function nextTimestamp(previous?:string):string{
  const previousMs=previous?Date.parse(previous):0;
  return new Date(Math.max(Date.now(),Number.isFinite(previousMs)?previousMs+1:0)).toISOString();
}
async function canonicalPath(value:string):Promise<string>{try{return await realpath(value);}catch{return path.resolve(value);}}
function samePath(left:string|null|undefined,right:string|null|undefined):boolean{if(!left||!right)return left===right;const a=path.resolve(left),b=path.resolve(right);return process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;}

export function registerGameRevivalRoutes(app:FastifyInstance,options:Options):void{
  const {db,dataDir}=options;
  const columns=db.raw.prepare('PRAGMA table_info(game_files)').all() as Array<{name:string}>;
  for(const [name,type] of [['ctime_ms','REAL'],['dev','INTEGER'],['ino','INTEGER']] as const)if(!columns.some(column=>column.name===name))db.raw.exec(`ALTER TABLE game_files ADD COLUMN ${name} ${type}`);
  db.raw.prepare("UPDATE game_profiles SET level='L2',updated_at=? WHERE id IN (SELECT project_id FROM game_rebuilds WHERE status='RUNNING')").run(new Date().toISOString());
  db.raw.prepare("UPDATE game_rebuilds SET status='FAILED',error='API restarted before rebuild completion',updated_at=? WHERE status='RUNNING'").run(new Date().toISOString());
  let activeScans=0,activeRebuilds=0,activeArchives=0,closing=false;
  const shutdown=new AbortController();
  const background=new Set<Promise<void>>();
  const rebuildControllers=new Map<string,AbortController>();
  const profileRevisions=new Map<string,number>();
  const scanRevisions=new Map<string,number>();
  const track=<T>(operation:Promise<T>):Promise<T>=>{const settled=operation.then(()=>undefined,()=>undefined);background.add(settled);void settled.then(()=>background.delete(settled));return operation;};
  const clearProjectEvidence=(projectId:string):void=>{
    db.raw.prepare('DELETE FROM game_rebuilds WHERE project_id=?').run(projectId);
    db.raw.prepare('DELETE FROM game_specs WHERE project_id=?').run(projectId);
    db.raw.prepare('DELETE FROM game_files WHERE project_id=?').run(projectId);
  };
  app.addHook('preClose',async()=>{closing=true;shutdown.abort(new Error('API is closing'));});
  app.addHook('onClose',async()=>{await Promise.allSettled([...background]);});
  app.get('/api/game/profiles',async()=>({items:(db.raw.prepare('SELECT * FROM game_profiles ORDER BY updated_at DESC').all() as unknown as ProfileRow[]).map(profile)}));
  app.put<{Params:{id:string}}>('/api/projects/:id/game-profile',async req=>{
    const current=project(db,req.params.id);if(current.kind!=='game')throw new AppError('BAD_REQUEST','Project is not a game research project',400);const input=body(req.body);const id=randomUUID();
    const values=[text(input,'name',120),text(input,'genre',32),optionalText(input,'publisher',120),optionalText(input,'region',120),optionalText(input,'clientVersion',120),optionalText(input,'shutdownDate',64),optionalText(input,'engine',120),text(input,'source',2048),text(input,'authorizationScope',4096),JSON.stringify(strings(input,'knownProtocols')),JSON.stringify(strings(input,'retainedMaterials')),JSON.stringify(strings(input,'existingImplementations')),'L0',JSON.stringify(strings(input,'unrecoveredFeatures')),input.rootPath===undefined?null:text(input,'rootPath',4096)];
    const rootPath=values[values.length-1] as string|null,canonicalRootPath=rootPath?await canonicalPath(rootPath):null;let obsoleteOutputs:string[]=[];
    db.raw.exec('BEGIN IMMEDIATE');
    try{
      const saved=db.raw.prepare('SELECT * FROM game_profiles WHERE project_id=?').get(current.id) as unknown as ProfileRow|undefined;
      const rootChanged=!samePath(saved?.root_path??null,canonicalRootPath),now=nextTimestamp(saved?.updated_at);
      if(rootChanged){
        rebuildControllers.get(current.id)?.abort(new Error('Game profile rootPath changed'));
        obsoleteOutputs=(db.raw.prepare('SELECT output_path FROM game_rebuilds WHERE project_id=? AND output_path IS NOT NULL').all(current.id) as Array<{output_path:string}>).map(item=>item.output_path);
        clearProjectEvidence(current.id);
      }
      db.raw.prepare(`INSERT INTO game_profiles (id,project_id,name,genre,publisher,region,client_version,shutdown_date,engine,source_text,authorization_scope,known_protocols_json,retained_materials_json,existing_implementations_json,level,unrecovered_features_json,root_path,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET name=excluded.name,genre=excluded.genre,publisher=excluded.publisher,region=excluded.region,client_version=excluded.client_version,shutdown_date=excluded.shutdown_date,engine=excluded.engine,source_text=excluded.source_text,authorization_scope=excluded.authorization_scope,known_protocols_json=excluded.known_protocols_json,retained_materials_json=excluded.retained_materials_json,existing_implementations_json=excluded.existing_implementations_json,unrecovered_features_json=excluded.unrecovered_features_json,root_path=excluded.root_path,level=CASE WHEN ? THEN excluded.level ELSE game_profiles.level END,updated_at=excluded.updated_at`).run(id,current.id,...values,now,now,rootChanged?1:0);
      db.raw.exec('COMMIT');
    }catch(error){db.raw.exec('ROLLBACK');throw error;}
    profileRevisions.set(current.id,(profileRevisions.get(current.id)??0)+1);
    await Promise.allSettled(obsoleteOutputs.map(output=>rm(output,{recursive:true,force:true})));
    const row=db.raw.prepare('SELECT * FROM game_profiles WHERE project_id=?').get(current.id) as unknown as ProfileRow;return{profile:profile(row)};
  });
  app.get<{Params:{id:string}}>('/api/projects/:id/game-profile',async req=>{project(db,req.params.id);const row=db.raw.prepare('SELECT * FROM game_profiles WHERE project_id=?').get(req.params.id) as unknown as ProfileRow|undefined;if(!row)throw new AppError('NOT_FOUND','Game profile not found',404);return{profile:profile(row)};});
  app.post<{Params:{id:string}}>('/api/projects/:id/game-scan',async req=>{
    const current=project(db,req.params.id);if(current.kind!=='game')throw new AppError('BAD_REQUEST','Project is not a game research project',400);const saved=profileRow(db,(db.raw.prepare('SELECT id FROM game_profiles WHERE project_id=?').get(current.id) as {id:string}|undefined)?.id??'');const input=body(req.body);const requested=input.rootPath===undefined?saved.root_path:text(input,'rootPath',4096);if(!requested)throw new AppError('BAD_REQUEST','rootPath is required',400);
    if(closing)throw new AppError('QUEUE_FULL','API is closing',503);
    if(activeScans>=MAX_SCANS)throw new AppError('RATE_LIMITED','Too many concurrent game scans',429);
    activeScans+=1;
    const profileRevision=profileRevisions.get(current.id)??0;
    const scanRevision=(scanRevisions.get(current.id)??0)+1;scanRevisions.set(current.id,scanRevision);
    const operation=(async()=>{
      const root=await gameRoot(requested),sameRoot=saved.root_path===root;
      const result=await scanGameDirectory(root,{signal:AbortSignal.any([req.signal,shutdown.signal]),previous:sameRoot?storedFiles(db,current.id):[]});AbortSignal.any([req.signal,shutdown.signal]).throwIfAborted();
      let obsoleteOutputs:string[]=[];const now=nextTimestamp(saved.updated_at);db.raw.exec('BEGIN IMMEDIATE');
      try{
        const latest=db.raw.prepare('SELECT * FROM game_profiles WHERE project_id=?').get(current.id) as unknown as ProfileRow|undefined;
        if(!latest||latest.root_path!==saved.root_path||(profileRevisions.get(current.id)??0)!==profileRevision||(scanRevisions.get(current.id)??0)!==scanRevision)throw new AppError('CONFLICT','Game profile or a newer scan changed while the scan was running',409);
        db.raw.prepare('DELETE FROM game_files WHERE project_id=?').run(current.id);
        if(!sameRoot){
          rebuildControllers.get(current.id)?.abort(new Error('Game scan rootPath changed'));
          obsoleteOutputs=(db.raw.prepare('SELECT output_path FROM game_rebuilds WHERE project_id=? AND output_path IS NOT NULL').all(current.id) as Array<{output_path:string}>).map(item=>item.output_path);
          clearProjectEvidence(current.id);
        }
        const insert=db.raw.prepare('INSERT INTO game_files (project_id,path,size,mtime_ms,ctime_ms,dev,ino,sha256,kind,scanned_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
        for(const file of result.files){const scanned=file as GameFileRecord&{ctimeMs:number;dev:number;ino:number};insert.run(current.id,file.relativePath,file.size,file.mtimeMs,scanned.ctimeMs,String(scanned.dev),String(scanned.ino),file.sha256??'',file.evidenceStatus,now);}
        const updated=db.raw.prepare("UPDATE game_profiles SET root_path=?,level='L1',updated_at=? WHERE project_id=? AND updated_at=?").run(root,now,current.id,saved.updated_at);if(updated.changes!==1)throw new AppError('CONFLICT','Game profile changed while the scan was running',409);db.raw.exec('COMMIT');
      }catch(error){db.raw.exec('ROLLBACK');throw error;}
      if(!sameRoot)profileRevisions.set(current.id,(profileRevisions.get(current.id)??0)+1);
      await Promise.allSettled(obsoleteOutputs.map(output=>rm(output,{recursive:true,force:true})));
      return result;
    })();
    track(operation);
    try{return await operation;}finally{activeScans-=1;}
  });
  app.post<{Params:{id:string}}>('/api/projects/:id/game-spec',async req=>{
    const current=project(db,req.params.id),saved=profileRow(db,(db.raw.prepare('SELECT id FROM game_profiles WHERE project_id=?').get(current.id) as {id:string}|undefined)?.id??''),input=body(req.body);
    const parsed=observations(input.observations),files=storedFiles(db,current.id);
    const spec=createGameServerSpec({name:saved.name,root:saved.root_path??'',genre:saved.genre==='fps'||saved.genre==='rpg'?saved.genre:'unknown',...(saved.engine?{engine:saved.engine}:{}),assets:[],observations:[],limitations:saved.authorization_scope?['Independent design requires validation']:[]},files,parsed);
    const id=randomUUID(),now=nextTimestamp(saved.updated_at),evidenceStatus=specEvidenceStatus(spec);db.raw.prepare('INSERT INTO game_specs (id,project_id,spec_json,evidence_status,created_at) VALUES (?,?,?,?,?)').run(id,current.id,JSON.stringify(spec),evidenceStatus,now);db.raw.prepare("UPDATE game_profiles SET level=?,updated_at=? WHERE project_id=?").run(spec.level,now,current.id);return{spec:{...spec,id,evidenceStatus}};
  });
  app.get<{Params:{id:string}}>('/api/projects/:id/game-specs',async req=>{project(db,req.params.id);return{items:(db.raw.prepare('SELECT * FROM game_specs WHERE project_id=? ORDER BY created_at DESC').all(req.params.id) as Record<string,unknown>[]).map(row=>({id:String(row.id),projectId:String(row.project_id),spec:JSON.parse(String(row.spec_json)),evidenceStatus:String(row.evidence_status),createdAt:String(row.created_at)}))};});
  app.post('/api/game/rebuilds',async(req,reply)=>{
    if(closing)throw new AppError('QUEUE_FULL','API is closing',503);
    const input=body(req.body),specId=text(input,'specId',128);const row=db.raw.prepare('SELECT * FROM game_specs WHERE id=?').get(specId) as Record<string,unknown>|undefined;if(!row)throw new AppError('NOT_FOUND','Game specification not found',404);
    const timeoutMs=rebuildTimeout();
    if(activeRebuilds>=MAX_REBUILDS)throw new AppError('QUEUE_FULL','A game rebuild is already running',503);
    activeRebuilds+=1;
    const projectId=String(row.project_id),id=randomUUID(),outputPath=path.join(dataDir,'revived-games',id);
    const previousProfile=db.raw.prepare('SELECT updated_at FROM game_profiles WHERE project_id=?').get(projectId) as {updated_at:string}|undefined;
    const now=nextTimestamp(previousProfile?.updated_at);
    try{db.raw.exec('BEGIN IMMEDIATE');db.raw.prepare("INSERT INTO game_rebuilds (id,project_id,spec_id,status,level,output_path,error,validation_json,created_at,updated_at) VALUES (?,?,?,'RUNNING','L2',?,NULL,NULL,?,?)").run(id,projectId,specId,outputPath,now,now);db.raw.prepare("UPDATE game_profiles SET level='L2',updated_at=? WHERE project_id=? AND updated_at=?").run(now,projectId,previousProfile?.updated_at??'');db.raw.exec('COMMIT');}catch(error){db.raw.exec('ROLLBACK');activeRebuilds-=1;throw error;}
    const controller=new AbortController(),signal=AbortSignal.any([controller.signal,shutdown.signal]);rebuildControllers.set(projectId,controller);
    const timer=setTimeout(()=>controller.abort(new Error(`Game rebuild exceeded ${timeoutMs}ms`)),timeoutMs);timer.unref();
    let report:GameValidationReport|undefined,generatedFiles:string[]=[];
    const operation=(async()=>{
      try{
        const spec=JSON.parse(String(row.spec_json));signal.throwIfAborted();const generated=await generateGameServer(spec,outputPath);generatedFiles=generated.files;signal.throwIfAborted();report=await validateGeneratedServer(outputPath,{signal});signal.throwIfAborted();const level=validationLevel(report),finished=new Date().toISOString();
        if(!report.valid)throw new Error('Generated server validation failed');
        db.raw.exec('BEGIN IMMEDIATE');
        try{
          const changed=db.raw.prepare("UPDATE game_rebuilds SET status='COMPLETED',level=?,validation_json=?,updated_at=? WHERE id=? AND status='RUNNING'").run(level,JSON.stringify({...report,files:generatedFiles}),finished,id);
          db.raw.prepare('UPDATE game_profiles SET level=?,updated_at=? WHERE project_id=? AND updated_at=?').run(level,finished,projectId,now);db.raw.exec('COMMIT');
          if(changed.changes===0)await rm(outputPath,{recursive:true,force:true});
        }catch(error){db.raw.exec('ROLLBACK');throw error;}
      }catch(error){
        const message=error instanceof Error?error.message:String(error);let cleanup='';
        try{await rm(outputPath,{recursive:true,force:true});}catch(cleanupError){cleanup=`; output cleanup failed: ${cleanupError instanceof Error?cleanupError.message:String(cleanupError)}`;}
        const finished=new Date().toISOString();db.raw.exec('BEGIN IMMEDIATE');
        try{db.raw.prepare("UPDATE game_rebuilds SET status='FAILED',level='L2',error=?,validation_json=?,updated_at=? WHERE id=? AND status='RUNNING'").run(`${message}${cleanup}`.slice(0,2000),report?JSON.stringify({...report,files:generatedFiles}):null,finished,id);db.raw.prepare("UPDATE game_profiles SET level='L2',updated_at=? WHERE project_id=? AND updated_at=?").run(finished,projectId,now);db.raw.exec('COMMIT');}catch(dbError){db.raw.exec('ROLLBACK');throw dbError;}
      }finally{clearTimeout(timer);activeRebuilds-=1;if(rebuildControllers.get(projectId)===controller)rebuildControllers.delete(projectId);}
    })();
    track(operation);
    return reply.code(202).send(rebuild(requireRebuild(db,id)));
  });
  app.get('/api/game/rebuilds',async()=>({items:(db.raw.prepare('SELECT * FROM game_rebuilds ORDER BY created_at DESC LIMIT 100').all() as Record<string,unknown>[]).map(rebuild)}));
  app.get<{Params:{id:string}}>('/api/game/rebuilds/:id',async req=>rebuild(requireRebuild(db,req.params.id)));
  app.get<{Params:{id:string}}>('/api/game/rebuilds/:id/archive',async(req,reply)=>{
    if(closing)throw new AppError('QUEUE_FULL','API is closing',503);
    const record=requireRebuild(db,req.params.id);if(record.status!=='COMPLETED'||!record.output_path)throw new AppError('CONFLICT','No validated server archive is available',409);
    const root=path.resolve(dataDir,'revived-games'),target=path.resolve(String(record.output_path)),relative=path.relative(root,target);if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw new AppError('CONFLICT','Unsafe rebuild output path',409);
    if(activeArchives>=MAX_ARCHIVES)throw new AppError('RATE_LIMITED','Too many concurrent game archive downloads',429);
    activeArchives+=1;
    try{const bytes=await zipDirectory(target);reply.header('content-type','application/zip').header('content-disposition',`attachment; filename="revived-game-server-${req.params.id}.zip"`).header('x-content-sha256',archiveDigest(bytes));return reply.send(bytes);}finally{activeArchives-=1;}
  });
}

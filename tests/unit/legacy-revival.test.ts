import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { analyzeLegacySoftware, createReconstructionSpec, generateReconstructionProject, recoverLegacyData, writeReconstructionProject } from '@reverse/legacy-revival';
import { legacyAdapter } from '@reverse/core';
import type { TaskContext } from '@reverse/workflow';

const run=promisify(execFile);const temporary:string[]=[];afterEach(async()=>{vi.unstubAllEnvs();await Promise.all(temporary.splice(0).map(dir=>rm(dir,{recursive:true,force:true})));});
async function workspace():Promise<string>{const dir=await mkdtemp(path.join(os.tmpdir(),'legacy-revival-'));temporary.push(dir);return dir;}
function legacyContext(dataDir:string,inputPath:string,inputSnapshotPath?:string,taskId='task-snapshot'):TaskContext{return{taskId,project:{} as TaskContext['project'],options:{path:inputPath},...(inputSnapshotPath?{inputSnapshotPath}:{}),stageOutputs:{},dataDir,signal:new AbortController().signal,log:async()=>{},evidence:async()=> 'evidence',finding:async()=> 'finding',writeArtifact:async()=>{},readArtifact:async()=>new Uint8Array()};}

describe('legacy software revival',()=>{
  it('identifies the retained INI tool without executing it and keeps privacy local',async()=>{
    const root=path.join(process.cwd(),'examples','legacy-samples','ini-editor');const analysis=await analyzeLegacySoftware(root);
    expect(analysis.profile.formats).toContain('INI');expect(analysis.profile.dataFormats).toContain('INI');expect(analysis.profile.evidenceStatus).toBe('EVIDENCE');expect(analysis.privacy).toMatchObject({localOnly:true,remoteAiUsed:false,networkRequired:[],externalTools:[]});expect(analysis.privacy.remoteAiNote).toContain('显式项目授权');expect(analysis.profile.license.status).toBe('UNKNOWN');
  });
  it('accepts the engine-bound task snapshot but still rejects paths outside the allowlist',async()=>{
    const dir=await workspace();const dataDir=path.join(dir,'data');const snapshotRoot=path.join(dataDir,'tasks','task-snapshot','input-snapshot');const snapshot=path.join(snapshotRoot,'sample.ini');await mkdir(snapshotRoot,{recursive:true});await writeFile(snapshot,'[general]\nname=legacy\n');const allowed=path.join(dir,'allowed');await mkdir(allowed);vi.stubEnv('RE_LEGACY_ROOTS',allowed);
    const detection=await legacyAdapter.detect(legacyContext(dataDir,snapshot,snapshot));expect(detection.format).toContain('INI');
    const directoryDataDir=path.join(dir,'directory-data');const directorySnapshot=path.join(directoryDataDir,'tasks','task-directory','input-snapshot');await mkdir(directorySnapshot,{recursive:true});await writeFile(path.join(directorySnapshot,'sample.ini'),'[general]\nname=directory\n');expect((await legacyAdapter.detect(legacyContext(directoryDataDir,directorySnapshot,directorySnapshot,'task-directory'))).format).toContain('INI');
    const original=path.join(allowed,'sample.ini');await writeFile(original,'[general]\nname=allowed\n');await legacyAdapter.validateInput!(legacyContext(dataDir,original));
    const outside=path.join(dir,'outside.ini');await writeFile(outside,'[general]\nname=outside\n');await expect(legacyAdapter.validateInput!(legacyContext(dataDir,outside))).rejects.toThrow(/outside RE_LEGACY_ROOTS/);await expect(legacyAdapter.detect(legacyContext(dataDir,outside))).rejects.toThrow(/outside RE_LEGACY_ROOTS/);
    const forged=path.join(dir,'forged.ini');await writeFile(forged,'[general]\nname=forged\n');await expect(legacyAdapter.detect(legacyContext(dataDir,forged,forged))).rejects.toThrow(/outside the task snapshot root/);
    const mismatch=path.join(allowed,'mismatch.ini');await writeFile(mismatch,'[general]\nname=mismatch\n');await expect(legacyAdapter.detect(legacyContext(dataDir,mismatch,snapshot))).rejects.toThrow(/binding mismatch/);
  });
  it('recovers CSV and INI into a new directory with source integrity evidence',async()=>{
    const dir=await workspace();const csv=path.join(dir,'old.csv');await writeFile(csv,'name,age\nAda,36\n');const recovered=await recoverLegacyData(csv,{outputDir:path.join(dir,'out-csv')});
    expect(recovered.records).toBe(1);expect(recovered.preview[0]).toEqual({name:'Ada',age:'36'});expect(recovered.integrity.sourceUnchanged).toBe(true);expect(recovered.truncated).toBe(false);expect(JSON.parse(await readFile(path.join(recovered.outputDir,'recovered.json'),'utf8')).records).toHaveLength(1);
    const ini=path.join(process.cwd(),'examples','legacy-samples','ini-editor','sample.ini');const iniResult=await recoverLegacyData(ini,{outputDir:path.join(dir,'out-ini')});expect(iniResult.records).toBe(6);expect(iniResult.fields).toEqual(['section','key','value']);
  });
  it('bounds records and cells, reports truncation and neutralizes spreadsheet formulas',async()=>{
    const dir=await workspace();const csv=path.join(dir,'old.csv');await writeFile(csv,'name,note\nAda,=1+1\nLin,@SUM(A1)\n');const recovered=await recoverLegacyData(csv,{outputDir:path.join(dir,'out'),maxRecords:1});
    expect(recovered.records).toBe(1);expect(recovered.truncated).toBe(true);expect(recovered.limitations.join(' ')).toContain('有界预览');const exported=await readFile(path.join(recovered.outputDir,'recovered.csv'),'utf8');expect(exported).toContain("'=1+1");expect(exported).not.toContain('\n@SUM');
    const huge=path.join(dir,'huge.csv');await writeFile(huge,'value\n'+'x'.repeat(70*1024)+'\n');await expect(recoverLegacyData(huge,{outputDir:path.join(dir,'huge-out')})).rejects.toThrow(/单元格/);
  });
  it('reads DBF field descriptors and rejects symbolic-link sources',async()=>{
    const dir=await workspace();const file=path.join(dir,'old.dbf');const header=Buffer.alloc(97);header.writeUInt32LE(1,4);header.writeUInt16LE(97,8);header.writeUInt16LE(8,10);header.write('NAME',32,'latin1');header[43]=67;header[48]=5;header.write('AGE',64,'latin1');header[75]=78;header[80]=2;header[96]=0x0d;const record=Buffer.from(' Ada  36','latin1');await writeFile(file,Buffer.concat([header,record]));const result=await recoverLegacyData(file,{outputDir:path.join(dir,'out')});expect(result.format).toBe('DBF');expect(result.preview[0]).toEqual({NAME:'Ada',AGE:36});
    const link=path.join(dir,'link.csv');try{await symlink(file,link);await expect(recoverLegacyData(link,{outputDir:path.join(dir,'link-out')})).rejects.toThrow(/普通文件/);}catch(error){if((error as NodeJS.ErrnoException).code!=='EPERM')throw error;}
  });
  it('reads SQLite read-only and enforces one global row budget across tables',async()=>{
    const dir=await workspace();const file=path.join(dir,'old.sqlite');const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(file);db.exec("CREATE TABLE a(id INTEGER); CREATE TABLE b(id INTEGER); INSERT INTO a VALUES(1),(2); INSERT INTO b VALUES(3),(4);");db.close();const result=await recoverLegacyData(file,{outputDir:path.join(dir,'out'),maxRecords:3});expect(result.format).toBe('SQLite');expect(result.records).toBe(3);expect(result.truncated).toBe(true);expect(result.preview[0]).toMatchObject({_table:'a',id:1});
  });
  it('reports SQLite table-count truncation instead of silently scanning only 100 tables',async()=>{
    const dir=await workspace();const file=path.join(dir,'many.sqlite');const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(file);db.exec(Array.from({length:101},(_,index)=>`CREATE TABLE t_${String(index).padStart(3,'0')}(id INTEGER);`).join('\n'));db.close();const result=await recoverLegacyData(file,{outputDir:path.join(dir,'out')});expect(result.truncated).toBe(true);expect(result.records).toBe(0);expect(result.limitations.join(' ')).toContain('检测到 101 张表');expect(result.limitations.join(' ')).toContain('仅恢复前 100 张表');
  });
  it('marks truncated directory analysis as inference instead of complete evidence',async()=>{
    const dir=await workspace();await writeFile(path.join(dir,'a.ini'),'[a]\nx=1\n');await writeFile(path.join(dir,'b.ini'),'[b]\ny=2\n');
    const analysis=await analyzeLegacySoftware(dir,{maxFiles:1});expect(analysis.profile.truncated).toBe(true);expect(analysis.profile.evidenceStatus).toBe('INFERENCE');expect(analysis.profile.limitations.join(' ')).toContain('不完整');
  });
  it('parses XML linearly and rejects unclosed tags without regex backtracking',async()=>{
    const dir=await workspace();const xml=path.join(dir,'old.xml');await writeFile(xml,'<root><item id="1">Ada</item><item id="2">Lin</item></root>');const result=await recoverLegacyData(xml,{outputDir:path.join(dir,'out')});expect(result.preview).toHaveLength(3);expect(result.preview.map(record=>record.element)).toEqual(['item','item','root']);
    const huge=path.join(dir,'huge.xml');await writeFile(huge,'<root>'+'x'.repeat(70*1024)+'</root>');await expect(recoverLegacyData(huge,{outputDir:path.join(dir,'huge-out')})).rejects.toThrow(/XML 单元格/);
    const hostile=path.join(dir,'hostile.xml');await writeFile(hostile,'<a>'.repeat(60_000));const started=performance.now();await expect(recoverLegacyData(hostile,{outputDir:path.join(dir,'hostile-out')})).rejects.toThrow(/未闭合|不匹配|深度/);expect(performance.now()-started).toBeLessThan(2_000);
  });
  it('bounds directory entries even when empty directories bypass file and byte limits',async()=>{
    const dir=await workspace();const root=path.join(dir,'entries');await mkdir(root);for(let start=0;start<10_001;start+=100)await Promise.all(Array.from({length:Math.min(100,10_001-start)},(_,offset)=>mkdir(path.join(root,`empty-${start+offset}`))));const analysis=await analyzeLegacySoftware(root,{maxFiles:2000,maxBytes:64*1024*1024});expect(analysis.profile.truncated).toBe(true);expect(['INFERENCE','UNKNOWN']).toContain(analysis.profile.evidenceStatus);expect(analysis.profile.limitations.join(' ')).toContain('目录条目数');
  },120_000);
  it('rejects reconstruction from truncated profiles while retaining data recovery',async()=>{
    const dir=await workspace();await writeFile(path.join(dir,'a.ini'),'[a]\nx=1\n');await writeFile(path.join(dir,'b.ini'),'[b]\ny=2\n');const analysis=await analyzeLegacySoftware(dir,{maxFiles:1});expect(analysis.profile.truncated).toBe(true);expect(()=>createReconstructionSpec({kind:'text-tool',name:'blocked',requirements:['text'],profile:analysis.profile})).toThrow(/截断/);const source=path.join(dir,'a.ini');const recovered=await recoverLegacyData(source,{outputDir:path.join(dir,'out')});expect(recovered.records).toBe(1);expect(recovered.evidenceStatus).toBe('VERIFIED');
    for(const evidenceStatus of ['INFERENCE','UNKNOWN'] as const){const profile={...analysis.profile,truncated:true,evidenceStatus};expect(()=>createReconstructionSpec({kind:'text-tool',name:'blocked',requirements:['text'],profile})).toThrow(/截断/);}
  });
  it('rejects SQLite WAL side data instead of exporting an incomplete main file',async()=>{
    const dir=await workspace();const file=path.join(dir,'wal.sqlite');const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(file);db.exec('PRAGMA journal_mode=WAL; CREATE TABLE records(id INTEGER); INSERT INTO records VALUES(1);');
    try{await expect(recoverLegacyData(file,{outputDir:path.join(dir,'out')})).rejects.toThrow(/WAL/);}finally{db.close();}
  });
  it('generates an independent INI editor that builds tests and starts for real',async()=>{
    const dir=await workspace();const analysis=await analyzeLegacySoftware(path.join(process.cwd(),'examples','legacy-samples','ini-editor'));const spec=createReconstructionSpec({kind:'ini-editor',name:'independent-ini-editor',requirements:['read INI','export a copy'],profile:analysis.profile});const project=generateReconstructionProject(spec);const output=path.join(dir,'app');await writeReconstructionProject(project,output);
    await run(process.execPath,['--test'],{cwd:output,timeout:60_000,windowsHide:true});const pkg=JSON.parse(await readFile(path.join(output,'package.json'),'utf8')) as {scripts:{test:string;start:string}};expect(pkg.scripts.test).toContain('node --test');expect(project.files.has('RECONSTRUCTION.json')).toBe(true);
  },120_000);
  it('generates a real data converter and rejects unbounded reconstruction requirements',async()=>{
    const dir=await workspace();const analysis=await analyzeLegacySoftware(path.join(process.cwd(),'examples','legacy-samples','ini-editor'));const spec=createReconstructionSpec({kind:'data-converter',name:'converter',requirements:['JSON to CSV','CSV to JSON'],profile:analysis.profile});const project=generateReconstructionProject(spec);expect(project.files.has('bin/convert.mjs')).toBe(true);expect(project.files.get('web/index.html')).toContain('out.textContent');expect(project.files.get('web/index.html')).toContain("import {jsonToCsv,csvToJson} from '/converter-core.js'");expect(project.files.get('converter-core.js')).toContain('csvCell');expect(project.files.get('converter-core.js')).toContain('inputBytes:1024*1024');const output=path.join(dir,'converter');await writeReconstructionProject(project,output);await run(process.execPath,['--test'],{cwd:output,timeout:60_000,windowsHide:true});
    const source=path.join(dir,'formula.json'),csv=path.join(dir,'formula.csv');await writeFile(source,JSON.stringify([{name:'=1+1',note:'@SUM(A1)'}]));await run(process.execPath,['bin/convert.mjs',source,csv],{cwd:output});const exported=await readFile(csv,'utf8');expect(exported).toContain("'=1+1");expect(exported).toContain("'@SUM(A1)");const quoted=path.join(dir,'quoted.csv'),roundtrip=path.join(dir,'quoted.json');await writeFile(quoted,'name,note\r\n"Ada, A.","line 1\nline 2"\r\n');await run(process.execPath,['bin/convert.mjs',quoted,roundtrip],{cwd:output});expect(JSON.parse(await readFile(roundtrip,'utf8'))).toEqual([{name:'Ada, A.',note:'line 1\nline 2'}]);const oversized=path.join(dir,'oversized.csv');await writeFile(oversized,'x\n'+'x'.repeat(70*1024));await expect(run(process.execPath,['bin/convert.mjs',oversized,path.join(dir,'oversized.json')],{cwd:output})).rejects.toThrow(/单元格/);
    expect(()=>createReconstructionSpec({kind:'text-tool',name:'x',requirements:Array.from({length:33},(_,index)=>String(index)),profile:analysis.profile})).toThrow(/1-32/);
  },120_000);
});

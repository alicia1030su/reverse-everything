import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { packageBackup, parseBackupArgs } from '../../scripts/package-backup.mjs';

const dirs:string[]=[];const databases:DatabaseSync[]=[];
afterEach(async()=>{for(const db of databases.splice(0))db.close();for(const dir of dirs.splice(0))await rm(dir,{recursive:true,force:true});});
async function temp(){const dir=await mkdtemp(path.join(os.tmpdir(),'re-package-backup-test-'));dirs.push(dir);return dir;}
async function fixture(){const dataDir=await temp();await writeFile(path.join(dataDir,'secret.key'),'secret-key-content');await writeFile(path.join(dataDir,'local-token'),'local-token-content');await mkdir(path.join(dataDir,'tasks','task-1','artifacts'),{recursive:true});await writeFile(path.join(dataDir,'tasks','task-1','artifacts','report.md'),'report');await mkdir(path.join(dataDir,'uploads','project-1'),{recursive:true});await writeFile(path.join(dataDir,'uploads','project-1','sample.bin'),'upload');return dataDir;}
async function hash(file){const digest=createHash('sha256');for await(const chunk of createReadStream(file))digest.update(chunk);return digest.digest('hex');}

describe('release backup packaging',()=>{
  it('packages a WAL-consistent database keys token uploads and artifacts with verifiable hashes',async()=>{
    const dataDir=await fixture();const releaseDir=path.join(await temp(),'release');const dbPath=path.join(dataDir,'reverse-everything.sqlite');const raw=new DatabaseSync(dbPath);databases.push(raw);raw.exec("PRAGMA journal_mode=WAL; CREATE TABLE fixture (value TEXT); INSERT INTO fixture VALUES ('wal-committed');");
    const report=await packageBackup({dataDir,releaseDir,confirm:true,version:'0.0.3',timestamp:'test'});expect(report.dryRun).toBe(false);expect(report.files.map(file=>file.path)).toEqual(expect.arrayContaining(['reverse-everything.sqlite','secret.key','local-token','tasks/task-1/artifacts/report.md','uploads/project-1/sample.bin','SHA256SUMS']));expect(JSON.stringify(report)).not.toContain('secret-key-content');expect(JSON.stringify(report)).not.toContain('local-token-content');
    const snapshot=new DatabaseSync(path.join(report.outputDir,'reverse-everything.sqlite'),{readOnly:true});try{expect(snapshot.prepare('SELECT value FROM fixture').get()).toEqual({value:'wal-committed'});}finally{snapshot.close();}
    const sums=await readFile(path.join(report.outputDir,'SHA256SUMS'),'utf8');for(const line of sums.trim().split('\n')){const [digest,relative]=line.split('  ');expect(await hash(path.join(report.outputDir,relative!))).toBe(digest);}
    expect(await hash(report.archive.path)).toBe(report.archive.sha256);expect(existsSync(report.archive.path)).toBe(true);
    if(process.platform!=='win32'){expect((await stat(report.archive.path)).mode&0o777).toBe(0o600);expect((await stat(report.outputDir)).mode&0o777).toBe(0o700);expect((await stat(path.join(report.outputDir,'secret.key'))).mode&0o777).toBe(0o600);}
  });
  it('defaults to dry-run without creating release output',async()=>{
    const dataDir=await fixture();const db=new DatabaseSync(path.join(dataDir,'reverse-everything.sqlite'));databases.push(db);db.exec('CREATE TABLE fixture (value TEXT)');const releaseDir=path.join(await temp(),'release');const report=await packageBackup({dataDir,releaseDir,version:'0.0.3',timestamp:'dry'});expect(report.dryRun).toBe(true);expect(report.files.length).toBeGreaterThan(0);expect(existsSync(releaseDir)).toBe(false);
  });
  it('rejects symbolic links in collected trees',async()=>{
    const dataDir=await fixture();const db=new DatabaseSync(path.join(dataDir,'reverse-everything.sqlite'));databases.push(db);db.exec('CREATE TABLE fixture (value TEXT)');const outside=await temp();await writeFile(path.join(outside,'escape.txt'),'outside');await symlink(outside,path.join(dataDir,'tasks','escape'),process.platform==='win32'?'junction':'dir');const releaseDir=path.join(await temp(),'release');await expect(packageBackup({dataDir,releaseDir,confirm:true,version:'0.0.3',timestamp:'link'})).rejects.toThrow(/symbolic link/i);expect(existsSync(releaseDir)).toBe(false);
  });
  it('requires the exact confirmation token for writes',()=>{expect(parseBackupArgs([]).confirm).toBe(false);expect(parseBackupArgs(['--confirm','BACKUP']).confirm).toBe(true);expect(()=>parseBackupArgs(['--confirm','YES'])).toThrow(/confirm BACKUP/);});
});

import { spawn } from 'node:child_process';
import { lstat, readdir, readFile, statfs } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ResourceProcess, ResourceSnapshot } from '@reverse/contracts';
import type { Database } from './database.js';

export interface ResourceThresholds { softRssMb:number; hardRssMb:number; minSystemFreeMemoryMB?:number; minDiskFreeBytes?:number; maxCpuPercent?:number }
export interface ResourceMonitorOptions {
  processSampler?: () => Promise<ResourceProcess[]>;
  diskSampler?: () => Promise<DiskSample>;
  systemSampler?: () => SystemSample;
  now?: () => number;
  sampleTtlMs?: number;
  diskSampleTtlMs?: number;
  hysteresis?: { pressureSamples?: number; dangerSamples?: number };
  circuitDedupWindowMs?: number;
  resourceRetention?: { days?:number; maxRows?:number };
  maxSamplingAttempts?: number;
  retryDelayMs?: number;
}
export type ResourceSamplingStatus='fresh'|'process-exited'|'unavailable';
export interface ResourceSamplingDiagnostics { status:ResourceSamplingStatus; attempts:number; retrying:boolean; stale:boolean; exitedPids:number[] }
export type MonitoredResourceSnapshot=ResourceSnapshot&{samplingStatus:ResourceSamplingStatus;sampling:ResourceSamplingDiagnostics};
export interface DiskSample { dataDirBytes:number; diskAvailableBytes:number; limitations:string[] }
export interface SystemSample { systemFreeMemoryMB:number; systemTotalMemoryMB:number }
export const DEFAULT_RESOURCE_THRESHOLDS:ResourceThresholds={softRssMb:700,hardRssMb:950,minSystemFreeMemoryMB:1024,minDiskFreeBytes:1024*1024*1024,maxCpuPercent:90};
export function effectiveResourceThresholds(configured:ResourceThresholds,systemTotalMemoryMB:number):ResourceThresholds {
  if(!Number.isFinite(systemTotalMemoryMB)||systemTotalMemoryMB<=0)return configured;
  const defaults=configured.softRssMb===DEFAULT_RESOURCE_THRESHOLDS.softRssMb&&configured.hardRssMb===DEFAULT_RESOURCE_THRESHOLDS.hardRssMb&&configured.minSystemFreeMemoryMB===DEFAULT_RESOURCE_THRESHOLDS.minSystemFreeMemoryMB;
  if(!defaults)return configured;
  if(systemTotalMemoryMB<1024)return {...configured,softRssMb:Math.max(256,systemTotalMemoryMB),hardRssMb:Math.max(384,systemTotalMemoryMB*1.5),minSystemFreeMemoryMB:0};
  const softRssMb=Math.max(256,Math.min(configured.softRssMb,systemTotalMemoryMB*0.15));
  return {...configured,softRssMb,hardRssMb:Math.max(softRssMb+128,Math.min(configured.hardRssMb,systemTotalMemoryMB*0.25)),minSystemFreeMemoryMB:Math.max(128,Math.min(configured.minSystemFreeMemoryMB??1024,systemTotalMemoryMB*0.1))};
}
export const PROCESS_SAMPLING_LIMITATION = 'Process-tree sampling unavailable; reporting Node self RSS only';
export const DEFAULT_RESOURCE_SAMPLE_RETENTION = { days:7, maxRows:10000 } as const;

interface ProcRow { ProcessId:number; ParentProcessId:number; WorkingSetSize:number; Name:string; KernelModeTime:number; UserModeTime:number; CreationDate?:string }
type IdentifiedResourceProcess=ResourceProcess&{startedAt?:number|string};
export class ProcessSamplingError extends Error { constructor(message:string,readonly kind:'transient'|'unavailable'|'process-exited'='transient'){super(message);this.name='ProcessSamplingError';} }
export interface ResourceSampleOptions { fresh?:boolean; rootPids?:number[] }
interface PressureState { level:ResourceSnapshot['pressure']; normalSamples:number }
interface PressureMetrics { treeRssMB:number; systemFreeMemoryMB:number|undefined; systemTotalMemoryMB:number|undefined; diskAvailableBytes:number|undefined; cpuPercent:number }
interface PeakMetrics { treeRssMB:number; cpuPercent:number; dataDirBytes:number }

async function windowsProcesses():Promise<IdentifiedResourceProcess[]> {
  const script="$p=Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,Name,KernelModeTime,UserModeTime,CreationDate; $p | ConvertTo-Json -Compress";
  return new Promise((resolve,reject) => {
    const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true});
    let stdout='';
    let settled=false;
    const finish=(error?:Error,rows?:ResourceProcess[]) => {
      if (settled) return;
      settled=true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(rows ?? []);
    };
    const timer=setTimeout(() => {
      child.kill();
      finish(new ProcessSamplingError('Process sampling timeout'));
    },8000);
    child.stdout.on('data',b => stdout+=b.toString());
    child.on('error',error => finish(new ProcessSamplingError(error.message,(error as NodeJS.ErrnoException).code==='ENOENT'?'unavailable':'transient')));
    child.on('close',code => {
      if (code !== 0) { finish(new ProcessSamplingError(`Process sampling exited with code ${code ?? 'unknown'}`)); return; }
      try {
        const parsed=JSON.parse(stdout) as ProcRow | ProcRow[] | null;
        const items=parsed ? (Array.isArray(parsed)?parsed:[parsed]) : [];
        const rows=items.filter(p => p && Number.isFinite(Number(p.ProcessId))).map(p => ({pid:Number(p.ProcessId),ppid:Number(p.ParentProcessId),rssMB:Number(p.WorkingSetSize)/1048576,cpuSeconds:(Number(p.KernelModeTime)+Number(p.UserModeTime))/10000000,name:p.Name,...(p.CreationDate?{startedAt:p.CreationDate}:{})}));
        if(typeof child.pid!=='number')throw new Error('Process sampler PID is unavailable');
        const samplerPids=new Set([child.pid,...descendants(rows,child.pid).map(row=>row.pid)]);
        const filtered=rows.filter(row=>!samplerPids.has(row.pid));
        if (!filtered.length) throw new Error('Process sampling returned no processes');
        finish(undefined,filtered);
      } catch (error) { finish(error instanceof Error?error:new Error(String(error))); }
    });
  });
}

export function parseDarwinProcessOutput(stdout:string):ResourceProcess[] {
  const rows:ResourceProcess[]=[];
  for(const line of stdout.split('\n')){
    if(!line.trim())continue;
    const match=line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+((?:(\d+):)?(\d+):(\d+(?:\.\d+)?))\s+(.+)$/);
    if(!match)throw new Error('Malformed macOS process sampling row');
    const pid=Number(match[1]),ppid=Number(match[2]),rssKB=Number(match[3]);const hours=Number(match[5]??0),minutes=Number(match[6]),seconds=Number(match[7]);
    if(![pid,ppid,rssKB,hours,minutes].every(Number.isSafeInteger)||!Number.isFinite(seconds)||minutes<0||minutes>59||seconds<0||seconds>=60)throw new Error('Invalid macOS process sampling values');
    rows.push({pid,ppid,rssMB:rssKB/1024,cpuSeconds:hours*3600+minutes*60+seconds,name:match[8]!.trim()});
  }
  if(!rows.length)throw new Error('Process sampling returned no processes');
  return rows;
}

export async function darwinProcesses():Promise<IdentifiedResourceProcess[]> {
  return new Promise((resolve,reject)=>{
    const child=spawn('/bin/ps',['-axo','pid=,ppid=,rss=,time=,comm='],{windowsHide:true});
    let stdout='';let settled=false;
    const finish=(error?:Error,rows?:ResourceProcess[])=>{if(settled)return;settled=true;clearTimeout(timer);if(error)reject(error);else resolve(rows??[]);};
    const timer=setTimeout(()=>{child.kill();finish(new Error('Process sampling timeout'));},8000);
    child.stdout.on('data',chunk=>{stdout+=chunk.toString();if(stdout.length>16*1024*1024){child.kill();finish(new Error('Process sampling output exceeded 16MB'));}});
    child.on('error',error=>finish(error));
    child.on('close',code=>{
      if(code!==0){finish(new ProcessSamplingError(`Process sampling exited with code ${code??'unknown'}`));return;}
      try{
        const rows=parseDarwinProcessOutput(stdout);if(typeof child.pid!=='number')throw new Error('Process sampler PID is unavailable');
        const samplerPids=new Set([child.pid,...descendants(rows,child.pid).map(row=>row.pid)]);const filtered=rows.filter(row=>!samplerPids.has(row.pid));
        if(!filtered.length)throw new Error('Process sampling returned no processes');finish(undefined,filtered);
      }catch(error){finish(error instanceof Error?error:new Error(String(error)));}
    });
  });
}

async function linuxProcesses():Promise<IdentifiedResourceProcess[]> {
  const rows:IdentifiedResourceProcess[]=[];
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const pid=Number(entry);
      const processStat=await readFile(`/proc/${pid}/stat`,'utf8');
      const close=processStat.lastIndexOf(')');
      const fields=processStat.slice(close+2).split(' ');
      const status=await readFile(`/proc/${pid}/status`,'utf8');
      const rss=Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1]??0)/1024;
      rows.push({pid,ppid:Number(fields[1]),rssMB:rss,cpuSeconds:(Number(fields[11])+Number(fields[12]))/100,name:processStat.slice(processStat.indexOf('(')+1,close),startedAt:Number(fields[19])});
    } catch { /* process exited during sampling */ }
  }
  if (!rows.length) throw new Error('Process sampling returned no processes');
  return rows;
}

export function descendants(processes:ResourceProcess[],rootPid:number) {
  const byParent=new Map<number,ResourceProcess[]>();
  for (const item of processes) {
    const list=byParent.get(item.ppid)??[];
    list.push(item);
    byParent.set(item.ppid,list);
  }
  const result:ResourceProcess[]=[];
  const queue=[rootPid];
  const seen=new Set<number>();
  while (queue.length) {
    const parent=queue.shift()!;
    for (const child of byParent.get(parent)??[]) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      result.push(child);
      queue.push(child.pid);
    }
  }
  return result;
}

export function defaultProcessSampler(platform:NodeJS.Platform=process.platform):()=>Promise<ResourceProcess[]> {return platform==='win32'?windowsProcesses:platform==='darwin'?darwinProcesses:linuxProcesses;}

export class ResourceMonitor {
  private previous=new Map<number,{time:number;cpu:number;startedAt:number|string|undefined}>();
  private lastSample=new Map<string,number>();
  private readonly inFlight=new Map<string,Promise<MonitoredResourceSnapshot>>();
  private readonly pressureStates=new Map<string,PressureState>();
  private readonly circuitTimes=new Map<string,number>();
  private diskCache?: {at:number;value:DiskSample};
  private diskInFlight: Promise<DiskSample> | undefined;
  private readonly now:() => number;
  private readonly sampleTtlMs:number;
  private readonly diskSampleTtlMs:number;
  private readonly processSampler:() => Promise<ResourceProcess[]>;
  private readonly diskSampler:() => Promise<DiskSample>;
  private readonly systemSampler:() => SystemSample;
  private readonly pressureRecoverySamples:number;
  private readonly dangerRecoverySamples:number;
  private readonly circuitDedupWindowMs:number;
  private resourceRetentionDays:number;
  private resourceRetentionMaxRows:number;
  private readonly maxSamplingAttempts:number;
  private readonly retryDelayMs:number;

  constructor(private db:Database,private dataDir:string,private thresholds:ResourceThresholds=DEFAULT_RESOURCE_THRESHOLDS,options:ResourceMonitorOptions={}) {
    this.now=options.now??Date.now;
    this.sampleTtlMs=options.sampleTtlMs??2000;
    this.diskSampleTtlMs=options.diskSampleTtlMs??30000;
    this.processSampler=options.processSampler??defaultProcessSampler();
    this.diskSampler=options.diskSampler??(() => this.scanDisk());
    this.systemSampler=options.systemSampler??(() => ({systemFreeMemoryMB:os.freemem()/1048576,systemTotalMemoryMB:os.totalmem()/1048576}));
    this.pressureRecoverySamples=Math.max(1,options.hysteresis?.pressureSamples??2);
    this.dangerRecoverySamples=Math.max(1,options.hysteresis?.dangerSamples??3);
    this.circuitDedupWindowMs=options.circuitDedupWindowMs??30000;
    this.resourceRetentionDays=this.retentionNumber(options.resourceRetention?.days,DEFAULT_RESOURCE_SAMPLE_RETENTION.days,0);
    this.resourceRetentionMaxRows=this.retentionNumber(options.resourceRetention?.maxRows,DEFAULT_RESOURCE_SAMPLE_RETENTION.maxRows,1);
    this.maxSamplingAttempts=Math.max(1,Math.floor(options.maxSamplingAttempts??3));this.retryDelayMs=Math.max(0,options.retryDelayMs??50);
  }

  private retentionNumber(value:number|undefined,fallback:number,minimum:number):number {
    return value===undefined||!Number.isFinite(value)?fallback:Math.max(minimum,Math.floor(value));
  }

  refreshRetention(options:{days?:number;maxRows?:number;minDiskFreeBytes?:number}):void{
    const days=options.days===undefined?this.resourceRetentionDays:this.retentionNumber(options.days,this.resourceRetentionDays,0);
    const maxRows=options.maxRows===undefined?this.resourceRetentionMaxRows:this.retentionNumber(options.maxRows,this.resourceRetentionMaxRows,1);
    if(options.maxRows!==undefined&&(!Number.isFinite(options.maxRows)||!Number.isInteger(options.maxRows)||options.maxRows<1))throw new Error('Invalid resource retention maxRows');
    if(options.days!==undefined&&(!Number.isFinite(options.days)||options.days<0))throw new Error('Invalid resource retention days');
    if(options.minDiskFreeBytes!==undefined&&(!Number.isFinite(options.minDiskFreeBytes)||options.minDiskFreeBytes<0))throw new Error('Invalid minimum free disk bytes');
    this.resourceRetentionDays=days;this.resourceRetentionMaxRows=maxRows;
    if(options.minDiskFreeBytes!==undefined)this.thresholds={...this.thresholds,minDiskFreeBytes:options.minDiskFreeBytes};
  }

  sample(source:'api'|'worker'|'desktop', options:ResourceSampleOptions={}): Promise<MonitoredResourceSnapshot> {
    const roots=[...new Set((options.rootPids??[]).filter(pid=>Number.isSafeInteger(pid)&&pid>0))].sort((a,b)=>a-b);
    const key=`${source}:${roots.join(',')}`;
    const active=this.inFlight.get(key);
    if (active) return active;
    const at=this.now();
    const last=this.lastSample.get(source);
    if (!options.fresh && roots.length===0 && last!==undefined && at-last<this.sampleTtlMs) {
      const stored=this.stored(source);
      if (stored && this.samplingHealthy(stored)) return Promise.resolve(stored);
    }
    const pending=this.performSample(source,roots).then(snapshot => {
      // Unhealthy fallback snapshots remain observable but are not allowed to
      // suppress the next sampling attempt.
      if (roots.length===0 && this.samplingHealthy(snapshot)) this.lastSample.set(source,this.now());
      return snapshot;
    }).finally(() => {
      if (this.inFlight.get(key)===pending) this.inFlight.delete(key);
    });
    this.inFlight.set(key,pending);
    return pending;
  }

  async sampleOrThrow(source:'api'|'worker'|'desktop', options:ResourceSampleOptions={}): Promise<MonitoredResourceSnapshot> {
    const snapshot=await this.sample(source,options);
    if(source==='worker'&&!this.samplingHealthy(snapshot)) throw new Error(`Resource sampling failed closed: ${snapshot.limitations.join('; ')}`);
    return snapshot;
  }

  samplingHealthy(snapshot?:ResourceSnapshot): boolean {
    return Boolean(snapshot && !snapshot.limitations.includes(PROCESS_SAMPLING_LIMITATION));
  }

  private async sampleProcesses():Promise<{processes:ResourceProcess[];attempts:number;unavailable:boolean}>{
    let lastError:unknown;
    for(let attempt=1;attempt<=this.maxSamplingAttempts;attempt++){
      try{return {processes:await this.processSampler(),attempts:attempt,unavailable:false};}
      catch(error){lastError=error;if(error instanceof ProcessSamplingError&&error.kind==='unavailable')break;if(attempt<this.maxSamplingAttempts&&this.retryDelayMs)await new Promise(resolve=>setTimeout(resolve,this.retryDelayMs));}
    }
    if(lastError instanceof ProcessSamplingError&&lastError.kind==='process-exited')return {processes:[],attempts:this.maxSamplingAttempts,unavailable:false};
    return {processes:[],attempts:this.maxSamplingAttempts,unavailable:true};
  }

  private async performSample(source:'api'|'worker'|'desktop', rootPids:number[]=[]): Promise<MonitoredResourceSnapshot> {
    const limitations:string[]=[];const processResult=await this.sampleProcesses();const processes=processResult.processes;
    if(processResult.unavailable)limitations.push(PROCESS_SAMPLING_LIMITATION);
    const sampledAt=this.now();
    const self=processes.find(p => p.pid===process.pid);
    const fallbackSelf:ResourceProcess={pid:process.pid,ppid:process.ppid,rssMB:process.memoryUsage().rss/1048576,cpuSeconds:0,name:process.platform};
    const byPid=new Map<number,ResourceProcess>([[process.pid,self??fallbackSelf]]);
    for(const pid of [process.pid,...rootPids]){
      const root=processes.find(item=>item.pid===pid);if(root)byPid.set(pid,root);
      for(const child of descendants(processes,pid))byPid.set(child.pid,child);
    }
    const exitedPids=rootPids.filter(pid=>!byPid.has(pid));
    if(exitedPids.length)limitations.push(`Registered process exited during sampling: ${exitedPids.join(',')}`);
    const all=[...byPid.values()];
    const selfRss=self?.rssMB??fallbackSelf.rssMB;
    const treeRss=all.reduce((n,p) => n+p.rssMB,0);
    let cpuDelta=0;
    let elapsed=0;
    const seen=new Set<number>();
    for (const item of all as IdentifiedResourceProcess[]) {
      seen.add(item.pid);
      const prev=this.previous.get(item.pid);
      const sameProcess=prev&&(prev.startedAt===undefined||item.startedAt===undefined||prev.startedAt===item.startedAt);
      if (sameProcess && sampledAt>prev.time) {
        cpuDelta+=Math.max(0,item.cpuSeconds-prev.cpu);
        elapsed=Math.max(elapsed,(sampledAt-prev.time)/1000);
      }
      this.previous.set(item.pid,{time:sampledAt,cpu:item.cpuSeconds,startedAt:item.startedAt});
    }
    for (const pid of this.previous.keys()) if (!seen.has(pid)) this.previous.delete(pid);
    const cores=Math.max(1,os.cpus().length);
    const cpuPercent=elapsed>0?Math.max(0,Math.min(100*cores,cpuDelta/elapsed/cores*100)):0;
    let disk:DiskSample={dataDirBytes:0,diskAvailableBytes:0,limitations:['Disk usage sampling unavailable']};
    try{disk=await this.measureDisk();}catch{/* unavailable disk metrics must not fabricate a low-disk danger */}
    let system:SystemSample|undefined;try{const sampled=this.systemSampler();if(Number.isFinite(sampled.systemTotalMemoryMB)&&sampled.systemTotalMemoryMB>0&&Number.isFinite(sampled.systemFreeMemoryMB)&&sampled.systemFreeMemoryMB>=0)system=sampled;else limitations.push('System memory sampling unavailable');}catch{limitations.push('System memory sampling unavailable');}
    for (const limitation of disk.limitations) if (!limitations.includes(limitation)) limitations.push(limitation);
    const queued=Number((this.db.raw.prepare("SELECT COUNT(*) n FROM tasks WHERE status='QUEUED'").get() as {n:number}).n);
    const running=Number((this.db.raw.prepare("SELECT COUNT(*) n FROM tasks WHERE status='RUNNING'").get() as {n:number}).n);
    const pressure=this.nextPressure(source,{treeRssMB:treeRss,systemFreeMemoryMB:system?.systemFreeMemoryMB,systemTotalMemoryMB:system?.systemTotalMemoryMB,diskAvailableBytes:disk.limitations.length?undefined:disk.diskAvailableBytes,cpuPercent});
    const previous=this.stored(source);const stale=Boolean(previous&&sampledAt-Date.parse(previous.sampledAt)>this.sampleTtlMs);
    const samplingStatus:ResourceSamplingStatus=processResult.unavailable?'unavailable':exitedPids.length?'process-exited':'fresh';
    if(stale&&processResult.unavailable)limitations.push('Previous resource metrics are stale');
    return this.transaction(() => {
      const previousPeak=this.readPeak();
      const peak:PeakMetrics={treeRssMB:Math.max(previousPeak.treeRssMB,treeRss),cpuPercent:Math.max(previousPeak.cpuPercent,cpuPercent),dataDirBytes:Math.max(previousPeak.dataDirBytes,disk.dataDirBytes)};
      const snapshot:MonitoredResourceSnapshot={sampledAt:new Date(sampledAt).toISOString(),source,treeRssMB:Math.round(treeRss),selfRssMB:Math.round(selfRss),childRssMB:Math.round(treeRss-selfRss),heapUsedMB:Math.round(process.memoryUsage().heapUsed/1048576),cpuPercent:Math.round(cpuPercent),handles:process.getActiveResourcesInfo().length,processes:all,systemFreeMemoryMB:Math.round(system?.systemFreeMemoryMB??0),systemTotalMemoryMB:Math.round(system?.systemTotalMemoryMB??0),dataDirBytes:disk.dataDirBytes,diskAvailableBytes:disk.diskAvailableBytes,queuedTasks:queued,runningTasks:running,peakTreeRssMB:Math.round(peak.treeRssMB),pressure,limitations,samplingStatus,sampling:{status:samplingStatus,attempts:processResult.attempts,retrying:false,stale,exitedPids}};
      this.db.raw.prepare('INSERT INTO resource_samples (source,snapshot_json,created_at) VALUES (?,?,?)').run(source,JSON.stringify(snapshot),snapshot.sampledAt);
      this.db.setSetting('resource_peak',JSON.stringify(peak));
      this.db.setSetting(`resource_snapshot_${source}`,JSON.stringify(snapshot));
      const cutoff=new Date(sampledAt-this.resourceRetentionDays*86400000).toISOString();
      this.db.raw.prepare('DELETE FROM resource_samples WHERE created_at<? AND id NOT IN (SELECT MAX(id) FROM resource_samples GROUP BY source)').run(cutoff);
      this.db.raw.prepare('DELETE FROM resource_samples WHERE id NOT IN (SELECT id FROM resource_samples ORDER BY id DESC LIMIT ?)').run(this.resourceRetentionMaxRows);
      return snapshot;
    });
  }

  private nextPressure(source:'api'|'worker'|'desktop',metrics:PressureMetrics): ResourceSnapshot['pressure'] {
    const previous=this.pressureStates.get(source)??{level:'normal' as const,normalSamples:0};
    let severity=0;
    const escalate=(level:ResourceSnapshot['pressure']) => {
      severity=Math.max(severity,level==='danger'?2:1);
    };
    const thresholds=effectiveResourceThresholds(this.thresholds,metrics.systemTotalMemoryMB??0);
    if (metrics.treeRssMB>=thresholds.hardRssMb) escalate('danger');
    else if (metrics.treeRssMB>=thresholds.softRssMb) escalate('pressure');
    const memoryFloor=thresholds.minSystemFreeMemoryMB;
    if (memoryFloor!==undefined && memoryFloor>0 && metrics.systemFreeMemoryMB!==undefined) {
      if (metrics.systemFreeMemoryMB<=memoryFloor/2) escalate('danger');
      else if (metrics.systemFreeMemoryMB<=memoryFloor) escalate('pressure');
    }
    const diskFloor=this.thresholds.minDiskFreeBytes;
    if (diskFloor!==undefined && diskFloor>0 && metrics.diskAvailableBytes!==undefined) {
      if (metrics.diskAvailableBytes<=diskFloor/2) escalate('danger');
      else if (metrics.diskAvailableBytes<=diskFloor) escalate('pressure');
    }
    const cpuCeiling=this.thresholds.maxCpuPercent;
    if (cpuCeiling!==undefined && cpuCeiling>0) {
      if (metrics.cpuPercent>=Math.min(100,cpuCeiling*1.1)) escalate('danger');
      else if (metrics.cpuPercent>=cpuCeiling) escalate('pressure');
    }
    const candidate:ResourceSnapshot['pressure']=severity===2?'danger':severity===1?'pressure':'normal';
    let level=previous.level;
    let normalSamples=previous.normalSamples;
    if (candidate==='danger') {
      level='danger';
      normalSamples=0;
    } else if (candidate==='pressure') {
      if (level==='normal') level='pressure';
      normalSamples=0;
    } else if (level==='normal') {
      normalSamples=0;
    } else {
      normalSamples++;
      const required=level==='danger'?this.dangerRecoverySamples:this.pressureRecoverySamples;
      if (normalSamples>=required) {
        level='normal';
        normalSamples=0;
      }
    }
    this.pressureStates.set(source,{level,normalSamples});
    return level;
  }

  private readPeak(): PeakMetrics {
    try {
      const value=JSON.parse(this.db.settings().resource_peak??'{}') as Partial<PeakMetrics>;
      return {treeRssMB:Number(value.treeRssMB??0),cpuPercent:Number(value.cpuPercent??0),dataDirBytes:Number(value.dataDirBytes??0)};
    } catch { return {treeRssMB:0,cpuPercent:0,dataDirBytes:0}; }
  }

  private measureDisk(): Promise<DiskSample> {
    if (this.diskCache && this.now()-this.diskCache.at<this.diskSampleTtlMs) return Promise.resolve(this.diskCache.value);
    if (this.diskInFlight) return this.diskInFlight;
    const pending=this.diskSampler().then(value => {
      this.diskCache={at:this.now(),value};
      return value;
    }).finally(() => {
      if (this.diskInFlight===pending) this.diskInFlight=undefined;
    });
    this.diskInFlight=pending;
    return pending;
  }

  private async scanDisk(): Promise<DiskSample> {
    const limitations:string[]=[];
    let dataDirBytes=0;
    let diskAvailableBytes=0;
    try {
      const info=await statfs(this.dataDir);
      diskAvailableBytes=Number(info.bavail)*Number(info.bsize);
    } catch { limitations.push('Disk usage sampling incomplete'); }
    let entries=0;
    let truncated=false;
    const walk=async(dir:string,depth:number) => {
      if (depth>2 || truncated) return;
      let children;
      try { children=await readdir(dir,{withFileTypes:true}); }
      catch {
        if (depth===0) limitations.push('Disk usage sampling incomplete');
        return;
      }
      for (const entry of children) {
        if (++entries>10000) { truncated=true; return; }
        if (entry.isSymbolicLink()) continue;
        const file=path.join(dir,entry.name);
        if (entry.isDirectory()) await walk(file,depth+1);
        else if (entry.isFile()) {
          const info=await lstat(file).catch(() => undefined);
          dataDirBytes+=info?.size??0;
        }
      }
    };
    await walk(this.dataDir,0);
    if (truncated) limitations.push('Data-directory scan truncated after 10000 entries');
    return {dataDirBytes,diskAvailableBytes,limitations};
  }

  stored(source:'api'|'worker'|'desktop'):MonitoredResourceSnapshot | undefined {
    const value=this.db.settings()[`resource_snapshot_${source}`];
    if (!value) return;
    try { const parsed=JSON.parse(value) as Partial<MonitoredResourceSnapshot>;return {...parsed,samplingStatus:parsed.samplingStatus??'fresh',sampling:parsed.sampling??{status:'fresh',attempts:1,retrying:false,stale:false,exitedPids:[]}} as MonitoredResourceSnapshot; } catch { return; }
  }

  circuit(level:'pressure'|'danger',reason:string,taskId?:string,snapshot?:ResourceSnapshot): boolean {
    const at=this.now();
    const key=`${level}\u0000${reason}`;
    const last=this.circuitTimes.get(key);
    if (last!==undefined && at-last<this.circuitDedupWindowMs) return false;
    const inserted=this.transaction(() => {
      const latest=this.db.raw.prepare('SELECT created_at FROM circuit_events WHERE level=? AND reason=? ORDER BY id DESC LIMIT 1').get(level,reason) as {created_at:string} | undefined;
      if (latest && at-Date.parse(latest.created_at)<this.circuitDedupWindowMs) return false;
      this.db.raw.prepare('INSERT INTO circuit_events (task_id,level,reason,snapshot_json,created_at) VALUES (?,?,?,?,?)').run(taskId??null,level,reason,JSON.stringify(snapshot??null),new Date(at).toISOString());
      return true;
    });
    if (inserted) this.circuitTimes.set(key,at);
    return inserted;
  }

  private transaction<T>(work:() => T): T {
    this.db.raw.exec('BEGIN IMMEDIATE');
    try {
      const result=work();
      this.db.raw.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.db.raw.exec('ROLLBACK'); } catch { /* preserve the original error */ }
      throw error;
    }
  }
}

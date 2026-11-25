import path from 'node:path';
import { Database, WorkflowEngine, AnalysisCache, RetentionService, ResourceMonitor } from '@reverse/workflow';
import { adapters } from '@reverse/core';
import { decryptSecret, encryptionKey } from '@reverse/security';
const dataDir=path.resolve(process.env.RE_DATA_DIR??'data');
const db=new Database(path.join(dataDir,'reverse-everything.sqlite'));
function envNumber(name:string,fallback:number){const value=Number(process.env[name]??fallback);return Number.isFinite(value)&&value>0?value:fallback;}
const thresholds={softRssMb:envNumber('RE_WORKER_SOFT_RSS_MB',700),hardRssMb:envNumber('RE_WORKER_MAX_RSS_MB',950),minSystemFreeMemoryMB:envNumber('RE_MIN_SYSTEM_FREE_MEMORY_MB',1024),minDiskFreeBytes:envNumber('RE_MIN_DISK_FREE_MB',1024)*1048576,maxCpuPercent:envNumber('RE_MAX_CPU_PERCENT',90)};
const retention=new RetentionService(db,dataDir);const cache=new AnalysisCache(db,dataDir,{maxBytes:retention.policy().cacheMaxBytes,ttlDays:retention.policy().cacheDays});const resources=new ResourceMonitor(db,dataDir,thresholds);
const engine=new WorkflowEngine(db,{dataDir,adapters,timeoutMs:envNumber('RE_TASK_TIMEOUT_MS',300000),maxQueue:envNumber('RE_MAX_QUEUE',100),maxDiskMB:envNumber('RE_TASK_MAX_DISK_MB',1024),cache,resources,thresholds,...(process.env.RE_WORKER_ID?{workerId:process.env.RE_WORKER_ID}:{}),leaseMs:envNumber('RE_WORKER_LEASE_MS',15000),getAiConfig:async()=>{const settings=db.settings();let apiKey='';if(settings.ai_api_key_enc){try{apiKey=decryptSecret(settings.ai_api_key_enc,await encryptionKey(dataDir));}catch{apiKey='';}}return {enabled:settings.ai_enabled==='true',baseUrl:settings.ai_base_url??'',model:settings.ai_model??'',allowRemoteData:settings.ai_allow_remote==='true',promptVersion:'analysis-v1',...(apiKey?{apiKey}:{})};}});
engine.start();console.log(`[worker] ready; data=${dataDir}; concurrency=1; schema=${db.migration.version}`);
let stopping=false;async function stop(){if(stopping)return;stopping=true;console.log('[worker] stopping after current checkpoint');await engine.close();db.close();process.exit(0);}process.on('SIGINT',()=>void stop());process.on('SIGTERM',()=>void stop());

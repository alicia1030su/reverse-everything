import path from 'node:path';
import { Database, WorkflowEngine } from '@reverse/workflow';
import { adapters } from '@reverse/core';
import { decryptSecret, encryptionKey } from '@reverse/security';
const dataDir=path.resolve(process.env.RE_DATA_DIR??'data');
const db=new Database(path.join(dataDir,'reverse-everything.sqlite'));
const engine=new WorkflowEngine(db,{dataDir,adapters,timeoutMs:Number(process.env.RE_TASK_TIMEOUT_MS??300000),maxRssMb:Number(process.env.RE_WORKER_MAX_RSS_MB??1024),getAiConfig:async()=>{const settings=db.settings();let apiKey='';if(settings.ai_api_key_enc){try{apiKey=decryptSecret(settings.ai_api_key_enc,await encryptionKey(dataDir));}catch{apiKey='';}}return {enabled:settings.ai_enabled==='true',baseUrl:settings.ai_base_url??'',model:settings.ai_model??'',...(apiKey?{apiKey}:{})};}});
engine.start();
console.log(`[worker] ready; data=${dataDir}; concurrency=1`);
let stopping=false;
async function stop(){ if(stopping)return; stopping=true; console.log('[worker] stopping after current checkpoint'); await engine.close(); db.close(); process.exit(0); }
process.on('SIGINT',()=>void stop()); process.on('SIGTERM',()=>void stop());

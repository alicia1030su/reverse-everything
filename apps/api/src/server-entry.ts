import path from 'node:path';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import { buildServer } from './server.js';
const dataDir=path.resolve(process.env.RE_DATA_DIR??'data');
const moduleRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const resourceDir=path.resolve(process.env.RE_RESOURCE_DIR??moduleRoot);
const webDir=path.join(resourceDir,'apps/web/dist');
const {app,db}=await buildServer({dataDir,webDir,resourceDir,logger:process.env.NODE_ENV!=='test'});
const host=process.env.RE_HOST??'127.0.0.1'; const port=Number(process.env.RE_PORT??4173);
const normalizedHost=host.replace(/^\[|\]$/g,'').toLowerCase();const local=normalizedHost==='localhost'||normalizedHost==='::1'||(isIP(normalizedHost)===4&&normalizedHost.startsWith('127.'));
if(!local&&process.env.RE_ALLOW_REMOTE!=='true')throw new Error('Remote listening requires RE_ALLOW_REMOTE=true and RE_ALLOWED_HOSTS');
if(!local&&!process.env.RE_ALLOWED_HOSTS?.split(',').some(host=>host.trim()))throw new Error('RE_ALLOWED_HOSTS is required for remote listening');
await app.listen({host,port});
console.log(`[api] listening on http://${host}:${port}; data=${dataDir}`);
let stopping=false;
async function stop(){if(stopping)return;stopping=true;await app.close();db.close();process.exit(0);}
process.on('SIGINT',()=>void stop());process.on('SIGTERM',()=>void stop());

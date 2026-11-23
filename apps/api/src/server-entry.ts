import path from 'node:path';
import { existsSync } from 'node:fs';
import { buildServer } from './server.js';
const dataDir=path.resolve(process.env.RE_DATA_DIR??'data');
const webCandidates=[path.resolve('apps/web/dist'),path.resolve('../web/dist')];
const webDir=webCandidates.find(existsSync)??webCandidates[0]!;
const {app,db}=await buildServer({dataDir,webDir,logger:process.env.NODE_ENV!=='test'});
const host=process.env.RE_HOST??'127.0.0.1'; const port=Number(process.env.RE_PORT??4173);
await app.listen({host,port});
console.log(`[api] listening on http://${host}:${port}; data=${dataDir}`);
let stopping=false;
async function stop(){if(stopping)return;stopping=true;await app.close();db.close();process.exit(0);}
process.on('SIGINT',()=>void stop());process.on('SIGTERM',()=>void stop());

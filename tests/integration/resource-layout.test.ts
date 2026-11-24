import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { VERSION } from '@reverse/contracts';
import { buildServer } from '../../apps/api/src/server.js';

const repoRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const dirs:string[]=[];
const children=new Set<ChildProcess>();
afterEach(async()=>{for(const child of children){if(child.exitCode===null){child.kill();await once(child,'exit');}}children.clear();for(const dir of dirs.splice(0))await rm(dir,{recursive:true,force:true});});
async function temp(){const dir=await mkdtemp(path.join(os.tmpdir(),'re-resource-layout-'));dirs.push(dir);return dir;}
async function fixture(){const dir=await temp();const files:Record<string,string>={
  'apps/web/dist/index.html':'<!doctype html><title>resource-layout-fixture</title>',
  [`docs/api/openapi-v${VERSION}.json`]:JSON.stringify({openapi:'3.1.0',info:{title:'resource-layout-fixture',version:VERSION}}),
  'examples/demo-game/captured-trace.json':JSON.stringify({format:'replay-trace/v1',fixture:true}),
  'node_modules/playwright/cli.js':'process.exit(0);'
};for(const [relative,content] of Object.entries(files)){const file=path.join(dir,relative);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,content);}return dir;}
async function freePort(){return new Promise<number>((resolve,reject)=>{const server=createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const address=server.address();const port=address&&typeof address==='object'?address.port:0;server.close(error=>error?reject(error):resolve(port));});});}
async function waitFor(check:()=>Promise<boolean>|boolean,timeout=20000){const deadline=Date.now()+timeout;while(Date.now()<deadline){if(await check())return;await new Promise(resolve=>setTimeout(resolve,100));}throw new Error('Timed out waiting for resource layout condition');}

describe('release resource layout',()=>{
  it('uses an explicit resourceDir instead of repository CWD assets',async()=>{
    const resourceDir=await fixture();const dataDir=await temp();const built=await buildServer({resourceDir,dataDir,token:'resource-layout-token',backgroundResources:false});
    try{
      const html=await built.app.inject({method:'GET',url:'/'});expect(html.statusCode).toBe(200);expect(html.body).toContain('resource-layout-fixture');
      const spec=await built.app.inject({method:'GET',url:'/api/openapi.json',headers:{authorization:'Bearer resource-layout-token'}});expect(spec.statusCode).toBe(200);expect(spec.json().info.title).toBe('resource-layout-fixture');
      const trace=await built.app.inject({method:'GET',url:'/api/demo/trace',headers:{authorization:'Bearer resource-layout-token'}});expect(trace.statusCode).toBe(200);expect(trace.json().fixture).toBe(true);
    }finally{await built.app.close();built.db.close();}
  });
  it('prefers an explicit webDir over resourceDir',async()=>{
    const resourceDir=await fixture();const webDir=await temp();await writeFile(path.join(webDir,'index.html'),'<title>explicit-web-dir</title>');const built=await buildServer({resourceDir,webDir,dataDir:await temp(),token:'resource-layout-token',backgroundResources:false});
    try{const html=await built.app.inject({method:'GET',url:'/'});expect(html.statusCode).toBe(200);expect(html.body).toContain('explicit-web-dir');}finally{await built.app.close();built.db.close();}
  });
  it('returns 404 for missing resources instead of falling back to repository CWD',async()=>{
    const built=await buildServer({resourceDir:await temp(),dataDir:await temp(),token:'resource-layout-token',backgroundResources:false});
    try{expect((await built.app.inject({method:'GET',url:'/'})).statusCode).toBe(404);expect((await built.app.inject({method:'GET',url:'/api/openapi.json',headers:{authorization:'Bearer resource-layout-token'}})).statusCode).toBe(404);}finally{await built.app.close();built.db.close();}
  });
  it('ships explicit remote defaults and still refuses unconfigured remote listening',async()=>{
    const dockerfile=await readFile(path.join(repoRoot,'Dockerfile'),'utf8');expect(dockerfile).toMatch(/RE_ALLOW_REMOTE=true/);expect(dockerfile).toMatch(/RE_ALLOWED_HOSTS=127\.0\.0\.1:4173,localhost:4173/);
    for(const [allowRemote,allowedHosts,message] of [['false','','Remote listening requires RE_ALLOW_REMOTE=true'],['true',' , ','RE_ALLOWED_HOSTS is required for remote listening']] as const){const port=await freePort();let output='';const child=spawn(process.execPath,[path.join(repoRoot,'apps/api/dist/server-entry.js')],{cwd:await temp(),env:{...process.env,NODE_ENV:'test',RE_DATA_DIR:await temp(),RE_HOST:'0.0.0.0',RE_PORT:String(port),RE_ALLOW_REMOTE:allowRemote,RE_ALLOWED_HOSTS:allowedHosts},stdio:['ignore','pipe','pipe']});children.add(child);child.stdout?.on('data',chunk=>output+=chunk.toString());child.stderr?.on('data',chunk=>output+=chunk.toString());let timer:ReturnType<typeof setTimeout>|undefined;
      try{const code=await Promise.race([once(child,'exit').then(([exitCode])=>exitCode),new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error(`Remote server did not exit: ${output}`)),5000);})]).finally(()=>{if(timer)clearTimeout(timer);});expect(code).not.toBe(0);expect(output).toContain(message);}finally{if(child.exitCode===null){child.kill();await once(child,'exit');}children.delete(child);}}
  });
  it('serves packaged assets and resolves Playwright from a neutral working directory',async()=>{
    const resourceDir=await fixture();const neutralDir=await temp();const dataDir=path.join(neutralDir,'data');const port=await freePort();const base=`http://127.0.0.1:${port}`;let output='';
    const child=spawn(process.execPath,[path.join(repoRoot,'apps/api/dist/server-entry.js')],{cwd:neutralDir,env:{...process.env,NODE_ENV:'test',RE_DATA_DIR:dataDir,RE_RESOURCE_DIR:resourceDir,RE_HOST:'127.0.0.1',RE_PORT:String(port),RE_ALLOW_REMOTE:'false',RE_RATE_LIMIT_PER_MIN:'1000'},stdio:['ignore','pipe','pipe']});children.add(child);child.stdout?.on('data',chunk=>output+=chunk.toString());child.stderr?.on('data',chunk=>output+=chunk.toString());
    try{
      await waitFor(async()=>{if(child.exitCode!==null)throw new Error(`server-entry exited ${child.exitCode}: ${output}`);try{return (await fetch(`${base}/api/health`,{signal:AbortSignal.timeout(500)})).ok;}catch{return false;}});
      const token=(await readFile(path.join(dataDir,'local-token'),'utf8')).trim();const headers={authorization:`Bearer ${token}`};
      const html=await fetch(`${base}/`);expect(html.status).toBe(200);expect(html.headers.get('content-type')).toContain('text/html');expect(await html.text()).toContain('resource-layout-fixture');
      const spec=await fetch(`${base}/api/openapi.json`,{headers});expect(spec.status).toBe(200);expect((await spec.json() as {info:{title:string}}).info.title).toBe('resource-layout-fixture');
      const trace=await fetch(`${base}/api/demo/trace`,{headers});expect(trace.status).toBe(200);expect((await trace.json() as {fixture:boolean}).fixture).toBe(true);
      const install=await fetch(`${base}/api/system/browser/install`,{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({confirm:true})});expect(install.status).toBe(200);
      await waitFor(async()=>{const response=await fetch(`${base}/api/system/browser/install`,{headers});const state=await response.json() as {status:string};return state.status==='completed'||state.status==='failed';});
      const state=await fetch(`${base}/api/system/browser/install`,{headers}).then(response=>response.json() as Promise<{status:string}>);expect(state.status).toBe('completed');
    }finally{if(child.exitCode===null){child.kill();await once(child,'exit');}children.delete(child);}
  });
});

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { EvidenceKind, Upload } from '@reverse/contracts';
import type { TaskContext } from '@reverse/workflow';
import { securityAdapter } from '../../packages/core/src/adapters/security.js';

const dirs:string[]=[];
afterEach(async()=>{for(const dir of dirs.splice(0))await rm(dir,{recursive:true,force:true});});

async function bounded<T>(promise:Promise<T>,timeoutMs=2000):Promise<T>{
  let timer:NodeJS.Timeout|undefined;
  try{return await Promise.race([promise,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error(`Condition exceeded ${timeoutMs}ms`)),timeoutMs);})]);}
  finally{if(timer)clearTimeout(timer);}
}

async function securityContext(content:Buffer){
  const dataDir=await mkdtemp(path.join(os.tmpdir(),'re-security-scan-'));dirs.push(dataDir);
  const projectId='scan-project';const uploadDir=path.join(dataDir,'uploads',projectId);await mkdir(uploadDir,{recursive:true});
  const storedName='fixture.js';await writeFile(path.join(uploadDir,storedName),content);
  const upload:Upload={id:'scan-upload',projectId,name:'fixture.js',storedName,mime:'text/javascript',size:content.length,sha256:'fixture',createdAt:new Date().toISOString()};
  const evidence:{kind:EvidenceKind;title:string;source:string;locator:string;content:unknown}[]=[];
  const ctx:TaskContext={
    taskId:'scan-task',
    project:{id:projectId,name:'scan',kind:'security',target:'fixture.js',authorizationConfirmed:true,createdAt:new Date().toISOString()},
    upload,options:{},stageOutputs:{},artifactDir:path.join(dataDir,'artifacts'),dataDir,signal:new AbortController().signal,
    log:async()=>{},
    evidence:async(kind,title,source,locator,value)=>{evidence.push({kind,title,source,locator,content:value});return `evidence-${evidence.length}`;},
    finding:async()=>{throw new Error('Unexpected finding during static analysis');},
    writeArtifact:async()=>{},
  };
  return {ctx,evidence};
}

describe('security static scan bounds',()=>{
  it('declares truncation and does not treat a malicious tail beyond 5MB as fully scanned',async()=>{
    const maliciousTail=Buffer.from('\napi_key = "abcdefghijklmnop"\n');
    const content=Buffer.concat([Buffer.alloc(5_000_000,0x61),maliciousTail]);
    const {ctx,evidence}=await securityContext(content);

    const analysis=await securityAdapter.analyze(ctx) as {truncated:boolean;checks:{id:string}[];limitations:string[]};

    expect(analysis.truncated).toBe(true);
    expect(analysis.checks.some(check=>check.id==='SECRET')).toBe(false);
    expect(analysis.limitations.some(item=>item.includes('trailing')&&item.includes(`${maliciousTail.length} bytes were not scanned`))).toBe(true);
    expect(evidence).toContainEqual(expect.objectContaining({kind:'UNKNOWN',title:'Static review truncated',content:expect.objectContaining({truncated:true,totalBytes:content.length,scannedBytes:5_000_000,unscannedBytes:maliciousTail.length})}));

    ctx.stageOutputs.ANALYZE=analysis;
    const validation=await securityAdapter.validate(ctx) as {truncated:boolean;limitations:string[]};
    expect(validation.truncated).toBe(true);
    expect(validation.limitations).toContain(`Static rules scanned only the first 5000000 bytes; trailing ${maliciousTail.length} bytes were not scanned`);
  });

  it('does not claim truncation when the complete file fits the scan budget',async()=>{
    const {ctx,evidence}=await securityContext(Buffer.from('const answer = 42;\n'));

    const analysis=await securityAdapter.analyze(ctx) as {truncated:boolean;checks:unknown[];limitations:string[]};

    expect(analysis.truncated).toBe(false);
    expect(analysis.checks).toEqual([]);
    expect(analysis.limitations.some(item=>item.includes('not scanned'))).toBe(false);
    expect(evidence.some(item=>item.kind==='UNKNOWN')).toBe(false);
    ctx.stageOutputs.ANALYZE=analysis;
    expect(await securityAdapter.validate(ctx)).toMatchObject({passed:true,truncated:false});
  });
});

describe('security passive HTTP cancellation',()=>{
  it('aborts a stalled response and closes the connection when the task signal is aborted',async()=>{
    const {ctx}=await securityContext(Buffer.alloc(0));delete ctx.upload;
    ctx.options={allowLocal:true,confirmLocal:true};
    const controller=new AbortController();ctx.signal=controller.signal;
    let markRequest!:()=>void;const requestSeen=new Promise<void>(resolve=>{markRequest=resolve;});
    let markClosed!:()=>void;const connectionClosed=new Promise<void>(resolve=>{markClosed=resolve;});
    const server=http.createServer((_req,res)=>{
      res.once('close',markClosed);
      res.writeHead(200,{'content-length':String(10_000_000)});
      res.write('a');
      markRequest();
    });
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const address=server.address();if(!address||typeof address==='string')throw new Error('Test HTTP server did not bind a TCP port');
    ctx.project.target=`http://127.0.0.1:${(address as AddressInfo).port}/`;
    try{
      const started=performance.now();const analysis=securityAdapter.analyze(ctx);
      await bounded(requestSeen);
      controller.abort(new DOMException('Task cancelled','AbortError'));
      await expect(bounded(analysis)).rejects.toMatchObject({name:'AbortError'});
      await bounded(connectionClosed);
      expect(performance.now()-started).toBeLessThan(2000);
    }finally{
      server.closeAllConnections();
      await new Promise<void>(resolve=>server.close(()=>resolve()));
    }
  });
});

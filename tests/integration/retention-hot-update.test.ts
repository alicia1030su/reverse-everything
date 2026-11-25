import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../../apps/api/src/server.js';

const dirs:string[]=[];const cleanups:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse())await cleanup();for(const dir of dirs.splice(0))await rm(dir,{recursive:true,force:true});});

describe('retention API hot updates',()=>{
  it('applies cache, resource-row and disk thresholds without restarting the API',async()=>{
    const dataDir=await mkdtemp(path.join(os.tmpdir(),'re-retention-api-'));dirs.push(dataDir);const built=await buildServer({dataDir,token:'retention-token',backgroundResources:false});cleanups.push(async()=>{await built.app.close();if(built.db.raw.isOpen)built.db.close();});const headers={authorization:'Bearer retention-token','content-type':'application/json'};
    const response=await built.app.inject({method:'PUT',url:'/api/retention',headers,payload:{cacheMaxBytes:128,resourceMaxRows:1,diskWarningFreeBytes:Number.MAX_SAFE_INTEGER}});expect(response.statusCode).toBe(200);expect(response.json()).toMatchObject({cacheMaxBytes:128,resourceMaxRows:1,diskWarningFreeBytes:Number.MAX_SAFE_INTEGER});
    await built.cache.put('oversized','project','p','file','ANALYZE',{payload:'x'.repeat(256)});expect(built.cache.statistics().entries).toBe(0);
    for(let index=0;index<3;index++){const snapshot=await built.resources.sample('api',{fresh:true});expect(snapshot.pressure).toBe('danger');}
    expect(Number((built.db.raw.prepare('SELECT COUNT(*) n FROM resource_samples').get() as {n:number}).n)).toBe(1);
  });
});

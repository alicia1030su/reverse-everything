import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../../apps/api/src/server.js';

const dirs:string[]=[];
afterEach(async()=>{for(const dir of dirs.splice(0))await rm(dir,{recursive:true,force:true});});

describe('OpenAPI route contract',()=>{
  it('documents every real API operation and resolves each documented handler',async()=>{
    const source=await readFile('apps/api/src/server.ts','utf8');
    const spec=JSON.parse(await readFile('docs/api/openapi-v0.0.3.json','utf8')) as {paths:Record<string,Record<string,unknown>>};
    const actual=new Set<string>();
    for(const match of source.matchAll(/app\.(get|post|put|delete)(?:<[^>]+>)?\('([^']+)'/g))actual.add(`${match[1]!.toUpperCase()} ${match[2]}`);
    const documented=new Set<string>();
    for(const [route,methods] of Object.entries(spec.paths))for(const method of Object.keys(methods))documented.add(`${method.toUpperCase()} ${route.replace(/\{([^}]+)\}/g,':$1')}`);
    expect([...actual].sort()).toEqual([...documented].sort());
    const dataDir=await mkdtemp(path.join(os.tmpdir(),'re-openapi-'));dirs.push(dataDir);const built=await buildServer({dataDir,token:'openapi-contract-token',backgroundResources:false});
    try{
      for(const operation of documented){const [method,route]=operation.split(' ') as [string,string];expect(built.app.hasRoute({method:method.toLowerCase() as 'GET',url:route}),operation).toBe(true);}
    }finally{await built.app.close();built.db.close();}
  });
});

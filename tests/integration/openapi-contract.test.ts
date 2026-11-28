import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { VERSION } from '../../apps/cli/src/version.js';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../../apps/api/src/server.js';

const dirs:string[]=[];
afterEach(async()=>{for(const dir of dirs.splice(0))await rm(dir,{recursive:true,force:true});});

describe('OpenAPI route contract',()=>{
  it('keeps released OpenAPI documents byte-for-byte immutable',async()=>{
    const hashes=JSON.parse(await readFile('scripts/openapi-release-hashes.json','utf8')) as Record<string,string>;
    expect(hashes['0.0.7']).toBe('2cdcccaecabf23fe4d5d35da1026cd18bcdf607290cbcc331b21361e2d031aee');
    for(const [version,expected] of Object.entries(hashes)){
      const bytes=await readFile(`docs/api/openapi-v${version}.json`);
      expect(createHash('sha256').update(bytes).digest('hex'),`released OpenAPI v${version}`).toBe(expected);
      expect(JSON.parse(bytes.toString('utf8')).info.version).toBe(version);
    }
  });

  it('generates only the current OpenAPI and refuses to overwrite a released version',async()=>{
    const dir=await mkdtemp(path.join(os.tmpdir(),'re-openapi-generator-'));dirs.push(dir);
    await mkdir(path.join(dir,'scripts'),{recursive:true});await mkdir(path.join(dir,'docs/api'),{recursive:true});
    await copyFile('scripts/generate-openapi.mjs',path.join(dir,'scripts/generate-openapi.mjs'));
    await copyFile('scripts/openapi-release-hashes.json',path.join(dir,'scripts/openapi-release-hashes.json'));
    await copyFile('package.json',path.join(dir,'package.json'));
    const historical=path.join(dir,'docs/api/openapi-v0.0.7.json');const historicalBytes=Buffer.from('released-openapi-sentinel');
    await writeFile(historical,historicalBytes);
    execFileSync(process.execPath,['scripts/generate-openapi.mjs'],{cwd:dir,stdio:'pipe'});
    expect(await readFile(historical)).toEqual(historicalBytes);
    const current=JSON.parse(await readFile(path.join(dir,`docs/api/openapi-v${VERSION}.json`),'utf8'));
    expect(current.info.version).toBe(VERSION);
    expect(current.paths['/api/autopilot/tasks']).toBeDefined();
    const indexPath=path.join(dir,'docs/api/index.html');const generatedIndex=await readFile(indexPath,'utf8');
    expect(generatedIndex).toContain(`openapi-v${VERSION}.json`);
    await writeFile(path.join(dir,'package.json'),JSON.stringify({...JSON.parse(await readFile('package.json','utf8')),version:'0.0.7'}));
    expect(()=>execFileSync(process.execPath,['scripts/generate-openapi.mjs'],{cwd:dir,stdio:'pipe'})).toThrow(/Refusing to overwrite immutable released OpenAPI v0.0.7/);
    expect(await readFile(historical)).toEqual(historicalBytes);
    expect(await readFile(indexPath,'utf8')).toBe(generatedIndex);
  });

  it('documents every real API operation and resolves each documented handler',async()=>{
    const sources=await Promise.all(['apps/api/src/server.ts','apps/api/src/research.ts','apps/api/src/game-revival.ts','apps/api/src/legacy-routes.ts','apps/api/src/hardware.ts','apps/api/src/desktop-metrics.ts','apps/api/src/autopilot-routes.ts','apps/api/src/model-routes.ts','apps/api/src/binary-diff-routes.ts'].map(file=>readFile(file,'utf8')));
    const spec=JSON.parse(await readFile(`docs/api/openapi-v${VERSION}.json`,'utf8')) as {paths:Record<string,Record<string,unknown>>};
    const actual=new Set<string>();
    for(const source of sources)for(const match of source.matchAll(/app\.(get|post|put|delete)\s*(?:<[^>]+>)?\('([^']+)'/g))actual.add(`${match[1]!.toUpperCase()} ${match[2]}`);
    const documented=new Set<string>();
    for(const [route,methods] of Object.entries(spec.paths))for(const method of Object.keys(methods))documented.add(`${method.toUpperCase()} ${route.replace(/\{([^}]+)\}/g,':$1')}`);
    expect([...actual].sort()).toEqual([...documented].sort());
    const dataDir=await mkdtemp(path.join(os.tmpdir(),'re-openapi-'));dirs.push(dataDir);const built=await buildServer({dataDir,token:'openapi-contract-token',backgroundResources:false});
    try{
      for(const operation of documented){const [method,route]=operation.split(' ') as [string,string];expect(built.app.hasRoute({method:method.toLowerCase() as 'GET',url:route}),operation).toBe(true);}
    }finally{await built.app.close();built.db.close();}
  });
});

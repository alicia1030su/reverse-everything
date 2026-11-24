import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { buildCliShrinkwrap } from '../../scripts/package-cli.mjs';

describe('standalone CLI dependency closure',()=>{
  it('uses the exact audited root lock instead of resolving a separate dependency tree',async()=>{
    const rootLock=JSON.parse(await readFile('package-lock.json','utf8')) as {packages:Record<string,{version?:string;dev?:boolean}>};
    const cliPackage=JSON.parse(await readFile('apps/cli/package.json','utf8')) as {name:string;version:string;dependencies:Record<string,string>};
    const shrinkwrap=buildCliShrinkwrap(rootLock,cliPackage);
    expect(shrinkwrap.packages[''].dependencies).toMatchObject({'@modelcontextprotocol/server':'2.4.0',zod:'4.6.7'});
    expect(Object.keys(shrinkwrap.packages).some(name=>name.startsWith('node_modules/@reverse/'))).toBe(false);
    for(const [location,entry] of Object.entries(shrinkwrap.packages)){
      if(!location)continue;
      expect(entry.version,location).toBe(rootLock.packages[location]?.version);
      expect(entry.dev,location).not.toBe(true);
    }
    expect(Object.values(shrinkwrap.packages).some(entry=>entry.version==='4.2.0')).toBe(false);
  });
});

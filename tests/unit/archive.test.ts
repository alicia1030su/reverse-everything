import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import yazl from 'yazl';
import { describe, expect, it } from 'vitest';
import { inspectZip } from '@reverse/security';
async function zip(entries:{name:string;data:Buffer}[]){const dir=await mkdtemp(path.join(os.tmpdir(),'re-zip-'));const file=path.join(dir,'sample.zip');const archive=new yazl.ZipFile();for(const entry of entries)archive.addBuffer(entry.data,entry.name.includes('../')?'safe.txt':entry.name);await new Promise<void>((resolve,reject)=>{archive.outputStream.pipe(createWriteStream(file)).on('close',resolve).on('error',reject);archive.end();});if(entries.some(e=>e.name.includes('../'))){const buffer=await readFile(file);await writeFile(file,Buffer.from(buffer.toString('binary').replaceAll('safe.txt','../x.txt'),'binary'));}return {dir,file};}
describe('archive safety',()=>{
  it('rejects path traversal without extracting',async()=>{const {dir,file}=await zip([{name:'../escape.txt',data:Buffer.from('x')}]);try{await expect(inspectZip(file)).rejects.toThrow(/Unsafe archive path|invalid relative path/);}finally{await rm(dir,{recursive:true,force:true});}});
  it('rejects expansion bombs by declared uncompressed size',async()=>{const {dir,file}=await zip([{name:'zeros.bin',data:Buffer.alloc(2_000_000)}]);try{await expect(inspectZip(file,{maxTotalBytes:100_000})).rejects.toThrow(/expansion limits/);}finally{await rm(dir,{recursive:true,force:true});}});
  it('lists safe entries with bounded metadata',async()=>{const {dir,file}=await zip([{name:'docs/readme.txt',data:Buffer.from('hello')}]);try{await expect(inspectZip(file)).resolves.toEqual([expect.objectContaining({fileName:'docs/readme.txt',uncompressedSize:5})]);}finally{await rm(dir,{recursive:true,force:true});}});
});

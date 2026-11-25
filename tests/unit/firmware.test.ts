import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import yazl from 'yazl';
import { afterEach, describe, expect, it } from 'vitest';
import type { AdapterDefinition, TaskContext } from '@reverse/workflow';
import { analyzeFirmware, parseElf, parseHex, parseUf2 } from '../../packages/firmware/src/index.js';
import { firmwareAdapter } from '../../packages/core/src/adapters/firmware.js';
import { entropyFixture, gptHeader, hexRecord, knownElf, knownHex, knownUf2, mbrHeader, sha256, uf2Block } from '../firmware/fixtures.js';

const dirs:string[]=[];
afterEach(async()=>{for(const dir of dirs.splice(0))await rm(dir,{recursive:true,force:true});});
async function temp():Promise<string>{const dir=await mkdtemp(path.join(os.tmpdir(),'re-firmware-'));dirs.push(dir);return dir;}
async function input(name:string,data:Buffer,options:Record<string,unknown>={}):Promise<{file:string;name:string;options:Record<string,unknown>}>{const dir=await temp(),file=path.join(dir,'sample.bin');await writeFile(file,data);return {file,name,options};}
async function context(name:string,data:Buffer,options:Record<string,unknown>={}):Promise<TaskContext>{
  const dataDir=await temp(),projectId='project',storedName='stored.bin',buffer=Buffer.from(data);const uploadDir=path.join(dataDir,'uploads',projectId),artifactDir=path.join(dataDir,'tasks','task','artifacts');await mkdir(uploadDir,{recursive:true});await mkdir(artifactDir,{recursive:true});await writeFile(path.join(uploadDir,storedName),buffer);
  return {taskId:'task',project:{id:projectId,name:'fixture',kind:'firmware',target:'authorized-local-fixture',authorizationConfirmed:true,createdAt:new Date(0).toISOString()},upload:{id:'upload',projectId,name,storedName,mime:'application/octet-stream',size:buffer.length,sha256:sha256(buffer),createdAt:new Date(0).toISOString()},options,stageOutputs:{},dataDir,signal:new AbortController().signal,log:async()=>{},evidence:async()=> 'evidence',finding:async()=> 'finding',writeArtifact:async(file,content)=>{await writeFile(path.join(artifactDir,file),content);},readArtifact:async file=>readFile(path.join(artifactDir,file))};
}
async function analyze(adapter:AdapterDefinition,ctx:TaskContext):Promise<unknown>{ctx.stageOutputs.PREPARE=await adapter.prepare(ctx);return adapter.analyze(ctx);}
async function zip(entries:{name:string;data:string|Buffer}[]):Promise<Buffer>{const archive=new yazl.ZipFile();for(const entry of entries)archive.addBuffer(Buffer.isBuffer(entry.data)?entry.data:Buffer.from(entry.data),entry.name);return new Promise((resolve,reject)=>{const chunks:Buffer[]=[];archive.outputStream.on('data',(chunk:Buffer)=>chunks.push(chunk));archive.outputStream.on('end',()=>resolve(Buffer.concat(chunks)));archive.outputStream.on('error',reject);archive.end();});}

describe('firmware streaming and format known answers',()=>{
  it('streams SHA256, 64KiB entropy bins and bounded ASCII/UTF-16LE strings',async()=>{
    const data=Buffer.concat([Buffer.from('fixture-boot-version\0'),Buffer.alloc(256),entropyFixture(65536),Buffer.alloc(4),entropyFixture(65536)]);
    const result=await analyzeFirmware(await input('firmware.bin',data));
    expect(result.sha256).toBe(sha256(data));expect(result.entropy.chunkBytes).toBe(65536);expect(result.entropy.bins).toHaveLength(3);expect(result.entropy.bins.map(bin=>bin.size)).toEqual([65536,65536,data.length-131072]);expect(result.entropy.bins[1]!.entropy).toBeGreaterThan(7.9);expect(result.strings.values).toEqual(expect.arrayContaining([expect.objectContaining({value:'fixture-boot-version',encoding:'ASCII',offset:0})]));
    expect(result.strings.count).toBeLessThanOrEqual(result.strings.limit);expect(result.limitations.join(' ')).toMatch(/never execut/);
  });
  it('parses Intel HEX extension records, ranges and byte counts',async()=>{
    const data=knownHex();const result=await analyzeFirmware(await input('known.hex',data));
    expect(result.format).toBe('Intel HEX');expect(result.hex).toMatchObject({recordCount:5,byteCount:7,addressBase:0x10000000,minAddress:0x10000000,maxAddress:0x10000007,types:{0:2,1:1,2:1,4:1},overlaps:[],checksumErrors:[],valid:true});
  });
  it('rejects malformed HEX checksum, overlap, overflow and line/byte limits fail-closed',async()=>{
    const data=knownHex(),bad=Buffer.from(data);const line=bad.toString().indexOf(':040000007F454C46');if(line<0)throw new Error('fixture record missing');bad[line+13]=bad[line+13]===0x30?0x31:0x30;
    await expect(analyzeFirmware(await input('bad.hex',bad))).rejects.toThrow(/checksum/i);
    const overlap=Buffer.from(knownHex().toString().replace(':00000001FF\r\n',hexRecord(0,0,Buffer.from([0x41]))+'\r\n:00000001FF\r\n'));
    expect(await parseHex(overlap,{maxRecords:100,maxBytes:1000})).toMatchObject({valid:false,overlaps:[expect.objectContaining({address:0x10000000})]});
    const overflow=Buffer.from(hexRecord(4,0,Buffer.from([0xff,0xff]))+'\n'+hexRecord(0,0xffff,Buffer.alloc(16))+'\n'+hexRecord(1,0,Buffer.alloc(0))+'\n');
    expect((await parseHex(overflow,{maxRecords:100,maxBytes:1000})).overflow).toBe(true);
    await expect(analyzeFirmware(await input('limit.hex',Buffer.from((hexRecord(0,0,Buffer.alloc(0))+'\n').repeat(20)+hexRecord(1,0,Buffer.alloc(0))+'\n'),{firmwareMaxHexRecords:10}))).rejects.toThrow(/HEX record limit/);
    await expect(analyzeFirmware(await input('bytes.hex',Buffer.from(hexRecord(0,0,Buffer.alloc(32))+'\n'+hexRecord(1,0,Buffer.alloc(0))+'\n'),{firmwareMaxHexBytes:16}))).rejects.toThrow(/HEX byte limit/);
  });
  it('parses UF2 blocks, families and address regions',async()=>{
    const data=knownUf2(),result=await analyzeFirmware(await input('known.uf2',data));
    expect(result.format).toBe('UF2');expect(result.uf2).toMatchObject({blockCount:2,payloadBytes:512,minAddress:0x10000000,maxAddress:0x10000200,families:['0xe48bff59'],addressRegions:[{start:'0x10000000',size:512}],valid:true});
  });
  it('rejects bad UF2 magic, family, payload, block ordering and partial blocks',async()=>{
    const good=knownUf2();
    await expect(analyzeFirmware(await input('magic.uf2',good.subarray(0,511)))).rejects.toThrow(/512|partial/i);
    const magic=Buffer.from(good);magic.writeUInt32LE(0,0);await expect(analyzeFirmware(await input('magic.uf2',magic))).rejects.toThrow(/magic/i);
    const payload=Buffer.from(good);payload.writeUInt32LE(509,20);await expect(analyzeFirmware(await input('payload.uf2',payload))).rejects.toThrow(/payload/i);
    const family=Buffer.concat([uf2Block(Buffer.alloc(256,1),0,2,0x10000000,0x2000,1),uf2Block(Buffer.alloc(256,2),1,2,0x10000000,0x2000,2)]);await expect(analyzeFirmware(await input('family.uf2',family))).rejects.toThrow(/family/i);
    const duplicate=Buffer.concat([uf2Block(Buffer.alloc(256,1),0,1,0x10000000),uf2Block(Buffer.alloc(256,2),0,1,0x10000000)]);await expect(analyzeFirmware(await input('duplicate.uf2',duplicate))).rejects.toThrow(/blockNo|duplicate/i);
  });
  it('parses bounded ELF headers and rejects malformed sizes or offsets',async()=>{
    const result=await parseElf(knownElf());expect(result).toMatchObject({architecture:'x86_64',bits:64,endian:'little',entry:'0x400000',declaredSections:1,declaredProgramHeaders:1,sections:[expect.objectContaining({offset:184,size:8})],programHeaders:[expect.objectContaining({type:'LOAD',offset:184})]});
    const bad=Buffer.from(knownElf());bad.writeBigUInt64LE(2n**63n,32);await expect(parseElf(bad)).rejects.toThrow(/offset|bounds|range/i);
    const short=Buffer.alloc(10);short.set([0x7f,0x45,0x4c,0x46]);await expect(parseElf(short)).rejects.toThrow(/ELF header/i);
  });
});

describe('firmware layouts, components, archives and adapter evidence',()=>{
  it('recognizes GPT and MBR signatures without unpacking',async()=>{
    const gpt=Buffer.concat([Buffer.alloc(512),gptHeader()]),a=await analyzeFirmware(await input('disk.img',gpt));expect(a.layout.formats).toEqual(expect.arrayContaining(['GPT']));expect(a.layout.signatures).toContainEqual(expect.objectContaining({format:'GPT',offset:512}));
    const mbr=await analyzeFirmware(await input('disk.img',mbrHeader()));expect(mbr.layout.formats).toContain('MBR');expect(mbr.layout.signatures).toContainEqual(expect.objectContaining({format:'MBR',offset:0}));
  });
  it('finds component clues with INFERENCE provenance and a CycloneDX SBOM',async()=>{
    const data=Buffer.concat([Buffer.from('BusyBox v1.36.1 (2024-01-01) multi-call binary.\0OpenSSL 3.2.1\0Linux version 6.1.0\0')]);
    const result=await analyzeFirmware(await input('rootfs.bin',data));
    expect(result.components.values).toEqual(expect.arrayContaining([expect.objectContaining({name:'BusyBox',kind:'INFERENCE',offset:0}),expect.objectContaining({name:'OpenSSL',kind:'INFERENCE'}),expect.objectContaining({name:'Linux kernel',kind:'INFERENCE'})]));
    expect(result.sbom).toMatchObject({bomFormat:'CycloneDX',specVersion:'1.5',components:expect.arrayContaining([expect.objectContaining({name:'BusyBox',version:'1.36.1'})])});
    expect(result.securityFindings.unknown).toBe(false);
  });
  it('reports high entropy unknown and risks as candidates with offsets',async()=>{
    const result=await analyzeFirmware(await input('unknown.bin',entropyFixture(65536)));
    expect(result.securityFindings.unknown).toBe(true);expect(result.securityFindings.candidates).toContainEqual(expect.objectContaining({code:'HIGH_ENTROPY_UNKNOWN',offset:0,classification:'UNKNOWN'}));
    const risk=await analyzeFirmware(await input('rootfs.bin',Buffer.from('debug-token=ABCDEFGHIJKLMNOP\0telnetd enabled\0')));expect(risk.securityFindings.candidates).toEqual(expect.arrayContaining([expect.objectContaining({code:'INSECURE_SERVICE',offset:expect.any(Number)}),expect.objectContaining({code:'CREDENTIAL_CANDIDATE'})]));
  });
  it('lists ZIP safely and rejects traversal and expansion bombs',async()=>{
    const archive=await zip([{name:'etc/config',data:'fixture'}]);const result=await analyzeFirmware(await input('update.zip',archive));expect(result.archive).toMatchObject({entries:1,extracted:false});expect(result.archive!.values[0]).toMatchObject({name:'etc/config',uncompressedSize:7});
    const badName=await zip([{name:'safe.txt',data:'x'}]);const traversal=Buffer.from(badName.toString('binary').replaceAll('safe.txt','../x.txt'),'binary');await expect(analyzeFirmware(await input('update.zip',traversal))).rejects.toThrow(/archive|path/i);
    const bomb=await zip([{name:'zeros.bin',data:Buffer.alloc(100_000)}]);await expect(analyzeFirmware(await input('bomb.zip',bomb),{firmwareMaxArchiveRatio:2})).rejects.toThrow(/archive|ratio|expansion/i);
  });
  it('writes six artifacts, evidence, validation and no reconstruction',async()=>{
    const ctx=await context('fixture.hex',knownHex()),result=await analyze(firmwareAdapter,ctx) as Awaited<ReturnType<typeof analyzeFirmware>>;ctx.stageOutputs.ANALYZE=result;
    const extracted=await firmwareAdapter.extractEvidence(ctx);expect(extracted.artifacts.sort()).toEqual(['entropy.json','firmware-analysis.json','layout.json','sbom.json','security-findings.json','strings.json']);
    for(const name of ['firmware-analysis.json','layout.json','entropy.json','strings.json','sbom.json','security-findings.json'])expect(await readFile(path.join(ctx.dataDir,'tasks/task/artifacts',name),'utf8')).not.toHaveLength(0);
    expect(await firmwareAdapter.validate(ctx)).toMatchObject({passed:true});expect(await firmwareAdapter.reconstruct(ctx)).toMatchObject({reconstructed:false});expect(result.hex?.valid).toBe(true);
  });
  it('honors cancellation and rejects unauthorized preparation',async()=>{
    const ctx=await context('cancel.hex',knownHex()),controller=new AbortController(),reason=new DOMException('cancelled','AbortError');ctx.signal=controller.signal;controller.abort(reason);await expect(analyze(firmwareAdapter,ctx)).rejects.toBe(reason);const unauthorized=await context('fixture.bin',knownHex());unauthorized.project.authorizationConfirmed=false;await expect(firmwareAdapter.prepare(unauthorized)).rejects.toThrow(/authorization/i);
  });
});

describe('firmware malicious, signature and resource regressions',()=>{
  it('extracts real UTF-16LE and truncates long strings without retaining unbounded values',async()=>{
    const utf=Buffer.from('wide-fixture-version\0','utf16le'),data=Buffer.concat([utf,Buffer.from('A'.repeat(4096)+'\0')]);const result=await analyzeFirmware(await input('strings.bin',data,{firmwareMaxStringBytes:128,firmwareMaxStrings:2}));
    expect(result.strings.values).toContainEqual(expect.objectContaining({encoding:'UTF-16LE',offset:0,value:'wide-fixture-version'}));expect(result.strings.values.every(item=>item.value.length<=128+'[TRUNCATED]'.length)).toBe(true);expect(result.strings.truncated).toBe(true);
  });
  it('recognizes BIN and IMG layout signatures without unpacking',async()=>{
    const cases:[string,Buffer][]=[
      ['SquashFS',Buffer.from('hsqs')],['UBI',Buffer.from('UBI#')],['UBIFS',Buffer.from([0x31,0x18,0x10,0x06])],['CramFS',Buffer.from([0x45,0x3d,0xcd,0x28])],
      ['JFFS2 (little-endian)',Buffer.from([0x85,0x19,0,0,8,0,0,0])],['gzip',Buffer.from([0x1f,0x8b,8,0])],['zlib',Buffer.from([0x78,0x9c])],['7-Zip',Buffer.from([0x37,0x7a,0xbc,0xaf,0x27,0x1c])],
      ['U-Boot uImage',Buffer.from([0x27,0x05,0x19,0x56])],['Android boot image',Buffer.from('ANDROID!')],['Android sparse image',Buffer.from([0x3a,0xff,0x26,0xed])],
    ];
    for(const [format,data] of cases){const result=await analyzeFirmware(await input('layout.bin',data));expect(result.layout.formats,format).toContain(format);expect(result.limitations.join(' ')).toMatch(/never.*unpacked/);}
    const ext=Buffer.alloc(1082);ext.writeUInt16LE(0xef53,1080);expect((await analyzeFirmware(await input('rootfs.img',ext))).layout.formats).toContain('ext2/3/4 superblock');
    const fat=Buffer.alloc(512);fat.write('FAT32   ',82);expect((await analyzeFirmware(await input('fat.img',fat))).layout.formats).toContain('FAT boot sector');
  });
  it('rejects nested archives, symlinks and malformed ZIP lengths',async()=>{
    await expect(analyzeFirmware(await input('nested.zip',await zip([{name:'nested.zip',data:await zip([{name:'safe.txt',data:'x'}])}])))).rejects.toThrow(/Nested archive/);
    const safe=await zip([{name:'link.txt',data:'x'}]),central=safe.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));expect(central).toBeGreaterThan(0);safe.writeUInt32LE((0xa1ff<<16)>>>0,central+38);await expect(analyzeFirmware(await input('symlink.zip',safe))).rejects.toThrow(/symbolic links/);
    await expect(analyzeFirmware(await input('short.zip',Buffer.from([0x50,0x4b,0x03,0x04])))).rejects.toThrow(/ZIP archive entry limit|Malformed ZIP/);
  });
  it('keeps non-contiguous UF2 address validation linear at 10000 blocks',async()=>{
    const count=10000,data=Buffer.concat(Array.from({length:count},(_,index)=>uf2Block(Buffer.alloc(256),index,count,0x10000000+index*1024)));const started=performance.now(),result=await parseUf2(data,count);expect(performance.now()-started).toBeLessThan(2000);expect(result).toMatchObject({blockCount:count,valid:true,overlaps:0});expect(result.addressRegions).toHaveLength(count);
  });
  it('enforces UF2 block, sequence and address-overflow limits',async()=>{
    await expect(analyzeFirmware(await input('many.uf2',Buffer.concat([uf2Block(Buffer.alloc(256),0,2,0x1000),uf2Block(Buffer.alloc(256),1,2,0x1100)]),{firmwareMaxUf2Blocks:1}))).rejects.toThrow(/block limit/);
    const overflow=uf2Block(Buffer.alloc(256),0,1,0xffffff01);await expect(analyzeFirmware(await input('overflow.uf2',overflow))).rejects.toThrow(/address overflow/);
    const incomplete=Buffer.concat([uf2Block(Buffer.alloc(256),0,2,0x1000)]);await expect(analyzeFirmware(await input('incomplete.uf2',incomplete))).rejects.toThrow(/Incomplete UF2/);
    const overlap=Buffer.concat([uf2Block(Buffer.alloc(256),0,2,0x1000),uf2Block(Buffer.alloc(256),1,2,0x10f0)]);const result=await analyzeFirmware(await input('overlap.uf2',overlap));expect(result.uf2?.valid).toBe(false);expect(result.uf2?.overlaps).toBe(1);
  });
  it('enforces ELF table bounds and count limits',async()=>{
    const bad=Buffer.from(knownElf());bad.writeUInt16LE(5,56);await expect(parseElf(bad)).rejects.toThrow(/program header.*(?:limit|bounds)/i);
    const short=Buffer.from(knownElf());short.writeUInt16LE(0,58);await expect(parseElf(short)).rejects.toThrow(/section header.*bounds/i);
    const missing=knownHex().subarray(0,knownHex().length-13);await expect(analyzeFirmware(await input('missing.hex',missing))).rejects.toThrow(/EOF/);
    const long=Buffer.from(':'+ '0'.repeat(20_000)+'\n');await expect(analyzeFirmware(await input('long.hex',long))).rejects.toThrow(/line.*limit/);
  });
  it('keeps streaming memory bounded for a 32MiB image',async()=>{
    const file=path.join(await temp(),'large.img'),block=entropyFixture(65536),stream=createWriteStream(file);await new Promise<void>((resolve,reject)=>{stream.on('error',reject);stream.on('finish',resolve);for(let index=0;index<512;index++)stream.write(block);stream.end();});const moduleUrl=pathToFileURL(path.resolve('packages/firmware/dist/index.js')).href;const script=`import {analyzeFirmware} from ${JSON.stringify(moduleUrl)};const r=await analyzeFirmware({file:process.argv[1],name:'large.img'});console.log(JSON.stringify({size:r.size,bins:r.entropy.bins.length,read:r.totalReadBytes,maxRSS:process.resourceUsage().maxRSS}));`;
    const {stdout}=await promisify(execFile)(process.execPath,['--input-type=module','-e',script,file],{maxBuffer:4096});const result=JSON.parse(stdout) as {size:number;bins:number;read:number;maxRSS:number};
    expect(result.size).toBe(32*1024*1024);expect(result.bins).toBe(512);expect(result.read).toBeLessThan(result.size*4);expect(result.maxRSS).toBeLessThan(112*1024);
  },30_000);
  it('fails closed on deterministic malformed mutations of known formats',async()=>{
    const fixtures=[knownHex(),knownUf2(),knownElf(),mbrHeader(),await zip([{name:'safe.txt',data:'fixture'}])];
    for(const fixture of fixtures)for(let mutation=0;mutation<6;mutation++){const data=Buffer.from(fixture);data[mutation*17%data.length]=data[mutation*17%data.length]!^0xff;try{const result=await analyzeFirmware(await input('fuzz.bin',data),{firmwareMaxHexRecords:100,firmwareMaxUf2Blocks:100});expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);expect(result.size).toBe(data.length);}catch(error){expect(error).toBeInstanceOf(Error);expect((error as Error).message).not.toMatch(/ENOENT|ECONN|timeout/i);}}
  },30_000);
});

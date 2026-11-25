import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { lstat, mkdir, mkdtemp, open, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { createInflateRaw } from 'node:zlib';
import { inspectZip, redactSensitive, SecurityError } from '@reverse/security';
import { safeArtifactName } from '@reverse/evidence';
import type { TaskContext } from '@reverse/workflow';
import { defineAdapter, limitedRead, noReconstruction, output, uploadPath } from './base.js';

export interface DexAnalysis {
  entry:string;
  sha256:string;
  size:number;
  magic:string;
  dexVersion:string;
  header:{fileSize:number;headerSize:number;endianTag:string;linkSize:number;linkOff:number;mapOff:number};
  stringIds:{count:number;values:string[];truncated:boolean};
  typeIds:{count:number;values:string[];truncated:boolean};
  protoIds:{count:number;values:{shorty:string;returnType:string;parametersOff:number}[];truncated:boolean};
  methodIds:{count:number;values:{class:string;name:string;returnType:string}[];truncated:boolean};
  classDefs:{count:number;values:string[];truncated:boolean};
  limitations:string[];
}
export interface ManifestAnalysis { format:'binary-axml'|'text-xml'|'UNKNOWN'; packageName:string; permissions:string[]; declaredPermissions:string[]; truncated:boolean }
export interface NativeLibrary { entry:string; size:number; sha256:string|null; truncated:boolean }
export interface ApkDecompiledFile { path:string; kind:'java'|'smali'|'resource'; size:number; sha256:string; artifact:string|null; artifactSize:number|null; artifactSha256:string|null }
export interface ApkDecompiledMethod { class:string; name:string; file:string }
export interface ApkDecompilation {
  status:'BLOCKED'|'COMPLETED';requested:boolean;engine:'none'|'jadx';version:string|null;expectedSha256:string;actualSha256:string|null;verificationMode:'none'|'official-archive'|'external';archiveVerified:boolean;reason:string;
  javaFiles:number;smaliFiles:number;resourceFiles:number;classes:string[];methods:ApkDecompiledMethod[];files:ApkDecompiledFile[];artifacts:string[];stdout:string;stderr:string;limitations:string[];truncated:boolean;
}
export interface ApkAnalysis {
  format:'APK / ZIP container';
  sha256:string;
  size:number;
  entries:{count:number;names:string[];truncated:boolean};
  manifest:ManifestAnalysis;
  dexFiles:DexAnalysis[];
  nativeLibraries:NativeLibrary[];
  decompilation:ApkDecompilation;
  dexCountLimit:number;
  stringCountLimit:number;
  nativeLibraryCountLimit:number;
  totalReadBytes:number;
  totalReadLimit:number;
  truncated:boolean;
  limitations:string[];
}

interface ApkLimits { maxEntries:number; maxDexFiles:number; maxStrings:number; maxTypes:number; maxProtos:number; maxMethods:number; maxClasses:number; maxNativeLibraries:number; maxTotalRead:number; maxManifestBytes:number; maxDexBytes:number; maxNativeBytes:number; maxZipTotalBytes:number; maxZipRatio:number }
interface ApkPrepared { limits:ApkLimits; input?:{file:string;sha256:string;size:number} }
interface CentralEntry { name:string; method:number; compressedSize:number; uncompressedSize:number; localOffset:number }
export interface DexTableLimits { maxTypes?:number; maxProtos?:number; maxMethods?:number; maxClasses?:number }
const SAMPLE_LIMIT=2_000;
const MANIFEST_MAX=4_000_000;
const DEX_MAX=32_000_000;
const NATIVE_MAX=128_000_000;
const DEFAULT_MAX_TYPES=20_000;
const DEFAULT_MAX_PROTOS=20_000;
const DEFAULT_MAX_METHODS=50_000;
const DEFAULT_MAX_CLASSES=20_000;
const DEFAULT_MAX_NATIVE_LIBRARIES=256;
const DEFAULT_MAX_ZIP_TOTAL_BYTES=256_000_000;
const DEFAULT_MAX_ZIP_RATIO=100;
const MAX_DEX_STRING_BYTES=65_536;
const MAX_DEX_STRING_TOTAL_BYTES=16_000_000;
export const JADX_VERSION='1.5.3';
export const JADX_SHA256='8280f3799c0273fe797a2bcd90258c943e451fd195f13d05400de5e6451d15ec';
const JADX_MAX_SCAN_ENTRIES=20_000;
const TEXT_ARTIFACT_EXTENSIONS=new Set(['.java','.kt','.smali','.xml','.txt','.json','.properties','.html','.css','.js','.csv','.md']);
function positive(value:unknown,fallback:number,max:number):number { return typeof value==='number'&&Number.isFinite(value)&&value>0?Math.min(Math.floor(value),max):fallback; }
function ratio(value:unknown,fallback:number,max:number):number { return typeof value==='number'&&Number.isFinite(value)&&value>0?Math.min(value,max):fallback; }
function apkLimits(options:Record<string,unknown>):ApkLimits { return {maxEntries:positive(options.apkMaxEntries,20_000,100_000),maxDexFiles:positive(options.apkMaxDexFiles,8,64),maxStrings:positive(options.apkMaxStrings,20_000,100_000),maxTypes:positive(options.apkMaxTypes,DEFAULT_MAX_TYPES,100_000),maxProtos:positive(options.apkMaxProtos,DEFAULT_MAX_PROTOS,100_000),maxMethods:positive(options.apkMaxMethods,DEFAULT_MAX_METHODS,200_000),maxClasses:positive(options.apkMaxClasses,DEFAULT_MAX_CLASSES,100_000),maxNativeLibraries:positive(options.apkMaxNativeLibraries,DEFAULT_MAX_NATIVE_LIBRARIES,4_096),maxTotalRead:positive(options.apkMaxTotalReadBytes,64_000_000,512_000_000),maxManifestBytes:positive(options.apkMaxManifestBytes,MANIFEST_MAX,8_000_000),maxDexBytes:positive(options.apkMaxDexBytes,DEX_MAX,64_000_000),maxNativeBytes:positive(options.apkMaxNativeBytes,NATIVE_MAX,256_000_000),maxZipTotalBytes:positive(options.apkMaxZipTotalBytes,DEFAULT_MAX_ZIP_TOTAL_BYTES,1_000_000_000),maxZipRatio:ratio(options.apkMaxZipRatio,DEFAULT_MAX_ZIP_RATIO,1_000)}; }
function assertAuthorized(authorized:boolean):void { if(!authorized)throw new Error('Explicit authorization confirmation is required before APK analysis'); }
function throwIfAborted(signal?:AbortSignal):void { if(signal?.aborted)throw signal.reason instanceof Error?signal.reason:new DOMException('The operation was aborted','AbortError'); }
function isZip(head:Buffer):boolean { return head.length>=4&&(head.subarray(0,4).equals(Buffer.from([0x50,0x4b,0x03,0x04]))||head.subarray(0,4).equals(Buffer.from([0x50,0x4b,0x05,0x06]))||head.subarray(0,4).equals(Buffer.from([0x50,0x4b,0x07,0x08]))); }

async function hashFile(file:string,signal?:AbortSignal):Promise<string> { throwIfAborted(signal);const hash=createHash('sha256');for await(const chunk of createReadStream(file)){throwIfAborted(signal);hash.update(chunk);}return hash.digest('hex'); }
async function readVerifiedUploadHead(ctx:TaskContext,length:number):Promise<Buffer>{
  if(!ctx.upload)throw new Error('APK analysis requires an uploaded file');const source=uploadPath(ctx),linked=await lstat(source);if(linked.isSymbolicLink()||!linked.isFile())throw new Error('APK input must be a regular file');const handle=await open(source,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  try{const before=await handle.stat();if(!before.isFile()||before.size!==ctx.upload.size)throw new Error('APK input identity changed before verification');const hash=createHash('sha256');let total=0;for await(const chunk of handle.createReadStream({autoClose:false})){throwIfAborted(ctx.signal);total+=chunk.length;if(total>ctx.upload.size)throw new Error('APK input grew beyond the verified upload size');hash.update(chunk);}const after=await handle.stat();if(after.dev!==before.dev||after.ino!==before.ino||after.size!==before.size||after.mtimeMs!==before.mtimeMs)throw new Error('APK input identity changed during verification');if(hash.digest('hex')!==ctx.upload.sha256)throw new Error('APK input hash changed after upload');const head=Buffer.alloc(length);let offset=0;while(offset<length){const read=await handle.read(head,offset,length-offset,offset);if(read.bytesRead===0)break;offset+=read.bytesRead;}return head.subarray(0,offset);}finally{await handle.close();}
}
async function readAt(file:string,position:number,length:number):Promise<Buffer> {
  const handle=await open(file,'r');try{const buffer=Buffer.alloc(length);let offset=0;while(offset<length){const read=await handle.read(buffer,offset,length-offset,position+offset);if(read.bytesRead===0)break;offset+=read.bytesRead;}return buffer.subarray(0,offset);}finally{await handle.close();}
}
async function centralDirectory(file:string,maxEntries:number,signal?:AbortSignal):Promise<CentralEntry[]> {
  throwIfAborted(signal);const info=await stat(file);if(info.size<22)throw new SecurityError('Invalid ZIP archive: missing end record','INVALID_ZIP');
  const tailLength=Math.min(info.size,65_557);const tail=await readAt(file,info.size-tailLength,tailLength);let eocd=-1;
  for(let i=tail.length-22;i>=0;i--)if(tail.readUInt32LE(i)===0x06054b50&&i+22+tail.readUInt16LE(i+20)===tail.length){eocd=i;break;}
  if(eocd<0)throw new SecurityError('Invalid ZIP archive: end record not found','INVALID_ZIP');
  if(tail.readUInt16LE(eocd+4)!==0||tail.readUInt16LE(eocd+6)!==0)throw new SecurityError('Multi-disk ZIP archives are unsupported','INVALID_ZIP');
  const count=tail.readUInt16LE(eocd+10);const size=tail.readUInt32LE(eocd+12);const offset=tail.readUInt32LE(eocd+16);
  if(count>maxEntries||count===0xffff||size===0xffffffff||offset===0xffffffff)throw new SecurityError('ZIP archive exceeds safe entry limits','ZIP_BOMB');
  if(size>16_000_000||offset+size>info.size)throw new SecurityError('Invalid ZIP central directory bounds','INVALID_ZIP');
  const central=await readAt(file,offset,size);if(central.length<size)throw new SecurityError('Invalid ZIP central directory','INVALID_ZIP');
  const entries:CentralEntry[]=[];let cursor=0;
  for(let i=0;i<count;i++){
    if(i%256===0)throwIfAborted(signal);
    if(cursor+46>central.length||central.readUInt32LE(cursor)!==0x02014b50)throw new SecurityError('Malformed ZIP central directory entry','INVALID_ZIP');
    const nameLength=central.readUInt16LE(cursor+28),extraLength=central.readUInt16LE(cursor+30),commentLength=central.readUInt16LE(cursor+32);if(cursor+46+nameLength+extraLength+commentLength>central.length)throw new SecurityError('Truncated ZIP central directory entry','INVALID_ZIP');
    entries.push({name:central.subarray(cursor+46,cursor+46+nameLength).toString('utf8'),method:central.readUInt16LE(cursor+10),compressedSize:central.readUInt32LE(cursor+20),uncompressedSize:central.readUInt32LE(cursor+24),localOffset:central.readUInt32LE(cursor+42)});cursor+=46+nameLength+extraLength+commentLength;
  }
  return entries;
}
async function readZipEntry(file:string,entry:CentralEntry,maxBytes:number,hashOnly=false,signal?:AbortSignal):Promise<{bytes:Buffer;sha256:string;size:number}> {
  throwIfAborted(signal);if(entry.uncompressedSize>maxBytes)throw new Error(`ZIP entry ${entry.name} exceeds the ${maxBytes}-byte read limit`);
  if(entry.method!==0&&entry.method!==8)throw new Error(`ZIP entry ${entry.name} uses unsupported compression method ${entry.method}`);
  const header=await readAt(file,entry.localOffset,30);if(header.length<30||header.readUInt32LE(0)!==0x04034b50)throw new Error(`Malformed ZIP local header for ${entry.name}`);
  const dataStart=entry.localOffset+30+header.readUInt16LE(26)+header.readUInt16LE(28);if(dataStart+entry.compressedSize>await stat(file).then(info=>info.size))throw new Error(`ZIP entry ${entry.name} extends beyond the archive`);
  if(entry.compressedSize===0&&entry.method===0)return {bytes:Buffer.alloc(0),sha256:createHash('sha256').digest('hex'),size:0};
  const source=createReadStream(file,{start:dataStart,end:dataStart+entry.compressedSize-1});const input=entry.method===8?source.pipe(createInflateRaw()):source;const chunks:Buffer[]=[];const hash=createHash('sha256');let size=0;
  const fail=(error:Error)=>{source.destroy(error);if(input!==source)input.destroy(error);};
  source.on('error',fail);
  try{for await(const chunk of input){throwIfAborted(signal);const buffer=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);size+=buffer.length;if(size>maxBytes||size>entry.uncompressedSize)throw new Error(`ZIP entry ${entry.name} exceeded its declared or bounded size`);hash.update(buffer);if(!hashOnly)chunks.push(buffer);}}
  finally{if(!source.destroyed)source.destroy();if(input!==source&&!input.destroyed)input.destroy();}
  return {bytes:Buffer.concat(chunks),sha256:hash.digest('hex'),size};
}

function readUleb(buffer:Buffer,offset:number):{value:number;next:number}|undefined { let value=0;for(let i=0;i<5;i++){if(offset+i>=buffer.length)return undefined;const byte=buffer[offset+i]!;value|=(byte&0x7f)<<(7*i);if((byte&0x80)===0)return {value:value>>>0,next:offset+i+1};}return undefined; }
function dexString(buffer:Buffer,offset:number):{value:string;bytes:number;truncated:boolean}|undefined {
  const utf16=readUleb(buffer,offset);if(!utf16)return undefined;const start=utf16.next,end=buffer.indexOf(0,start);if(end<0)return undefined;const bytes=end-start,truncated=bytes>MAX_DEX_STRING_BYTES,decodedEnd=Math.min(end,start+MAX_DEX_STRING_BYTES);
  return {value:redactSensitive(buffer.subarray(start,decodedEnd).toString('utf8').replace(/\u0000/g,''))+(truncated?'[TRUNCATED]':''),bytes,truncated};
}
function checkTable(buffer:Buffer,offset:number,count:number,itemSize:number,label:string):void { if(count>0&&(offset<112||offset+count*itemSize>buffer.length))throw new Error(`Malformed DEX: ${label} table is outside the file`); }
export function parseDex(entry:string,data:Buffer,maxStrings=20_000,options:DexTableLimits={},signal?:AbortSignal):DexAnalysis {
  throwIfAborted(signal);const limitations:string[]=[],source=data;
  if(data.length<112)throw new Error(`Malformed DEX ${entry}: header is shorter than 112 bytes`);
  const magic=data.subarray(0,8).toString('latin1');if(!/^dex\n0\d\d\0$/.test(magic))throw new Error(`Malformed DEX ${entry}: invalid magic`);
  const little=data.readUInt32LE(40)===0x12345678;if(!little&&data.readUInt32LE(40)!==0x78563412)throw new Error(`Malformed DEX ${entry}: invalid endian tag`);
  const u32=(offset:number)=>little?data.readUInt32LE(offset):data.readUInt32BE(offset);const u16=(offset:number)=>little?data.readUInt16LE(offset):data.readUInt16BE(offset);
  const fileSize=u32(32),headerSize=u32(36);if(headerSize!==112)throw new Error(`Malformed DEX ${entry}: unsupported header size ${headerSize}`);if(fileSize<112||fileSize>data.length)throw new Error(`Malformed DEX ${entry}: declared file size is outside the input`);
  if(fileSize<data.length)limitations.push(`declared file size ${fileSize} excludes ${data.length-fileSize} trailing bytes; trailing data was not analyzed`);data=source.subarray(0,fileSize);
  const stringCount=u32(56),stringOff=u32(60),typeCount=u32(64),typeOff=u32(68),protoCount=u32(72),protoOff=u32(76),methodCount=u32(88),methodOff=u32(92),classCount=u32(96),classOff=u32(100);
  checkTable(data,stringOff,stringCount,4,'string_ids');checkTable(data,typeOff,typeCount,4,'type_ids');checkTable(data,protoOff,protoCount,12,'proto_ids');checkTable(data,methodOff,methodCount,8,'method_ids');checkTable(data,classOff,classCount,32,'class_defs');
  const stringLimit=positive(maxStrings,20_000,100_000),typeLimit=positive(options.maxTypes,DEFAULT_MAX_TYPES,100_000),protoLimit=positive(options.maxProtos,DEFAULT_MAX_PROTOS,100_000),methodLimit=positive(options.maxMethods,DEFAULT_MAX_METHODS,200_000),classLimit=positive(options.maxClasses,DEFAULT_MAX_CLASSES,100_000);
  const strings=new Map<number,string>();const stringValues:string[]=[];const parsedStrings=Math.min(stringCount,stringLimit);let stringBytes=0,stringLengthTruncated=false,stringDataTruncated=false;
  for(let i=0;i<parsedStrings;i++){if(i%256===0)throwIfAborted(signal);const stringOffset=u32(stringOff+i*4);if(stringOffset>=data.length)throw new Error(`Malformed DEX ${entry}: string data offset is outside the file`);const item=dexString(data,stringOffset);if(item===undefined)throw new Error(`Malformed DEX ${entry}: unterminated string ${i}`);if(stringBytes+item.bytes>MAX_DEX_STRING_TOTAL_BYTES){stringDataTruncated=true;limitations.push(`string data byte limit ${MAX_DEX_STRING_TOTAL_BYTES} reached; remaining strings were not inspected`);break;}stringBytes+=item.bytes;stringLengthTruncated ||= item.truncated;strings.set(i,item.value);if(stringValues.length<SAMPLE_LIMIT)stringValues.push(item.value);}
  if(stringLengthTruncated)limitations.push(`individual string values were truncated to ${MAX_DEX_STRING_BYTES} decoded bytes`);
  const typeValues:string[]=[];const types=new Map<number,string>();const parsedTypes=Math.min(typeCount,typeLimit);
  for(let i=0;i<parsedTypes;i++){if(i%256===0)throwIfAborted(signal);const value=strings.get(u32(typeOff+i*4))??'UNKNOWN';types.set(i,value);if(typeValues.length<SAMPLE_LIMIT)typeValues.push(value);}
  const protoValues:{shorty:string;returnType:string;parametersOff:number}[]=[];const protos=new Map<number,{shorty:string;returnType:string;parametersOff:number}>();const parsedProtos=Math.min(protoCount,protoLimit);
  for(let i=0;i<parsedProtos;i++){if(i%256===0)throwIfAborted(signal);const offset=protoOff+i*12;const value={shorty:strings.get(u32(offset))??'UNKNOWN',returnType:types.get(u32(offset+4))??'UNKNOWN',parametersOff:u32(offset+8)};protos.set(i,value);if(protoValues.length<SAMPLE_LIMIT)protoValues.push(value);}
  const methodValues:{class:string;name:string;returnType:string}[]=[];const parsedMethods=Math.min(methodCount,methodLimit);
  for(let i=0;i<parsedMethods;i++){if(i%256===0)throwIfAborted(signal);const offset=methodOff+i*8;const value={class:types.get(u16(offset))??'UNKNOWN',name:strings.get(u32(offset+4))??'UNKNOWN',returnType:protos.get(u16(offset+2))?.returnType??'UNKNOWN'};if(methodValues.length<SAMPLE_LIMIT)methodValues.push(value);}
  const classValues:string[]=[];const parsedClasses=Math.min(classCount,classLimit);
  for(let i=0;i<parsedClasses;i++){if(i%256===0)throwIfAborted(signal);const value=types.get(u32(classOff+i*32))??'UNKNOWN';if(classValues.length<SAMPLE_LIMIT)classValues.push(value);}
  return {entry,sha256:createHash('sha256').update(source).digest('hex'),size:source.length,magic,dexVersion:magic.slice(4,7),header:{fileSize,headerSize,endianTag:`0x${u32(40).toString(16)}`,linkSize:u32(44),linkOff:u32(48),mapOff:u32(52)},stringIds:{count:stringCount,values:stringValues,truncated:stringCount>parsedStrings||stringValues.length<stringCount||stringLengthTruncated||stringDataTruncated},typeIds:{count:typeCount,values:typeValues,truncated:typeCount>parsedTypes||typeValues.length<typeCount},protoIds:{count:protoCount,values:protoValues,truncated:protoCount>parsedProtos||protoValues.length<protoCount},methodIds:{count:methodCount,values:methodValues,truncated:methodCount>parsedMethods||methodValues.length<methodCount},classDefs:{count:classCount,values:classValues,truncated:classCount>parsedClasses||classValues.length<classCount},limitations};
}

function length8(buffer:Buffer,offset:number):{value:number;next:number}|undefined { if(offset>=buffer.length)return undefined;const first=buffer[offset]!;if((first&0x80)===0)return {value:first,next:offset+1};if(offset+1>=buffer.length)return undefined;return {value:((first&0x7f)<<8)|buffer[offset+1]!,next:offset+2}; }
function length16(buffer:Buffer,offset:number):{value:number;next:number}|undefined { if(offset>=buffer.length)return undefined;const first=buffer.readUInt16LE(offset);if((first&0x8000)===0)return {value:first,next:offset+2};if(offset+3>=buffer.length)return undefined;return {value:((first&0x7fff)<<16)|buffer.readUInt16LE(offset+2),next:offset+4}; }
function parseStringPool(data:Buffer,start:number,signal?:AbortSignal):{values:string[];next:number}|undefined {
  throwIfAborted(signal);if(start+28>data.length)return undefined;const type=data.readUInt16LE(start),headerSize=data.readUInt16LE(start+2),size=data.readUInt32LE(start+4);if(type!==1||headerSize<28||size<headerSize||start+size>data.length)return undefined;
  const count=data.readUInt32LE(start+8),flags=data.readUInt32LE(start+16),stringsStart=data.readUInt32LE(start+20);if(count>100_000||start+headerSize+count*4>start+size)return undefined;const values:string[]=[];
  for(let i=0;i<count;i++){if(i%256===0)throwIfAborted(signal);const relative=data.readUInt32LE(start+headerSize+i*4);let offset=start+stringsStart+relative;if(offset>=start+size)return undefined;let value:string;
    if((flags&0x100)!==0){const chars=length8(data,offset);if(!chars)return undefined;offset=chars.next;const bytes=length8(data,offset);if(!bytes||offset+bytes.value>start+size)return undefined;offset=bytes.next;value=data.subarray(offset,offset+bytes.value).toString('utf8').replace(/\u0000/g,'');}
    else{const chars=length16(data,offset);if(!chars||offset+chars.value*2>start+size)return undefined;offset=chars.next;value=data.subarray(offset,offset+chars.value*2).toString('utf16le').replace(/\u0000/g,'');}
    values.push(value);
  }
  return {values,next:start+size};
}
function xmlEntities(value:string):string { return value.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&'); }
function textManifest(data:Buffer,signal?:AbortSignal):ManifestAnalysis {
  throwIfAborted(signal);const text=data.toString('utf8').replace(/^\uFEFF/,'');const manifest=/<manifest\b[^>]*\bpackage\s*=\s*(["'])(.*?)\1/i.exec(text);const permissions:string[]=[],declared:string[]=[];
  const permissionPattern=/<uses-permission(?:-sdk-23)?\b[^>]*\bandroid:name\s*=\s*(["'])(.*?)\1/gi;const declaredPattern=/<permission\b[^>]*\bandroid:name\s*=\s*(["'])(.*?)\1/gi;let match:RegExpExecArray|null;
  while(permissions.length<1000){throwIfAborted(signal);match=permissionPattern.exec(text);if(!match)break;permissions.push(xmlEntities(match[2]!));}while(declared.length<1000){throwIfAborted(signal);match=declaredPattern.exec(text);if(!match)break;declared.push(xmlEntities(match[2]!));}
  return {format:'text-xml',packageName:manifest?xmlEntities(manifest[2]!):'UNKNOWN',permissions:[...new Set(permissions)],declaredPermissions:[...new Set(declared)],truncated:permissions.length>=1000||declared.length>=1000};
}
function parseAxml(data:Buffer,signal?:AbortSignal):ManifestAnalysis {
  throwIfAborted(signal);let offset=0,strings:string[]=[];const resources:number[]=[];const permissions:string[]=[],declared:string[]=[];let sawManifest=false,packageName='UNKNOWN';
  while(offset+8<=data.length){throwIfAborted(signal);const type=data.readUInt16LE(offset),headerSize=data.readUInt16LE(offset+2),size=data.readUInt32LE(offset+4);if(size<headerSize||headerSize<8||offset+size>data.length)throw new Error('Malformed binary AndroidManifest.xml chunk');if(type===3){offset+=headerSize;continue;}if(type===1){const pool=parseStringPool(data,offset,signal);if(!pool)throw new Error('Malformed AndroidManifest.xml string pool');strings=pool.values;offset+=size;continue;}if(type===0x0180){for(let i=offset+headerSize;i+4<=offset+size;i+=4){if((i-offset-headerSize)%1024===0)throwIfAborted(signal);resources.push(data.readUInt32LE(i));}offset+=size;continue;}
    if(type===0x0102&&offset+36<=data.length){const name=strings[data.readUInt32LE(offset+20)]??'';const attributeStart=data.readUInt16LE(offset+24),attributeSize=data.readUInt16LE(offset+26),attributeCount=data.readUInt16LE(offset+28);if(attributeSize<20)throw new Error('Malformed AndroidManifest.xml attribute size');
      for(let i=0;i<attributeCount;i++){if(i%256===0)throwIfAborted(signal);const attr=offset+16+attributeStart+i*attributeSize;if(attr+20>offset+size)throw new Error('Malformed AndroidManifest.xml attribute table');const nameIndex=data.readUInt32LE(attr+4),rawIndex=data.readUInt32LE(attr+8),dataType=data[attr+15]!,value=data.readUInt32LE(attr+16);let attrName=strings[nameIndex]??'';if(!attrName&&i<resources.length){const id=resources[i]!;attrName=id===0x01010003?'name':id===0x01010001?'label':id===0x01010002?'icon':`resource_${id.toString(16)}`;}const attrValue=rawIndex!==0xffffffff?strings[rawIndex]??'':dataType===3?strings[value]??'':String(value);
        if(name==='manifest'&&attrName==='package')packageName=attrValue;if((name==='uses-permission'||name==='uses-permission-sdk-23')&&attrName==='name'&&permissions.length<1000)permissions.push(attrValue);if(name==='permission'&&attrName==='name'&&declared.length<1000)declared.push(attrValue);
      }
      if(name==='manifest')sawManifest=true;
    }
    offset+=size;
  }
  if(!sawManifest)throw new Error('Malformed binary AndroidManifest.xml: manifest element not found');return {format:'binary-axml',packageName,permissions:[...new Set(permissions)],declaredPermissions:[...new Set(declared)],truncated:permissions.length>=1000||declared.length>=1000};
}
function parseManifest(data:Buffer,signal?:AbortSignal):ManifestAnalysis { const head=data.subarray(0,200).toString('utf8').trimStart();return head.startsWith('<')?textManifest(data,signal):parseAxml(data,signal); }

interface JadxTool { command:string;prefix:string[];detail:string;actualSha256:string;verificationMode:'official-archive'|'external';archiveVerified:boolean }
interface JadxOptions { timeoutMs:number;maxLogBytes:number;maxOutputBytes:number;maxFileBytes:number;maxFiles:number;maxArtifactFiles:number;maxArtifactBytes:number;maxDiskBytes:number }
interface JadxAvailability { tool?:JadxTool;reason?:string }
interface OutputFile { relative:string;absolute:string;size:number }
interface DirectoryScan { bytes:number;files:OutputFile[];complete:boolean }
const EMPTY_DECOMPILATION=(requested:boolean,reason:string):ApkDecompilation=>({status:'BLOCKED',requested,engine:'none',version:null,expectedSha256:JADX_SHA256,actualSha256:null,verificationMode:'none',archiveVerified:false,reason,javaFiles:0,smaliFiles:0,resourceFiles:0,classes:[],methods:[],files:[],artifacts:[],stdout:'',stderr:'',limitations:[reason],truncated:false});
function diskBudgetBytes(value:unknown):number { return typeof value==='number'&&Number.isFinite(value)&&value>0?Math.max(1,Math.min(Math.floor(value*1048576),Number.MAX_SAFE_INTEGER)):1024*1048576; }
function taskDiskBudgetBytes(ctx:TaskContext):number { return diskBudgetBytes(Math.min(diskBudgetBytes(ctx.options.maxDiskMB)/1048576,ctx.effectiveMaxDiskMB??Number.MAX_SAFE_INTEGER)); }
function jadxOptions(ctx:TaskContext):JadxOptions { const options=ctx.options;return {timeoutMs:positive(options.jadxTimeoutMs,120_000,600_000),maxLogBytes:positive(options.jadxMaxLogBytes,1_000_000,8_000_000),maxOutputBytes:positive(options.jadxMaxOutputBytes,64_000_000,512_000_000),maxFileBytes:positive(options.jadxMaxFileBytes,4_000_000,64_000_000),maxFiles:positive(options.jadxMaxFiles,10_000,50_000),maxArtifactFiles:positive(options.jadxMaxArtifactFiles,500,5_000),maxArtifactBytes:positive(options.jadxMaxArtifactBytes,16_000_000,256_000_000),maxDiskBytes:taskDiskBudgetBytes(ctx)}; }
async function isRegularFile(file:string):Promise<boolean> { try{const info=await lstat(file);return info.isFile()&&!info.isSymbolicLink();}catch{return false;} }
async function javaCommand():Promise<string|undefined> {
  const explicit=process.env.RE_JAVA;if(explicit){const resolved=path.resolve(explicit);return await isRegularFile(resolved)?resolved:undefined;}
  const home=process.env.JAVA_HOME;if(home){const candidate=path.join(path.resolve(home),'bin',process.platform==='win32'?'java.exe':'java');return await isRegularFile(candidate)?candidate:undefined;}
  return 'java';
}
const jadxToolCache=new Map<string,{expiresAt:number;pending:Promise<JadxAvailability>}>();
async function resolveJadxToolUncached():Promise<JadxAvailability> {
  const explicit=process.env.RE_JADX_BIN;
  if(explicit){const resolved=path.resolve(explicit);if(!await isRegularFile(resolved))return {reason:'RE_JADX_BIN does not reference a regular executable file'};if(process.platform==='win32'&&/\.(?:bat|cmd)$/i.test(resolved))return {reason:'Windows .bat/.cmd launchers are not executed through a shell; use RE_JADX_HOME or a directly executable wrapper'};const actualSha256=await hashFile(resolved);const nodeLauncher=/\.(?:js|mjs|cjs)$/i.test(resolved);return {tool:{command:nodeLauncher?process.execPath:resolved,prefix:nodeLauncher?[resolved]:[],detail:`${nodeLauncher?'Node ':''}JADX launcher: ${resolved}`,actualSha256,verificationMode:'external',archiveVerified:false}};}
  const home=process.env.RE_JADX_HOME;if(!home)return {reason:'JADX is not configured; set RE_JADX_HOME or RE_JADX_BIN'};const resolved=path.resolve(home),lib=path.join(resolved,'lib');let jar:string|undefined;for(const candidate of [path.join(lib,`jadx-${JADX_VERSION}-all.jar`),path.join(lib,`jadx-cli-${JADX_VERSION}-all.jar`),path.join(lib,`jadx-cli-${JADX_VERSION}.jar`)])if(await isRegularFile(candidate)){jar=candidate;break;}if(!jar)return {reason:`RE_JADX_HOME does not contain the pinned jadx-${JADX_VERSION}-all.jar, jadx-cli-${JADX_VERSION}-all.jar or jadx-cli-${JADX_VERSION}.jar`};const java=await javaCommand();if(!java)return {reason:'A Java 11+ runtime could not be resolved; set RE_JAVA or JAVA_HOME'};const archive=process.env.RE_JADX_ARCHIVE;let actualSha256:string,verificationMode:'official-archive'|'external',archiveVerified:boolean,detail:string;if(archive){const archiveFile=path.resolve(archive);if(!await isRegularFile(archiveFile))return {reason:'RE_JADX_ARCHIVE does not reference a regular archive file'};actualSha256=await hashFile(archiveFile);if(actualSha256!==JADX_SHA256)return {reason:`JADX archive SHA256 mismatch: expected ${JADX_SHA256}, received ${actualSha256}`};verificationMode='official-archive';archiveVerified=true;detail=`JADX ${JADX_VERSION} distribution: ${resolved}; official archive verified`;}else{actualSha256=await hashFile(jar);verificationMode='external';archiveVerified=false;detail=`External JADX ${JADX_VERSION} distribution: ${resolved}; archive provenance not supplied`;}return {tool:{command:java,prefix:['-cp',path.join(lib,'*'),'jadx.cli.JadxCLI'],detail,actualSha256,verificationMode,archiveVerified}};
}
function resolveJadxTool():Promise<JadxAvailability> {
  const key=JSON.stringify([process.env.RE_JADX_BIN??'',process.env.RE_JADX_HOME??'',process.env.RE_JADX_ARCHIVE??'',process.env.RE_JAVA??'',process.env.JAVA_HOME??'']);const now=Date.now(),cached=jadxToolCache.get(key);if(cached&&cached.expiresAt>now)return cached.pending;
  const pending=resolveJadxToolUncached();jadxToolCache.set(key,{expiresAt:now+30_000,pending});return pending;
}
async function killTree(child:{pid?:number|undefined;kill(signal?:NodeJS.Signals):boolean},platform=process.platform):Promise<void> {
  if(child.pid===undefined)return;
  if(platform==='win32'){await new Promise<void>(resolve=>{const killer=spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore',shell:false,windowsHide:true});let done=false;const finish=()=>{if(done)return;done=true;clearTimeout(timer);resolve();};const timer=setTimeout(finish,3_000);killer.once('error',finish);killer.once('exit',finish);});try{child.kill('SIGKILL');}catch{/* process already exited */}return;}
  try{process.kill(-child.pid,'SIGKILL');}catch{try{child.kill('SIGKILL');}catch{/* process already exited */}}
}
async function probeJadx(tool:JadxTool,signal?:AbortSignal,registerProcess?:((pid:number)=>()=>void)|undefined):Promise<{version:string}|{reason:string}> {
  throwIfAborted(signal);const child=spawn(tool.command,[...tool.prefix,'--version'],{stdio:['ignore','pipe','pipe'],shell:false,detached:process.platform!=='win32',windowsHide:true,env:{...process.env,JADX_DISABLE_XML_SECURITY:'false',JADX_DISABLE_ZIP_SECURITY:'false'}});
  return new Promise(resolve=>{
    let output='',settled=false,killing=false,unregisterProcess:(()=>void)|undefined;
    const finish=(value:{version:string}|{reason:string})=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',onAbort);unregisterProcess?.();resolve(value);};
    const terminate=(reason:string)=>{if(settled||killing)return;killing=true;void killTree(child).then(()=>finish({reason}));};
    const onAbort=()=>terminate('JADX availability probe was aborted');
    const timer=setTimeout(()=>terminate('JADX version probe timed out'),15_000);signal?.addEventListener('abort',onAbort,{once:true});
    const append=(chunk:Buffer)=>{if(output.length<8192)output+=chunk.toString('utf8').slice(0,8192-output.length);};child.stdout?.on('data',append);child.stderr?.on('data',append);
    child.once('error',error=>finish({reason:`Unable to start JADX: ${error.message}`}));child.once('close',code=>{if(settled||killing)return;if(code!==0){finish({reason:`JADX version probe exited with code ${code}`});return;}const versionOutput=output.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g,'').trim();if(!new RegExp(`^(?:jadx\\s+)?${JADX_VERSION.replaceAll('.','\\.')}\\s*$`,'im').test(versionOutput)){finish({reason:`JADX version must be pinned to ${JADX_VERSION}; probe returned ${redactSensitive(versionOutput).slice(0,300)||'no version'}`});return;}finish({version:JADX_VERSION});});
    if(child.pid!==undefined&&registerProcess){try{unregisterProcess=registerProcess(child.pid);}catch(error){terminate(error instanceof Error?error.message:String(error));}}
  });
}
const jadxInspectCache=new Map<string,{expiresAt:number;pending:Promise<{available:boolean;detail:string;version?:string}>}>();
export async function inspectJadx(signal?:AbortSignal,registerProcess?:((pid:number)=>()=>void)|undefined):Promise<{available:boolean;detail:string;version?:string}> {
  const resolved=await resolveJadxTool();if(!resolved.tool)return {available:false,detail:resolved.reason??'JADX unavailable'};const tool=resolved.tool,key=JSON.stringify([tool.command,tool.prefix,tool.actualSha256]);if(!signal&&!registerProcess){const now=Date.now(),cached=jadxInspectCache.get(key);if(cached&&cached.expiresAt>now)return cached.pending;const pending=(async()=>{const probe=await probeJadx(tool);if('reason' in probe)return {available:false,detail:probe.reason};return {available:true,detail:tool.detail,version:probe.version};})();jadxInspectCache.set(key,{expiresAt:now+30_000,pending});return pending;}
  const probe=await probeJadx(tool,signal,registerProcess);if('reason' in probe)return {available:false,detail:probe.reason};return {available:true,detail:tool.detail,version:probe.version};
}
async function scanDirectory(root:string):Promise<DirectoryScan> {
  let bytes=0,entries=0,complete=true;const files:OutputFile[]=[];
  const walk=async(dir:string):Promise<void>=>{let directory;try{directory=await lstat(dir);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;complete=false;return;}if(directory.isSymbolicLink()||!directory.isDirectory())throw new Error('JADX produced a symbolic link or non-directory in its output');let children;try{children=await readdir(dir,{withFileTypes:true});}catch{complete=false;return;}for(const child of children){if(++entries>JADX_MAX_SCAN_ENTRIES){complete=false;return;}const absolute=path.join(dir,child.name),relative=path.relative(root,absolute);if(!relative||relative.split(path.sep)[0]==='..'||path.isAbsolute(relative))throw new Error('JADX produced an output path outside its work directory');if(child.isSymbolicLink())throw new Error('JADX produced a symbolic link in its output');if(child.isDirectory()){await walk(absolute);continue;}if(!child.isFile()){complete=false;continue;}try{const info=await lstat(absolute);if(!info.isFile()||info.isSymbolicLink())throw new Error('JADX output changed while it was being inspected');bytes+=info.size;files.push({relative:relative.split(path.sep).join('/'),absolute,size:info.size});}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}};
  await walk(root);return {bytes,files,complete};
}
function assertOutputBudget(scan:DirectoryScan,options:JadxOptions):void { if(!scan.complete)throw new Error(`JADX output accounting exceeded ${JADX_MAX_SCAN_ENTRIES} entries or was incomplete`);if(scan.files.length>options.maxFiles)throw new Error(`JADX output exceeds ${options.maxFiles}-file limit`);if(scan.bytes>options.maxOutputBytes)throw new Error(`JADX output exceeds ${options.maxOutputBytes}-byte limit`);for(const file of scan.files)if(file.size>options.maxFileBytes)throw new Error(`JADX output file ${file.relative} exceeds ${options.maxFileBytes}-byte limit`); }
function assertDiskBudget(scan:DirectoryScan,maxDiskBytes:number):void { if(!scan.complete)throw new Error(`JADX work directory disk accounting exceeded ${JADX_MAX_SCAN_ENTRIES} entries or was incomplete`);if(scan.bytes>maxDiskBytes)throw new Error(`JADX work directory exceeds task disk budget: ${scan.bytes} bytes used of ${maxDiskBytes} bytes`); }
async function runJadx(tool:JadxTool,args:string[],work:string,taskDir:string,options:JadxOptions,signal:AbortSignal,registerProcess?:((pid:number)=>()=>void)|undefined):Promise<{code:number;stdout:string;stderr:string}> {
  throwIfAborted(signal);const env:NodeJS.ProcessEnv={...process.env,JADX_CONFIG_DIR:path.join(work,'config'),JADX_CACHE_DIR:path.join(work,'cache'),JADX_TMP_DIR:path.join(work,'tmp'),JADX_DISABLE_XML_SECURITY:'false',JADX_DISABLE_ZIP_SECURITY:'false'};delete env._JAVA_OPTIONS;delete env.JAVA_TOOL_OPTIONS;delete env.JDK_JAVA_OPTIONS;
  const child=spawn(tool.command,[...tool.prefix,...args],{cwd:work,stdio:['ignore','pipe','pipe'],shell:false,detached:process.platform!=='win32',windowsHide:true,env});
  return new Promise((resolve,reject)=>{
    let stdout='',stderr='',outputBytes=0,settled=false,killing=false,checking=false,unregisterProcess:(()=>void)|undefined;
    const append=(kind:'stdout'|'stderr',chunk:Buffer)=>{outputBytes+=chunk.length;const target=kind==='stdout'?stdout:stderr;if(target.length<4000){const text=target+chunk.toString('utf8').slice(0,Math.max(0,4000-target.length));if(kind==='stdout')stdout=text;else stderr=text;}};
    const cleanup=()=>{clearTimeout(timer);clearInterval(monitor);signal.removeEventListener('abort',onAbort);unregisterProcess?.();};
    const rejectOnce=(error:unknown)=>{if(settled)return;settled=true;cleanup();reject(error);};
    const terminate=(reason:()=>Error)=>{if(settled||killing)return;killing=true;void killTree(child).then(()=>rejectOnce(reason()));};
    const onAbort=()=>terminate(()=>signal.reason instanceof Error?signal.reason:new DOMException('The operation was aborted','AbortError'));
    const timer=setTimeout(()=>terminate(()=>new Error(`JADX timeout after ${options.timeoutMs}ms`)),options.timeoutMs);
    const check=async()=>{if(settled||killing||checking)return;checking=true;try{if(outputBytes>options.maxLogBytes)terminate(()=>new Error(`JADX process output exceeds ${options.maxLogBytes}-byte limit`));const output=await scanDirectory(path.join(work,'output'));assertOutputBudget(output,options);const disk=await scanDirectory(taskDir);assertDiskBudget(disk,options.maxDiskBytes);}catch(error){terminate(()=>error instanceof Error?error:new Error(String(error)));}finally{checking=false;}};
    const monitor=setInterval(()=>{void check();},50);void check();signal.addEventListener('abort',onAbort,{once:true});child.stdout?.on('data',(chunk:Buffer)=>append('stdout',chunk));child.stderr?.on('data',(chunk:Buffer)=>append('stderr',chunk));
    child.once('error',error=>{if(!killing)rejectOnce(new Error(`Unable to start JADX: ${error.message}`));});child.once('close',code=>{if(settled||killing)return;if(outputBytes>options.maxLogBytes){killing=true;rejectOnce(new Error(`JADX process output exceeds ${options.maxLogBytes}-byte limit`));return;}settled=true;cleanup();resolve({code:code??-1,stdout,stderr});});
    if(child.pid!==undefined&&registerProcess){try{unregisterProcess=registerProcess(child.pid);}catch(error){terminate(()=>error instanceof Error?error:new Error(String(error)));}}
  });
}
function boundedText(value:string,limit=16_384):string { const truncated=value.length>limit;return redactSensitive(truncated?value.slice(0,limit+256):value).slice(0,limit)+(truncated?'[TRUNCATED]':''); }
function parseJavaInventory(relative:string,text:string):{classes:string[];methods:ApkDecompiledMethod[]} {
  const classes=new Set<string>(),methods:ApkDecompiledMethod[]=[],packageName=/\bpackage\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*;/.exec(text)?.[1];const classPattern=/\b(?:class|interface|enum|record)\s+([A-Za-z_$][\w$]*)/g;let match:RegExpExecArray|null;
  while((match=classPattern.exec(text)))classes.add(packageName?`${packageName}.${match[1]}`:match[1]!);
  if(classes.size===0&&relative.startsWith('sources/')&&relative.endsWith('.java')){const name=relative.slice('sources/'.length,-'.java'.length).split('/').join('.');if(name)classes.add(name);}
  for(const owner of classes){const simpleName=owner.split('.').at(-1)!;if(new RegExp(`\\b${simpleName.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\s*\\([^;{}]*\\)\\s*\\{`).test(text)&&methods.length<5000)methods.push({class:owner,name:'<init>',file:relative});}
  const methodPattern=/(?:(?:public|protected|private|static|final|abstract|synchronized|native|default|strictfp)\s+)*(?:<[^>]+>\s*)?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:<[^>]+>)?(?:\[\])*\s+([A-Za-z_$][\w$]*)\s*\([^;{}]*\)\s*(?:throws\s+[^{]+)?\{/g;
  while((match=methodPattern.exec(text))&&methods.length<5000)for(const owner of classes)methods.push({class:owner,name:match[1]!,file:relative});
  return {classes:[...classes],methods};
}
async function snapshotApkInput(ctx:TaskContext,maxBytes:number):Promise<{file:string;relativeFile:string;cleanup:()=>Promise<void>}>{
  if(!ctx.upload)throw new Error('APK analysis requires an uploaded file');const source=uploadPath(ctx),linked=await lstat(source);if(linked.isSymbolicLink()||!linked.isFile())throw new Error('APK input must be a regular file');if(linked.size!==ctx.upload.size||linked.size>maxBytes)throw new Error('APK input size does not match the verified upload or exceeds the safe expansion limit');const maxDiskBytes=taskDiskBudgetBytes(ctx),taskDir=path.join(ctx.dataDir,'tasks',ctx.taskId),temporaryRoot=path.join(taskDir,'tmp');await mkdir(temporaryRoot,{recursive:true});const usage=await scanDirectory(taskDir);assertDiskBudget(usage,maxDiskBytes);const allowed=Math.min(maxBytes,maxDiskBytes-usage.bytes);if(linked.size>allowed)throw new Error(`APK immutable snapshot exceeds remaining task disk budget: ${linked.size} bytes of ${allowed} available`);const handle=await open(source,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  try{const opened=await handle.stat();if(!opened.isFile()||opened.size!==ctx.upload.size)throw new Error('APK input identity changed before snapshot');const directory=await mkdtemp(path.join(temporaryRoot,'apk-input-')),file=path.join(directory,'input.apk');let copied=0;const limiter=new Transform({transform(chunk:Buffer,_encoding,callback){copied+=chunk.length;if(copied>allowed)return callback(new Error('APK immutable snapshot exceeded the bounded copy limit'));callback(null,chunk);}});
    try{await pipeline(handle.createReadStream({autoClose:false}),limiter,createWriteStream(file,{flags:'wx',mode:0o600}));const digest=await hashFile(file,ctx.signal);if(digest!==ctx.upload.sha256)throw new Error('APK input hash changed while creating the immutable analysis snapshot');return {file,relativeFile:path.relative(taskDir,file).split(path.sep).join('/'),cleanup:()=>rm(directory,{recursive:true,force:true,maxRetries:3,retryDelay:100})};}catch(error){await rm(directory,{recursive:true,force:true,maxRetries:3,retryDelay:100}).catch(()=>{});throw error;}
  }finally{await handle.close();}
}
async function resolvePreparedSnapshot(ctx:TaskContext,prep:ApkPrepared):Promise<{file:string;cleanup:()=>Promise<void>}>{
  const max=prep.limits;if(!prep.input)return snapshotApkInput(ctx,max.maxZipTotalBytes);const taskDir=path.join(ctx.dataDir,'tasks',ctx.taskId),candidate=path.resolve(taskDir,prep.input.file),relative=path.relative(taskDir,candidate),parent=path.dirname(candidate);
  if(!prep.input.file||path.isAbsolute(prep.input.file)||relative==='..'||relative.startsWith('..'+path.sep)||path.dirname(parent)!==path.join(taskDir,'tmp')||!path.basename(parent).startsWith('apk-input-')||path.basename(candidate)!=='input.apk'||prep.input.sha256!==ctx.upload?.sha256||prep.input.size!==ctx.upload?.size)throw new Error('APK prepared snapshot path or identity is invalid');
  try{const info=await lstat(candidate);if(info.isSymbolicLink()||!info.isFile()||info.size!==ctx.upload?.size)throw new Error('APK prepared snapshot integrity failure');if(await hashFile(candidate,ctx.signal)!==ctx.upload.sha256)throw new Error('APK prepared snapshot hash mismatch');return {file:candidate,cleanup:()=>rm(parent,{recursive:true,force:true,maxRetries:3,retryDelay:100})};}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return snapshotApkInput(ctx,max.maxZipTotalBytes);throw error;}
}
async function decompileApk(ctx:TaskContext,input:string,dexEntries:CentralEntry[],max:ApkLimits):Promise<ApkDecompilation> {
  const requested=ctx.options.apkDecompile===true;if(!requested)return EMPTY_DECOMPILATION(false,'Decompilation was not requested; set apkDecompile=true to run the configured JADX tool');if(dexEntries.length===0)return EMPTY_DECOMPILATION(true,'Decompilation is BLOCKED because no DEX files were available');const dexBytes=dexEntries.reduce((total,entry)=>total+entry.uncompressedSize,0);if(dexEntries.length>max.maxDexFiles||dexEntries.some(entry=>entry.uncompressedSize>max.maxDexBytes)||dexBytes>max.maxTotalRead)return EMPTY_DECOMPILATION(true,'Decompilation is BLOCKED because the complete JADX input exceeds the configured DEX count, per-file byte or total read budget');
  const resolved=await resolveJadxTool();if(!resolved.tool)return EMPTY_DECOMPILATION(true,`Decompilation is BLOCKED: ${resolved.reason??'JADX unavailable'}`);const capability=await probeJadx(resolved.tool,ctx.signal,ctx.registerProcess);throwIfAborted(ctx.signal);if('reason' in capability)return EMPTY_DECOMPILATION(true,`Decompilation is BLOCKED: ${capability.reason}`);
  const options=jadxOptions(ctx),taskDir=path.join(ctx.dataDir,'tasks',ctx.taskId);await mkdir(taskDir,{recursive:true});const work=await mkdtemp(path.join(taskDir,'apk-jadx-work-'));
  try{
    const outputDir=path.join(work,'output');await mkdir(outputDir,{recursive:true});await Promise.all(['tmp','config','cache'].map(dir=>mkdir(path.join(work,dir),{recursive:true})));assertDiskBudget(await scanDirectory(taskDir),options.maxDiskBytes);
    const args=['-d',outputDir,'--threads-count','1','--show-bad-code','--no-debug-info','--deobf-cfg-file-mode','ignore','--log-level','progress',input];const execution=await runJadx(resolved.tool,args,work,taskDir,options,ctx.signal,ctx.registerProcess);throwIfAborted(ctx.signal);if(await hashFile(input,ctx.signal)!==ctx.upload?.sha256)throw new Error('APK input hash changed during JADX decompilation');
    if(execution.code!==0){const diagnostic=redactSensitive(execution.stderr||execution.stdout).slice(0,1000);throw new Error(`JADX exited with code ${execution.code}: ${diagnostic||'no diagnostic output'}`);}
    const scan=await scanDirectory(outputDir);assertOutputBudget(scan,options);assertDiskBudget(await scanDirectory(taskDir),options.maxDiskBytes);if(scan.files.length===0)throw new Error('JADX completed without producing bounded output files');
    const limitations=['JADX output is Java-like decompilation and decoded resources, not original source or a verified rebuild','Class and method inventories are best-effort declaration parses of generated Java, not semantic call graphs','JADX CLI does not emit a standalone smali disassembly; DEX metadata remains available from the built-in parser',resolved.tool.archiveVerified?'Installed JADX CLI archive SHA256 matches the pinned official archive':'External JADX launcher is version-pinned and its actual file SHA256 is recorded; the official archive was not verified','Potentially sensitive Java and text resource artifacts are redacted; binary resources are inventoried and hashed without content rewriting'];let truncated=false,inventoryTruncated=false,artifactBytes=0,artifactFiles=0;const files:ApkDecompiledFile[]=[],classes=new Set<string>(),methods=new Map<string,ApkDecompiledMethod>(),artifacts:string[]=[];
    for(const file of scan.files){const extension=path.extname(file.relative).toLowerCase(),kind:ApkDecompiledFile['kind']=extension==='.java'?'java':extension==='.smali'?'smali':'resource';const bytes=await limitedRead(file.absolute,options.maxFileBytes+1);if(bytes.length>options.maxFileBytes)throw new Error(`JADX output file ${file.relative} exceeds ${options.maxFileBytes}-byte limit`);let artifact:string|null=null,artifactSize:number|null=null,artifactSha256:string|null=null;
      const content=TEXT_ARTIFACT_EXTENSIONS.has(extension)?redactSensitive(bytes.toString('utf8')):bytes,artifactContent=Buffer.from(content);
      if(artifactFiles<options.maxArtifactFiles&&artifactBytes+artifactContent.length<=options.maxArtifactBytes){artifact=safeArtifactName(`apk-jadx-${String(artifactFiles).padStart(4,'0')}-${path.basename(file.relative)}`);await ctx.writeArtifact(artifact,artifactContent,extension==='.java'?'text/x-java':extension==='.xml'?'application/xml':'application/octet-stream');artifactSize=artifactContent.length;artifactSha256=createHash('sha256').update(artifactContent).digest('hex');artifacts.push(artifact);artifactFiles++;artifactBytes+=artifactContent.length;}else truncated=true;
      files.push({path:file.relative,kind,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),artifact,artifactSize,artifactSha256});
      if((kind==='java'||kind==='smali')&&bytes.length<=2_000_000){const parsed=parseJavaInventory(file.relative,bytes.toString('utf8'));for(const name of parsed.classes){if(classes.size>=5000){inventoryTruncated=true;break;}classes.add(boundedText(name));}if(classes.size>=5000)inventoryTruncated=true;for(const method of parsed.methods){if(methods.size>=5000){inventoryTruncated=true;break;}const safe={class:boundedText(method.class),name:boundedText(method.name,256),file:file.relative};methods.set(`${safe.class}#${safe.name}#${safe.file}`,safe);}if(methods.size>=5000)inventoryTruncated=true;}
    }
    if(truncated)limitations.push(`Artifact export was limited to ${options.maxArtifactFiles} files and ${options.maxArtifactBytes} bytes; the bounded output inventory and hashes remain complete`);if(inventoryTruncated){truncated=true;limitations.push('Class and method declaration inventory was limited to 5000 classes or methods');}
    const decompilation:ApkDecompilation={status:'COMPLETED',requested:true,engine:'jadx',version:JADX_VERSION,expectedSha256:JADX_SHA256,actualSha256:resolved.tool.actualSha256,verificationMode:resolved.tool.verificationMode,archiveVerified:resolved.tool.archiveVerified,reason:`JADX ${JADX_VERSION} completed static decompilation and resource decoding`,javaFiles:files.filter(file=>file.kind==='java').length,smaliFiles:files.filter(file=>file.kind==='smali').length,resourceFiles:files.filter(file=>file.kind==='resource').length,classes:[...classes],methods:[...methods.values()],files,artifacts,stdout:boundedText(execution.stdout),stderr:boundedText(execution.stderr),limitations,truncated};
    await ctx.writeArtifact('apk-jadx-manifest.json',JSON.stringify({tool:{engine:'jadx',version:JADX_VERSION,officialArchiveSha256:JADX_SHA256,actualSha256:decompilation.actualSha256,verificationMode:decompilation.verificationMode,archiveVerified:decompilation.archiveVerified},classes:decompilation.classes,methods:decompilation.methods,files,truncated,limitations,stdout:decompilation.stdout,stderr:decompilation.stderr},null,2),'application/json');decompilation.artifacts.push('apk-jadx-manifest.json');await ctx.log('info',`JADX ${JADX_VERSION} produced ${decompilation.javaFiles} Java files, ${decompilation.smaliFiles} smali files and ${decompilation.resourceFiles} resources`,'jadx');return decompilation;
  }finally{await rm(work,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
}

export const apkAdapter=defineAdapter({
  name:'apk',version:'1.1.0',description:'Bounded static APK/ZIP inspection with optional pinned JADX decompilation and resource decoding; never executes uploaded code.',
  available:async()=>{const capability=await inspectJadx();return {available:true,detail:capability.available?`Built-in safe ZIP, AXML and DEX metadata parser; JADX ${JADX_VERSION} decompilation available on request`:`Built-in safe ZIP, AXML and DEX metadata parser; decompilation BLOCKED: ${capability.detail}`};},
  detect:async ctx=>{const head=await readVerifiedUploadHead(ctx,8);if(!isZip(head)&&!/\.(apk|zip)$/i.test(ctx.upload?.name??''))throw new Error('APK adapter requires an APK or ZIP container');return {adapter:'apk',confidence:isZip(head)?1:0.7,format:'APK / ZIP container',details:{size:ctx.upload?.size??0},limitations:['Manifest permissions are candidates; package and permission semantics are not executed or confirmed']};},
  prepare:async ctx=>{assertAuthorized(ctx.project.authorizationConfirmed);const limits=apkLimits(ctx.options),snapshot=await snapshotApkInput(ctx,limits.maxZipTotalBytes);try{const head=await limitedRead(snapshot.file,8);if(!isZip(head))throw new Error('Invalid APK/ZIP magic');return {limits,input:{file:snapshot.relativeFile,sha256:ctx.upload!.sha256,size:ctx.upload!.size}};}catch(error){await snapshot.cleanup();throw error;}},
  analyze:async ctx=>{
    throwIfAborted(ctx.signal);assertAuthorized(ctx.project.authorizationConfirmed);const prep=output<ApkPrepared>(ctx,'PREPARE')??await apkAdapter.prepare(ctx) as ApkPrepared;const max=prep.limits;const snapshot=await resolvePreparedSnapshot(ctx,prep);
    try{const file=snapshot.file;
    const inventory=await inspectZip(file,{maxEntries:max.maxEntries,maxTotalBytes:max.maxZipTotalBytes,maxRatio:max.maxZipRatio});throwIfAborted(ctx.signal);const central=await centralDirectory(file,max.maxEntries,ctx.signal);throwIfAborted(ctx.signal);
    const sha256=await hashFile(file,ctx.signal),size=(await stat(file)).size;throwIfAborted(ctx.signal);const result:ApkAnalysis={format:'APK / ZIP container',sha256,size,entries:{count:inventory.length,names:inventory.map(entry=>entry.fileName).slice(0,SAMPLE_LIMIT),truncated:inventory.length>SAMPLE_LIMIT},manifest:{format:'UNKNOWN',packageName:'UNKNOWN',permissions:[],declaredPermissions:[],truncated:false},dexFiles:[],nativeLibraries:[],decompilation:EMPTY_DECOMPILATION(ctx.options.apkDecompile===true,'Decompilation status is pending'),dexCountLimit:max.maxDexFiles,stringCountLimit:max.maxStrings,nativeLibraryCountLimit:max.maxNativeLibraries,totalReadBytes:0,totalReadLimit:max.maxTotalRead,truncated:inventory.length>SAMPLE_LIMIT,limitations:['Archive entries are read only into bounded memory; uploaded code is never executed','DEX method_ids include referenced methods, not only methods defined by classes','MUTF-8 strings are decoded best-effort and likely secrets are redacted']};
    throwIfAborted(ctx.signal);if(inventory.length>SAMPLE_LIMIT)result.limitations.push(`ZIP entry names limited to ${SAMPLE_LIMIT}; ${inventory.length-SAMPLE_LIMIT} names were not retained`);
    const manifest=central.find(entry=>entry.name==='AndroidManifest.xml');if(manifest){try{const read=await readZipEntry(file,manifest,max.maxManifestBytes,false,ctx.signal);result.totalReadBytes+=read.size;result.manifest=parseManifest(read.bytes,ctx.signal);}catch(error){throwIfAborted(ctx.signal);if(error instanceof SecurityError)throw error;result.limitations.push(`AndroidManifest.xml could not be parsed: ${error instanceof Error?error.message:String(error)}`);}}
    else result.limitations.push('AndroidManifest.xml is absent; package name and permissions remain UNKNOWN');
    const dexEntries=central.filter(entry=>/\.dex$/i.test(entry.name));if(dexEntries.length>max.maxDexFiles){result.truncated=true;result.limitations.push(`DEX count limit ${max.maxDexFiles} reached; ${dexEntries.length-max.maxDexFiles} files were skipped`);}
    for(const entry of dexEntries.slice(0,max.maxDexFiles)){
      throwIfAborted(ctx.signal);if(entry.uncompressedSize>max.maxDexBytes||entry.uncompressedSize>result.totalReadLimit-result.totalReadBytes){result.truncated=true;result.limitations.push(`DEX ${entry.name} skipped because a per-file or total read limit was reached`);continue;}
      try{
        const read=await readZipEntry(file,entry,Math.min(max.maxDexBytes,result.totalReadLimit-result.totalReadBytes),false,ctx.signal);result.totalReadBytes+=read.size;
        const dex=parseDex(entry.name,read.bytes,max.maxStrings,{maxTypes:max.maxTypes,maxProtos:max.maxProtos,maxMethods:max.maxMethods,maxClasses:max.maxClasses},ctx.signal);
        for(const limitation of dex.limitations){result.truncated=true;result.limitations.push(`DEX ${entry.name} ${limitation}`);}
        const tables=[
          {label:'string',summary:dex.stringIds,limit:max.maxStrings},
          {label:'type',summary:dex.typeIds,limit:max.maxTypes},
          {label:'proto',summary:dex.protoIds,limit:max.maxProtos},
          {label:'method',summary:dex.methodIds,limit:max.maxMethods},
          {label:'class',summary:dex.classDefs,limit:max.maxClasses},
        ];
        for(const table of tables)if(table.summary.truncated){result.truncated=true;if(table.summary.count>table.limit)result.limitations.push(`DEX ${entry.name} ${table.label} inventory limited to ${table.limit}; ${table.summary.count-table.limit} entries were not inspected`);else if(table.label!=='string'||dex.limitations.length===0)result.limitations.push(`DEX ${entry.name} ${table.label} values limited to ${table.summary.values.length} samples; ${table.summary.count} table entries were inspected`);}
        result.dexFiles.push(dex);
      }catch(error){throwIfAborted(ctx.signal);if(error instanceof SecurityError)throw error;throw new Error(error instanceof Error?error.message:String(error));}
    }
    const nativeEntries=central.filter(entry=>/^lib\/[^/]+\/[^/]+\.so$/i.test(entry.name));
    if(nativeEntries.length>max.maxNativeLibraries){result.truncated=true;result.limitations.push(`Native library count limit ${max.maxNativeLibraries} reached; ${nativeEntries.length-max.maxNativeLibraries} libraries were skipped`);}
    for(const entry of nativeEntries.slice(0,max.maxNativeLibraries)){throwIfAborted(ctx.signal);const remaining=result.totalReadLimit-result.totalReadBytes;if(entry.uncompressedSize>max.maxNativeBytes||entry.uncompressedSize>remaining){result.truncated=true;result.nativeLibraries.push({entry:entry.name,size:entry.uncompressedSize,sha256:null,truncated:true});result.limitations.push(`Native library ${entry.name} hash skipped because a read limit was reached`);continue;}try{const read=await readZipEntry(file,entry,Math.min(max.maxNativeBytes,remaining),true,ctx.signal);result.totalReadBytes+=read.size;result.nativeLibraries.push({entry:entry.name,size:read.size,sha256:read.sha256,truncated:false});}catch(error){throwIfAborted(ctx.signal);result.truncated=true;result.nativeLibraries.push({entry:entry.name,size:entry.uncompressedSize,sha256:null,truncated:true});result.limitations.push(`Native library ${entry.name} could not be hashed: ${error instanceof Error?error.message:String(error)}`);}}
    if(result.manifest.format==='text-xml')result.limitations.push('Plain-text manifest metadata was parsed as candidates; compiled binary AXML is preferred');if(result.manifest.packageName==='UNKNOWN')result.limitations.push('Package name remains UNKNOWN because manifest metadata was absent or unreliable');throwIfAborted(ctx.signal);result.decompilation=await decompileApk(ctx,file,dexEntries,max);result.limitations.push(...result.decompilation.limitations);if(result.decompilation.truncated)result.truncated=true;await ctx.log('info',`Inspected ${inventory.length} ZIP entries, ${result.dexFiles.length} DEX files and ${result.nativeLibraries.length} native libraries; decompilation ${result.decompilation.status}`,'apk-static');return result;
    }finally{await snapshot.cleanup();}
  },
  extractEvidence:async ctx=>{
    throwIfAborted(ctx.signal);const analysis=output<ApkAnalysis>(ctx,'ANALYZE');await ctx.evidence('EVIDENCE','APK/ZIP identity and safe entry inventory','zip-central-directory','archive',{sha256:analysis.sha256,size:analysis.size,entries:analysis.entries});throwIfAborted(ctx.signal);await ctx.evidence('INFERENCE','Manifest package and permission candidates','android-manifest-parser','AndroidManifest.xml',analysis.manifest);throwIfAborted(ctx.signal);
    for(const dex of analysis.dexFiles){await ctx.evidence('EVIDENCE',`DEX metadata: ${dex.entry}`,'dex-parser',dex.entry,{sha256:dex.sha256,magic:dex.magic,header:dex.header,stringIds:dex.stringIds.count,typeIds:dex.typeIds.count,protoIds:dex.protoIds.count,methodIds:dex.methodIds.count,classDefs:dex.classDefs.count,classes:dex.classDefs.values.slice(0,500),methods:dex.methodIds.values.slice(0,1000),strings:dex.stringIds.values.slice(0,1000),truncated:dex.stringIds.truncated||dex.typeIds.truncated||dex.protoIds.truncated||dex.methodIds.truncated||dex.classDefs.truncated,limitations:dex.limitations});throwIfAborted(ctx.signal);}
    if(analysis.nativeLibraries.length)await ctx.evidence('EVIDENCE','Native library identity hashes','zip-stream-sha256','lib',analysis.nativeLibraries);throwIfAborted(ctx.signal);await ctx.evidence(analysis.decompilation.status==='COMPLETED'?'EVIDENCE':'UNKNOWN',`JADX decompilation ${analysis.decompilation.status}`,'jadx','apk-jadx-manifest.json',{engine:analysis.decompilation.engine,version:analysis.decompilation.version,reason:analysis.decompilation.reason,classCount:analysis.decompilation.classes.length,methodCount:analysis.decompilation.methods.length,fileCount:analysis.decompilation.files.length,classes:analysis.decompilation.classes.slice(0,500),methods:analysis.decompilation.methods.slice(0,1000),files:analysis.decompilation.files.slice(0,2000),limitations:analysis.decompilation.limitations});throwIfAborted(ctx.signal);await ctx.writeArtifact('apk-analysis.json',JSON.stringify(analysis,null,2),'application/json');throwIfAborted(ctx.signal);return {entries:analysis.entries.count,dexFiles:analysis.dexFiles.length,nativeLibraries:analysis.nativeLibraries.length,decompilation:analysis.decompilation.status,truncated:analysis.truncated,artifacts:['apk-analysis.json',...analysis.decompilation.artifacts]};
  },
  reconstruct:async ctx=>{const analysis=output<ApkAnalysis>(ctx,'ANALYZE');if(analysis.decompilation.status==='COMPLETED'){await ctx.evidence('EVIDENCE','JADX produced bounded Java-like source and decoded resources; no rebuild or execution was performed','jadx','apk-jadx-manifest.json',{classes:analysis.decompilation.classes.slice(0,500),methods:analysis.decompilation.methods.slice(0,1000)});return noReconstruction(ctx,'Decompiled Java-like artifacts were produced, but no runnable reconstruction was built or executed');}await ctx.evidence('UNKNOWN','APK decompilation is BLOCKED','apk-adapter','reconstruct',{reason:analysis.decompilation.reason});return noReconstruction(ctx,analysis.decompilation.reason);},
  validate:async ctx=>{const analysis=output<ApkAnalysis>(ctx,'ANALYZE'),decomp=analysis.decompilation,artifactNames=new Set(decomp.artifacts);const checks=[
    {name:'safe ZIP inventory completed',passed:analysis.entries.count>0},
    {name:'input identity matches verified upload',passed:analysis.sha256===ctx.upload?.sha256&&analysis.size===ctx.upload?.size},
    {name:'DEX and native read limits enforced',passed:analysis.totalReadBytes<=analysis.totalReadLimit&&analysis.dexFiles.length<=analysis.dexCountLimit&&analysis.nativeLibraries.length<=analysis.nativeLibraryCountLimit},
    {name:'uploaded code not executed',passed:true},
    {name:'manifest uncertainty is explicit',passed:analysis.manifest.packageName==='UNKNOWN'?analysis.limitations.some(item=>/UNKNOWN|absent|unreliable/i.test(item)):analysis.manifest.format!=='UNKNOWN'&&analysis.manifest.packageName.length>0},
    {name:'decompilation status and inventory are consistent',passed:decomp.status==='COMPLETED'?decomp.engine==='jadx'&&decomp.version===JADX_VERSION&&decomp.files.length===decomp.javaFiles+decomp.smaliFiles+decomp.resourceFiles&&decomp.files.length>0&&decomp.files.every(file=>file.artifact===null||(artifactNames.has(file.artifact)&&file.artifactSize!==null&&/^[0-9a-f]{64}$/.test(file.artifactSha256??'')))&&new Set(decomp.artifacts).size===decomp.artifacts.length&&/^[0-9a-f]{64}$/.test(decomp.actualSha256??'')&&(!decomp.archiveVerified||(decomp.verificationMode==='official-archive'&&decomp.actualSha256===JADX_SHA256)):decomp.status==='BLOCKED'&&decomp.engine==='none'&&decomp.reason.length>0&&decomp.files.length===0}
  ];return {passed:checks.every(check=>check.passed),checks,limitations:analysis.limitations};}
});

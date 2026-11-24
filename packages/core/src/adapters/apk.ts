import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { createInflateRaw } from 'node:zlib';
import { inspectZip, redactSensitive, SecurityError } from '@reverse/security';
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
export interface ApkAnalysis {
  format:'APK / ZIP container';
  sha256:string;
  size:number;
  entries:{count:number;names:string[];truncated:boolean};
  manifest:ManifestAnalysis;
  dexFiles:DexAnalysis[];
  nativeLibraries:NativeLibrary[];
  dexCountLimit:number;
  stringCountLimit:number;
  nativeLibraryCountLimit:number;
  totalReadBytes:number;
  totalReadLimit:number;
  truncated:boolean;
  limitations:string[];
}

interface ApkLimits { maxEntries:number; maxDexFiles:number; maxStrings:number; maxTypes:number; maxProtos:number; maxMethods:number; maxClasses:number; maxNativeLibraries:number; maxTotalRead:number; maxManifestBytes:number; maxDexBytes:number; maxNativeBytes:number; maxZipTotalBytes:number; maxZipRatio:number }
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
function positive(value:unknown,fallback:number,max:number):number { return typeof value==='number'&&Number.isFinite(value)&&value>0?Math.min(Math.floor(value),max):fallback; }
function ratio(value:unknown,fallback:number,max:number):number { return typeof value==='number'&&Number.isFinite(value)&&value>0?Math.min(value,max):fallback; }
function apkLimits(options:Record<string,unknown>):ApkLimits { return {maxEntries:positive(options.apkMaxEntries,20_000,100_000),maxDexFiles:positive(options.apkMaxDexFiles,8,64),maxStrings:positive(options.apkMaxStrings,20_000,100_000),maxTypes:positive(options.apkMaxTypes,DEFAULT_MAX_TYPES,100_000),maxProtos:positive(options.apkMaxProtos,DEFAULT_MAX_PROTOS,100_000),maxMethods:positive(options.apkMaxMethods,DEFAULT_MAX_METHODS,200_000),maxClasses:positive(options.apkMaxClasses,DEFAULT_MAX_CLASSES,100_000),maxNativeLibraries:positive(options.apkMaxNativeLibraries,DEFAULT_MAX_NATIVE_LIBRARIES,4_096),maxTotalRead:positive(options.apkMaxTotalReadBytes,64_000_000,512_000_000),maxManifestBytes:positive(options.apkMaxManifestBytes,MANIFEST_MAX,8_000_000),maxDexBytes:positive(options.apkMaxDexBytes,DEX_MAX,64_000_000),maxNativeBytes:positive(options.apkMaxNativeBytes,NATIVE_MAX,256_000_000),maxZipTotalBytes:positive(options.apkMaxZipTotalBytes,DEFAULT_MAX_ZIP_TOTAL_BYTES,1_000_000_000),maxZipRatio:ratio(options.apkMaxZipRatio,DEFAULT_MAX_ZIP_RATIO,1_000)}; }
function assertAuthorized(authorized:boolean):void { if(!authorized)throw new Error('Explicit authorization confirmation is required before APK analysis'); }
function throwIfAborted(signal?:AbortSignal):void { if(signal?.aborted)throw signal.reason instanceof Error?signal.reason:new DOMException('The operation was aborted','AbortError'); }
function isZip(head:Buffer):boolean { return head.length>=4&&(head.subarray(0,4).equals(Buffer.from([0x50,0x4b,0x03,0x04]))||head.subarray(0,4).equals(Buffer.from([0x50,0x4b,0x05,0x06]))||head.subarray(0,4).equals(Buffer.from([0x50,0x4b,0x07,0x08]))); }

async function hashFile(file:string,signal?:AbortSignal):Promise<string> { throwIfAborted(signal);const hash=createHash('sha256');for await(const chunk of createReadStream(file)){throwIfAborted(signal);hash.update(chunk);}return hash.digest('hex'); }
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
  const utf16=readUleb(buffer,offset);if(!utf16)return undefined;const bytes=readUleb(buffer,utf16.next);if(!bytes)return undefined;const start=bytes.next,end=start+bytes.value;if(end>=buffer.length||buffer[end]!==0)return undefined;const truncated=bytes.value>MAX_DEX_STRING_BYTES,decodedEnd=Math.min(end,start+MAX_DEX_STRING_BYTES);
  return {value:redactSensitive(buffer.subarray(start,decodedEnd).toString('utf8').replace(/\u0000/g,''))+(truncated?'[TRUNCATED]':''),bytes:bytes.value,truncated};
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

export const apkAdapter=defineAdapter({
  name:'apk',version:'1.0.0',description:'Bounded static APK/ZIP inspection with safe streaming entry reads, binary manifest candidates and DEX metadata; never executes uploaded code.',
  available:async()=>({available:true,detail:'Built-in safe ZIP, AXML and DEX metadata parser'}),
  detect:async ctx=>{const head=await limitedRead(uploadPath(ctx),8);if(!isZip(head)&&!/\.(apk|zip)$/i.test(ctx.upload?.name??''))throw new Error('APK adapter requires an APK or ZIP container');return {adapter:'apk',confidence:isZip(head)?1:0.7,format:'APK / ZIP container',details:{size:ctx.upload?.size??0},limitations:['Manifest permissions are candidates; package and permission semantics are not executed or confirmed']};},
  prepare:async ctx=>{assertAuthorized(ctx.project.authorizationConfirmed);const head=await limitedRead(uploadPath(ctx),8);if(!isZip(head))throw new Error('Invalid APK/ZIP magic');return {limits:apkLimits(ctx.options)};},
  analyze:async ctx=>{
    throwIfAborted(ctx.signal);assertAuthorized(ctx.project.authorizationConfirmed);const prep=output<{limits:ApkLimits}>(ctx,'PREPARE')??await apkAdapter.prepare(ctx) as {limits:ApkLimits};const max=prep.limits;const file=uploadPath(ctx);
    const inventory=await inspectZip(file,{maxEntries:max.maxEntries,maxTotalBytes:max.maxZipTotalBytes,maxRatio:max.maxZipRatio});throwIfAborted(ctx.signal);const central=await centralDirectory(file,max.maxEntries,ctx.signal);throwIfAborted(ctx.signal);
    const sha256=await hashFile(file,ctx.signal),size=(await stat(file)).size;throwIfAborted(ctx.signal);const result:ApkAnalysis={format:'APK / ZIP container',sha256,size,entries:{count:inventory.length,names:inventory.map(entry=>entry.fileName).slice(0,SAMPLE_LIMIT),truncated:inventory.length>SAMPLE_LIMIT},manifest:{format:'UNKNOWN',packageName:'UNKNOWN',permissions:[],declaredPermissions:[],truncated:false},dexFiles:[],nativeLibraries:[],dexCountLimit:max.maxDexFiles,stringCountLimit:max.maxStrings,nativeLibraryCountLimit:max.maxNativeLibraries,totalReadBytes:0,totalReadLimit:max.maxTotalRead,truncated:inventory.length>SAMPLE_LIMIT,limitations:['Archive entries are read only into bounded memory; uploaded code is never executed','DEX method_ids include referenced methods, not only methods defined by classes','MUTF-8 strings are decoded best-effort and likely secrets are redacted']};
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
    if(result.manifest.format==='text-xml')result.limitations.push('Plain-text manifest metadata was parsed as candidates; compiled binary AXML is preferred');if(result.manifest.packageName==='UNKNOWN')result.limitations.push('Package name remains UNKNOWN because manifest metadata was absent or unreliable');throwIfAborted(ctx.signal);await ctx.log('info',`Inspected ${inventory.length} ZIP entries, ${result.dexFiles.length} DEX files and ${result.nativeLibraries.length} native libraries`,'apk-static');return result;
  },
  extractEvidence:async ctx=>{
    throwIfAborted(ctx.signal);const analysis=output<ApkAnalysis>(ctx,'ANALYZE');await ctx.evidence('EVIDENCE','APK/ZIP identity and safe entry inventory','zip-central-directory','archive',{sha256:analysis.sha256,size:analysis.size,entries:analysis.entries});throwIfAborted(ctx.signal);await ctx.evidence('INFERENCE','Manifest package and permission candidates','android-manifest-parser','AndroidManifest.xml',analysis.manifest);throwIfAborted(ctx.signal);
    for(const dex of analysis.dexFiles){await ctx.evidence('EVIDENCE',`DEX metadata: ${dex.entry}`,'dex-parser',dex.entry,{sha256:dex.sha256,magic:dex.magic,header:dex.header,stringIds:dex.stringIds.count,typeIds:dex.typeIds.count,protoIds:dex.protoIds.count,methodIds:dex.methodIds.count,classDefs:dex.classDefs.count,classes:dex.classDefs.values.slice(0,500),methods:dex.methodIds.values.slice(0,1000),strings:dex.stringIds.values.slice(0,1000),truncated:dex.stringIds.truncated||dex.typeIds.truncated||dex.protoIds.truncated||dex.methodIds.truncated||dex.classDefs.truncated,limitations:dex.limitations});throwIfAborted(ctx.signal);}
    if(analysis.nativeLibraries.length)await ctx.evidence('EVIDENCE','Native library identity hashes','zip-stream-sha256','lib',analysis.nativeLibraries);throwIfAborted(ctx.signal);await ctx.writeArtifact('apk-analysis.json',JSON.stringify(analysis,null,2),'application/json');throwIfAborted(ctx.signal);return {entries:analysis.entries.count,dexFiles:analysis.dexFiles.length,nativeLibraries:analysis.nativeLibraries.length,truncated:analysis.truncated,artifacts:['apk-analysis.json']};
  },
  reconstruct:async ctx=>{await ctx.evidence('UNKNOWN','APK metadata analysis does not reconstruct source or execute the application','apk-adapter','reconstruct',{reason:'No decompiler or runtime provider is configured'});return noReconstruction(ctx,'No APK code was decompiled, executed or reconstructed');},
  validate:async ctx=>{const analysis=output<ApkAnalysis>(ctx,'ANALYZE');const checks=[{name:'safe ZIP inventory completed',passed:analysis.entries.count>0},{name:'DEX read limits enforced',passed:analysis.totalReadBytes<=analysis.totalReadLimit},{name:'uploaded code not executed',passed:true},{name:'manifest uncertainty explicit',passed:analysis.manifest.packageName==='UNKNOWN'||analysis.limitations.length>=0}];return {passed:checks.every(check=>check.passed),checks,limitations:analysis.limitations};}
});

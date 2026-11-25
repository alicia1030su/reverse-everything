import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';
import { redactSensitive } from '@reverse/security';
import { throwIfAborted } from './limits.js';
import type { EntropyAnalysis, FirmwareString, StringAnalysis } from './types.js';

export class FirmwareInput {
  readonly handle:FileHandle;readonly size:number;readonly path:string;totalReadBytes=0;
  private constructor(handle:FileHandle,size:number,filePath:string){this.handle=handle;this.size=size;this.path=filePath;}
  static async open(file:string,maxImageBytes:number,signal?:AbortSignal):Promise<FirmwareInput>{
    throwIfAborted(signal);const before=await lstat(file);if(before.isSymbolicLink()||!before.isFile())throw new Error('Firmware input must be a regular file, not a symbolic link');
    if(before.size>maxImageBytes)throw new Error(`Firmware image exceeds the ${maxImageBytes}-byte limit`);
    const handle=await open(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
    try{const opened=await handle.stat(),after=await lstat(file);if(!opened.isFile()||opened.size!==before.size||opened.dev!==before.dev||opened.ino!==before.ino||after.dev!==opened.dev||after.ino!==opened.ino||after.isSymbolicLink())throw new Error('Firmware input changed while opening');return new FirmwareInput(handle,opened.size,file);}catch(error){await handle.close();throw error;}
  }
  async readAt(position:number,length:number,signal?:AbortSignal,destination?:Buffer):Promise<Buffer>{
    throwIfAborted(signal);if(!Number.isSafeInteger(position)||!Number.isSafeInteger(length)||position<0||length<0||position+length>this.size)throw new Error('Firmware read bounds are invalid or outside the image');if(destination&&destination.length<length)throw new Error('Firmware read destination is too small');
    const buffer=destination??Buffer.alloc(length);let offset=0;while(offset<length){throwIfAborted(signal);const read=await this.handle.read(buffer,offset,length-offset,position+offset);if(read.bytesRead===0)throw new Error('Unexpected end of firmware image');offset+=read.bytesRead;this.totalReadBytes+=read.bytesRead;}return buffer.subarray(0,length);
  }
  async verify(signal?:AbortSignal):Promise<void>{throwIfAborted(signal);const info=await this.handle.stat();if(info.size!==this.size)throw new Error('Firmware image size changed during analysis');}
  async close():Promise<void>{await this.handle.close();}
}

export function entropy(buffer:Buffer):number { if(!buffer.length)return 0;const counts=new Uint32Array(256);for(const byte of buffer)counts[byte]!++;let value=0;for(const count of counts)if(count){const p=count/buffer.length;value-=p*Math.log2(p);}return Math.round(value*1000)/1000; }

export interface ScanResult { sha256:string;entropy:EntropyAnalysis;strings:StringAnalysis;head:Buffer }
interface AsciiRun { start:number;length:number;value:string }
interface Utf16Run { start:number;codes:number[];pending:number|null;parity:number }
export async function scanFirmware(input:FirmwareInput,chunkBytes:number,maxStrings:number,maxStringBytes:number,maxStringTotalBytes:number,signal?:AbortSignal):Promise<ScanResult>{
  const hash=createHash('sha256'),counts=new Uint32Array(256),bins:EntropyAnalysis['bins']=[];let offset=0,binOffset=0,binSize=0,binCounts=new Uint32Array(256),totalBytes=0;
  const values:FirmwareString[]=[];let stringCount=0,stringBytes=0,stringsTruncated=false,ascii:AsciiRun|null=null;
  const flushAscii=():void=>{if(ascii&&ascii.length>=4){stringCount++;if(values.length<maxStrings&&stringBytes<=maxStringTotalBytes){const truncated=ascii.length>maxStringBytes,bytesNeeded=Math.min(ascii.length,maxStringBytes);if(stringBytes+bytesNeeded>maxStringTotalBytes)stringsTruncated=true;else{stringBytes+=bytesNeeded;values.push({offset:ascii.start,encoding:'ASCII',value:redactSensitive(ascii.value)+(truncated?'[TRUNCATED]':''),truncated});}}else stringsTruncated=true;}ascii=null;};
  const utf:Utf16Run[]=[{start:0,codes:[],pending:null,parity:0},{start:0,codes:[],pending:null,parity:1}];
  const flushUtf=(run:Utf16Run):void=>{if(run.codes.length>=4){stringCount++;if(values.length<maxStrings&&stringBytes<=maxStringTotalBytes){const text=String.fromCharCode(...run.codes.slice(0,maxStringBytes));const truncated=run.codes.length>maxStringBytes;const bytesNeeded=Math.min(run.codes.length,maxStringBytes)*2;if(stringBytes+bytesNeeded>maxStringTotalBytes)stringsTruncated=true;else{stringBytes+=bytesNeeded;values.push({offset:run.start,encoding:'UTF-16LE',value:redactSensitive(text)+(truncated?'[TRUNCATED]':''),truncated});}}else stringsTruncated=true;}run.codes=[];run.pending=null;};
  let head:Buffer=Buffer.alloc(0);const readBuffer=Buffer.alloc(Math.min(chunkBytes,input.size));
  while(offset<input.size){
    throwIfAborted(signal);const length=Math.min(chunkBytes,input.size-offset),chunk=await input.readAt(offset,length,signal,readBuffer);if(!head.length)head=Buffer.from(chunk.subarray(0,Math.min(chunk.length,4096)));hash.update(chunk);totalBytes+=chunk.length;
    for(let index=0;index<chunk.length;index++){
      const byte=chunk[index]!;counts[byte]!++;binCounts[byte]!++;binSize++;
      if(ascii&&(byte<0x20||byte>0x7e))flushAscii();
      if(byte>=0x20&&byte<=0x7e){if(!ascii)ascii={start:offset+index,length:1,value:String.fromCharCode(byte)};else{ascii.length++;if(ascii.value.length<maxStringBytes)ascii.value+=String.fromCharCode(byte);}}else if(byte===0&&ascii)flushAscii();
      for(const run of utf){if(run.pending!==null){const code=run.pending|(byte<<8);if(code>=0x20&&code<=0x7e)run.codes.push(code);else{flushUtf(run);if(byte===0)run.start=offset+index-1;}run.pending=null;}else if(byte!==0)run.pending=byte;else flushUtf(run);}
    }
    offset+=chunk.length;if(binSize===chunkBytes||offset===input.size){bins.push({offset:binOffset,size:binSize,entropy:entropyCounts(binCounts,binSize)});binOffset=offset;binSize=0;binCounts=new Uint32Array(256);}
  }
  flushAscii();for(const run of utf)flushUtf(run);await input.verify(signal);
  return {sha256:hash.digest('hex'),entropy:{algorithm:'Shannon-256',chunkBytes,global:entropyCounts(counts,totalBytes),bins},strings:{values,count:stringCount,limit:maxStrings,truncated:stringsTruncated||stringCount>values.length},head};
}
function entropyCounts(counts:Uint32Array,size:number):number { if(!size)return 0;let result=0;for(const count of counts)if(count){const p=count/size;result-=p*Math.log2(p);}return Math.round(result*1000)/1000; }

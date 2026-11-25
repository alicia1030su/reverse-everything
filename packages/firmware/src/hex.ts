import { throwIfAborted } from './limits.js';
import type { HexAnalysis } from './types.js';
export const MAX_HEX_LINE_BYTES=16_384;
export interface HexLimits { maxRecords:number;maxBytes:number;maxAddress?:number }
export function isIntelHex(head:Buffer):boolean { const line=head.toString('latin1').split(/\r?\n/,1)[0]??'';return /^:[0-9A-Fa-f]{10,}$/.test(line); }
async function* lines(source:Buffer|AsyncIterable<Buffer>,signal?:AbortSignal):AsyncGenerator<string>{
  let carry:Buffer=Buffer.alloc(0);
  if(Buffer.isBuffer(source)){const text=source.toString('latin1');for(const line of text.split(/\r?\n/)){throwIfAborted(signal);if(line)yield line;}return;}
  for await(const raw of source){throwIfAborted(signal);const chunk=Buffer.isBuffer(raw)?raw:Buffer.from(raw);const data=carry.length?Buffer.concat([carry,chunk]):chunk;let start=0;for(let index=0;index<data.length;index++)if(data[index]===10){if(index-start>MAX_HEX_LINE_BYTES)throw new Error('Intel HEX line exceeds the bounded line limit');yield data.subarray(start,index).toString('latin1').replace(/\r$/,'');start=index+1;}carry=data.subarray(start);if(carry.length>MAX_HEX_LINE_BYTES)throw new Error('Intel HEX line exceeds the bounded line limit');}
  if(carry.length)yield carry.toString('latin1').replace(/\r$/,'');
}
export async function parseHex(source:Buffer|AsyncIterable<Buffer>,limits:HexLimits,signal?:AbortSignal):Promise<HexAnalysis>{
  const result:HexAnalysis={format:'Intel HEX',recordCount:0,byteCount:0,valid:true,checksumErrors:[],overlaps:[],types:{},addressBase:0,minAddress:null,maxAddress:null,overflow:false,eof:false};
  const ranges:{start:number;end:number;record:number}[]=[];let upper=0,eof=false;
  for await(const line of lines(source,signal)){
    if(!line.length)continue;if(result.recordCount>=limits.maxRecords)throw new Error(`Intel HEX record limit ${limits.maxRecords} exceeded`);const record=result.recordCount++;
    if(!/^:[0-9A-Fa-f]+$/.test(line)||line.length<11||line.length%2!==1)throw new Error(`Malformed Intel HEX record ${record+1}`);
    const length=Number.parseInt(line.slice(1,3),16),address=Number.parseInt(line.slice(3,7),16),type=Number.parseInt(line.slice(7,9),16);
    if(line.length!==11+length*2)throw new Error(`Malformed Intel HEX length at record ${record+1}`);
    const bytes=Buffer.from(line.slice(9,9+length*2),'hex');let sum=(length+(address>>8)+(address&255)+type)&255;for(const byte of bytes)sum=(sum+byte)&255;sum=(sum+Number.parseInt(line.slice(9+length*2),16))&255;
    if(sum!==0){result.checksumErrors.push(record);throw new Error(`Intel HEX checksum error at record ${record+1}`);}
    if((type===4||type===2)&&length!==2)throw new Error(`Malformed Intel HEX extension record ${record+1}`);if((type===3||type===5)&&length!==4)throw new Error(`Malformed Intel HEX start-address record ${record+1}`);if(type===1&&length!==0)throw new Error(`Malformed Intel HEX EOF record ${record+1}`);
    result.types[String(type)]=(result.types[String(type)]??0)+1;
    if(type===4)upper=bytes.readUInt16BE(0)*0x10000;
    else if(type===2)upper=bytes.readUInt16BE(0)*0x10;
    else if(type===0){result.byteCount+=length;if(result.byteCount>limits.maxBytes)throw new Error(`Intel HEX byte limit ${limits.maxBytes} exceeded`);const start=upper+address,end=start+length;
      if(!Number.isSafeInteger(start)||end>0x1_0000_0000||start>=(limits.maxAddress??0x1_0000_0000)||end>(limits.maxAddress??0x1_0000_0000)){result.overflow=true;result.valid=false;continue;}
      ranges.push({start,end,record});result.minAddress=result.minAddress===null?start:Math.min(result.minAddress,start);result.maxAddress=result.maxAddress===null?end:Math.max(result.maxAddress,end);result.addressBase=upper;
    }else if(type===1){eof=true;result.eof=true;break;}else if(type!==3&&type!==5)throw new Error(`Unsupported Intel HEX record type ${type}`);
  }
  if(!eof){result.valid=false;throw new Error('Intel HEX EOF record is missing');}
  ranges.sort((a,b)=>a.start-b.start);for(let index=1;index<ranges.length;index++){const prior=ranges[index-1]!,current=ranges[index]!;if(current.start<prior.end){result.valid=false;result.overlaps.push({address:current.start,size:Math.min(prior.end,current.end)-current.start,record:current.record});}}
  return result;
}

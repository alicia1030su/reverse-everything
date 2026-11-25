import { throwIfAborted } from './limits.js';
import type { Uf2Analysis } from './types.js';
const MAGIC0=0x0a324655,MAGIC1=0x9e5d5157,END=0x0ab16f30;
export function isUf2(head:Buffer):boolean { return head.length>=8&&head.readUInt32LE(0)===MAGIC0&&head.readUInt32LE(4)===MAGIC1; }
export async function parseUf2(source:Buffer|AsyncIterable<Buffer>,maxBlocks:number,signal?:AbortSignal):Promise<Uf2Analysis>{
  const result:Uf2Analysis={format:'UF2',blockCount:0,payloadBytes:0,valid:true,flags:[],families:[],numBlocks:null,minAddress:null,maxAddress:null,addressRegions:[],overlaps:0};
  const regions:{start:number;end:number}[]=[],families=new Set<number>(),flags=new Set<number>(),blocks=new Set<number>();let declared:number|null=null;let carry:Buffer=Buffer.alloc(0);
  const accept=(block:Buffer):void=>{
    if(result.blockCount>=maxBlocks)throw new Error(`UF2 block limit ${maxBlocks} exceeded`);
    if(block.length!==512||block.readUInt32LE(0)!==MAGIC0||block.readUInt32LE(4)!==MAGIC1)throw new Error('Invalid UF2 magic or partial 512-byte block');
    if(block.readUInt32LE(508)!==END)throw new Error('Invalid UF2 end magic');
    const payloadSize=block.readUInt32LE(20),blockNo=block.readUInt32LE(24),numBlocks=block.readUInt32LE(28),family=block.readUInt32LE(32),flagsValue=block.readUInt32LE(12),address=block.readUInt32LE(16);
    if(payloadSize!==256)throw new Error('Invalid UF2 payload size');
    if(blockNo>=numBlocks)throw new Error('Invalid UF2 blockNo/numBlocks range');if(declared!==null&&declared!==numBlocks)throw new Error('Inconsistent UF2 numBlocks');
    declared=numBlocks;result.numBlocks=numBlocks;if(blocks.has(blockNo))throw new Error('Duplicate UF2 blockNo');blocks.add(blockNo);if(blockNo!==result.blockCount)throw new Error('UF2 blocks are out of sequence');
    if(families.size&&!families.has(family))throw new Error('Inconsistent UF2 family ID');families.add(family);flags.add(flagsValue);
    if((flagsValue&0x2000)===0)throw new Error('UF2 block does not target the main flash address region');
    const start=address,end=address+payloadSize;if(!Number.isSafeInteger(end)||end>0x1_0000_0000)throw new Error('UF2 address overflow');if(end<=address)throw new Error('UF2 address overflow');
    if(flagsValue&1){if(payloadSize!==256)throw new Error('Invalid MD5 UF2 payload size');}
    let low=0,high=regions.length;while(low<high){const middle=(low+high)>>>1;if(regions[middle]!.end<start)low=middle+1;else high=middle;}
    let index=low,mergedStart=start,mergedEnd=end;while(index<regions.length&&regions[index]!.start<=end){const region=regions[index]!;if(start<region.end&&end>region.start)result.overlaps++;mergedStart=Math.min(mergedStart,region.start);mergedEnd=Math.max(mergedEnd,region.end);index++;}
    regions.splice(low,index-low,{start:mergedStart,end:mergedEnd});
    result.payloadBytes+=payloadSize;if(!Number.isSafeInteger(result.payloadBytes))throw new Error('UF2 payload byte overflow');result.blockCount++;result.minAddress=result.minAddress===null?start:Math.min(result.minAddress,start);result.maxAddress=result.maxAddress===null?end:Math.max(result.maxAddress,end);
  };
  const chunks=Buffer.isBuffer(source)?[source]:source;
  for await(const raw of chunks){throwIfAborted(signal);const chunk=Buffer.isBuffer(raw)?raw:Buffer.from(raw),data=carry.length?Buffer.concat([carry,chunk]):chunk;let offset=0;while(data.length-offset>=512){accept(data.subarray(offset,offset+512));offset+=512;}carry=data.subarray(offset);}
  if(carry.length)throw new Error('Partial UF2 512-byte block');if(!result.blockCount)throw new Error('UF2 input has no blocks');if(declared===null||blocks.size!==declared||result.blockCount!==declared)throw new Error('Incomplete UF2 block sequence');
  result.flags=[...flags];result.families=[...families].map(value=>`0x${value.toString(16).padStart(8,'0')}`);regions.sort((a,b)=>a.start-b.start);result.addressRegions=regions.map(region=>({start:`0x${region.start.toString(16)}`,size:region.end-region.start}));if(result.overlaps)result.valid=false;return result;
}

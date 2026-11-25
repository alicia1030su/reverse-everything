import path from 'node:path';
import { firmwareLimits, throwIfAborted } from './limits.js';
import { inventoryZip } from './archive.js';
import { parseElfFile, isElf } from './elf.js';
import { parseHex, isIntelHex } from './hex.js';
import { detectComponents, makeSbom, securityAnalysis } from './insights.js';
import { detectLayout } from './layout.js';
import { scanFirmware, FirmwareInput } from './stream.js';
import type { ArchiveAnalysis, ElfAnalysis, FirmwareAnalysis, HexAnalysis, Uf2Analysis } from './types.js';
import { parseUf2, isUf2 } from './uf2.js';
export * from './types.js';
export { firmwareLimits } from './limits.js';
export { entropy } from './stream.js';
export { parseElf } from './elf.js';
export { parseHex } from './hex.js';
export { parseUf2 } from './uf2.js';
export { detectLayout } from './layout.js';

export interface FirmwareInputOptions { file:string;name?:string;options?:Record<string,unknown>;signal?:AbortSignal }
async function* chunks(input:FirmwareInput,signal?:AbortSignal):AsyncGenerator<Buffer>{const buffer=Buffer.alloc(Math.min(65_536,input.size));for(let offset=0;offset<input.size;){throwIfAborted(signal);const length=Math.min(65_536,input.size-offset),chunk=await input.readAt(offset,length,signal,buffer);offset+=length;yield chunk;}}
export async function analyzeFirmware(request:FirmwareInputOptions):Promise<FirmwareAnalysis>{
  throwIfAborted(request.signal);const limits=firmwareLimits(request.options??{}),input=await FirmwareInput.open(request.file,limits.maxImageBytes,request.signal);
  try{
    const scan=await scanFirmware(input,limits.chunkBytes,limits.maxStrings,limits.maxStringBytes,limits.maxStringTotalBytes,request.signal);throwIfAborted(request.signal);
    const layout=await detectLayout(input,scan.head,limits.maxSignatureScanBytes,request.signal);throwIfAborted(request.signal);
    let hex:HexAnalysis|null=null,uf2:Uf2Analysis|null=null,elf:ElfAnalysis|null=null,archive:ArchiveAnalysis|null=null;
    if(isIntelHex(scan.head)||/\.(?:hex|ihex)$/i.test(request.name??''))hex=await parseHex(chunks(input,request.signal),{maxRecords:limits.maxHexRecords,maxBytes:limits.maxHexBytes,...(typeof request.options?.firmwareMaxAddress==='number'&&Number.isSafeInteger(request.options.firmwareMaxAddress)?{maxAddress:request.options.firmwareMaxAddress}:{})},request.signal);
    else if(isUf2(scan.head)||/\.uf2$/i.test(request.name??''))uf2=await parseUf2(chunks(input,request.signal),limits.maxUf2Blocks,request.signal);
    else if(isElf(scan.head))elf=await parseElfFile(input,limits);
    else if(layout.formats.includes('ZIP'))archive=await inventoryZip(input,limits.maxArchiveEntries,limits.maxArchiveTotalBytes,limits.maxArchiveRatio);
    throwIfAborted(request.signal);
    const components=detectComponents(scan.strings.values),sbom=makeSbom(components.values,path.basename(request.name??'firmware-image'));
    const known=Boolean(hex||uf2||elf||archive||layout.formats.length),format=hex?.format??uf2?.format??elf?.format??(archive?'ZIP':(layout.formats[0]??'UNKNOWN'));
    const securityFindings=securityAnalysis(scan.strings.values,scan.entropy,layout,known,components.values.length,Boolean(archive));
    const limitations=['Static analysis only: uploaded firmware is never executed, flashed, mounted, unpacked or decompressed','SHA256, entropy and strings cover the entire bounded input stream; structured parsers inspect only declared metadata regions','Component versions and security risks are INFERENCE candidates, not verified provenance or vulnerability findings','Unknown or high-entropy content remains UNKNOWN unless a format signature is present'];
    if(scan.strings.truncated)limitations.push(`String inventory truncated at ${limits.maxStrings} strings or ${limits.maxStringTotalBytes} decoded bytes`);if(layout.signatures.some(item=>/gzip|zlib|7-Zip|tar|XZ|bzip2|LZ4/.test(item.format)))limitations.push('Compressed or archive signature recognized; content was not decompressed and no nested archive was traversed');if(input.size>limits.maxSignatureScanBytes)limitations.push(`Signature scanning was limited to the first ${limits.maxSignatureScanBytes} bytes`);if(hex&&!hex.valid)limitations.push('Intel HEX contains overlapping or overflowing data records; no image was reconstructed');if(uf2&&!uf2.valid)limitations.push('UF2 contains overlapping payload ranges; no image was reconstructed');
    await input.verify(request.signal);return {format,size:input.size,sha256:scan.sha256,entropy:scan.entropy,strings:scan.strings,hex,uf2,elf,layout,components,archive,sbom,securityFindings,limits,totalReadBytes:input.totalReadBytes,truncated:scan.strings.truncated||components.truncated||Boolean(elf?.truncated)||Boolean(archive?.truncated),limitations};
  }finally{await input.close();}
}

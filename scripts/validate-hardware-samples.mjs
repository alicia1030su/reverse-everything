import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { enumerateDevices, parseUsbCapture } from '../packages/hardware/dist/index.js';

const SOURCE='https://gitlab.com/wireshark/wireshark';
const SOURCE_PAGE=`${SOURCE}/-/tree/master/test/captures`;
const LICENSE={name:'GNU General Public License v2 or later',url:`${SOURCE}/-/blob/master/COPYING`,note:'Wireshark repository license applies; samples remain external GPL material and are never copied into this repository.'};
export const SAMPLES=[
  {file:'usb-hid.pcapng',gzip:false,sha256:'893f285dce30121687f164c57572dc873595a7bc289dde3596b7bb0ec160bc34',expected:{format:'PCAPNG',linkType:220,recordCount:10,devices:1,endpoints:2,transactions:5,descriptorCandidates:2,skippedPackets:0,interfaceLinkTypes:[220]}},
  {file:'usb_coverage.pcapng.gz',gzip:true,sha256:'98b5742ef016ea9fb1c2b1035e44f4552262ce69a86255b20f31eeb44d884b3e',expected:{format:'PCAPNG',linkType:186,recordCount:292,devices:5,endpoints:21,transactions:116,descriptorCandidates:29,skippedPackets:41,interfaceLinkTypes:[220,189,249,186,266,1]}},
  {file:'usb_hid_coverage.pcapng.gz',gzip:true,sha256:'24d751a1625f7ea5a9f9390987f7bce28667c8b87be4251bc0f214b4657372a3',expected:{format:'PCAPNG',linkType:220,recordCount:230,devices:7,endpoints:4,transactions:115,descriptorCandidates:54,skippedPackets:37,interfaceLinkTypes:[220,252]}},
];
export const MAX_DOWNLOAD_BYTES=64_000_000,MAX_DECOMPRESSED_BYTES=128_000_000;
export function sha256(bytes){return createHash('sha256').update(bytes).digest('hex');}
export function decodeSample(sample,stored){
  const downloadedSha256=sha256(stored),bytes=sample.gzip?gunzipSync(stored,{maxOutputLength:MAX_DECOMPRESSED_BYTES}):stored,captureSha256=sha256(bytes);
  if(captureSha256!==sample.sha256)throw new Error(`${sample.file}: SHA256 mismatch; expected ${sample.sha256}, received ${captureSha256}`);
  return {bytes,downloadedSha256,sha256:captureSha256};
}
async function download(url,destination){
  if(new URL(url).protocol!=='https:'||new URL(url).hostname!=='gitlab.com')throw new Error('Refusing non-HTTPS or non-official download URL');
  const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(60_000),headers:{'user-agent':'reverse-everything-hardware-sample-validator/1.0'}});
  if(!response.ok||!response.body)throw new Error(`${sampleName(url)}: HTTP ${response.status}`);
  const chunks=[];let total=0;const reader=response.body.getReader();
  try{while(true){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>MAX_DOWNLOAD_BYTES){await reader.cancel();throw new Error(`${sampleName(url)}: download exceeds ${MAX_DOWNLOAD_BYTES} bytes`);}chunks.push(Buffer.from(value));}}finally{reader.releaseLock();}
  const bytes=Buffer.concat(chunks);await writeFile(destination,bytes);return bytes;
}
function sampleName(url){return path.basename(new URL(url).pathname);}
export function summarizeEnumeration(result){
  return {platform:result.platform,status:result.status,usbDeviceCount:result.devices.length,serialPortCount:result.serialPorts?.length??0,capabilities:result.capabilities,anomalies:result.anomalies,limitations:result.limitations,truncated:result.truncated};
}
export function assertSampleExpectation(sample,result){
  for(const [key,value] of Object.entries(sample.expected??{})){
    const actual=result[key];
    if(JSON.stringify(actual)!==JSON.stringify(value))throw new Error(`${sample.file}: known-answer mismatch for ${key}; expected ${JSON.stringify(value)}, received ${JSON.stringify(actual)}`);
  }
}
export async function validateHardwareSamples({localDir,keepTemp=false,includeEnumeration=false}={}){
  const enumeration=includeEnumeration?summarizeEnumeration(await enumerateDevices({platform:'win32',timeoutMs:10_000})):undefined;
  const temp=localDir?undefined:await mkdtemp(path.join(os.tmpdir(),'re-usb-samples-')),directory=localDir??temp,results=[];
  try{
    for(const sample of SAMPLES){
      const url=`${SOURCE}/-/raw/master/test/captures/${sample.file}`,file=path.join(directory,sample.file);let stored;
      if(localDir)stored=await readFile(file);else stored=await download(url,file);
      const decoded=decodeSample(sample,stored),analysis=await parseUsbCapture(decoded.bytes,{maxRecords:100_000,maxTimeline:100_000,maxTransactions:20_000});
      const result={file:sample.file,url,sourcePage:SOURCE_PAGE,license:LICENSE,downloadBytes:stored.length,captureBytes:decoded.bytes.length,downloadedSha256:decoded.downloadedSha256,sha256:decoded.sha256,format:analysis.format,linkType:analysis.linkType,byteOrder:analysis.byteOrder,recordCount:analysis.recordCount,interfaceLinkTypes:analysis.interfaceLinkTypes,skippedPackets:analysis.skippedPackets,devices:Object.keys(analysis.stats.devices).length,interfaces:Object.keys(analysis.stats.interfaces),endpoints:Object.keys(analysis.stats.endpoints).length,transferTypes:analysis.stats.transferTypes,transactions:analysis.transactions.length,descriptorCandidates:analysis.descriptorCandidates.length,anomalies:analysis.anomalies.slice(0,20),truncated:analysis.truncated,limitations:analysis.limitations};
      assertSampleExpectation(sample,result);
      results.push(result);
    }
    return {ok:true,source:SOURCE_PAGE,license:LICENSE,storage:'temporary directory only; no GPL sample is written to the repository',...(enumeration?{enumeration}:{}),results};
  }finally{if(temp&&!keepTemp)await rm(temp,{recursive:true,force:true});}
}
async function main(){
  const args=process.argv.slice(2),localIndex=args.indexOf('--local');if(localIndex>=0&&!args[localIndex+1])throw new Error('--local requires a directory');
  if(args.includes('--enumerate-only')){const enumeration=summarizeEnumeration(await enumerateDevices({platform:'win32',timeoutMs:10_000}));console.log(JSON.stringify({ok:enumeration.status!=='ERROR',mode:'read-only Windows Win32_PnPEntity enumeration',enumeration},null,2));if(enumeration.status==='ERROR')process.exitCode=1;return;}
  const result=await validateHardwareSamples({...(localIndex>=0?{localDir:path.resolve(args[localIndex+1])}:{}),includeEnumeration:args.includes('--enumerate')});console.log(JSON.stringify(result,null,2));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){main().catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});}

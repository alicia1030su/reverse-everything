import { defineAdapter, limitedRead, noReconstruction, output, uploadPath } from './base.js';

export interface NetworkConversation { endpoints:[string,string]; protocol:string; packets:number; bytes:number }
export interface DnsSummary { packets:number; queries:number; responses:number; names:string[]; queryTypes:Record<string,number>; answerTypes:Record<string,number>; responseCodes:Record<string,number>; truncated:boolean }
export interface TlsSummary { records:number; clientHellos:number; serverHellos:number; serverNames:string[]; truncated:boolean }
export interface HttpSample { url?:string|undefined; method?:string|undefined; target?:string|undefined; host?:string|undefined; status?:number|undefined; version?:string|undefined; requestBodySize?:number|undefined; responseBodySize?:number|undefined; mimeType?:string|undefined; requestHeaders?:string[]|undefined; responseHeaders?:string[]|undefined; bodyOmitted:true }
export interface HttpSummary { requests:number; responses:number; methods:Record<string,number>; statuses:Record<string,number>; samples:HttpSample[]; truncated:boolean }
export interface NetworkAnalysis {
  format:'HAR'|'PCAP'|'PCAPNG';
  sourceBytes:number;
  bytesRead:number;
  recordCount:number;
  totalRecords?:number;
  endpoints:string[];
  conversations:NetworkConversation[];
  protocolDistribution:Record<string,number>;
  dns:DnsSummary;
  tls:TlsSummary;
  http:HttpSummary;
  truncated:boolean;
  limitations:string[];
}

interface Limits { maxBytes:number; maxRecords:number; maxBodyBytes:number; maxSamples:number }
interface TransportPacket { version:4|6; src:string; dst:string; protocol:number; payload:Buffer }
interface ParsedPacket extends TransportPacket { srcPort?:number; dstPort?:number; transport?:'TCP'|'UDP' }
interface PacketIndexes { endpoints:Set<string>; conversations:Map<string,NetworkConversation> }

const DEFAULT_MAX_BYTES=16_000_000;
const DEFAULT_MAX_RECORDS=10_000;
const DEFAULT_MAX_BODY_BYTES=65_536;
const DEFAULT_MAX_SAMPLES=2_000;
const MAX_ENDPOINTS=5_000;
const MAX_CONVERSATIONS=5_000;
const MAX_DNS_QUESTIONS=32;
const MAX_DNS_ANSWERS=64;
const MAX_HAR_HEADERS=200;
const MAX_HAR_HEADER_NAME=256;
const MAX_PCAPNG_INTERFACES=256;
const MAX_PCAPNG_BLOCKS=100_000;
const YIELD_EVERY=256;

function positiveOption(value:unknown,fallback:number,max:number):number { return typeof value==='number'&&Number.isFinite(value)&&value>0?Math.min(Math.floor(value),max):fallback; }
function limits(options:Record<string,unknown>):Limits {
  return {maxBytes:positiveOption(options.networkMaxBytes,DEFAULT_MAX_BYTES,64_000_000),maxRecords:positiveOption(options.networkMaxPackets??options.networkMaxEntries,DEFAULT_MAX_RECORDS,100_000),maxBodyBytes:positiveOption(options.networkMaxBodyBytes,DEFAULT_MAX_BODY_BYTES,1_000_000),maxSamples:positiveOption(options.networkMaxSamples,DEFAULT_MAX_SAMPLES,20_000)};
}
function increment(map:Record<string,number>,key:string):void { map[key]=(map[key]??0)+1; }
function markTruncated(result:NetworkAnalysis,message:string):void { result.truncated=true;if(!result.limitations.includes(message))result.limitations.push(message); }
function throwIfAborted(signal?:AbortSignal):void { if(signal?.aborted)throw signal.reason instanceof Error?signal.reason:new DOMException('The operation was aborted','AbortError'); }
async function yieldControl(signal?:AbortSignal):Promise<void> { throwIfAborted(signal);await new Promise<void>(resolve=>setImmediate(resolve));throwIfAborted(signal); }
function emptyDns():DnsSummary { return {packets:0,queries:0,responses:0,names:[],queryTypes:{},answerTypes:{},responseCodes:{},truncated:false}; }
function emptyTls():TlsSummary { return {records:0,clientHellos:0,serverHellos:0,serverNames:[],truncated:false}; }
function emptyHttp():HttpSummary { return {requests:0,responses:0,methods:{},statuses:{},samples:[],truncated:false}; }
function assertAuthorized(authorized:boolean):void { if(!authorized)throw new Error('Explicit authorization confirmation is required before capture analysis'); }
function ipv4(buffer:Buffer,offset:number):string { return `${buffer[offset]}.${buffer[offset+1]}.${buffer[offset+2]}.${buffer[offset+3]}`; }
function ipv6(buffer:Buffer,offset:number):string {
  const words:number[]=[]; for(let i=0;i<8;i++)words.push(buffer.readUInt16BE(offset+i*2));
  let bestStart=-1,bestLength=0; for(let i=0;i<8;){if(words[i]!==0){i++;continue;}const start=i;while(i<8&&words[i]===0)i++;if(i-start>bestLength){bestStart=start;bestLength=i-start;}}
  if(bestLength<2)return words.map(w=>w.toString(16)).join(':');
  const left=words.slice(0,bestStart).map(w=>w.toString(16)).join(':'); const right=words.slice(bestStart+bestLength).map(w=>w.toString(16)).join(':');
  return `${left}::${right}`;
}
function endpoint(ip:string,port:number|undefined,version:4|6):string { return port===undefined?ip:`${version===6?`[${ip}]`:ip}:${port}`; }
const SENSITIVE_QUERY_KEY=/token|secret|password|passwd|auth|signature|api[_-]?key|credential|session|sid|code|key|jwt/i;
function safeUrl(raw:string):string {
  try { const url=new URL(raw); if(url.username||url.password){url.username='';url.password='';} for(const key of [...url.searchParams.keys()])if(SENSITIVE_QUERY_KEY.test(key))url.searchParams.set(key,'[REDACTED]'); url.hash=''; return url.toString(); }
  catch { return '[invalid-url]'; }
}
function safeRequestTarget(raw:string):string {
  const target=raw.slice(0,2048);if(/^[a-z][a-z\d+.-]*:\/\//i.test(target))return safeUrl(target);
  const fragment=target.indexOf('#');const value=fragment<0?target:target.slice(0,fragment),query=value.indexOf('?');if(query<0)return value;
  const params=new URLSearchParams(value.slice(query+1));for(const key of [...params.keys()])if(SENSITIVE_QUERY_KEY.test(key))params.set(key,'[REDACTED]');return `${value.slice(0,query)}?${params.toString()}`;
}
function headerNames(value:unknown):{names:string[];truncated:boolean} {
  if(!Array.isArray(value))return {names:[],truncated:false};
  const names:string[]=[];let truncated=value.length>MAX_HAR_HEADERS;
  for(let i=0;i<Math.min(value.length,MAX_HAR_HEADERS);i++){
    const item=value[i];const name=item&&typeof item==='object'&&typeof (item as {name?:unknown}).name==='string'?(item as {name:string}).name:'[unnamed]';
    if(name.length>MAX_HAR_HEADER_NAME)truncated=true;
    names.push(name.slice(0,MAX_HAR_HEADER_NAME).toLowerCase());
  }
  return {names,truncated};
}
function sizeOption(value:unknown):number|undefined { return typeof value==='number'&&Number.isFinite(value)&&value>=0?Math.floor(value):undefined; }
function detectCapture(name:string,head:Buffer):'HAR'|'PCAP'|'PCAPNG'|undefined {
  if(head.length>=4&&[0xd4c3b2a1,0xa1b2c3d4,0x4d3cb2a1,0xa1b23c4d].includes(head.readUInt32LE(0)))return 'PCAP';
  if(head.length>=4&&head.readUInt32BE(0)===0x0a0d0d0a)return 'PCAPNG';
  if(/\.har$/i.test(name))return 'HAR';
  return undefined;
}

async function parseHar(buffer:Buffer,sourceBytes:number,max:Limits,signal?:AbortSignal):Promise<NetworkAnalysis> {
  throwIfAborted(signal);let root:unknown; try { root=JSON.parse(buffer.toString('utf8')); } catch { throwIfAborted(signal);throw new Error('Malformed HAR: invalid JSON within the bounded input'); }
  const log=(root as {log?:unknown})?.log;
  if(!log||typeof log!=='object'||!Array.isArray((log as {entries?:unknown}).entries))throw new Error('Malformed HAR: log.entries must be an array');
  const entries=(log as {entries:unknown[]}).entries;
  const result:NetworkAnalysis={format:'HAR',sourceBytes,bytesRead:buffer.length,recordCount:Math.min(entries.length,max.maxRecords),totalRecords:entries.length,endpoints:[],conversations:[],protocolDistribution:{},dns:emptyDns(),tls:emptyTls(),http:emptyHttp(),truncated:entries.length>max.maxRecords,limitations:['HAR response bodies, request bodies, cookies and header values are not retained']};
  if(result.truncated)result.limitations.push(`HAR entry limit ${max.maxRecords} reached; ${entries.length-result.recordCount} entries were not inspected`);
  const endpointSet=new Set<string>();let headersTruncated=false;
  for(let i=0;i<result.recordCount;i++){
    if(i%YIELD_EVERY===0)await yieldControl(signal);
    const entry=entries[i] as {request?:{method?:unknown;url?:unknown;headers?:unknown;bodySize?:unknown;postData?:{text?:unknown;mimeType?:unknown}};response?:{status?:unknown;headers?:unknown;bodySize?:unknown;content?:{size?:unknown;mimeType?:unknown};redirectURL?:unknown};timings?:unknown}|null;
    if(!entry||typeof entry!=='object'||!entry.request||typeof entry.request!=='object')throw new Error(`Malformed HAR: entry ${i} has no request object`);
    const request=entry.request; const response=entry.response;
    const url=safeUrl(typeof request.url==='string'?request.url:'[missing-url]'); let host='[unknown-host]';
    try { host=new URL(url).host; } catch { /* invalid URLs are represented explicitly */ }
    if(!endpointSet.has(host)){if(endpointSet.size<MAX_ENDPOINTS)endpointSet.add(host);else markTruncated(result,`Endpoint limit ${MAX_ENDPOINTS} reached; additional endpoints were not retained`);} increment(result.protocolDistribution,'HTTP');
    const method=typeof request.method==='string'?request.method.slice(0,32):'UNKNOWN';
    const requestBodySize=sizeOption(request.bodySize); const responseBodySize=sizeOption(response?.bodySize)??sizeOption(response?.content?.size);
    const mimeType=typeof response?.content?.mimeType==='string'?response.content.mimeType.slice(0,200):undefined;
    const requestText=typeof request.postData?.text==='string'?request.postData.text:undefined;
    const bodyBytes=Math.max(requestBodySize??0,responseBodySize??0,requestText===undefined?0:Buffer.byteLength(requestText));
    if(bodyBytes>max.maxBodyBytes)result.limitations.push(`HAR entry ${i} declares or contains a body larger than ${max.maxBodyBytes} bytes; body content was not retained`);
    const status=typeof response?.status==='number'&&Number.isInteger(response.status)?response.status:undefined;
    if(method!=='UNKNOWN'){result.http.requests++;increment(result.http.methods,method);} if(status!==undefined){result.http.responses++;increment(result.http.statuses,String(status));}
    if(result.http.samples.length<max.maxSamples){
      const requestHeaders=headerNames(request.headers),responseHeaders=headerNames(response?.headers);headersTruncated ||= requestHeaders.truncated||responseHeaders.truncated;
      result.http.samples.push({method,url,host,status,requestBodySize,responseBodySize,mimeType,requestHeaders:requestHeaders.names,responseHeaders:responseHeaders.names,bodyOmitted:true});
    } else result.http.truncated=true;
  }
  result.endpoints=[...endpointSet].sort();
  if(headersTruncated){result.truncated=true;result.http.truncated=true;result.limitations.push(`HAR header inventory limited to ${MAX_HAR_HEADERS} names per request/response and ${MAX_HAR_HEADER_NAME} characters per name`);}
  if(result.recordCount>max.maxSamples){result.truncated=true;result.limitations.push(`HTTP sample limit ${max.maxSamples} reached`);}
  throwIfAborted(signal);return result;
}

function parseLinkPacket(linkType:number,packet:Buffer,snaplen:number):{packet:Buffer;etherType?:number}|undefined {
  if(linkType===1){
    if(packet.length<14)return undefined; let offset=14; let type=packet.readUInt16BE(12);
    while((type===0x8100||type===0x88a8||type===0x9100)&&packet.length>=offset+4){type=packet.readUInt16BE(offset+2);offset+=4;}
    return {packet:packet.subarray(offset),etherType:type};
  }
  if(linkType===113){if(packet.length<16)return undefined;return {packet:packet.subarray(16),etherType:packet.readUInt16BE(14)};}
  if(linkType===276){if(packet.length<20)return undefined;return {packet:packet.subarray(20),etherType:packet.readUInt16BE(0)};}
  if(linkType===101||linkType===228||linkType===229||linkType===12)return {packet};
  if(linkType===0||linkType===108){if(packet.length<4)return undefined;return {packet:packet.subarray(4)};}
  void snaplen; return undefined;
}
function parseIp(packet:Buffer,etherType?:number):TransportPacket|undefined {
  if(packet.length<1)return undefined; const version=packet[0]!>>>4;
  if(etherType===0x0800&&version!==4)return undefined; if(etherType===0x86dd&&version!==6)return undefined;
  if(version===4){
    if(packet.length<20)return undefined; const ihl=(packet[0]!&15)*4; if(ihl<20||packet.length<ihl)return undefined;
    const total=packet.readUInt16BE(2); const fragment=packet.readUInt16BE(6); if((fragment&0x1fff)!==0)return undefined;
    const end=Math.min(packet.length,total>0?total:packet.length); return {version:4,src:ipv4(packet,12),dst:ipv4(packet,16),protocol:packet[9]!,payload:packet.subarray(ihl,end)};
  }
  if(version===6){
    if(packet.length<40)return undefined; let next=packet[6]!,offset=40; const end=Math.min(packet.length,40+packet.readUInt16BE(4));
    for(let guards=0;guards<8;guards++){
      if(next===6||next===17)break;
      if(next===44){if(offset+8>end)return undefined;const fragment=packet.readUInt16BE(offset+2);if((fragment&0xfff8)!==0)return undefined;next=packet[offset]!;offset+=8;continue;}
      if(next===0||next===43||next===60){if(offset+2>end)return undefined;const size=(packet[offset+1]!+1)*8;next=packet[offset]!;offset+=size;continue;}
      if(next===51){if(offset+2>end)return undefined;const size=(packet[offset+1]!+2)*4;next=packet[offset]!;offset+=size;continue;}
      return undefined;
    }
    if(offset>end)return undefined; return {version:6,src:ipv6(packet,8),dst:ipv6(packet,24),protocol:next,payload:packet.subarray(offset,end)};
  }
  return undefined;
}
function parseTransport(packet:TransportPacket):ParsedPacket {
  if(packet.protocol===6&&packet.payload.length>=20){const offset=(packet.payload[12]!>>>4)*4;if(offset<20||packet.payload.length<offset)return {...packet,transport:'TCP'};return {...packet,srcPort:packet.payload.readUInt16BE(0),dstPort:packet.payload.readUInt16BE(2),transport:'TCP',payload:packet.payload.subarray(offset)};}
  if(packet.protocol===17&&packet.payload.length>=8)return {...packet,srcPort:packet.payload.readUInt16BE(0),dstPort:packet.payload.readUInt16BE(2),transport:'UDP',payload:packet.payload.subarray(8)};
  return packet.protocol===6||packet.protocol===17?{...packet,transport:packet.protocol===6?'TCP':'UDP'}:{...packet};
}
function dnsName(buffer:Buffer,start:number):{name:string;next:number}|undefined {
  const labels:string[]=[];let offset=start,next=-1,jumps=0;
  while(offset<buffer.length&&jumps++<32){const length=buffer[offset]!;if(length===0){if(next<0)next=offset+1;return {name:labels.join('.'),next};}if((length&0xc0)===0xc0){if(offset+1>=buffer.length)return undefined;const pointer=((length&0x3f)<<8)|buffer[offset+1]!;if(next<0)next=offset+2;offset=pointer;continue;}if((length&0xc0)!==0||offset+1+length>buffer.length)return undefined;labels.push(buffer.subarray(offset+1,offset+1+length).toString('latin1'));offset+=1+length;}
  return undefined;
}
const DNS_TYPES:Record<number,string>={1:'A',2:'NS',5:'CNAME',6:'SOA',12:'PTR',15:'MX',16:'TXT',28:'AAAA',33:'SRV',41:'OPT',65:'HTTPS'};
const DNS_RCODES:Record<number,string>={0:'NOERROR',1:'FORMERR',2:'SERVFAIL',3:'NXDOMAIN',4:'NOTIMP',5:'REFUSED'};
function inspectDns(packet:ParsedPacket,summary:DnsSummary,limitations:string[]):boolean {
  if(packet.transport!=='UDP'||(packet.srcPort!==53&&packet.dstPort!==53)||packet.payload.length<12)return false;
  const data=packet.payload;summary.packets++;const flags=data.readUInt16BE(2);const questions=data.readUInt16BE(4),answers=data.readUInt16BE(6);if((flags&0x8000)!==0)summary.responses++;else summary.queries++;
  if(questions>MAX_DNS_QUESTIONS||answers>MAX_DNS_ANSWERS){summary.truncated=true;const reason=questions>MAX_DNS_QUESTIONS?`question limit ${MAX_DNS_QUESTIONS}`:`answer limit ${MAX_DNS_ANSWERS}`;const message=`DNS packet exceeded the per-packet ${reason}; its records were not inspected`;if(!limitations.includes(message))limitations.push(message);return true;}
  let offset=12;for(let i=0;i<questions;i++){const parsed=dnsName(data,offset);if(!parsed||parsed.next<=offset||parsed.next+4>data.length)return true;if(summary.names.length<1000)summary.names.push(parsed.name.toLowerCase());else summary.truncated=true;const type=data.readUInt16BE(parsed.next);increment(summary.queryTypes,DNS_TYPES[type]??`TYPE_${type}`);offset=parsed.next+4;}
  for(let i=0;i<answers;i++){const parsed=dnsName(data,offset);if(!parsed||parsed.next<=offset||parsed.next+10>data.length)return true;const type=data.readUInt16BE(parsed.next);increment(summary.answerTypes,DNS_TYPES[type]??`TYPE_${type}`);offset=parsed.next+10+data.readUInt16BE(parsed.next+8);if(offset>data.length)return true;}
  if((flags&15)!==0)increment(summary.responseCodes,DNS_RCODES[flags&15]??`RCODE_${flags&15}`);return true;
}
function tlsServerNames(payload:Buffer,summary:TlsSummary):void {
  if(payload.length<9||payload[0]!==1)return;const length=((payload[1]!<<16)|(payload[2]!<<8)|payload[3]!)>>>0;const hello=payload.subarray(4,Math.min(payload.length,4+length));if(hello.length<35)return;let offset=34;const sessionLength=hello[offset++]!;offset+=sessionLength;if(offset+2>hello.length)return;offset+=2+hello.readUInt16BE(offset);if(offset>=hello.length)return;offset+=1+hello[offset]!;if(offset+2>hello.length)return;const extensionsLength=hello.readUInt16BE(offset);offset+=2;const end=Math.min(hello.length,offset+extensionsLength);
  while(offset+4<=end){const type=hello.readUInt16BE(offset),size=hello.readUInt16BE(offset+2);offset+=4;if(offset+size>end)return;if(type===0&&size>=5){const listLength=hello.readUInt16BE(offset);let entry=offset+2;const listEnd=Math.min(offset+size,offset+2+listLength);while(entry+3<=listEnd){const nameType=hello[entry++],nameLength=hello.readUInt16BE(entry);entry+=2;if(entry+nameLength>listEnd)return;if(nameType===0){if(summary.serverNames.length<100)summary.serverNames.push(hello.subarray(entry,entry+nameLength).toString('utf8').toLowerCase().replace(/\.$/,''));else summary.truncated=true;}entry+=nameLength;}}offset+=size;}
}
function inspectTls(packet:ParsedPacket,summary:TlsSummary):boolean {
  if(packet.transport!=='TCP'||packet.payload.length<5||packet.payload[0]!==0x16||packet.payload[1]!==0x03)return false;
  const length=packet.payload.readUInt16BE(3);if(length===0||5+length>packet.payload.length)return false;summary.records++;const handshake=packet.payload[5];if(handshake===1){summary.clientHellos++;tlsServerNames(packet.payload.subarray(5),summary);}else if(handshake===2)summary.serverHellos++;return true;
}
function inspectHttp(packet:ParsedPacket,summary:HttpSummary,maxSamples:number):boolean {
  if(packet.transport!=='TCP'||packet.payload.length<8)return false;const text=packet.payload.subarray(0,Math.min(packet.payload.length,4096)).toString('latin1');
  const request=/^([A-Z]{3,20}) (\S+) HTTP\/(\d\.\d)\r?\n/.exec(text);const response=/^HTTP\/(\d\.\d) (\d{3}) /.exec(text);
  if(!request&&!response)return false;const host=/\r?\nHost:\s*([^\r\n]+)/i.exec(text)?.[1]?.trim().slice(0,255);
  if(request){summary.requests++;increment(summary.methods,request[1]!);}if(response){summary.responses++;increment(summary.statuses,response[2]!);}
  if(summary.samples.length<maxSamples)summary.samples.push({method:request?.[1],target:request?.[2]===undefined?undefined:safeRequestTarget(request[2]),host,status:response?Number(response[2]):undefined,version:(request??response)?.[3],bodyOmitted:true});else summary.truncated=true;return true;
}
function applyPacket(result:NetworkAnalysis,packet:ParsedPacket,limitsValue:Limits,indexes:PacketIndexes):void {
  const source=endpoint(packet.src,packet.srcPort,packet.version),destination=endpoint(packet.dst,packet.dstPort,packet.version);
  for(const value of [source,destination])if(!indexes.endpoints.has(value)){if(indexes.endpoints.size<MAX_ENDPOINTS){indexes.endpoints.add(value);result.endpoints.push(value);}else markTruncated(result,`Endpoint limit ${MAX_ENDPOINTS} reached; additional endpoints were not retained`);}
  const protocol=packet.transport??`IP_${packet.protocol}`;increment(result.protocolDistribution,protocol);
  const first=source<destination?source:destination,second=source<destination?destination:source;const key=`${protocol}\0${first}\0${second}`;let conversation=indexes.conversations.get(key);
  if(!conversation){if(indexes.conversations.size>=MAX_CONVERSATIONS)markTruncated(result,`Conversation limit ${MAX_CONVERSATIONS} reached; additional conversations were not retained`);else{conversation={endpoints:[source,destination],protocol,packets:0,bytes:0};indexes.conversations.set(key,conversation);result.conversations.push(conversation);}}
  if(conversation){conversation.packets++;conversation.bytes+=packet.payload.length;}
  if(inspectDns(packet,result.dns,result.limitations))increment(result.protocolDistribution,'DNS');if(inspectTls(packet,result.tls))increment(result.protocolDistribution,'TLS');if(inspectHttp(packet,result.http,limitsValue.maxSamples))increment(result.protocolDistribution,'HTTP');
}

async function parsePcap(buffer:Buffer,sourceBytes:number,max:Limits,signal?:AbortSignal):Promise<NetworkAnalysis> {
  throwIfAborted(signal);if(buffer.length<24)throw new Error('Malformed PCAP: truncated global header');
  const magic=buffer.readUInt32LE(0);let little=true;if(magic===0xa1b2c3d4||magic===0xa1b23c4d)little=true;else if(magic===0xd4c3b2a1||magic===0x4d3cb2a1)little=false;else throw new Error('Malformed PCAP: invalid magic');
  const read16=(offset:number)=>little?buffer.readUInt16LE(offset):buffer.readUInt16BE(offset);const read32=(offset:number)=>little?buffer.readUInt32LE(offset):buffer.readUInt32BE(offset);
  if(read16(4)!==2||read16(6)!==4)throw new Error('Malformed PCAP: unsupported version');const linkType=read32(20);const snaplen=read32(16);
  const result:NetworkAnalysis={format:'PCAP',sourceBytes,bytesRead:buffer.length,recordCount:0,endpoints:[],conversations:[],protocolDistribution:{},dns:emptyDns(),tls:emptyTls(),http:emptyHttp(),truncated:buffer.length<sourceBytes,limitations:[]};
  if(result.truncated)result.limitations.push(`PCAP byte limit ${max.maxBytes} reached`);
  let offset=24,index=0;const indexes:PacketIndexes={endpoints:new Set(),conversations:new Map()};
  while(offset<buffer.length){
    if(index%YIELD_EVERY===0)await yieldControl(signal);
    if(result.recordCount>=max.maxRecords){result.truncated=true;result.limitations.push(`Packet limit ${max.maxRecords} reached`);break;}
    if(offset+16>buffer.length){if(result.truncated)break;throw new Error('Malformed PCAP: truncated packet record header');}
    const captured=read32(offset+8),original=read32(offset+12);if(original<captured)throw new Error(`Malformed PCAP: packet ${index} captured length exceeds original length`);if(offset+16+captured>buffer.length){if(result.truncated)break;throw new Error(`Malformed PCAP: truncated packet ${index} data`);}
    const raw=buffer.subarray(offset+16,offset+16+captured);const link=parseLinkPacket(linkType,raw,snaplen);
    if(!link)increment(result.protocolDistribution,'UNSUPPORTED_LINK');else{const ip=parseIp(link.packet,link.etherType);if(ip)applyPacket(result,parseTransport(ip),max,indexes);else increment(result.protocolDistribution,'NON_IP_OR_MALFORMED');}
    result.recordCount++;index++;offset+=16+captured;
  }
  throwIfAborted(signal);return result;
}

async function parsePcapng(buffer:Buffer,sourceBytes:number,max:Limits,signal?:AbortSignal):Promise<NetworkAnalysis> {
  throwIfAborted(signal);const result:NetworkAnalysis={format:'PCAPNG',sourceBytes,bytesRead:buffer.length,recordCount:0,endpoints:[],conversations:[],protocolDistribution:{},dns:emptyDns(),tls:emptyTls(),http:emptyHttp(),truncated:buffer.length<sourceBytes,limitations:[]};
  if(result.truncated)result.limitations.push(`PCAPNG byte limit ${max.maxBytes} reached`);
  let little=true,offset=0,blockCount=0,interfaceCount=0;let interfaces:{linkType:number;snaplen:number}[]=[];const indexes:PacketIndexes={endpoints:new Set(),conversations:new Map()};
  while(offset<buffer.length){
    if(blockCount%YIELD_EVERY===0)await yieldControl(signal);
    if(offset===0&&buffer.readUInt32BE(0)!==0x0a0d0d0a)throw new Error('Malformed PCAPNG: first block is not a section header');
    if(blockCount>=MAX_PCAPNG_BLOCKS){markTruncated(result,`PCAPNG block limit ${MAX_PCAPNG_BLOCKS} reached`);break;}
    if(result.recordCount>=max.maxRecords){markTruncated(result,`Packet limit ${max.maxRecords} reached`);break;}
    if(offset+12>buffer.length){if(result.truncated)break;throw new Error('Malformed PCAPNG: truncated block header');}
    if(buffer.readUInt32BE(offset)===0x0a0d0d0a){if(offset+28>buffer.length){if(result.truncated)break;throw new Error('Malformed PCAPNG: truncated section header');}const bom=buffer.readUInt32LE(offset+8);if(bom===0x1a2b3c4d)little=true;else if(bom===0x4d3c2b1a)little=false;else throw new Error('Malformed PCAPNG: invalid byte-order magic');interfaces=[];}
    const read32=(position:number)=>little?buffer.readUInt32LE(position):buffer.readUInt32BE(position);const read16=(position:number)=>little?buffer.readUInt16LE(position):buffer.readUInt16BE(position);
    const type=read32(offset),length=read32(offset+4);if(length<12||length%4!==0||offset+length>buffer.length){if(result.truncated)break;throw new Error('Malformed PCAPNG: invalid or truncated block length');}if(read32(offset+length-4)!==length)throw new Error('Malformed PCAPNG: block length trailer mismatch');
    const body=offset+8,bodyLength=length-12;blockCount++;
    if(type===1){if(bodyLength<8)throw new Error('Malformed PCAPNG: truncated interface description');if(interfaceCount>=MAX_PCAPNG_INTERFACES){markTruncated(result,`PCAPNG interface limit ${MAX_PCAPNG_INTERFACES} reached`);break;}interfaces.push({linkType:read16(body),snaplen:read32(body+4)});interfaceCount++;}
    else if(type===6){if(bodyLength<20)throw new Error('Malformed PCAPNG: truncated enhanced packet block');const id=read32(body),captured=read32(body+12);if(id>=interfaces.length)throw new Error('Malformed PCAPNG: packet references an unknown interface');if(captured>bodyLength-20)throw new Error('Malformed PCAPNG: captured packet length exceeds block');const link=parseLinkPacket(interfaces[id]!.linkType,buffer.subarray(body+20,body+20+captured),interfaces[id]!.snaplen);if(!link)increment(result.protocolDistribution,'UNSUPPORTED_LINK');else{const ip=parseIp(link.packet,link.etherType);if(ip)applyPacket(result,parseTransport(ip),max,indexes);else increment(result.protocolDistribution,'NON_IP_OR_MALFORMED');}result.recordCount++;}
    else if(type===3){if(bodyLength<4)throw new Error('Malformed PCAPNG: truncated simple packet block');const iface=interfaces[0];if(!iface)throw new Error('Malformed PCAPNG: simple packet has no interface');const original=read32(body);const captured=Math.min(original,iface.snaplen||original,bodyLength-4);const link=parseLinkPacket(iface.linkType,buffer.subarray(body+4,body+4+captured),iface.snaplen);if(!link)increment(result.protocolDistribution,'UNSUPPORTED_LINK');else{const ip=parseIp(link.packet,link.etherType);if(ip)applyPacket(result,parseTransport(ip),max,indexes);else increment(result.protocolDistribution,'NON_IP_OR_MALFORMED');}result.recordCount++;}
    else if(type===2){if(bodyLength<20)throw new Error('Malformed PCAPNG: truncated packet block');const id=read16(body),captured=read32(body+12);if(id>=interfaces.length)throw new Error('Malformed PCAPNG: packet references an unknown interface');if(captured>bodyLength-20)throw new Error('Malformed PCAPNG: captured packet length exceeds block');const link=parseLinkPacket(interfaces[id]!.linkType,buffer.subarray(body+20,body+20+captured),interfaces[id]!.snaplen);if(!link)increment(result.protocolDistribution,'UNSUPPORTED_LINK');else{const ip=parseIp(link.packet,link.etherType);if(ip)applyPacket(result,parseTransport(ip),max,indexes);else increment(result.protocolDistribution,'NON_IP_OR_MALFORMED');}result.recordCount++;}
    offset+=length;
  }
  if(result.recordCount===0&&!result.truncated)throw new Error('Malformed PCAPNG: no packet blocks found');
  throwIfAborted(signal);return result;
}

function finalizeNetwork(result:NetworkAnalysis,max:Limits):void {
  if(result.dns.truncated){result.truncated=true;if(!result.limitations.some(item=>item.startsWith('DNS ')))result.limitations.push('DNS metadata limit reached; some names were not retained');}
  if(result.tls.truncated){result.truncated=true;if(!result.limitations.some(item=>item.startsWith('TLS ')))result.limitations.push('TLS server-name limit reached; some names were not retained');}
  if(result.http.truncated&&!result.limitations.some(item=>item.startsWith('HTTP sample limit')||item.startsWith('HAR header inventory')))markTruncated(result,`HTTP sample limit ${max.maxSamples} reached`);
}

export const networkAdapter=defineAdapter({
  name:'network',version:'1.0.0',description:'Bounded offline HAR, PCAP and PCAPNG metadata analysis without target execution or sensitive body retention.',
  available:async()=>({available:true,detail:'Built-in bounded capture parser; no network access is performed'}),
  detect:async ctx=>{const head=await limitedRead(uploadPath(ctx),8);const format=detectCapture(ctx.upload?.name??'',head);if(!format)throw new Error('Network adapter supports HAR, PCAP and PCAPNG captures only');return {adapter:'network',confidence:format==='HAR'?0.9:1,format,details:{size:ctx.upload?.size??0},limitations:['Capture metadata is analyzed offline; application protocols are signature-based inferences']};},
  prepare:async ctx=>{assertAuthorized(ctx.project.authorizationConfirmed);const head=await limitedRead(uploadPath(ctx),8);const format=detectCapture(ctx.upload?.name??'',head);if(!format)throw new Error('Unsupported capture format');return {format,limits:limits(ctx.options)};},
  analyze:async ctx=>{
    throwIfAborted(ctx.signal);assertAuthorized(ctx.project.authorizationConfirmed);const prep=output<{format:'HAR'|'PCAP'|'PCAPNG';limits:Limits}>(ctx,'PREPARE')??await networkAdapter.prepare(ctx) as {format:'HAR'|'PCAP'|'PCAPNG';limits:Limits};
    const sourceBytes=ctx.upload?.size??0;const buffer=await limitedRead(uploadPath(ctx),prep.limits.maxBytes);throwIfAborted(ctx.signal);
    const result=await(prep.format==='HAR'?parseHar(buffer,sourceBytes,prep.limits,ctx.signal):prep.format==='PCAP'?parsePcap(buffer,sourceBytes,prep.limits,ctx.signal):parsePcapng(buffer,sourceBytes,prep.limits,ctx.signal));finalizeNetwork(result,prep.limits);throwIfAborted(ctx.signal);
    result.limitations.push('Protocol labels are inferred from bounded packet signatures; no target was executed');await ctx.log('info',`Parsed ${result.format} with ${result.recordCount} records and ${result.endpoints.length} endpoints`,'capture-parser');throwIfAborted(ctx.signal);return result;
  },
  extractEvidence:async ctx=>{
    throwIfAborted(ctx.signal);const analysis=output<NetworkAnalysis>(ctx,'ANALYZE');await ctx.evidence('EVIDENCE',`${analysis.format} capture metadata`,'capture-parser','capture',{format:analysis.format,recordCount:analysis.recordCount,totalRecords:analysis.totalRecords,endpoints:analysis.endpoints.slice(0,2000),conversations:analysis.conversations.slice(0,1000),truncated:analysis.truncated});throwIfAborted(ctx.signal);
    await ctx.evidence('INFERENCE','Transport and application protocol distribution','capture-signatures','protocols',analysis.protocolDistribution);throwIfAborted(ctx.signal);if(analysis.dns.packets)await ctx.evidence('INFERENCE','DNS metadata summary','dns-parser','dns',analysis.dns);if(analysis.tls.records)await ctx.evidence('INFERENCE','TLS handshake summary','tls-parser','tls',analysis.tls);if(analysis.http.requests||analysis.http.responses)await ctx.evidence('INFERENCE','HTTP metadata summary','http-parser','http',analysis.http);throwIfAborted(ctx.signal);
    await ctx.writeArtifact('network-analysis.json',JSON.stringify(analysis,null,2),'application/json');throwIfAborted(ctx.signal);return {records:analysis.recordCount,endpoints:analysis.endpoints.length,truncated:analysis.truncated,artifacts:['network-analysis.json']};
  },
  reconstruct:async ctx=>{await ctx.evidence('UNKNOWN','Capture-only analysis does not reconstruct an application','network-adapter','reconstruct',{reason:'No target behavior or source was generated'});return noReconstruction(ctx,'No application was executed or reconstructed from capture metadata');},
  validate:async ctx=>{const analysis=output<NetworkAnalysis>(ctx,'ANALYZE');const checks=[{name:'recognized capture format',passed:['HAR','PCAP','PCAPNG'].includes(analysis.format)},{name:'bounded input read',passed:analysis.bytesRead<=analysis.sourceBytes},{name:'sensitive bodies omitted',passed:analysis.format!=='HAR'||analysis.http.samples.every(sample=>sample.bodyOmitted)}];return {passed:checks.every(check=>check.passed),checks,limitations:analysis.limitations};}
});

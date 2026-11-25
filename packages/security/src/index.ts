import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import type { LookupAddress } from 'node:dns';
import yauzl from 'yauzl';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFile, writeFile, chmod, mkdir } from 'node:fs/promises';
import { isIP } from 'node:net';

export function redactSensitive(text:string):string { return text.replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,'[REDACTED_PRIVATE_KEY]').replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,'[REDACTED_AWS_KEY]').replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\b/g,'[REDACTED_JWT]').replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+/gi,'$1[REDACTED]').replace(/((?:api[_-]?key|password|secret|token|cookie|set-cookie|jwt|private[_-]?key|access[_-]?key|secret[_-]?key)\s*[:=]\s*["']?)[A-Za-z0-9._~+\/-]{12,}/gi,'$1[REDACTED]'); }
export function encryptSecret(value:string,keyHex:string):string { const iv=randomBytes(12); const cipher=createCipheriv('aes-256-gcm',Buffer.from(keyHex,'hex'),iv); const data=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]); return `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${data.toString('base64')}`; }
export function decryptSecret(value:string,keyHex:string):string { const [iv,tag,data]=value.split('.'); if(!iv||!tag||!data)return ''; const decipher=createDecipheriv('aes-256-gcm',Buffer.from(keyHex,'hex'),Buffer.from(iv,'base64')); decipher.setAuthTag(Buffer.from(tag,'base64')); return Buffer.concat([decipher.update(Buffer.from(data,'base64')),decipher.final()]).toString('utf8'); }
export async function encryptionKey(dataDir:string):Promise<string> { await mkdir(dataDir,{recursive:true}); const file=`${dataDir}/secret.key`; try{return (await readFile(file,'utf8')).trim();}catch{const key=randomBytes(32).toString('hex');await writeFile(file,key,{mode:0o600});await chmod(file,0o600);return key;} }
export class SecurityError extends Error { constructor(message:string, readonly code:string) { super(message); this.name='SecurityError'; } }
function parseIPv6(address:string): number[] | null {
  if(isIP(address)!==6||address.includes('%')) return null;
  const halves=address.split('::');
  if(halves.length>2) return null;
  const parseSide=(side:string):number[]|null=>{
    if(!side) return [];
    const words:number[]=[];
    const parts=side.split(':');
    for(const [index,part] of parts.entries()) {
      if(part.includes('.')) {
        if(index!==parts.length-1||isIP(part)!==4) return null;
        const octets=part.split('.').map(Number);
        words.push((octets[0]!<<8)|octets[1]!,(octets[2]!<<8)|octets[3]!);
      } else {
        if(!/^[0-9a-f]{1,4}$/.test(part)) return null;
        words.push(Number.parseInt(part,16));
      }
    }
    return words;
  };
  const left=parseSide(halves[0]!);
  const right=halves.length===2?parseSide(halves[1]!):[];
  if(!left||!right) return null;
  const missing=8-left.length-right.length;
  if(halves.length===1) return missing===0?[...left,...right]:null;
  if(missing<1) return null;
  return [...left,...Array<number>(missing).fill(0),...right];
}
function hasWordPrefix(words:number[],prefix:number[]):boolean { return prefix.every((word,index)=>words[index]===word); }
function embeddedIPv4(words:number[],offset:number):string { return [words[offset]!>>>8,words[offset]!&255,words[offset+1]!>>>8,words[offset+1]!&255].join('.'); }
function invertedEmbeddedIPv4(words:number[],offset:number):string { return [words[offset]!>>>8^255,words[offset]!&255^255,words[offset+1]!>>>8^255,words[offset+1]!&255^255].join('.'); }
function isPublicIPv4(address:string):boolean {
  if(isIP(address)!==4) return false;
  const octets=address.split('.').map(Number);
  const a=octets[0]!,b=octets[1]!;
  return !(a===0||a===10||a===127||a>=224||
    (a===100&&b>=64&&b<=127)||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||
    (a===192&&b===168)||(a===192&&b===0)||(a===192&&b===88&&octets[2]===99)||
    (a===198&&b===18||a===198&&b===19)||(a===198&&b===51&&octets[2]===100)||
    (a===203&&b===0&&octets[2]===113));
}
export function isPublicAddress(address:string): boolean {
  const ip=address.toLowerCase();
  if(isIP(ip)===4) return isPublicIPv4(ip);
  const words=parseIPv6(ip);
  if(!words) return false;

  // IPv4-mapped, IPv4-translated, compatible, NAT64, 6to4 and Teredo addresses
  // must apply the IPv4 policy to every embedded address, including obfuscated ones.
  if(hasWordPrefix(words,[0,0,0,0,0,0xffff])) return isPublicAddress(embeddedIPv4(words,6));
  if(hasWordPrefix(words,[0,0,0,0,0xffff,0])) return isPublicAddress(embeddedIPv4(words,6));
  if(hasWordPrefix(words,[0,0,0,0,0,0])) return isPublicAddress(embeddedIPv4(words,6));
  if(hasWordPrefix(words,[0x64,0xff9b,1])) return false;
  if(hasWordPrefix(words,[0x64,0xff9b])) return isPublicAddress(embeddedIPv4(words,6));
  if(hasWordPrefix(words,[0x2002])) return isPublicAddress(embeddedIPv4(words,1));
  if(hasWordPrefix(words,[0x2001,0])) {
    return isPublicAddress(embeddedIPv4(words,2))&&isPublicAddress(invertedEmbeddedIPv4(words,6));
  }

  const first=words[0]!,second=words[1]!;
  if(first===0||first===0x100&&second===0||
    (first&0xfe00)===0xfc00||(first&0xffc0)===0xfe80||
    (first&0xffc0)===0xfec0||(first&0xff00)===0xff00||
    (first===0x2001&&second===0x0db8)||
    (first===0x3fff&&(second&0xfff0)===0)||
    first===0x5f00||(first===0x2001&&second===2&&words[2]===0)||
    (first===0x2001&&((second&0xfff0)===0x0010||(second&0xfff0)===0x0020))) return false;
  return true;
}
export interface SafeTarget { url: URL; addresses: string[] }
function abortError(signal:AbortSignal):Error {
  return signal.reason instanceof Error ? signal.reason : Object.assign(new Error('Operation aborted'),{name:'AbortError',cause:signal.reason});
}
function withAbort<T>(promise:Promise<T>,signal?:AbortSignal):Promise<T> {
  if(!signal) return promise;
  if(signal.aborted) { void promise.catch(()=>{}); return Promise.reject(abortError(signal)); }
  return new Promise<T>((resolve,reject)=>{
    const onAbort=()=>reject(abortError(signal));
    const cleanup=()=>signal.removeEventListener('abort',onAbort);
    signal.addEventListener('abort',onAbort,{once:true});
    promise.then(value=>{cleanup();resolve(value);},error=>{cleanup();reject(error);});
  });
}
function isLoopbackAddress(address:string):boolean {
  const ip=address.toLowerCase();
  if(isIP(ip)===4) return ip.startsWith('127.');
  const words=parseIPv6(ip);
  return words!==null&&words.slice(0,7).every(word=>word===0)&&words[7]===1;
}
function isLoopbackHost(host:string):boolean {
  return host==='localhost'||host.endsWith('.localhost')||isLoopbackAddress(host);
}
function parseTarget(raw:string,allowLocal:boolean,signal?:AbortSignal):{url:URL;host:string} {
  if(signal?.aborted) throw abortError(signal);
  let url:URL;
  try { url=new URL(raw); } catch { throw new SecurityError('Invalid URL','INVALID_URL'); }
  if(!['http:','https:'].includes(url.protocol)) throw new SecurityError('Only HTTP and HTTPS targets are allowed','BAD_PROTOCOL');
  if(url.username||url.password) throw new SecurityError('Credentials in URLs are forbidden','URL_CREDENTIALS');
  const host=url.hostname.replace(/^\[|\]$/g,'').toLowerCase();
  if((host==='localhost'||host.endsWith('.localhost'))&&!allowLocal) throw new SecurityError('Loopback targets require explicit local analysis permission','LOCAL_BLOCKED');
  return {url,host};
}
function checkedTarget(url:URL,host:string,addresses:string[],allowLocal:boolean):SafeTarget {
  const local=allowLocal&&isLoopbackHost(host);
  if(isIP(host)&&!local&&!isPublicAddress(host)) throw new SecurityError('Private, loopback, link-local or metadata addresses are blocked','SSRF_BLOCKED');
  if(!addresses.length) throw new SecurityError('Target hostname has no addresses','DNS_FAILED');
  if(addresses.some(address=>local?!isLoopbackAddress(address):!isPublicAddress(address))) throw new SecurityError('Private, loopback, link-local or metadata addresses are blocked','SSRF_BLOCKED');
  const allowedPort=url.protocol==='https:'?443:80;
  if(url.port&&Number(url.port)!==allowedPort&&!local) throw new SecurityError('Non-standard public ports are blocked','PORT_BLOCKED');
  return {url,addresses};
}
function approvedTarget(raw:string,addresses:string[],allowLocal:boolean,signal?:AbortSignal):SafeTarget {
  const {url,host}=parseTarget(raw,allowLocal,signal);
  if(!Array.isArray(addresses)||!addresses.length||addresses.some(address=>typeof address!=='string')) throw new SecurityError('Approved addresses must be a non-empty string array','INVALID_ADDRESSES');
  return checkedTarget(url,host,[...addresses],allowLocal);
}
export async function validateTarget(raw:string, allowLocal=false, signal?:AbortSignal): Promise<SafeTarget> {
  const {url,host}=parseTarget(raw,allowLocal,signal);
  let addresses:LookupAddress[];
  try { addresses=await withAbort(lookup(host,{all:true,verbatim:true}),signal); } catch { if(signal?.aborted) throw abortError(signal); throw new SecurityError('Target hostname could not be resolved','DNS_FAILED'); }
  if(signal?.aborted) throw abortError(signal);
  if(!addresses.length) throw new SecurityError('Target hostname has no addresses','DNS_FAILED');
  return checkedTarget(url,host,addresses.map(address=>address.address),allowLocal);
}
export interface FetchResult { status:number; headers:Record<string,string|string[]>; body:Buffer; finalUrl:string; truncated:boolean }
export async function safeFetch(raw:string, opts:{allowLocal?:boolean;maxBytes?:number;timeoutMs?:number;method?:string;headers?:Record<string,string>;body?:string|Uint8Array;followRedirects?:boolean;signal?:AbortSignal;addresses?:string[]}={}):Promise<FetchResult> {
  const maxBytes=opts.maxBytes??2_000_000,timeoutMs=opts.timeoutMs??20000;
  if(!Number.isFinite(maxBytes)||maxBytes<0) throw new SecurityError('maxBytes must be finite and non-negative','INVALID_LIMIT');
  if(!Number.isFinite(timeoutMs)||timeoutMs<0) throw new SecurityError('timeoutMs must be finite and non-negative','INVALID_LIMIT');
  const deadline=performance.now()+timeoutMs;
  const controller=new AbortController();
  const externalSignal=opts.signal;
  const onExternalAbort=()=>controller.abort(externalSignal?.reason);
  if(externalSignal?.aborted) onExternalAbort();
  else externalSignal?.addEventListener('abort',onExternalAbort,{once:true});
  const timer=setTimeout(()=>controller.abort(new SecurityError('Request timeout','TIMEOUT')),timeoutMs);
  const remaining=()=>Math.max(0,deadline-performance.now());
  const ensureTime=()=>{if(remaining()<=0) throw new SecurityError('Request timeout','TIMEOUT');};
  try {
    if(controller.signal.aborted) throw abortError(controller.signal);
    ensureTime();
    let current=opts.addresses===undefined
      ?await validateTarget(raw,opts.allowLocal??false,controller.signal)
      :approvedTarget(raw,opts.addresses,opts.allowLocal??false,controller.signal);
    const initialHost=current.url.hostname.replace(/^\[|\]$/g,'').toLowerCase();
    const redirectAllowLocal=(opts.allowLocal??false)&&isLoopbackHost(initialHost);
    for(let redirects=0;redirects<5;redirects++) {
      ensureTime();
      const result=await requestPinned(current,{...opts,timeoutMs:remaining(),signal:controller.signal},maxBytes);
      const location=result.headers.location;
      if([301,302,303,307,308].includes(result.status)&&typeof location==='string') {
        if(opts.followRedirects===false) throw new SecurityError('Redirects are not allowed','REDIRECT_BLOCKED');
        ensureTime();
        const next=new URL(location,current.url);
        if(opts.addresses!==undefined) {
          if(next.origin!==current.url.origin) throw new SecurityError('Cross-origin redirects are not allowed when addresses are pinned','REDIRECT_BLOCKED');
          current=approvedTarget(next.toString(),current.addresses,redirectAllowLocal,controller.signal);
        } else current=await validateTarget(next.toString(),redirectAllowLocal,controller.signal);
        continue;
      }
      return {...result,finalUrl:current.url.toString()};
    }
    throw new SecurityError('Too many redirects','REDIRECT_LIMIT');
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort',onExternalAbort);
  }
}
function requestPinned(target:SafeTarget,opts:{timeoutMs?:number;method?:string;headers?:Record<string,string>;body?:string|Uint8Array;signal?:AbortSignal},maxBytes:number):Promise<Omit<FetchResult,'finalUrl'>> {
  return new Promise((resolve,reject)=>{
    if(opts.signal?.aborted) { reject(abortError(opts.signal)); return; }
    const transport=target.url.protocol==='https:'?https:http;
    const body=opts.body===undefined?undefined:Buffer.from(opts.body);
    const headers:Record<string,string>={'user-agent':'ReverseEverything/0.0.1 (authorized local analysis)',...opts.headers};
    if(body!==undefined&&!Object.keys(headers).some(name=>name.toLowerCase()==='content-length'))headers['content-length']=String(body.byteLength);
    let settled=false;
    let response:http.IncomingMessage|undefined;
    const chunks:Buffer[]=[]; let size=0;
    const cleanupRequest=()=>req.removeListener('error',onError);
    const cleanupResponse=()=>{
      response?.removeListener('error',onError);
      response?.removeListener('aborted',onAborted);
    };
    const cleanup=()=>{
      opts.signal?.removeEventListener('abort',onAbort);
      req.setTimeout(0);
      req.once('close',cleanupRequest);
      response?.removeListener('data',onData);
      response?.removeListener('end',onEnd);
      response?.once('close',cleanupResponse);
    };
    const fail=(error:unknown)=>{
      if(settled) return;
      settled=true;
      cleanup();
      response?.destroy();
      req.destroy();
      reject(error);
    };
    const complete=(truncated:boolean)=>{
      if(settled) return;
      settled=true;
      const headers:Record<string,string|string[]>={};
      for(const [name,value] of Object.entries(response?.headers??{})) if(value!==undefined) headers[name]=value;
      const body=Buffer.concat(chunks);
      cleanup();
      if(truncated) { response?.destroy(); req.destroy(); }
      resolve({status:response?.statusCode??0,headers,body,truncated});
    };
    const req=transport.request(target.url,{method:opts.method??'GET',headers,lookup:(_host,_options,callback)=>{ const addresses=target.addresses.map(address=>({address,family:address.includes(':')?6:4})); callback(null,addresses); }},res=>{
      response=res;
      if(settled) { res.destroy(); return; }
      res.on('data',onData);
      res.on('end',()=>complete(false));
      res.on('error',onError);
      res.on('aborted',onAborted);
      if(maxBytes<=0) complete(true);
    });
    function onData(chunk:Buffer){
      if(settled) return;
      const remaining=maxBytes-size;
      if(chunk.length<remaining) { chunks.push(chunk); size+=chunk.length; return; }
      if(remaining>0) chunks.push(chunk.subarray(0,remaining));
      complete(true);
    }
    function onEnd(){ complete(false); }
    function onError(error:Error){ fail(error); }
    function onAborted(){ fail(new SecurityError('Response aborted','RESPONSE_ABORTED')); }
    function onAbort(){ fail(abortError(opts.signal!)); }
    req.on('error',onError);
    opts.signal?.addEventListener('abort',onAbort,{once:true});
    req.setTimeout(opts.timeoutMs??20000,()=>fail(new SecurityError('Request timeout','TIMEOUT')));
    req.end(body);
  });
}
export interface ZipEntry { fileName:string; uncompressedSize:number; compressedSize:number; compressed:boolean }
export async function inspectZip(file:string, limits:{maxEntries?:number;maxTotalBytes?:number;maxRatio?:number}={}):Promise<ZipEntry[]> {
  const maxEntries=limits.maxEntries??10000, maxTotal=limits.maxTotalBytes??500_000_000, maxRatio=limits.maxRatio??200;
  return new Promise((resolve,reject)=>yauzl.open(file,{lazyEntries:true,strictFileNames:true},(err,zip)=>{
    if(err||!zip) return reject(new SecurityError('Invalid or unsupported ZIP archive','INVALID_ZIP'));
    const entries:ZipEntry[]=[]; let total=0;
    zip.on('error',reject);
    zip.on('end',()=>resolve(entries));
    zip.on('entry',entry=>{
      if(/^\/|(^|\/)\\.\.(\/|$)|[\\\\]/.test(entry.fileName)) { zip.close(); return reject(new SecurityError('Unsafe archive path detected','ZIP_PATH')); }
      if(entries.length>=maxEntries||total+entry.uncompressedSize>maxTotal||(entry.compressedSize>0&&entry.uncompressedSize/entry.compressedSize>maxRatio)) { zip.close(); return reject(new SecurityError('Archive exceeds safe expansion limits','ZIP_BOMB')); }
      total+=entry.uncompressedSize;
      if(!entry.fileName.endsWith('/')) entries.push({fileName:entry.fileName,uncompressedSize:entry.uncompressedSize,compressedSize:entry.compressedSize,compressed:entry.compressionMethod!==0});
      zip.readEntry();
    });
    zip.readEntry();
  }));
}
export function detectFormat(name:string, head:Buffer):string {
  if(head.subarray(0,2).equals(Buffer.from([0x4d,0x5a]))) return 'PE executable';
  if(head.subarray(0,4).equals(Buffer.from([0x7f,0x45,0x4c,0x46]))) return 'ELF binary';
  if([0xfeedface,0xfeedfacf,0xcafebabe,0xbebafeca].includes(head.readUInt32BE(0))) return 'Mach-O binary';
  if(head.subarray(0,4).equals(Buffer.from([0x50,0x4b,0x03,0x04]))) return 'ZIP / APK / JAR container';
  if(head.subarray(0,4).toString()==='OggS') return 'Ogg media';
  if(/\.json$/i.test(name)) return 'JSON document';
  if(/\.(js|mjs|cjs|ts)$/i.test(name)) return 'JavaScript / TypeScript source';
  if(/\.(har|pcap|pcapng)$/i.test(name)) return 'capture record';
  return 'unknown / raw data';
}
export async function extractStrings(file:string, limits:{maxBytes?:number;maxStrings?:number;minLength?:number}={}):Promise<{offset:number;encoding:'ascii'|'utf16le';value:string}[]> {
  const maxBytes=limits.maxBytes??8_000_000,maxStrings=limits.maxStrings??5000,minLength=limits.minLength??4;
  const bytes=(await import('node:fs/promises')).readFile;
  const fd=await import('node:fs/promises').then(m=>m.open(file,'r'));
  try {
    const size=Math.min((await fd.stat()).size,maxBytes); const buffer=Buffer.alloc(size); await fd.read(buffer,0,size,0);
    const out:{offset:number;encoding:'ascii'|'utf16le';value:string}[]=[];
    for(const encoding of ['ascii','utf16le'] as const) {
      const pattern=encoding==='ascii'?/[\x20-\x7e]{4,}/g:/[\x20-\x7e]\x00{1}/g;
      const step=encoding==='ascii'?1:2;
      for(let i=0;i<buffer.length;i+=step) {
        if((encoding==='ascii'&&(buffer[i]!<0x20||buffer[i]!>0x7e))||(encoding==='utf16le'&&(buffer[i]!<0x20||buffer[i]!>0x7e))) continue;
        const slice=buffer.subarray(i,Math.min(buffer.length,i+4096)); const match=pattern.exec(slice.toString(encoding==='ascii'?'latin1':'utf16le'));
        if(match&&match[0].replace(/\x00/g,'').length>=minLength) { out.push({offset:i,encoding,value:match[0].replace(/\x00/g,'')}); if(out.length>=maxStrings) return out; }
        pattern.lastIndex=0; i+=Math.max(step,(match?.index??0)+(match?Math.max(0,match[0].length-1)*step:0));
      }
    }
    return out.sort((a,b)=>a.offset-b.offset).slice(0,maxStrings);
  } finally { await fd.close(); void bytes; }
}

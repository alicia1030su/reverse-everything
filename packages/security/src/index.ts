import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import type { LookupAddress } from 'node:dns';
import yauzl from 'yauzl';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFile, writeFile, chmod, mkdir } from 'node:fs/promises';

export function redactSensitive(text:string):string { return text.replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+/gi,'$1[REDACTED]').replace(/((?:api[_-]?key|password|secret|token)\s*[:=]\s*["']?)[A-Za-z0-9._~+\/-]{12,}/gi,'$1[REDACTED]'); }
export function encryptSecret(value:string,keyHex:string):string { const iv=randomBytes(12); const cipher=createCipheriv('aes-256-gcm',Buffer.from(keyHex,'hex'),iv); const data=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]); return `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${data.toString('base64')}`; }
export function decryptSecret(value:string,keyHex:string):string { const [iv,tag,data]=value.split('.'); if(!iv||!tag||!data)return ''; const decipher=createDecipheriv('aes-256-gcm',Buffer.from(keyHex,'hex'),Buffer.from(iv,'base64')); decipher.setAuthTag(Buffer.from(tag,'base64')); return Buffer.concat([decipher.update(Buffer.from(data,'base64')),decipher.final()]).toString('utf8'); }
export async function encryptionKey(dataDir:string):Promise<string> { await mkdir(dataDir,{recursive:true}); const file=`${dataDir}/secret.key`; try{return (await readFile(file,'utf8')).trim();}catch{const key=randomBytes(32).toString('hex');await writeFile(file,key,{mode:0o600});await chmod(file,0o600);return key;} }
export class SecurityError extends Error { constructor(message:string, readonly code:string) { super(message); this.name='SecurityError'; } }
export function isPublicAddress(address:string): boolean {
  const ip=address.toLowerCase().split('%')[0]!;
  if (ip==='::1'||ip==='::'||ip==='::ffff:127.0.0.1'||ip==='::ffff:0.0.0.0') return false;
  if (ip.startsWith('::ffff:')) return isPublicAddress(ip.slice(7));
  const v4=ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if(v4) { const a=Number(v4[1]),b=Number(v4[2]); return !(a===0||a===10||a===127||a>=224||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&b===168)||(a===100&&b>=64&&b<=127)||(a===198&&(b===18||b===19))); }
  if(ip.startsWith('fc')||ip.startsWith('fd')||ip.startsWith('fe8')||ip.startsWith('fe9')||ip.startsWith('fea')||ip.startsWith('feb')) return false;
  return ip.includes(':');
}
export interface SafeTarget { url: URL; addresses: string[] }
export async function validateTarget(raw:string, allowLocal=false): Promise<SafeTarget> {
  let url:URL;
  try { url=new URL(raw); } catch { throw new SecurityError('Invalid URL','INVALID_URL'); }
  if(!['http:','https:'].includes(url.protocol)) throw new SecurityError('Only HTTP and HTTPS targets are allowed','BAD_PROTOCOL');
  if(url.username||url.password) throw new SecurityError('Credentials in URLs are forbidden','URL_CREDENTIALS');
  const host=url.hostname.replace(/^\[|\]$/g,'').toLowerCase();
  if(host==='localhost'||host.endsWith('.localhost')) { if(!allowLocal) throw new SecurityError('Loopback targets require explicit local analysis permission','LOCAL_BLOCKED'); }
  let addresses:LookupAddress[];
  try { addresses=await lookup(host,{all:true,verbatim:true}); } catch { throw new SecurityError('Target hostname could not be resolved','DNS_FAILED'); }
  if(!addresses.length) throw new SecurityError('Target hostname has no addresses','DNS_FAILED');
  if(!allowLocal && addresses.some(a=>!isPublicAddress(a.address))) throw new SecurityError('Private, loopback, link-local or metadata addresses are blocked','SSRF_BLOCKED');
  const allowedPort=url.protocol==='https:'?443:80;
  if(url.port && Number(url.port)!==allowedPort && !allowLocal) throw new SecurityError('Non-standard public ports are blocked','PORT_BLOCKED');
  return {url,addresses:addresses.map(a=>a.address)};
}
export interface FetchResult { status:number; headers:Record<string,string>; body:Buffer; finalUrl:string; truncated:boolean }
export async function safeFetch(raw:string, opts:{allowLocal?:boolean;maxBytes?:number;timeoutMs?:number;method?:string;headers?:Record<string,string>}={}):Promise<FetchResult> {
  const maxBytes=opts.maxBytes??2_000_000;
  let current=await validateTarget(raw,opts.allowLocal??false);
  for(let redirects=0;redirects<5;redirects++) {
    const result=await requestPinned(current,opts,maxBytes);
    if([301,302,303,307,308].includes(result.status)&&result.headers.location) {
      const next=new URL(result.headers.location,current.url).toString();
      current=await validateTarget(next,opts.allowLocal??false); continue;
    }
    return {...result,finalUrl:current.url.toString()};
  }
  throw new SecurityError('Too many redirects','REDIRECT_LIMIT');
}
function requestPinned(target:SafeTarget,opts:{timeoutMs?:number;method?:string;headers?:Record<string,string>},maxBytes:number):Promise<Omit<FetchResult,'finalUrl'>> {
  return new Promise((resolve,reject)=>{
    const transport=target.url.protocol==='https:'?https:http;
    const req=transport.request(target.url,{method:opts.method??'GET',headers:{'user-agent':'ReverseEverything/0.0.1 (authorized local analysis)',...opts.headers},lookup:(_host,_options,callback)=>{ const addresses=target.addresses.map(address=>({address,family:address.includes(':')?6:4})); callback(null,addresses); }},res=>{
      const chunks:Buffer[]=[]; let size=0; let truncated=false;
      res.on('data',(chunk:Buffer)=>{ size+=chunk.length; if(size<=maxBytes) chunks.push(chunk); else truncated=true; });
      res.on('end',()=>resolve({status:res.statusCode??0,headers:res.headers as Record<string,string>,body:Buffer.concat(chunks),truncated}));
      res.on('error',reject);
    });
    req.setTimeout(opts.timeoutMs??20000,()=>req.destroy(new SecurityError('Request timeout','TIMEOUT')));
    req.on('error',reject); req.end();
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

import { createHash } from 'node:crypto';
import { constants, lstat, open, opendir, realpath } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import path from 'node:path';
import type { LegacyAnalysis, LegacyFinding, LegacyFormat, LegacySoftwareProfile } from './types.js';

const MAX_FILES=2_000;
const MAX_TOTAL_BYTES=64*1024*1024;
const MAX_FILE_BYTES=2*1024*1024;
const MAX_DEPTH=8;
const MAX_DIRECTORY_ENTRIES=10_000;
const NO_FOLLOW=constants.O_NOFOLLOW??0;

export interface AnalyzeLegacyOptions { maxFiles?:number; maxBytes?:number; signal?:AbortSignal }
interface Candidate { absolute:string; relative:string; size:number; format:LegacyFormat; head:Buffer; sha256:string; identity:Stats }

function sameIdentity(actual:Stats,expected:Stats):boolean{return actual.dev===expected.dev&&actual.ino===expected.ino;}
function sameFingerprint(actual:Stats,expected:Stats):boolean{return sameIdentity(actual,expected)&&actual.size===expected.size&&actual.mtimeMs===expected.mtimeMs&&actual.ctimeMs===expected.ctimeMs;}
async function verifiedPath(file:string,root:string,expected:Stats,rootIsFile:boolean):Promise<string>{
  const resolved=await realpath(file);if(rootIsFile){if(resolved!==root)throw new Error('分析期间文件被替换');}else{const rel=path.relative(root,resolved);if(rel==='..'||rel.startsWith(`..${path.sep}`)||path.isAbsolute(rel))throw new Error('分析路径越界');}
  if(!sameIdentity(await lstat(resolved),expected))throw new Error('分析期间目录或文件被替换');return resolved;
}
async function hashFile(file:string,expected:Stats,root:string,rootIsFile:boolean,maxBytes=MAX_FILE_BYTES):Promise<{sha256:string;head:Buffer;size:number}>{
  const before=await verifiedPath(file,root,expected,rootIsFile);const handle=await open(before,constants.O_RDONLY|NO_FOLLOW);
  try{
    const opened=await handle.stat();if(!sameFingerprint(opened,expected)||!opened.isFile())throw new Error('分析期间文件被替换');
    await verifiedPath(file,root,expected,rootIsFile);
    const hash=createHash('sha256');const head=Buffer.alloc(Math.min(opened.size,4096));let read=0;
    while(read<head.length){const result=await handle.read(head,read,head.length-read,read);if(!result.bytesRead)break;read+=result.bytesRead;}
    const buffer=Buffer.allocUnsafe(64*1024);let offset=0;
    while(offset<Math.min(opened.size,maxBytes)){const result=await handle.read(buffer,0,Math.min(buffer.length,opened.size,maxBytes)-offset,offset);if(!result.bytesRead)break;hash.update(buffer.subarray(0,result.bytesRead));offset+=result.bytesRead;}
    const after=await handle.stat();if(!sameFingerprint(after,expected))throw new Error('分析期间文件发生变化');
    return {sha256:hash.digest('hex'),head:head.subarray(0,read),size:opened.size};
  }finally{await handle.close();}
}
function detect(name:string,head:Buffer):LegacyFormat{
  if(head.subarray(0,2).toString()==='MZ')return 'PE';
  if(head.subarray(0,4).equals(Buffer.from([0x7f,0x45,0x4c,0x46])))return 'ELF';
  if(head.subarray(0,4).equals(Buffer.from([0xfe,0xed,0xfa,0xce]))||head.subarray(0,4).equals(Buffer.from([0xcf,0xfa,0xed,0xfe])))return 'Mach-O';
  if(head.subarray(0,8).equals(Buffer.from([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1])))return /\.msi$/i.test(name)?'MSI':'Unknown';
  if(head.subarray(0,4).toString()==='PK\u0003\u0004')return /\.jar$/i.test(name)?'JAR':'Unknown';
  if(head.subarray(0,16).toString().startsWith('SQLite format 3'))return 'SQLite';
  const ext=path.extname(name).toLowerCase();
  if(ext==='.dbf')return 'DBF';if(ext==='.csv')return 'CSV';if(ext==='.ini'||ext==='.cfg'||ext==='.conf')return 'INI';if(ext==='.json')return 'JSON';if(ext==='.xml')return 'XML';
  return 'Unknown';
}
function peArchitecture(head:Buffer):string{
  if(head.length<0x40)return 'UNKNOWN';const pe=head.readUInt32LE(0x3c);if(pe+6>head.length)return 'UNKNOWN';const machine=head.readUInt16LE(pe+4);return machine===0x8664?'x86_64':machine===0x14c?'x86':machine===0xaa64?'ARM64':`machine-0x${machine.toString(16)}`;
}
function findings(formats:LegacyFormat[],architecture:string,runtimes:string[],dependencies:string[],files:Candidate[]):LegacyFinding[]{
  const result:LegacyFinding[]=[];
  if(architecture==='x86')result.push({id:'arch-32',severity:'medium',title:'32 位程序',detail:'目标为 x86，现代 64 位 Windows 可能缺少 WoW64 兼容层',recommendation:'确认系统支持 32 位应用；不要安装来源不明的 DLL',evidenceStatus:'EVIDENCE'});
  if(formats.includes('PE')&&architecture==='UNKNOWN')result.push({id:'pe-unknown',severity:'info',title:'PE 架构未识别',detail:'文件头不足以确定 CPU 架构',recommendation:'提供完整合法样本后再判断',evidenceStatus:'UNKNOWN'});
  if(runtimes.includes('.NET'))result.push({id:'dotnet',severity:'medium',title:'检测到 .NET 依赖线索',detail:'程序集可能依赖特定 .NET Framework 或 .NET Runtime',recommendation:'使用微软官方运行时；先核对程序集目标框架',evidenceStatus:'INFERENCE'});
  if(runtimes.includes('Java'))result.push({id:'java',severity:'medium',title:'检测到 Java 依赖线索',detail:'JAR 或 Java 配置需要兼容的 JRE',recommendation:'使用 Adoptium/Eclipse Temurin 等官方 JRE',evidenceStatus:'INFERENCE'});
  if(runtimes.includes('Electron'))result.push({id:'electron',severity:'low',title:'检测到 Electron 应用',detail:'应用自带 Chromium 与 Node，体积较大且依赖较旧',recommendation:'优先官方更新；独立重建时只复用功能规格，不复制专有代码',evidenceStatus:'INFERENCE'});
  if(runtimes.includes('Python'))result.push({id:'python',severity:'low',title:'检测到 Python 打包或脚本线索',detail:'可能需要旧版 Python 或专用打包运行时',recommendation:'核对官方 Python 版本与依赖许可证',evidenceStatus:'INFERENCE'});
  if(dependencies.includes('MSVCRT')||dependencies.includes('VCRUNTIME'))result.push({id:'vc-runtime',severity:'medium',title:'检测到 Visual C++ 运行库线索',detail:'导入名称包含 MSVCRT/VCRUNTIME',recommendation:'从微软官方下载对应架构运行库',evidenceStatus:'INFERENCE'});
  if(files.some(file=>/\.(dll|ocx)$/i.test(file.relative)))result.push({id:'local-dll',severity:'info',title:'目录包含本地 DLL/OCX',detail:'程序可能依赖同目录组件',recommendation:'保留原目录结构，只从合法安装介质恢复缺失组件',evidenceStatus:'EVIDENCE'});
  return result;
}

export async function analyzeLegacySoftware(input:string,options:AnalyzeLegacyOptions={}):Promise<LegacyAnalysis>{
  if(!path.isAbsolute(input))throw new Error('软件路径必须是本机绝对路径');
  const original=await lstat(input);if(original.isSymbolicLink())throw new Error('拒绝符号链接、junction 或特殊文件');
  const root=await realpath(input);const info=await lstat(root);if(info.dev!==original.dev||info.ino!==original.ino||(!info.isFile()&&!info.isDirectory()))throw new Error('拒绝符号链接、junction 或特殊文件');
  const maxFiles=options.maxFiles??MAX_FILES,maxBytes=options.maxBytes??MAX_TOTAL_BYTES;
  if(!Number.isSafeInteger(maxFiles)||maxFiles<1||!Number.isSafeInteger(maxBytes)||maxBytes<1)throw new Error('分析上限无效');
  const candidates:Candidate[]=[];let total=info.size;const rootIsFile=info.isFile();let truncated=false,directoryEntries=0;
  async function walk(dir:string,expected:Stats,depth:number):Promise<void>{
    if(depth>MAX_DEPTH){truncated=true;return;}options.signal?.throwIfAborted();const resolved=await verifiedPath(dir,root,expected,false);const entries=await opendir(resolved,{bufferSize:32});
    if(!sameFingerprint(await lstat(resolved),expected)||await realpath(resolved)!==resolved){await entries.close();throw new Error('分析期间目录被替换');}
    for await(const entry of entries){options.signal?.throwIfAborted();if(++directoryEntries>MAX_DIRECTORY_ENTRIES){truncated=true;return;}if(candidates.length>=maxFiles||total>maxBytes){truncated=true;return;}const absolute=path.join(resolved,entry.name);const stat=await lstat(absolute);if(stat.isSymbolicLink()||(!stat.isFile()&&!stat.isDirectory())){truncated=true;continue;}if(stat.isDirectory()){await walk(absolute,stat,depth+1);if(truncated&&directoryEntries>MAX_DIRECTORY_ENTRIES)return;continue;}total+=stat.size;if(total>maxBytes||stat.size>MAX_FILE_BYTES){truncated=true;continue;}const hashed=await hashFile(absolute,stat,root,false);candidates.push({absolute,relative:path.relative(root,absolute).split(path.sep).join('/'),size:stat.size,format:detect(entry.name,hashed.head),head:hashed.head,sha256:hashed.sha256,identity:stat});}
  }
  if(info.isDirectory())await walk(root,info,0);else if(info.size<=MAX_FILE_BYTES){const hashed=await hashFile(root,info,root,true);candidates.push({absolute:root,relative:path.basename(root),size:info.size,format:detect(root,hashed.head),head:hashed.head,sha256:hashed.sha256,identity:info});}else truncated=true;
  const formats=[...new Set(candidates.map(file=>file.format))];
  const runtimes=new Set<string>(),dependencies=new Set<string>();let name=path.basename(root),version='UNKNOWN',vendor='UNKNOWN';
  for(const file of candidates){
    if(file.format==='PE'){
      if(peArchitecture(file.head)==='x86')dependencies.add('MSVCRT');
      if(file.head.includes(Buffer.from('mscoree.dll')))runtimes.add('.NET');
      if(/python|pyinstaller|nuitka/i.test(file.head.toString('latin1')))runtimes.add('Python');
    }
    if(file.format==='JAR')runtimes.add('Java');
    if(file.relative==='package.json'&&file.size<=MAX_FILE_BYTES){try{const pkg=JSON.parse(await readSmall(file.absolute,file.identity,root,rootIsFile)) as {name?:string;version?:string;author?:string|{name?:string};dependencies?:Record<string,string>;devDependencies?:Record<string,string>};name=pkg.name??name;version=pkg.version??version;vendor=typeof pkg.author==='string'?pkg.author:pkg.author?.name??vendor;if(pkg.dependencies?.electron||pkg.devDependencies?.electron)runtimes.add('Electron');}catch{/* metadata remains unknown */}}
    if(/\.py$/i.test(file.relative))runtimes.add('Python');
  }
  const architecture=candidates.find(file=>file.format==='PE')?peArchitecture(candidates.find(file=>file.format==='PE')!.head):formats.includes('ELF')?'UNKNOWN':'UNKNOWN';
  const dataFormats=formats.filter(format=>['SQLite','CSV','DBF','INI','JSON','XML'].includes(format));
  const profile:LegacySoftwareProfile={name,version,vendor,sourcePath:root,sha256:createHash('sha256').update(candidates.map(file=>`${file.relative}:${file.sha256}`).join('\n')).digest('hex'),sizeBytes:total,formats,architecture,targetOs:formats.includes('PE')?'Windows (inferred)':formats.includes('ELF')?'Linux (inferred)':'UNKNOWN',runtimes:[...runtimes],dependencies:[...dependencies],files:candidates.map(file=>({path:file.relative,size:file.size,sha256:file.sha256})),compatibility:findings(formats,architecture,[...runtimes],[...dependencies],candidates),license:{status:'UNKNOWN',name:'UNKNOWN',source:'用户未提供可核验许可证',notes:['不推断商业软件授权；仅记录用户声明或公开许可证文件']},dataFormats,limitations:['只读静态识别，不执行目标程序','导入名称和字符串只是线索，不能证明实际运行时行为','未集成 Wine/DOSBox/虚拟机，不会自动安装外部依赖',...(truncated?['扫描达到文件数、字节数、目录条目数、深度或单文件上限；结果不完整']:[])],evidenceStatus:candidates.length?(truncated?'INFERENCE':'EVIDENCE'):'UNKNOWN',truncated};
  return {profile,privacy:{localOnly:true,remoteAiUsed:false,networkRequired:[],externalTools:[],remoteAiNote:'静态分析器本身不调用远程 AI；共享任务引擎可能在显式项目授权后调用远程 AI'},summary:`识别 ${formats.join(', ')||'UNKNOWN'}；${profile.compatibility.length} 项兼容性线索；${dataFormats.length} 类可恢复数据格式`};
}
async function readSmall(file:string,expected:Stats,root:string,rootIsFile:boolean):Promise<string>{const before=await verifiedPath(file,root,expected,rootIsFile);const handle=await open(before,constants.O_RDONLY|NO_FOLLOW);try{const opened=await handle.stat();if(!sameFingerprint(opened,expected))throw new Error('分析期间文件被替换');const buffer=Buffer.alloc(MAX_FILE_BYTES);const {bytesRead}=await handle.read(buffer,0,buffer.length,0);const after=await handle.stat();if(!sameFingerprint(after,expected))throw new Error('分析期间文件被替换');return buffer.subarray(0,bytesRead).toString('utf8');}finally{await handle.close();}}

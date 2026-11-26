import { createHash } from 'node:crypto';
import { constants, lstat, mkdir, open, readdir, realpath, rm } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import type { LegacyFormat, LegacyRecoveryResult } from './types.js';

const MAX_SOURCE_BYTES=128*1024*1024;
const DEFAULT_MAX_RECORDS=50_000;
const DEFAULT_MAX_BYTES=32*1024*1024;
const MAX_FIELDS=256;
const MAX_CELL_BYTES=64*1024;
const NO_FOLLOW=constants.O_NOFOLLOW??0;
export interface RecoverLegacyOptions { outputDir:string; maxRecords?:number; maxBytes?:number; signal?:AbortSignal }
interface SourceFile { file:string; sha256:string; size:number; identity:Stats }
interface Recovered { format:LegacyFormat; records:Array<Record<string,unknown>>; fields:string[]; limitations:string[]; truncated:boolean }
interface RecoveryLimits { maxRecords:number; maxBytes:number; signal?:AbortSignal }

function sameIdentity(actual:Stats,expected:Stats):boolean{return actual.dev===expected.dev&&actual.ino===expected.ino;}
function sameFingerprint(actual:Stats,expected:Stats):boolean{return sameIdentity(actual,expected)&&actual.size===expected.size&&actual.mtimeMs===expected.mtimeMs&&actual.ctimeMs===expected.ctimeMs;}
async function sourceFile(input:string,maxBytes:number):Promise<SourceFile>{
  const original=await lstat(input);if(original.isSymbolicLink())throw new Error('恢复来源必须是普通文件');
  const file=await realpath(input);const info=await lstat(file);if(!sameIdentity(info,original)||!info.isFile())throw new Error('恢复来源必须是普通文件');if(info.size>maxBytes||info.size>MAX_SOURCE_BYTES)throw new Error(`来源超过 ${Math.min(maxBytes,MAX_SOURCE_BYTES)} 字节恢复上限`);
  const handle=await open(file,constants.O_RDONLY|NO_FOLLOW);
  try{
    const opened=await handle.stat();if(!sameFingerprint(opened,info))throw new Error('恢复来源在打开前被替换');
    const hash=createHash('sha256');const buffer=Buffer.allocUnsafe(64*1024);let offset=0;
    while(offset<info.size){const {bytesRead}=await handle.read(buffer,0,Math.min(buffer.length,info.size-offset),offset);if(!bytesRead)break;hash.update(buffer.subarray(0,bytesRead));offset+=bytesRead;}
    const after=await handle.stat();if(!sameFingerprint(after,info)||offset!==info.size)throw new Error('恢复来源在哈希期间发生变化');
    return{file,sha256:hash.digest('hex'),size:info.size,identity:info};
  }finally{await handle.close();}
}
async function readBounded(source:SourceFile,maxBytes:number,signal?:AbortSignal):Promise<Buffer>{
  const handle=await open(source.file,constants.O_RDONLY|NO_FOLLOW);
  try{
    const opened=await handle.stat();if(!sameFingerprint(opened,source.identity))throw new Error('恢复来源在读取前被替换');
    const buffer=Buffer.alloc(Math.min(source.size,maxBytes));let offset=0;
    while(offset<buffer.length){signal?.throwIfAborted();const {bytesRead}=await handle.read(buffer,offset,buffer.length-offset,offset);if(!bytesRead)break;offset+=bytesRead;}
    const after=await handle.stat();if(!sameFingerprint(after,source.identity)||offset>maxBytes)throw new Error('恢复来源在读取期间发生变化或超过上限');
    return buffer.subarray(0,offset);
  }finally{await handle.close();}
}
function cellText(value:unknown):string{return typeof value==='string'?value:value===null||value===undefined?'':JSON.stringify(value);}
function utf8ByteLength(text:string):number{let bytes=0;for(const char of text)bytes+=Buffer.byteLength(char);return bytes;}
function validateRecord(record:Record<string,unknown>):void{
  const keys=Object.keys(record);if(keys.length>MAX_FIELDS)throw new Error(`记录字段超过 ${MAX_FIELDS} 上限`);
  for(const key of keys){if(Buffer.byteLength(key)>MAX_CELL_BYTES||Buffer.byteLength(cellText(record[key]))>MAX_CELL_BYTES)throw new Error(`记录单元格超过 ${MAX_CELL_BYTES} 字节上限`);}
}
function parseCsv(text:string,limits:RecoveryLimits):{records:Array<Record<string,unknown>>;fields:string[];limitations:string[];truncated:boolean}{
  const rows:string[][]=[];let row:string[]=[],field='',cellBytes=0,quoted=false,truncated=false;
  const append=(char:string):void=>{field+=char;cellBytes+=Buffer.byteLength(char);if(cellBytes>MAX_CELL_BYTES)throw new Error(`CSV 单元格超过 ${MAX_CELL_BYTES} 字节上限`);};
  const pushRow=():boolean=>{row.push(field);if(row.some(value=>value!=='')){if(rows.length>limits.maxRecords){truncated=true;return false;}rows.push(row);}row=[];field='';cellBytes=0;return true;};
  for(let index=0;index<text.length;index++){
    limits.signal?.throwIfAborted();const codePoint=text.codePointAt(index)!;const char=String.fromCodePoint(codePoint);if(codePoint>0xffff)index++;
    if(quoted){if(char==='"'){if(text[index+1]==='"'){append('"');index++;}else quoted=false;}else append(char);}
    else if(char==='"'&&field==='')quoted=true;else if(char===','){row.push(field);field='';cellBytes=0;if(row.length>MAX_FIELDS)throw new Error(`CSV 列数超过 ${MAX_FIELDS} 上限`);}
    else if(char==='\n'||char==='\r'){if(char==='\r'&&text[index+1]==='\n')index++;if(!pushRow())break;}
    else append(char);
  }
  if(quoted)throw new Error('CSV 引号未闭合');if(!truncated)pushRow();
  const fields=(rows.shift()??[]).map((value,index)=>value||`column_${index+1}`);if(fields.length>MAX_FIELDS)throw new Error(`CSV 列数超过 ${MAX_FIELDS} 上限`);if(new Set(fields).size!==fields.length)throw new Error('CSV 列名重复');
  const records=rows.map(values=>Object.fromEntries(fields.map((key,index)=>[key,values[index]??''])));for(const record of records)validateRecord(record);
  return{records,fields,limitations:['CSV 使用有界 UTF-8 解析；不猜测编码或公式执行',...(truncated?['记录数达到上限，导出为有界预览而非完整恢复']:[])],truncated};
}
function parseDbf(buffer:Buffer,limits:RecoveryLimits):{records:Array<Record<string,unknown>>;fields:string[];limitations:string[];truncated:boolean}{
  if(buffer.length<33||buffer.readUInt32LE(4)===0)throw new Error('DBF 头无效');const count=buffer.readUInt32LE(4),headerLength=buffer.readUInt16LE(8),recordLength=buffer.readUInt16LE(10);
  if(count>MAX_SOURCE_BYTES||headerLength<33||headerLength>buffer.length||recordLength<1||count*recordLength>buffer.length-headerLength)throw new Error('DBF 结构超过安全上限或记录被截断');
  const fields:string[]=[];const descriptors:Array<{name:string;offset:number;length:number;type:string}>=[];let fieldOffset=1;
  for(let cursor=32;cursor+32<=headerLength&&buffer[cursor]!==0x0d;cursor+=32){const name=buffer.subarray(cursor,cursor+11).toString('latin1').replace(/\0.*$/,'').trim();if(!name)break;const length=buffer.readUInt8(cursor+16),type=String.fromCharCode(buffer.readUInt8(cursor+11));if(!length||fieldOffset+length>recordLength)throw new Error('DBF 字段描述符无效');if(fields.length>=MAX_FIELDS)throw new Error(`DBF 字段超过 ${MAX_FIELDS} 上限`);fields.push(name);descriptors.push({name,offset:fieldOffset,length,type});fieldOffset+=length;}
  if(!descriptors.length)throw new Error('DBF 缺少字段描述符');
  const records:Array<Record<string,unknown>>=[];let truncated=false;
  for(let index=0;index<count;index++){limits.signal?.throwIfAborted();if(records.length>=limits.maxRecords){truncated=true;break;}const start=headerLength+index*recordLength;if(buffer[start]===0x2a)continue;const record:Record<string,unknown>={};for(const descriptor of descriptors){const raw=buffer.subarray(start+descriptor.offset,start+descriptor.offset+descriptor.length).toString('latin1').trim();if(descriptor.type==='N'||descriptor.type==='F'){const value=Number(raw);record[descriptor.name]=raw===''?null:Number.isFinite(value)?value:raw;}else if(descriptor.type==='L')record[descriptor.name]=raw==='T'||raw==='Y';else record[descriptor.name]=raw;}validateRecord(record);records.push(record);}
  return{records,fields,limitations:['DBF 记录按字段描述符读取；备注文件与索引未自动恢复','字符编码按 Latin-1 保守解码，原始字节保留在来源文件中',...(truncated?['记录数达到上限，导出为有界预览而非完整恢复']:[])],truncated};
}
function xmlTagEnd(text:string,start:number):number{
  let quote='';
  for(let index=start;index<text.length;index++){
    const char=text[index]!;
    if(quote){if(char===quote)quote='';continue;}
    if(char==='"'||char==="'"){quote=char;continue;}
    if(char==='>')return index;
  }
  return -1;
}
function parseXml(text:string,limits:RecoveryLimits):{records:Array<Record<string,unknown>>;fields:string[];limitations:string[];truncated:boolean}{
  if(/<!DOCTYPE|<!ENTITY/i.test(text))throw new Error('拒绝 DTD 与实体声明');
  const records:Array<Record<string,unknown>>=[];const stack:Array<{name:string;attributes:string;text:string;bytes:number}>=[];
  let cursor=0,truncated=false,operations=0;
  const appendText=(value:string):void=>{const current=stack[stack.length-1];if(!current)return;current.text+=value;current.bytes+=utf8ByteLength(value);if(current.bytes>MAX_CELL_BYTES)throw new Error(`XML 单元格超过 ${MAX_CELL_BYTES} 字节上限`);};
  while(cursor<text.length){
    if((operations++&1023)===0)limits.signal?.throwIfAborted();
    const open=text.indexOf('<',cursor);if(open<0){appendText(text.slice(cursor));break;}
    if(open>cursor)appendText(text.slice(cursor,open));
    if(text.startsWith('<!--',open)){const end=text.indexOf('-->',open+4);if(end<0)throw new Error('XML 注释未闭合');cursor=end+3;continue;}
    if(text.startsWith('<![CDATA[',open)){const end=text.indexOf(']]>',open+9);if(end<0)throw new Error('XML CDATA 未闭合');appendText(text.slice(open+9,end));cursor=end+3;continue;}
    if(text.startsWith('<?',open)){const end=text.indexOf('?>',open+2);if(end<0)throw new Error('XML 处理指令未闭合');cursor=end+2;continue;}
    if(text.startsWith('</',open)){
      const end=xmlTagEnd(text,open+2);if(end<0)throw new Error('XML 结束标签未闭合');
      const name=text.slice(open+2,end).trim();const current=stack.pop();
      if(!current||current.name!==name)throw new Error('XML 标签不匹配');
      const record={element:current.name,attributes:current.attributes,text:current.text.trim()};validateRecord(record);records.push(record);
      if(records.length>=limits.maxRecords){truncated=true;break;}
      cursor=end+1;continue;
    }
    const end=xmlTagEnd(text,open+1);if(end<0)throw new Error('XML 开始标签未闭合');
    const inside=text.slice(open+1,end).trim();const selfClosing=inside.endsWith('/');const body=selfClosing?inside.slice(0,-1).trim():inside;
    const match=/^([A-Za-z_][\w:.-]*)/.exec(body);if(!match)throw new Error('XML 元素名无效');
    const name=match[1]!;const attributes=body.slice(name.length).trim();
    if(stack.length>=64)throw new Error('XML 嵌套深度超过 64 层');
    if(selfClosing){const record={element:name,attributes,text:''};validateRecord(record);records.push(record);if(records.length>=limits.maxRecords){truncated=true;break;}}
    else stack.push({name,attributes,text:'',bytes:0});
    cursor=end+1;
  }
  if(stack.length&&!truncated)throw new Error('XML 标签未闭合');
  return{records,fields:['element','attributes','text'],limitations:['仅提取有界元素直接文本；不解析 DTD 或外部实体',...(truncated?['记录数达到上限，导出为有界预览而非完整恢复']:[])],truncated};
}
async function recover(input:string,source:SourceFile,limits:RecoveryLimits):Promise<Recovered>{
  const ext=path.extname(input).toLowerCase();
  if(ext==='.sqlite'||source.size>=16&&(await readBounded(source,16,limits.signal)).subarray(0,16).toString().startsWith('SQLite format 3')){
    const wal=`${source.file}-wal`;const walInfo=await lstat(wal).catch(()=>undefined);if(walInfo&&walInfo.size>0)throw new Error('SQLite WAL 包含未检查点数据；请先 checkpoint 后再恢复');
    const db=new DatabaseSync(source.file,{readOnly:true});
    try{
      const tableCount=Number((db.prepare("SELECT COUNT(*) count FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get() as {count:number}).count);const tableLimit=100;const tableTruncated=tableCount>tableLimit;const tables=(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name LIMIT ?").all(tableLimit) as {name:string}[]).map(row=>row.name);const records:Array<Record<string,unknown>>=[];const fields=new Set<string>();let truncated=tableTruncated;
      for(const table of tables){if(records.length>=limits.maxRecords){truncated=true;break;}const quoted=`"${table.replace(/"/g,'""')}"`;const remaining=limits.maxRecords-records.length;const rows=db.prepare(`SELECT * FROM ${quoted} LIMIT ${remaining}`).all() as Array<Record<string,unknown>>;for(const row of rows){validateRecord(row);records.push({_table:table,...row});Object.keys(row).forEach(key=>fields.add(key));if(fields.size>MAX_FIELDS)throw new Error(`SQLite 字段超过 ${MAX_FIELDS} 上限`);}if(rows.length===remaining)truncated=true;limits.signal?.throwIfAborted();}
      if(fields.has('_table'))fields.delete('_table');return{format:'SQLite',records,fields:[...fields],limitations:[`只读打开 ${tables.length} 张表；不修复或覆盖来源数据库`,`全局行数上限 ${limits.maxRecords}；视图、触发器和权限未恢复`,...(tableTruncated?[`检测到 ${tableCount} 张表，超过 ${tableLimit} 张表扫描上限；仅恢复前 ${tableLimit} 张表`]:[]),...(truncated&&!tableTruncated?['记录数达到上限，导出为有界预览而非完整恢复']:[])],truncated};
    }finally{db.close();}
  }
  const buffer=await readBounded(source,limits.maxBytes,limits.signal);const text=buffer.toString('utf8');
  if(ext==='.csv')return{format:'CSV',...parseCsv(text,limits)};
  if(ext==='.dbf')return{format:'DBF',...parseDbf(buffer,limits)};
  if(ext==='.json'){
    const value=JSON.parse(text) as unknown;const candidates=Array.isArray(value)?value as unknown[]:[value];if(candidates.some(item=>!item||typeof item!=='object'||Array.isArray(item)))throw new Error('JSON 记录必须是对象');const truncated=candidates.length>limits.maxRecords;const records=(candidates.slice(0,limits.maxRecords) as Array<Record<string,unknown>>);for(const record of records)validateRecord(record);return{format:'JSON',records,fields:[...new Set(records.flatMap(record=>Object.keys(record)))].slice(0,MAX_FIELDS),limitations:['JSON 结构保留；不执行脚本或公式',...(truncated?['记录数达到上限，导出为有界预览而非完整恢复']:[])],truncated};
  }
  if(ext==='.ini'||ext==='.cfg'||ext==='.conf'){
    const records:Array<Record<string,unknown>>=[];let section='default',truncated=false;for(const line of text.split(/\r?\n/)){limits.signal?.throwIfAborted();if(records.length>=limits.maxRecords){truncated=true;break;}const trimmed=line.trim();if(!trimmed||trimmed.startsWith(';')||trimmed.startsWith('#'))continue;if(trimmed.startsWith('[')&&trimmed.endsWith(']')){section=trimmed.slice(1,-1);continue;}const index=trimmed.indexOf('=');if(index<1)continue;const record={section,key:trimmed.slice(0,index).trim(),value:trimmed.slice(index+1).trim()};validateRecord(record);records.push(record);}return{format:'INI',records,fields:['section','key','value'],limitations:['仅解析 key=value；不展开环境变量或执行配置',...(truncated?['记录数达到上限，导出为有界预览而非完整恢复']:[])],truncated};
  }
  if(ext==='.xml')return{format:'XML',...parseXml(text,limits)};
  throw new Error('不支持的数据格式；保持 UNKNOWN');
}
function csvValue(value:unknown):string{
  let text=cellText(value);if(/^[\s]*[=+\-@\t\r]/.test(text))text="'"+text;return /[",\r\n]/.test(text)?`"${text.replace(/"/g,'""')}"`:text;
}
async function writeNewFile(destination:string,content:string):Promise<void>{const handle=await open(destination,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|NO_FOLLOW,0o600);try{await handle.writeFile(content,'utf8');}finally{await handle.close();}}

export async function recoverLegacyData(input:string,options:RecoverLegacyOptions):Promise<LegacyRecoveryResult>{
  if(!path.isAbsolute(options.outputDir))throw new Error('输出目录必须是绝对路径');
  const maxRecords=options.maxRecords??DEFAULT_MAX_RECORDS,maxBytes=options.maxBytes??DEFAULT_MAX_BYTES;
  if(!Number.isSafeInteger(maxRecords)||maxRecords<1||maxRecords>DEFAULT_MAX_RECORDS)throw new Error('记录上限无效');if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>MAX_SOURCE_BYTES)throw new Error('字节上限无效');
  const limits:RecoveryLimits={maxRecords,maxBytes,...(options.signal?{signal:options.signal}:{})};const source=await sourceFile(input,maxBytes);const recovered=await recover(input,source,limits);
  const parent=path.dirname(options.outputDir);const outputRoot=await realpath(parent).catch(()=>path.resolve(parent));const outputDir=path.resolve(outputRoot,path.basename(options.outputDir));
  try{await mkdir(outputDir,{recursive:false});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;const info=await lstat(outputDir);if(info.isSymbolicLink()||!info.isDirectory())throw new Error('输出目录必须是普通目录');if((await readdir(outputDir)).length)throw new Error('输出目录必须不存在或为空');}
  const outputInfo=await lstat(outputDir);if(outputInfo.isSymbolicLink()||!outputInfo.isDirectory()||await realpath(outputDir)!==outputDir)throw new Error('输出目录不安全');
  const json=JSON.stringify({format:recovered.format,sourceSha256:source.sha256,truncated:recovered.truncated,records:recovered.records},null,2)+'\n';const csvFields=recovered.fields.length?recovered.fields:['value'];const csv=[csvFields.map(csvValue).join(','),...recovered.records.map(record=>csvFields.map(field=>csvValue(record[field])).join(','))].join('\n')+'\n';
  const files=[{name:'recovered.json',content:json},{name:'recovered.csv',content:csv},{name:'manifest.json',content:JSON.stringify({sourceSha256:source.sha256,format:recovered.format,records:recovered.records.length,truncated:recovered.truncated,fields:recovered.fields,limitations:recovered.limitations},null,2)+'\n'}];const written:string[]=[];
  try{
    for(const file of files){const destination=path.join(outputDir,file.name);await writeNewFile(destination,file.content);written.push(destination);}
    const after=await sourceFile(input,maxBytes);if(after.sha256!==source.sha256||!sameIdentity(after.identity,source.identity))throw new Error('恢复期间来源文件发生变化');
  }catch(error){await Promise.all(written.map(file=>rm(file,{force:true})));throw error;}
  const records=recovered.records;const fileRecords=[];for(const file of files){const content=Buffer.from(file.content);fileRecords.push({name:file.name,size:content.length,sha256:createHash('sha256').update(content).digest('hex')});}
  return{format:recovered.format,sourceSha256:source.sha256,outputDir,records:records.length,fields:recovered.fields,preview:records.slice(0,20),files:fileRecords,integrity:{sourceUnchanged:true,exportSha256:fileRecords[0]!.sha256},limitations:recovered.limitations,evidenceStatus:'VERIFIED',truncated:recovered.truncated};
}

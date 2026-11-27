import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { LegacyGeneratedProject, LegacyReconstructionSpec, LegacySoftwareProfile } from './types.js';

export interface ReconstructionInput { kind:LegacyReconstructionSpec['kind']; name:string; requirements:string[]; profile:LegacySoftwareProfile }
export interface LegacyRequirementAssessment { requirement:string; status:'SUPPORTED'|'UNCOVERED'|'REJECTED'; tests:string[]; note:string }
export type AssessedReconstructionSpec=LegacyReconstructionSpec&{requirementAssessments:LegacyRequirementAssessment[];capabilityMatrix:Array<{kind:LegacyReconstructionSpec['kind'];capability:string;status:'SUPPORTED'|'REJECTED';tests:string[];note:string}>}
const capabilityMatrix:AssessedReconstructionSpec['capabilityMatrix']=[
  {kind:'ini-editor',capability:'读取 section 与 key=value',status:'SUPPORTED',tests:['tests/ini-tool.test.mjs'],note:'注释与空行忽略；不展开环境变量'},
  {kind:'ini-editor',capability:'本地编辑保存与独立复制',status:'SUPPORTED',tests:['tests/ini-tool.test.mjs'],note:'浏览器 localStorage 与 CLI copy；不覆盖来源'},
  {kind:'ini-editor',capability:'二进制 INI、环境变量展开、远程同步',status:'REJECTED',tests:[],note:'超出独立编辑器范围'},
  {kind:'csv-viewer',capability:'本地 CSV 表格预览与行列统计',status:'SUPPORTED',tests:['tests/csv-tool.test.mjs'],note:'基础逗号分隔；不执行公式'},
  {kind:'csv-viewer',capability:'编辑导出、完整 RFC 4180、远程数据库',status:'REJECTED',tests:[],note:'当前仅查看，不代表完整 CSV 标准实现'},
  {kind:'text-tool',capability:'本地文本编辑与独立复制',status:'SUPPORTED',tests:[],note:'仅静态页面和复制 CLI；当前无自动化行为测试，标为未覆盖'},
  {kind:'text-tool',capability:'语法分析、格式转换、协作编辑',status:'REJECTED',tests:[],note:'通用文本工具不实现这些能力'},
  {kind:'data-converter',capability:'JSON 对象数组与 CSV 双向转换',status:'SUPPORTED',tests:['tests/convert.test.mjs'],note:'含引号、换行、CRLF 与公式中和'},
  {kind:'data-converter',capability:'输入、行列、字段与单元格上限',status:'SUPPORTED',tests:['tests/convert.test.mjs'],note:'1MiB、10000 行、256 列、64KiB 单元格'},
  {kind:'data-converter',capability:'XML、数据库、任意格式或无限输入',status:'REJECTED',tests:['tests/convert.test.mjs'],note:'仅 JSON/CSV；超限明确失败'},
];
const requirementPatterns:Record<LegacyReconstructionSpec['kind'],Array<{pattern:RegExp;tests:string[];note:string}>>={
  'ini-editor':[
    {pattern:/ini|section|key\s*=|配置|节|键值/i,tests:['tests/ini-tool.test.mjs'],note:'基础 INI 读取'},
    {pattern:/保存|save|persist|本地编辑/i,tests:[],note:'页面保存存在，但无浏览器自动化测试，标为未覆盖'},
    {pattern:/导出|export|copy|复制|不覆盖/i,tests:['tests/ini-tool.test.mjs'],note:'独立复制且不覆盖来源'},
  ],
  'csv-viewer':[
    {pattern:/csv|表格|预览|view|preview|row|column|行|列/i,tests:['tests/csv-tool.test.mjs'],note:'基础 CSV 查看与统计'},
  ],
  'text-tool':[
    {pattern:/text|文本|复制|copy/i,tests:[],note:'基础文本工具存在，但无自动化行为测试，标为未覆盖'},
  ],
  'data-converter':[
    {pattern:/json\s*(?:to|->|→|转|到)\s*csv|json.*csv/i,tests:['tests/convert.test.mjs'],note:'JSON 到 CSV'},
    {pattern:/csv\s*(?:to|->|→|转|到)\s*json|csv.*json/i,tests:['tests/convert.test.mjs'],note:'CSV 到 JSON'},
    {pattern:/quote|quoted|引号|换行|newline|crlf|公式|formula|上限|limit|bound/i,tests:['tests/convert.test.mjs'],note:'转换边界与公式中和'},
  ],
};
function assessRequirements(kind:LegacyReconstructionSpec['kind'],requirements:string[]):LegacyRequirementAssessment[]{return requirements.map(requirement=>{
  if(/绕过|drm|激活破解|未授权.*(?:源码|资源)|原始服务端|反作弊|无限|unbounded/i.test(requirement))return{requirement,status:'REJECTED',tests:[],note:'违反合法边界或无界要求，生成器不声称支持'};
  const match=requirementPatterns[kind].find(item=>item.pattern.test(requirement));
  if(!match)return{requirement,status:'UNCOVERED',tests:[],note:'没有对应实现与测试映射，不得声称已实现'};
  const hasTests=match.tests.length>0;return{requirement,status:hasTests?'SUPPORTED':'UNCOVERED',tests:match.tests,note:hasTests?match.note:`${match.note}；当前无自动化测试`};
});}
export function createReconstructionSpec(input:ReconstructionInput):AssessedReconstructionSpec{
  if(!input.name.trim()||input.name.length>80||input.requirements.length<1||input.requirements.length>32||input.requirements.some(item=>!item.trim()||item.length>500))throw new Error('独立重建需要 1-80 字名称和 1-32 条有界功能需求');
  if(input.profile.truncated)throw new Error('截断档案不能用于独立重建；恢复工具仍可使用');
  const requirementAssessments=assessRequirements(input.kind,input.requirements.map(item=>item.trim().slice(0,500)));
  const rejected=requirementAssessments.find(item=>item.status==='REJECTED');if(rejected)throw new Error(`重建需求被拒绝：${rejected.requirement}（${rejected.note}）`);
  const uncovered=requirementAssessments.filter(item=>item.status==='UNCOVERED').map(item=>`需求未覆盖或缺少自动化测试：${item.requirement}`);
  return{id:`legacy-${createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0,16)}`,name:input.name.replace(/[^a-zA-Z0-9_-]/g,'-').slice(0,64)||'legacy-tool',kind:input.kind,requirements:input.requirements.map(item=>item.trim().slice(0,500)),sourceProfileSha256:input.profile.sha256,evidenceStatus:'INFERENCE',limitations:['独立实现，不复制原软件源码、资源或品牌标识','功能一致性仅针对用户提供的规格与样本，不代表原软件完整兼容',...uncovered],requirementAssessments,capabilityMatrix:capabilityMatrix.filter(item=>item.kind===input.kind)};
}
const html=(title:string,body:string)=>`<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font:15px system-ui;max-width:960px;margin:32px auto;padding:0 16px;background:#f8fafc;color:#0f172a}textarea,input,button{font:inherit;padding:8px;margin:4px 0}textarea{width:100%;box-sizing:border-box}pre{white-space:pre-wrap;background:#e2e8f0;padding:12px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #cbd5e1;padding:6px;text-align:left}</style><h1>${title}</h1>${body}</html>\n`;
function iniProject(spec:LegacyReconstructionSpec):Map<string,string>{
  const files=new Map<string,string>();
  files.set('web/index.html',html(spec.name,`<p>独立 INI 配置编辑器。数据仅保存在当前浏览器。</p><textarea id="input" rows="16">[general]\nname=example\nenabled=true</textarea><button id="save">保存到本机浏览器</button><button id="export">导出 INI</button><pre id="status"></pre><script>
const input=document.querySelector('#input'),status=document.querySelector('#status');input.value=localStorage.getItem('ini')||input.value;document.querySelector('#save').onclick=()=>{localStorage.setItem('ini',input.value);status.textContent='已保存'};document.querySelector('#export').onclick=()=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([input.value],{type:'text/plain'}));a.download='config.ini';a.click()};
</script>`));
  files.set('bin/ini-tool.mjs',`import {readFile,writeFile} from 'node:fs/promises';
const [command,file]=process.argv.slice(2);
if(command==='read'){const text=await readFile(file,'utf8');const sections={};let section='default';for(const line of text.split(/\\r?\\n/)){const value=line.trim();if(!value||value.startsWith(';')||value.startsWith('#'))continue;if(value.startsWith('[')&&value.endsWith(']')){section=value.slice(1,-1);sections[section]??={};continue;}const index=value.indexOf('=');if(index<1)throw new Error('Invalid INI line');(sections[section]??={})[value.slice(0,index).trim()]=value.slice(index+1).trim()}console.log(JSON.stringify(sections,null,2))}else if(command==='copy'){if(!process.argv[4])throw new Error('Usage: copy <source> <destination>');await writeFile(process.argv[4],await readFile(file),{flag:'wx'});console.log('Independent copy written')}else throw new Error('Commands: read <file> | copy <source> <destination>');
`);
  files.set('tests/ini-tool.test.mjs',`import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {execFile} from 'node:child_process';import {promisify} from 'node:util';const run=promisify(execFile);test('reads and independently copies INI',async()=>{const dir=await mkdtemp(path.join(os.tmpdir(),'ini-tool-'));try{const source=path.join(dir,'source.ini'),dest=path.join(dir,'dest.ini');await writeFile(source,'[general]\\nname=test\\n');const {stdout}=await run(process.execPath,['bin/ini-tool.mjs','read',source]);assert.equal(JSON.parse(stdout).general.name,'test');await run(process.execPath,['bin/ini-tool.mjs','copy',source,dest]);assert.equal(await readFile(dest,'utf8'),'[general]\\nname=test\\n')}finally{await rm(dir,{recursive:true,force:true})}});
`);
  return files;
}
function viewerProject(spec:LegacyReconstructionSpec):Map<string,string>{
  const files=new Map<string,string>();files.set('web/index.html',html(spec.name,`<p>独立 CSV 查看器。选择本地 CSV，数据不会上传。</p><input id="file" type="file" accept=".csv,text/csv"><div id="table"></div><script>document.querySelector('#file').onchange=async event=>{const text=await event.target.files[0].text();const rows=text.trim().split(/\\r?\\n/).map(line=>line.split(','));document.querySelector('#table').innerHTML='<table>'+rows.map((row,index)=>'<tr>'+row.map(cell=>'<'+'td>'+cell.replace(/[&<>]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[char]))+'</td>').join('')+'</tr>').join('')+'</table>'}</script>`));files.set('bin/csv-tool.mjs',`import {readFile} from 'node:fs/promises';const text=await readFile(process.argv[2],'utf8');const rows=text.trim().split(/\\r?\\n/).map(line=>line.split(','));console.log(JSON.stringify({rows:rows.length-1,columns:rows[0]?.length??0,preview:rows.slice(0,20)},null,2));
`);files.set('tests/csv-tool.test.mjs',`import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,writeFile,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {execFile} from 'node:child_process';import {promisify} from 'node:util';const run=promisify(execFile);test('counts CSV rows',async()=>{const dir=await mkdtemp(path.join(os.tmpdir(),'csv-tool-'));try{const file=path.join(dir,'x.csv');await writeFile(file,'a,b\\n1,2\\n');const {stdout}=await run(process.execPath,['bin/csv-tool.mjs',file]);assert.deepEqual(JSON.parse(stdout),{rows:1,columns:2,preview:[['a','b'],['1','2']]})}finally{await rm(dir,{recursive:true,force:true})}});
`);return files;
}
function converterProject(spec:LegacyReconstructionSpec):Map<string,string>{
  const files=new Map<string,string>();
  files.set('converter-core.js',`export const LIMITS=Object.freeze({inputBytes:1024*1024,rows:10000,fields:256,cellBytes:64*1024});
const encoder=new TextEncoder();
function bounded(text){if(encoder.encode(text).length>LIMITS.inputBytes)throw new Error('输入超过 1MiB 上限')}
function cellText(value){const text=typeof value==='string'?value:JSON.stringify(value??'');if(encoder.encode(text).length>LIMITS.cellBytes)throw new Error('单元格超过 64KiB 上限');return text}
function csvCell(value){let text=cellText(value);if(/^[\\s]*[=+\\-@\\t\\r]/.test(text))text="'"+text;return /[",\\r\\n]/.test(text)?'"'+text.replace(/"/g,'""')+'"':text}
export function jsonToCsv(text){bounded(text);const value=JSON.parse(text),rows=Array.isArray(value)?value:[value];if(!rows.length||rows.length>LIMITS.rows||rows.some(row=>!row||typeof row!=='object'||Array.isArray(row)))throw new Error('JSON 必须包含 1-10000 个对象');const fields=[...new Set(rows.flatMap(row=>Object.keys(row)))];if(fields.length>LIMITS.fields)throw new Error('列数超过 256 上限');return [fields.map(csvCell).join(','),...rows.map(row=>fields.map(key=>csvCell(row[key])).join(','))].join('\\n')+'\\n'}
export function csvToJson(text){bounded(text);const rows=[];let row=[],value='',quoted=false,closed=false;
const pushRow=()=>{row.push(value);rows.push(row);if(rows.length>LIMITS.rows)throw new Error('行数超过 10000 上限');row=[];value=''};
for(let index=0;index<text.length;index++){const char=text[index];if(quoted){if(char==='"'){if(text[index+1]==='"'){value+='"';index++;}else{quoted=false;closed=true}}else value+=char;}else if(char==='"'&&value===''&&!closed){quoted=true}else if(char===','){row.push(value);value='';closed=false;if(row.length>LIMITS.fields)throw new Error('列数超过 256 上限')}else if(char==='\\n'||char==='\\r'){if(char==='\\r'&&text[index+1]==='\\n')index++;pushRow();closed=false;continue;}else{if(closed&&!/[ \\t]/.test(char))throw new Error('CSV 结束引号后存在非法字符');value+=char}cellText(value)}
if(quoted)throw new Error('CSV 引号未闭合');if(value||row.length||!rows.length)pushRow();if(rows.length>1&&rows.at(-1).length===1&&rows.at(-1)[0]==='')rows.pop();const fields=rows.shift()??[];if(!fields.length||fields.length>LIMITS.fields||new Set(fields).size!==fields.length)throw new Error('CSV 列名无效或重复');return JSON.stringify(rows.map(values=>Object.fromEntries(fields.map((key,index)=>[key,values[index]??'']))),null,2)+'\\n'}
`);
  files.set('web/index.html',html(spec.name,`<p>独立数据转换工具。选择本地 JSON 或 CSV，数据不会上传。</p><input id="file" type="file" accept=".json,.csv"><pre id="out"></pre><script type="module">import {jsonToCsv,csvToJson} from '/converter-core.js';document.querySelector('#file').onchange=async event=>{const out=document.querySelector('#out');try{const file=event.target.files[0];if(file.size>1024*1024)throw new Error('输入超过 1MiB 上限');const text=await file.text();out.textContent=file.name.toLowerCase().endsWith('.json')?jsonToCsv(text):csvToJson(text)}catch(error){out.textContent='转换失败：'+(error instanceof Error?error.message:String(error))}}</script>`));
  files.set('bin/convert.mjs',`import {readFile,writeFile} from 'node:fs/promises';import {jsonToCsv,csvToJson} from '../converter-core.js';
const [source,destination]=process.argv.slice(2);if(!source||!destination)throw new Error('Usage: convert <source.json|source.csv> <destination.csv|destination.json>');
if(!/\.(json|csv)$/i.test(source))throw new Error('Only JSON and CSV are supported');const text=await readFile(source,'utf8');const output=/\\.json$/i.test(source)?jsonToCsv(text):csvToJson(text);await writeFile(destination,output,{flag:'wx'});
`);
  files.set('tests/convert.test.mjs',`import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {jsonToCsv,csvToJson,LIMITS} from '../converter-core.js';const run=promisify(execFile);test('converts JSON to CSV and CSV to JSON with quoting and formula neutralization',async()=>{const dir=await mkdtemp(path.join(os.tmpdir(),'convert-tool-'));try{const json=path.join(dir,'x.json'),csv=path.join(dir,'x.csv'),roundtrip=path.join(dir,'roundtrip.json');await writeFile(json,JSON.stringify([{name:'=1+1',note:'a,"b"\\n@SUM(A1)'}]));await run(process.execPath,['bin/convert.mjs',json,csv]);const exported=await readFile(csv,'utf8');assert.ok(exported.includes("'=1+1"));assert.ok(exported.includes("a,\\"\\"b\\"\\"\\n@SUM(A1)"));await run(process.execPath,['bin/convert.mjs',csv,roundtrip]);assert.deepEqual(JSON.parse(await readFile(roundtrip,'utf8')),[{name:"'=1+1",note:"a,\\"b\\"\\n@SUM(A1)"}]);assert.equal(csvToJson('a,b\\r\\n"x,y","line1\\nline2"\\r\\n'),JSON.stringify([{a:'x,y',b:'line1\\nline2'}],null,2)+'\\n');assert.throws(()=>csvToJson('a\\n"unclosed'),/引号未闭合/);assert.throws(()=>jsonToCsv(JSON.stringify([{x:'x'.repeat(LIMITS.cellBytes+1)}])),/单元格/)}finally{await rm(dir,{recursive:true,force:true})}});
`);
  return files;
}
export function generateReconstructionProject(spec:LegacyReconstructionSpec):LegacyGeneratedProject{
  const files=spec.kind==='ini-editor'?iniProject(spec):spec.kind==='csv-viewer'?viewerProject(spec):spec.kind==='data-converter'?converterProject(spec):new Map([['web/index.html',html(spec.name,'<p>独立文本工具</p><textarea id="t" rows="12"></textarea><script>document.querySelector("#t").value=localStorage.getItem("text")||"";document.querySelector("#t").oninput=e=>localStorage.setItem("text",e.target.value)</script>')],['bin/text-tool.mjs',`import {readFile,writeFile} from 'node:fs/promises';const [source,dest]=process.argv.slice(2);if(!source||!dest)throw new Error('Usage: text-tool <source> <destination>');await writeFile(dest,await readFile(source),{flag:'wx'});
`]]);
  files.set('package.json',JSON.stringify({name:spec.name,version:'1.0.0',private:true,type:'module',scripts:{test:'node --test',start:'node server.mjs'}},null,2)+'\n');
  files.set('server.mjs',`import {createServer} from 'node:http';import {readFile} from 'node:fs/promises';const port=Number(process.env.PORT??4173);createServer(async(req,res)=>{try{const file=req.url==='/'?'web/index.html':req.url.slice(1);if(!/^(?:web\\/[a-z0-9.-]+|converter-core\\.js)$/.test(file)){res.writeHead(404);res.end();return}const body=await readFile(file);res.setHeader('content-type',file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.js')?'text/javascript; charset=utf-8':'text/plain');res.end(body)}catch{res.writeHead(404);res.end()}}).listen(port,'127.0.0.1',()=>console.log('http://127.0.0.1:'+port));
`);
  const saved=spec as Partial<AssessedReconstructionSpec>;
  const assessed:AssessedReconstructionSpec={...spec,requirementAssessments:saved.requirementAssessments??assessRequirements(spec.kind,spec.requirements),capabilityMatrix:saved.capabilityMatrix??capabilityMatrix.filter(item=>item.kind===spec.kind)};
  files.set('README.md',`# ${spec.name}\n\n独立重建产物，不复用原软件源码或资源。\n\n## 需求与测试映射\n\n| 需求 | 状态 | 测试 | 说明 |\n| --- | --- | --- | --- |\n${assessed.requirementAssessments.map(item=>`| ${item.requirement.replace(/\|/g,'\\|')} | ${item.status} | ${item.tests.join(', ')||'无'} | ${item.note.replace(/\|/g,'\\|')} |`).join('\n')}\n\n## 能力支持/拒绝矩阵\n\n| 能力 | 状态 | 测试 | 边界 |\n| --- | --- | --- | --- |\n${assessed.capabilityMatrix.map(item=>`| ${item.capability} | ${item.status} | ${item.tests.join(', ')||'无（拒绝项无需测试）'} | ${item.note} |`).join('\n')}\n\n## 运行\n\n\`\`\`sh\nnpm test\nnpm start\n\`\`\`\n\n打开 http://127.0.0.1:4173。CLI 工具位于 bin/。\n\n## 边界\n\n${spec.limitations.map(item=>`- ${item}`).join('\n')}\n`);
  files.set('RECONSTRUCTION.json',JSON.stringify(assessed,null,2)+'\n');return{files,spec:{...spec,...assessed}};
}
export async function writeReconstructionProject(project:LegacyGeneratedProject,outputDir:string):Promise<string[]>{
  const root=path.resolve(outputDir);await mkdir(root,{recursive:false});const written:string[]=[];
  for(const [relative,content] of project.files){const destination=path.resolve(root,relative);const rel=path.relative(root,destination);if(rel==='..'||rel.startsWith(`..${path.sep}`)||path.isAbsolute(rel))throw new Error('生成路径越界');await mkdir(path.dirname(destination),{recursive:true});await writeFile(destination,content,{mode:0o600,flag:'wx'});written.push(relative);}return written.sort();
}

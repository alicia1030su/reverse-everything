#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { stat, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { VERSION } from './version.js';
import { api, apiUrl, CliError, redactToken, token } from './client.js';
const raw=process.argv.slice(2);const flags=new Set<string>();const values=new Map<string,string>();const args:string[]=[];
for(let i=0;i<raw.length;i++){const arg=raw[i]!;if(arg==='--json'||arg==='--quiet'||arg==='--authorized'||arg==='--no-wait'||arg==='--wait'||arg==='--confirm-local'||arg==='--port')flags.add(arg);else if(arg==='--api-url'||arg==='--timeout'||arg==='--name'){values.set(arg,raw[++i]??'');}else if(arg==='--version'||arg==='-v')flags.add(arg);else if(arg==='--help'||arg==='-h')flags.add(arg);else args.push(arg);}
if(values.has('--api-url'))process.env.RE_API_URL=values.get('--api-url');if(values.has('--timeout'))process.env.RE_CLI_TIMEOUT_MS=values.get('--timeout')!;
const quiet=flags.has('--quiet');const out=(value:unknown)=>{if(!quiet)console.log(JSON.stringify(value,null,2));};
const help={product:'reverse-everything',version:VERSION,usage:['reverse-everything --version','reverse-everything --help','reverse-everything health','reverse-everything capabilities','reverse-everything analyzers list','reverse-everything hardware list','reverse-everything hardware doctor','reverse-everything hardware serial','reverse-everything firmware inspect <file> --authorized [--no-wait]','reverse-everything projects list','reverse-everything projects create <name> <kind> [target] --authorized','reverse-everything projects upload <projectId> <file>','reverse-everything analyze file <file> [--name <name>] --authorized [--no-wait]','reverse-everything analyze web <url> [--name <name>] --authorized [--confirm-local]','reverse-everything tasks create <projectId> <adapter>','reverse-everything tasks list','reverse-everything tasks get <taskId>','reverse-everything tasks logs <taskId>','reverse-everything tasks action <taskId> <pause|resume|cancel|retry>','reverse-everything report export <taskId> [out.md]','reverse-everything config show','reverse-everything resources status','reverse-everything cache stats','reverse-everything retention show','reverse-everything mcp stdio','reverse-everything mcp http [--port 4174]'],globalFlags:['--json','--quiet','--timeout <ms>','--api-url <url>']};
async function waitTask(id:string){const deadline=Date.now()+Number(process.env.RE_CLI_TIMEOUT_MS??120000);while(Date.now()<deadline){const task=await api<{id:string;status:string;error?:string}>(`/api/tasks/${id}`);if(['COMPLETED','FAILED','BLOCKED','CANCELLED','PARTIAL_SUCCESS'].includes(task.status))return task;await new Promise(r=>setTimeout(r,500));}throw new CliError(4,'Timed out waiting for task; task was not cancelled');}
async function uploadFile(projectId:string,file:string){const info=await stat(file);if(!info.isFile())throw new CliError(1,'Upload path must be a regular file');const boundary=`re-${randomUUID()}`;const filename=path.basename(file).replace(/[\r\n"]/g,'_');const preamble=Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`);const epilogue=Buffer.from(`\r\n--${boundary}--\r\n`);const stream=Readable.toWeb(Readable.from((async function*(){yield preamble;for await(const chunk of createReadStream(file))yield chunk;yield epilogue;})())) as BodyInit;return api(`/api/projects/${projectId}/uploads`,{method:'POST',body:stream,headers:{'content-type':`multipart/form-data; boundary=${boundary}`,'content-length':String(preamble.length+info.size+epilogue.length)}});}
async function artifactJson<T>(taskId:string,name:string):Promise<T>{const response=await fetch(`${apiUrl()}/api/tasks/${taskId}/artifacts/${encodeURIComponent(name)}`,{headers:{authorization:`Bearer ${await token()}`}});if(!response.ok)throw new CliError(response.status,redactToken(await response.text(),await token()));return response.json() as Promise<T>;}
async function main(){
  if(flags.has('--version'))return out({product:'reverse-everything',version:VERSION});
  const [command='help',sub='',...rest]=args;
  if(command==='help'||flags.has('--help')||raw.length===0)return out(help);
  switch(`${command} ${sub}`.trim()){
    case 'health':return out(await api('/api/health'));
    case 'capabilities':
    case 'analyzers list':return out(await api('/api/capabilities'));
    case 'hardware list':return out(await api('/api/hardware/devices'));
    case 'hardware doctor':return out(await api('/api/hardware/doctor'));
    case 'hardware serial':return out(await api('/api/hardware/serial'));
    case 'firmware inspect':{const file=rest[0];if(!file)throw new CliError(1,'Usage: firmware inspect <file> --authorized');if(!flags.has('--authorized'))throw new CliError(1,'Add --authorized to confirm you may analyze this firmware');const project=await api<{id:string}>('/api/projects',{method:'POST',body:JSON.stringify({name:values.get('--name')??`Firmware ${path.basename(file)}`,kind:'firmware',authorizationConfirmed:true})});await uploadFile(project.id,file);const task=await api<{id:string}>(`/api/projects/${project.id}/tasks`,{method:'POST',body:JSON.stringify({adapter:'firmware'})});if(flags.has('--no-wait'))return out(task);const done=await waitTask(task.id);if(done.status!=='COMPLETED')return out(done);return out({task:done,analysis:await artifactJson(task.id,'firmware-analysis.json')});}
    case 'resources':
    case 'resources status':return out(await api('/api/resources'));
    case 'config show':return out({apiUrl:apiUrl(),tokenSource:process.env.RE_API_TOKEN?'environment':'local-token-file',settings:await api('/api/settings')});
    case 'projects list':return out(await api('/api/projects'));
    case 'projects create':{const name=rest[0],kind=rest[1],target=rest.slice(2).join(' ');if(!name||!['website','software','game','security','protocol','hardware','firmware'].includes(kind??''))throw new CliError(1,'Usage: projects create <name> <website|software|game|security|protocol|hardware|firmware> [target] --authorized');if(!flags.has('--authorized'))throw new CliError(1,'Add --authorized to confirm you are entitled to analyze this target');return out(await api('/api/projects',{method:'POST',body:JSON.stringify({name,kind,target,authorizationConfirmed:true})}));}
    case 'projects upload':{const id=rest[0],file=rest[1];if(!id||!file)throw new CliError(1,'Usage: projects upload <projectId> <file>');return out(await uploadFile(id,file));}
    case 'analyze file':{const file=rest[0];if(!file)throw new CliError(1,'Usage: analyze file <file>');if(!flags.has('--authorized'))throw new CliError(1,'Add --authorized for local file analysis');const name=values.get('--name')??`File ${file}`;const project=await api<{id:string}>('/api/projects',{method:'POST',body:JSON.stringify({name,kind:'software',authorizationConfirmed:true})});await uploadFile(project.id,file);const task=await api<{id:string}>(`/api/projects/${project.id}/tasks`,{method:'POST',body:JSON.stringify({adapter:'file'})});return out(flags.has('--no-wait')?task:await waitTask(task.id));}
    case 'analyze web':{const target=rest[0];if(!target||!/^https?:\/\//.test(target))throw new CliError(1,'Usage: analyze web <url> --authorized');if(!flags.has('--authorized'))throw new CliError(1,'Add --authorized to confirm target ownership');const local=['127.0.0.1','localhost'].includes(new URL(target).hostname);if(local&&!flags.has('--confirm-local'))throw new CliError(1,'Local target also requires --confirm-local');const project=await api<{id:string}>('/api/projects',{method:'POST',body:JSON.stringify({name:values.get('--name')??`Web ${target}`,kind:'website',target,authorizationConfirmed:true})});const task=await api<{id:string}>(`/api/projects/${project.id}/tasks`,{method:'POST',body:JSON.stringify({adapter:'website',options:local?{allowLocal:true,confirmLocal:true}:{}})});return out(flags.has('--no-wait')?task:await waitTask(task.id));}
    case 'tasks create':{const projectId=rest[0],adapter=rest[1];if(!projectId||!['website','file','security','game','network','apk','ghidra','hardware','firmware'].includes(adapter??''))throw new CliError(1,'Usage: tasks create <projectId> <adapter>');return out(await api(`/api/projects/${projectId}/tasks`,{method:'POST',body:JSON.stringify({adapter})}));}
    case 'tasks list':return out(await api('/api/tasks'));
    case 'tasks get':return out(await api(`/api/tasks/${rest[0]}`));
    case 'tasks logs':{const task=await api<{logs:unknown[]}>(`/api/tasks/${rest[0]}`);return out(task.logs);}
    case 'tasks action':{const id=rest[0],action=rest[1];if(!['pause','resume','cancel','retry'].includes(action??''))throw new CliError(1,'Action must be pause, resume, cancel or retry');return out(await api(`/api/tasks/${id}/${action}`,{method:'POST'}));}
    case 'report export':{const id=rest[0],destination=rest[1]??`report-${id}.md`;const response=await fetch(`${apiUrl()}/api/tasks/${id}/report`,{headers:{authorization:`Bearer ${await token()}`}});if(!response.ok)throw new CliError(response.status,redactToken(await response.text(),await token()));await writeFile(destination,await response.text());return out({saved:destination});}
    case 'cache stats':return out(await api('/api/cache/stats'));
    case 'retention show':return out(await api('/api/retention'));
    case 'mcp stdio':await import('./mcp.js');return;
    case 'mcp http':await import('./mcp-http.js');return;
    default:throw new CliError(1,`Unknown command: ${command} ${sub}`.trim());
  }
}
main().catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=error instanceof CliError?(error.status===401||error.status===403?2:error.status===409?3:error.status===429?4:1):1;});

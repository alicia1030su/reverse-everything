#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { VERSION } from './version.js';
import { api, apiUrl, CliError, redactToken, token } from './client.js';
const raw=process.argv.slice(2);const flags=new Set<string>();const values=new Map<string,string>();const args:string[]=[];
for(let i=0;i<raw.length;i++){const arg=raw[i]!;if(arg==='--json'||arg==='--quiet'||arg==='--authorized'||arg==='--no-wait'||arg==='--wait'||arg==='--confirm-local'||arg==='--port')flags.add(arg);else if(arg==='--api-url'||arg==='--timeout'||arg==='--name'){values.set(arg,raw[++i]??'');}else if(arg==='--version'||arg==='-v')flags.add(arg);else if(arg==='--help'||arg==='-h')flags.add(arg);else args.push(arg);}
if(values.has('--api-url'))process.env.RE_API_URL=values.get('--api-url');if(values.has('--timeout'))process.env.RE_CLI_TIMEOUT_MS=values.get('--timeout')!;
const quiet=flags.has('--quiet');const out=(value:unknown)=>{if(!quiet)console.log(JSON.stringify(value,null,2));};
const help={product:'reverse-everything',version:VERSION,usage:['reverse-everything --version','reverse-everything --help','reverse-everything health','reverse-everything capabilities','reverse-everything projects list','reverse-everything projects create <name> <kind> [target] --authorized','reverse-everything projects upload <projectId> <file>','reverse-everything analyze file <file> [--name <name>] --authorized [--no-wait]','reverse-everything analyze web <url> [--name <name>] --authorized [--confirm-local]','reverse-everything tasks list','reverse-everything tasks get <taskId>','reverse-everything tasks logs <taskId>','reverse-everything tasks action <taskId> <pause|resume|cancel|retry>','reverse-everything report export <taskId> [out.md]','reverse-everything config show','reverse-everything resources','reverse-everything cache stats','reverse-everything retention show','reverse-everything mcp stdio','reverse-everything mcp http [--port 4174]'],globalFlags:['--json','--quiet','--timeout <ms>','--api-url <url>']};
async function waitTask(id:string){const deadline=Date.now()+Number(process.env.RE_CLI_TIMEOUT_MS??120000);while(Date.now()<deadline){const task=await api<{id:string;status:string;error?:string}>(`/api/tasks/${id}`);if(['COMPLETED','FAILED','BLOCKED','CANCELLED'].includes(task.status))return task;await new Promise(r=>setTimeout(r,500));}throw new CliError(4,'Timed out waiting for task; task was not cancelled');}
async function main(){
  if(flags.has('--version'))return out({product:'reverse-everything',version:VERSION});
  const [command='help',sub='',...rest]=args;
  if(command==='help'||flags.has('--help')||raw.length===0)return out(help);
  switch(`${command} ${sub}`.trim()){
    case 'health':return out(await api('/api/health'));
    case 'capabilities':return out(await api('/api/capabilities'));
    case 'resources':return out(await api('/api/resources'));
    case 'config show':return out({apiUrl:apiUrl(),tokenSource:process.env.RE_API_TOKEN?'environment':'local-token-file',settings:await api('/api/settings')});
    case 'projects list':return out(await api('/api/projects'));
    case 'projects create':{const name=rest[0],kind=rest[1],target=rest.slice(2).join(' ');if(!name||!['website','software','game','security'].includes(kind??''))throw new CliError(1,'Usage: projects create <name> <website|software|game|security> [target] --authorized');if(!flags.has('--authorized'))throw new CliError(1,'Add --authorized to confirm you are entitled to analyze this target');return out(await api('/api/projects',{method:'POST',body:JSON.stringify({name,kind,target,authorizationConfirmed:true})}));}
    case 'projects upload':{const id=rest[0],file=rest[1];if(!id||!file)throw new CliError(1,'Usage: projects upload <projectId> <file>');const form=new FormData();form.append('file',new Blob([new Uint8Array(await import('node:fs/promises').then(m=>m.readFile(file)))]),file);return out(await api(`/api/projects/${id}/uploads`,{method:'POST',body:form}));}
    case 'analyze file':{const file=rest[0];if(!file)throw new CliError(1,'Usage: analyze file <file>');if(!flags.has('--authorized'))throw new CliError(1,'Add --authorized for local file analysis');const name=values.get('--name')??`File ${file}`;const project=await api<{id:string}>('/api/projects',{method:'POST',body:JSON.stringify({name,kind:'software',authorizationConfirmed:true})});const form=new FormData();form.append('file',new Blob([new Uint8Array(await import('node:fs/promises').then(m=>m.readFile(file)))]),file);await api(`/api/projects/${project.id}/uploads`,{method:'POST',body:form});const task=await api<{id:string}>(`/api/projects/${project.id}/tasks`,{method:'POST',body:JSON.stringify({adapter:'file'})});return out(flags.has('--no-wait')?task:await waitTask(task.id));}
    case 'analyze web':{const target=rest[0];if(!target||!/^https?:\/\//.test(target))throw new CliError(1,'Usage: analyze web <url> --authorized');if(!flags.has('--authorized'))throw new CliError(1,'Add --authorized to confirm target ownership');const local=['127.0.0.1','localhost'].includes(new URL(target).hostname);if(local&&!flags.has('--confirm-local'))throw new CliError(1,'Local target also requires --confirm-local');const project=await api<{id:string}>('/api/projects',{method:'POST',body:JSON.stringify({name:values.get('--name')??`Web ${target}`,kind:'website',target,authorizationConfirmed:true})});const task=await api<{id:string}>(`/api/projects/${project.id}/tasks`,{method:'POST',body:JSON.stringify({adapter:'website',options:local?{allowLocal:true,confirmLocal:true}:{}})});return out(flags.has('--no-wait')?task:await waitTask(task.id));}
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

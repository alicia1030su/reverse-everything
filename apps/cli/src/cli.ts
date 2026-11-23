#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { api, apiUrl } from './client.js';
const [command='help',sub='',...args]=process.argv.slice(2);
const json=(value:unknown)=>console.log(JSON.stringify(value,null,2));
async function main(){
  switch(`${command} ${sub}`.trim()){
    case 'health': return json(await api('/api/health'));
    case 'projects list': return json(await api('/api/projects'));
    case 'projects create': { const name=args[0],kind=args[1],target=args.slice(2).join(' '); if(!name||!['website','software','game','security'].includes(kind??''))throw new Error('Usage: reverse projects create <name> <website|software|game|security> [target] --authorized'); const authorized=process.argv.includes('--authorized'); if(!authorized)throw new Error('Add --authorized to confirm you are entitled to analyze this target'); return json(await api('/api/projects',{method:'POST',body:JSON.stringify({name,kind,target,authorizationConfirmed:true})})); }
    case 'projects upload': { const id=args[0],file=args[1]; if(!id||!file)throw new Error('Usage: reverse projects upload <projectId> <file>'); const form=new FormData(); form.append('file',new Blob([new Uint8Array(await import('node:fs/promises').then(m=>m.readFile(file)))]),file); return json(await api(`/api/projects/${id}/uploads`,{method:'POST',body:form})); }
    case 'tasks list': return json(await api('/api/tasks'));
    case 'tasks create': { const id=args[0],adapter=args[1]; if(!id||!['website','file','security','game'].includes(adapter??''))throw new Error('Usage: reverse tasks create <projectId> <adapter> [options-json]'); const options=args[2]?JSON.parse(args[2]) as Record<string,unknown>:{}; return json(await api(`/api/projects/${id}/tasks`,{method:'POST',body:JSON.stringify({adapter,options})})); }
    case 'tasks get': return json(await api(`/api/tasks/${args[0]}`));
    case 'tasks action': { const id=args[0],action=args[1]; if(!['pause','resume','cancel','retry'].includes(action??''))throw new Error('Action must be pause, resume, cancel or retry'); return json(await api(`/api/tasks/${id}/${action}`,{method:'POST'})); }
    case 'tasks report': { const id=args[0],out=args[1]??`report-${id}.md`; const response=await fetch(`${apiUrl}/api/tasks/${id}/report`,{headers:{authorization:`Bearer ${await import('./client.js').then(m=>m.token())}`}}); if(!response.ok)throw new Error(await response.text()); await writeFile(out,await response.text()); return json({saved:out}); }
    case 'tasks artifact': { const id=args[0],name=args[1],out=args[2]??name; if(!name)throw new Error('Artifact name is required'); const destination=out??name; const response=await fetch(`${apiUrl}/api/tasks/${id}/artifacts/${encodeURIComponent(name)}`,{headers:{authorization:`Bearer ${await import('./client.js').then(m=>m.token())}`}}); if(!response.ok)throw new Error(await response.text()); await writeFile(destination,Buffer.from(await response.arrayBuffer())); return json({saved:destination}); }
    default: return json({usage:['reverse health','reverse projects list','reverse projects create <name> <kind> [target] --authorized','reverse projects upload <projectId> <file>','reverse tasks list','reverse tasks create <projectId> <adapter> [options-json]','reverse tasks get <taskId>','reverse tasks action <taskId> <pause|resume|cancel|retry>','reverse tasks report <taskId> [out.md]','reverse tasks artifact <taskId> <name> [out]']});
  }
}
main().catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});

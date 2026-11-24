import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { api } from './client.js';
const text=(value:unknown)=>({content:[{type:'text' as const,text:JSON.stringify(value,null,2)}]});
export function createMcpServer(localFileRead=false):McpServer{
  const server=new McpServer({name:'reverse-everything',version:'0.0.2'},{instructions:'Analyze only targets the user is authorized to inspect. Tool evidence is authoritative; model output is inference. Never bypass access controls.'});
  const register=(name:string,description:string,shape:Record<string,z.ZodTypeAny>,handler:(args:Record<string,unknown>)=>Promise<unknown>)=>server.registerTool(name,{description,inputSchema:shape},async args=>text(await handler(args as Record<string,unknown>)));
  register('list_projects','List local projects',{},()=>api('/api/projects'));
  register('create_project','Create an authorized project',{name:z.string(),kind:z.enum(['website','software','game','security']),target:z.string().optional(),authorized:z.literal(true)},args=>api('/api/projects',{method:'POST',body:JSON.stringify({name:args.name,kind:args.kind,target:args.target??'',authorizationConfirmed:true})}));
  register('upload_file','Upload base64 content, or a local path only when stdio allowed roots permit it',{projectId:z.string(),filePath:z.string().optional(),fileName:z.string().optional(),contentBase64:z.string().optional()},async args=>{let bytes:Uint8Array;let fileName=String(args.fileName??'upload.bin');if(args.contentBase64){bytes=Buffer.from(String(args.contentBase64),'base64');}else{if(!localFileRead||!args.filePath)throw new Error('HTTP MCP requires contentBase64; local paths are disabled');const roots=(process.env.RE_MCP_ALLOWED_ROOTS??'').split(path.delimiter).filter(Boolean).map(root=>path.resolve(root));if(!roots.length)throw new Error('RE_MCP_ALLOWED_ROOTS is not configured');const target=await realpath(path.resolve(String(args.filePath)));if(!roots.some(root=>target===root||target.startsWith(root+path.sep)))throw new Error('File path is outside allowed roots');bytes=new Uint8Array(await readFile(target));fileName=path.basename(target);}const form=new FormData();form.append('file',new Blob([new Uint8Array(bytes)]),fileName);return api(`/api/projects/${String(args.projectId)}/uploads`,{method:'POST',body:form});});
  register('create_task','Create a task through the shared engine',{projectId:z.string(),adapter:z.enum(['website','file','security','game']),options:z.record(z.string(),z.unknown()).optional()},args=>api(`/api/projects/${String(args.projectId)}/tasks`,{method:'POST',body:JSON.stringify({adapter:args.adapter,options:args.options??{}})}));
  register('list_tasks','List tasks',{},()=>api('/api/tasks'));
  register('get_task','Get stages evidence findings logs and artifacts',{taskId:z.string()},args=>api(`/api/tasks/${String(args.taskId)}`));
  register('task_action','Pause resume cancel or retry',{taskId:z.string(),action:z.enum(['pause','resume','cancel','retry'])},args=>api(`/api/tasks/${String(args.taskId)}/${String(args.action)}`,{method:'POST'}));
  register('get_report','Get task detail including generated Markdown report',{taskId:z.string()},args=>api(`/api/tasks/${String(args.taskId)}`));
  register('list_capabilities','List product version adapters and entrypoints',{},()=>api('/api/capabilities'));
  register('get_system_health','Get API worker and browser status',{},()=>api('/api/system/status'));
  register('get_resource_metrics','Get real API worker and desktop metrics',{},()=>api('/api/resources'));
  register('list_evidence','List paginated evidence for a task',{taskId:z.string(),limit:z.number().optional(),offset:z.number().optional()},args=>api(`/api/tasks/${String(args.taskId)}/evidence?limit=${Number(args.limit??100)}&offset=${Number(args.offset??0)}`));
  register('get_evidence','Get evidence by ID',{evidenceId:z.string()},args=>api(`/api/evidence/${String(args.evidenceId)}`));
  register('get_task_events','Get persisted task event history',{taskId:z.string(),after:z.number().optional()},args=>api(`/api/tasks/${String(args.taskId)}/events/history?after=${Number(args.after??0)}`));
  register('get_artifact_manifest','Get artifact names hashes and download paths',{taskId:z.string()},args=>api(`/api/tasks/${String(args.taskId)}/artifact-manifest`));
  register('list_cache_entries','List cache entries; destructive cleanup is not exposed',{projectId:z.string().optional(),limit:z.number().optional(),offset:z.number().optional()},args=>api(`/api/cache?projectId=${encodeURIComponent(String(args.projectId??''))}&limit=${Number(args.limit??100)}&offset=${Number(args.offset??0)}`));
  register('get_cache_statistics','Get cache hit rate size and integrity counters',{},()=>api('/api/cache/stats'));
  return server;
}

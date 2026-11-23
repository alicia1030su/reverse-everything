#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { api } from './client.js';
const tools=[
  {name:'list_projects',description:'List local reverse-engineering projects',inputSchema:{type:'object',properties:{},additionalProperties:false}},
  {name:'create_project',description:'Create a project for a target you are authorized to analyze',inputSchema:{type:'object',properties:{name:{type:'string'},kind:{type:'string',enum:['website','software','game','security']},target:{type:'string'},authorized:{type:'boolean',const:true}},required:['name','kind','authorized'],additionalProperties:false}},
  {name:'upload_file',description:'Upload a local file to an existing project',inputSchema:{type:'object',properties:{projectId:{type:'string'},filePath:{type:'string'}},required:['projectId','filePath'],additionalProperties:false}},
  {name:'create_task',description:'Create an analysis task using the same backend as the Web console',inputSchema:{type:'object',properties:{projectId:{type:'string'},adapter:{type:'string',enum:['website','file','security','game']},options:{type:'object'}},required:['projectId','adapter'],additionalProperties:false}},
  {name:'list_tasks',description:'List analysis tasks',inputSchema:{type:'object',properties:{},additionalProperties:false}},
  {name:'get_task',description:'Get task stages, evidence, findings, logs and artifacts',inputSchema:{type:'object',properties:{taskId:{type:'string'}},required:['taskId'],additionalProperties:false}},
  {name:'task_action',description:'Pause, resume, cancel or retry a task',inputSchema:{type:'object',properties:{taskId:{type:'string'},action:{type:'string',enum:['pause','resume','cancel','retry']}},required:['taskId','action'],additionalProperties:false}},
  {name:'get_report',description:'Download the Markdown analysis report',inputSchema:{type:'object',properties:{taskId:{type:'string'}},required:['taskId'],additionalProperties:false}}
];
async function call(name:string,args:Record<string,unknown>):Promise<unknown> {
  switch(name){
    case 'list_projects': return api('/api/projects');
    case 'create_project': if(args.authorized!==true)throw new Error('Explicit authorization is required'); return api('/api/projects',{method:'POST',body:JSON.stringify({name:args.name,kind:args.kind,target:args.target??'',authorizationConfirmed:true})});
    case 'upload_file': { const filePath=String(args.filePath); const bytes=await readFile(filePath); const form=new FormData(); form.append('file',new Blob([new Uint8Array(bytes)]),path.basename(filePath)); return api(`/api/projects/${String(args.projectId)}/uploads`,{method:'POST',body:form}); }
    case 'create_task': return api(`/api/projects/${String(args.projectId)}/tasks`,{method:'POST',body:JSON.stringify({adapter:args.adapter,options:args.options??{}})});
    case 'list_tasks': return api('/api/tasks');
    case 'get_task': return api(`/api/tasks/${String(args.taskId)}`);
    case 'task_action': return api(`/api/tasks/${String(args.taskId)}/${String(args.action)}`,{method:'POST'});
    case 'get_report': return api(`/api/tasks/${String(args.taskId)}`);
    default: throw new Error(`Unknown tool ${name}`);
  }
}
const rl=createInterface({input:process.stdin,crlfDelay:Infinity});
rl.on('line',line=>{ void (async()=>{ let id:number|string|undefined; try { const msg=JSON.parse(line) as {id?:number|string;method:string;params?:Record<string,unknown>}; id=msg.id; if(msg.id===undefined)return; let result:unknown;
  if(msg.method==='initialize') result={protocolVersion:'2025-06-18',capabilities:{tools:{listChanged:false}},serverInfo:{name:'reverse-everything',version:'0.0.1'},instructions:'Analyze only targets you are authorized to inspect. Tool evidence is authoritative; model output is inference.'};
  else if(msg.method==='ping') result={};
  else if(msg.method==='tools/list') result={tools};
  else if(msg.method==='tools/call'){ const params=msg.params??{}; try{const data=await call(String(params.name),(params.arguments??{}) as Record<string,unknown>);result={content:[{type:'text',text:JSON.stringify(data,null,2)}],isError:false};}catch(error){result={content:[{type:'text',text:error instanceof Error?error.message:String(error)}],isError:true};}}
  else { process.stdout.write(`${JSON.stringify({jsonrpc:'2.0',id,error:{code:-32601,message:'Method not found'}})}\n`); return; }
  process.stdout.write(`${JSON.stringify({jsonrpc:'2.0',id,result})}\n`);
}catch{process.stdout.write(`${JSON.stringify({jsonrpc:'2.0',id,error:{code:-32700,message:'Parse error'}})}\n`);}})(); });

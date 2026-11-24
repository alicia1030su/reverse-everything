#!/usr/bin/env node
const base=(process.env.RE_API_URL??'http://127.0.0.1:4173').replace(/\/$/,'');
const result={node:process.version,apiUrl:base,cli:process.env.RE_CLI_PATH??'reverse-everything',mcpStdio:Boolean(process.env.RE_MCP_STDIO),mcpHttp:Boolean(process.env.RE_MCP_HTTP_URL),authorizationRequired:true};
try{const response=await fetch(`${base}/api/health`,{signal:AbortSignal.timeout(3000)});result.api=response.ok?await response.json():{reachable:false,status:response.status};}catch{result.api={reachable:false};}
console.log(JSON.stringify(result,null,2));

import { readFile } from 'node:fs/promises';
import path from 'node:path';
export const apiUrl=(process.env.RE_API_URL??'http://127.0.0.1:4173').replace(/\/$/,'');
export async function token():Promise<string> { if(process.env.RE_API_TOKEN)return process.env.RE_API_TOKEN; const file=path.resolve(process.env.RE_DATA_DIR??'data','local-token'); return (await readFile(file,'utf8')).trim(); }
export async function api<T>(route:string,init:RequestInit={}):Promise<T> { const response=await fetch(`${apiUrl}${route}`,{...init,headers:{...(init.body&&typeof init.body==='string'?{'content-type':'application/json'}:{}),authorization:`Bearer ${await token()}`,...init.headers}}); const text=await response.text(); const data=text?JSON.parse(text) as T:{} as T; if(!response.ok)throw new Error(`HTTP ${response.status}: ${text.slice(0,1000)}`); return data; }

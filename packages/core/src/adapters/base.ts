import path from 'node:path';
import { open, stat } from 'node:fs/promises';
import type { Stage } from '@reverse/contracts';
import type { AdapterDefinition, TaskContext } from '@reverse/workflow';
export function uploadPath(ctx:TaskContext):string { if(!ctx.upload) throw new Error('This adapter requires an uploaded file'); return path.resolve(ctx.dataDir,'uploads',ctx.upload.projectId,ctx.upload.storedName); }
export function output<T>(ctx:TaskContext,stage:Stage):T { return ctx.stageOutputs[stage] as T; }
export async function limitedRead(file:string,max=10_000_000):Promise<Buffer> { const s=await stat(file); const size=Math.min(s.size,max); const buffer=Buffer.alloc(size); const handle=await open(file,'r'); try { await handle.read(buffer,0,size,0); return buffer; } finally { await handle.close(); } }
export function noReconstruction(ctx:TaskContext, reason:string) { return {reconstructed:false,reason,limitations:[reason]}; }
export function defineAdapter(definition:AdapterDefinition):AdapterDefinition { return definition; }

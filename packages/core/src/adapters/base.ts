import path from 'node:path';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import type { Stage } from '@reverse/contracts';
import type { AdapterDefinition, TaskContext } from '@reverse/workflow';
export function uploadPath(ctx:TaskContext):string { if(!ctx.upload) throw new Error('This adapter requires an uploaded file'); if(ctx.inputSnapshotPath) return path.resolve(ctx.inputSnapshotPath); return path.resolve(ctx.dataDir,'uploads',ctx.upload.projectId,ctx.upload.storedName); }
export function output<T>(ctx:TaskContext,stage:Stage):T { return ctx.stageOutputs[stage] as T; }
export async function limitedRead(file:string,max=10_000_000):Promise<Buffer> {
  if(!Number.isSafeInteger(max)||max<=0)throw new Error('Bounded read limit must be a positive safe integer');
  const before=await lstat(file);if(before.isSymbolicLink()||!before.isFile())throw new Error('Upload path is not a regular file');
  const handle=await open(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  try{
    const opened=await handle.stat();const after=await lstat(file);
    if(opened.isSymbolicLink()||!opened.isFile()||after.isSymbolicLink()||!after.isFile()||before.dev!==opened.dev||before.ino!==opened.ino||opened.dev!==after.dev||opened.ino!==after.ino)throw new Error('Upload file changed while it was being opened');
    const size=Math.min(opened.size,max);const buffer=Buffer.alloc(size);let offset=0;
    while(offset<size){const read=await handle.read(buffer,offset,size-offset,offset);if(read.bytesRead===0)throw new Error(`Unexpected end of file while reading ${file}`);offset+=read.bytesRead;}
    const final=await handle.stat();if(final.size!==opened.size||final.mtimeMs!==opened.mtimeMs)throw new Error('Upload file changed during the bounded read');
    return buffer;
  }finally{await handle.close();}
}
export function noReconstruction(ctx:TaskContext, reason:string) { return {reconstructed:false,reason,limitations:[reason]}; }
export function defineAdapter(definition:AdapterDefinition):AdapterDefinition { return definition; }

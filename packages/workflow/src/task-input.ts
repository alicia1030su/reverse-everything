import path from 'node:path';
import type { Task, Upload } from '@reverse/contracts';
import type { Database } from './database.js';

export interface DirectTaskInput { upload?:Upload;target:string;inputHash?:string;kind:'upload'|'path'|'url'|'unknown' }

function normalizeUrlTarget(value:string):string{
  const target=value.trim();
  if(path.isAbsolute(target))return path.resolve(target);
  if(path.win32.isAbsolute(target))return path.win32.normalize(target);
  try{
    const url=new URL(target);
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password)return target;
    url.hash='';
    return url.toString();
  }catch{return target;}
}

export function normalizeInputTarget(value:string):string{return normalizeUrlTarget(value);}

/** 直接任务必须绑定唯一、可复核的实际输入；无法确定时失败关闭。 */
export function resolveDirectTaskInput(db:Database,task:Task):DirectTaskInput{
  const project=db.getProject(task.projectId);
  if(!project)throw new Error('Project no longer exists');
  const uploadId=typeof task.options.uploadId==='string'?task.options.uploadId.trim():'';
  const localPath=typeof task.options.path==='string'?task.options.path.trim():'';
  if(uploadId&&localPath)throw new Error('Direct task cannot bind both uploadId and path');
  if(uploadId){
    const upload=db.uploads(task.projectId).find(item=>item.id===uploadId);
    if(!upload)throw new Error('Bound upload is missing');
    return {upload,target:upload.id,kind:'upload'};
  }
  if(localPath){
    if(!path.isAbsolute(localPath)&&!path.win32.isAbsolute(localPath))throw new Error('Legacy path must be absolute');
    if(!/^[a-f0-9]{64}$/i.test(task.inputHash))throw new Error('Direct path task is missing its bound input hash');
    return {target:normalizeInputTarget(localPath),inputHash:task.inputHash.toLowerCase(),kind:'path'};
  }
  const projectTarget=project.target.trim();
  const urlAdapters=new Set(['website','security']);
  if(urlAdapters.has(task.adapter)&&projectTarget)return {target:normalizeUrlTarget(projectTarget),kind:'url'};
  const uploads=db.uploads(task.projectId);
  if(uploads.length===1)return {upload:uploads[0]!,target:uploads[0]!.id,kind:'upload'};
  if(uploads.length>1)throw new Error('Direct task input is ambiguous; specify uploadId');
  if(projectTarget)return {target:normalizeUrlTarget(projectTarget),kind:'url'};
  return {target:'',kind:'unknown'};
}

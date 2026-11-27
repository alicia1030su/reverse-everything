import { readFile, writeFile, chmod, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { encryptSecret, decryptSecret, encryptionKey } from '@reverse/security';
export { encryptSecret, decryptSecret, encryptionKey };
export async function localToken(dataDir:string):Promise<string> { await mkdir(dataDir,{recursive:true}); const file=path.join(dataDir,'local-token'); try{return (await readFile(file,'utf8')).trim();}catch{const token=(await import('node:crypto')).randomBytes(32).toString('hex');await writeFile(file,token,{mode:0o600});await chmod(file,0o600);return token;} }
export function cookieValue(header:string|undefined,name:string):string|undefined { for(const part of header?.split(';')??[]){const [k,...v]=part.trim().split('=');if(k===name)return v.join('=');} }
export function redactAbsolutePaths<T>(value:T):T {
  if(typeof value==='string')return (!value.startsWith('/api/')&&(path.isAbsolute(value)||path.win32.isAbsolute(value))?(path.isAbsolute(value)?path.basename(value):path.win32.basename(value)):value) as T;
  if(Array.isArray(value))return value.map(item=>redactAbsolutePaths(item)) as T;
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,redactAbsolutePaths(item)])) as T;
  return value;
}
export function publicTask<T extends {options:Record<string,unknown>}>(task:T):T { return {...task,options:redactAbsolutePaths(task.options)}; }

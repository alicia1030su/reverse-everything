import { readFile, writeFile, chmod, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { encryptSecret, decryptSecret, encryptionKey } from '@reverse/security';
export { encryptSecret, decryptSecret, encryptionKey };
export async function localToken(dataDir:string):Promise<string> { await mkdir(dataDir,{recursive:true}); const file=path.join(dataDir,'local-token'); try{return (await readFile(file,'utf8')).trim();}catch{const token=(await import('node:crypto')).randomBytes(32).toString('hex');await writeFile(file,token,{mode:0o600});await chmod(file,0o600);return token;} }
export function cookieValue(header:string|undefined,name:string):string|undefined { for(const part of header?.split(';')??[]){const [k,...v]=part.trim().split('=');if(k===name)return v.join('=');} }

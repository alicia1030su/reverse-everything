import yazl from 'yazl';
import { readdir, mkdir, readFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
const root=path.resolve('skills/reverse-everything');const version=JSON.parse(await readFile('package.json','utf8')).version;const output='dist/release/reverse-everything-skill-'+version+'.zip';await mkdir(path.dirname(output),{recursive:true});const zip=new yazl.ZipFile();
async function add(dir,prefix=''){for(const entry of await readdir(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);const name=path.posix.join(prefix,entry.name);if(entry.isDirectory())await add(file,name);else if(entry.isFile())zip.addFile(file,name);}}
await add(root,'reverse-everything');for(const file of ['LICENSE','NOTICE'])zip.addFile(file,'reverse-everything/'+file);await new Promise((resolve,reject)=>{zip.outputStream.pipe(createWriteStream(output)).on('close',resolve).on('error',reject);zip.end();});console.log(output);

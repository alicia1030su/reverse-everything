import { open, readdir } from 'node:fs/promises';
import path from 'node:path';
const ignored=new Set(['node_modules','.git','data','dist','test-results','playwright-report','coverage','.ghidra']);
const patterns=[/gh[pousr]_[A-Za-z0-9]{30,}/,/github_pat_[A-Za-z0-9_]{40,}/,/sk-[A-Za-z0-9]{32,}/,/AKIA[0-9A-Z]{16}/,/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/];
const files=[];
async function walk(dir){for(const entry of await readdir(dir,{withFileTypes:true})){if(ignored.has(entry.name))continue;const file=path.join(dir,entry.name);if(entry.isDirectory())await walk(file);else if(entry.isFile()&&entry.name!=='package-lock.json'&&!/^ghidra_.*\.zip$/i.test(entry.name))files.push(file);}}
async function scanFile(file){
  const handle=await open(file,'r');const buffer=Buffer.alloc(1024*1024);const findings=new Set();let carry='';
  try{
    while(true){
      const {bytesRead}=await handle.read(buffer,0,buffer.length,null);
      if(!bytesRead)break;
      const text=carry+buffer.subarray(0,bytesRead).toString('latin1');
      for(const pattern of patterns)if(pattern.test(text))findings.add(`${file}: ${pattern}`);
      carry=text.slice(-256);
    }
  }finally{await handle.close();}
  return [...findings];
}
await walk('.');
const findings=[];
for(const file of files)findings.push(...await scanFile(file));
if(findings.length){console.error('Potential secrets found:\n'+findings.join('\n'));process.exit(1);}
console.log(`Secret scan passed: ${files.length} text files checked.`);

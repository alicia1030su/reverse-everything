import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
const ignored=new Set(['node_modules','.git','data','dist','test-results','playwright-report','coverage']);
const patterns=[/gh[pousr]_[A-Za-z0-9]{30,}/,/github_pat_[A-Za-z0-9_]{40,}/,/sk-[A-Za-z0-9]{32,}/,/AKIA[0-9A-Z]{16}/,/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/];
const files=[];
async function walk(dir){for(const entry of await readdir(dir,{withFileTypes:true})){if(ignored.has(entry.name))continue;const file=path.join(dir,entry.name);if(entry.isDirectory())await walk(file);else if(entry.isFile()&&entry.name!=='package-lock.json')files.push(file);}}
await walk('.');
const findings=[];
for(const file of files){const text=await readFile(file,'utf8');for(const pattern of patterns)if(pattern.test(text))findings.push(`${file}: ${pattern}`);}
if(findings.length){console.error('Potential secrets found:\n'+findings.join('\n'));process.exit(1);}
console.log(`Secret scan passed: ${files.length} text files checked.`);

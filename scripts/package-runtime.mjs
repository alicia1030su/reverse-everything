import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir } from 'node:fs/promises';
import { resetGeneratedDirectory } from './reset-generated-dir.mjs';
import { createRequire } from 'node:module';
import path from 'node:path';
const root=process.cwd();
async function copyExclusive(source,destination){
  const info=await lstat(source);
  if(info.isSymbolicLink())return;
  if(info.isDirectory()){await mkdir(destination,{recursive:true});for(const entry of await readdir(source,{withFileTypes:true})){if(entry.name==='.git'||entry.name==='node_modules'||entry.name.endsWith('.map'))continue;await copyExclusive(path.join(source,entry.name),path.join(destination,entry.name));}return;}
  if(info.isFile()){await mkdir(path.dirname(destination),{recursive:true});await copyFile(source,destination,constants.COPYFILE_EXCL);}
}
const out=path.join(root,'dist/desktop-runtime/node_modules');
await resetGeneratedDirectory(path.dirname(out),path.join(root,'dist'),'desktop-runtime');
await mkdir(out,{recursive:true});
await mkdir(path.join(out,'scripts'),{recursive:true});
await copyExclusive(path.join(root,'scripts/ghidra-analyze-headless.mjs'),path.join(out,'scripts/ghidra-analyze-headless.mjs'));
await mkdir(path.join(path.dirname(out),'scripts'),{recursive:true});
await copyExclusive(path.join(root,'scripts/ghidra-analyze-headless.mjs'),path.join(path.dirname(out),'scripts/ghidra-analyze-headless.mjs'));
const rootPackage=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
const npmVersion=rootPackage.devDependencies?.npm;
if(typeof npmVersion!=='string'||!/^\d+\.\d+\.\d+$/.test(npmVersion))throw new Error('npm must be an exact-version devDependency');
const workspaceDirs=['apps/api','apps/worker','packages/core','packages/program-ir','packages/security','packages/workflow','packages/evidence','packages/ai','packages/contracts'];
const queue=[{name:'npm',from:root}];
for(const dir of workspaceDirs){
  const pkg=JSON.parse(await readFile(path.join(root,dir,'package.json'),'utf8'));
  for(const name of Object.keys(pkg.dependencies??{}))queue.push({name,from:path.join(root,dir)});
}
const seen=new Set();
let count=0;
async function findPackage(name,from){
  if(name.startsWith('@reverse/')){
    const dir=path.join(root,'packages',name.slice('@reverse/'.length));
    try{
      const pkg=JSON.parse(await readFile(path.join(dir,'package.json'),'utf8'));
      return {dir,pkg,workspace:true};
    }catch{
      throw new Error('Missing workspace dependency: '+name);
    }
  }
  const require=createRequire(path.join(from,'package.json'));
  let entry;
  try{entry=require.resolve(name);}catch{try{entry=require.resolve(name+'/package.json');}catch{throw new Error('Missing production dependency: '+name+' from '+from);}}
  let dir=path.dirname(entry);
  while(dir!==path.dirname(dir)){
    try{
      const pkg=JSON.parse(await readFile(path.join(dir,'package.json'),'utf8'));
      if(pkg.name===name||path.basename(dir)===name.split('/').at(-1))return {dir,pkg,workspace:false};
    }catch{}
    dir=path.dirname(dir);
  }
  throw new Error('Cannot locate package manifest for '+name);
}
while(queue.length){
  const item=queue.shift();
  const found=await findPackage(item.name,item.from);
  if(item.name==='npm'&&found.pkg.version!==npmVersion)throw new Error(`Installed npm ${found.pkg.version} does not match fixed devDependency ${npmVersion}`);
  const key=found.workspace?found.pkg.name:found.dir;
  if(seen.has(key))continue;
  seen.add(key);
  const nodeModulesRoot=path.join(root,'node_modules');const relative=path.relative(nodeModulesRoot,found.dir);if(!found.workspace&&(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative)))throw new Error('Production dependency is outside root node_modules: '+found.dir);const dest=found.workspace?path.join(out,...found.pkg.name.split('/')):path.join(out,...relative.split(path.sep));
  await mkdir(path.dirname(dest),{recursive:true});
  if(found.workspace){
    await mkdir(dest,{recursive:true});
    await copyExclusive(path.join(found.dir,'dist'),path.join(dest,'dist'));
    await copyExclusive(path.join(found.dir,'package.json'),path.join(dest,'package.json'));
  }else{
    await copyExclusive(found.dir,dest);
  }
  count++;
  for(const dep of Object.keys(found.pkg.dependencies??{}))queue.push({name:dep,from:found.dir});
  for(const dep of Object.keys(found.pkg.optionalDependencies??{}))queue.push({name:dep,from:found.dir});
}
console.log('Desktop runtime: '+count+' production packages');

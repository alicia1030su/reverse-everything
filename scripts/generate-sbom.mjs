import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
const lock=JSON.parse(await readFile('package-lock.json','utf8'));
const root=JSON.parse(await readFile('package.json','utf8'));
const components=[];
for(const [key,value] of Object.entries(lock.packages??{})){
  if(!key.startsWith('node_modules/')||value.dev)continue;
  const name=value.name??key.slice('node_modules/'.length);
  components.push({type:'library',name,version:value.version??'unknown',purl:'pkg:npm/'+name.replace(/^@/,'%40').replace('/','%2F')+'@'+(value.version??'unknown'),licenses:value.license?[{license:{id:value.license}}]:[]});
}
const bom={bomFormat:'CycloneDX',specVersion:'1.5',serialNumber:'urn:uuid:'+randomUUID(),version:1,metadata:{timestamp:new Date().toISOString(),tools:[{vendor:'Node.js',name:'node',version:process.version}],component:{type:'application',name:root.name,version:root.version}},components};
await mkdir('dist/release',{recursive:true});
await writeFile('dist/release/SBOM-v'+root.version+'.json',JSON.stringify(bom,null,2));
console.log('SBOM components: '+components.length+' ('+root.version+')');

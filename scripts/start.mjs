import { spawn } from 'node:child_process';
const commands=[['api',['apps/api/dist/server-entry.js']],['worker',['apps/worker/dist/worker.js']]];
const children=commands.map(([name,args])=>{const child=spawn(process.execPath,args,{env:{...process.env,RE_DATA_DIR:process.env.RE_DATA_DIR??'data'},stdio:['ignore','pipe','pipe']});child.stdout.on('data',b=>process.stdout.write(`[${name}] ${b}`));child.stderr.on('data',b=>process.stderr.write(`[${name}] ${b}`));child.on('exit',code=>{if(!stopping){console.error(`[${name}] exited unexpectedly: ${code}`);stop(code??1);}});return child;});
let stopping=false;
function stop(code=0){if(stopping)return;stopping=true;for(const child of children)child.kill();setTimeout(()=>process.exit(code),500).unref();}
process.on('SIGINT',()=>stop());process.on('SIGTERM',()=>stop());

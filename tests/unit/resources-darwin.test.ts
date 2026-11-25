import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

const processMock=vi.hoisted(()=>({spawn:vi.fn()}));
vi.mock('node:child_process',async importOriginal=>({...await importOriginal<typeof import('node:child_process')>(),spawn:processMock.spawn}));

import { darwinProcesses, defaultProcessSampler, parseDarwinProcessOutput } from '../../packages/workflow/src/resources.js';

function samplerChild(output:string,code=0){const child=new EventEmitter() as EventEmitter&{pid:number;stdout:PassThrough;stderr:PassThrough;kill:ReturnType<typeof vi.fn>};child.pid=4321;child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=vi.fn();queueMicrotask(()=>{child.stdout.emit('data',Buffer.from(output));child.emit('close',code);});return child;}

afterEach(()=>{processMock.spawn.mockReset();});

describe('macOS process-tree sampling',()=>{
  it('parses RSS, cumulative CPU time and commands containing spaces',()=>{
    const rows=parseDarwinProcessOutput(`${process.pid} 1 2048 1:02:03.50 Node worker\n9001 ${process.pid} 1024 0:04.25 analyzer child\n`);
    expect(rows).toEqual([{pid:process.pid,ppid:1,rssMB:2,cpuSeconds:3723.5,name:'Node worker'},{pid:9001,ppid:process.pid,rssMB:1,cpuSeconds:4.25,name:'analyzer child'}]);
  });
  it('fails closed on malformed rows and empty output',()=>{
    expect(()=>parseDarwinProcessOutput('not-a-process-row')).toThrow(/Malformed macOS/);expect(()=>parseDarwinProcessOutput('')).toThrow(/no processes/);
  });
  it('runs the real ps branch and excludes the sampler and its descendants',async()=>{
    const output=[`4321 1 10 0:00.01 ps`,`4322 4321 10 0:00.01 ps-child`,`${process.pid} 1 2048 0:01.00 node`,`9001 ${process.pid} 1024 0:02.00 analyzer`,`9002 9001 512 0:01.00 analyzer-child`].join('\n');processMock.spawn.mockReturnValue(samplerChild(output));
    const rows=await darwinProcesses();expect(processMock.spawn).toHaveBeenCalledWith('/bin/ps',['-axo','pid=,ppid=,rss=,time=,comm='],{windowsHide:true});expect(rows.map(row=>row.pid)).toEqual([process.pid,9001,9002]);
  });
  it('rejects nonzero sampler exits and dispatches darwin separately from linux',async()=>{
    processMock.spawn.mockReturnValue(samplerChild('',1));await expect(darwinProcesses()).rejects.toThrow(/exited with code 1/);expect(defaultProcessSampler('darwin')).toBe(darwinProcesses);expect(defaultProcessSampler('linux')).not.toBe(darwinProcesses);
  });
});

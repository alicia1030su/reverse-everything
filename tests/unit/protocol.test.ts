import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { inferProtocol } from '@reverse/core';
import { canonical, evidenceHash } from '@reverse/evidence';
interface Trace {format:string;target:{name:string};messages:{seq:number;at:string;direction:'client'|'server';type:string;payload:Record<string,unknown>}[]}
describe('protocol inference',()=>{
  it('derives types, fields and transitions only from observed trace messages',async()=>{const trace=JSON.parse(await readFile('examples/demo-game/captured-trace.json','utf8')) as Trace;const model=inferProtocol(trace);expect(model.messageTypes.map(m=>m.type)).toEqual(expect.arrayContaining(['hello','welcome','login','login_ok','player_state','move','logout','logout_ok']));const login=model.messageTypes.find(m=>m.type==='login')!;expect(login.fields).toEqual(expect.arrayContaining([expect.objectContaining({path:'username',type:'string',confidence:'EVIDENCE'})]));expect(model.transitions.find(t=>t.from==='client:login'&&t.to==='server:login_ok')).toBeTruthy();expect(model.requestResponses.find(r=>r.request==='login')?.responses).toEqual(['login_ok','player_state']);});
  it('marks missing responses as unknown',()=>{const model=inferProtocol({format:'replay-trace/v1',target:{name:'x'},messages:[{seq:1,at:'',direction:'client',type:'mystery',payload:{x:1}}]});expect(model.unknowns).toContain('No server response observed for mystery');});
});
describe('evidence canonicalization',()=>{it('is stable across object key order',async()=>{expect(canonical({b:2,a:1})).toBe(canonical({a:1,b:2}));expect(await evidenceHash({b:2,a:1})).toBe(await evidenceHash({a:1,b:2}));});});

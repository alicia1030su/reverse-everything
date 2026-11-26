export interface TokenBudget { input:number; output:number }
export function estimateTokens(text:string):number { return Math.ceil(text.length/4); }
export function withinBudget(text:string,budget:TokenBudget):boolean { return estimateTokens(text)<=Math.max(0,budget.input-budget.output); }
export function truncateToTokenBudget(text:string,maxTokens:number):string { return text.slice(0,Math.max(0,maxTokens*4)); }
export function redactSecrets(text:string):string { return text.replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+/gi,'$1[REDACTED]').replace(/((?:api[_-]?key|password|passwd|pwd|secret|token|credential|authorization|cookie|session[_-]?(?:id|key)?)\s*[:=]\s*["']?)[A-Za-z0-9._~+\/-]{8,}/gi,'$1[REDACTED]'); }
const SENSITIVE_KEY=/^(?:password|passwd|pwd|secret|token|jwt|bearer|credential|credentials|authorization|cookie|api[_-]?key|private[_-]?key|access[_-]?key|signing[_-]?key|session[_-]?(?:id|key)?|auth|proof|client[_-]?secret|refresh[_-]?token)$/i;
const EMBEDDED_SECRET=/(?:Bearer\s+)[A-Za-z0-9._~+\/-]+|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b|(?:\b(?:password|passwd|pwd|token|secret|api[_-]?key|authorization)\s*[:=]\s*)[^\s,;]+/gi;
function bounded(value:unknown,depth:number,nodes:{count:number},seen:Set<object>):unknown{
  if(nodes.count++>4096||depth>12)return '[TRUNCATED]';
  if(typeof value==='string')return value.replace(EMBEDDED_SECRET,'[REDACTED]').slice(0,16384);
  if(typeof value==='number'||typeof value==='boolean'||value===null)return value;
  if(typeof value!=='object')return String(value).slice(0,1024);
  if(seen.has(value))return '[CIRCULAR]';seen.add(value);
  if(Array.isArray(value)){const out=value.slice(0,256).map(item=>bounded(item,depth+1,nodes,seen));seen.delete(value);return out;}
  const out:Record<string,unknown>={};for(const [key,item] of Object.entries(value as Record<string,unknown>).slice(0,256)){out[key]=SENSITIVE_KEY.test(key)?'[REDACTED]':bounded(item,depth+1,nodes,seen);}seen.delete(value);return out;
}
export function redactDataForAi(value:unknown):unknown{return bounded(value,0,{count:0},new Set());}
export function stringifyForAi(value:unknown,maxLength=120000):string{return JSON.stringify(redactDataForAi(value)).slice(0,maxLength);}

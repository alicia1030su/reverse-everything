export interface TokenBudget { input:number; output:number }
export function estimateTokens(text:string):number { return Math.ceil(text.length/4); }
export function withinBudget(text:string,budget:TokenBudget):boolean { return estimateTokens(text)<=Math.max(0,budget.input-budget.output); }
export function truncateToTokenBudget(text:string,maxTokens:number):string { return text.slice(0,Math.max(0,maxTokens*4)); }
export function redactSecrets(text:string):string { return text.replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+/gi,'$1[REDACTED]').replace(/((?:api[_-]?key|password|secret|token)\s*[:=]\s*["']?)[A-Za-z0-9._~+\/-]{12,}/gi,'$1[REDACTED]'); }

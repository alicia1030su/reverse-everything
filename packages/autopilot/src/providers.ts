/** Model management V4. Secrets are held by the host application, never in profiles. */
export const MODEL_ROLES = ['main','light','code','multimodal','reviewer','fallback'] as const;
export type ModelRole = typeof MODEL_ROLES[number];
export type ProviderKind = 'openai-compatible'|'ollama'|'custom';
export type ProviderCapability = 'chat'|'stream'|'tools'|'structuredOutput'|'vision';

export interface ProviderCapabilities {
  chat:boolean; stream:boolean; tools:boolean; structuredOutput:boolean; vision:boolean;
  maxContextTokens?:number;
}
export interface ProviderLimits {
  timeoutMs:number; retries:number; rateLimitPerMinute:number;
  maxTokensPerRequest:number; maxTokensPerTask:number; maxCostUsdPerTask:number;
  inputCostPerMillionUsd?:number; outputCostPerMillionUsd?:number;
}
export interface ProviderProfile {
  id:string; name:string; kind:ProviderKind; baseUrl:string; model:string;
  apiKeyRef?:string; enabled:boolean; priority:number; roles:ModelRole[];
  capabilities:ProviderCapabilities; limits:ProviderLimits;
  createdAt:string; updatedAt:string;
}
export type RoleAssignments = Partial<Record<Exclude<ModelRole,'fallback'>,string[]>>;
export interface ModelProviderSettings {
  version:4; providers:ProviderProfile[]; roleAssignments:RoleAssignments; updatedAt:string;
}
export interface SecretStore {
  get(ref:string):Promise<string|null>;
  set(ref:string,value:string):Promise<void>;
  delete(ref:string):Promise<void>;
  has(ref:string):Promise<boolean>;
}
export interface ModelProviderSettingsStore {
  load():Promise<ModelProviderSettings|null>;
  save(settings:ModelProviderSettings):Promise<void>;
}
export interface ModelUsage { promptTokens:number; completionTokens:number; totalTokens:number }
export interface ModelRequest {
  role:ModelRole; prompt:string; system?:string; taskId?:string; schema?:JsonSchema;
  requiredCapabilities?:ProviderCapability[]; maxTokens?:number; temperature?:number;
  signal?:AbortSignal;
}
export interface ModelResult {
  content:string; parsed?:unknown; providerId:string; model:string; usage:ModelUsage;
  costUsd:number; attempts:number;
}
export interface ProviderPublicView extends Omit<ProviderProfile,'apiKeyRef'> {
  apiKeyRef?:string; hasApiKey:boolean;
}

export type JsonSchema = {
  type?:'object'|'array'|'string'|'number'|'integer'|'boolean'|'null';
  properties?:Record<string,JsonSchema>; required?:string[]; additionalProperties?:boolean;
  items?:JsonSchema; enum?:unknown[]; const?:unknown; minLength?:number; maxLength?:number;
  minimum?:number; maximum?:number; minItems?:number; maxItems?:number;
  description?:string; $ref?:string; definitions?:Record<string,JsonSchema>;
  allOf?:JsonSchema[]; anyOf?:JsonSchema[];
};

export class ModelProviderError extends Error {
  constructor(message:string,readonly code:string,readonly retryable=false,readonly status?:number){
    super(message); this.name='ModelProviderError';
  }
}

interface HttpLikeResponse { ok:boolean; status:number; text():Promise<string> }
export type FetchLike = (url:string,init?:{method?:string;headers?:Record<string,string>;body?:string;signal?:AbortSignal})=>Promise<HttpLikeResponse>;
interface Candidate { profile:ProviderProfile; apiKey:string }
interface Budget { tokens:number; costMicrousd:number }

const DEFAULT_LIMITS:ProviderLimits = {
  timeoutMs:60_000,retries:1,rateLimitPerMinute:60,maxTokensPerRequest:4096,
  maxTokensPerTask:100_000,maxCostUsdPerTask:5,
};
const nowIso=()=>new Date().toISOString();

function assertProfile(input:ProviderProfile):void {
  if(!input.id||!input.name||!input.baseUrl||!input.model)throw new ModelProviderError('Provider id/name/baseUrl/model are required','INVALID_PROVIDER');
  let url:URL;
  try{url=new URL(input.baseUrl);}catch{throw new ModelProviderError('Provider baseUrl must be an absolute URL','INVALID_PROVIDER');}
  if(!['http:','https:'].includes(url.protocol))throw new ModelProviderError('Provider baseUrl must use HTTP(S)','INVALID_PROVIDER');
  if(input.roles.some(role=>!MODEL_ROLES.includes(role)))throw new ModelProviderError('Unknown model role','INVALID_PROVIDER');
  if(input.limits.timeoutMs<=0||input.limits.rateLimitPerMinute<=0||input.limits.maxTokensPerRequest<=0||input.limits.maxTokensPerTask<=0||input.limits.maxCostUsdPerTask<0)throw new ModelProviderError('Invalid provider limits','INVALID_PROVIDER');
}
function normalizedLimits(limits:Partial<ProviderLimits>):ProviderLimits{return {...DEFAULT_LIMITS,...limits};}
function costMicrousd(profile:ProviderProfile,input:number,output:number):number {
  const inputCost=profile.limits.inputCostPerMillionUsd??0;
  const outputCost=profile.limits.outputCostPerMillionUsd??0;
  return Math.ceil(input*inputCost+output*outputCost); // tokens × USD/million = micro-USD.
}
function safeError(error:unknown):ModelProviderError {
  if(error instanceof ModelProviderError)return error;
  const message=error instanceof Error?error.message:'Unknown provider failure';
  return new ModelProviderError(message,'PROVIDER_ERROR',true);
}
function redact(text:string,secrets:string[]):string {
  let output=text;
  for(const secret of secrets)if(secret.length>=4)output=output.split(secret).join('[REDACTED]');
  return output.replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi,'Bearer [REDACTED]').slice(0,500);
}

/** Small JSON Schema validator for the model-output subset used by Autopilot. */
export function validateJsonSchema(value:unknown,schema:JsonSchema,root:JsonSchema=schema,path='$'):string[] {
  if(schema.$ref){
    const ref=schema.$ref.replace(/^#\//,'').split('/');
    let target:unknown=root;
    for(const part of ref)target=target&&typeof target==='object'?(target as Record<string,unknown>)[part]:undefined;
    if(!target||typeof target!=='object')return [`${path}: unresolved schema reference ${schema.$ref}`];
    return validateJsonSchema(value,target as JsonSchema,root,path);
  }
  if(schema.allOf){const errors=schema.allOf.flatMap(part=>validateJsonSchema(value,part,root,path));if(errors.length)return errors;}
  if(schema.anyOf&&!schema.anyOf.some(part=>validateJsonSchema(value,part,root,path).length===0))return [`${path}: does not match anyOf`];
  const errors:string[]=[];
  if(schema.const!==undefined&&JSON.stringify(value)!==JSON.stringify(schema.const))errors.push(`${path}: expected const ${JSON.stringify(schema.const)}`);
  if(schema.enum&&!schema.enum.some(item=>JSON.stringify(item)===JSON.stringify(value)))errors.push(`${path}: value is not in enum`);
  if(schema.type==='null'){if(value!==null)errors.push(`${path}: expected null`);return errors;}
  if(schema.type==='object'){
    if(!value||typeof value!=='object'||Array.isArray(value))return [`${path}: expected object`];
    const object=value as Record<string,unknown>;
    for(const key of schema.required??[])if(!(key in object))errors.push(`${path}.${key}: required property missing`);
    for(const [key,item] of Object.entries(object)){
      const child=schema.properties?.[key];
      if(child)errors.push(...validateJsonSchema(item,child,root,`${path}.${key}`));
      else if(schema.additionalProperties===false)errors.push(`${path}.${key}: additional property not allowed`);
    }
  }else if(schema.type==='array'){
    if(!Array.isArray(value))return [`${path}: expected array`];
    if(schema.minItems!==undefined&&value.length<schema.minItems)errors.push(`${path}: expected at least ${schema.minItems} items`);
    if(schema.maxItems!==undefined&&value.length>schema.maxItems)errors.push(`${path}: expected at most ${schema.maxItems} items`);
    value.forEach((item,index)=>errors.push(...validateJsonSchema(item,schema.items??{},root,`${path}[${index}]`)));
  }else if(schema.type==='string'){
    if(typeof value!=='string')return [`${path}: expected string`];
    if(schema.minLength!==undefined&&value.length<schema.minLength)errors.push(`${path}: string too short`);
    if(schema.maxLength!==undefined&&value.length>schema.maxLength)errors.push(`${path}: string too long`);
  }else if(schema.type==='number'||schema.type==='integer'){
    if(typeof value!=='number'||!Number.isFinite(value)||(schema.type==='integer'&&!Number.isInteger(value)))return [`${path}: expected ${schema.type}`];
    if(schema.minimum!==undefined&&value<schema.minimum)errors.push(`${path}: below minimum`);
    if(schema.maximum!==undefined&&value>schema.maximum)errors.push(`${path}: above maximum`);
  }else if(schema.type==='boolean'&&typeof value!=='boolean')errors.push(`${path}: expected boolean`);
  return errors;
}

export function parseStructuredContent(content:string,schema:JsonSchema):unknown {
  let candidate=content.trim();
  const fenced=candidate.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if(fenced?.[1])candidate=fenced[1].trim();
  let value:unknown;
  try{value=JSON.parse(candidate);}catch{throw new ModelProviderError('Model output is not valid JSON','STRUCTURED_OUTPUT_INVALID');}
  const errors=validateJsonSchema(value,schema);
  if(errors.length)throw new ModelProviderError(`Model output failed schema validation: ${errors.join('; ')}`,'STRUCTURED_OUTPUT_SCHEMA');
  return value;
}

export class ModelProviderService {
  private providers:ProviderProfile[];
  private roleAssignments:RoleAssignments;
  private readonly budgets=new Map<string,Budget>();
  private readonly rateWindows=new Map<string,number[]>();
  constructor(options:{
    settings?:ModelProviderSettings; providers?:ProviderProfile[]; roleAssignments?:RoleAssignments;
    secretStore:SecretStore; settingsStore?:ModelProviderSettingsStore; fetchImpl?:FetchLike; now?:()=>number;
  }){
    this.secretStore=options.secretStore;
    this.settingsStore=options.settingsStore;
    this.fetchImpl=options.fetchImpl??(globalThis.fetch as unknown as FetchLike);
    this.now=options.now??Date.now;
    this.providers=(options.settings?.providers??options.providers??[]).map(profile=>({...profile,limits:normalizedLimits(profile.limits)}));
    this.roleAssignments=options.settings?.roleAssignments??options.roleAssignments??{};
    this.providers.forEach(assertProfile);
  }
  private readonly secretStore:SecretStore;
  private readonly settingsStore:ModelProviderSettingsStore|undefined;
  private readonly fetchImpl:FetchLike;
  private readonly now:()=>number;

  async initialize():Promise<void>{
    if(!this.settingsStore)return;
    const settings=await this.settingsStore.load();
    if(!settings||settings.version!==4)return;
    this.providers=settings.providers.map(profile=>({...profile,limits:normalizedLimits(profile.limits)}));
    this.roleAssignments=settings.roleAssignments;
    this.providers.forEach(assertProfile);
  }
  getSettings():ModelProviderSettings{return {version:4,providers:this.publicProviders(),roleAssignments:structuredClone(this.roleAssignments),updatedAt:nowIso()};}
  getUsage():{taskId:string;tokens:number;costUsd:number}[]{
    return [...this.budgets.entries()].map(([taskId,budget])=>({taskId,tokens:budget.tokens,costUsd:budget.costMicrousd/1_000_000})).sort((a,b)=>a.taskId.localeCompare(b.taskId));
  }
  listProviders():ProviderPublicView[]{return this.publicProviders();}
  private publicProviders():ProviderPublicView[]{return this.providers.map(({apiKeyRef,...profile})=>({...profile,...(apiKeyRef?{apiKeyRef}:{}),hasApiKey:Boolean(apiKeyRef)}));}
  private async persist():Promise<void>{if(this.settingsStore)await this.settingsStore.save({...this.getSettings(),providers:this.providers});}

  async upsertProvider(profile:ProviderProfile):Promise<ProviderPublicView>{
    assertProfile(profile);
    const previous=this.providers.find(item=>item.id===profile.id);
    const next={...profile,limits:normalizedLimits(profile.limits),createdAt:previous?.createdAt??profile.createdAt??nowIso(),updatedAt:nowIso()};
    this.providers=previous?this.providers.map(item=>item.id===profile.id?next:item):[...this.providers,next];
    await this.persist();
    const view=this.listProviders().find(item=>item.id===profile.id);
    if(!view)throw new ModelProviderError('Provider was not saved','INTERNAL');
    return view;
  }
  async removeProvider(id:string):Promise<void>{this.providers=this.providers.filter(profile=>profile.id!==id);await this.persist();}
  async setRoleAssignments(assignments:RoleAssignments):Promise<void>{
    for(const [role,ids] of Object.entries(assignments)){
      if(!MODEL_ROLES.includes(role as ModelRole)||role==='fallback')throw new ModelProviderError('Invalid role assignment','INVALID_ROLE');
      for(const id of ids??[])if(!this.providers.some(profile=>profile.id===id))throw new ModelProviderError(`Unknown provider ${id}`,'INVALID_ROLE');
    }
    this.roleAssignments=structuredClone(assignments);await this.persist();
  }

  private async resolve(role:ModelRole,required:ProviderCapability[]=[]):Promise<Candidate[]>{
    const candidates:Candidate[]=[];
    if(role==='fallback'){
      for(const profile of this.providers.filter(item=>item.enabled&&item.roles.includes('fallback')))candidates.push(await this.candidate(profile));
      return candidates;
    }
    const assigned=this.roleAssignments[role];
    const primaryIds=assigned??this.providers.filter(profile=>profile.enabled&&profile.roles.includes(role)).sort((a,b)=>a.priority-b.priority).map(profile=>profile.id);
    for(const id of primaryIds){
      const profile=this.providers.find(item=>item.id===id&&item.enabled);
      if(!profile)continue;
      if(required.some(cap=>cap==='vision'?!profile.capabilities.vision:!profile.capabilities[cap]))continue;
      candidates.push(await this.candidate(profile));
    }
    const seen=new Set(candidates.map(item=>item.profile.id));
    for(const profile of this.providers.filter(item=>item.enabled&&item.roles.includes('fallback')).sort((a,b)=>a.priority-b.priority)){
      if(seen.has(profile.id))continue;
      if(required.some(cap=>cap==='vision'?!profile.capabilities.vision:!profile.capabilities[cap]))continue;
      candidates.push(await this.candidate(profile));seen.add(profile.id);
    }
    return candidates;
  }
  private async candidate(profile:ProviderProfile):Promise<Candidate>{
    const apiKey=profile.apiKeyRef?(await this.secretStore.get(profile.apiKeyRef))??'':'';
    return {profile,apiKey};
  }
  private checkRate(profile:ProviderProfile):void{
    const cutoff=this.now()-60_000;
    const window=(this.rateWindows.get(profile.id)??[]).filter(time=>time>cutoff);
    if(window.length>=profile.limits.rateLimitPerMinute)throw new ModelProviderError('Provider rate limit exceeded','RATE_LIMITED',true,429);
    window.push(this.now());this.rateWindows.set(profile.id,window);
  }
  private reserve(taskId:string,profile:ProviderProfile,inputTokens:number,outputTokens:number):void{
    const budget=this.budgets.get(taskId)??{tokens:0,costMicrousd:0};
    const reservedTokens=inputTokens+outputTokens;
    if(budget.tokens+reservedTokens>profile.limits.maxTokensPerTask)throw new ModelProviderError('Task token budget exceeded','TOKEN_BUDGET_EXCEEDED');
    const estimate=costMicrousd(profile,inputTokens,outputTokens);
    if(budget.costMicrousd+estimate>profile.limits.maxCostUsdPerTask*1_000_000)throw new ModelProviderError('Task cost budget exceeded','COST_BUDGET_EXCEEDED');
    budget.tokens+=reservedTokens;budget.costMicrousd+=estimate;this.budgets.set(taskId,budget);
  }
  private settle(taskId:string,profile:ProviderProfile,reserved:Budget,usage:ModelUsage):number{
    const budget=this.budgets.get(taskId)??{tokens:0,costMicrousd:0};
    const actual=costMicrousd(profile,usage.promptTokens,usage.completionTokens);
    budget.tokens=budget.tokens-reserved.tokens+usage.totalTokens;
    budget.costMicrousd+=actual-reserved.costMicrousd;
    if(budget.tokens>profile.limits.maxTokensPerTask)throw new ModelProviderError('Task token budget exceeded','TOKEN_BUDGET_EXCEEDED');
    if(budget.costMicrousd>profile.limits.maxCostUsdPerTask*1_000_000)throw new ModelProviderError('Task cost budget exceeded','COST_BUDGET_EXCEEDED');
    this.budgets.set(taskId,budget);return actual/1_000_000;
  }
  private release(taskId:string,reserved:Budget):void{
    const budget=this.budgets.get(taskId);if(!budget)return;
    budget.tokens=Math.max(0,budget.tokens-reserved.tokens);
    budget.costMicrousd-=reserved.costMicrousd;
    if(budget.tokens===0&&budget.costMicrousd<=0)this.budgets.delete(taskId);else this.budgets.set(taskId,budget);
  }

  async complete(request:ModelRequest):Promise<ModelResult>{
    const candidates=await this.resolve(request.role,request.requiredCapabilities??[]);
    if(!candidates.length)throw new ModelProviderError(`No enabled provider for role ${request.role}`,'NO_PROVIDER');
    const taskId=request.taskId??'default';
    const failures:ModelProviderError[]=[];
    for(const candidate of candidates){
      try{return await this.completeWith(candidate,request,taskId);}
      catch(error){
        const failure=safeError(error);
        if(failure.code==='TOKEN_BUDGET_EXCEEDED'||failure.code==='COST_BUDGET_EXCEEDED'||failure.code==='NO_PROVIDER')throw failure;
        failures.push(failure);
        if(!failure.retryable)break;
      }
    }
    const summary=failures.map(failure=>failure.code).join(', ');
    throw new ModelProviderError(`All model providers failed (${summary})`,'ALL_PROVIDERS_FAILED');
  }

  private async completeWith(candidate:Candidate,request:ModelRequest,taskId:string):Promise<ModelResult>{
    const {profile,apiKey}=candidate;
    if(!profile.capabilities.chat)throw new ModelProviderError('Provider chat capability is not verified','CAPABILITY_UNSUPPORTED');
    if((request.requiredCapabilities??[]).some(cap=>cap==='vision'?!profile.capabilities.vision:!profile.capabilities[cap]))throw new ModelProviderError('Required capability is unsupported','CAPABILITY_UNSUPPORTED');
    const maxTokens=Math.min(request.maxTokens??profile.limits.maxTokensPerRequest,profile.limits.maxTokensPerRequest,profile.capabilities.maxContextTokens??Number.MAX_SAFE_INTEGER);
    if(maxTokens<=0)throw new ModelProviderError('Invalid maxTokens','INVALID_REQUEST');
    const estimatedInputTokens=Math.ceil(`${request.system??''}${request.prompt}`.length/4);
    this.reserve(taskId,profile,estimatedInputTokens,maxTokens);
    const reserved:Budget={tokens:estimatedInputTokens+maxTokens,costMicrousd:costMicrousd(profile,estimatedInputTokens,maxTokens)};
    let lastError:ModelProviderError|undefined;
    for(let attempt=0;attempt<=profile.limits.retries;attempt++){
      try{
        this.checkRate(profile);
        const body=this.requestBody(profile,request,maxTokens);
        const response=await this.http(profile,apiKey,body,request.signal);
        if(!response.ok)throw new ModelProviderError(`Provider HTTP ${response.status}`,'PROVIDER_HTTP',response.status===408||response.status===429||response.status>=500,response.status);
        const payload=await this.parseResponse(response,estimatedInputTokens,maxTokens);
        const content=payload.content;
        if(!content)throw new ModelProviderError('Provider returned empty content','EMPTY_RESPONSE',true);
        const usage={promptTokens:payload.promptTokens,completionTokens:payload.completionTokens,totalTokens:payload.promptTokens+payload.completionTokens};
        if(usage.totalTokens>maxTokens&&payload.promptTokens+maxTokens>profile.limits.maxTokensPerTask)throw new ModelProviderError('Task token budget exceeded','TOKEN_BUDGET_EXCEEDED');
        const parsed=request.schema?parseStructuredContent(content,request.schema):undefined;
        const costUsd=this.settle(taskId,profile,reserved,usage);
        return {content,...(request.schema?{parsed}:{}),providerId:profile.id,model:profile.model,usage,costUsd,attempts:attempt+1};
      }catch(error){lastError=safeError(error);if(!lastError.retryable||attempt===profile.limits.retries)break;}
    }
    this.release(taskId,reserved);
    throw lastError??new ModelProviderError('Provider failed','PROVIDER_ERROR',true);
  }

  private requestBody(profile:ProviderProfile,request:ModelRequest,maxTokens:number):Record<string,unknown>{
    const messages:Record<string,string>[]=[];
    if(request.system)messages.push({role:'system',content:request.system});
    messages.push({role:'user',content:request.prompt});
    const body:Record<string,unknown>={model:profile.model,messages,stream:false};
    if(profile.kind==='ollama')body.options={num_predict:maxTokens};else body.max_tokens=maxTokens;
    if(request.temperature!==undefined)body.temperature=request.temperature;
    if(request.schema)body.response_format={type:'json_schema',json_schema:{name:'autopilot_result',strict:true,schema:request.schema}};
    return body;
  }
  private endpoint(profile:ProviderProfile):string{
    const url=new URL(profile.baseUrl);
    const path=url.pathname.replace(/\/+$/,'');
    url.pathname=profile.kind==='ollama'?`${path}/api/chat`:`${path}/chat/completions`;
    return url.toString();
  }
  private async http(profile:ProviderProfile,apiKey:string,body:Record<string,unknown>,signal?:AbortSignal):Promise<HttpLikeResponse>{
    const headers:Record<string,string>={'content-type':'application/json'};
    if(apiKey)headers.authorization=`Bearer ${apiKey}`;
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),profile.limits.timeoutMs);
    const abort=()=>controller.abort();
    signal?.addEventListener('abort',abort,{once:true});
    try{
      return await this.fetchImpl(this.endpoint(profile),{method:'POST',headers,body:JSON.stringify(body),signal:controller.signal});
    }catch(error){
      if(signal?.aborted)throw new ModelProviderError('Model request aborted','ABORTED');
      throw new ModelProviderError(redact(error instanceof Error?error.message:'Network error',[apiKey]),'NETWORK_ERROR',true);
    }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
  }
  private async parseResponse(response:HttpLikeResponse,estimatedInputTokens:number,maxTokens:number):Promise<{content:string;promptTokens:number;completionTokens:number}>{
    const text=await response.text();
    let payload:unknown;
    try{payload=JSON.parse(text);}catch{throw new ModelProviderError('Provider returned non-JSON response','INVALID_RESPONSE',true);}
    if(!payload||typeof payload!=='object')throw new ModelProviderError('Invalid provider response','INVALID_RESPONSE',true);
    const data=payload as Record<string,unknown>;
    const choice=Array.isArray(data.choices)?data.choices[0] as Record<string,unknown>|undefined:undefined;
    const message=choice?.message as Record<string,unknown>|undefined;
    const content=typeof message?.content==='string'?message.content:'';
    const usage=(data.usage??(data.prompt_eval_count!==undefined?{prompt_tokens:data.prompt_eval_count,completion_tokens:data.eval_count}:undefined)) as Record<string,unknown>|undefined;
    const tokenCount=(value:unknown,fallback:number):number=>{
      if(value===undefined)return fallback;
      if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0)throw new ModelProviderError('Invalid token usage','INVALID_RESPONSE');
      return value;
    };
    // Missing usage is billed conservatively at the full reserved amount; never release budget on unknown consumption.
    const promptTokens=tokenCount(usage?.prompt_tokens!==undefined?usage.prompt_tokens:usage?.input_tokens,estimatedInputTokens);
    const completionTokens=tokenCount(usage?.completion_tokens!==undefined?usage.completion_tokens:usage?.output_tokens,maxTokens);
    if(!Number.isSafeInteger(promptTokens+completionTokens))throw new ModelProviderError('Invalid token usage','INVALID_RESPONSE');
    return {content,promptTokens,completionTokens};
  }

  /** Actively probes chat, streaming, tool calling and structured output; only successes are marked true. */
  async detectCapabilities(providerId:string):Promise<ProviderCapabilities>{
    const profile=this.providers.find(item=>item.id===providerId);
    if(!profile)throw new ModelProviderError('Unknown provider','NOT_FOUND',false,404);
    const {apiKey}=await this.candidate(profile);
    const capabilities:ProviderCapabilities={chat:false,stream:false,tools:false,structuredOutput:false,vision:false,...(profile.capabilities.maxContextTokens?{maxContextTokens:profile.capabilities.maxContextTokens}:{})};
    const probe=async(body:Record<string,unknown>):Promise<HttpLikeResponse>=>this.http(profile,apiKey,{model:profile.model,messages:[{role:'user',content:'Return OK.'}],max_tokens:16,...body});
    const checks:Array<[Exclude<ProviderCapability,'vision'>,Record<string,unknown>]>=[
      ['chat',{}],['stream',{stream:true}],
      ['tools',{tools:[{type:'function',function:{name:'noop',description:'No operation',parameters:{type:'object',properties:{}}}}]}],
      ['structuredOutput',{response_format:{type:'json_schema',json_schema:{name:'probe',strict:true,schema:{type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false}}}}],
    ];
    for(const [capability,body] of checks){
      try{const response=await probe(body);capabilities[capability]=response.ok&&Boolean(await response.text());}
      catch{capabilities[capability]=false;}
    }
    profile.capabilities=capabilities;profile.updatedAt=nowIso();await this.persist();
    return {...capabilities};
  }
}

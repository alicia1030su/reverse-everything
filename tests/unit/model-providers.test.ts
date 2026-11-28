import { describe,expect,it,vi } from 'vitest';
import { ModelProviderService,ModelProviderError,parseStructuredContent,validateJsonSchema } from '../../packages/autopilot/src/providers.js';
import type { FetchLike,ProviderProfile,SecretStore } from '../../packages/autopilot/src/providers.js';

const response=(body:unknown,status=200)=>({ok:status>=200&&status<300,status,text:async()=>typeof body==='string'?body:JSON.stringify(body)});
const completion=(content:string,promptTokens=10,completionTokens=5)=>({choices:[{message:{content}}],usage:{prompt_tokens:promptTokens,completion_tokens:completionTokens}});
const secretStore=():SecretStore=>({get:async()=> 'sk-super-secret',set:async()=>{},delete:async()=>{},has:async()=>true});
const profile=(overrides:Partial<ProviderProfile>={}):ProviderProfile=>({
  id:'p1',name:'Primary',kind:'openai-compatible',baseUrl:'https://models.example/v1',model:'test-model',apiKeyRef:'key-1',
  enabled:true,priority:1,roles:['main','fallback'],
  capabilities:{chat:true,stream:true,tools:true,structuredOutput:true,vision:false},
  limits:{timeoutMs:1000,retries:1,rateLimitPerMinute:60,maxTokensPerRequest:256,maxTokensPerTask:1000,maxCostUsdPerTask:1,inputCostPerMillionUsd:1,outputCostPerMillionUsd:2},
  createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z',...overrides,
});
const service=(fetchImpl:FetchLike,providers=[profile()])=>new ModelProviderService({providers,secretStore:secretStore(),fetchImpl});

describe('ModelProviderService V4',()=>{
  it('detects capabilities with actual probes and preserves unverified vision',async()=>{
    const fetchImpl=vi.fn<FetchLike>().mockResolvedValue(response(completion('OK')));
    const instance=service(fetchImpl);
    const capabilities=await instance.detectCapabilities('p1');
    expect(capabilities).toMatchObject({chat:true,stream:true,tools:true,structuredOutput:true,vision:false});
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(fetchImpl.mock.calls[1]?.[1]?.body).toContain('"stream":true');
    expect(fetchImpl.mock.calls[3]?.[1]?.body).toContain('json_schema');
  });

  it('falls back after retryable HTTP failure and records attempts',async()=>{
    const fetchImpl=vi.fn<FetchLike>()
      .mockResolvedValueOnce(response({error:'busy'},503)).mockResolvedValueOnce(response({error:'busy'},503))
      .mockResolvedValueOnce(response(completion('{"ok":true}')));
    const fallback=profile({id:'p2',name:'Fallback',roles:['fallback'],priority:2});
    const result=await service(fetchImpl,[profile(),fallback]).complete({role:'main',taskId:'t1',schema:{type:'object',properties:{ok:{type:'boolean'}},required:['ok']}});
    expect(result.providerId).toBe('p2');
    expect(result.attempts).toBe(1);
    expect(result.parsed).toEqual({ok:true});
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('enforces per-task token budget',async()=>{
    const limited=profile({limits:{...profile().limits,maxTokensPerTask:20}});
    await expect(service(vi.fn<FetchLike>().mockResolvedValue(response(completion('hello'))),[limited]).complete({role:'main',taskId:'budget',prompt:'x'.repeat(100)})).rejects.toMatchObject({code:'TOKEN_BUDGET_EXCEEDED'});
  });

  it('keeps token usage cumulative across consecutive requests',async()=>{
    const limited=profile({limits:{...profile().limits,maxTokensPerRequest:20,maxTokensPerTask:50}});
    const instance=service(vi.fn<FetchLike>().mockResolvedValue(response(completion('hello',10,5))),[limited]);
    await expect(instance.complete({role:'main',taskId:'cumulative',prompt:'x'})).resolves.toMatchObject({usage:{totalTokens:15}});
    await expect(instance.complete({role:'main',taskId:'cumulative',prompt:'x'})).resolves.toMatchObject({usage:{totalTokens:15}});
    await expect(instance.complete({role:'main',taskId:'cumulative',prompt:'x'})).rejects.toMatchObject({code:'TOKEN_BUDGET_EXCEEDED'});
  });

  it('settles actual usage into the per-task cost budget',async()=>{
    const priced=profile({limits:{...profile().limits,maxCostUsdPerTask:0.00001,inputCostPerMillionUsd:1,outputCostPerMillionUsd:2}});
    const instance=service(vi.fn<FetchLike>().mockResolvedValue(response(completion('hello',10,5))),[priced]);
    await expect(instance.complete({role:'main',taskId:'cost'})).rejects.toMatchObject({code:'COST_BUDGET_EXCEEDED'});
  });

  it('accumulates token usage across small requests without resetting prior calls',async()=>{
    const limited=profile({limits:{...profile().limits,maxTokensPerRequest:10,maxTokensPerTask:600}});
    const instance=service(vi.fn<FetchLike>().mockResolvedValue(response(completion('ok',10,50))),[limited]);
    for(let index=0;index<10;index++)await instance.complete({role:'main',taskId:'cumulative',maxTokens:10,prompt:'x'});
    expect(instance.getUsage()).toEqual([{taskId:'cumulative',tokens:600,costUsd:0.0011}]);
    await expect(instance.complete({role:'main',taskId:'cumulative',maxTokens:10,prompt:'x'})).rejects.toMatchObject({code:'TOKEN_BUDGET_EXCEEDED'});
  });

  it('conservatively settles missing usage instead of releasing reserved budget',async()=>{
    const limited=profile({limits:{...profile().limits,maxTokensPerRequest:10,maxTokensPerTask:25}});
    const instance=service(vi.fn<FetchLike>().mockResolvedValue(response({choices:[{message:{content:'ok'}}]})),[limited]);
    await instance.complete({role:'main',taskId:'missing-usage',maxTokens:10,prompt:'x'});
    await instance.complete({role:'main',taskId:'missing-usage',maxTokens:10,prompt:'x'});
    expect(instance.getUsage()).toEqual([{taskId:'missing-usage',tokens:22,costUsd:0.000042}]);
    await expect(instance.complete({role:'main',taskId:'missing-usage',maxTokens:10,prompt:'x'})).rejects.toMatchObject({code:'TOKEN_BUDGET_EXCEEDED'});
  });

  it.each([
    ['negative',{prompt_tokens:-1000,completion_tokens:-1000}],
    ['NaN',{prompt_tokens:'NaN',completion_tokens:1}],
    ['infinite',{prompt_tokens:1e999,completion_tokens:1}],
    ['unsafe integer',{prompt_tokens:Number.MAX_SAFE_INTEGER+1,completion_tokens:1}],
    ['fractional',{prompt_tokens:1.5,completion_tokens:1}],
  ])('rejects %s token usage without polluting budgets',async(_name,usage)=>{
    const instance=service(vi.fn<FetchLike>().mockResolvedValue(response({choices:[{message:{content:'ok'}}],usage})),[profile({limits:{...profile().limits,retries:0}})]);
    await expect(instance.complete({role:'main',taskId:'invalid-usage'})).rejects.toMatchObject({code:'ALL_PROVIDERS_FAILED'});
    expect(instance.getUsage()).toEqual([]);
  });

  it('rejects non-finite JSON numbers and overflowing totals',async()=>{
    for(const raw of [
      '{"choices":[{"message":{"content":"ok"}}],"usage":{"prompt_tokens":1e999,"completion_tokens":1}}',
      `{"choices":[{"message":{"content":"ok"}}],"usage":{"prompt_tokens":${Number.MAX_SAFE_INTEGER},"completion_tokens":1}}`,
    ]){
      const instance=service(vi.fn<FetchLike>().mockResolvedValue(response(raw)),[profile({limits:{...profile().limits,retries:0}})]);
      await expect(instance.complete({role:'main',taskId:'overflow'})).rejects.toMatchObject({code:'ALL_PROVIDERS_FAILED'});
      expect(instance.getUsage()).toEqual([]);
    }
  });

  it('rejects structurally invalid output without claiming success',async()=>{
    const fetchImpl=vi.fn<FetchLike>().mockResolvedValue(response(completion('{"steps":"wrong"}')));
    await expect(service(fetchImpl).complete({role:'main',taskId:'schema',schema:{type:'object',properties:{steps:{type:'array',items:{type:'string'}}},required:['steps']}})).rejects.toMatchObject({code:'ALL_PROVIDERS_FAILED'});
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('preserves redacted HTTP error details for provider compatibility diagnosis',async()=>{
    const fetchImpl=vi.fn<FetchLike>().mockResolvedValue(response({error:{message:'invalid model sk-super-secret'}},400));
    await expect(service(fetchImpl).complete({role:'main',taskId:'http-diagnostic',prompt:'x'})).rejects.toThrow(/PROVIDER_HTTP HTTP 400: .*invalid model \[REDACTED\]/);
  });

  it('never returns API keys in provider views or network errors',async()=>{
    const fetchImpl=vi.fn<FetchLike>().mockRejectedValue(new Error('failed with sk-super-secret'));
    const instance=service(fetchImpl);
    expect(JSON.stringify(await instance.listProviders())).not.toContain('sk-super-secret');
    expect((await instance.listProviders())[0]).toMatchObject({apiKeyRef:'key-1',hasApiKey:true});
    await expect(instance.complete({role:'main',taskId:'redact'})).rejects.toMatchObject({code:'ALL_PROVIDERS_FAILED'});
  });

  it('reports missing secrets honestly and records real response evidence',async()=>{
    const missing=new ModelProviderService({providers:[profile()],secretStore:{get:async()=>null,set:async()=>{},delete:async()=>{},has:async()=>false}});
    expect((await missing.listProviders())[0]).toMatchObject({hasApiKey:false});
    const fetchImpl=vi.fn<FetchLike>().mockResolvedValue({ok:true,status:200,text:async()=>JSON.stringify({id:'req-1',choices:[{message:{content:'ok'},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:5}})});
    const result=await service(fetchImpl).complete({role:'main',taskId:'evidence',prompt:'x'});
    expect(result).toMatchObject({requestId:'req-1',finishReason:'stop',usageSource:'provider',refusal:false});
    expect(result.responseSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('honors assigned role order and required multimodal capability',async()=>{
    const noVision=profile({id:'text',roles:['main']});
    const vision=profile({id:'vision',roles:['main','multimodal'],capabilities:{...profile().capabilities,vision:true}});
    const instance=service(vi.fn<FetchLike>().mockResolvedValue(response(completion('ok'))),[noVision,vision]);
    const result=await instance.complete({role:'main',taskId:'vision',requiredCapabilities:['vision']});
    expect(result.providerId).toBe('vision');
  });

  it('validates schema references and rejects unknown fields',()=>{
    const schema={type:'object' as const,properties:{ok:{type:'boolean' as const}},required:['ok'],additionalProperties:false};
    expect(validateJsonSchema({ok:true},schema)).toEqual([]);
    expect(validateJsonSchema({ok:true,extra:1},schema)[0]).toContain('additional property');
    expect(()=>parseStructuredContent('not json',schema)).toThrow(ModelProviderError);
  });
});

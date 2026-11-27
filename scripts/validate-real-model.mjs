#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ModelProviderService } from '../packages/autopilot/dist/providers.js';

const args=process.argv.slice(2);
const value=(name)=>{const index=args.indexOf(name);return index>=0?args[index+1]:undefined;};
const baseUrl=value('--base-url');
const model=value('--model');
const apiKeyEnv=value('--api-key-env')??'OPENAI_API_KEY';
const output=resolve(value('--output')??'artifacts/V008-MODEL-VALIDATION.json');
const schema={
  type:'object',
  properties:{
    objective:{type:'string',minLength:1},
    steps:{type:'array',minItems:2,maxItems:3,items:{type:'object',properties:{title:{type:'string',minLength:1},acceptance:{type:'string',minLength:1}},required:['title','acceptance'],additionalProperties:false}},
    risks:{type:'array',maxItems:3,items:{type:'string'}},
  },
  required:['objective','steps','risks'],additionalProperties:false,
};
const startedAt=new Date().toISOString();
const report=(status,extra={})=>({
  schemaVersion:'v008-model-validation-1',status,startedAt,completedAt:new Date().toISOString(),
  provider:{kind:'openai-compatible',baseUrl:baseUrl??null,model:model??null,apiKeyEnv,keyReturned:false},
  request:{task:'produce a small structured implementation plan',schema},
  ...extra,
});
const save=async(status,extra={})=>{
  await mkdir(resolve(output,'..'),{recursive:true});
  await writeFile(output,`${JSON.stringify(report(status,extra),null,2)}\n`,'utf8');
  console.log(`${status}: ${output}`);
};
if(!baseUrl||!model){
  await save('FAILED',{error:{code:'INVALID_ARGUMENTS',message:'--base-url and --model are required'},realModelCalled:false});
  process.exit(2);
}
const apiKey=process.env[apiKeyEnv];
if(!apiKey){
  await save('SKIPPED',{error:{code:'MISSING_API_KEY',message:`Environment variable ${apiKeyEnv} is not set`},realModelCalled:false});
  process.exit(2);
}
const secrets=new Map([['validation-key',apiKey]]);
const service=new ModelProviderService({
  secretStore:{get:async(ref)=>secrets.get(ref)??null,set:async(ref,value)=>{secrets.set(ref,value);},delete:async(ref)=>{secrets.delete(ref);},has:async(ref)=>secrets.has(ref)},
  providers:[{
    id:'real-validation',name:'Real validation provider',kind:'openai-compatible',baseUrl,model,apiKeyRef:'validation-key',
    enabled:true,priority:1,roles:['main'],
    capabilities:{chat:true,stream:false,tools:false,structuredOutput:true,vision:false},
    limits:{timeoutMs:120000,retries:0,rateLimitPerMinute:10,maxTokensPerRequest:1024,maxTokensPerTask:4096,maxCostUsdPerTask:1},
    createdAt:startedAt,updatedAt:startedAt,
  }],
});
try{
  const result=await service.complete({
    role:'main',taskId:'v008-real-model-validation',requiredCapabilities:['structuredOutput'],maxTokens:1024,
    system:'You are a precise planning model. Return only JSON matching the supplied schema.',
    prompt:'Create a concise plan to add a health-check endpoint to a small TypeScript API. Include two or three steps and one realistic risk.',
    schema,
  });
  if(!result.parsed)throw new Error('Structured output was not returned');
  await save('PASSED',{realModelCalled:true,result:{content:result.content,parsed:result.parsed,usage:result.usage,attempts:result.attempts},checks:{structuredSchemaValid:true,nonEmptyPlan:Array.isArray(result.parsed.steps)&&result.parsed.steps.length>0}});
}catch(error){
  const message=error instanceof Error?error.message:'Unknown validation error';
  const safe=apiKey?message.split(apiKey).join('[REDACTED]'):message;
  await save('FAILED',{realModelCalled:true,error:{code:error?.code??'VALIDATION_ERROR',message:safe},checks:{structuredSchemaValid:false}});
  process.exitCode=1;
}

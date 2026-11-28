#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ModelProviderService } from '../packages/autopilot/dist/providers.js';
import { ProgramQuery } from '../packages/program-ir/dist/query.js';
import { assertProgramIr, ghidraMetadataToProgram } from '../packages/program-ir/dist/index.js';
import { assertFinalDeliveryPassed, serializeModelResponseEvidence } from './model-evidence.mjs';

const args = process.argv.slice(2);
const value = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const baseUrl = value('--base-url');
const model = value('--model');
const apiKeyEnv = value('--api-key-env') ?? 'OPENAI_API_KEY';
const programIrPath = path.resolve(value('--program-ir') ?? 'tests/fixtures/program-ir/ghidra-metadata.json');
const outputDir = path.resolve(value('--output-dir') ?? 'artifacts/v009-real-model');
const functionSelector = value('--function') ?? 'sum_bytes';
const startedAt = new Date().toISOString();
const report = {
  schemaVersion: 'v009-real-model-validation-1', status: 'FAILED', startedAt, completedAt: null,
  realModel: { realModelCalled: false, invocation: 'real', provider: 'openai-compatible', model: model ?? null, requests: [] },
  error: null,
};

const schemas = {
  'program-analysis': { type: 'object', properties: { summary: { type: 'string', minLength: 1 }, functions: { type: 'array', minItems: 1, items: { type: 'object', properties: { name: { type: 'string' }, observations: { type: 'array', items: { type: 'string' }, minItems: 1 } }, required: ['name', 'observations'], additionalProperties: false } }, unknowns: { type: 'array', items: { type: 'string' } } }, required: ['summary', 'functions', 'unknowns'], additionalProperties: false },
  'function-understanding': { type: 'object', properties: { functionName: { type: 'string' }, behavior: { type: 'string', minLength: 1 }, inputs: { type: 'array', items: { type: 'string' } }, outputs: { type: 'array', items: { type: 'string' } }, evidenceRefs: { type: 'array', items: { type: 'string' }, minItems: 1 }, unknowns: { type: 'array', items: { type: 'string' } } }, required: ['functionName', 'behavior', 'inputs', 'outputs', 'evidenceRefs', 'unknowns'], additionalProperties: false },
  'research-plan': { type: 'object', properties: { objective: { type: 'string' }, steps: { type: 'array', minItems: 2, maxItems: 4, items: { type: 'object', properties: { title: { type: 'string' }, acceptance: { type: 'string' } }, required: ['title', 'acceptance'], additionalProperties: false } } }, required: ['objective', 'steps'], additionalProperties: false },
  'tool-selection': { type: 'object', properties: { selectedTools: { type: 'array', items: { type: 'string', enum: ['program-ir-query', 'dynamic-trace', 'symbolic-execute', 'binary-diff', 'build-test'] }, minItems: 1 }, rationale: { type: 'string', minLength: 1 } }, required: ['selectedTools', 'rationale'], additionalProperties: false },
  'behavior-hypothesis': { type: 'object', properties: { hypothesis: { type: 'string', minLength: 1 }, confidence: { type: 'number', minimum: 0, maximum: 1 }, falsification: { type: 'string', minLength: 1 } }, required: ['hypothesis', 'confidence', 'falsification'], additionalProperties: false },
  reconstruction: { type: 'object', properties: { language: { type: 'string', enum: ['c'] }, source: { type: 'string', minLength: 1 }, notes: { type: 'array', items: { type: 'string' } } }, required: ['language', 'source', 'notes'], additionalProperties: false },
  'test-repair': { type: 'object', properties: { diagnosis: { type: 'string', minLength: 1 }, source: { type: 'string', minLength: 1 }, tests: { type: 'array', items: { type: 'string' }, minItems: 1 } }, required: ['diagnosis', 'source', 'tests'], additionalProperties: false },
  'final-delivery': { type: 'object', properties: { status: { type: 'string', enum: ['PASSED', 'BLOCKED'] }, summary: { type: 'string', minLength: 1 }, deliverables: { type: 'array', items: { type: 'string' }, minItems: 1 }, limitations: { type: 'array', items: { type: 'string' } } }, required: ['status', 'summary', 'deliverables', 'limitations'], additionalProperties: false },
};

const sha = text => createHash('sha256').update(text).digest('hex');
const safe = text => String(text).split(/\r?\n/).map(line => line.slice(0, 2000)).join('\n').slice(0, 100_000);

async function save(status, error) {
  report.status = status; report.completedAt = new Date().toISOString(); report.durationMs = Date.parse(report.completedAt) - Date.parse(startedAt); report.peakMemoryMB = Number((process.resourceUsage().maxRSS / 1024).toFixed(3)); if (error) report.error = error;
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, 'real-model-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

if (!baseUrl || !model) {
  await save('BLOCKED', { code: 'INVALID_ARGUMENTS', message: '--base-url and --model are required' });
  process.exit(2);
}
const apiKey = process.env[apiKeyEnv];
if (!apiKey) {
  await save('BLOCKED', { code: 'MISSING_API_KEY', message: `Environment variable ${apiKeyEnv} is not set` });
  process.exit(2);
}

let context;
try {
  const raw = JSON.parse(await readFile(programIrPath, 'utf8'));
  const program = raw.schemaVersion === 1 ? (raw.programIr ?? raw) : ghidraMetadataToProgram(raw, 'v009-real-model-fixture');
  assertProgramIr(program, { allowPartial: true });
  const query = new ProgramQuery(program);
  const fn = query.function(functionSelector);
  const detail = query.context(fn.id);
  context = {
    programId: program.id, inputSha256: program.provenance?.inputSha256 ?? null, format: program.format, architecture: program.architecture,
    function: { id: fn.id, name: fn.name, entry: fn.entry, signature: fn.signature ?? null, callingConvention: fn.callingConvention ?? null, returnType: fn.returnType ?? null },
    instructions: detail.blocks.flatMap(block => block.instructionIds).map(id => program.instructions.find(item => item.id === id)).filter(Boolean).map(item => ({ address: item.address, mnemonic: item.mnemonic, bytes: item.bytes ?? null, pcode: item.pcode ?? [] })),
    callees: detail.callees.map(item => item.name), callers: detail.callers.map(item => item.name),
    data: detail.data.map(item => ({ address: item.address, kind: item.kind, value: item.value ?? null })),
    hypotheses: detail.hypotheses, evidence: detail.evidence,
  };
} catch (error) {
  await save('FAILED', { code: 'INVALID_PROGRAM_IR', message: error instanceof Error ? error.message : String(error) });
  process.exit(1);
}

const secrets = new Map([['validation-key', apiKey]]);
const service = new ModelProviderService({
  secretStore: { get: async ref => secrets.get(ref) ?? null, set: async (ref, value) => { secrets.set(ref, value); }, delete: async ref => { secrets.delete(ref); }, has: async ref => secrets.has(ref) },
  providers: [{
    id: 'v009-real-validation', name: 'V009 real validation provider', kind: 'openai-compatible', baseUrl, model, apiKeyRef: 'validation-key',
    enabled: true, priority: 1, roles: ['main', 'code', 'reviewer'],
    capabilities: { chat: true, stream: false, tools: false, structuredOutput: true, vision: false },
    limits: { timeoutMs: 120000, retries: 0, rateLimitPerMinute: 30, maxTokensPerRequest: 4096, maxTokensPerTask: 32768, maxCostUsdPerTask: 5 },
    createdAt: startedAt, updatedAt: startedAt,
  }],
});

const contextText = safe(JSON.stringify(context, null, 2));
const previous = {};
const stages = [
  ['program-analysis', 'Analyze the authorized Program IR evidence. Do not invent missing facts.', `Program IR context:\n${contextText}`],
  ['function-understanding', 'Explain the selected function using only the supplied evidence. Mark uncertainty explicitly.', `Selected function: ${context.function.name}\nProgram IR context:\n${contextText}`],
  ['research-plan', 'Create a minimal evidence-driven plan to validate the function behavior and reconstruct it independently.', `Function: ${context.function.name}\nSignature: ${context.function.signature ?? 'unknown'}`],
  ['tool-selection', 'Choose the smallest sufficient tool sequence from the allowlist. Do not choose tools that bypass access controls.', `Function: ${context.function.name}\nAvailable tools: program-ir-query, dynamic-trace, symbolic-execute, binary-diff, build-test`],
  ['behavior-hypothesis', 'State one falsifiable behavior hypothesis grounded in the Program IR.', `Function: ${context.function.name}\nProgram IR context:\n${contextText}`],
  ['reconstruction', 'Reconstruct the selected function as a standalone C source file. Preserve the observed signature and behavior. Do not use external libraries.', `Function: ${context.function.name}\nSignature: ${context.function.signature ?? 'unknown'}\nProgram IR context:\n${contextText}`],
  ['test-repair', 'Repair the supplied C source by removing the deliberate benchmark error. Keep behavior unchanged and add at least one concrete test.', `Deliberate failing source:\n${previous.reconstruction ? `#error deliberate repair benchmark\n${previous.reconstruction.source}` : '#error deliberate repair benchmark\nint repaired(void) { return 0; }'}`],
  ['final-delivery', 'Deliver an evidence-first summary. Status must be BLOCKED if any required evidence is missing; never claim tests that were not run.', `Function: ${context.function.name}\nAnalysis: ${safe(JSON.stringify(previous['program-analysis'] ?? {}))}\nHypothesis: ${safe(JSON.stringify(previous['behavior-hypothesis'] ?? {}))}\nReconstruction: ${safe(JSON.stringify(previous.reconstruction ?? {}))}\nRepair: ${safe(JSON.stringify(previous['test-repair'] ?? {}))}`],
];

try {
  for (const [stage, system, prompt] of stages) {
    const result = await service.complete({ role: stage === 'reconstruction' || stage === 'test-repair' ? 'code' : 'main', taskId: `v009-${stage}`, requiredCapabilities: ['structuredOutput'], maxTokens: 4096, system, prompt, schema: schemas[stage] });
    if (!result.parsed) throw new Error(`${stage} did not return structured output`);
    if (!result.requestId || result.finishReason !== 'stop' || result.usageSource !== 'provider' || result.refusal) throw new Error(`${stage} lacks complete provider response evidence`);
    const promptSha256 = sha(prompt);
    const promptPath = `prompts/${stage}.txt`; const evidencePath = `responses/${stage}.json`;
    await mkdir(path.join(outputDir, 'prompts'), { recursive: true }); await mkdir(path.join(outputDir, 'responses'), { recursive: true });
    await writeFile(path.join(outputDir, promptPath), prompt, 'utf8');
    const responseEvidence = serializeModelResponseEvidence({ stage, requestId: result.requestId, finishReason: result.finishReason, usageSource: result.usageSource, refusal: result.refusal, usage: result.usage, promptSha256, provider: 'openai-compatible', model, response: result.content, parsed: result.parsed });
    await writeFile(path.join(outputDir, evidencePath), responseEvidence.serialized, 'utf8');
    const responseSha256 = responseEvidence.sha256;
    report.realModel.requests.push({ stage, requestId: result.requestId, finishReason: result.finishReason, usageSource: result.usageSource, refusal: result.refusal, usage: result.usage, promptSha256, responseSha256, promptPath, evidencePath });
    previous[stage] = result.parsed;
    report.realModel.realModelCalled = true;
  }
  assertFinalDeliveryPassed(previous['final-delivery']);
  await save('PASSED');
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  let diagnostic = '';
  if (/no access|HTTP 403/i.test(message)) {
    try {
      const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, { headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15000) });
      if (!response.ok) diagnostic = ` Model list endpoint returned HTTP ${response.status}.`;
      else {
        const payload = await response.json();
        const list = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : Array.isArray(payload) ? payload : [];
        const ids = list.map(item => item?.id ?? item?.name).filter(value => typeof value === 'string').slice(0, 100);
        const shape = Array.isArray(payload) ? `array length ${payload.length}` : `keys ${Object.keys(payload ?? {}).join(',')}`;
        diagnostic = ids.length ? ` Accessible models: ${ids.join(', ')}` : ` Model list endpoint returned no model identifiers (${shape}). Payload: ${JSON.stringify(payload).slice(0, 4000)}`;
      }
    } catch (listError) {
      diagnostic = ` Model list diagnostic failed: ${listError instanceof Error ? listError.message : String(listError)}`;
    }
  }
  const safeMessage = `${apiKey ? message.split(apiKey).join('[REDACTED]') : message}${apiKey && diagnostic ? diagnostic.split(apiKey).join('[REDACTED]') : diagnostic}`;
  await save('FAILED', { code: error?.code ?? 'VALIDATION_ERROR', message: safeMessage });
  console.error(`Real model validation failed: ${error?.code ?? 'VALIDATION_ERROR'}: ${safeMessage}`);
  process.exitCode = 1;
}

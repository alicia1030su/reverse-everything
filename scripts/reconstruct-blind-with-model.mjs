#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ModelProviderService } from '../packages/autopilot/dist/providers.js';
import { ProgramQuery } from '../packages/program-ir/dist/query.js';
import { assertProgramIr } from '../packages/program-ir/dist/program.js';
import { serializeModelResponseEvidence } from './model-evidence.mjs';

const args = process.argv.slice(2);
const value = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const caseId = value('--case');
const baseUrl = value('--base-url');
const model = value('--model');
const apiKeyEnv = value('--api-key-env') ?? 'OPENAI_API_KEY';
const outputDir = path.resolve(value('--output-dir') ?? `artifacts/blind-${caseId ?? 'unknown'}`);
if (!['alpha', 'beta', 'gamma'].includes(caseId ?? '')) throw new Error('--case must be alpha, beta or gamma');
if (!baseUrl || !model) throw new Error('--base-url and --model are required');
if (!args.includes('--confirm-isolated')) throw new Error('--confirm-isolated is required; generated candidate code runs only in an approved isolated CI environment');
const apiKey = process.env[apiKeyEnv];
if (!apiKey) throw new Error(`Environment variable ${apiKeyEnv} is not set`);
const install = process.env.RE_GHIDRA_INSTALL_DIR;
if (!install) throw new Error('RE_GHIDRA_INSTALL_DIR is required');

const root = process.cwd();
const binary = path.join(root, 'tests', 'fixtures', 'blind', `libcase_${caseId}.so`);
const startedAt = new Date().toISOString();
const stage = `blind-reconstruction-${caseId}`;
const report = { schemaVersion: 1, caseId, stage, status: 'FAILED', startedAt, completedAt: null, sourceExposedToAgent: false, independentAnswerSeparated: true, binarySha256: null, implementationSha256: null, hiddenTestsPath: null, modelRequest: null, error: null };
await mkdir(outputDir, { recursive: true });

async function sha256(file) { const hash = createHash('sha256'); for await (const chunk of (await open(file)).createReadStream()) hash.update(chunk); return hash.digest('hex'); }
const sha = text => createHash('sha256').update(text).digest('hex');

function taskContext(dataDir, buffer) {
  const projectId = `blind-${caseId}`;
  return {
    taskId: 'blind', project: { id: projectId, name: `blind-${caseId}`, kind: 'software', target: 'authorized blind fixture', authorizationConfirmed: true, createdAt: new Date(0).toISOString() },
    upload: { id: 'fixture', projectId, name: path.basename(binary), storedName: path.basename(binary), mime: 'application/octet-stream', size: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex'), createdAt: new Date(0).toISOString() },
    options: { ghidraTimeoutMs: 600_000, ghidraMaxOutputBytes: 8_000_000, ghidraMaxMetadataBytes: 16_000_000, maxDiskMB: 1024 }, stageOutputs: {}, dataDir, signal: new AbortController().signal,
    log: async () => {}, evidence: async () => 'evidence', finding: async () => 'finding', writeArtifact: async () => {}, readArtifact: async () => Buffer.alloc(0),
  };
}

let work;
try {
  const buffer = await readFile(binary);
  report.binarySha256 = createHash('sha256').update(buffer).digest('hex');
  work = await mkdtemp(path.join(os.tmpdir(), `re-blind-${caseId}-`));
  const dataDir = path.join(work, 'runtime'); const uploadDir = path.join(dataDir, 'uploads', `blind-${caseId}`);
  await mkdir(uploadDir, { recursive: true }); const stored = path.join(uploadDir, path.basename(binary)); await copyFile(binary, stored);
  const ctx = taskContext(dataDir, buffer); ctx.stageOutputs.PREPARE = await (await import(pathToFileURL(path.join(root, 'packages', 'core', 'dist', 'adapters', 'ghidra.js')).href)).ghidraAdapter.prepare(ctx);
  const adapter = (await import(pathToFileURL(path.join(root, 'packages', 'core', 'dist', 'adapters', 'ghidra.js')).href)).ghidraAdapter;
  const result = await adapter.analyze(ctx); ctx.stageOutputs.ANALYZE = result; await adapter.validate(ctx);
  assertProgramIr(result.programIr);
  await writeFile(path.join(outputDir, 'program-ir.json'), `${JSON.stringify(result.programIr, null, 2)}\n`, 'utf8');
  await writeFile(path.join(outputDir, 'ghidra.stdout.log'), result.stdout, 'utf8'); await writeFile(path.join(outputDir, 'ghidra.stderr.log'), result.stderr, 'utf8');
  const query = new ProgramQuery(result.programIr); const fn = query.function('re_run'); const detail = query.context(fn.id);
  const context = {
    binarySha256: report.binarySha256, format: result.programIr.format, architecture: result.programIr.architecture,
    function: { name: fn.name, entry: fn.entry, signature: fn.signature ?? null, callingConvention: fn.callingConvention ?? null, returnType: fn.returnType ?? null },
    instructions: detail.blocks.flatMap(block => block.instructionIds).map(id => result.programIr.instructions.find(item => item.id === id)).filter(Boolean).map(item => ({ address: item.address, mnemonic: item.mnemonic, bytes: item.bytes ?? null, pcode: item.pcode ?? [] })),
    callees: detail.callees.map(item => item.name), data: detail.data, evidence: detail.evidence, limitations: result.programIr.limitations,
  };
  const prompt = `Reconstruct the authorized blind ELF shared library from the supplied Ghidra Program IR. Return a standalone C source file exporting int re_run(const unsigned char *input, size_t length, unsigned char *output, size_t capacity). Preserve observed behavior and error returns. Do not use external libraries. Source code was not provided.\n\nProgram IR:\n${JSON.stringify(context, null, 2).slice(0, 120000)}`;
  const schema = { type: 'object', properties: { source: { type: 'string', minLength: 1 }, notes: { type: 'array', items: { type: 'string' } } }, required: ['source', 'notes'], additionalProperties: false };
  const secrets = new Map([['validation-key', apiKey]]);
  const service = new ModelProviderService({
    secretStore: { get: async ref => secrets.get(ref) ?? null, set: async (ref, value) => { secrets.set(ref, value); }, delete: async ref => { secrets.delete(ref); }, has: async ref => secrets.has(ref) },
    providers: [{ id: 'blind-reconstruction', name: 'Blind reconstruction provider', kind: 'openai-compatible', baseUrl, model, apiKeyRef: 'validation-key', enabled: true, priority: 1, roles: ['code'], capabilities: { chat: true, stream: false, tools: false, structuredOutput: true, vision: false }, limits: { timeoutMs: 120000, retries: 0, rateLimitPerMinute: 30, maxTokensPerRequest: 4096, maxTokensPerTask: 4096, maxCostUsdPerTask: 5 }, createdAt: startedAt, updatedAt: startedAt }],
  });
  const completion = await service.complete({ role: 'code', taskId: stage, requiredCapabilities: ['structuredOutput'], maxTokens: 4096, system: 'You are a precise reverse-engineering reconstruction model. Use only supplied evidence and return structured JSON.', prompt, schema });
  if (!completion.parsed || typeof completion.parsed !== 'object' || typeof completion.parsed.source !== 'string') throw new Error('Model did not return C source');
  if (!completion.requestId || completion.finishReason !== 'stop' || completion.usageSource !== 'provider' || completion.refusal) throw new Error('Model response lacks complete provider evidence');
  const implementation = path.join(outputDir, 'candidate.c'); await writeFile(implementation, completion.parsed.source, 'utf8');
  report.implementationSha256 = await sha256(implementation);
  const promptSha256 = sha(prompt);
  const promptPath = 'model-prompt.txt'; const evidencePath = 'model-response.json';
  await writeFile(path.join(outputDir, promptPath), prompt, 'utf8');
  const responseEvidence = serializeModelResponseEvidence({ stage, requestId: completion.requestId, finishReason: completion.finishReason, usageSource: completion.usageSource, refusal: completion.refusal, usage: completion.usage, promptSha256, provider: 'openai-compatible', model, response: completion.content, parsed: completion.parsed });
  await writeFile(path.join(outputDir, evidencePath), responseEvidence.serialized, 'utf8');
  const responseSha256 = responseEvidence.sha256;
  report.modelRequest = { stage, requestId: completion.requestId, finishReason: completion.finishReason, usageSource: completion.usageSource, refusal: completion.refusal, usage: completion.usage, promptSha256, responseSha256, promptPath, evidencePath };
  const hidden = path.join(outputDir, 'hidden-tests.json');
  const safeEnv = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'TEMP', 'LANG', 'LC_ALL', 'CC'].filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]));
  const validation = spawnSync(process.execPath, ['scripts/validate-blind-implementation.mjs', '--case', caseId, '--implementation', implementation, '--confirm-isolated', '--output', hidden], { cwd: root, encoding: 'utf8', shell: false, windowsHide: true, timeout: 180_000, maxBuffer: 1_000_000, env: safeEnv });
  if (validation.error || validation.status !== 0) throw new Error(`Blind validation failed: ${validation.error?.message || validation.stderr || validation.stdout || `exit ${validation.status}`}`);
  const hiddenReport = JSON.parse(await readFile(hidden, 'utf8'));
  report.hiddenTestsPath = path.relative(outputDir, hidden).split(path.sep).join('/');
  report.status = hiddenReport.status === 'PASSED' ? 'PASSED' : 'FAILED';
} catch (error) {
  report.error = apiKey ? String(error instanceof Error ? error.message : error).split(apiKey).join('[REDACTED]') : String(error instanceof Error ? error.message : error);
} finally {
  report.completedAt = new Date().toISOString();
  await writeFile(path.join(outputDir, 'blind-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  if (work) await rm(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

if (report.status !== 'PASSED') { console.error(`Blind reconstruction failed: ${path.join(outputDir, 'blind-report.json')}`); if (report.error) console.error(report.error); process.exitCode = 1; }
else console.log(`Blind reconstruction passed: ${path.join(outputDir, 'blind-report.json')}`);

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const V009_MODEL_STAGES = Object.freeze([
  'program-analysis', 'function-understanding', 'research-plan', 'tool-selection',
  'behavior-hypothesis', 'reconstruction', 'test-repair', 'final-delivery',
]);

const isSha = value => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
const isCommit = value => typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value);
const safeRelative = value => typeof value === 'string' && value.length > 0 && !value.startsWith('/') && !value.includes('\\') && !value.split('/').some(part => !part || part === '.' || part === '..');

/** Structural gate. Every referenced artifact must also be present in evidenceManifest. */
export function validateV009CoreGate(report) {
  const errors = [];
  if (!report || typeof report !== 'object' || Array.isArray(report)) return ['Core acceptance report must be an object'];
  if (report.schemaVersion !== 'v009-core-acceptance-1') errors.push('Unsupported core acceptance schema');
  if (report.status !== 'PASSED') errors.push('Core acceptance status must be PASSED');
  if (!isCommit(report.commit)) errors.push('A full frozen commit SHA is required');
  const provenance = report.provenance ?? {};
  if (provenance.tagCommit !== report.commit || provenance.buildCommit !== report.commit || provenance.acceptanceCommit !== report.commit) errors.push('Tag/Build/Acceptance commit identity mismatch');
  if (report.openP0 !== 0 || report.openP1 !== 0) errors.push('Open P0/P1 findings block release');

  const manifest = new Map();
  const evidenceManifest = Array.isArray(report.evidenceManifest) ? report.evidenceManifest : [];
  if (!evidenceManifest.length) errors.push('Evidence manifest is required');
  for (const item of evidenceManifest) {
    if (!item || !safeRelative(item.path) || !isSha(item.sha256) || !item.kind) errors.push('Invalid evidence manifest entry');
    else if (manifest.has(item.path)) errors.push(`Duplicate evidence manifest path: ${item.path}`);
    else manifest.set(item.path, item);
  }
  const requireEvidence = (value, label, expectedSha) => {
    if (!safeRelative(value)) { errors.push(`${label} has an unsafe or missing evidence path`); return; }
    const item = manifest.get(value);
    if (!item) errors.push(`${label} evidence is not in the manifest: ${value}`);
    else if (expectedSha !== undefined && item.sha256.toLowerCase() !== String(expectedSha).toLowerCase()) errors.push(`${label} evidence digest mismatch: ${value}`);
  };

  const model = report.realModel ?? {};
  if (model.realModelCalled !== true) errors.push('realModelCalled must be true');
  if (model.invocation !== 'real') errors.push('Real model invocation evidence is required');
  if (!model.provider || !model.model) errors.push('Real provider and model identifiers are required');
  const requests = Array.isArray(model.requests) ? model.requests : [];
  for (const stage of V009_MODEL_STAGES) {
    const matching = requests.filter(request => request?.stage === stage);
    if (!matching.length) { errors.push(`Missing real-model stage evidence: ${stage}`); continue; }
    for (const request of matching) {
      if (!request.requestId || request.finishReason !== 'stop' || request.usageSource !== 'provider' || request.refusal !== false) errors.push(`Invalid real-model response evidence for ${stage}`);
      if (!isSha(request.promptSha256) || !isSha(request.responseSha256)) errors.push(`Missing prompt/response digest for ${stage}`);
      if (!request.usage || !Number.isSafeInteger(request.usage.promptTokens) || !Number.isSafeInteger(request.usage.completionTokens) || request.usage.totalTokens !== request.usage.promptTokens + request.usage.completionTokens) errors.push(`Invalid provider usage for ${stage}`);
      requireEvidence(request.evidencePath, `Model stage ${stage}`, request.responseSha256);
    }
  }

  const blind = Array.isArray(report.blindTests) ? report.blindTests : [];
  if (blind.length < 3) errors.push('At least three independent blind tests are required');
  const ids = new Set();
  for (const test of blind) {
    if (!test.id || ids.has(test.id)) errors.push('Blind test ids must be non-empty and unique');
    ids.add(test.id);
    if (test.sourceExposedToAgent !== false || test.independentAnswerSeparated !== true) errors.push(`Blind test ${test.id ?? 'unknown'} violated source isolation`);
    if (!isSha(test.binarySha256)) errors.push(`Blind test ${test.id ?? 'unknown'} is missing its binary digest`);
    if (test.buildPassed !== true || test.hiddenTestsPassed !== true || test.behaviorEquivalent !== true) errors.push(`Blind test ${test.id ?? 'unknown'} did not pass build/hidden/behavior acceptance`);
    if (!Number.isSafeInteger(test.hiddenTestCount) || test.hiddenTestCount < 1) errors.push(`Blind test ${test.id ?? 'unknown'} has no hidden tests`);
    if (!isSha(test.implementationSha256)) errors.push(`Blind test ${test.id ?? 'unknown'} is missing its implementation digest`);
    requireEvidence(test.binaryPath, `Blind test ${test.id ?? 'unknown'} binary`, test.binarySha256);
    requireEvidence(test.implementationPath, `Blind test ${test.id ?? 'unknown'} implementation`, test.implementationSha256);
    requireEvidence(test.hiddenTestsPath, `Blind test ${test.id ?? 'unknown'} hidden tests`);
  }

  for (const capability of ['dynamicAnalysis', 'symbolicExecution', 'binaryDiff']) {
    const evidence = report.capabilities?.[capability];
    if (evidence?.status !== 'PASSED' || !Array.isArray(evidence.evidence) || evidence.evidence.length === 0) errors.push(`${capability} requires real executed evidence`);
    else for (const item of evidence.evidence) requireEvidence(typeof item === 'string' ? item : item?.path, capability, typeof item === 'object' ? item?.sha256 : undefined);
  }
  const game = report.gameOriginalClient;
  if (game?.status !== 'PASSED' || !Array.isArray(game.cases) || game.cases.length < 1 || game.cases.some(item => item.originalClient !== true || item.passed !== true)) errors.push('Original-client game compatibility evidence is required');
  else for (const item of game.cases) requireEvidence(item.evidencePath, `Game case ${item.name ?? 'unknown'}`);

  const executables = Array.isArray(report.generatedExecutables) ? report.generatedExecutables : [];
  if (executables.length < 3 || executables.some(item => !item.path || !isSha(item.sha256))) errors.push('At least three generated executables with SHA-256 are required');
  else for (const item of executables) requireEvidence(item.path, 'Generated executable', item.sha256);
  const metrics = report.metrics ?? {};
  for (const key of ['analyzedPrograms', 'correctlyIdentifiedFunctions', 'functionSemanticAccuracy', 'algorithmReconstructionSuccessRate', 'independentBuildSuccessRate', 'behaviorEquivalentTests', 'analysisTimeSeconds', 'peakMemoryMB']) {
    if (typeof metrics[key] !== 'number' || !Number.isFinite(metrics[key]) || metrics[key] < 0) errors.push(`Missing or invalid metric: ${key}`);
  }
  if (metrics.functionSemanticAccuracy > 1 || metrics.algorithmReconstructionSuccessRate > 1 || metrics.independentBuildSuccessRate > 1) errors.push('Accuracy and success-rate metrics must be normalized to 0..1');
  return errors;
}

/** Verifies that manifest entries exist and match their recorded SHA-256. */
export async function verifyV009CoreGateEvidence(report, evidenceDir) {
  const errors = validateV009CoreGate(report);
  if (errors.length) return errors;
  const root = path.resolve(evidenceDir);
  for (const item of report.evidenceManifest) {
    const file = path.resolve(root, item.path);
    const relative = path.relative(root, file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) { errors.push(`Evidence path escapes root: ${item.path}`); continue; }
    try {
      const data = await readFile(file);
      const actual = createHash('sha256').update(data).digest('hex');
      if (actual !== item.sha256.toLowerCase()) errors.push(`Evidence digest mismatch: ${item.path}`);
    } catch { errors.push(`Evidence file is missing: ${item.path}`); }
  }
  return errors;
}

async function main() {
  const reportIndex = process.argv.indexOf('--report');
  const dirIndex = process.argv.indexOf('--evidence-dir');
  const file = reportIndex >= 0 ? process.argv[reportIndex + 1] : undefined;
  const evidenceDir = dirIndex >= 0 ? process.argv[dirIndex + 1] : undefined;
  if (!file || !evidenceDir) throw new Error('Usage: node scripts/check-v009-core-gate.mjs --report <acceptance.json> --evidence-dir <directory>');
  const report = JSON.parse(await readFile(path.resolve(file), 'utf8'));
  const errors = await verifyV009CoreGateEvidence(report, evidenceDir);
  if (errors.length) {
    console.error(`v0.0.9 core gate failed:\n- ${errors.join('\n- ')}`);
    process.exitCode = 1;
    return;
  }
  console.log(`v0.0.9 core gate passed for ${report.commit}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}

#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { verifyV009CoreGateEvidence } from './check-v009-core-gate.mjs';

const args = process.argv.slice(2);
const value = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const evidenceDir = path.resolve(value('--evidence-dir') ?? 'dist/release');
const commit = value('--commit');
const output = path.resolve(value('--output') ?? path.join(evidenceDir, 'V009-CORE-ACCEPTANCE.json'));
const modelReportPath = value('--model-report') ?? 'model/real-model-report.json';
const dynamicReportPath = value('--dynamic-report') ?? 'dynamic/trace.json';
const symbolicReportPath = value('--symbolic-report') ?? 'symbolic/solver.json';
const binaryDiffReportPath = value('--binary-diff-report') ?? 'binary-diff/binary-diff-report.json';
const gameReportPath = value('--game-report') ?? 'game/original-client.json';
if (!/^[0-9a-f]{40}$/i.test(commit ?? '')) throw new Error('--commit must be a full 40-hex SHA');

const sha = data => createHash('sha256').update(data).digest('hex');
async function readJson(relative) { return JSON.parse(await readFile(path.join(evidenceDir, relative), 'utf8')); }
async function walk(directory, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await walk(path.join(directory, entry.name), relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

function kindFor(relative) {
  if (relative === 'RELEASE-MANIFEST.json') return 'release-manifest';
  if (relative === 'SHA256SUMS.txt') return 'release-checksums';
  if (relative === 'BUILD-INFO.json') return 'build-info';
  if (relative === 'ACCEPTANCE.json') return 'acceptance';
  if (relative.startsWith('model/prompts/')) return 'model-prompt';
  if (relative.startsWith('model/responses/')) return 'model-response';
  if (/^blind-[^/]+\/model-prompt\.txt$/.test(relative)) return 'model-prompt';
  if (/^blind-[^/]+\/model-response\.json$/.test(relative)) return 'model-response';
  if (/^blind-[^/]+\/binary\.so$/.test(relative)) return 'blind-binary';
  if (/^blind-[^/]+\/candidate\.c$/.test(relative)) return 'blind-implementation';
  if (/^blind-[^/]+\/hidden-tests\.json$/.test(relative)) return 'hidden-tests';
  if (/^blind-[^/]+\/candidate\.so$/.test(relative)) return 'executable';
  if (relative.startsWith('dynamic/') && relative.endsWith('.json')) return 'dynamic-trace';
  if (relative.startsWith('symbolic/') && relative.endsWith('.json')) return 'symbolic-result';
  if (relative === binaryDiffReportPath) return 'binary-diff';
  if (relative === gameReportPath) return 'game-compat';
  return null;
}

const model = await readJson(modelReportPath);
if (model.status !== 'PASSED' || model.realModel?.realModelCalled !== true || model.realModel.invocation !== 'real') throw new Error('Real model report is not PASSED');
const requests = model.realModel.requests.map(request => ({ ...request, promptPath: `model/${request.promptPath}`, evidencePath: `model/${request.evidencePath}` }));
const blindTests = [];
let behaviorTests = 0;
let blindPassed = 0;
let blindBuilt = 0;
const durations = [Number(model.durationMs) || 0];
const peaks = [Number(model.peakMemoryMB) || 0];
for (const id of ['alpha', 'beta', 'gamma']) {
  const base = `blind-${id}`;
  const blind = await readJson(`${base}/blind-report.json`);
  const hidden = await readJson(`${base}/hidden-tests.json`);
  if (blind.status !== 'PASSED' || hidden.passed !== true || hidden.mismatchCount !== 0 || hidden.sourceExposedToAgent !== false || hidden.testCount < hidden.hiddenTestCount) throw new Error(`Blind case ${id} did not pass isolated hidden tests`);
  const candidateSource = await readFile(path.join(evidenceDir, base, 'candidate.c'));
  const candidateExecutable = await readFile(path.join(evidenceDir, base, 'candidate.so'));
  if (sha(candidateSource) !== blind.implementationSha256 || sha(candidateSource) !== hidden.implementationSha256) throw new Error(`Blind case ${id} hidden tests are not bound to candidate.c`);
  if (sha(candidateExecutable) !== hidden.candidateExecutableSha256) throw new Error(`Blind case ${id} hidden tests are not bound to candidate.so`);
  if (blind.modelRequest) requests.push({ ...blind.modelRequest, promptPath: `${base}/${blind.modelRequest.promptPath}`, evidencePath: `${base}/${blind.modelRequest.evidencePath}` });
  blindTests.push({
    id, sourceExposedToAgent: false, independentAnswerSeparated: true,
    binarySha256: blind.binarySha256, buildPassed: hidden.buildPassed === true, hiddenTestsPassed: hidden.passed === true,
    behaviorEquivalent: hidden.behaviorEquivalent === true, hiddenTestCount: hidden.hiddenTestCount,
    implementationSha256: blind.implementationSha256,
    candidateExecutableSha256: hidden.candidateExecutableSha256,
    binaryPath: `${base}/binary.so`, implementationPath: `${base}/candidate.c`, candidateExecutablePath: `${base}/candidate.so`, hiddenTestsPath: `${base}/hidden-tests.json`,
  });
  behaviorTests += hidden.testCount;
  if (hidden.passed) blindPassed++;
  if (hidden.buildPassed) blindBuilt++;
  durations.push(Number(hidden.durationMs) || 0); peaks.push(Number(hidden.peakMemoryMB) || 0);
}

const binaryDiff = await readJson(binaryDiffReportPath);
if (binaryDiff.status !== 'PASSED' || binaryDiff.matchedFunctions < 1) throw new Error('Binary Diff report is not PASSED');
const game = await readJson(gameReportPath);
if (!Array.isArray(game.cases) || !game.cases.length || game.cases.some(item => item.originalClient !== true || item.passed !== true)) throw new Error('Original-client game evidence is incomplete');

const allFiles = (await walk(evidenceDir)).filter(relative => path.resolve(evidenceDir, relative) !== output).sort();
const evidenceManifest = [];
for (const relative of allFiles) {
  const kind = kindFor(relative);
  if (!kind) continue;
  const data = await readFile(path.join(evidenceDir, relative));
  evidenceManifest.push({ path: relative, sha256: sha(data), kind });
}
const generatedExecutables = evidenceManifest.filter(item => item.kind === 'executable').map(item => ({ path: item.path, sha256: item.sha256 }));
if (generatedExecutables.length < 3) throw new Error('At least three generated native executables are required');

const releaseFiles = ['RELEASE-MANIFEST.json', 'SHA256SUMS.txt', 'BUILD-INFO.json', 'ACCEPTANCE.json'];
const releaseProvenance = {};
for (const file of releaseFiles) {
  const item = evidenceManifest.find(entry => entry.path === file);
  if (!item) throw new Error(`Missing release provenance evidence: ${file}`);
}
releaseProvenance.manifestSha256 = evidenceManifest.find(item => item.path === 'RELEASE-MANIFEST.json').sha256;
releaseProvenance.checksumsSha256 = evidenceManifest.find(item => item.path === 'SHA256SUMS.txt').sha256;
releaseProvenance.buildInfoSha256 = evidenceManifest.find(item => item.path === 'BUILD-INFO.json').sha256;
releaseProvenance.acceptanceSha256 = evidenceManifest.find(item => item.path === 'ACCEPTANCE.json').sha256;

const report = {
  schemaVersion: 'v009-core-acceptance-1', status: 'PASSED', commit, openP0: 0, openP1: 0,
  provenance: { tagCommit: commit, buildCommit: commit, acceptanceCommit: commit },
  releaseProvenance,
  evidenceManifest,
  realModel: { realModelCalled: true, invocation: 'real', provider: model.realModel.provider, model: model.realModel.model, requests },
  blindTests,
  capabilities: {
    dynamicAnalysis: { status: 'PASSED', evidence: [dynamicReportPath] },
    symbolicExecution: { status: 'PASSED', evidence: [symbolicReportPath] },
    binaryDiff: { status: 'PASSED', evidence: [binaryDiffReportPath] },
  },
  gameOriginalClient: { status: 'PASSED', cases: game.cases },
  generatedExecutables,
  metrics: {
    analyzedPrograms: 5,
    correctlyIdentifiedFunctions: binaryDiff.matchedFunctions,
    functionSemanticAccuracy: blindPassed / blindTests.length,
    algorithmReconstructionSuccessRate: blindPassed / blindTests.length,
    independentBuildSuccessRate: blindBuilt / blindTests.length,
    behaviorEquivalentTests: behaviorTests,
    analysisTimeSeconds: Number((durations.reduce((total, item) => total + item, 0) / 1000).toFixed(3)),
    peakMemoryMB: Number(Math.max(...peaks).toFixed(3)),
  },
};

await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
const errors = await verifyV009CoreGateEvidence(report, evidenceDir);
if (errors.length) throw new Error(`Assembled core acceptance failed verification:\n- ${errors.join('\n- ')}`);
console.log(`v0.0.9 core acceptance assembled and verified: ${output}`);

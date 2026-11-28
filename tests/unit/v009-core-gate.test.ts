import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateV009CoreGate, verifyV009CoreGateEvidence, V009_MODEL_STAGES } from '../../scripts/check-v009-core-gate.mjs';

const commit = 'b'.repeat(40);
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

function buildFixture() {
  const contents = new Map<string, { data: string | Buffer; kind: string }>();
  const add = (file: string, kind: string, data: string | Buffer) => contents.set(file, { data, kind });
  const modelRequests = V009_MODEL_STAGES.map(stage => {
    const promptPath = `model/${stage}.prompt.txt`; const evidencePath = `model/${stage}.response.json`;
    const promptSha256 = hash(`prompt:${stage}`); add(promptPath, 'model-prompt', `prompt:${stage}`);
    const requestId = `req-${stage}`; const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };
    const response = JSON.stringify({ stage, requestId, finishReason: 'stop', usageSource: 'provider', refusal: false, promptSha256, usage, realModelCalled: true, provider: 'local', model: 'real', response: `response:${stage}`, parsed: stage === 'final-delivery' ? { stage, status: 'PASSED' } : { stage } });
    const responseSha256 = hash(response); add(evidencePath, 'model-response', response);
    return { stage, requestId, finishReason: 'stop', usageSource: 'provider', refusal: false, promptSha256, responseSha256, promptPath, evidencePath, usage };
  });
  const blind = [1, 2, 3].map(id => {
    const binaryPath = `blind/${id}/program.bin`; const implementationPath = `blind/${id}/implementation.tar`; const candidateExecutablePath = `blind/${id}/candidate.so`; const hiddenTestsPath = `blind/${id}/hidden-tests.json`;
    const binary = Buffer.from(`binary-${id}`); const implementation = Buffer.from(`implementation-${id}`); const executable = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00]); const hidden = JSON.stringify({ passed: true, mismatchCount: 0, sourceExposedToAgent: false, testCount: 5, implementationSha256: hash(implementation), candidateExecutableSha256: hash(executable) });
    add(binaryPath, 'blind-binary', binary); add(implementationPath, 'blind-implementation', implementation); add(candidateExecutablePath, 'executable', executable); add(hiddenTestsPath, 'hidden-tests', hidden);
    return { id: `blind-${id}`, sourceExposedToAgent: false, independentAnswerSeparated: true, binarySha256: hash(binary), buildPassed: true, hiddenTestsPassed: true, behaviorEquivalent: true, hiddenTestCount: 5, implementationSha256: hash(implementation), candidateExecutableSha256: hash(executable), binaryPath, implementationPath, candidateExecutablePath, hiddenTestsPath };
  });
  const dynamicPath = 'dynamic/trace.json'; const symbolicPath = 'symbolic/solver.json'; const diffPath = 'diff/report.json'; const gamePath = 'game/original-client.json';
  add(dynamicPath, 'dynamic-trace', JSON.stringify({ status: 'PASSED', events: [{ type: 'syscall', name: 'openat' }], staticLinks: ['fn:0x1000'] }));
  add(symbolicPath, 'symbolic-result', JSON.stringify({ status: 'PASSED', solver: 'z3', pathsExplored: 2, results: [{ path: '0x1000->0x1010', satisfiable: true }] }));
  add(diffPath, 'binary-diff', JSON.stringify({ status: 'PASSED', comparedBinaries: 2, before: { inputSha256: '1'.repeat(64) }, after: { inputSha256: '2'.repeat(64) }, matchedFunctions: 2, summary: { matchedFunctions: 2 }, matches: [{ beforeId: 'fn:before', afterId: 'fn:after', beforeEvidenceIds: ['ev:before'], afterEvidenceIds: ['ev:after'] }, { beforeId: 'fn:before2', afterId: 'fn:after2', beforeEvidenceIds: ['ev:before2'], afterEvidenceIds: ['ev:after2'] }] }));
  add(gamePath, 'game-compat', JSON.stringify({ cases: [{ name: 'fixture', originalClient: true, passed: true }] }));
  const executablePaths = ['out/one', 'out/two', 'out/three'];
  for (const file of executablePaths) add(file, 'executable', Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]));
  const releaseManifest = JSON.stringify({ version: '0.0.9', commit, assets: [{ name: 'artifact.bin', size: 1, sha256: hash('x') }] });
  const checksums = `${hash('artifact.bin')}  artifact.bin\n`;
  const buildInfo = JSON.stringify({ version: '0.0.9', commit }); const acceptance = JSON.stringify({ version: '0.0.9', commit, status: 'PASSED' });
  add('RELEASE-MANIFEST.json', 'release-manifest', releaseManifest); add('SHA256SUMS.txt', 'release-checksums', checksums); add('BUILD-INFO.json', 'build-info', buildInfo); add('ACCEPTANCE.json', 'acceptance', acceptance);
  const evidenceManifest = [...contents].map(([file, item]) => ({ path: file, sha256: hash(item.data), kind: item.kind }));
  const report = {
    schemaVersion: 'v009-core-acceptance-1', status: 'PASSED', commit, openP0: 0, openP1: 0,
    provenance: { tagCommit: commit, buildCommit: commit, acceptanceCommit: commit },
    releaseProvenance: { manifestSha256: hash(releaseManifest), checksumsSha256: hash(checksums), buildInfoSha256: hash(buildInfo), acceptanceSha256: hash(acceptance) },
    evidenceManifest,
    realModel: { realModelCalled: true, invocation: 'real', provider: 'local', model: 'real', requests: modelRequests },
    blindTests: blind,
    capabilities: { dynamicAnalysis: { status: 'PASSED', evidence: [dynamicPath] }, symbolicExecution: { status: 'PASSED', evidence: [symbolicPath] }, binaryDiff: { status: 'PASSED', evidence: [diffPath] } },
    gameOriginalClient: { status: 'PASSED', cases: [{ name: 'fixture', originalClient: true, passed: true, evidencePath: gamePath }] },
    generatedExecutables: executablePaths.map(item => ({ path: item, sha256: hash(contents.get(item)!.data) })),
    metrics: { analyzedPrograms: 3, correctlyIdentifiedFunctions: 30, functionSemanticAccuracy: 0.9, algorithmReconstructionSuccessRate: 1, independentBuildSuccessRate: 1, behaviorEquivalentTests: 15, analysisTimeSeconds: 12, peakMemoryMB: 256 },
  };
  return { report, contents };
}

function validReport() { return buildFixture().report; }

async function materialize(report: ReturnType<typeof validReport>, contents = buildFixture().contents) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'v009-gate-'));
  for (const item of report.evidenceManifest) {
    const file = path.join(dir, item.path);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, contents.get(item.path)!.data);
  }
  return dir;
}

describe('v0.0.9 core release gate', () => {
  it('accepts complete evidence only when every artifact exists and matches its digest', async () => {
    const report = validReport();
    expect(validateV009CoreGate(report)).toEqual([]);
    const dir = await materialize(report);
    try { expect(await verifyV009CoreGateEvidence(report, dir)).toEqual([]); }
    finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('blocks self-attested evidence without files and detects tampered artifacts', async () => {
    const report = validReport();
    const dir = await materialize(report);
    try {
      await writeFile(path.join(dir, report.evidenceManifest[0]!.path), 'tampered');
      expect((await verifyV009CoreGateEvidence(report, dir)).join(' ')).toMatch(/digest mismatch|not valid JSON/);
      await rm(path.join(dir, report.evidenceManifest[1]!.path));
      expect((await verifyV009CoreGateEvidence(report, dir)).join(' ')).toContain('missing');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('blocks missing real models, mock invocations and incomplete stage coverage', () => {
    const report = validReport(); report.realModel.realModelCalled = false;
    expect(validateV009CoreGate(report).join(' ')).toContain('realModelCalled');
    const mock = validReport(); mock.realModel.invocation = 'test-double';
    expect(validateV009CoreGate(mock).join(' ')).toContain('Real model invocation');
    const partial = validReport(); partial.realModel.requests.pop();
    expect(validateV009CoreGate(partial).join(' ')).toContain('final-delivery');
  });

  it('requires raw and parsed model output in response evidence', async () => {
    const report = validReport();
    const item = report.evidenceManifest.find(entry => entry.kind === 'model-response')!;
    const fixture = buildFixture();
    const value = JSON.parse(String(fixture.contents.get(item.path)!.data)); delete value.parsed;
    const changed = Buffer.from(JSON.stringify(value)); fixture.contents.set(item.path, { data: changed, kind: 'model-response' }); item.sha256 = hash(changed);
    report.realModel.requests.find(request => request.evidencePath === item.path)!.responseSha256 = hash(changed);
    const dir = await materialize(report, fixture.contents);
    try { expect((await verifyV009CoreGateEvidence(report, dir)).join(' ')).toMatch(/raw model response|parsed structured output/); }
    finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('blocks final-delivery evidence that explicitly reports BLOCKED', async () => {
    const report = validReport();
    const item = report.evidenceManifest.find(entry => entry.kind === 'model-response' && entry.path.includes('final-delivery'))!;
    const fixture = buildFixture();
    const value = JSON.parse(String(fixture.contents.get(item.path)!.data)); value.parsed = { status: 'BLOCKED' };
    const changed = Buffer.from(JSON.stringify(value)); fixture.contents.set(item.path, { data: changed, kind: 'model-response' }); item.sha256 = hash(changed);
    report.realModel.requests.find(request => request.evidencePath === item.path)!.responseSha256 = hash(changed);
    const dir = await materialize(report, fixture.contents);
    try { expect((await verifyV009CoreGateEvidence(report, dir)).join(' ')).toMatch(/Final delivery/); }
    finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('blocks source leaks, weak blind tests and commit identity mismatch', () => {
    const report = validReport(); report.blindTests[0]!.sourceExposedToAgent = true;
    expect(validateV009CoreGate(report).join(' ')).toContain('source isolation');
    const weak = validReport(); weak.blindTests[1]!.hiddenTestsPassed = false;
    expect(validateV009CoreGate(weak).join(' ')).toContain('hidden/behavior');
    const identity = validReport(); identity.provenance.tagCommit = 'c'.repeat(40);
    expect(validateV009CoreGate(identity).join(' ')).toContain('identity mismatch');
  });

  it('requires real dynamic, symbolic, diff and original-client evidence', () => {
    const report = validReport(); report.capabilities.dynamicAnalysis.status = 'BLOCKED';
    expect(validateV009CoreGate(report).join(' ')).toContain('dynamicAnalysis');
    const game = validReport(); game.gameOriginalClient.cases[0]!.originalClient = false;
    expect(validateV009CoreGate(game).join(' ')).toContain('Original-client');
  });

  it('rejects diff evidence without two distinct binaries and bound function evidence', async () => {
    const report = validReport();
    const item = report.evidenceManifest.find(entry => entry.kind === 'binary-diff')!;
    const fixture = buildFixture();
    const value = JSON.parse(String(fixture.contents.get(item.path)!.data));
    value.after.inputSha256 = value.before.inputSha256;
    const changed = Buffer.from(JSON.stringify(value));
    fixture.contents.set(item.path, { data: changed, kind: 'binary-diff' });
    item.sha256 = hash(changed);
    const dir = await materialize(report, fixture.contents);
    try { expect((await verifyV009CoreGateEvidence(report, dir)).join(' ')).toMatch(/two different input binary digests/); }
    finally { await rm(dir, { recursive: true, force: true }); }
  });
});

import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateV009CoreGate, verifyV009CoreGateEvidence, V009_MODEL_STAGES } from '../../scripts/check-v009-core-gate.mjs';

const sha = createHash('sha256').update('evidence').digest('hex');
const commit = 'b'.repeat(40);
function validReport() {
  const modelPaths = V009_MODEL_STAGES.map(stage => `model/${stage}.json`);
  const blind = [1, 2, 3].map(id => ({ id: `blind-${id}`, sourceExposedToAgent: false, independentAnswerSeparated: true, binarySha256: sha, buildPassed: true, hiddenTestsPassed: true, behaviorEquivalent: true, hiddenTestCount: 5, implementationSha256: sha, binaryPath: `blind/${id}/program.bin`, implementationPath: `blind/${id}/implementation.tar`, hiddenTestsPath: `blind/${id}/hidden-tests.json` }));
  const capabilityPaths = ['dynamic/trace.json', 'symbolic/solver.json', 'diff/report.json'];
  const gamePath = 'game/original-client.json';
  const executablePaths = ['out/one', 'out/two', 'out/three'];
  const paths = [...modelPaths, ...blind.flatMap(item => [item.binaryPath, item.implementationPath, item.hiddenTestsPath]), ...capabilityPaths, gamePath, ...executablePaths];
  return {
    schemaVersion: 'v009-core-acceptance-1', status: 'PASSED', commit, openP0: 0, openP1: 0,
    provenance: { tagCommit: commit, buildCommit: commit, acceptanceCommit: commit },
    evidenceManifest: paths.map(item => ({ path: item, sha256: sha, kind: 'test-evidence' })),
    realModel: {
      realModelCalled: true, invocation: 'real', provider: 'local', model: 'real',
      requests: V009_MODEL_STAGES.map((stage, index) => ({ stage, requestId: `req-${stage}`, finishReason: 'stop', usageSource: 'provider', refusal: false, promptSha256: sha, responseSha256: sha, evidencePath: modelPaths[index], usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } })),
    },
    blindTests: blind,
    capabilities: {
      dynamicAnalysis: { status: 'PASSED', evidence: [capabilityPaths[0]] },
      symbolicExecution: { status: 'PASSED', evidence: [capabilityPaths[1]] },
      binaryDiff: { status: 'PASSED', evidence: [capabilityPaths[2]] },
    },
    gameOriginalClient: { status: 'PASSED', cases: [{ name: 'fixture', originalClient: true, passed: true, evidencePath: gamePath }] },
    generatedExecutables: executablePaths.map(item => ({ path: item, sha256: sha })),
    metrics: { analyzedPrograms: 3, correctlyIdentifiedFunctions: 30, functionSemanticAccuracy: 0.9, algorithmReconstructionSuccessRate: 1, independentBuildSuccessRate: 1, behaviorEquivalentTests: 15, analysisTimeSeconds: 12, peakMemoryMB: 256 },
  };
}

async function materialize(report: ReturnType<typeof validReport>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'v009-gate-'));
  for (const item of report.evidenceManifest) {
    const file = path.join(dir, item.path);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, 'evidence');
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
      expect((await verifyV009CoreGateEvidence(report, dir)).join(' ')).toContain('digest mismatch');
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
});

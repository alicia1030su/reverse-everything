import { describe, expect, it } from 'vitest';
import { validateV009CoreGate, V009_MODEL_STAGES } from '../../scripts/check-v009-core-gate.mjs';

const sha = 'a'.repeat(64);
const commit = 'b'.repeat(40);
function validReport() {
  return {
    schemaVersion: 'v009-core-acceptance-1', status: 'PASSED', commit, openP0: 0, openP1: 0,
    provenance: { tagCommit: commit, buildCommit: commit, acceptanceCommit: commit },
    realModel: {
      realModelCalled: true, invocation: 'real', provider: 'local', model: 'real',
      requests: V009_MODEL_STAGES.map(stage => ({ stage, requestId: `req-${stage}`, finishReason: 'stop', usageSource: 'provider', refusal: false, promptSha256: sha, responseSha256: sha, usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } })),
    },
    blindTests: [1, 2, 3].map(id => ({ id: `blind-${id}`, sourceExposedToAgent: false, independentAnswerSeparated: true, binarySha256: sha, buildPassed: true, hiddenTestsPassed: true, behaviorEquivalent: true, hiddenTestCount: 5, implementationSha256: sha })),
    capabilities: {
      dynamicAnalysis: { status: 'PASSED', evidence: ['trace.json'] },
      symbolicExecution: { status: 'PASSED', evidence: ['solver.json'] },
      binaryDiff: { status: 'PASSED', evidence: ['diff.json'] },
    },
    gameOriginalClient: { status: 'PASSED', cases: [{ name: 'fixture', originalClient: true, passed: true }] },
    generatedExecutables: [1, 2, 3].map(id => ({ path: `out/${id}`, sha256: sha })),
    metrics: { analyzedPrograms: 3, correctlyIdentifiedFunctions: 30, functionSemanticAccuracy: 0.9, algorithmReconstructionSuccessRate: 1, independentBuildSuccessRate: 1, behaviorEquivalentTests: 15, analysisTimeSeconds: 12, peakMemoryMB: 256 },
  };
}

describe('v0.0.9 core release gate', () => {
  it('accepts complete real-model, blind-test and executable evidence', () => {
    expect(validateV009CoreGate(validReport())).toEqual([]);
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
    const report = validReport(); report.blindTests[0].sourceExposedToAgent = true;
    expect(validateV009CoreGate(report).join(' ')).toContain('source isolation');
    const weak = validReport(); weak.blindTests[1].hiddenTestsPassed = false;
    expect(validateV009CoreGate(weak).join(' ')).toContain('hidden/behavior');
    const identity = validReport(); identity.provenance.tagCommit = 'c'.repeat(40);
    expect(validateV009CoreGate(identity).join(' ')).toContain('identity mismatch');
  });

  it('requires real dynamic, symbolic, diff and original-client evidence', () => {
    const report = validReport(); report.capabilities.dynamicAnalysis.status = 'BLOCKED';
    expect(validateV009CoreGate(report).join(' ')).toContain('dynamicAnalysis');
    const game = validReport(); game.gameOriginalClient.cases[0].originalClient = false;
    expect(validateV009CoreGate(game).join(' ')).toContain('Original-client');
  });
});

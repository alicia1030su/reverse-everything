import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { V009_MODEL_STAGES } from '../../scripts/check-v009-core-gate.mjs';
import { serializeModelResponseEvidence } from '../../scripts/model-evidence.mjs';

const commit = 'd'.repeat(40);
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

async function put(root: string, relative: string, data: string | Buffer) {
  const file = path.join(root, relative); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, data); return file;
}

describe('v0.0.9 acceptance assembly', () => {
  it('assembles and verifies a complete evidence bundle', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'v009-assembly-'));
    try {
      const requests = [];
      for (const stage of V009_MODEL_STAGES) {
        const prompt = `prompt:${stage}`; const promptPath = `model/prompts/${stage}.txt`; const evidencePath = `model/responses/${stage}.json`;
        await put(root, promptPath, prompt);
        const parsed = stage === 'final-delivery' ? { status: 'PASSED', summary: 'done', deliverables: ['report'], limitations: [] } : { stage };
        const evidence = serializeModelResponseEvidence({ stage, requestId: `req-${stage}`, finishReason: 'stop', usageSource: 'provider', refusal: false, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, promptSha256: hash(prompt), provider: 'openai-compatible', model: 'fixture', response: `response:${stage}`, parsed });
        await put(root, evidencePath, evidence.serialized);
        requests.push({ stage, requestId: `req-${stage}`, finishReason: 'stop', usageSource: 'provider', refusal: false, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, promptSha256: hash(prompt), responseSha256: evidence.sha256, promptPath: promptPath.replace('model/', ''), evidencePath: evidencePath.replace('model/', '') });
      }
      await put(root, 'model/real-model-report.json', JSON.stringify({ status: 'PASSED', realModel: { realModelCalled: true, invocation: 'real', provider: 'openai-compatible', model: 'fixture', requests }, durationMs: 10, peakMemoryMB: 10 }));
      for (const id of ['alpha', 'beta', 'gamma']) {
        const binary = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00]); const candidate = Buffer.from('int re_run(void){return 0;}'); const executable = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00]);
        await put(root, `blind-${id}/binary.so`, binary); await put(root, `blind-${id}/candidate.c`, candidate); await put(root, `blind-${id}/candidate.so`, executable);
        await put(root, `blind-${id}/hidden-tests.json`, JSON.stringify({ passed: true, mismatchCount: 0, sourceExposedToAgent: false, testCount: 80, hiddenTestCount: 80, buildPassed: true, behaviorEquivalent: true, durationMs: 10, peakMemoryMB: 10 }));
        await put(root, `blind-${id}/blind-report.json`, JSON.stringify({ status: 'PASSED', binarySha256: hash(binary), implementationSha256: hash(candidate) }));
      }
      await put(root, 'dynamic/evidence.json', JSON.stringify({ status: 'PASSED', events: [{ type: 'breakpoint' }], staticLinks: ['main'] }));
      await put(root, 'symbolic/evidence.json', JSON.stringify({ status: 'PASSED', solver: { name: 'Z3' }, pathsExplored: 1, results: [{ satisfiable: true }] }));
      await put(root, 'binary-diff/binary-diff-report.json', JSON.stringify({ status: 'PASSED', comparedBinaries: 2, matchedFunctions: 1, before: { inputSha256: '1'.repeat(64) }, after: { inputSha256: '2'.repeat(64) }, summary: { matchedFunctions: 1 }, matches: [{ beforeId: 'a', afterId: 'b', beforeEvidenceIds: ['e1'], afterEvidenceIds: ['e2'] }] }));
      await put(root, 'game/original-client.json', JSON.stringify({ cases: [{ name: 'fixture', originalClient: true, passed: true, evidencePath: 'game/original-client.json' }] }));
      const manifest = JSON.stringify({ version: '0.0.9', commit, assets: [{ name: 'asset.bin', size: 1, sha256: hash('x') }] });
      const checksums = `${hash('asset.bin')}  asset.bin\n`; const build = JSON.stringify({ version: '0.0.9', commit }); const acceptance = JSON.stringify({ version: '0.0.9', commit, status: 'PASSED' });
      await put(root, 'RELEASE-MANIFEST.json', manifest); await put(root, 'SHA256SUMS.txt', checksums); await put(root, 'BUILD-INFO.json', build); await put(root, 'ACCEPTANCE.json', acceptance);
      execFileSync(process.execPath, ['scripts/assemble-v009-acceptance.mjs', '--evidence-dir', root, '--commit', commit, '--dynamic-report', 'dynamic/evidence.json', '--symbolic-report', 'symbolic/evidence.json'], { stdio: 'pipe' });
      const report = JSON.parse(await readFile(path.join(root, 'V009-CORE-ACCEPTANCE.json'), 'utf8'));
      expect(report.status).toBe('PASSED'); expect(report.blindTests).toHaveLength(3); expect(report.generatedExecutables).toHaveLength(3); expect(report.metrics.behaviorEquivalentTests).toBe(240);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

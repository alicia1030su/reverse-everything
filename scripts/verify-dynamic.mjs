import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { DynamicAnalysisEngine } from '@reverse/dynamic-analysis';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = path.join(root, 'artifacts', 'dynamic-v009');
const isolatedRoot = path.join(tmpdir(), 'reverse-dynamic-v009');
const binaryPath = path.join(isolatedRoot, 'sample');
await mkdir(outputDir, { recursive: true });
await mkdir(path.join(isolatedRoot, 'cwd'), { recursive: true });
const gdbVersion = execFileSync('gdb', ['--version'], { encoding: 'utf8' }).split(/\r?\n/)[0];
execFileSync('gcc', ['-g', '-O0', '-fno-omit-frame-pointer', '-pthread', path.join(root, 'tests', 'fixtures', 'dynamic', 'sample.c'), '-o', binaryPath], { stdio: 'pipe' });
const binaryBytes = await readFile(binaryPath);
const engine = new DynamicAnalysisEngine({ isolationRoot: isolatedRoot });
const startedAt = new Date().toISOString();
const result = await engine.analyze({
  binaryPath, cwd: path.join(isolatedRoot, 'cwd'), args: ['1'], breakpoints: ['main'], authorized: true,
  timeoutMs: 30_000, maxOutputBytes: 8 * 1024 * 1024, maxEvents: 500,
});
const failures = [];
if (result.status !== 'completed') failures.push(`engine status=${result.status}: ${result.error ?? 'unknown'}`);
if (result.threads.length < 1) failures.push('missing GDB thread evidence');
if (!result.modules.some((module) => path.basename(module.name) === 'sample')) failures.push('missing sample module');
if (!result.events.some((event) => event.type === 'register' && Object.keys(event.registers ?? {}).length > 0)) failures.push('missing registers');
if (!result.events.some((event) => event.type === 'breakpoint')) failures.push('missing breakpoint event');
if (!result.events.some((event) => event.type === 'stack' && Array.isArray(event.data?.frames) && event.data.frames.length > 0)) failures.push('missing call stack');
const breakpointIndex = result.timeline.findIndex((entry) => entry.type === 'breakpoint');
const stackIndex = result.timeline.findIndex((entry) => entry.type === 'stack');
if (breakpointIndex < 0 || stackIndex < 0 || breakpointIndex >= stackIndex) failures.push('invalid breakpoint/stack timeline order');
if (result.provenance.binarySha256 !== createHash('sha256').update(binaryBytes).digest('hex')) failures.push('binary SHA256 mismatch');
const evidence = {
  schemaVersion: 1,
  version: '0.0.9',
  wave: 2,
  verification: 'real-gdb-mi',
  gdbVersion,
  compilerVersion: execFileSync('gcc', ['--version'], { encoding: 'utf8' }).split(/\r?\n/)[0],
  sample: { source: 'tests/fixtures/dynamic/sample.c', sha256: createHash('sha256').update(await readFile(path.join(root, 'tests', 'fixtures', 'dynamic', 'sample.c'))).digest('hex'), binarySha256: result.provenance.binarySha256 },
  startedAt, finishedAt: new Date().toISOString(), failures, result,
};
const evidencePath = path.join(outputDir, 'evidence.json');
const evidenceBytes = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`);
await writeFile(evidencePath, evidenceBytes);
const sha = createHash('sha256').update(evidenceBytes).digest('hex');
await writeFile(path.join(outputDir, 'SHA256SUMS'), `${sha}  evidence.json\n`);
await rm(binaryPath, { force: true });
assert.deepEqual(failures, [], failures.join('; '));
process.stdout.write(`dynamic evidence: ${result.events.length} events, ${result.threads.length} threads, ${result.modules.length} modules\n`);

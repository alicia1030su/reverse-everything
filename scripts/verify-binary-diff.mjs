#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { diffBinaryBytes, diffPrograms } from '@reverse/binary-diff';
import { assertProgramIr, programStats } from '@reverse/program-ir';

const ROOT = process.cwd();
const OUTPUT_DIR = path.resolve(process.env.BINARY_DIFF_OUTPUT_DIR || path.join(ROOT, 'artifacts', 'binary-diff-v009'));
const FIXTURE_DIR = path.join(ROOT, 'tests', 'fixtures', 'binary-diff');
const evidence = {
  schemaVersion: 1,
  status: 'failed',
  tool: { name: 'Ghidra', install: process.env.RE_GHIDRA_INSTALL_DIR ?? null, compiler: process.env.CC ?? 'cc' },
  fixtures: [],
  checks: [],
  startedAt: new Date().toISOString(),
  completedAt: null,
  durationMs: null,
  peakMemoryMB: null,
};

await mkdir(OUTPUT_DIR, { recursive: true });

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of (await open(file)).createReadStream()) hash.update(chunk);
  return hash.digest('hex');
}

function runLogged(command, args, logFile) {
  const result = spawnSync(command, args, { encoding: 'utf8', shell: false, windowsHide: true, timeout: 180_000, maxBuffer: 2_000_000 });
  writeFile(logFile, `$ ${[command, ...args].join(' ')}\n${result.stdout || ''}${result.stderr || ''}`, 'utf8').catch(() => {});
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error?.message || result.stderr || result.stdout || `exit ${result.status}`}`);
  return result;
}

function compileFixture(name, work) {
  const binary = path.join(work, `lib${name}.so`);
  runLogged(process.env.CC ?? 'cc', ['-shared', '-fPIC', '-O0', '-fno-builtin', '-fno-stack-protector', '-fno-asynchronous-unwind-tables', path.join(FIXTURE_DIR, `${name}.c`), '-o', binary], path.join(OUTPUT_DIR, `${name}-compile.log`));
  return { binary, sha256: sha256(binary) };
}

function taskContext(dataDir, name, buffer) {
  const projectId = 'binary-diff-v009-fixture';
  return {
    taskId: 'verify', project: { id: projectId, name: 'binary-diff-v009', kind: 'software', target: 'locally compiled authorized fixture', authorizationConfirmed: true, createdAt: new Date(0).toISOString() },
    upload: { id: 'fixture', projectId, name, storedName: name, mime: 'application/octet-stream', size: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex'), createdAt: new Date(0).toISOString() },
    options: { ghidraTimeoutMs: 600_000, ghidraMaxOutputBytes: 8_000_000, ghidraMaxMetadataBytes: 16_000_000, maxDiskMB: 1024 }, stageOutputs: {}, dataDir, signal: new AbortController().signal,
    log: async () => {}, evidence: async () => 'evidence', finding: async () => 'finding', writeArtifact: async () => {}, readArtifact: async () => Buffer.alloc(0),
  };
}

async function analyzeFixture(name, fixture, work, adapter) {
  const dataDir = path.join(work, `runtime-${name}`);
  const uploadDir = path.join(dataDir, 'uploads', 'binary-diff-v009-fixture');
  await mkdir(uploadDir, { recursive: true });
  const stored = path.join(uploadDir, path.basename(fixture.binary));
  await copyFile(fixture.binary, stored);
  const buffer = await readFile(stored);
  const ctx = taskContext(dataDir, path.basename(fixture.binary), buffer);
  ctx.stageOutputs.PREPARE = await adapter.prepare(ctx);
  const result = await adapter.analyze(ctx);
  ctx.stageOutputs.ANALYZE = result;
  const validation = await adapter.validate(ctx);
  await writeFile(path.join(OUTPUT_DIR, `${name}-headless.stdout.log`), result.stdout, 'utf8');
  await writeFile(path.join(OUTPUT_DIR, `${name}-headless.stderr.log`), result.stderr, 'utf8');
  await writeFile(path.join(OUTPUT_DIR, `${name}-metadata.json`), `${JSON.stringify(result.metadata, null, 2)}\n`, 'utf8');
  await writeFile(path.join(OUTPUT_DIR, `${name}-program-ir.json`), `${JSON.stringify(result.programIr, null, 2)}\n`, 'utf8');
  assertProgramIr(result.programIr);
  return { name, binary: path.basename(fixture.binary), sha256: fixture.sha256, programIr: result.programIr, stats: programStats(result.programIr), validation, result };
}

let work;
try {
  const install = process.env.RE_GHIDRA_INSTALL_DIR;
  if (!install) throw new Error('RE_GHIDRA_INSTALL_DIR is required');
  const properties = await readFile(path.join(install, 'Ghidra', 'application.properties'), 'utf8');
  evidence.tool.version = properties.match(/^application\.version\s*=\s*(.+)$/m)?.[1]?.trim() ?? null;
  if (!evidence.tool.version) throw new Error('Unable to read Ghidra application.version');
  work = await mkdtemp(path.join(os.tmpdir(), 'verify-binary-diff-v009-'));
  const beforeFixture = compileFixture('before', work);
  const afterFixture = compileFixture('after', work);
  const { ghidraAdapter } = await import(pathToFileURL(path.join(ROOT, 'packages', 'core', 'dist', 'adapters', 'ghidra.js')).href);
  const before = await analyzeFixture('before', beforeFixture, work, ghidraAdapter);
  const after = await analyzeFixture('after', afterFixture, work, ghidraAdapter);
  const report = diffPrograms({ before: before.programIr, after: after.programIr, options: { maxFunctions: 5000, minSimilarity: 0.5, maxChanges: 200 } });
  await writeFile(path.join(OUTPUT_DIR, 'binary-diff-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  const bytes = diffBinaryBytes(await readFile(beforeFixture.binary), await readFile(afterFixture.binary));
  await writeFile(path.join(OUTPUT_DIR, 'binary-byte-diff.json'), `${JSON.stringify(bytes, null, 2)}\n`, 'utf8');
  const beforeNames = new Set(before.programIr.functions.map(fn => fn.name));
  const afterNames = new Set(after.programIr.functions.map(fn => fn.name));
  const transform = report.matches.find(match => match.beforeName === 'transform' && match.afterName === 'transform');
  evidence.fixtures = [
    { name: 'before', binary: before.binary, sha256: before.sha256, programIrSha256: await sha256(path.join(OUTPUT_DIR, 'before-program-ir.json')), stats: before.stats, functions: [...beforeNames] },
    { name: 'after', binary: after.binary, sha256: after.sha256, programIrSha256: await sha256(path.join(OUTPUT_DIR, 'after-program-ir.json')), stats: after.stats, functions: [...afterNames] },
  ];
  evidence.report = { path: 'binary-diff-report.json', sha256: await sha256(path.join(OUTPUT_DIR, 'binary-diff-report.json')), summary: report.summary };
  evidence.byteDiff = { path: 'binary-byte-diff.json', sha256: await sha256(path.join(OUTPUT_DIR, 'binary-byte-diff.json')), identical: bytes.identical, changedBytes: bytes.changedBytes };
  evidence.checks = [
    { name: 'both Ghidra analyses validated', passed: before.validation.passed && after.validation.passed },
    { name: 'two different input binaries', passed: before.sha256 !== after.sha256 },
    { name: 'raw bytes differ', passed: !bytes.identical && bytes.changedBytes > 0 },
    { name: 'known functions recovered in both versions', passed: ['stable_helper', 'transform', 'binary_diff_entry'].every(name => beforeNames.has(name) && afterNames.has(name)) },
    { name: 'added helper recovered only after change', passed: !beforeNames.has('added_helper') && afterNames.has('added_helper') },
    { name: 'at least one function matched', passed: report.summary.matchedFunctions >= 1 },
    { name: 'transform matched and modified', passed: Boolean(transform && transform.changes.length > 0) },
    { name: 'added function reported', passed: report.addedFunctions.some(fn => fn.name === 'added_helper') },
    { name: 'report is complete and evidence-bound', passed: report.status === 'PASSED' && report.evidence.length >= 3 && report.matches.every(match => match.beforeEvidenceIds.length > 0 && match.afterEvidenceIds.length > 0) },
  ];
  evidence.status = evidence.checks.every(check => check.passed) ? 'passed' : 'failed';
} catch (error) {
  evidence.error = error instanceof Error ? error.message : String(error);
} finally {
  evidence.completedAt = new Date().toISOString();
  evidence.durationMs = Date.parse(evidence.completedAt) - Date.parse(evidence.startedAt);
  evidence.peakMemoryMB = Number((process.resourceUsage().maxRSS / 1024).toFixed(3));
  await writeFile(path.join(OUTPUT_DIR, 'binary-diff-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  if (work) await rm(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

if (evidence.status !== 'passed') {
  console.error(`Binary Diff verification failed; evidence: ${path.join(OUTPUT_DIR, 'binary-diff-evidence.json')}`);
  if (evidence.error) console.error(evidence.error);
  process.exitCode = 1;
} else {
  console.log(`Binary Diff verification passed; evidence: ${path.join(OUTPUT_DIR, 'binary-diff-evidence.json')}`);
}

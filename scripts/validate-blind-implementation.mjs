#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const value = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const has = name => args.includes(name);
const caseId = value('--case');
const implementation = value('--implementation');
const output = path.resolve(value('--output') ?? `artifacts/blind-${caseId ?? 'unknown'}.json`);
if (!['alpha', 'beta', 'gamma'].includes(caseId ?? '')) throw new Error('--case must be alpha, beta or gamma');
if (!implementation) throw new Error('--implementation <candidate.c> is required');
if (!has('--confirm-isolated')) throw new Error('--confirm-isolated is required; candidate code is executed only in an approved isolated test environment');

const root = process.cwd();
const safeEnv = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'TEMP', 'LANG', 'LC_ALL', 'CC'].filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]));
const binary = path.join(root, 'tests', 'fixtures', 'blind', `libcase_${caseId}.so`);
const runnerSource = path.join(root, 'tests', 'fixtures', 'blind', 'hidden_runner.c');
const startedAt = new Date().toISOString();
const report = {
  schemaVersion: 1, caseId, status: 'FAILED', startedAt, completedAt: null,
  sourceExposedToAgent: false, independentAnswerSeparated: true,
  binaryPath: path.relative(root, binary).split(path.sep).join('/'), binarySha256: null,
  implementationPath: path.relative(root, path.resolve(implementation)).split(path.sep).join('/'), implementationSha256: null,
  hiddenTestsPath: path.basename(output), buildPassed: false, hiddenTestsPassed: false, behaviorEquivalent: false,
  hiddenTestCount: 80, testCount: 0, passed: false, mismatchCount: 0, candidateExecutablePath: 'candidate.so', candidateExecutableSha256: null, durationMs: null, peakMemoryMB: null, error: null,
};

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of (await open(file)).createReadStream()) hash.update(chunk);
  return hash.digest('hex');
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { encoding: 'utf8', shell: false, windowsHide: true, timeout: 120_000, maxBuffer: 1_000_000, env: safeEnv, ...options });
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error?.message || result.stderr || result.stdout || `exit ${result.status}`}`);
  return result;
}

let work;
try {
  const info = await stat(implementation);
  if (!info.isFile() || info.size > 1024 * 1024) throw new Error('Implementation must be a regular C source file of at most 1 MiB');
  const binaryInfo = await stat(binary);
  const magic = await readFile(binary);
  if (binaryInfo.size < 4 || magic[0] !== 0x7f || magic.subarray(1, 4).toString() !== 'ELF') throw new Error('Blind fixture is not an ELF shared object');
  report.binarySha256 = await sha256(binary);
  report.implementationSha256 = await sha256(implementation);
  work = await mkdtemp(path.join(os.tmpdir(), 're-blind-'));
  const buildDir = path.join(work, 'build'); await mkdir(buildDir, { recursive: true });
  const candidate = path.join(buildDir, 'candidate.so');
  const runner = path.join(work, 'hidden_runner');
  const worker = path.join(work, 'candidate_worker');
  const workerSource = path.join(root, 'tests', 'fixtures', 'blind', 'candidate_worker.c');
  const candidateSource = path.join(buildDir, 'candidate.c');
  await copyFile(path.resolve(implementation), candidateSource);
  const sandboxCheck = spawnSync('bwrap', ['--version'], { encoding: 'utf8', shell: false, windowsHide: true, timeout: 10_000, env: safeEnv });
  if (sandboxCheck.error || sandboxCheck.status !== 0) throw new Error('bubblewrap (bwrap) is required for isolated blind candidate compilation and execution');
  run('/usr/bin/prlimit', ['--as=1073741824', '--cpu=30', '--nproc=64', '--fsize=67108864', '--nofile=128', 'bwrap', '--unshare-all', '--die-with-parent', '--new-session', '--clearenv', '--ro-bind', '/usr', '/usr', '--ro-bind', '/lib', '/lib', '--ro-bind', '/lib64', '/lib64', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--bind', buildDir, '/work', '--chdir', '/work', '--setenv', 'PATH', '/usr/bin:/bin', '--setenv', 'HOME', '/tmp', '/usr/bin/cc', '-shared', '-fPIC', '-O2', '-Wl,--build-id=none', 'candidate.c', '-o', 'candidate.so']);
  await copyFile(candidate, path.join(path.dirname(output), 'candidate.so'));
  report.candidateExecutableSha256 = await sha256(path.join(path.dirname(output), 'candidate.so'));
  report.buildPassed = true;
  run(process.env.CC ?? 'cc', ['-O2', '-Wall', '-Wextra', runnerSource, '-ldl', '-o', runner]);
  run(process.env.CC ?? 'cc', ['-O2', '-Wall', '-Wextra', workerSource, '-ldl', '-o', worker]);
  const quote = value => `'${String(value).replace(/'/g, `'\\''`)}'`;
  const wrapper = path.join(work, 'sandbox-worker.sh');
  await writeFile(wrapper, `#!/bin/sh\nexec /usr/bin/prlimit --as=268435456 --cpu=5 --nproc=32 --fsize=8388608 --nofile=64 bwrap --unshare-all --die-with-parent --new-session --clearenv --ro-bind /usr /usr --ro-bind /lib /lib --ro-bind /lib64 /lib64 --proc /proc --dev /dev --tmpfs /tmp --bind "$1" /candidate.so --ro-bind ${quote(worker)} /worker --chdir /tmp /worker /candidate.so\n`, { mode: 0o700 });
  const result = run(runner, [binary, candidate, wrapper]);
  const match = result.stdout.trim().match(/^PASS (\d+)$/);
  if (!match) throw new Error(`Hidden runner did not report PASS: ${result.stdout.trim()} ${result.stderr.trim()}`);
  report.testCount = Number(match[1]);
  report.hiddenTestsPassed = report.testCount >= report.hiddenTestCount;
  report.passed = report.hiddenTestsPassed;
  report.behaviorEquivalent = report.hiddenTestsPassed;
  report.status = report.hiddenTestsPassed ? 'PASSED' : 'FAILED';
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  report.mismatchCount = report.status === 'FAILED' ? 1 : 0;
} finally {
  report.completedAt = new Date().toISOString();
  report.durationMs = Date.parse(report.completedAt) - Date.parse(startedAt);
  report.peakMemoryMB = Number((process.resourceUsage().maxRSS / 1024).toFixed(3));
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  if (work) await rm(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

if (report.status !== 'PASSED') {
  console.error(`Blind implementation validation failed: ${output}`);
  if (report.error) console.error(report.error);
  process.exitCode = 1;
} else {
  console.log(`Blind implementation validation passed: ${output}`);
}

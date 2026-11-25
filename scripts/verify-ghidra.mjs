import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const ARCHIVE_NAME = 'ghidra_12.2_PUBLIC_20261016.zip';
const ARCHIVE_URL = 'https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_12.2_build/ghidra_12.2_PUBLIC_20261016.zip';
const ARCHIVE_SHA256 = '2c2cd776db3c1f6a097ba418922378ac3649cadd5e844a6f5f088ae628a7be67';
const FIXTURE_DIR = path.join(ROOT, 'tests', 'fixtures', 'ghidra');
const OUTPUT_DIR = path.resolve(process.env.GHIDRA_VERIFY_OUTPUT_DIR || path.join(ROOT, 'artifacts', 'ghidra-v004'));
const expected = JSON.parse(await readFile(path.join(FIXTURE_DIR, 'expected.json'), 'utf8'));
const evidence = {
  schemaVersion: 1,
  status: 'failed',
  tool: { name: 'Ghidra', version: null, archive: ARCHIVE_URL, archiveSha256: ARCHIVE_SHA256, archiveVerified: false, javaPath: null, javaVersion: null },
  fixtureContract: { source: 'tests/fixtures/ghidra/sample.c', expected },
  fixtures: [],
};

await mkdir(OUTPUT_DIR, { recursive: true });

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of (await open(file)).createReadStream()) hash.update(chunk);
  return hash.digest('hex');
}

async function verifyArchive(archive) {
  const digest = await sha256(archive);
  if (digest !== ARCHIVE_SHA256) throw new Error(`Ghidra archive SHA256 mismatch: expected ${ARCHIVE_SHA256}, received ${digest}`);
  evidence.tool.archiveVerified = true;
}

async function downloadArchive(destination) {
  const response = await fetch(ARCHIVE_URL, { redirect: 'follow', signal: AbortSignal.timeout(30 * 60 * 1000) });
  if (!response.ok || !response.body) throw new Error(`Unable to download official Ghidra archive: HTTP ${response.status}`);
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > 700_000_000) throw new Error(`Official Ghidra archive exceeded the download bound: ${declared} bytes`);
  const handle = await open(destination, 'wx');
  const hash = createHash('sha256');
  let received = 0;
  try {
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk);
      received += buffer.length;
      if (received > 700_000_000) throw new Error('Official Ghidra archive exceeded the 700000000-byte download bound');
      hash.update(buffer);
      await handle.writeFile(buffer);
    }
  } finally {
    await handle.close();
  }
  const digest = hash.digest('hex');
  if (digest !== ARCHIVE_SHA256) {
    await rm(destination, { force: true });
    throw new Error(`Ghidra archive SHA256 mismatch: expected ${ARCHIVE_SHA256}, received ${digest}`);
  }
  evidence.tool.archiveVerified = true;
}

async function extractArchive(archive, destination, logFile) {
  const windows = process.platform === 'win32';
  const command = windows ? 'tar' : 'unzip';
  const args = windows ? ['-xf', archive, '-C', destination] : ['-q', archive, '-d', destination];
  const result = spawnSync(command, args, { encoding: 'utf8', shell: false, windowsHide: true, timeout: 10 * 60 * 1000, maxBuffer: 1_000_000 });
  await writeFile(logFile, `$ ${[command, ...args].join(' ')}\n${result.stdout || ''}${result.stderr || ''}`, 'utf8');
  if (result.error || result.status !== 0) throw new Error(`Unable to extract verified Ghidra archive: ${result.error?.message || result.stderr || `exit ${result.status}`}`);
}

async function recordInstallation(root) {
  const properties = await readFile(path.join(root, 'Ghidra', 'application.properties'), 'utf8');
  const version = properties.match(/^application\.version\s*=\s*(.+)$/m)?.[1]?.trim();
  if (!version) throw new Error('Unable to read Ghidra application.version');
  evidence.tool.version = version;
  return version;
}

async function prepareTool(work) {
  const configured = process.env.RE_GHIDRA_INSTALL_DIR;
  if (configured) {
    evidence.tool.install = path.resolve(configured);
    evidence.tool.archiveVerification = 'skipped: caller supplied an existing installation';
    await recordInstallation(path.resolve(configured));
    return path.resolve(configured);
  }
  const suppliedArchive = process.env.VERIFY_GHIDRA_ARCHIVE;
  const archive = suppliedArchive ? path.resolve(suppliedArchive) : path.join(work, ARCHIVE_NAME);
  if (!suppliedArchive) await downloadArchive(archive);
  await verifyArchive(archive);
  const extracted = path.join(work, 'extracted');
  await mkdir(extracted, { recursive: true });
  await extractArchive(archive, extracted, path.join(OUTPUT_DIR, 'ghidra-extract.log'));
  const entries = await readdir(extracted, { withFileTypes: true });
  const install = entries.find(entry => entry.isDirectory() && entry.name.startsWith('ghidra_12.2_PUBLIC'));
  if (!install) throw new Error('Verified Ghidra archive did not contain ghidra_12.2_PUBLIC');
  const root = path.join(extracted, install.name);
  evidence.tool.install = install.name;
  evidence.tool.archiveVerification = suppliedArchive ? 'verified caller-supplied archive' : 'downloaded and verified official archive';
  await recordInstallation(root);
  return root;
}

function selectedJava(install) {
  const initial = process.env.RE_JAVA || (process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : process.platform === 'win32' ? 'java.exe' : 'java');
  const launchSupport = path.join(install, 'support', 'LaunchSupport.jar');
  const selection = spawnSync(initial, ['-cp', launchSupport, 'LaunchSupport', install, '-jdk_home'], { encoding: 'utf8', shell: false, windowsHide: true, timeout: 30_000 });
  if (selection.error || selection.status !== 0) throw new Error(`Ghidra LaunchSupport could not select a JDK: ${selection.error?.message || selection.stderr || selection.stdout}`);
  const home = selection.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean).reverse().find(candidate => path.isAbsolute(candidate));
  const java = home ? path.join(home, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : initial;
  const result = spawnSync(java, ['-version'], { encoding: 'utf8', shell: false, windowsHide: true, timeout: 15_000 });
  const text = `${result.stdout || ''}${result.stderr || ''}`.trim();
  if (result.error || result.status !== 0) throw new Error(`JDK 25 is required: ${result.error?.message || text || 'java -version failed'}`);
  const match = text.match(/version\s+"(\d+)/);
  if (!match || Number(match[1]) < 25) throw new Error(`JDK 25 or newer is required: ${text}`);
  evidence.tool.javaPath = java;
  evidence.tool.javaVersion = text.split(/\r?\n/)[0];
}

async function runLogged(command, args, logFile) {
  const result = spawnSync(command, args, { encoding: 'utf8', shell: false, windowsHide: true, timeout: 2 * 60 * 1000, maxBuffer: 2_000_000 });
  await writeFile(logFile, `$ ${[command, ...args].join(' ')}\n${result.stdout || ''}${result.stderr || ''}`, 'utf8');
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error?.message || result.stderr || `exit ${result.status}`}`);
}

async function compileFixture(format, work) {
  const binary = path.join(work, format === 'pe' ? 'v004-sample.dll' : 'libv004-sample.so');
  const logFile = path.join(OUTPUT_DIR, `${format}-compile.log`);
  const common = ['-O0', '-fno-builtin', '-fno-stack-protector', '-fno-asynchronous-unwind-tables', path.join(FIXTURE_DIR, 'sample.c')];
  if (format === 'pe') {
    if (process.platform === 'win32') await runLogged('clang', ['--target=x86_64-pc-windows-msvc', '-fuse-ld=lld-link', '-nostdlib', '-shared', '-Wl,/entry:v004_entry', '-Wl,/subsystem:console', ...common, '-o', binary], logFile);
    else await runLogged('x86_64-w64-mingw32-gcc', ['-shared', '-nostdlib', '-Wl,--entry=v004_entry', ...common, '-o', binary], logFile);
  } else {
    await runLogged(process.env.CC || 'cc', ['-shared', '-fPIC', ...common, '-o', binary], logFile);
  }
  return { binary, sha256: await sha256(binary) };
}

function taskContext(dataDir, name, buffer) {
  const projectId = 'ghidra-v004-fixture';
  return {
    taskId: 'verify', project: { id: projectId, name: 'ghidra-v004', kind: 'software', target: 'locally compiled authorized fixture', authorizationConfirmed: true, createdAt: new Date(0).toISOString() },
    upload: { id: 'fixture', projectId, name, storedName: name, mime: 'application/octet-stream', size: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex'), createdAt: new Date(0).toISOString() },
    options: { ghidraTimeoutMs: 600_000, ghidraMaxOutputBytes: 8_000_000, ghidraMaxMetadataBytes: 16_000_000, maxDiskMB: 1024 }, stageOutputs: {}, dataDir, signal: new AbortController().signal,
    log: async () => {}, evidence: async () => 'evidence', finding: async () => 'finding', writeArtifact: async () => {}, readArtifact: async () => Buffer.alloc(0),
  };
}

async function captureApplicationLog(format) {
  if (!evidence.tool.version) return;
  const configBase = process.platform === 'win32'
    ? process.env.APPDATA
    : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  if (!configBase) return;
  const logFile = path.join(configBase, 'ghidra', `ghidra_${evidence.tool.version}_PUBLIC`, 'application.log');
  try {
    const content = await readFile(logFile, 'utf8');
    await writeFile(path.join(OUTPUT_DIR, `${format}-application.log`), content.slice(-250_000), 'utf8');
  } catch {
    // The application log is optional diagnostic evidence; stdout/stderr remain authoritative.
  }
}

async function analyzeFixture(format, binary, binarySha256, work, adapter) {
  const dataDir = path.join(work, `runtime-${format}`);
  const uploadDir = path.join(dataDir, 'uploads', 'ghidra-v004-fixture');
  await mkdir(uploadDir, { recursive: true });
  const name = path.basename(binary);
  const stored = path.join(uploadDir, name);
  await copyFile(binary, stored);
  const buffer = await readFile(stored);
  const ctx = taskContext(dataDir, name, buffer);
  ctx.stageOutputs.PREPARE = await adapter.prepare(ctx);
  const result = await adapter.analyze(ctx);
  ctx.stageOutputs.ANALYZE = result;
  const validation = await adapter.validate(ctx);
  await writeFile(path.join(OUTPUT_DIR, `${format}-headless.stdout.log`), result.stdout, 'utf8');
  await writeFile(path.join(OUTPUT_DIR, `${format}-headless.stderr.log`), result.stderr, 'utf8');
  const metadata = result.metadata;
  await writeFile(path.join(OUTPUT_DIR, `${format}-metadata.json`), `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
  const checks = [
    { name: 'headless process completed', passed: result.status === 'completed' && result.exitCode === 0 },
    { name: 'adapter validation passed', passed: validation.passed },
    { name: 'format matches compiled fixture', passed: metadata.format === expected.formats[format], expected: expected.formats[format], observed: metadata.format },
    { name: 'known functions recovered', passed: expected.functions.every(name => metadata.functions.some(item => item.name === name)), expected: expected.functions, observed: metadata.functions.map(item => item.name) },
    { name: 'known functions decompiled', passed: expected.functions.every(name => metadata.decompiledFunctions.some(item => item.name === name && item.pseudocode.trim().length > 0)), observed: metadata.decompiledFunctions.map(item => item.name) },
    { name: 'no decompiler failures', passed: metadata.decompileFailureCount === 0, observed: metadata.decompileFailureCount },
    { name: 'known direct call edges recovered', passed: expected.calls.every(edge => metadata.calls.some(item => item.caller === edge.caller && item.callee === edge.callee)), expected: expected.calls, observed: metadata.calls },
    { name: 'known string recovered', passed: expected.stringReferences.every(reference => metadata.strings.includes(reference.value)), expected: expected.stringReferences },
    { name: 'known string address/function references recovered', passed: expected.stringReferences.every(reference => metadata.stringReferences.some(item => item.value === reference.value && item.function === reference.function && item.address.length > 0)), expected: expected.stringReferences, observed: metadata.stringReferences },
    { name: 'inventories and process output were not truncated', passed: !metadata.truncated && !result.outputTruncated },
  ];
  return { format, binary: name, sha256: binarySha256, passed: checks.every(check => check.passed), checks, observed: { format: metadata.format, architecture: metadata.architecture, functions: metadata.functions.map(item => item.name), decompiledFunctions: metadata.decompiledFunctions, calls: metadata.calls, strings: metadata.strings, stringReferences: metadata.stringReferences, decompileFailureCount: metadata.decompileFailureCount, truncated: metadata.truncated, limitations: result.limitations } };
}

let work;
try {
  work = await mkdtemp(path.join(os.tmpdir(), 'verify-ghidra-v004-'));
  const formats = (process.argv.slice(2).join(',') || process.env.GHIDRA_VERIFY_FORMATS || 'pe,elf').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
  if (!formats.length || formats.some(format => format !== 'pe' && format !== 'elf')) throw new Error('Formats must be a comma-separated subset of pe,elf');
  const install = await prepareTool(work);
  selectedJava(install);
  process.env.RE_GHIDRA_INSTALL_DIR = install;
  delete process.env.RE_GHIDRA_HEADLESS;
  const { ghidraAdapter } = await import(pathToFileURL(path.join(ROOT, 'packages', 'core', 'dist', 'adapters', 'ghidra.js')).href);
  for (const format of formats) {
    try {
      const fixture = await compileFixture(format, work);
      evidence.fixtures.push(await analyzeFixture(format, fixture.binary, fixture.sha256, work, ghidraAdapter));
    } catch (error) {
      await captureApplicationLog(format);
      evidence.fixtures.push({ format, passed: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  evidence.status = evidence.fixtures.length > 0 && evidence.fixtures.every(fixture => fixture.passed) ? 'passed' : 'failed';
} catch (error) {
  evidence.error = error instanceof Error ? error.message : String(error);
} finally {
  await writeFile(path.join(OUTPUT_DIR, 'ghidra-v004-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  if (work) await rm(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
if (evidence.status !== 'passed') {
  console.error(`Ghidra v0.0.4 verification failed; evidence: ${path.join(OUTPUT_DIR, 'ghidra-v004-evidence.json')}`);
  process.exitCode = 1;
} else {
  console.log(`Ghidra v0.0.4 verification passed; evidence: ${path.join(OUTPUT_DIR, 'ghidra-v004-evidence.json')}`);
}

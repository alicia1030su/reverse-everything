import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yazl from 'yazl';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_DIR = path.join(ROOT, 'tests', 'fixtures', 'android');
const JADX_VERSION = '1.5.3';
const JADX_SHA256 = '8280f3799c0273fe797a2bcd90258c943e451fd195f13d05400de5e6451d15ec';
const JADX_URL = `https://github.com/skylot/jadx/releases/download/v${JADX_VERSION}/jadx-${JADX_VERSION}.zip`;
const JADX_ARCHIVE_BYTES = 116608944;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function align(value, boundary = 4) {
  return Math.ceil(value / boundary) * boundary;
}

function uleb(value) {
  const bytes = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value) byte |= 0x80;
    bytes.push(byte);
  } while (value);
  return Buffer.from(bytes);
}

function length8(value) {
  if (value < 0x80) return Buffer.from([value]);
  if (value < 0x4000) return Buffer.from([(value >> 8) | 0x80, value & 0xff]);
  if (value < 0x200000) return Buffer.from([(value >> 16) | 0x80, (value >> 8) | 0x80, value & 0xff]);
  throw new Error('Fixture UTF-8 string is too large');
}

function adler32(data) {
  let a = 1;
  let b = 0;
  for (const byte of data) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function finishDex(buffer) {
  buffer.writeUInt32LE(buffer.length, 32);
  buffer.writeUInt32LE(112, 36);
  buffer.writeUInt32LE(0x12345678, 40);
  createHash('sha1').update(buffer.subarray(32)).digest().copy(buffer, 12);
  buffer.writeUInt32LE(adler32(buffer.subarray(12)), 8);
  return buffer;
}

function writeCode(buffer, offset, registers, inputs, outputs, instructions) {
  buffer.writeUInt16LE(registers, offset);
  buffer.writeUInt16LE(inputs, offset + 2);
  buffer.writeUInt16LE(outputs, offset + 4);
  buffer.writeUInt16LE(0, offset + 6);
  buffer.writeUInt32LE(0, offset + 8);
  buffer.writeUInt32LE(instructions.length, offset + 12);
  instructions.forEach((instruction, index) => buffer.writeUInt16LE(instruction, offset + 16 + index * 2));
  return 16 + instructions.length * 2;
}

function buildDex(expected) {
  const strings = [
    '<init>',
    'Fixture.java',
    'L',
    `L${expected.className.replaceAll('.', '/')};`,
    'Ljava/lang/Object;',
    'Ljava/lang/String;',
    'V',
    expected.methodName,
    expected.stringValue,
  ].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  const stringIndex = value => strings.indexOf(value);
  const typeIds = ['Ljava/lang/Object;', 'Ljava/lang/String;', `L${expected.className.replaceAll('.', '/')};`, 'V'].sort((left, right) => stringIndex(left) - stringIndex(right));
  const typeIndex = value => typeIds.indexOf(value);
  const stringIdsOff = 112;
  const typeIdsOff = stringIdsOff + strings.length * 4;
  const protoIdsOff = typeIdsOff + typeIds.length * 4;
  const methodIdsOff = protoIdsOff + 2 * 12;
  const classDefsOff = methodIdsOff + 3 * 8;
  const dataOff = classDefsOff + 32;
  const classType = typeIndex(`L${expected.className.replaceAll('.', '/')};`);
  const objectType = typeIndex('Ljava/lang/Object;');
  const stringType = typeIndex('Ljava/lang/String;');
  const voidType = typeIndex('V');
  if ([classType, objectType, stringType, voidType].includes(-1)) throw new Error('Fixture DEX type table is incomplete');
  const voidProto = 1;
  const stringProto = 0;
  const methodIds = [
    { class: classType, name: stringIndex('<init>'), proto: voidProto },
    { class: classType, name: stringIndex(expected.methodName), proto: stringProto },
    { class: objectType, name: stringIndex('<init>'), proto: voidProto },
  ];
  const stringOffsets = [];
  let cursor = dataOff;
  const stringData = strings.map(value => {
    const bytes = Buffer.from(value, 'utf8');
    const item = Buffer.concat([length8(value.length), length8(bytes.length), bytes, Buffer.from([0])]);
    const offset = cursor;
    stringOffsets.push(offset);
    cursor += align(item.length);
    return item;
  });
  const constructorOff = cursor;
  cursor += align(writeCode(Buffer.alloc(32), 0, 1, 1, 1, [0x1070, 2, 0x000e]));
  const markerOff = cursor;
  cursor += align(writeCode(Buffer.alloc(32), 0, 1, 0, 0, [0x001a, stringIndex(expected.stringValue), 0x0011]));
  const classDataOff = cursor;
  const classData = Buffer.concat([
    uleb(0), uleb(0), uleb(1), uleb(1),
    uleb(0), uleb(0x10002), uleb(constructorOff),
    uleb(1), uleb(0x9), uleb(markerOff),
  ]);
  cursor += classData.length;
  const mapOff = cursor;
  const mapEntries = [
    [0x0000, 1, 0], [0x0001, strings.length, stringIdsOff], [0x0002, typeIds.length, typeIdsOff],
    [0x0003, 2, protoIdsOff], [0x0005, methodIds.length, methodIdsOff], [0x0006, 1, classDefsOff],
    [0x2002, strings.length, dataOff], [0x2001, 1, constructorOff], [0x2001, 1, markerOff],
    [0x2000, 1, classDataOff], [0x1000, 1, mapOff],
  ];
  const buffer = Buffer.alloc(mapOff + 4 + mapEntries.length * 12);
  buffer.write('dex\n035\0', 0, 'latin1');
  buffer.writeUInt32LE(strings.length, 56); buffer.writeUInt32LE(stringIdsOff, 60);
  buffer.writeUInt32LE(typeIds.length, 64); buffer.writeUInt32LE(typeIdsOff, 68);
  buffer.writeUInt32LE(2, 72); buffer.writeUInt32LE(protoIdsOff, 76);
  buffer.writeUInt32LE(methodIds.length, 88); buffer.writeUInt32LE(methodIdsOff, 92);
  buffer.writeUInt32LE(1, 96); buffer.writeUInt32LE(classDefsOff, 100);
  buffer.writeUInt32LE(buffer.length - dataOff, 104); buffer.writeUInt32LE(dataOff, 108); buffer.writeUInt32LE(mapOff, 52);
  stringOffsets.forEach((offset, index) => buffer.writeUInt32LE(offset, stringIdsOff + index * 4));
  typeIds.forEach((value, index) => buffer.writeUInt32LE(stringIndex(value), typeIdsOff + index * 4));
  buffer.writeUInt32LE(stringIndex('L'), protoIdsOff); buffer.writeUInt32LE(stringType, protoIdsOff + 4); buffer.writeUInt32LE(0, protoIdsOff + 8);
  buffer.writeUInt32LE(stringIndex('V'), protoIdsOff + 12); buffer.writeUInt32LE(voidType, protoIdsOff + 16); buffer.writeUInt32LE(0, protoIdsOff + 20);
  methodIds.forEach((method, index) => {
    const offset = methodIdsOff + index * 8;
    buffer.writeUInt16LE(method.class, offset); buffer.writeUInt16LE(method.proto, offset + 2); buffer.writeUInt32LE(method.name, offset + 4);
  });
  buffer.writeUInt32LE(classType, classDefsOff); buffer.writeUInt32LE(0x11, classDefsOff + 4); buffer.writeUInt32LE(objectType, classDefsOff + 8);
  buffer.writeUInt32LE(0, classDefsOff + 12); buffer.writeUInt32LE(stringIndex('Fixture.java'), classDefsOff + 16); buffer.writeUInt32LE(0, classDefsOff + 20);
  buffer.writeUInt32LE(classDataOff, classDefsOff + 24); buffer.writeUInt32LE(0, classDefsOff + 28);
  stringData.forEach((item, index) => item.copy(buffer, stringOffsets[index]));
  writeCode(buffer, constructorOff, 1, 1, 1, [0x1070, 2, 0x000e]);
  writeCode(buffer, markerOff, 1, 0, 0, [0x001a, stringIndex(expected.stringValue), 0x0011]);
  classData.copy(buffer, classDataOff);
  buffer.writeUInt32LE(mapEntries.length, mapOff);
  mapEntries.forEach(([type, size, offset], index) => {
    const entry = mapOff + 4 + index * 12;
    buffer.writeUInt16LE(type, entry); buffer.writeUInt16LE(0, entry + 2); buffer.writeUInt32LE(size, entry + 4); buffer.writeUInt32LE(offset, entry + 8);
  });
  return finishDex(buffer);
}

function buildManifest(expected) {
  const strings = ['android', expected.packageName, 'manifest', 'package', 'uses-permission', 'name', expected.permission, 'permission', expected.declaredPermission];
  const offsets = [];
  const encoded = [];
  for (const value of strings) {
    const bytes = Buffer.from(value, 'utf8');
    offsets.push(encoded.length);
    encoded.push(...length8(value.length), ...length8(bytes.length), ...bytes, 0);
  }
  while (encoded.length % 4) encoded.push(0);
  const stringsStart = 28 + strings.length * 4;
  const pool = Buffer.alloc(stringsStart + encoded.length);
  pool.writeUInt16LE(1, 0); pool.writeUInt16LE(28, 2); pool.writeUInt32LE(pool.length, 4);
  pool.writeUInt32LE(strings.length, 8); pool.writeUInt32LE(0x100, 16); pool.writeUInt32LE(stringsStart, 20);
  offsets.forEach((offset, index) => pool.writeUInt32LE(offset, 28 + index * 4));
  Buffer.from(encoded).copy(pool, stringsStart);
  const start = (name, attributes) => {
    const chunk = Buffer.alloc(36 + attributes.length * 20);
    chunk.writeUInt16LE(0x0102, 0); chunk.writeUInt16LE(16, 2); chunk.writeUInt32LE(chunk.length, 4);
    chunk.writeUInt32LE(0xffffffff, 8); chunk.writeUInt32LE(0xffffffff, 16); chunk.writeUInt32LE(name, 20);
    chunk.writeUInt16LE(20, 24); chunk.writeUInt16LE(20, 26); chunk.writeUInt16LE(attributes.length, 28);
    attributes.forEach((attribute, index) => {
      const offset = 36 + index * 20;
      chunk.writeUInt32LE(attribute.ns, offset); chunk.writeUInt32LE(attribute.name, offset + 4); chunk.writeUInt32LE(0xffffffff, offset + 8);
      chunk.writeUInt16LE(8, offset + 12); chunk[offset + 15] = 3; chunk.writeUInt32LE(attribute.value, offset + 16);
    });
    return chunk;
  };
  const end = name => {
    const chunk = Buffer.alloc(24);
    chunk.writeUInt16LE(0x0103, 0); chunk.writeUInt16LE(16, 2); chunk.writeUInt32LE(24, 4);
    chunk.writeUInt32LE(0xffffffff, 8); chunk.writeUInt32LE(0xffffffff, 16); chunk.writeUInt32LE(name, 20);
    return chunk;
  };
  const body = Buffer.concat([
    pool,
    start(2, [{ ns: 0xffffffff, name: 3, value: 1 }]),
    start(4, [{ ns: 0, name: 5, value: 6 }]), end(4),
    start(7, [{ ns: 0, name: 5, value: 8 }]), end(7), end(2),
  ]);
  const root = Buffer.alloc(8 + body.length);
  root.writeUInt16LE(3, 0); root.writeUInt16LE(8, 2); root.writeUInt32LE(root.length, 4); body.copy(root, 8);
  return root;
}

async function zip(entries) {
  const archive = new yazl.ZipFile();
  for (const entry of entries) archive.addBuffer(entry.data, entry.name, { mtime: new Date(1980, 0, 1), mode: 0o100644, compress: false, forceDosTimestamp: true });
  return new Promise((resolve, reject) => {
    const chunks = [];
    archive.outputStream.on('data', chunk => chunks.push(chunk));
    archive.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    archive.outputStream.on('error', reject);
    archive.end();
  });
}

async function buildFixture() {
  const expected = JSON.parse(await readFile(path.join(FIXTURE_DIR, 'expected.json'), 'utf8'));
  const source = await readFile(path.join(FIXTURE_DIR, 'Fixture.java'));
  const manifestSource = await readFile(path.join(FIXTURE_DIR, 'AndroidManifest.xml'));
  if (!source.toString('utf8').includes(expected.className.split('.').at(-1)) || !source.toString('utf8').includes(expected.methodName)) throw new Error('Fixture source does not match expected.json');
  if (!manifestSource.toString('utf8').includes(expected.packageName) || !manifestSource.toString('utf8').includes(expected.permission)) throw new Error('Fixture manifest source does not match expected.json');
  const dex = buildDex(expected);
  const apk = await zip([
    { name: 'AndroidManifest.xml', data: buildManifest(expected) },
    { name: 'classes.dex', data: dex },
    { name: expected.resourcePath, data: Buffer.from(expected.resourceValue, 'utf8') },
  ]);
  const provenance = {
    fixture: 'minimal.apk',
    generator: 'scripts/verify-jadx.mjs --build-fixture',
    generationMethod: 'Deterministic synthetic DEX 035 and binary AXML assembled in Node.js with stored ZIP entries and timezone-independent DOS timestamps; mirrors the checked-in Fixture.java and AndroidManifest.xml known answers. No APK is executed.',
    sourceSha256: sha256(source),
    manifestSourceSha256: sha256(manifestSource),
    dexSha256: sha256(dex),
    apkSha256: sha256(apk),
    expected: 'expected.json',
    jadxVerification: { version: JADX_VERSION, officialArchiveSha256: JADX_SHA256, officialUrl: JADX_URL },
  };
  await writeFile(path.join(FIXTURE_DIR, 'minimal.apk'), apk);
  await writeFile(path.join(FIXTURE_DIR, 'provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`);
  return provenance;
}

async function checkFixture() {
  const expected = JSON.parse(await readFile(path.join(FIXTURE_DIR, 'expected.json'), 'utf8'));
  const source = await readFile(path.join(FIXTURE_DIR, 'Fixture.java'));
  const manifestSource = await readFile(path.join(FIXTURE_DIR, 'AndroidManifest.xml'));
  const dex = buildDex(expected);
  const apk = await zip([
    { name: 'AndroidManifest.xml', data: buildManifest(expected) },
    { name: 'classes.dex', data: dex },
    { name: expected.resourcePath, data: Buffer.from(expected.resourceValue, 'utf8') },
  ]);
  const checkedIn = await readFile(path.join(FIXTURE_DIR, 'minimal.apk'));
  if (!checkedIn.equals(apk)) throw new Error('Checked-in minimal.apk does not match the deterministic generator');
  const provenance = JSON.parse(await readFile(path.join(FIXTURE_DIR, 'provenance.json'), 'utf8'));
  if (provenance.apkSha256 !== sha256(apk) || provenance.dexSha256 !== sha256(dex) || provenance.sourceSha256 !== sha256(source) || provenance.manifestSourceSha256 !== sha256(manifestSource)) throw new Error('Fixture provenance hash mismatch');
  return { fixtureSha256: sha256(apk), deterministic: true };
}

async function verifyArchive(file) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('JADX archive must be a regular file');
  if (info.size !== JADX_ARCHIVE_BYTES) throw new Error(`JADX archive size mismatch: ${info.size} !== ${JADX_ARCHIVE_BYTES}`);
  const digest = await hashFile(file);
  if (digest !== JADX_SHA256) throw new Error(`JADX archive SHA256 mismatch: ${digest}`);
  return { archive: file, version: JADX_VERSION, sha256: digest, bytes: info.size, officialUrl: JADX_URL };
}

function javaCommand() {
  if (process.env.RE_JAVA) return path.resolve(process.env.RE_JAVA);
  if (process.env.JAVA_HOME) return path.join(path.resolve(process.env.JAVA_HOME), 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
  return 'java';
}

async function killTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    await new Promise(resolve => {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', shell: false, windowsHide: true });
      const timer = setTimeout(resolve, 3000);
      killer.once('error', () => { clearTimeout(timer); resolve(); });
      killer.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    return;
  }
  try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* already exited */ } }
}

async function run(command, args, options = {}) {
  const env = { ...process.env, JADX_DISABLE_XML_SECURITY: 'false', JADX_DISABLE_ZIP_SECURITY: 'false' };
  delete env._JAVA_OPTIONS; delete env.JAVA_TOOL_OPTIONS; delete env.JDK_JAVA_OPTIONS;
  const child = spawn(command, args, { cwd: options.cwd, env, stdio: ['ignore', 'pipe', 'pipe'], shell: false, detached: process.platform !== 'win32', windowsHide: true });
  return new Promise((resolve, reject) => {
    let stdout = ''; let stderr = ''; let settled = false;
    const append = (target, chunk) => target.length < 1_000_000 ? target + chunk.toString('utf8').slice(0, 1_000_000 - target.length) : target;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => { void killTree(child).then(() => finish(new Error(`JADX command timeout after ${options.timeoutMs ?? 120000}ms`))); }, options.timeoutMs ?? 120000);
    child.stdout.on('data', chunk => { stdout = append(stdout, chunk); });
    child.stderr.on('data', chunk => { stderr = append(stderr, chunk); });
    child.once('error', error => finish(new Error(`Unable to start ${command}: ${error.message}`)));
    child.once('close', code => code === 0 ? finish(null, { code, stdout, stderr }) : finish(new Error(`JADX exited with code ${code}: ${(stderr || stdout).slice(0, 2000)}`)));
  });
}

async function verifyRealJadx(home, apk) {
  const resolved = path.resolve(home);
  let cli;
  for (const candidate of [path.join(resolved, 'lib', `jadx-${JADX_VERSION}-all.jar`), path.join(resolved, 'lib', `jadx-cli-${JADX_VERSION}-all.jar`), path.join(resolved, 'lib', `jadx-cli-${JADX_VERSION}.jar`)]) {
    try { if ((await stat(candidate)).isFile()) { cli = candidate; break; } } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (!cli) throw new Error(`Missing pinned JADX CLI in ${resolved}/lib`);
  const cliSha256 = await hashFile(cli);
  const java = javaCommand();
  const prefix = ['-cp', path.join(resolved, 'lib', '*'), 'jadx.cli.JadxCLI'];
  const version = await run(java, [...prefix, '--version'], { timeoutMs: 10000 });
  const versionOutput = `${version.stdout}${version.stderr}`.trim().split(/\r?\n/)[0] ?? '';
  if (!new RegExp(`^jadx\\s+${JADX_VERSION.replaceAll('.', '\\.')}$`, 'i').test(versionOutput)) throw new Error(`JADX version probe did not report ${JADX_VERSION}`);
  const work = await mkdtemp(path.join(os.tmpdir(), 're-jadx-verify-'));
  try {
    const output = path.join(work, 'output');
    const execution = await run(java, [...prefix, '-d', output, '--threads-count', '1', '--show-bad-code', '--no-debug-info', '--deobf-cfg-file-mode', 'ignore', '--log-level', 'progress', path.resolve(apk)], { cwd: work });
    const expected = JSON.parse(await readFile(path.join(FIXTURE_DIR, 'expected.json'), 'utf8'));
    const javaPath = path.join(output, 'sources', `${expected.className.replaceAll('.', '/')}.java`);
    const resourcePath = path.join(output, 'resources', expected.resourcePath);
    const manifestPath = path.join(output, 'resources', 'AndroidManifest.xml');
    const source = await readFile(javaPath, 'utf8');
    const resource = await readFile(resourcePath, 'utf8');
    const manifest = await readFile(manifestPath, 'utf8');
    if (!source.includes(`class ${expected.className.split('.').at(-1)}`) || !source.includes(`${expected.methodName}(`) || !source.includes(expected.stringValue)) throw new Error('JADX Java known-answer mismatch');
    if (!source.includes(`String ${expected.methodName}(`)) throw new Error('JADX method return type known-answer mismatch');
    if (resource !== expected.resourceValue) throw new Error('JADX resource known-answer mismatch');
    if (!manifest.includes(expected.packageName) || !manifest.includes(expected.permission) || !manifest.includes(expected.declaredPermission)) throw new Error('JADX manifest known-answer mismatch');
    return { realJadx: true, version: JADX_VERSION, archiveSha256: JADX_SHA256, cliSha256, className: expected.className, methodName: expected.methodName, stringValue: expected.stringValue, resourcePath: expected.resourcePath, packageName: expected.packageName, stdout: execution.stdout.slice(-4000), stderr: execution.stderr.slice(-4000) };
  } finally {
    await rm(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

function argsOf(argv) {
  const args = { buildFixture: false, checkFixture: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--build-fixture') args.buildFixture = true;
    else if (arg === '--check-fixture') args.checkFixture = true;
    else if (arg === '--archive' || arg === '--jadx-home' || arg === '--apk' || arg === '--log') {
      const value = argv[++index];
      if (!value) throw new Error(`Missing value for ${arg}`);
      if (arg === '--jadx-home') args.jadxHome = value;
      else args[arg.slice(2)] = value;
    }
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

async function main() {
  const args = argsOf(process.argv.slice(2));
  const report = {};
  if (args.buildFixture) report.fixture = await buildFixture();
  if (args.checkFixture) report.fixtureCheck = await checkFixture();
  if (args.archive) report.archive = await verifyArchive(path.resolve(args.archive));
  if (args.jadxHome) report.jadx = await verifyRealJadx(path.resolve(args.jadxHome), args.apk ? path.resolve(args.apk) : path.join(FIXTURE_DIR, 'minimal.apk'));
  if (Object.keys(report).length === 0) throw new Error('Specify --build-fixture, --check-fixture, --archive <file> or --jadx-home <dir>');
  const text = `${JSON.stringify(report, null, 2)}\n`;
  process.stdout.write(text);
  if (args.log) { await mkdir(path.dirname(path.resolve(args.log)), { recursive: true }); await writeFile(path.resolve(args.log), text); }
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });

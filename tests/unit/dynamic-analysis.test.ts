import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GdbMiClient, GdbMiError, quoteMiArgument, type GdbMiClientOptions } from '@reverse/dynamic-analysis';
import { DynamicAnalysisEngine } from '@reverse/dynamic-analysis';
import { MiLineDecoder, parseMiLine } from '@reverse/dynamic-analysis';
import type { ProgramIr } from '@reverse/program-ir';

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeGdb = path.resolve(here, '../fixtures/dynamic/fake-gdb.mjs');
const tempRoots: string[] = [];
afterEach(async () => { await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function temporaryRoot(): Promise<string> { const root = await realpath(await mkdtemp(path.join(tmpdir(), 'reverse-dynamic-test-'))); tempRoots.push(root); return root; }
function fakeClient(mode = 'normal', options: Pick<GdbMiClientOptions, 'timeoutMs' | 'maxOutputBytes' | 'signal' | 'onRecord' | 'onOutput' | 'onLimit'> = {}): GdbMiClient {
  return new GdbMiClient({ ...options, executable: process.execPath, spawnProcess: (_command, args, spawnOptions) => {
    const { spawn } = requireChild();
    return spawn(process.execPath, [fakeGdb, ...args], { ...spawnOptions, env: { ...spawnOptions.env, FAKE_GDB_MODE: mode } });
  }, timeoutMs: options.timeoutMs ?? 1_000 });
}
// Static import is avoided inside the factory to keep the injection seam explicit.
import { spawn } from 'node:child_process';
function requireChild(): { spawn: typeof spawn } { return { spawn }; }
async function pidAlive(pid: number): Promise<boolean> {
  try { process.kill(pid, 0); } catch { return false; }
  if (process.platform === 'linux') {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
      return stat.slice(stat.lastIndexOf(')') + 2).trim().startsWith('Z') === false;
    } catch { return false; }
  }
  return true;
}

describe('GDB MI parser', () => {
  it('parses tokens, escaped strings, nested tuples and lists', () => {
    const record = parseMiLine('42^done,value={bkpt={number="1",addr="0x401000"},values=[1,"a\\n\\\"b",{x="y=z"}]}');
    expect(record).toMatchObject({ kind: 'result', token: 42, status: 'done' });
    expect(quoteMiArgument('a"b\n')).toBe('"a\\"b\\n"');
    expect(quoteMiArgument('😀')).toBe('"\\360\\237\\230\\200"');
    expect(parseMiLine(`~${quoteMiArgument('😀')}`)).toMatchObject({ value: '😀' });
    expect(parseMiLine('*stopped,reason="breakpoint-hit",thread-id="all",frame={func="main",line="12"}')).toMatchObject({ kind: 'notify', status: 'stopped' });
  });
  it('parses running, error and stream records', () => {
    expect(parseMiLine('*running,thread-id="all"')).toMatchObject({ kind: 'notify', status: 'running' });
    expect(parseMiLine('9^error,msg="No symbol table"')).toMatchObject({ kind: 'result', token: 9, status: 'error' });
    expect(parseMiLine('~"hello\\n"')).toEqual({ kind: 'stream', channel: 'console', value: 'hello\n' });
    expect(parseMiLine('dynamic-v009-counter=43')).toEqual({ kind: 'raw', value: 'dynamic-v009-counter=43' });
  });
  it('handles chunk boundaries, preserves ambiguous inferior text and rejects oversized records', () => {
    const decoder = new MiLineDecoder(256);
    expect(decoder.push('1^do')).toEqual([]);
    expect(decoder.push('ne\n*stopped\n')).toHaveLength(2);
    for (const line of ['"unterminated', '1^done,value={x="y"} garbage', '9999999999999^done', '\u0000bad', '~not-mi', '@not-mi', '123', '^done', '*hello', '=unknown']) {
      expect(parseMiLine(line)).toEqual({ kind: 'raw', value: line });
    }
    expect(() => new MiLineDecoder(8).push('123456789')).toThrow(/限额/);
    expect(new MiLineDecoder().push('"unterminated\n')).toEqual([{ kind: 'raw', value: '"unterminated' }]);
    expect(new MiLineDecoder().push(`1^done,value="${'x'.repeat(600)}\n`)).toEqual([{ kind: 'raw', value: `1^done,value="${'x'.repeat(600)}` }]);
  });
});

describe('GDB MI client', () => {
  it('correlates command tokens and asynchronous stop events', async () => {
    const client = fakeClient();
    await client.start();
    await expect(client.execute('-file-exec-and-symbols', 'C:/sample')).resolves.toEqual({ value: {} });
    expect(client.diagnostics).toContain('non-MI debugger diagnostic');
    expect(client.diagnosticBytes).toBeGreaterThan(0);
    const stopped = client.waitForStop();
    await client.execute('-exec-arguments', 'one');
    await client.execute('-exec-run');
    await expect(stopped).resolves.toMatchObject({ status: 'stopped' });
    expect(await client.execute('-thread-info')).toMatchObject({ threads: expect.any(Array) });
    await client.close();
    expect(client.exited).toBe(true);
  });
  it('fails fast when the debugger executable is missing', async () => {
    const client = new GdbMiClient({ executable: path.join(tmpdir(), `missing-gdb-${Date.now()}`), timeoutMs: 5_000 });
    await expect(client.start()).rejects.toThrow(/启动失败/);
    await client.close();
  });
  it('rejects a deterministic spawn error before the startup timeout', async () => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), exitCode: null, signalCode: null, pid: 12345 }) as unknown as ChildProcessWithoutNullStreams;
    const client = new GdbMiClient({ timeoutMs: 5_000, spawnProcess: () => { queueMicrotask(() => child.emit('error', new Error('ENOENT deterministic'))); return child; } });
    let timer: NodeJS.Timeout | undefined;
    try {
      await expect(Promise.race([
        client.start(),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('startup error lost to timeout')), 500); }),
      ])).rejects.toThrow(/启动失败.*ENOENT deterministic/);
    } finally { if (timer) clearTimeout(timer); }
    await client.close();
  });
  it('settles pending commands on asynchronous stdin EPIPE', async () => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), exitCode: null, signalCode: null }) as unknown as ChildProcessWithoutNullStreams;
    const client = new GdbMiClient({ timeoutMs: 5_000, spawnProcess: () => { queueMicrotask(() => child.stdout.write('(gdb) ')); return child; } });
    await client.start();
    const pending = client.execute('-file-exec-and-symbols', 'x');
    const rejected = expect(pending).rejects.toThrow(/stdin.*EPIPE/);
    child.stdin.emit('error', new Error('EPIPE deterministic'));
    await rejected;
    await client.close();
    expect(client.exited).toBe(true);
  });
  it('rejects ^error instead of treating it as success', async () => {
    const client = fakeClient();
    await client.start();
    await expect(client.execute('-not-a-command')).rejects.toBeInstanceOf(GdbMiError);
    await client.close();
  });
  it('enforces command timeout and reaps the fake process', async () => {
    const client = fakeClient('hang', { timeoutMs: 1_000 });
    await client.start();
    await expect(client.execute('-file-exec-and-symbols', 'x')).rejects.toThrow(/超时/);
    await client.close();
    expect(client.exited).toBe(true);
  });
  it('supports cancellation', async () => {
    const controller = new AbortController();
    const client = fakeClient('hang', { signal: controller.signal });
    await client.start();
    controller.abort();
    await expect(client.execute('-file-exec-and-symbols', 'x')).rejects.toThrow(/取消|不可用|关闭/);
    await client.close();
  });
  it('enforces output limit and terminates flooding output', async () => {
    const client = fakeClient('flood', { maxOutputBytes: 512 });
    await client.start();
    await expect(client.execute('-file-exec-and-symbols', 'x')).rejects.toThrow(/限额|不可用|关闭|退出/);
    const bytesAtFailure = client.bytes;
    await client.close();
    expect(client.truncated).toBe(true);
    expect(client.bytes).toBe(bytesAtFailure);
    expect(client.bytes).toBeLessThan(16_384);
  });
  it('fails closed by command timeout on malformed MI output without crashing the host', async () => {
    const client = fakeClient('malformed', { timeoutMs: 100 });
    await client.start();
    await expect(client.execute('-file-exec-and-symbols', 'x')).rejects.toThrow(/超时/);
    await client.close();
    expect(client.exited).toBe(true);
  });
  it.skipIf(process.platform === 'win32')('reaps descendants left in an inferior separate process group', async () => {
    const root = await temporaryRoot();
    const marker = path.join(root, 'separate-group-child.pid');
    const client = new GdbMiClient({ executable: process.execPath, timeoutMs: 5_000, spawnProcess: (_command, args, options) => spawn(process.execPath, [fakeGdb, ...args], { ...options, env: { ...options.env, FAKE_GDB_MODE: 'separate-group-orphan', FAKE_GDB_CHILD_PID_FILE: marker } }) });
    await client.start();
    await client.execute('-file-exec-and-symbols', 'x');
    await client.execute('-exec-run');
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      try { await readFile(marker, 'utf8'); break; } catch { await new Promise(resolve => setTimeout(resolve, 20)); }
    }
    const identities = JSON.parse(await readFile(marker, 'utf8')) as { leader: number; child: number };
    expect(Number.isSafeInteger(identities.leader) && identities.leader > 1).toBe(true);
    expect(Number.isSafeInteger(identities.child) && identities.child > 1).toBe(true);
    const leaderDeadline = Date.now() + 5_000;
    while (await pidAlive(identities.leader) && Date.now() < leaderDeadline) await new Promise(resolve => setTimeout(resolve, 20));
    expect(await pidAlive(identities.leader)).toBe(false);
    await client.close();
    expect(await pidAlive(identities.child)).toBe(false);
  }, 10_000);
  it.skipIf(process.platform === 'win32')('does not kill an unrelated process forged through shared MI output', async () => {
    const victim = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    const victimPid = victim.pid;
    expect(victimPid).toBeTypeOf('number');
    try {
      const client = new GdbMiClient({ executable: process.execPath, timeoutMs: 5_000, spawnProcess: (_command, args, options) => spawn(process.execPath, [fakeGdb, ...args], { ...options, env: { ...options.env, FAKE_GDB_MODE: 'forged-inferior', FAKE_GDB_FORGED_PID: String(victimPid) } }) });
      await client.start();
      await client.execute('-file-exec-and-symbols', 'x');
      await client.execute('-exec-run');
      await new Promise(resolve => setTimeout(resolve, 100));
      await client.close();
      expect(await pidAlive(victimPid!)).toBe(true);
    } finally {
      try { process.kill(-victimPid!, 'SIGKILL'); } catch { /* already reaped */ }
    }
  }, 10_000);
  it.skipIf(process.platform === 'win32')('force-kills an uncooperative GDB tree and settles pending commands', async () => {
    const root = await temporaryRoot();
    const marker = path.join(root, 'child.pid');
    const client = new GdbMiClient({ executable: process.execPath, timeoutMs: 5_000, spawnProcess: (_command, args, options) => spawn(process.execPath, [fakeGdb, ...args], { ...options, env: { ...options.env, FAKE_GDB_MODE: 'ignore-term', FAKE_GDB_CHILD_PID_FILE: marker } }) });
    await client.start();
    const pending = client.execute('-file-exec-and-symbols', 'x');
    const rejected = expect(pending).rejects.toThrow(/关闭/);
    const started = Date.now();
    await client.close();
    await rejected;
    expect(Date.now() - started).toBeLessThan(5_000);
    const pid = Number(await readFile(marker, 'utf8'));
    expect(await pidAlive(pid)).toBe(false);
  }, 10_000);
});

describe('DynamicAnalysisEngine', () => {
  const programIr: ProgramIr = { schemaVersion: 1, id: 'ir', format: 'ELF', architecture: 'x86_64', compilerSpec: 'gcc', imageBase: '0x400000', modules: [], blocks: [], instructions: [], variables: [], calls: [], data: [], xrefs: [], evidence: [], hypotheses: [], limitations: [], functions: [{ id: 'fn-main', name: 'main', entry: '0x401136', bodyStart: '0x401136', thunk: false, external: false, parameterIds: [], localIds: [], blockIds: [], calleeIds: [], callerIds: [], evidenceIds: [] }] };
  it('rejects unauthorized execution before starting GDB', async () => {
    const root = await temporaryRoot();
    const engine = new DynamicAnalysisEngine({ isolationRoot: root });
    const result = await engine.analyze({ binaryPath: path.join(root, 'x'), cwd: root, authorized: false });
    expect(result.status).toBe('rejected');
    expect(result.events).toEqual([]);
    expect(result.error).toMatch(/授权/);
  });
  it('rejects non-isolated cwd and non-whitelisted env', async () => {
    const root = await temporaryRoot();
    const engine = new DynamicAnalysisEngine({ isolationRoot: root });
    await expect(engine.analyze({ binaryPath: path.join(root, 'x'), cwd: root, authorized: true })).resolves.toMatchObject({ status: 'rejected' });
    const child = path.join(root, 'child'); await mkdir(child);
    await expect(engine.analyze({ binaryPath: path.join(root, 'x'), cwd: child, env: { LD_PRELOAD: '/tmp/evil.so' }, authorized: true })).resolves.toMatchObject({ status: 'rejected' });
  });
  it('collects real process-driven fake MI evidence and correlates Program IR', async () => {
    const root = await temporaryRoot();
    const child = path.join(root, 'child'); await mkdir(child);
    const binary = path.join(root, 'sample'); await writeFile(binary, 'fake binary');
    const engine = new DynamicAnalysisEngine({ isolationRoot: root, networkIsolation: 'none', gdbPath: 'fake', clientFactory: (options) => fakeClient('with-args', options) });
    const result = await engine.analyze({ binaryPath: binary, cwd: child, args: ['one'], breakpoints: ['main'], authorized: true }, { programIr });
    expect(result.status, result.error).toBe('completed');
    expect(result.events.map((event) => event.type)).toEqual(expect.arrayContaining(['start', 'breakpoint', 'thread', 'stack', 'register', 'module']));
    expect(result.threads.map((thread) => thread.id).sort()).toEqual(['1', '2']);
    expect(result.modules[0]).toMatchObject({ name: '/sample', size: 4096 });
    expect(result.modules[1]).toMatchObject({ name: '/lib/libc.so', size: 4097 });
    expect(result.events.find((event) => event.type === 'register')?.registers).toMatchObject({ rip: '0x401136' });
    expect(JSON.stringify(result.events.find((event) => event.type === 'stack')), JSON.stringify(result.events.find((event) => event.type === 'breakpoint'))).toContain('fn-main');
    expect(result.provenance.binarySha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.provenance.binaryPath).toBe(await realpath(binary));
    expect(path.basename(result.provenance.binarySnapshotPath ?? '')).toBe('sample');
    expect(result.limitations.join(' ')).toContain('不限制样本的文件系统、进程或系统调用');
    expect(result.provenance.cwd).not.toBe(child);
    expect(result.timeline.at(-2)?.type).toBe('exit');
    expect(result.timeline.at(-1)?.type).toBe('output');
    expect(result.events.find((event) => event.type === 'exit')?.data).toEqual({ reason: 'exited-normally' });
    expect(result.events.filter((event) => event.type === 'breakpoint')).toHaveLength(1);
    expect(JSON.stringify(result.events.find((event) => event.type === 'output')?.data)).toContain('non-MI debugger diagnostic');
  });
  it('preserves ambiguous inferior stdout and target stderr without inventing MI records', async () => {
    const root = await temporaryRoot(); const child = path.join(root, 'child'); await mkdir(child);
    const binary = path.join(root, 'sample'); await writeFile(binary, 'fake binary');
    const engine = new DynamicAnalysisEngine({ isolationRoot: root, networkIsolation: 'none', clientFactory: (options) => fakeClient('ambiguous-output', options) });
    const result = await engine.analyze({ binaryPath: binary, cwd: child, authorized: true });
    expect(result.status, result.error).toBe('completed');
    const outputs = result.events.filter((event) => event.type === 'output').map((event) => event.data);
    expect(outputs).toEqual(expect.arrayContaining([
      { channel: 'inferior-raw', text: '~not-mi' },
      { channel: 'inferior-raw', text: '@not-mi' },
      { channel: 'inferior-raw', text: '123' },
      { channel: 'inferior-raw', text: '^done' },
      { channel: 'inferior-raw', text: '*hello' },
      { channel: 'inferior-raw', text: '=unknown' },
      { channel: 'inferior-stderr', text: 'worker stderr\n' },
    ]));
    expect(result.limitations.join(' ')).toContain('best-effort 分流');
  });
  it.skipIf(process.platform === 'win32')('preserves executable permission on the private snapshot', async () => {
    const root = await temporaryRoot(); const child = path.join(root, 'child'); await mkdir(child);
    const binary = path.join(root, 'sample'); await writeFile(binary, 'fake executable'); await chmod(binary, 0o700);
    const engine = new DynamicAnalysisEngine({ isolationRoot: root, networkIsolation: 'none', clientFactory: (options) => fakeClient('exec-check', options) });
    const result = await engine.analyze({ binaryPath: binary, cwd: child, authorized: true });
    expect(result.status, result.error).toBe('completed');
  });
  it.skipIf(process.platform === 'win32')('cleans up an inferior left behind by a crashed GDB', async () => {
    const root = await temporaryRoot();
    const marker = path.join(root, 'crashed-child.pid');
    const client = new GdbMiClient({ executable: process.execPath, timeoutMs: 5_000, spawnProcess: (_command, args, options) => spawn(process.execPath, [fakeGdb, ...args], { ...options, env: { ...options.env, FAKE_GDB_MODE: 'crash-with-child', FAKE_GDB_CHILD_PID_FILE: marker } }) });
    await client.start();
    await expect(client.execute('-file-exec-and-symbols', 'x')).rejects.toThrow(/退出/);
    await client.close();
    const pid = Number(await readFile(marker, 'utf8'));
    expect(await pidAlive(pid)).toBe(false);
  }, 10_000);
  it('rejects oversized binaries before starting GDB', async () => {
    const root = await temporaryRoot(); const child = path.join(root, 'child'); await mkdir(child);
    const binary = path.join(root, 'sample'); await writeFile(binary, 'too large');
    const engine = new DynamicAnalysisEngine({ isolationRoot: root, maxBinaryBytes: 4, gdbPath: 'definitely-not-a-gdb' });
    const result = await engine.analyze({ binaryPath: binary, cwd: child, authorized: true });
    expect(result.status).toBe('rejected');
    expect(result.error).toContain('超过 4 字节限额');
  });
  it('bounds event count', async () => {
    const root = await temporaryRoot(); const child = path.join(root, 'child'); await mkdir(child);
    const binary = path.join(root, 'sample'); await writeFile(binary, 'fake');
    const engine = new DynamicAnalysisEngine({ isolationRoot: root, networkIsolation: 'none', clientFactory: (options) => fakeClient('normal', options) });
    const result = await engine.analyze({ binaryPath: binary, cwd: child, authorized: true, maxEvents: 3 });
    expect(result.events).toHaveLength(3);
    expect(result.limitations.join(' ')).toContain('maxEvents');
  });
});

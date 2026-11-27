import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, open, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ProgramIr } from '@reverse/program-ir';
import { GdbMiClient, type GdbMiClientOptions } from './mi-client.js';
import { asList, asRecord, asString, type MiRecord, type MiValue } from './mi-parser.js';
import type { DynamicAnalysisEngineOptions, DynamicAnalysisRequest, DynamicAnalysisResult, DynamicEvent, DynamicFrame, DynamicModule, DynamicThread } from './types.js';

export const DYNAMIC_ENGINE_VERSION = '0.0.9';
const ENV_WHITELIST = ['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'HOME', 'USER', 'LOGNAME', 'TERM'];
const MAX_EVENTS = 10_000;
const MAX_BREAKPOINTS = 64;

function field(record: unknown, key: string): string | undefined { return asString(asRecord(record)?.[key]); }
function number(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
function positive(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) throw new Error(`动态分析参数必须在 1..${maximum} 之间`);
  return value;
}
function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
function parseFrame(value: MiValue | undefined): DynamicFrame | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const level = number(field(record, 'level'));
  if (level === undefined) return undefined;
  const address = field(record, 'addr'); const fn = field(record, 'func'); const file = field(record, 'fullname'); const line = number(field(record, 'line'));
  return { level, ...(address ? { address } : {}), ...(fn ? { function: fn } : {}), ...(file ? { file } : {}), ...(line !== undefined ? { line } : {}) };
}
function addressKey(value: string): bigint | undefined { try { return /^0x[0-9a-f]+$/i.test(value) ? BigInt(value) : undefined; } catch { return undefined; } }
function parseThreads(value: MiValue | undefined): DynamicThread[] {
  const record = asRecord(value);
  const currentId = field(record, 'current-thread-id');
  const entries = asList(record?.['threads']).flatMap((item) => {
    const nested = asRecord(item)?.['threads'];
    return asList(nested).length > 0 ? asList(nested) : [item];
  });
  return entries.flatMap((item): DynamicThread[] => {
    const thread = asRecord(item);
    const id = field(thread, 'id');
    if (!thread || !id) return [];
    const frame = parseFrame(thread.frame);
    return [{ id, current: thread.current === 'true' || id === currentId, ...(frame ? { frame } : {}) }];
  });
}
function parseRegisterNames(value: MiValue | undefined): string[] {
  return asList(asRecord(value)?.['register-names']).flatMap((item) => typeof item === 'string' ? [item] : []);
}
function parseRegisters(value: MiValue | undefined, names: string[] = []): Record<string, string> {
  const result: Record<string, string> = {};
  for (const item of asList(asRecord(value)?.['register-values'])) {
    const register = asRecord(item);
    const raw = field(register, 'value');
    const name = field(register, 'name') ?? names[Number(field(register, 'number'))];
    if (register && name && raw !== undefined) result[name] = raw;
  }
  return result;
}

async function snapshotBinary(sourcePath: string, destination: string, maxBytes: number): Promise<string> {
  const source = await open(sourcePath, 'r');
  try {
    const stat = await source.stat();
    if (!stat.isFile()) throw new Error('binaryPath 必须指向普通文件');
    if (stat.size > maxBytes) throw new Error(`二进制超过 ${maxBytes} 字节限额`);
    const hash = createHash('sha256');
    let bytes = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > maxBytes) { callback(new Error(`二进制超过 ${maxBytes} 字节限额`)); return; }
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(source.createReadStream({ autoClose: false }), meter, createWriteStream(destination, { flags: 'wx', mode: 0o600 | (stat.mode & 0o111) }));
    return hash.digest('hex');
  } finally {
    await source.close();
  }
}

export class DynamicAnalysisEngine {
  private readonly isolationRoot: string;
  private readonly gdbPath: string;
  private readonly networkIsolation: 'external-required' | 'none';
  private readonly maxBinaryBytes: number;
  private readonly clientFactory: (options: GdbMiClientOptions) => GdbMiClient;

  constructor(options: DynamicAnalysisEngineOptions = {}) {
    this.isolationRoot = path.resolve(options.isolationRoot ?? path.join(tmpdir(), 'reverse-dynamic-analysis'));
    this.gdbPath = options.gdbPath ?? 'gdb';
    this.networkIsolation = options.networkIsolation ?? 'external-required';
    this.maxBinaryBytes = options.maxBinaryBytes ?? 256 * 1024 * 1024;
    this.clientFactory = options.clientFactory ?? ((clientOptions) => new GdbMiClient(clientOptions));
  }

  async analyze(request: DynamicAnalysisRequest, options: { signal?: AbortSignal; programIr?: ProgramIr } = {}): Promise<DynamicAnalysisResult> {
    const started = new Date();
    let provenance: DynamicAnalysisResult['provenance'] | undefined;
    let binaryHash = '';
    let status: DynamicAnalysisResult['status'] = 'failed';
    let error: string | undefined;
    const events: DynamicEvent[] = [];
    const threads = new Map<string, DynamicThread>();
    const modules = new Map<string, DynamicModule>();
    let outputBytes = 0;
    let truncated = false;
    const limitations: string[] = [];
    const signal = options.signal;
    const timeoutMs = positive(request.timeoutMs, 30_000, 600_000);
    const maxOutputBytes = positive(request.maxOutputBytes, 16 * 1024 * 1024, 128 * 1024 * 1024);
    const maxEvents = positive(request.maxEvents, 2_000, MAX_EVENTS);
    const timeoutController = new AbortController();
    const combined = new AbortController();
    const onAbort = (): void => combined.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const timer = setTimeout(() => { timeoutController.abort(new Error(`动态分析超过 ${timeoutMs}ms`)); combined.abort(timeoutController.signal.reason); }, timeoutMs);
    let client: GdbMiClient | undefined;
    let workDir: string | undefined;
    try {
      if (request.authorized !== true) throw Object.assign(new Error('动态执行需要显式 authorized=true 授权'), { code: 'DYNAMIC_NOT_AUTHORIZED' });
      if (!request.binaryPath || !request.cwd) throw new Error('binaryPath 与 cwd 必填');
      if (!Array.isArray(request.args ?? []) || (request.args ?? []).some((arg) => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('args 必须为不含 NUL 的字符串数组');
      if (Object.keys(request.env ?? {}).some((key) => !ENV_WHITELIST.includes(key))) throw new Error(`env 仅允许白名单变量: ${ENV_WHITELIST.join(', ')}`);
      if (Object.values(request.env ?? {}).some((value) => typeof value !== 'string' || value.includes('\0'))) throw new Error('env 值必须为不含 NUL 的字符串');
      if ((request.breakpoints ?? []).length > MAX_BREAKPOINTS || (request.breakpoints ?? []).some((bp) => typeof bp !== 'string' || !bp.trim() || bp.length > 1024)) throw new Error(`断点无效（最多 ${MAX_BREAKPOINTS} 个）`);
      const isolationRoot = await realpath(this.isolationRoot).catch(async () => { await mkdir(this.isolationRoot, { recursive: true }); return realpath(this.isolationRoot); });
      const requestedCwd = await realpath(request.cwd);
      if (!inside(isolationRoot, requestedCwd) || requestedCwd === isolationRoot) throw new Error('cwd 必须位于隔离根目录内且不能等于隔离根目录');
      workDir = await mkdtemp(path.join(isolationRoot, `run-${randomUUID()}-`));
      const originalBinaryPath = await realpath(request.binaryPath);
      const binaryPath = path.join(workDir, 'sample');
      binaryHash = await snapshotBinary(originalBinaryPath, binaryPath, this.maxBinaryBytes);
      provenance = { engine: '@reverse/dynamic-analysis', engineVersion: DYNAMIC_ENGINE_VERSION, executable: this.gdbPath, binaryPath: originalBinaryPath, binarySnapshotPath: binaryPath, binarySha256: binaryHash, platform: process.platform, cwd: workDir, networkIsolation: this.networkIsolation, startedAt: started.toISOString(), stoppedAt: '', durationMs: 0, environmentVariables: Object.keys(request.env ?? {}).sort() };
      if (this.networkIsolation !== 'none') limitations.push('网络隔离由外层 network namespace 保障；引擎环境白名单本身不能阻止已授权样本访问网络。');
      else limitations.push('网络隔离未启用；不得在此模式执行不受信任样本。');
      limitations.push('隔离根目录仅约束工作目录与私有二进制快照，不限制样本的文件系统、进程或系统调用；必须在可信授权样本或外层操作系统沙箱中运行。');
      limitations.push('GDB/MI 与 inferior 共享输出通道，文本/MI 归属为 best-effort 分流，不能证明协议完整性；严格隔离场景应使用外层 PTY 或操作系统沙箱。');
      if (process.platform !== 'linux') limitations.push('进程树强制回收在 Windows 使用 taskkill，在 POSIX 使用进程组；非 Linux 平台没有内核级禁网。');
      const env: NodeJS.ProcessEnv = {};
      for (const key of ENV_WHITELIST) if (request.env?.[key] !== undefined) env[key] = request.env[key]; else if (process.env[key] !== undefined) env[key] = process.env[key];
      // Do not inherit debugger, dynamic-loader or language-runtime injection variables.
      for (const key of Object.keys(env)) if (/^(LD_|DYLD_|PYTHON|NODE_|BASH_ENV|ENV$|GDB)/i.test(key)) delete env[key];
      const consoleModules: DynamicModule[] = [];
      client = this.clientFactory({ executable: this.gdbPath, cwd: workDir, env, timeoutMs, maxOutputBytes, signal: combined.signal,
        onRecord: (record) => {
          if (record.kind === 'raw') { addEvent({ type: 'output', data: { channel: 'inferior-raw', text: record.value } }); return; }
          if (record.kind === 'stream' && record.channel === 'target') { addEvent({ type: 'output', data: { channel: 'inferior-stderr', text: record.value } }); return; }
          if (record.kind !== 'stream' || record.channel !== 'console') return;
          const match = /^\s*(0x[0-9a-f]+)\s+(0x[0-9a-f]+)\s+(0x[0-9a-f]+)\s+(.+)$/i.exec(record.value.trim());
          if (!match) return;
          const from = BigInt(match[1]!); const to = BigInt(match[2]!);
          const size = BigInt(match[3]!);
          const remainder = match[4]!.trim();
          const first = remainder.split(/\s+/, 1)[0]!;
          // `info proc mappings` has an offset column before the objfile name;
          // older `info modules` output does not.
          const name = /^0x[0-9a-f]+$/i.test(first) ? remainder.slice(first.length).trim() : remainder;
          if (name) consoleModules.push({ from: match[1]!, to: match[2]!, size: Number(size), name });
        },
        onOutput: (_text, bytes) => { outputBytes += bytes; },
        onLimit: () => { truncated = true; limitations.push('GDB 原始输出达到 maxOutputBytes 限额，分析提前终止。'); },
      });
      const addEvent = (event: Omit<DynamicEvent, 'timestamp'>): void => {
        if (events.length >= maxEvents) { truncated = true; if (!limitations.some((item) => item.includes('maxEvents'))) limitations.push('事件数量达到 maxEvents 限额，后续事件被丢弃。'); return; }
        events.push({ ...event, timestamp: new Date().toISOString() });
      };
      await client.start();
      await client.execute('-interpreter-exec', 'console', 'set auto-load off');
      addEvent({ type: 'start', data: { binaryPath: originalBinaryPath, binarySnapshotPath: binaryPath, binarySha256: binaryHash } });
      await client.execute('-file-exec-and-symbols', binaryPath);
      if ((request.args ?? []).length > 0) await client.execute('-exec-arguments', ...request.args!);
      for (const breakpoint of request.breakpoints ?? []) await client.execute('-break-insert', breakpoint);
      const inferProgramFunction = (frame?: DynamicFrame, address?: string): Record<string, unknown> | undefined => {
        const functions = options.programIr?.functions ?? [];
        const byName = frame?.function ? functions.find((fn) => !fn.external && fn.name === frame.function) : undefined;
        const byAddress = address ? functions.find((fn) => { const key = addressKey(fn.entry); const candidate = addressKey(address); return key !== undefined && candidate !== undefined && key === candidate; }) : undefined;
        const fn = byName ?? byAddress;
        return fn ? { programFunctionId: fn.id, programFunctionName: fn.name, entry: fn.entry, correlation: byName ? 'function-name' : 'entry-address' } : undefined;
      };
      const collectStoppedEvidence = async (record: Extract<MiRecord, { kind: 'notify' }>): Promise<void> => {
        const stopped = asRecord(record.value);
        const threadId = field(stopped, 'thread-id') ?? '1';
        const frame = parseFrame(stopped?.frame);
        const programFunction = inferProgramFunction(frame, frame?.address);
        addEvent({ type: 'breakpoint', threadId, ...(frame ? { frame } : {}), ...(frame?.address ? { address: frame.address } : {}), data: { reason: field(stopped, 'reason') ?? 'stopped', ...(programFunction ?? {}) } });
        const [threadValue, stackValue, registerNamesValue, registerValue] = await Promise.all([
          client!.execute('-thread-info'), client!.execute('-stack-list-frames'), client!.execute('-data-list-register-names'), client!.execute('-data-list-register-values', 'x'),
        ]);
        for (const thread of parseThreads(threadValue)) threads.set(thread.id, thread);
        addEvent({ type: 'thread', threadId, data: { threads: [...threads.values()] } });
        const stack = asList(asRecord(stackValue)?.stack).flatMap((item) => { const frameValue = parseFrame(asRecord(item)?.frame); return frameValue ? [frameValue] : []; });
        const current = stack.find((item) => item.level === 0);
        const correlated = inferProgramFunction(current, current?.address ?? frame?.address);
        if (current) { const breakpointEvent = [...events].reverse().find((event) => event.type === 'breakpoint'); if (breakpointEvent) { breakpointEvent.frame = current; if (current.address) breakpointEvent.address = current.address; } }
        if (correlated) { const breakpointEvent = [...events].reverse().find((event) => event.type === 'breakpoint'); if (breakpointEvent) breakpointEvent.data = { ...(breakpointEvent.data as Record<string, unknown>), ...correlated }; }
        addEvent({ type: 'stack', threadId, ...(current ? { frame: current } : {}), data: { frames: stack, ...(correlated ?? {}) } });
        const registers = parseRegisters(registerValue, parseRegisterNames(registerNamesValue));
        addEvent({ type: 'register', threadId, registers });
        await client!.execute('-interpreter-exec', 'console', 'info proc mappings');
        for (const module of consoleModules) modules.set(`${module.from ?? ''}:${module.name}`, module);
        addEvent({ type: 'module', data: { modules: [...modules.values()] } });
      };
      // Start with -exec-run; continuation is selected from the second invocation onward.
      let firstRun = true;
      const runToTerminal = async (): Promise<boolean> => {
        const stopped = client!.waitForStop();
        const exited = client!.waitForExit().then(() => null);
        const command = (firstRun ? client!.execute('-exec-run') : client!.execute('-exec-continue')).then(async () => { await exited; return null; });
        firstRun = false;
        const outcome = await Promise.race([stopped, exited, command]);
        if (!outcome) { addEvent({ type: 'exit', data: { reason: 'gdb-exit' } }); return false; }
        const reason = field(asRecord(outcome.value), 'reason') ?? '';
        if (reason === 'exited' || reason === 'exited-normally' || reason === 'exited-signalled') {
          addEvent({ type: 'exit', data: { reason } });
          return false;
        }
        await collectStoppedEvidence(outcome);
        return true;
      };
      while (events.length < maxEvents) {
        const stopped = await runToTerminal();
        if (!stopped) break;
        // Every stop is evidence; continue until normal inferior exit.
      }
      if (client.diagnostics) addEvent({ type: 'output', data: { channel: 'stderr', bytes: client.diagnosticBytes, text: client.diagnostics } });
      status = 'completed';
    } catch (caught) {
      const failure = caught as Error & { code?: string };
      error = failure.message;
      if (combined.signal.aborted) status = timeoutController.signal.aborted ? 'timeout' : 'cancelled';
      else if (!provenance) status = 'rejected';
      else status = 'failed';
      if (status === 'timeout') limitations.push(`执行在 ${timeoutMs}ms 超时后回收，未采集到完整终止状态。`);
      if (status === 'cancelled') limitations.push('执行由调用方取消，未采集到完整终止状态。');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      await client?.close().catch(() => undefined);
      if (client && !client.cleanupSucceeded) limitations.push('GDB 进程组或已记录 inferior 未在清理期限内确认消失；需要人工核查或外层沙箱强制回收。');
      if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => limitations.push('隔离工作目录清理失败，请人工核查。'));
      if (provenance) {
        provenance.stoppedAt = new Date().toISOString();
        provenance.durationMs = Date.now() - started.getTime();
        if (!binaryHash) provenance.binarySha256 = '';
      }
      if (client?.truncated) truncated = true;
    }
    if (!provenance) {
      provenance = { engine: '@reverse/dynamic-analysis', engineVersion: DYNAMIC_ENGINE_VERSION, executable: this.gdbPath, binaryPath: request.binaryPath, binarySha256: binaryHash, platform: process.platform, cwd: request.cwd, networkIsolation: this.networkIsolation, startedAt: started.toISOString(), stoppedAt: new Date().toISOString(), durationMs: Date.now() - started.getTime(), environmentVariables: [] };
    }
    return { status, events, threads: [...threads.values()], modules: [...modules.values()], timeline: events.map((event, index) => ({ index, timestamp: event.timestamp, type: event.type })), limitations, outputBytes, truncated, provenance, ...(options.programIr ? { programIr: options.programIr } : {}), ...(error ? { error } : {}) };
  }
}

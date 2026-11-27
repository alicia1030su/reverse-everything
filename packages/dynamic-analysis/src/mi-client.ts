import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { asRecord, MiLineDecoder, type MiRecord, type MiValue } from './mi-parser.js';

export interface GdbMiClientOptions {
  executable?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  /** Used by deterministic tests; production always launches gdb --quiet --nx --interpreter=mi2. */
  spawnProcess?: (command: string, args: string[], options: { cwd?: string; env: NodeJS.ProcessEnv; detached: boolean; stdio: 'pipe' }) => ChildProcessWithoutNullStreams;
  onRecord?: (record: MiRecord) => void;
  onOutput?: (text: string, bytes: number) => void;
  onStderr?: (text: string, bytes: number) => void;
  onLimit?: (kind: 'output' | 'event', limit: number) => void;
}

export class GdbMiError extends Error {
  constructor(message: string, readonly code = 'GDB_MI_ERROR') { super(message); this.name = 'GdbMiError'; }
}

interface PendingCommand {
  resolve: (value: MiValue | undefined) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}
interface StoppedWaiter {
  resolve: (record: Extract<MiRecord, { kind: 'notify' }>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export function quoteMiArgument(value: string): string {
  let result = '"';
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (char === '"' || char === '\\') result += `\\${char}`;
    else if (char === '\n') result += '\\n';
    else if (char === '\r') result += '\\r';
    else if (char === '\t') result += '\\t';
    else if (code < 32 || code > 126) result += [...Buffer.from(char, 'utf8')].map((byte) => `\\${byte.toString(8).padStart(3, '0')}`).join('');
    else result += char;
  }
  return `${result}"`;
}

export class GdbMiClient extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private readonly decoder = new MiLineDecoder();
  private readonly pending = new Map<number, PendingCommand>();
  private readonly stoppedWaiters = new Set<StoppedWaiter>();
  private readonly exitWaiters = new Set<{ resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private token = 0;
  private outputBytes = 0;
  private stderrBytes = 0;
  private stderrTail = '';
  private limitReached = false;
  private closed = false;
  private closePromise?: Promise<void>;
  private cleanupPromise?: Promise<void>;
  private readonly inferiorPids = new Map<string, number>();
  private commandTimeoutMs: number;
  private readonly signal: AbortSignal | undefined;
  private readonly abortListener: () => void;

  constructor(private readonly options: GdbMiClientOptions = {}) {
    super();
    this.commandTimeoutMs = options.timeoutMs ?? 15_000;
    this.signal = options.signal;
    this.abortListener = () => { const error = new GdbMiError('动态分析已取消', 'GDB_CANCELLED'); this.failAll(error); void this.close(error, true); };
    this.signal?.addEventListener('abort', this.abortListener, { once: true });
  }

  get bytes(): number { return this.outputBytes; }
  get diagnostics(): string { return this.stderrTail; }
  get diagnosticBytes(): number { return this.stderrBytes; }
  get truncated(): boolean { return this.limitReached; }
  get exited(): boolean { return this.closed; }

  async start(): Promise<void> {
    if (this.signal?.aborted) throw new GdbMiError('动态分析已取消', 'GDB_CANCELLED');
    try {
      this.child = (this.options.spawnProcess ?? spawn)(this.options.executable ?? 'gdb', ['--quiet', '--nx', '--interpreter=mi2'], {
        ...(this.options.cwd ? { cwd: this.options.cwd } : {}), env: this.options.env ?? process.env, detached: process.platform !== 'win32', stdio: 'pipe',
      });
    } catch (error) { throw new GdbMiError(`无法启动 GDB: ${(error as Error).message}`, 'GDB_SPAWN_FAILED'); }
    const child = this.child;
    let rejectStartup: (error: Error) => void = () => undefined;
    const startupFailure = new Promise<never>((_resolve, reject) => { rejectStartup = reject; });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.consume(chunk));
    child.stderr.on('data', (chunk: string) => this.consumeStderr(chunk));
    child.on('error', (error) => {
      rejectStartup(new GdbMiError(`GDB 启动失败: ${error.message}`, 'GDB_SPAWN_FAILED'));
      this.failAll(new GdbMiError(`GDB 进程错误: ${error.message}`, 'GDB_PROCESS_ERROR'));
      this.closed = true;
      this.cleanupPromise = this.killTree();
      this.emit('exit');
    });
    child.on('close', () => {
      rejectStartup(new GdbMiError('GDB 在启动期间退出', 'GDB_START_EXITED'));
      this.failAll(new GdbMiError('GDB 在命令完成前退出', 'GDB_EXITED'));
      this.closed = true;
      // The debugger may have crashed while its inferior is still running.
      this.cleanupPromise = this.killTree();
      this.emit('exit');
    });
    const prompt = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { reject(new GdbMiError('GDB 启动超时', 'GDB_START_TIMEOUT')); void this.close(); }, this.commandTimeoutMs);
      // The prompt is not an MI record and must be removed before decoding.
      const cleanup = (): void => { child.stdout.off('data', data); clearTimeout(timer); };
      const data = (chunk: string): void => { if (chunk.includes('(gdb)')) { cleanup(); resolve(); } };
      child.stdout.on('data', data);
      startupFailure.finally(cleanup).catch(() => undefined);
    });
    await Promise.race([prompt, startupFailure]);
  }

  private consumeStderr(chunk: string): void {
    if (this.limitReached) return;
    const bytes = Buffer.byteLength(chunk);
    this.stderrBytes += bytes;
    this.stderrTail = (this.stderrTail + chunk).slice(-65_536);
    this.options.onStderr?.(chunk, bytes);
    if (!this.accountOutput(bytes)) return;
  }

  private accountOutput(bytes: number): boolean {
    this.outputBytes += bytes;
    const max = this.options.maxOutputBytes ?? 16 * 1024 * 1024;
    if (this.outputBytes <= max) return true;
    this.limitReached = true;
    this.options.onLimit?.('output', max);
    const error = new GdbMiError('GDB 输出超过限额', 'GDB_OUTPUT_LIMIT');
    this.failAll(error);
    void this.close(error, true);
    return false;
  }

  private consume(chunk: string): void {
    if (this.limitReached) return;
    chunk = chunk.replace(/\(gdb\) ?/g, '');
    if (!chunk) return;
    const bytes = Buffer.byteLength(chunk);
    this.options.onOutput?.(chunk, bytes);
    if (!this.accountOutput(bytes)) return;
    let records: MiRecord[];
    try { records = this.decoder.push(chunk); }
    catch (error) {
      const failure = new GdbMiError(`MI 解析失败: ${(error as Error).message}`, 'GDB_PROTOCOL_ERROR');
      this.failAll(failure);
      void this.close(failure, true);
      return;
    }
    for (const record of records) this.handleRecord(record);
  }

  private handleRecord(record: MiRecord): void {
    this.options.onRecord?.(record);
    this.emit('record', record);
    if (record.kind === 'notify' && (record.status === 'thread-group-started' || record.status === 'thread-group-exited')) {
      const value = asRecord(record.value);
      const id = typeof value?.id === 'string' ? value.id : undefined;
      if (id && record.status === 'thread-group-exited') this.inferiorPids.delete(id);
      if (id && record.status === 'thread-group-started' && typeof value?.pid === 'string' && /^\d+$/.test(value.pid)) this.inferiorPids.set(id, Number(value.pid));
    }
    if (record.kind === 'result' && record.status === 'exit') {
      for (const waiter of this.exitWaiters) { clearTimeout(waiter.timer); waiter.resolve(); }
      this.exitWaiters.clear();
      return;
    }
    if (record.kind === 'result') {
      if (record.token === undefined) return;
      const pending = this.pending.get(record.token);
      if (!pending) return;
      this.pending.delete(record.token);
      clearTimeout(pending.timer);
      if (record.status === 'done' || record.status === 'running' || record.status === 'connected') pending.resolve(record.value);
      else pending.reject(new GdbMiError(`GDB 命令失败 (${record.status}): ${JSON.stringify(record.value ?? {})}`, 'GDB_COMMAND_FAILED'));
      return;
    }
    if (record.kind === 'notify' && record.status === 'stopped') {
      for (const waiter of this.stoppedWaiters) { clearTimeout(waiter.timer); waiter.resolve(record); }
      this.stoppedWaiters.clear();
    }
  }

  private commandInput(command: string, args: string[]): string {
    const token = ++this.token;
    const encodedArgs = args.map(quoteMiArgument).join(' ');
    return `${token}${command}${encodedArgs ? ` ${encodedArgs}` : ''}\n`;
  }

  async execute(command: string, ...args: string[]): Promise<MiValue | undefined> {
    if (this.closed || this.limitReached) throw new GdbMiError('GDB 不可用', 'GDB_UNAVAILABLE');
    if (this.signal?.aborted) throw new GdbMiError('动态分析已取消', 'GDB_CANCELLED');
    const token = this.token + 1;
    return new Promise<MiValue | undefined>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(token);
        const error = new GdbMiError(`GDB 命令超时: ${command}`, 'GDB_COMMAND_TIMEOUT');
        reject(error);
        void this.close(error);
      }, this.commandTimeoutMs);
      this.pending.set(token, { resolve, reject, timer });
      try { this.child?.stdin.write(this.commandInput(command, args)); }
      catch (error) { this.pending.delete(token); clearTimeout(timer); reject(new GdbMiError((error as Error).message, 'GDB_WRITE_FAILED')); }
    });
  }

  waitForStop(timeoutMs = this.commandTimeoutMs): Promise<Extract<MiRecord, { kind: 'notify' }>> {
    if (this.closed || this.limitReached) return Promise.reject(new GdbMiError('GDB 不可用', 'GDB_UNAVAILABLE'));
    return new Promise((resolve, reject) => {
      const waiter: StoppedWaiter = { resolve, reject, timer: setTimeout(() => { this.stoppedWaiters.delete(waiter); const error = new GdbMiError('等待 GDB 停止事件超时', 'GDB_STOP_TIMEOUT'); reject(error); void this.close(error); }, timeoutMs) };
      this.stoppedWaiters.add(waiter);
    });
  }

  waitForExit(): Promise<void> {
    if (this.closed) return Promise.reject(new GdbMiError('GDB 不可用', 'GDB_UNAVAILABLE'));
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: setTimeout(() => { this.exitWaiters.delete(waiter); const error = new GdbMiError('等待 inferior 退出超时', 'GDB_EXIT_TIMEOUT'); reject(error); void this.close(error); }, this.commandTimeoutMs) };
      this.exitWaiters.add(waiter);
    });
  }

  private failPending(error: Error): void { for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); } this.pending.clear(); }
  private failStopped(error: Error): void { for (const waiter of this.stoppedWaiters) { clearTimeout(waiter.timer); waiter.reject(error); } this.stoppedWaiters.clear(); }
  private failAll(error: Error): void {
    this.failPending(error);
    this.failStopped(error);
    for (const waiter of this.exitWaiters) { clearTimeout(waiter.timer); waiter.reject(error); }
    this.exitWaiters.clear();
  }

  close(reason = new GdbMiError('GDB 已关闭', 'GDB_CLOSED'), force = false): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (this.closed) return this.cleanupPromise ?? Promise.resolve();
    this.closed = true;
    this.signal?.removeEventListener('abort', this.abortListener);
    this.failAll(reason);
    this.closePromise = this.closeInternal(force);
    return this.closePromise;
  }

  private async closeInternal(force: boolean): Promise<void> {
    const child = this.child;
    if (!child) return;
    if (child.exitCode !== null || child.signalCode !== null) { await this.killTree(); return; }
    if (force) {
      await this.killTree();
      if (child.exitCode === null && child.signalCode === null) await new Promise<void>((resolve) => child.once('close', resolve));
      return;
    }
    await new Promise<void>((resolve) => {
      let killing: Promise<void> | undefined;
      const timer = setTimeout(() => { killing = this.killTree(); void killing.finally(resolve); }, 750);
      child.once('close', () => { clearTimeout(timer); if (killing) void killing.finally(resolve); else resolve(); });
      // Try graceful MI exit, then force kill if the process does not cooperate.
      try { child.stdin.write('0-gdb-exit\n'); } catch { clearTimeout(timer); killing = this.killTree(); void killing.finally(resolve); }
    });
  }

  private async killTree(): Promise<void> {
    const child = this.child;
    if (!child?.pid) return;
    const inferiorPids = [...this.inferiorPids.values()];
    if (process.platform === 'win32') {
      const pids = [...new Set([child.pid, ...inferiorPids])];
      for (const pid of pids) {
        await new Promise<void>((resolve) => {
          const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
          killer.once('error', () => { try { child.kill('SIGKILL'); } catch { /* already reaped */ } resolve(); });
          killer.once('close', resolve);
        });
      }
      return;
    }
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* already reaped */ } }
    for (const pid of inferiorPids) { try { process.kill(pid, 'SIGKILL'); } catch { /* already reaped */ } }
  }
}

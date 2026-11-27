import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { asRecord, MiLineDecoder, type MiRecord, type MiValue } from './mi-parser.js';
import { planInferiorCleanup, type InferiorGroupIdentity, type ProcessIdentity } from './process-identity.js';

const PIDFD_HELPER = fileURLToPath(new URL('../../../scripts/pidfd_cleanup.py', import.meta.url));

export interface GdbMiClientOptions {
  executable?: string;
  pythonExecutable?: string;
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
interface ProcStat {
  ppid: number;
  pgid: number;
  startTicks: number;
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
  private cleanupComplete = true;
  private captureObservationFailed = false;
  private readonly inferiorCandidates = new Map<string, number>();
  private readonly inferiorGroups = new Map<number, InferiorGroupIdentity>();
  private gdbGroup?: InferiorGroupIdentity;
  private readonly inferiorValidations = new Set<Promise<void>>();
  private commandTimeoutMs: number;
  private readonly signal: AbortSignal | undefined;
  private readonly pythonExecutable: string;
  private readonly abortListener: () => void;

  constructor(private readonly options: GdbMiClientOptions = {}) {
    super();
    this.commandTimeoutMs = options.timeoutMs ?? 15_000;
    this.signal = options.signal;
    this.pythonExecutable = options.pythonExecutable ?? 'python3';
    this.abortListener = () => { const error = new GdbMiError('动态分析已取消', 'GDB_CANCELLED'); this.failAll(error); void this.close(error, true); };
    this.signal?.addEventListener('abort', this.abortListener, { once: true });
  }

  get bytes(): number { return this.outputBytes; }
  get diagnostics(): string { return this.stderrTail; }
  get diagnosticBytes(): number { return this.stderrBytes; }
  get truncated(): boolean { return this.limitReached; }
  get exited(): boolean { return this.closed; }
  get cleanupSucceeded(): boolean { return this.cleanupComplete; }

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
    child.stdin.on('error', (error) => {
      const failure = new GdbMiError(`GDB stdin 写入失败: ${error.message}`, 'GDB_STDIN_ERROR');
      rejectStartup(failure);
      this.failAll(failure);
      this.closed = true;
      this.ensureCleanup();
      this.emit('exit');
    });
    child.on('error', (error) => {
      rejectStartup(new GdbMiError(`GDB 启动失败: ${error.message}`, 'GDB_SPAWN_FAILED'));
      this.failAll(new GdbMiError(`GDB 进程错误: ${error.message}`, 'GDB_PROCESS_ERROR'));
      this.closed = true;
      this.ensureCleanup();
      this.emit('exit');
    });
    child.on('close', () => {
      rejectStartup(new GdbMiError('GDB 在启动期间退出', 'GDB_START_EXITED'));
      this.failAll(new GdbMiError('GDB 在命令完成前退出', 'GDB_EXITED'));
      this.closed = true;
      // The debugger may have crashed while its inferior is still running.
      this.ensureCleanup();
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
    if (!await this.captureGdbGroup()) throw new GdbMiError('无法验证 GDB 进程身份', 'GDB_PROCESS_OBSERVATION_FAILED');
  }

  /** Returns null only for ENOENT; undefined means the observation failed. */
  private async readProcStat(pid: number): Promise<ProcStat | null | undefined> {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
      const end = stat.lastIndexOf(')');
      if (end < 0) return undefined;
      const fields = stat.slice(end + 2).trim().split(/\s+/);
      const ppid = Number(fields[1]);
      const pgid = Number(fields[2]);
      const startTicks = Number(fields[19]);
      if (!fields[0] || !Number.isSafeInteger(ppid) || !Number.isSafeInteger(pgid) || !Number.isSafeInteger(startTicks)) return undefined;
      return { ppid, pgid, startTicks };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      return undefined;
    }
  }

  private async isDescendantOfGdb(pid: number): Promise<boolean | undefined> {
    const gdbPid = this.child?.pid;
    if (!gdbPid || pid === gdbPid) return false;
    let current = pid;
    for (let depth = 0; depth < 32; depth += 1) {
      const stat = await this.readProcStat(current);
      if (stat === undefined) return undefined;
      if (!stat) return false;
      if (stat.ppid === gdbPid) return true;
      if (stat.ppid <= 1) return false;
      current = stat.ppid;
    }
    return false;
  }

  private async readProcAllProcesses(): Promise<ProcessIdentity[] | undefined> {
    const members: ProcessIdentity[] = [];
    let entries: string[];
    try { entries = await readdir('/proc'); } catch { return undefined; }
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = Number(entry);
      const stat = await this.readProcStat(pid);
      if (stat === undefined) return undefined;
      if (stat) members.push({ pid, pgid: stat.pgid, startTicks: stat.startTicks });
    }
    return members;
  }

  private markCaptureObservationFailed(): false {
    this.captureObservationFailed = true;
    this.cleanupComplete = false;
    return false;
  }

  private async captureGdbGroup(): Promise<boolean> {
    if (process.platform !== 'linux' || !this.child?.pid) return true;
    const leader = await this.readProcStat(this.child.pid);
    if (leader === undefined) return this.markCaptureObservationFailed();
    if (!leader) return false;
    const members = new Map<number, number>();
    const observed = await this.readProcAllProcesses();
    if (!observed) return this.markCaptureObservationFailed();
    this.gdbGroup = { leaderPid: this.child.pid, leaderStartTicks: leader.startTicks, pgid: this.child.pid, gdbPid: this.child.pid, members, membersComplete: false };
    for (const member of observed) {
      if (member.pgid !== this.child.pid || member.pid === this.child.pid) continue;
      const descendant = await this.isDescendantOfGdb(member.pid);
      if (descendant === undefined) return this.markCaptureObservationFailed();
      if (descendant) members.set(member.pid, member.startTicks);
    }
    this.gdbGroup.membersComplete = true;
    return true;
  }

  private async captureInferiorGroup(pid: number): Promise<boolean> {
    if (process.platform !== 'linux' || !this.child?.pid) return false;
    const initial = await this.readProcStat(pid);
    if (initial === undefined) return this.markCaptureObservationFailed();
    if (!initial) return false;
    const descendant = await this.isDescendantOfGdb(pid);
    if (descendant === undefined) return this.markCaptureObservationFailed();
    if (!descendant) return false;
    const confirmed = await this.readProcStat(pid);
    if (confirmed === undefined) return this.markCaptureObservationFailed();
    if (!confirmed) return false;
    if (confirmed.startTicks !== initial.startTicks || confirmed.pgid !== initial.pgid) {
      this.inferiorGroups.set(pid, { leaderPid: pid, leaderStartTicks: confirmed.startTicks, pgid: confirmed.pgid, gdbPid: this.child.pid, members: new Map([[pid, confirmed.startTicks]]), membersComplete: false });
      return this.markCaptureObservationFailed();
    }
    const members = new Map<number, number>([[pid, confirmed.startTicks]]);
    const observed = await this.readProcAllProcesses();
    if (!observed) {
      this.inferiorGroups.set(pid, { leaderPid: pid, leaderStartTicks: confirmed.startTicks, pgid: confirmed.pgid, gdbPid: this.child.pid, members, membersComplete: false });
      return this.markCaptureObservationFailed();
    }
    const group: InferiorGroupIdentity = { leaderPid: pid, leaderStartTicks: confirmed.startTicks, pgid: confirmed.pgid, gdbPid: this.child.pid, members, membersComplete: false };
    this.inferiorGroups.set(pid, group);
    for (const member of observed) {
      if (member.pgid !== confirmed.pgid || member.pid === this.child.pid || member.pid === pid) continue;
      const memberDescendant = await this.isDescendantOfGdb(member.pid);
      if (memberDescendant === undefined) return this.markCaptureObservationFailed();
      if (memberDescendant) members.set(member.pid, member.startTicks);
    }
    group.membersComplete = true;
    return true;
  }

  private async killVerifiedProcesses(targets: ProcessIdentity[]): Promise<{ killedPids: number[]; unresolved: boolean }> {
    if (targets.length === 0) return { killedPids: [], unresolved: false };
    return new Promise((resolve) => {
      let settled = false;
      let stdout = '';
      let stderr = '';
      const finish = (result: { killedPids: number[]; unresolved: boolean }): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      const helper = spawn(this.pythonExecutable, [PIDFD_HELPER], { stdio: ['pipe', 'pipe', 'pipe'] });
      helper.stdout.setEncoding('utf8');
      helper.stderr.setEncoding('utf8');
      helper.stdout.on('data', (chunk: string) => { if (stdout.length < 65_536) stdout += chunk.slice(0, 65_536 - stdout.length); });
      helper.stderr.on('data', (chunk: string) => { if (stderr.length < 4_096) stderr += chunk.slice(0, 4_096 - stderr.length); });
      helper.on('error', () => finish({ killedPids: [], unresolved: true }));
      helper.on('close', (code) => {
        try {
          const parsed = JSON.parse(stdout) as { results?: Array<{ pid?: number; status?: string }> };
          const results = Array.isArray(parsed.results) ? parsed.results : [];
          const killedPids = results.filter(item => item.status === 'killed' && typeof item.pid === 'number').map(item => item.pid!);
          const unresolved = code !== 0 || results.length !== targets.length || results.some(item => item.status !== 'killed' && item.status !== 'gone');
          finish({ killedPids, unresolved });
        } catch { finish({ killedPids: [], unresolved: true }); }
      });
      helper.stdin.on('error', () => finish({ killedPids: [], unresolved: true }));
      helper.stdin.end(JSON.stringify({ targets }), 'utf8');
    });
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
    if (record.kind === 'notify' && record.status === 'thread-group-started') {
      const value = asRecord(record.value);
      const id = typeof value?.id === 'string' ? value.id : undefined;
      if (id && typeof value?.pid === 'string' && /^\d+$/.test(value.pid)) {
        const pid = Number(value.pid);
        this.inferiorCandidates.set(id, pid);
        const validation = this.captureInferiorGroup(pid).then(() => undefined).catch(() => { this.markCaptureObservationFailed(); });
        this.inferiorValidations.add(validation);
        void validation.finally(() => this.inferiorValidations.delete(validation));
      }
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
    if (child.exitCode !== null || child.signalCode !== null) { await this.ensureCleanup(); return; }
    if (force) {
      const closed = child.exitCode === null && child.signalCode === null
        ? new Promise<void>((resolve) => child.once('close', resolve))
        : Promise.resolve();
      await this.ensureCleanup();
      await closed;
      return;
    }
    let killing: Promise<void> | undefined;
    const ensureKill = (): Promise<void> => killing ??= this.ensureCleanup();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { void ensureKill().finally(resolve); }, 750);
      child.once('close', () => { clearTimeout(timer); if (killing) void killing.finally(resolve); else resolve(); });
      // Try graceful MI exit, then force kill if the process does not cooperate.
      try { child.stdin.write('0-gdb-exit\n'); } catch { clearTimeout(timer); void ensureKill().finally(resolve); }
    });
    // The debugger may exit cleanly while an inferior descendant remains in a
    // separate process group. Always reap retained inferior PGIDs before returning.
    await ensureKill();
  }

  private async posixTargetsAlive(pids: number[]): Promise<boolean | undefined> {
    const targets = new Set(pids);
    if (targets.size === 0) return false;
    if (process.platform === 'linux') {
      let entries: string[];
      try { entries = await readdir('/proc'); } catch { return undefined; }
      for (const entry of entries) {
        if (!/^\d+$/.test(entry)) continue;
        const pid = Number(entry);
        if (!targets.has(pid)) continue;
        try {
          const stat = await readFile(`/proc/${entry}/stat`, 'utf8');
          const end = stat.lastIndexOf(')');
          if (end < 0) return undefined;
          const state = stat.slice(end + 2).trim().split(/\s+/)[0];
          if (state !== 'Z') return true;
        } catch { return undefined; }
      }
      return false;
    }
    for (const pid of targets) {
      try { process.kill(pid, 0); return true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return undefined; }
    }
    return false;
  }

  private ensureCleanup(): Promise<void> {
    return this.cleanupPromise ??= this.killTree();
  }

  private async killTree(): Promise<void> {
    const child = this.child;
    if (!child?.pid) return;
    await Promise.all([...this.inferiorValidations]);
    if (process.platform === 'win32') {
      // Individual inferior PID/PGID validation is currently Linux-only.
      const pids = [child.pid];
      for (const pid of pids) {
        const killed = await new Promise<boolean>((resolve) => {
          const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
          killer.once('error', () => { try { child.kill('SIGKILL'); } catch { /* already reaped */ } resolve(false); });
          killer.once('close', code => resolve(code === 0));
        });
        this.cleanupComplete = this.cleanupComplete && killed;
      }
      return;
    }
    const groups = [...(this.gdbGroup ? [this.gdbGroup] : []), ...this.inferiorGroups.values()];
    const observed = await this.readProcAllProcesses();
    const killedMemberPids: number[] = [];
    let unresolved = this.captureObservationFailed;
    if (!observed) {
      this.cleanupComplete = false;
      if (child.exitCode === null && child.signalCode === null) { try { child.kill('SIGKILL'); } catch { /* already reaped */ } }
      return;
    }
    const observedByPid = new Map(observed.map(member => [member.pid, member]));
    for (const group of groups) {
      const currentLeader = observedByPid.get(group.leaderPid);
      if (currentLeader?.startTicks === group.leaderStartTicks && currentLeader.pgid === group.pgid) {
        for (const member of observed) {
          if (member.pgid !== group.pgid || member.pid === group.gdbPid || group.members.has(member.pid)) continue;
          const descendant = await this.isDescendantOfGdb(member.pid);
          if (descendant === undefined) { unresolved = true; continue; }
          if (descendant) group.members.set(member.pid, member.startTicks);
        }
      }
      const plan = planInferiorCleanup(group, observed);
      const targets = plan.killMemberPids.map(pid => {
        const member = observedByPid.get(pid)!;
        return { pid, pgid: member.pgid, startTicks: member.startTicks };
      });
      const killed = await this.killVerifiedProcesses(targets);
      killedMemberPids.push(...killed.killedPids);
      if (killed.unresolved || plan.unresolved) unresolved = true;
    }
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL'); } catch { /* already reaped */ }
    }
    const deadline = Date.now() + 2_000;
    do {
      const alive = await this.posixTargetsAlive(killedMemberPids);
      if (alive === undefined) { this.cleanupComplete = false; return; }
      if (!alive) {
        if (unresolved || this.captureObservationFailed) this.cleanupComplete = false;
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    } while (Date.now() < deadline);
    this.cleanupComplete = false;
  }
}

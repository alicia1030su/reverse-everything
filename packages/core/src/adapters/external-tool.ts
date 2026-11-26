import { spawn } from 'node:child_process';

export interface ExternalToolResult {
  code: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

export interface ExternalToolOptions {
  label: string;
  command: string;
  args: string[];
  cwd?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal | undefined;
  registerProcess?: ((pid: number) => () => void) | undefined;
  outputLimitError?: (bytes: number) => Error;
  monitor?: (helpers: { terminate: (error: Error) => void; outputBytes: () => number }) => void | Promise<void>;
}

export async function killProcessTree(child: { pid?: number | undefined; kill(signal?: NodeJS.Signals): boolean }, platform = process.platform): Promise<void> {
  if (child.pid === undefined) return;
  if (platform === 'win32') {
    await new Promise<void>(resolve => {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', shell: false, windowsHide: true });
      let done = false;
      const finish = () => { if (done) return; done = true; clearTimeout(timer); resolve(); };
      const timer = setTimeout(finish, 3000);
      killer.once('error', finish);
      killer.once('exit', finish);
    });
    try { child.kill('SIGKILL'); } catch { /* already exited */ }
    return;
  }
  try { process.kill(-child.pid, 'SIGKILL'); }
  catch { try { child.kill('SIGKILL'); } catch { /* already exited */ } }
}

function diagnostics(head: string, tail: string, chars: number): string {
  return chars <= 12_000 ? tail : `${head}${head && tail ? '\n...[diagnostics truncated]...\n' : ''}${tail}`;
}

export async function runExternalTool(options: ExternalToolOptions): Promise<ExternalToolResult> {
  if (options.signal?.aborted) throw options.signal.reason ?? new DOMException('Aborted', 'AbortError');
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  return new Promise((resolve, reject) => {
    let stdoutHead = '', stderrHead = '', stdoutTail = '', stderrTail = '';
    let stdoutChars = 0, stderrChars = 0, outputBytes = 0, truncated = false;
    let settled = false, killing = false, monitoring = false;
    let unregisterProcess: (() => void) | undefined;
    let monitorTimer: NodeJS.Timeout | undefined;

    const append = (kind: 'stdout' | 'stderr', chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > options.maxOutputBytes) truncated = true;
      const text = chunk.toString('utf8');
      if (kind === 'stdout') {
        stdoutChars += text.length;
        if (stdoutHead.length < 4000) stdoutHead += text.slice(0, 4000 - stdoutHead.length);
        stdoutTail = (stdoutTail + text).slice(-12_000);
      } else {
        stderrChars += text.length;
        if (stderrHead.length < 4000) stderrHead += text.slice(0, 4000 - stderrHead.length);
        stderrTail = (stderrTail + text).slice(-12_000);
      }
      if (options.outputLimitError && outputBytes > options.maxOutputBytes) terminate(options.outputLimitError(outputBytes));
    };
    const cleanup = () => {
      clearTimeout(timer);
      if (monitorTimer) clearInterval(monitorTimer);
      options.signal?.removeEventListener('abort', onAbort);
      unregisterProcess?.();
    };
    const rejectOnce = (error: unknown) => { if (settled) return; settled = true; cleanup(); reject(error); };
    const terminate = (error: Error) => {
      if (settled || killing) return;
      killing = true;
      void killProcessTree(child).then(() => rejectOnce(error));
    };
    const onAbort = () => terminate(options.signal?.reason instanceof Error ? options.signal.reason : new DOMException('Aborted', 'AbortError'));
    const timer = setTimeout(() => terminate(new Error(`${options.label} timeout after ${options.timeoutMs}ms`)), options.timeoutMs);
    const check = async () => {
      if (!options.monitor || settled || killing || monitoring) return;
      monitoring = true;
      try { await options.monitor({ terminate, outputBytes: () => outputBytes }); }
      catch (error) { terminate(error instanceof Error ? error : new Error(String(error))); }
      finally { monitoring = false; }
    };

    options.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (chunk: Buffer) => append('stdout', chunk));
    child.stderr?.on('data', (chunk: Buffer) => append('stderr', chunk));
    child.once('error', error => { if (!killing) rejectOnce(new Error(`Unable to start ${options.label}: ${error.message}`)); });
    child.once('close', code => {
      if (settled || killing) return;
      settled = true;
      cleanup();
      resolve({ code: code ?? -1, stdout: diagnostics(stdoutHead, stdoutTail, stdoutChars), stderr: diagnostics(stderrHead, stderrTail, stderrChars), truncated });
    });
    if (child.pid !== undefined && options.registerProcess) {
      try { unregisterProcess = options.registerProcess(child.pid); }
      catch (error) { terminate(error instanceof Error ? error : new Error(String(error))); }
    }
    if (options.monitor) { void check(); monitorTimer = setInterval(() => { void check(); }, 50); }
  });
}

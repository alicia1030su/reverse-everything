import { spawn as nodeSpawn, spawn as spawnTaskkill, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateSymbolicRequest, validateSymbolicResult } from './schema.js';
import type { SymbolicAnalysisRequest, SymbolicAnalysisResult, SymbolicEngineOptions } from './types.js';

const DEFAULT_WORKER = fileURLToPath(new URL('../../../scripts/symbolic_execute.py', import.meta.url));

function localResult(request: SymbolicAnalysisRequest, status: SymbolicAnalysisResult['status'], error?: string): SymbolicAnalysisResult {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1, status, paths: [], solvedInputs: [], solver: { name: 'unavailable', version: '0' },
    stats: { statesExplored: 0, pathsFound: 0, elapsedMs: 0 },
    limitations: [status === 'unauthorized' ? 'Authorization was not granted; no binary was loaded or executed.' : 'No worker result was available; no symbolic execution evidence is claimed.'],
    provenance: { binaryPath: request.binaryPath, binarySha256: '0'.repeat(64), workerSha256: '0'.repeat(64), pythonVersion: 'unavailable', angrVersion: 'unavailable', requestedAt: now, completedAt: now },
    ...(error ? { error } : {}),
  };
}

export class SymbolicExecutionEngine {
  private readonly pythonExecutable: string;
  private readonly workerPath: string;
  private readonly maxOutputBytes: number;
  private readonly maxRequestBytes: number;
  private readonly spawnProcess: NonNullable<SymbolicEngineOptions['spawn']>;

  constructor(options: SymbolicEngineOptions = {}) {
    this.pythonExecutable = options.pythonExecutable ?? (process.platform === 'win32' ? 'python' : 'python3');
    this.workerPath = options.workerPath ?? DEFAULT_WORKER;
    this.maxOutputBytes = options.maxOutputBytes ?? 2_097_152;
    this.maxRequestBytes = options.maxRequestBytes ?? 16_384;
    this.spawnProcess = options.spawn ?? nodeSpawn;
  }

  async analyze(rawRequest: SymbolicAnalysisRequest, signal?: AbortSignal): Promise<SymbolicAnalysisResult> {
    const startedAt = new Date().toISOString();
    let request: SymbolicAnalysisRequest;
    try {
      request = validateSymbolicRequest(rawRequest);
    } catch (error) {
      if (typeof rawRequest === 'object' && rawRequest !== null && (rawRequest as { authorized?: unknown }).authorized === false) return localResult(rawRequest, 'unauthorized');
      throw error;
    }
    if (signal?.aborted) return localResult(request, 'cancelled');
    const payload = JSON.stringify({ ...request, timeoutMs: request.timeoutMs ?? 30_000, maxPaths: request.maxPaths ?? 32, maxStates: request.maxStates ?? 10_000 });
    if (Buffer.byteLength(payload, 'utf8') > this.maxRequestBytes) throw new Error('Symbolic request exceeds the bounded JSON budget');

    return new Promise<SymbolicAnalysisResult>((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = this.spawnProcess(this.pythonExecutable, [this.workerPath], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams;
      } catch (error) {
        reject(new Error(`Unable to spawn symbolic worker: ${error instanceof Error ? error.message : String(error)}`));
        return;
      }
      let stdout = '';
      let stderr = '';
      let outputBytes = 0;
      let outputExceeded = false;
      let settled = false;
      let timedOut = false;
      let killTimer: NodeJS.Timeout | undefined;
      const timeoutMs = request.timeoutMs ?? 30_000;

      const finish = (result: SymbolicAnalysisResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        signal?.removeEventListener('abort', onAbort);
        resolve(result);
      };
      const terminate = (): void => {
        if (child.killed) return;
        try {
          if (process.platform === 'win32' && child.pid) {
            const killer = spawnTaskkill('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
            killer.on('error', () => { try { child.kill('SIGKILL'); } catch { /* close still completes */ } });
            killer.unref();
          } else child.kill('SIGTERM');
        } catch { /* close/error still completes the promise */ }
        killTimer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* process may already have exited */ }
        }, 1_000);
        killTimer.unref();
      };
      const timer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, timeoutMs);
      const onAbort = (): void => { terminate(); };
      signal?.addEventListener('abort', onAbort, { once: true });

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (settled || outputExceeded) return;
        outputBytes += Buffer.byteLength(chunk, 'utf8');
        if (outputBytes > this.maxOutputBytes) {
          outputExceeded = true;
          terminate();
          return;
        }
        stdout += chunk;
      });
      child.stderr.on('data', (chunk: string) => {
        if (stderr.length < 65_536) stderr += chunk.slice(0, 65_536 - stderr.length);
      });
      child.on('error', error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        signal?.removeEventListener('abort', onAbort);
        reject(new Error(`Symbolic worker process error: ${error.message}`));
      });
      child.on('close', (code, terminationSignal) => {
        if (settled) return;
        if (outputBytes > this.maxOutputBytes) {
          finish(localResult(request, 'error', `Symbolic worker output exceeded ${this.maxOutputBytes} bytes`));
          return;
        }
        if (signal?.aborted) {
          finish(localResult(request, 'cancelled'));
          return;
        }
        if (timedOut) {
          finish(localResult(request, 'timeout', `Symbolic worker exceeded ${timeoutMs} ms and was terminated`));
          return;
        }
        if (code !== 0 || terminationSignal !== null) {
          finish(localResult(request, 'error', `Symbolic worker exited with code ${String(code)} signal ${String(terminationSignal)}: ${stderr.trim().slice(0, 2_000)}`));
          return;
        }
        try {
          const result = validateSymbolicResult(JSON.parse(stdout) as unknown, this.maxOutputBytes);
          if (result.provenance.binaryPath !== request.binaryPath) throw new Error('Worker returned evidence for a different binary');
          if (result.solvedInputs.some(input => input.inputHex.length !== request.input.sizeBytes * 2)) throw new Error('Solved input size does not match the request');
          result.stats.elapsedMs = Math.max(result.stats.elapsedMs, Date.now() - Date.parse(startedAt));
          finish(result);
        } catch (error) {
          finish(localResult(request, 'error', `Invalid symbolic worker response: ${error instanceof Error ? error.message : String(error)}`));
        }
      });
      child.stdin.on('error', () => { /* A worker failure is reported through close/error. */ });
      child.stdin.end(payload, 'utf8');
    });
  }
}

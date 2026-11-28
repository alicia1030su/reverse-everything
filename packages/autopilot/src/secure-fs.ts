import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { AutopilotError } from './types.js';

const HELPER = fileURLToPath(new URL('../../../scripts/secure_fs.py', import.meta.url));
const MAX_RESPONSE_BYTES = 48 * 1024 * 1024;

export interface SecureFsRequest {
  operation: 'read' | 'write' | 'copy';
  root: string;
  directoryParts: string[];
  fileParts?: string[];
  subdirectory?: string;
  fileName?: string;
  contentBase64?: string;
  maxBytes?: number;
  source?: string;
  expectedSha256?: string;
}
export interface SecureFsOptions {
  pythonExecutable?: string;
  signal?: AbortSignal | undefined;
  timeoutMs?: number;
}
export type SecureFsResult =
  | { operation: 'read'; path: string; sha256: string; contentBase64: string }
  | { operation: 'write' | 'copy'; path: string; sha256: string };

function pythonCandidates(explicit?: string): string[] {
  const configured = explicit ?? process.env.PYTHON;
  const fallback = process.platform === 'win32' ? 'python' : 'python3';
  return [...new Set([configured, 'python3', fallback].filter((value): value is string => Boolean(value)))];
}

function statusFor(code: string): number {
  if (code === 'PATH_FORBIDDEN') return 403;
  if (code === 'ARTIFACT_MISSING' || code === 'HASH_MISMATCH' || code === 'INPUT_CHANGED' || code === 'INVALID_CONTENT' || code === 'INVALID_PATH' || code === 'INVALID_HASH') return 422;
  if (code === 'INPUT_TOO_LARGE' || code === 'REQUEST_TOO_LARGE') return 413;
  return 500;
}

async function runOnce(request: SecureFsRequest, executable: string, options: SecureFsOptions): Promise<SecureFsResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [HELPER], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new AutopilotError('安全文件操作超时', 'SECURE_FS_TIMEOUT', 408));
    }, options.timeoutMs ?? 30_000);
    const onAbort = (): void => {
      child.kill('SIGKILL');
      finish(new AutopilotError('安全文件操作已取消', 'SECURE_FS_CANCELLED', 409));
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) { onAbort(); return; }
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > MAX_RESPONSE_BYTES) {
        child.kill('SIGKILL');
        finish(new AutopilotError('安全文件操作响应超过限额', 'SECURE_FS_OUTPUT_LIMIT', 413));
      }
    });
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-65_536); });
    child.on('error', (error) => finish(new AutopilotError(`无法启动安全文件 helper: ${error.message}`, 'SECURE_FS_SPAWN_FAILED', 503)));
    child.on('close', (code) => {
      if (settled) return;
      let parsed: unknown;
      try { parsed = JSON.parse(stdout); } catch { finish(new AutopilotError(`安全文件 helper 返回无效响应: ${stderr.slice(-2000)}`, 'SECURE_FS_PROTOCOL', 502)); return; }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { finish(new AutopilotError('安全文件 helper 响应必须是对象', 'SECURE_FS_PROTOCOL', 502)); return; }
      const value = parsed as Record<string, unknown>;
      if (value.ok !== true) {
        const error = value.error && typeof value.error === 'object' ? value.error as Record<string, unknown> : {};
        const code = typeof error.code === 'string' ? error.code : 'INTERNAL';
        const message = typeof error.message === 'string' ? error.message : '安全文件操作失败';
        finish(new AutopilotError(message, `SECURE_FS_${code}`, statusFor(code)));
        return;
      }
      if (code !== 0 || typeof value.path !== 'string' || typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.sha256)) {
        finish(new AutopilotError('安全文件 helper 响应契约无效', 'SECURE_FS_PROTOCOL', 502));
        return;
      }
      if (request.operation === 'read') {
        if (typeof value.contentBase64 !== 'string') { finish(new AutopilotError('安全文件读取响应缺少内容', 'SECURE_FS_PROTOCOL', 502)); return; }
        finish();
        resolve({ operation: 'read', path: value.path, sha256: value.sha256, contentBase64: value.contentBase64 });
      } else {
        finish();
        resolve({ operation: request.operation, path: value.path, sha256: value.sha256 });
      }
    });
    child.stdin.on('error', (error) => finish(new AutopilotError(`安全文件 helper stdin 写入失败: ${error.message}`, 'SECURE_FS_STDIN', 502)));
    child.stdin.end(JSON.stringify(request), 'utf8');
  });
}

export async function runSecureFs(request: SecureFsRequest, options: SecureFsOptions = {}): Promise<SecureFsResult> {
  const candidates = pythonCandidates(options.pythonExecutable);
  let last: unknown;
  for (const executable of candidates) {
    try { return await runOnce(request, executable, options); }
    catch (error) { last = error; if ((error as { code?: string }).code !== 'SECURE_FS_SPAWN_FAILED') throw error; }
  }
  throw last instanceof Error ? last : new AutopilotError('没有可用的 Python 解释器', 'SECURE_FS_PYTHON_MISSING', 503);
}

export function relativeParts(root: string, candidate: string): string[] {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new AutopilotError('路径必须位于任务工作区内', 'SECURE_FS_PATH_FORBIDDEN', 403);
  return relative.split(path.sep).filter(Boolean);
}

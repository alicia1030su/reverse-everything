import { createHash } from 'node:crypto';
import { constants, lstat, open, opendir, realpath } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import path from 'node:path';
import type { GameFileRecord, GameScanOptions, GameScanResult, GameScanSkipped } from './types.js';

const DEFAULT_MAX_FILES = 20_000;
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;
const MAX_SKIPPED = 100;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;

type ScannedFile = GameFileRecord & { ctimeMs: number; dev: number; ino: number };
type PreviousFile = Omit<Partial<ScannedFile>, 'dev' | 'ino'> & { dev?: number | string; ino?: number | string } & Pick<GameFileRecord, 'path'>;

function assertInside(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) return;
  throw new Error(`路径越界：${candidate}`);
}

function sameIdentity(actual: Stats, expected: Stats): boolean {
  return actual.dev === expected.dev && actual.ino === expected.ino;
}

function sameFingerprint(actual: Stats, expected: Stats): boolean {
  return sameIdentity(actual, expected) && actual.size === expected.size && actual.mtimeMs === expected.mtimeMs && actual.ctimeMs === expected.ctimeMs;
}

async function verifiedRealpath(candidate: string, root: string, expected: Stats): Promise<string> {
  const resolved = await realpath(candidate);
  assertInside(root, resolved);
  if (!sameIdentity(await lstat(resolved), expected)) throw new Error(`扫描期间目录或文件被替换：${candidate}`);
  return resolved;
}

async function hashFile(file: string, expected: Stats, root: string, signal?: AbortSignal, reusableHash?: string, remainingBytes = Number.MAX_SAFE_INTEGER): Promise<{ sha256?: string; bytesRead: number; exhausted: boolean }> {
  const before = await verifiedRealpath(file, root, expected);
  const handle = await open(before, constants.O_RDONLY | NO_FOLLOW);
  try {
    const opened = await handle.stat();
    if (!sameFingerprint(opened, expected) || !opened.isFile()) throw new Error(`扫描期间文件被替换：${file}`);
    await verifiedRealpath(file, root, expected);
    let bytesRead = 0;
    if (reusableHash) {
      const after = await handle.stat();
      if (!sameFingerprint(after, expected)) throw new Error(`扫描期间文件被修改：${file}`);
      return { sha256: reusableHash, bytesRead, exhausted: false };
    }
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      signal?.throwIfAborted();
      const { bytesRead: count } = await handle.read(buffer, 0, Math.min(buffer.length, remainingBytes - bytesRead + 1), bytesRead);
      if (!count) break;
      if (bytesRead + count > remainingBytes) return { bytesRead, exhausted: true };
      hash.update(buffer.subarray(0, count));
      bytesRead += count;
    }
    const after = await handle.stat();
    if (!sameFingerprint(after, expected) || after.size !== bytesRead) throw new Error(`扫描期间文件被修改：${file}`);
    return { sha256: hash.digest('hex'), bytesRead, exhausted: false };
  } finally { await handle.close(); }
}

function previousMap(previous: GameScanOptions['previous'], root: string): Map<string, PreviousFile> {
  if (!previous) return new Map();
  const result = new Map<string, PreviousFile>();
  for (const file of Array.isArray(previous) ? previous : previous.files) {
    const absolute = path.resolve(root, file.path);
    try { assertInside(root, absolute); } catch { continue; }
    result.set(absolute, file);
  }
  return result;
}

/** 只读扫描：不跟随链接，逐文件流式哈希；身份与四元元数据不变时才复用摘要。 */
export async function scanGameDirectory(rootInput: string, options: GameScanOptions = {}): Promise<GameScanResult> {
  const root = path.resolve(rootInput);
  const canonicalRoot = await realpath(root);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('扫描根目录必须是普通目录，不能是符号链接或 junction');
  await verifiedRealpath(root, canonicalRoot, rootStat);
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('扫描上限必须是正整数');
  const old = previousMap(options.previous, canonicalRoot);
  const files: ScannedFile[] = [];
  const skipped: GameScanSkipped[] = [];
  const skip = (file: string, reason: string): void => { if (skipped.length < MAX_SKIPPED) skipped.push({ path: file, reason }); };
  let bytesScanned = 0;
  let truncated = false;

  async function walk(directory: string, expected: Stats): Promise<void> {
    options.signal?.throwIfAborted();
    const resolved = await verifiedRealpath(directory, canonicalRoot, expected);
    const entries = await opendir(resolved, { bufferSize: 64 });
    if (!sameIdentity(await lstat(resolved), expected) || await realpath(resolved) !== resolved) { await entries.close(); throw new Error(`扫描期间目录被替换：${directory}`); }
    for await (const entry of entries) {
        options.signal?.throwIfAborted();
        if (files.length >= maxFiles) { truncated = true; return; }
        const absolute = path.resolve(resolved, entry.name);
        assertInside(canonicalRoot, absolute);
        const stat = await lstat(absolute);
        if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
          skip(absolute, '拒绝符号链接、junction 或特殊文件');
          continue;
        }
        await verifiedRealpath(absolute, canonicalRoot, stat);
        if (stat.isDirectory()) {
          await walk(absolute, stat);
          if (truncated) return;
          continue;
        }
        if (bytesScanned + stat.size > maxBytes) {
          truncated = true;
          skip(absolute, '总字节上限');
          return;
        }
        const relativePath = path.relative(canonicalRoot, absolute).split(path.sep).join('/');
        const previous = old.get(absolute);
        const reusable = previous && previous.sha256 && previous.size === stat.size && previous.mtimeMs === stat.mtimeMs && previous.ctimeMs === stat.ctimeMs && String(previous.dev) === String(stat.dev) && String(previous.ino) === String(stat.ino);
        const hashed = await hashFile(absolute, stat, canonicalRoot, options.signal, reusable ? previous.sha256 : undefined, maxBytes - bytesScanned);
        bytesScanned += hashed.bytesRead;
        if (hashed.exhausted) {
          truncated = true;
          skip(absolute, '读取达到总字节上限');
          return;
        }
        files.push({
          path: absolute,
          relativePath,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          ctimeMs: stat.ctimeMs,
          dev: stat.dev,
          ino: stat.ino,
          ...(hashed.sha256 ? { sha256: hashed.sha256 } : {}),
          extension: path.extname(entry.name).toLowerCase(),
          evidenceStatus: reusable ? 'INFERRED' : 'OBSERVED',
          evidenceRefs: [{ path: relativePath, detail: reusable ? '未重读文件内容；dev/ino、size、mtimeMs、ctimeMs 与上次一致，复用 SHA-256，证据降为 INFERRED' : `流式读取并校验 ${hashed.bytesRead} 字节，读后复核 dev/ino、size、mtimeMs、ctimeMs` }],
        });
      }
  }
  await walk(canonicalRoot, rootStat);
  return { files: files.sort((a, b) => a.relativePath.localeCompare(b.relativePath)), filesScanned: files.length, bytesScanned, truncated, skipped };
}

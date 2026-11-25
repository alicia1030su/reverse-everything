import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rm, stat, writeFile, type FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export async function sha256(value: string | Uint8Array): Promise<string> { return createHash('sha256').update(value).digest('hex'); }
export async function hashFile(file: string): Promise<string> {
  const handle = await openVerifiedFile(file);
  const hash = createHash('sha256');
  try { for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk); return hash.digest('hex'); }
  finally { await handle.close(); }
}
export class ArtifactAccessError extends Error {
  readonly code = 'ARTIFACT_UNAVAILABLE';
  constructor(message: string) { super(message); this.name = 'ArtifactAccessError'; }
}
function sameFileIdentity(a: { dev: number; ino: number }, b: { dev: number; ino: number }): boolean { return a.dev === b.dev && a.ino === b.ino; }
function windowsSystemCommand(name: string): string { const root = process.env.SystemRoot; if (!root) throw new ArtifactAccessError('Windows system directory is unavailable'); return path.join(root, 'System32', name); }
function runWindowsCommand(command: string, args: string[]): Promise<string> { return new Promise((resolve, reject) => execFile(command, args, { timeout: 5000, windowsHide: true }, (error, stdout) => error ? reject(error) : resolve(stdout))); }
async function restrictWindowsSnapshotDirectory(dir: string): Promise<void> {
  try {
    const identity = await runWindowsCommand(windowsSystemCommand('whoami.exe'), ['/user', '/fo', 'csv', '/nh']);
    const sid = identity.match(/\bS-1-[0-9-]+\b/)?.[0]; if (!sid) throw new Error('Current user SID was not returned');
    const icacls = windowsSystemCommand('icacls.exe');
    await runWindowsCommand(icacls, [dir, '/reset', '/T']);
    await runWindowsCommand(icacls, [dir, '/grant:r', `*${sid}:(OI)(CI)F`, '/T']);
    await runWindowsCommand(icacls, [dir, '/inheritance:r', '/T']);
  } catch { throw new ArtifactAccessError('Unable to restrict snapshot directory permissions'); }
}
async function assertWindowsNonReparsePath(file: string): Promise<void> {
  if (process.platform !== 'win32') return;
  const absolute = path.resolve(file);
  let canonical: string;
  try { canonical = await realpath(absolute); }
  catch (error) { if ((error as { code?: string }).code === 'ENOENT') throw new ArtifactAccessError('Artifact not found'); throw error; }
  const root = path.parse(absolute).root;
  let current = root;
  for (const component of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const info = await lstat(current).catch(error => { if ((error as { code?: string }).code === 'ENOENT') throw new ArtifactAccessError('Artifact not found'); throw error; });
    if (info.isSymbolicLink()) throw new ArtifactAccessError('Artifact path traverses a Windows reparse point');
  }
  const [original, resolved] = await Promise.all([lstat(absolute), lstat(canonical)]);
  if (!sameFileIdentity(original, resolved)) throw new ArtifactAccessError('Artifact path traverses a Windows reparse point');
}
async function openRegularFile(file: string): Promise<FileHandle> {
  const before = await lstat(file).catch(error => { if ((error as { code?: string }).code === 'ENOENT') throw new ArtifactAccessError('Artifact not found'); throw error; });
  if (before.isSymbolicLink() || !before.isFile()) throw new ArtifactAccessError('Artifact path is not a regular file');
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(error => { if ((error as { code?: string }).code === 'ENOENT') throw new ArtifactAccessError('Artifact not found'); throw error; });
  try {
    const opened = await handle.stat();
    if (opened.isSymbolicLink() || !opened.isFile() || !sameFileIdentity(before, opened)) throw new ArtifactAccessError('Artifact file changed while it was being opened');
    await assertWindowsNonReparsePath(file);
    return handle;
  } catch (error) { await handle.close().catch(() => {}); throw error; }
}
function verifySnapshotStats(before: Awaited<ReturnType<FileHandle['stat']>>, after: Awaited<ReturnType<FileHandle['stat']>>, expectedSize?: number): void {
  if (!before.isFile() || !after.isFile() || before.size !== after.size || before.mtimeMs !== after.mtimeMs || (expectedSize !== undefined && before.size !== expectedSize)) throw new ArtifactAccessError('Artifact changed while it was being read');
}
export async function openVerifiedFile(file: string, expectedSize?: number, expectedSha256?: string): Promise<FileHandle> {
  const handle = await openRegularFile(file);
  try {
    const opened = await handle.stat();
    if (expectedSize !== undefined && opened.size !== expectedSize) throw new ArtifactAccessError('Artifact size does not match its manifest');
    if (expectedSha256 !== undefined) {
      const hash = createHash('sha256'); const chunk = Buffer.alloc(64 * 1024); let position = 0;
      while (position < opened.size) { const read = await handle.read(chunk, 0, Math.min(chunk.length, opened.size - position), position); if (read.bytesRead === 0) throw new ArtifactAccessError('Artifact ended before its declared size'); hash.update(chunk.subarray(0, read.bytesRead)); position += read.bytesRead; }
      const final = await handle.stat(); verifySnapshotStats(opened, final, expectedSize);
      if (hash.digest('hex') !== expectedSha256) throw new ArtifactAccessError('Artifact digest does not match its manifest');
    }
    return handle;
  } catch (error) { await handle.close().catch(() => {}); throw error; }
}
export async function readVerifiedFile(file: string, expectedSize?: number, expectedSha256?: string): Promise<Buffer> {
  const handle = await openRegularFile(file);
  try {
    const before = await handle.stat(); const bytes = await handle.readFile(); const after = await handle.stat(); verifySnapshotStats(before, after, expectedSize);
    if (expectedSha256 !== undefined && createHash('sha256').update(bytes).digest('hex') !== expectedSha256) throw new ArtifactAccessError('Artifact digest does not match its manifest');
    return bytes;
  } finally { await handle.close(); }
}
export async function snapshotVerifiedFile(file: string, expectedSize: number, expectedSha256: string): Promise<{ handle: FileHandle; cleanup: () => Promise<void> }> {
  const source = await openRegularFile(file); let dir: string | undefined; let writer: FileHandle | undefined; let reader: FileHandle | undefined; let cleaned = false;
  const cleanup = async () => { if (cleaned) return; cleaned = true; await reader?.close().catch(() => {}); await writer?.close().catch(() => {}); await source.close().catch(() => {}); if (dir) await rm(dir, { recursive: true, force: true }); };
  try {
    const before = await source.stat(); if (before.size !== expectedSize) throw new ArtifactAccessError('Artifact size does not match its manifest');
    dir = await mkdtemp(path.join(os.tmpdir(), 're-artifact-snapshot-')); const snapshot = path.join(dir, 'artifact'); await assertWindowsNonReparsePath(dir); if (process.platform === 'win32') await restrictWindowsSnapshotDirectory(dir); await assertWindowsNonReparsePath(dir); writer = await open(snapshot, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); await assertWindowsNonReparsePath(snapshot);
    const hash = createHash('sha256'); const chunk = Buffer.alloc(64 * 1024); let position = 0;
    while (position < expectedSize) { const read = await source.read(chunk, 0, Math.min(chunk.length, expectedSize - position), position); if (read.bytesRead === 0) throw new ArtifactAccessError('Artifact ended before its declared size'); const part = chunk.subarray(0, read.bytesRead); let written = 0; while (written < part.length) { const result = await writer.write(part, written, part.length - written); if (result.bytesWritten === 0) throw new ArtifactAccessError('Artifact snapshot could not be written'); written += result.bytesWritten; } hash.update(part); position += part.length; }
    const after = await source.stat(); verifySnapshotStats(before, after, expectedSize); if (hash.digest('hex') !== expectedSha256) throw new ArtifactAccessError('Artifact digest does not match its manifest');
    await writer.close(); writer = undefined; reader = await openRegularFile(snapshot); return { handle: reader, cleanup };
  } catch (error) { await cleanup(); throw error; }
}
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value as object).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
}
export async function evidenceHash(value: unknown): Promise<string> { return sha256(canonical(value)); }
export function safeArtifactName(name: string): string {
  const base = name.replace(/\\/g, '/').split('/').pop() ?? '';
  const clean = base.replace(/[^a-zA-Z0-9._-]/g, '_');
  if (!clean || clean === '.' || clean === '..' || /~[0-9]/i.test(base)) throw new Error('Invalid artifact name');
  const canonical = clean.normalize('NFC').replace(/[. ]+$/, '');
  if (!canonical) throw new Error('Invalid artifact name');
  return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(canonical) ? `_${canonical.toLowerCase()}` : canonical.toLowerCase();
}
export async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2), 'utf8');
}
export async function readJson<T>(file: string): Promise<T> { return JSON.parse(await readFile(file, 'utf8')) as T; }
export async function artifactMeta(file: string, name: string, mime: string) {
  const s = await stat(file);
  return { name, size: s.size, sha256: await hashFile(file), mime, downloadPath: `/api/tasks/${encodeURIComponent(name)}/artifacts/${encodeURIComponent(name)}` };
}

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function sha256(value: string | Uint8Array): Promise<string> { return createHash('sha256').update(value).digest('hex'); }
export async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value as object).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
}
export async function evidenceHash(value: unknown): Promise<string> { return sha256(canonical(value)); }
export function safeArtifactName(name: string): string {
  const clean = path.basename(name).replace(/[^a-zA-Z0-9._-]/g, '_');
  if (!clean || clean === '.' || clean === '..') throw new Error('Invalid artifact name');
  return clean;
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

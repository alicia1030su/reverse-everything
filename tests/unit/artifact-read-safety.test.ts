import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ArtifactAccessError, hashFile, openVerifiedFile, readVerifiedFile, snapshotVerifiedFile } from '@reverse/evidence';
import { cleanupKnownTempRoot } from '../helpers/safe-cleanup.js';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function setup() { const dir = await mkdtemp(path.join(os.tmpdir(), 're-artifact-read-')); dirs.push(dir); return dir; }
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

describe('verified artifact reads', () => {
  it('returns the original open handle only after size and digest validation', async () => {
    const dir = await setup(); const file = path.join(dir, 'artifact'); const value = 'verified artifact bytes'; await writeFile(file, value);
    const handle = await openVerifiedFile(file, Buffer.byteLength(value), digest(value));
    try { const stream = handle.createReadStream(); let received = ''; for await (const chunk of stream) received += chunk.toString(); expect(received).toBe(value); } finally { await handle.close(); }
    expect(await readVerifiedFile(file, Buffer.byteLength(value), digest(value))).toEqual(Buffer.from(value));
  });
  it('rejects same-size byte tampering and closes the opened handle', async () => {
    const dir = await setup(); const file = path.join(dir, 'artifact'); const original = 'original-artifact'; const tampered = 'tampered-artifact'; await writeFile(file, tampered);
    await expect(readVerifiedFile(file, Buffer.byteLength(original), digest(original))).rejects.toBeInstanceOf(ArtifactAccessError);
    await expect(readVerifiedFile(file, Buffer.byteLength(original) + 1, digest(original))).rejects.toThrow(/size|changed/);
  });
  it('streams a private verified snapshot after the original path changes', async () => {
    const dir = await setup(); const file = path.join(dir, 'artifact'); const value = 'snapshot-original'; await writeFile(file, value);
    const opened = await snapshotVerifiedFile(file, Buffer.byteLength(value), digest(value));
    try { await writeFile(file, 'snapshot-tampered'); let received = ''; for await (const chunk of opened.handle.createReadStream()) received += chunk.toString(); expect(received).toBe(value); } finally { await opened.cleanup(); }
  });
  it('cleans a known temporary root in small verified batches without touching siblings', async () => {
    const parent = await setup(); const root = path.join(parent, 'integration-fixture'); const nested = path.join(root, 'nested'); const sibling = path.join(parent, 'keep.txt');
    await mkdir(nested, { recursive: true }); await writeFile(sibling, 'keep');
    for (let index = 0; index < 85; index++) await writeFile(path.join(index % 2 ? nested : root, `file-${index}`), String(index));
    await cleanupKnownTempRoot(root, parent);
    await expect(readFile(root)).rejects.toMatchObject({ code: 'ENOENT' }); expect(await readFile(sibling, 'utf8')).toBe('keep');
    const unrelated = path.join(parent, 'unrelated'); await mkdir(unrelated); await writeFile(path.join(unrelated, 'keep'), 'keep');
    await expect(cleanupKnownTempRoot(unrelated, parent)).rejects.toThrow(/known temporary|prefix|parent/i); expect(await readFile(path.join(unrelated, 'keep'), 'utf8')).toBe('keep');
  });
  it.skipIf(process.platform === 'win32')('rejects symbolic links without reading their target', async () => {
    const dir = await setup(); const target = path.join(dir, 'target'); const link = path.join(dir, 'link'); const value = 'outside-secret'; await writeFile(target, value); await symlink(target, link, 'file');
    await expect(readVerifiedFile(link, Buffer.byteLength(value), digest(value))).rejects.toBeInstanceOf(ArtifactAccessError);
    await expect(hashFile(link)).rejects.toBeInstanceOf(ArtifactAccessError);
    await expect(readFile(link)).resolves.toEqual(Buffer.from(value));
  });
});

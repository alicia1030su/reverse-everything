import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { limitedRead } from '../../packages/core/src/adapters/base.js';

const swap = vi.hoisted(() => ({ target: '', replacement: '', done: false }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, stat: async (...args: Parameters<typeof actual.stat>) => {
    const result = await actual.stat(...args);
    if (args[0] === swap.target && !swap.done) { swap.done = true; await actual.writeFile(swap.target, swap.replacement); }
    return result;
  } };
});
const dirs: string[] = [];
afterEach(async () => { swap.target = ''; swap.replacement = ''; swap.done = false; for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function setup() { const dir = await mkdtemp(path.join(os.tmpdir(), 're-upload-read-')); dirs.push(dir); return dir; }

describe('bounded upload reads', () => {
  it('does not trust a pathname stat before opening a replaceable upload', async () => {
    const dir = await setup(); const file = path.join(dir, 'upload.bin'); await writeFile(file, 'safe'); swap.target = file; swap.replacement = 'LEAK';
    let value: string | undefined;
    try { value = (await limitedRead(file, 100)).toString(); } catch (error) { expect(String(error)).toMatch(/changed|unsafe|identity|size|end/i); }
    if (value !== undefined) expect(value).toBe('safe');
  });
  it.skipIf(process.platform === 'win32')('rejects a symbolic-link upload instead of following it', async () => {
    const dir = await setup(); const target = path.join(dir, 'target'); const link = path.join(dir, 'upload'); await writeFile(target, 'outside-secret'); await symlink(target, link, 'file');
    await expect(limitedRead(link, 100)).rejects.toThrow(/regular|symbolic|unsafe/i);
  });
});

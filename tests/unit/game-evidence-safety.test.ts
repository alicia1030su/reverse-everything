import { mkdtemp, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scanGameDirectory } from '../../packages/game-revival/src/scanner.js';

const controls = vi.hoisted(() => ({ replaceOnOpen: false, mutateOnRead: false, replaceDirectoryOnOpen: false, forceSymbolicLinks: false }));
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...fs,
    lstat: async (...args: Parameters<typeof fs.lstat>) => {
      const stat = await fs.lstat(...args);
      if (controls.forceSymbolicLinks && path.basename(String(args[0])).startsWith('link-')) {
        stat.isSymbolicLink = () => true;
        stat.isFile = () => false;
        stat.isDirectory = () => false;
      }
      return stat;
    },
    open: async (...args: Parameters<typeof fs.open>) => {
      const file = String(args[0]);
      if (controls.replaceOnOpen && file.endsWith('victim.bin')) {
        controls.replaceOnOpen = false;
        await fs.writeFile(file, 'evil!');
      }
      const handle = await fs.open(...args);
      if (controls.mutateOnRead && file.endsWith('victim.bin')) {
        controls.mutateOnRead = false;
        const read = handle.read.bind(handle);
        handle.read = (async (...readArgs: Parameters<typeof handle.read>) => {
          const result = await read(...readArgs);
          await fs.writeFile(file, 'changed');
          return result;
        }) as typeof handle.read;
      }
      return handle;
    },
    opendir: async (...args: Parameters<typeof fs.opendir>) => {
      if (controls.replaceDirectoryOnOpen && String(args[0]).endsWith('nested')) {
        controls.replaceDirectoryOnOpen = false;
        await rename(String(args[0]), `${args[0]}-moved`);
        await mkdir(String(args[0]));
        await writeFile(path.join(String(args[0]), 'intruder.txt'), 'outside traversal');
      }
      return fs.opendir(...args);
    },
  };
});

const temporary: string[] = [];
beforeEach(() => { controls.replaceOnOpen = false; controls.mutateOnRead = false; controls.replaceDirectoryOnOpen = false; controls.forceSymbolicLinks = false; });
afterEach(async () => { await Promise.all(temporary.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
async function workspace(): Promise<string> { const directory = await mkdtemp(path.join(os.tmpdir(), 'game-evidence-safety-')); temporary.push(directory); return directory; }

describe('扫描竞态与读取安全', () => {
  it('拒绝 lstat/realpath 之后、open 之前被替换的同尺寸文件', async () => {
    const root = await workspace();
    await writeFile(path.join(root, 'victim.bin'), 'hello');
    controls.replaceOnOpen = true;
    await expect(scanGameDirectory(root)).rejects.toThrow('被替换');
  });

  it('读后 fstat 拒绝内容已修改的文件', async () => {
    const root = await workspace();
    await writeFile(path.join(root, 'victim.bin'), 'hello');
    controls.mutateOnRead = true;
    await expect(scanGameDirectory(root)).rejects.toThrow('被修改');
  });

  it('skipped 详情最多保留 100 条', async () => {
    const root = await workspace();
    for (let index = 0; index < 105; index += 1) await writeFile(path.join(root, `link-${index}.txt`), 'x');
    controls.forceSymbolicLinks = true;
    const result = await scanGameDirectory(root);
    expect(result.files).toEqual([]);
    expect(result.skipped).toHaveLength(100);
  });

  it('拒绝 opendir 期间被替换的目录', async () => {
    const root = await workspace();
    await mkdir(path.join(root, 'nested'));
    await writeFile(path.join(root, 'nested', 'safe.txt'), 'safe');
    controls.replaceDirectoryOnOpen = true;
    await expect(scanGameDirectory(root)).rejects.toThrow('目录被替换');
  });
});

import * as fsPromises from 'node:fs/promises';
import { mkdtemp, mkdir, symlink, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { archiveDigest, validateArchiveEntryName, zipDirectory } from '../../apps/api/src/game-archive.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});

const temporary: string[] = [];
async function fixture(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 're-v006-zip-'));
  temporary.push(dir);
  return dir;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporary.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('生成游戏服务归档', () => {
  it('写入有效且确定性的 ZIP 中央目录，直接使用条目元数据', async () => {
    const dir = await fixture();
    await mkdir(path.join(dir, 'server'));
    await writeFile(path.join(dir, 'README.md'), 'owned');
    await writeFile(path.join(dir, 'server', 'index.mjs'), 'console.log(1)');
    const bytes = await zipDirectory(dir);
    expect(bytes.readUInt32LE(0)).toBe(0x04034b50);
    const eocd = bytes.length - 22;
    expect(bytes.readUInt32LE(eocd)).toBe(0x06054b50);
    expect(bytes.readUInt16LE(eocd + 10)).toBe(2);
    expect(bytes.readUInt32LE(14)).toBe(0x3bb4532d);
    const firstEntrySize = 30 + bytes.readUInt16LE(26) + bytes.readUInt32LE(18);
    expect(bytes.readUInt32LE(eocd + 16)).toBe(firstEntrySize + 30 + bytes.readUInt32LE(firstEntrySize + 18) + bytes.readUInt16LE(firstEntrySize + 26));
    expect(archiveDigest(bytes)).toMatch(/^[a-f0-9]{64}$/);
    expect(archiveDigest(await zipDirectory(dir))).toBe(archiveDigest(bytes));
  });

  it('不把内容中的伪造 PK 中央目录元数据当作真实条目', async () => {
    const dir = await fixture();
    const fakeLocal = Buffer.alloc(30);
    fakeLocal.writeUInt32LE(0x04034b50, 0);
    fakeLocal.writeUInt16LE(9, 26);
    fakeLocal.write('evil.txt', 30);
    await writeFile(path.join(dir, 'payload.bin'), fakeLocal);
    const bytes = await zipDirectory(dir);
    const eocd = bytes.length - 22;
    expect(bytes.readUInt16LE(eocd + 10)).toBe(1);
    expect(bytes.toString('utf8')).toContain('payload.bin');
  });

  it('排除依赖、构建产物、数据、Git 与环境文件', async () => {
    const dir = await fixture();
    for (const name of ['node_modules', 'dist', 'data', '.git', 'nested', 'nested/dist']) await mkdir(path.join(dir, name));
    for (const name of ['node_modules/a.js', 'dist/a.js', 'data/a.json', '.git/config', '.env', '.env.local', 'nested/dist/a.js']) {
      await writeFile(path.join(dir, name), 'excluded');
    }
    await writeFile(path.join(dir, 'keep.mjs'), 'keep');
    const bytes = await zipDirectory(dir);
    expect(bytes.toString('utf8')).toContain('keep.mjs');
    expect(bytes.toString('utf8')).not.toContain('excluded');
    expect(bytes.readUInt16LE(bytes.length - 12)).toBe(1);
  });

  it('拒绝 POSIX 危险条目名', async () => {
    for (const name of ['../escape.txt', '/absolute.txt', 'C:/drive.txt', 'C:drive.txt', 'dir\\escape.txt', 'bad\u0000name', 'bad\nname', 'dir/../escape', './file', 'dir//file', '']) {
      expect(() => validateArchiveEntryName(name)).toThrow(/条目名|路径/);
    }
    expect(() => validateArchiveEntryName('nested/server/index.mjs')).not.toThrow();
  });

  it('拒绝符号链接与非普通根目录', async () => {
    const dir = await fixture();
    await writeFile(path.join(dir, 'real.txt'), 'real');
    try {
      await symlink(path.join(dir, 'real.txt'), path.join(dir, 'link.txt'), 'file');
      await expect(zipDirectory(dir)).rejects.toThrow(/符号链接|symbolic link/i);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    }
    await expect(zipDirectory(path.join(dir, 'real.txt'))).rejects.toThrow(/目录/);
  });

  it('使用 handle 有界读取并检测 stat 后增长', async () => {
    const dir = await fixture();
    const file = path.join(dir, 'growing.txt');
    await writeFile(file, '1234');
    const actualOpen = fsPromises.open;
    const open = vi.mocked(fsPromises.open).mockImplementationOnce(async () => {
      await fsPromises.appendFile(file, '56789');
      return actualOpen(file, 'r');
    });
    await expect(zipDirectory(dir, { maxEntryBytes: 8 })).rejects.toThrow(/文件.*超/);
    expect(open).toHaveBeenCalledWith(file, 'r');
  });

  it('大量小文件不会按单文件上限预分配内存', async () => {
    const dir = await fixture();
    for (let index = 0; index < 300; index += 1) await writeFile(path.join(dir, `small-${index}.txt`), 'x');
    const bytes = await zipDirectory(dir, { maxEntryBytes: 16 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024 });
    expect(bytes.readUInt16LE(bytes.length - 12)).toBe(300);
  });

  it('严格限制条目数与总字节，且限制可调', async () => {
    const dir = await fixture();
    await writeFile(path.join(dir, 'a.txt'), '1234');
    await writeFile(path.join(dir, 'b.txt'), '5678');
    await expect(zipDirectory(dir, { maxTotalBytes: 7 })).rejects.toThrow(/总字节/);
    await expect(zipDirectory(dir, { maxEntryBytes: 3 })).rejects.toThrow(/文件.*超/);
    await expect(zipDirectory(dir, { maxEntries: 1 })).rejects.toThrow(/条目/);
  });
});

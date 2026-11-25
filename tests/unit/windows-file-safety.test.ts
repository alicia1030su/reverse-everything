import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArtifactAccessError, readVerifiedFile, snapshotVerifiedFile } from '@reverse/evidence';

const controls = vi.hoisted(() => ({ failAcl: false, snapshotDirs: [] as string[], swapTarget: '', swapped: false, realpathTarget: '', realpathAlias: '' }));
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: ((...args: Parameters<typeof actual.execFile>) => {
    const command = String(args[0]); const commandArgs = args[1] as readonly string[] | undefined;
    if (command.toLowerCase().includes('icacls') && commandArgs?.[0] && path.basename(commandArgs[0]).startsWith('re-artifact-snapshot-')) {
      controls.snapshotDirs.push(commandArgs[0]);
      if (controls.failAcl) { const callback = args[3]; queueMicrotask(() => callback?.(new Error('ACL command failed'), '', '')); return {} as ReturnType<typeof actual.execFile>; }
    }
    return Reflect.apply(actual.execFile, undefined, args) as ReturnType<typeof actual.execFile>;
  }) as typeof actual.execFile };
});
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, lstat: async (...args: Parameters<typeof actual.lstat>) => {
    const info = await actual.lstat(...args);
    if (String(args[0]) === controls.swapTarget && !controls.swapped) {
      controls.swapped = true; const replacement = `${String(args[0])}.old`; await actual.rename(String(args[0]), replacement); await actual.writeFile(String(args[0]), 'LEAK');
    }
    return info;
  }, realpath: async (...args: Parameters<typeof actual.realpath>) => String(args[0]) === controls.realpathTarget ? controls.realpathAlias : actual.realpath(...args) };
});

const dirs: string[] = [];
afterEach(async () => { controls.failAcl = false; controls.snapshotDirs = []; controls.swapTarget = ''; controls.swapped = false; controls.realpathTarget = ''; controls.realpathAlias = ''; for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function setup() { const dir = await mkdtemp(path.join(os.tmpdir(), 're-windows-file-safety-')); dirs.push(dir); return dir; }
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function run(command: string, args: string[]): Promise<string> { return new Promise((resolve, reject) => execFile(command, args, { timeout: 5000, windowsHide: true }, (error, stdout) => error ? reject(error) : resolve(stdout))); }
function systemCommand(name: string): string { const root = process.env.SystemRoot; if (!root) throw new Error('Windows system directory is unavailable'); return path.join(root, 'System32', name); }

describe('Windows file safety', () => {
  it.skipIf(process.platform !== 'win32')('rejects an artifact reached through a directory junction', async () => {
    const dir = await setup(); const artifacts = path.join(dir, 'artifacts'); const outside = path.join(dir, 'outside'); await mkdir(artifacts); await mkdir(outside);
    const value = 'outside-secret'; const target = path.join(outside, 'secret'); await writeFile(target, value); await symlink(outside, path.join(artifacts, 'junction'), 'junction');
    await expect(readVerifiedFile(path.join(artifacts, 'junction', 'secret'), Buffer.byteLength(value), digest(value))).rejects.toBeInstanceOf(ArtifactAccessError);
  });
  it.runIf(process.platform === 'win32')('accepts a canonical alias with the same file identity and no link component', async () => {
    const dir = await setup(); const file = path.join(dir, 'artifact'); const alias = path.join(dir, 'canonical-alias'); const value = 'canonical alias bytes'; await writeFile(file, value); await link(file, alias);
    controls.realpathTarget = file; controls.realpathAlias = alias;
    await expect(readVerifiedFile(file, Buffer.byteLength(value), digest(value))).resolves.toEqual(Buffer.from(value));
  });
  it.skipIf(process.platform !== 'win32')('rejects a final-component symbolic-link reparse point', async ({ skip }) => {
    const dir = await setup(); const value = 'outside-secret'; const target = path.join(dir, 'target'); const link = path.join(dir, 'link'); await writeFile(target, value);
    try { await symlink(target, link, 'file'); } catch (error) { if ((error as { code?: string }).code === 'EPERM') { skip(); return; } throw error; }
    await expect(readVerifiedFile(link, Buffer.byteLength(value), digest(value))).rejects.toBeInstanceOf(ArtifactAccessError);
  });
  it('rejects same-size file replacement between lstat and open', async () => {
    const dir = await setup(); const file = path.join(dir, 'artifact'); await writeFile(file, 'safe'); controls.swapTarget = file;
    await expect(readVerifiedFile(file, 4, digest('safe'))).rejects.toBeInstanceOf(ArtifactAccessError);
    controls.swapped = true; await expect(snapshotVerifiedFile(file, 4, digest('safe'))).rejects.toBeInstanceOf(ArtifactAccessError);
  });
  it.skipIf(process.platform !== 'win32')('removes inherited broad ACLs from private snapshot directories', async () => {
    const parent = await setup(); const source = path.join(parent, 'source'); await writeFile(source, 'private snapshot');
    const sid = (await run(systemCommand('whoami.exe'), ['/user', '/fo', 'csv', '/nh'])).match(/S-1-[0-9-]+/)?.[0]; expect(sid).toBeTruthy();
    await run(systemCommand('icacls.exe'), [parent, '/grant', '*S-1-5-11:(OI)(CI)F']);
    const previousTemp = process.env.TEMP; const previousTmp = process.env.TMP; process.env.TEMP = parent; process.env.TMP = parent;
    let opened: Awaited<ReturnType<typeof snapshotVerifiedFile>> | undefined;
    try { opened = await snapshotVerifiedFile(source, Buffer.byteLength('private snapshot'), digest('private snapshot')); } finally { process.env.TEMP = previousTemp; process.env.TMP = previousTmp; if (previousTemp === undefined) delete process.env.TEMP; if (previousTmp === undefined) delete process.env.TMP; }
    try {
      const snapshotDir = controls.snapshotDirs[0]; expect(snapshotDir).toBeTruthy(); const acl = await run(systemCommand('icacls.exe'), [snapshotDir!]);
      expect(acl.match(/\(OI\)\(CI\)\(F\)/g)).toHaveLength(1); expect(acl).not.toContain('S-1-5-11'); expect(acl).not.toMatch(/Everyone|BUILTIN\\Users|Authenticated Users/i);
    } finally { await opened?.cleanup(); }
  });
  it.skipIf(process.platform !== 'win32')('fails closed and removes the snapshot directory when ACL hardening fails', async () => {
    const dir = await setup(); const source = path.join(dir, 'source'); await writeFile(source, 'private snapshot'); controls.failAcl = true;
    await expect(snapshotVerifiedFile(source, Buffer.byteLength('private snapshot'), digest('private snapshot'))).rejects.toBeInstanceOf(ArtifactAccessError);
    const snapshotDir = controls.snapshotDirs[0]; expect(snapshotDir).toBeTruthy(); await expect(lstat(snapshotDir!)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

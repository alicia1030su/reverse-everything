import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sevenZip from '7zip-bin';
import { afterEach, describe, expect, it } from 'vitest';
import { extractZip } from '../../scripts/extract-zip.mjs';

const path7za = typeof sevenZip === 'string' ? sevenZip : sevenZip.path7za;

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('demo ZIP extraction', () => {
  it('extracts packaged demo ZIP bytes without relying on platform tar ZIP support', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 're-demo-zip-'));
    temporary.push(root);
    const source = path.join(root, 'source');
    const destination = path.join(root, 'destination');
    const archive = path.join(root, 'demo.zip');
    await mkdir(path.join(source, 'nested'), { recursive: true });
    await mkdir(destination);
    await writeFile(path.join(source, 'nested', 'START-HERE.md'), 'verified demo\n');
    execFileSync(path7za, ['a', '-tzip', archive, '.'], { cwd: source, stdio: 'pipe' });

    await extractZip(archive, destination);

    expect(await readFile(path.join(destination, 'nested', 'START-HERE.md'), 'utf8')).toBe('verified demo\n');
  });
});

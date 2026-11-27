import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { afterEach, describe, expect, it } from 'vitest';
import yazl from 'yazl';
import { extractZip } from '../../scripts/extract-zip.mjs';

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
    const contentPath = path.join(source, 'nested', 'START-HERE.md');
    await writeFile(contentPath, 'verified demo\n');
    const zip = new yazl.ZipFile();
    zip.addFile(contentPath, 'nested/START-HERE.md');
    zip.end();
    await pipeline(zip.outputStream, createWriteStream(archive));

    await extractZip(archive, destination);

    expect(await readFile(path.join(destination, 'nested', 'START-HERE.md'), 'utf8')).toBe('verified demo\n');
  });
});

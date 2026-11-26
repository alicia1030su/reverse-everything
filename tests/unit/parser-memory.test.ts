import { execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);

async function finish(stream: ReturnType<typeof createWriteStream>): Promise<void> {
  await new Promise<void>((resolve, reject) => { stream.once('error', reject); stream.once('finish', resolve); stream.end(); });
}

describe('bounded parser memory', () => {
  it.each([64, 128])('streams a 100MB-class HAR under a %iMiB heap', async heap => {
    const dir = await import('node:fs/promises').then(fs => fs.mkdtemp(path.join(os.tmpdir(), 're-har-memory-')));
    const file = path.join(dir, 'large.har');
    const stream = createWriteStream(file);
    stream.write('{"log":{"entries":[');
    const padding = 'x'.repeat(1024);
    for (let index = 0; index < 100_000; index++) {
      if (index) stream.write(',');
      stream.write(JSON.stringify({ request: { method: 'GET', url: `https://example.test/${index}`, headers: [{ name: 'X-Pad', value: padding }] }, response: { status: 200, headers: [] } }));
    }
    stream.write(']}}');
    await finish(stream);
    const size = (await stat(file)).size;
    const moduleUrl = pathToFileURL(path.resolve('packages/core/dist/adapters/network.js')).href;
    const script = `import {parseHarFile} from ${JSON.stringify(moduleUrl)};const r=await parseHarFile(process.argv[1],Number(process.argv[2]),{maxBytes:64000000,maxRecords:100000,maxBodyBytes:1000000,maxSamples:100000,maxEntryBytes:8000000});console.log(JSON.stringify({records:r.recordCount,total:r.totalRecords,truncated:r.truncated,maxRSS:process.resourceUsage().maxRSS}));`;
    const { stdout } = await run(process.execPath, [`--max-old-space-size=${heap}`, '--input-type=module', '-e', script, file, String(size)], { maxBuffer: 4096, timeout: 60_000 });
    const result = JSON.parse(stdout) as { records: number; total: number; truncated: boolean; maxRSS: number };
    expect(size).toBeGreaterThan(100 * 1024 * 1024);
    expect(result.records).toBe(100_000);
    expect(result.total).toBe(100_000);
    expect(result.truncated).toBe(false);
    expect(result.maxRSS).toBeLessThan(256 * 1024);
    await import('node:fs/promises').then(fs => fs.rm(dir, { recursive: true, force: true }));
  }, 90_000);

  it.each([64, 128])('streams a 100MB-class usbmon capture under a %iMiB heap', async heap => {
    const dir = await import('node:fs/promises').then(fs => fs.mkdtemp(path.join(os.tmpdir(), 're-usbmon-memory-')));
    const file = path.join(dir, 'large-usbmon.txt');
    const stream = createWriteStream(file);
    const hex = Array.from({ length: 750 }, () => 'aaaaaaaa').join(' ');
    for (let index = 0; index < 20_000; index++) stream.write(`aaaa ${index} S Bi:1:001:1 0 ${hex.replace(/ /g, '').length / 2} = ${hex}\n`);
    await finish(stream);
    const size = (await stat(file)).size;
    const moduleUrl = pathToFileURL(path.resolve('packages/hardware/dist/capture.js')).href;
    const script = `import {parseUsbmonStream} from ${JSON.stringify(moduleUrl)};const r=await parseUsbmonStream(process.argv[1],Number(process.argv[2]),{maxRecords:20000,maxLineBytes:1000000});console.log(JSON.stringify({records:r.recordCount,truncated:r.truncated,maxRSS:process.resourceUsage().maxRSS}));`;
    const { stdout } = await run(process.execPath, [`--max-old-space-size=${heap}`, '--input-type=module', '-e', script, file, String(size)], { maxBuffer: 4096, timeout: 60_000 });
    const result = JSON.parse(stdout) as { records: number; truncated: boolean; maxRSS: number };
    expect(size).toBeGreaterThan(100 * 1024 * 1024);
    expect(result.records).toBe(20_000);
    expect(result.truncated).toBe(false);
    expect(result.maxRSS).toBeLessThan(256 * 1024);
    await import('node:fs/promises').then(fs => fs.rm(dir, { recursive: true, force: true }));
  }, 90_000);
});

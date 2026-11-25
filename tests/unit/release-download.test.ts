import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error JavaScript release utility is exercised directly.
import { downloadArtifacts } from '../../scripts/download-artifact.mjs';

const payload = Buffer.from('resumable-candidate-payload');
const sha256 = createHash('sha256').update(payload).digest('hex');
const dirs: string[] = [];
const servers: ReturnType<typeof createServer>[] = [];

async function fixtureDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 're-download-'));
  dirs.push(dir);
  return dir;
}
async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test server address');
  return `http://127.0.0.1:${address.port}`;
}
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('bounded artifact download', () => {
  it('resumes with Range and accepts legal redirect statuses without forwarding authorization cross-origin', async () => {
    let active = 0;
    let maxActive = 0;
    let redirectedAuthorization: string | undefined;
    let receivedRange: string | undefined;
    const target = await serve((req, res) => {
      redirectedAuthorization = req.headers.authorization;
      receivedRange = req.headers.range;
      res.setHeader('content-type', 'application/octet-stream');
      if (req.headers.range) {
        const start = Number(String(req.headers.range).match(/^bytes=(\d+)-$/)?.[1]);
        res.statusCode = 206;
        res.setHeader('content-range', `bytes ${start}-${payload.length - 1}/${payload.length}`);
        res.end(payload.subarray(start));
      } else res.end(payload);
    });
    const base = await serve((req, res) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      setTimeout(() => {
        active -= 1;
        if (req.url === '/start') {
          res.statusCode = 307;
          res.setHeader('location', target + '/asset');
          res.end();
        } else res.end(payload);
      }, 20);
    });
    const dir = await fixtureDir();
    const partial = Buffer.from('resumable-');
    await writeFile(path.join(dir, 'asset.bin.part'), partial);
    const manifest = { assets: [{ name: 'asset.bin', size: payload.length, sha256, url: base + '/start' }] };
    await downloadArtifacts({ manifest, dir, concurrency: 2, token: 'secret-token', fetchImpl: fetch, allowLocalHttp: true });
    expect(await readFile(path.join(dir, 'asset.bin'))).toEqual(payload);
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(receivedRange).toBe(`bytes=${partial.length}-`);
    expect(redirectedAuthorization).toBeUndefined();
  });

  it('uses bounded workers for multiple assets', async () => {
    let active = 0;
    let maxActive = 0;
    const base = await serve((_req, res) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      setTimeout(() => { active -= 1; res.end(payload); }, 20);
    });
    const dir = await fixtureDir();
    const manifest = { assets: Array.from({ length: 5 }, (_, index) => ({ name: `asset-${index}.bin`, size: payload.length, sha256, url: base + '/' + index })) };
    await downloadArtifacts({ manifest, dir, concurrency: 2, allowLocalHttp: true });
    expect(maxActive).toBe(2);
    for (const asset of manifest.assets) expect(await readFile(path.join(dir, asset.name))).toEqual(payload);
  });

  it.each([302, 303, 307, 308])('accepts HTTP %s redirects', async status => {
    const target = await serve((_req, res) => res.end(payload));
    const base = await serve((_req, res) => { res.statusCode = status; res.setHeader('location', target + '/asset'); res.end(); });
    const dir = await fixtureDir();
    const manifest = { assets: [{ name: 'asset.bin', size: payload.length, sha256, url: base + '/start' }] };
    await downloadArtifacts({ manifest, dir, allowLocalHttp: true });
    expect(await readFile(path.join(dir, 'asset.bin'))).toEqual(payload);
  });

  it('rejects a declared total-size mismatch before downloading', async () => {
    let requests = 0;
    const base = await serve((_req, res) => { requests += 1; res.end(payload); });
    const dir = await fixtureDir();
    const manifest = { assets: [{ name: 'asset.bin', size: payload.length + 1, sha256, url: base + '/asset' }] };
    await expect(downloadArtifacts({ manifest, dir, maxTotalBytes: payload.length, allowLocalHttp: true })).rejects.toThrow('Declared total size exceeds');
    expect(requests).toBe(0);
  });

  it('rejects actual size and digest mismatches and removes partial files', async () => {
    const base = await serve((_req, res) => res.end('wrong'));
    const dir = await fixtureDir();
    const manifest = { assets: [{ name: 'asset.bin', size: payload.length, sha256, url: base + '/asset' }] };
    await expect(downloadArtifacts({ manifest, dir, allowLocalHttp: true })).rejects.toThrow('Downloaded size mismatch');
    await expect(readFile(path.join(dir, 'asset.bin'))).rejects.toThrow();
    await expect(readFile(path.join(dir, 'asset.bin.part'))).rejects.toThrow();
  });

  it('rejects a same-size digest mismatch', async () => {
    const base = await serve((_req, res) => res.end('wrong'));
    const dir = await fixtureDir();
    const manifest = { assets: [{ name: 'asset.bin', size: 5, sha256, url: base + '/asset' }] };
    await expect(downloadArtifacts({ manifest, dir, allowLocalHttp: true })).rejects.toThrow('Downloaded digest mismatch');
  });

  it('redacts temporary URLs and tokens from network errors', async () => {
    const dir = await fixtureDir();
    const manifest = { assets: [{ name: 'asset.bin', size: 1, sha256, url: 'https://example.com/a?token=secret-token' }] };
    const fetchImpl = async () => { throw new TypeError('fetch failed https://example.com/a?token=secret-token'); };
    const attempt = downloadArtifacts({ manifest, dir, token: 'secret-token', fetchImpl });
    await expect(attempt).rejects.toThrow('[redacted-url]');
    await expect(attempt).rejects.not.toThrow('secret-token');
  });

  it('rejects unsafe names, insecure remote URLs and secret-bearing errors', async () => {
    const dir = await fixtureDir();
    await expect(downloadArtifacts({ manifest: { assets: [{ name: '../asset.bin', size: 1, sha256, url: 'https://example.com/a' }] }, dir })).rejects.toThrow('Unsafe artifact name');
    await expect(downloadArtifacts({ manifest: { assets: [{ name: 'asset.bin', size: 1, sha256, url: 'http://example.com/a' }] }, dir })).rejects.toThrow('HTTPS');
    await expect(downloadArtifacts({ manifest: { assets: [{ name: 'asset.bin', size: 1, sha256, url: 'https://example.com/a?token=secret-token' }] }, dir, token: 'secret-token', maxTotalBytes: 0 })).rejects.not.toThrow('secret-token');
  });
});

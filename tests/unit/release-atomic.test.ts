import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error JavaScript release utility is exercised directly.
import { evaluateRelease, expectedReleaseAssets, findReleaseByTag, getRelease, loadState, provenanceMarker, releaseAssetUploadUrl, retryDelayMs, saveState, uploadAsset, verifyAssetCompleteness, verifyDraft, verifyPublicAssets } from '../../scripts/release-atomic.mjs';

const commit = 'a'.repeat(40);
const tag = 'v0.0.4';
const digest = createHash('sha256').update('asset').digest('hex');
const manifestDigest = createHash('sha256').update('manifest').digest('hex');
const expected = [
  { name: 'asset.bin', size: 5, sha256: digest },
  { name: 'RELEASE-MANIFEST.json', size: 8, sha256: manifestDigest },
  { name: 'SHA256SUMS.txt', size: 10, sha256: 'c'.repeat(64) },
];

describe('atomic release state', () => {
  it('wires the v0.0.9 core gate into the publish path', async () => {
    const source = await readFile('scripts/release-atomic.mjs', 'utf8');
    expect(source).toContain("tag === 'v0.0.9'");
    expect(source).toContain('verifyV009CoreGateEvidence');
    expect(source).toContain('--core-gate-report');
    expect(source).toContain('--core-gate-evidence-dir');
  });

  it('requires an accepted candidate at the frozen commit', () => {
    const manifest = {
      schemaVersion: 1,
      version: '0.0.4',
      tag,
      commit,
      assets: [{ name: 'asset.bin', size: 5, sha256: digest }],
    };
    expect(expectedReleaseAssets(manifest, { manifestSize: 8, manifestSha256: manifestDigest, checksumsSize: 10, checksumsSha256: 'c'.repeat(64) })).toEqual(expected);
    expect(provenanceMarker(manifestDigest)).toBe('release-provenance-sha256:' + manifestDigest);
  });

  it('finds Draft releases through the list endpoint and rejects ambiguous duplicates', () => {
    const draft = { id: 1, tag_name: tag, draft: true };
    expect(findReleaseByTag([{ id: 2, tag_name: 'v0.0.3' }, draft], tag)).toBe(draft);
    expect(findReleaseByTag([], tag)).toBeNull();
    expect(() => findReleaseByTag([draft, { id: 3, tag_name: tag, draft: true }], tag)).toThrow(/Multiple releases/);
  });

  it('returns no release when both the tag endpoint and Draft list are absent', async () => {
    const server = createServer((_req, res) => { res.writeHead(404).end(); });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const previous = { api: process.env.GH_API_URL, token: process.env.GH_TOKEN };
    process.env.GH_API_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    process.env.GH_TOKEN = 'test-token';
    try { await expect(getRelease('acme/product', tag)).resolves.toBeNull(); }
    finally {
      if (previous.api === undefined) delete process.env.GH_API_URL; else process.env.GH_API_URL = previous.api;
      if (previous.token === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = previous.token;
      server.closeAllConnections();
      server.close();
      await once(server, 'close');
    }
  });

  it('persists resume state atomically and reports corrupt state clearly', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 're-release-state-'));
    const dir = path.join(parent, 'release');
    await mkdir(dir);
    const stateTag = 'v9.9.9';
    const state = { schemaVersion: 1, repo: 'acme/product', tag: stateTag, commit, manifestSha256: manifestDigest, releaseId: '42' };
    try {
      await saveState(dir, state);
      await expect(loadState(dir, stateTag, 'acme/product', commit, manifestDigest)).resolves.toEqual(state);
      const stateFile = path.join(dir, '..', '.release-state', `${stateTag}.json`);
      await writeFile(stateFile, '{');
      await expect(loadState(dir, stateTag, 'acme/product', commit, manifestDigest)).rejects.toThrow(/resume state is corrupt/);
      await writeFile(stateFile, 'null');
      await expect(loadState(dir, stateTag, 'acme/product', commit, manifestDigest)).rejects.toThrow(/resume state is corrupt/);
    } finally { await rm(parent, { recursive: true, force: true }); }
  });

  it('builds asset upload URLs from the Draft release identity instead of the tag endpoint', () => {
    const uploadUrl = 'https://uploads.github.com/repos/acme/product/releases/42/assets{?name,label}';
    const url = releaseAssetUploadUrl(uploadUrl, 'asset file.bin');
    expect(url.origin).toBe('https://uploads.github.com');
    expect(url.pathname).toBe('/repos/acme/product/releases/42/assets');
    expect(url.searchParams.get('name')).toBe('asset file.bin');
    expect(() => releaseAssetUploadUrl('not-a-url', 'asset.bin')).toThrow(/upload URL is invalid/);
    expect(() => releaseAssetUploadUrl('https://evil.example/releases/42/assets', 'asset.bin')).toThrow(/host is not allowed/);
  });

  it('accepts only a non-prerelease Draft targeting the accepted commit', () => {
    const draft = { tag_name: tag, target_commitish: commit, draft: true, prerelease: false, body: provenanceMarker(manifestDigest) };
    expect(verifyDraft(draft, { tag, commit, manifestSha256: manifestDigest })).toEqual([]);
    expect(verifyDraft({ ...draft, draft: false }, { tag, commit, manifestSha256: manifestDigest })).toContain('Release is already public');
    expect(verifyDraft({ ...draft, target_commitish: 'b'.repeat(40) }, { tag, commit, manifestSha256: manifestDigest })).toContain('Draft target commit mismatch');
    expect(verifyDraft({ ...draft, body: 'unrelated' }, { tag, commit, manifestSha256: manifestDigest })).toContain('Draft provenance marker mismatch');
  });

  it('checks every remote asset name, size and digest without allowing extras', () => {
    const remote = expected.map(asset => ({ name: asset.name, size: asset.size, digest: 'sha256:' + asset.sha256 }));
    expect(verifyAssetCompleteness(remote, expected)).toEqual([]);
    expect(verifyAssetCompleteness(remote.slice(1), expected)).toContain('Release asset is missing: asset.bin');
    expect(verifyAssetCompleteness(remote.map(asset => asset.name === 'asset.bin' ? { ...asset, size: 6 } : asset), expected)).toContain('Release asset size mismatch: asset.bin');
    expect(verifyAssetCompleteness(remote.map(asset => asset.name === 'asset.bin' ? { ...asset, digest: null } : asset), expected)).toContain('Release asset digest is missing: asset.bin');
    expect(verifyAssetCompleteness([...remote, { name: 'unexpected.zip', size: 1, digest: 'sha256:' + 'd'.repeat(64) }], expected)).toContain('Unexpected Release asset: unexpected.zip');
  });

  it('makes a verified public retry a no-op and rejects incomplete stable state', () => {
    const release = {
      tag_name: tag,
      target_commitish: commit,
      draft: false,
      prerelease: false,
      assets: expected.map(asset => ({ name: asset.name, size: asset.size, digest: 'sha256:' + asset.sha256 })),
    };
    const input = { release, latestTag: tag, tag, commit, expected };
    const first = evaluateRelease(input);
    expect(first).toMatchObject({ ok: true, alreadyPublished: true, safeToPublish: false });
    expect(evaluateRelease(input)).toEqual(first);
    expect(evaluateRelease({ ...input, latestTag: 'v0.0.3' })).toMatchObject({ ok: false, alreadyPublished: true });
    expect(evaluateRelease({ ...input, release: { ...release, draft: true } })).toMatchObject({ ok: true, alreadyPublished: false, safeToPublish: true });
    expect(evaluateRelease({ ...input, release: { ...release, assets: release.assets.slice(1) } })).toMatchObject({ ok: false, safeToPublish: false });
  });

  it('uses bounded exponential backoff and honors Retry-After', () => {
    expect(retryDelayMs(1)).toBe(250);
    expect(retryDelayMs(2)).toBe(500);
    expect(retryDelayMs(3)).toBe(1000);
    expect(retryDelayMs(2, 3)).toBe(3000);
  });

  it('paginates Release lookup and validates an explicit Release ID', async () => {
    const target = { id: 42, tag_name: tag, target_commitish: commit, draft: true, prerelease: false, assets: [], upload_url: '' };
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === `/repos/acme/product/releases/tags/${tag}`) { res.writeHead(404).end(); return; }
      if (url.pathname === '/repos/acme/product/releases') {
        const page = Number(url.searchParams.get('page') ?? '1');
        const batch = page === 1 ? Array.from({ length: 100 }, (_, index) => ({ id: index + 1, tag_name: `v9.0.${index}`, draft: true, assets: [] })) : [{ ...target, upload_url: `http://127.0.0.1:${(server.address() as { port: number }).port}/repos/acme/product/releases/42/assets{?name,label}` }];
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(batch)); return;
      }
      if (url.pathname === '/repos/acme/product/releases/42') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ...target, tag_name: 'v0.0.3', upload_url: `http://127.0.0.1:${(server.address() as { port: number }).port}/repos/acme/product/releases/42/assets{?name,label}` })); return; }
      res.writeHead(404).end();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const previous = { api: process.env.GH_API_URL, token: process.env.GH_TOKEN };
    process.env.GH_API_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    process.env.GH_TOKEN = 'test-token';
    try {
      expect((await getRelease('acme/product', tag))?.id).toBe(42);
      await expect(getRelease('acme/product', tag, '42')).rejects.toThrow(/does not match/);
    } finally {
      if (previous.api === undefined) delete process.env.GH_API_URL; else process.env.GH_API_URL = previous.api;
      if (previous.token === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = previous.token;
      server.closeAllConnections();
      server.close();
      await once(server, 'close');
    }
  });

  it('retries transient upload failures and accepts an already stored identical asset', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 're-release-upload-'));
    const file = path.join(dir, 'asset.bin');
    await writeFile(file, 'asset');
    let attempts = 0;
    let duplicate = false;
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method === 'POST' && url.pathname === '/repos/acme/product/releases/42/assets') {
        attempts++;
        if (duplicate) { res.writeHead(422).end(); return; }
        if (attempts === 1) { res.writeHead(503).end(); return; }
        res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 1, name: 'asset.bin', size: 5, digest: 'sha256:' + digest })); return;
      }
      if (req.method === 'GET' && url.pathname === '/repos/acme/product/releases/42') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 42, assets: [{ name: 'asset.bin', size: 5, digest: 'sha256:' + digest }] })); return;
      }
      res.writeHead(404).end();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as { port: number }).port;
    const release = { id: 42, upload_url: `http://127.0.0.1:${port}/repos/acme/product/releases/42/assets{?name,label}` };
    const previous = { api: process.env.GH_API_URL, token: process.env.GH_TOKEN };
    process.env.GH_API_URL = `http://127.0.0.1:${port}`;
    process.env.GH_TOKEN = 'test-token';
    try {
      await uploadAsset('acme/product', release, 'asset.bin', file, 'test-token', expected[0]);
      expect(attempts).toBe(2);
      duplicate = true;
      await expect(uploadAsset('acme/product', release, 'asset.bin', file, 'test-token', expected[0])).resolves.toMatchObject({ name: 'asset.bin' });
    } finally {
      if (previous.api === undefined) delete process.env.GH_API_URL; else process.env.GH_API_URL = previous.api;
      if (previous.token === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = previous.token;
      await rm(dir, { recursive: true, force: true });
      server.closeAllConnections();
      server.close();
      await once(server, 'close');
    }
  });

  it('downloads public assets and verifies their sizes, digests and checksum manifest', async () => {
    const content = Buffer.from('asset');
    const checksums = `${digest}  asset.bin\n`;
    const checksumDigest = createHash('sha256').update(checksums).digest('hex');
    const server = createServer((req, res) => {
      if (req.url === '/asset.bin') { res.writeHead(200).end(content); return; }
      if (req.url === '/SHA256SUMS.txt') { res.writeHead(200).end(checksums); return; }
      res.writeHead(404).end();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const release = { assets: [
        { name: 'asset.bin', browser_download_url: `${base}/asset.bin` },
        { name: 'SHA256SUMS.txt', browser_download_url: `${base}/SHA256SUMS.txt` },
      ] };
      const assets = [
        { name: 'asset.bin', size: content.length, sha256: digest },
        { name: 'SHA256SUMS.txt', size: Buffer.byteLength(checksums), sha256: checksumDigest },
      ];
      await expect(verifyPublicAssets(release, assets)).resolves.toEqual({ verified: 2 });
    } finally {
      server.closeAllConnections();
      server.close();
      await once(server, 'close');
    }
  });
});

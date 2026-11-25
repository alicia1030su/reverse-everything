import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { link, mkdir, open, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REDIRECTS = new Set([302, 303, 307, 308]);
const DEFAULT_TOKEN_HOSTS = new Set(['https://api.github.com', 'https://uploads.github.com']);

export function safeAssetName(value) {
  return typeof value === 'string' && value.length > 0 && value !== '.' && value !== '..' && !/[\\/\x00-\x1f]/.test(value);
}

function safeUrl(value, allowLocalHttp) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Artifact URL is invalid'); }
  const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(allowLocalHttp && local && url.protocol === 'http:')) throw new Error('Artifact URL must use HTTPS');
  if (url.username || url.password) throw new Error('Artifact URL must not contain credentials');
  return url;
}

export async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function sanitize(error, token) {
  let message = error instanceof Error ? error.message : String(error);
  message = message.replace(/https?:\/\/\S+/g, '[redacted-url]');
  if (token) message = message.split(token).join('[redacted-token]');
  return new Error(message);
}

async function request(url, { token, tokenHosts, range, fetchImpl, allowLocalHttp }) {
  let current = safeUrl(url, allowLocalHttp);
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const headers = { accept: 'application/octet-stream' };
    if (token && tokenHosts.has(current.origin)) headers.authorization = 'Bearer ' + token;
    if (range !== undefined) headers.range = `bytes=${range}-`;
    const response = await fetchImpl(current, { headers, redirect: 'manual' });
    if (REDIRECTS.has(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new Error('Artifact redirect is missing a Location header');
      current = safeUrl(new URL(location, current).href, allowLocalHttp);
      if (current.protocol === 'http:' && url.startsWith('https:')) throw new Error('Artifact redirect downgraded HTTPS');
      continue;
    }
    return { response, url: current };
  }
  throw new Error('Artifact redirect limit exceeded');
}

function parseContentRange(value, existing, expectedSize) {
  if (!value) throw new Error('Resumed response is missing Content-Range');
  const match = value.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
  if (!match) throw new Error('Resumed response has invalid Content-Range');
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (start !== existing || end !== expectedSize - 1 || total !== expectedSize || end < start) {
    throw new Error('Resumed response range mismatch');
  }
}

export async function downloadArtifacts({
  manifest,
  dir,
  concurrency = 4,
  token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN,
  tokenHosts,
  maxTotalBytes = 10 * 1024 * 1024 * 1024,
  fetchImpl = fetch,
  allowLocalHttp = false,
}) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new Error('Download concurrency must be between 1 and 16');
  if (!Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < 1) throw new Error('maxTotalBytes must be a positive safe integer');
  if (!manifest || !Array.isArray(manifest.assets) || manifest.assets.length === 0) throw new Error('Download manifest assets must be a non-empty array');
  const allowedHosts = new Set(tokenHosts ?? DEFAULT_TOKEN_HOSTS);
  const seen = new Set();
  let declaredTotal = 0;
  for (const asset of manifest.assets) {
    if (!asset || !safeAssetName(asset.name)) throw new Error('Unsafe artifact name');
    if (seen.has(asset.name)) throw new Error('Duplicate artifact name: ' + asset.name);
    seen.add(asset.name);
    if (!Number.isSafeInteger(asset.size) || asset.size < 0) throw new Error('Invalid artifact size: ' + asset.name);
    if (!/^[0-9a-f]{64}$/i.test(String(asset.sha256 ?? ''))) throw new Error('Invalid artifact SHA-256: ' + asset.name);
    safeUrl(asset.url, allowLocalHttp);
    declaredTotal += asset.size;
    if (!Number.isSafeInteger(declaredTotal) || declaredTotal > maxTotalBytes) throw new Error('Declared total size exceeds the configured limit');
  }

  await mkdir(dir, { recursive: true });
  let cursor = 0;
  let failure;
  const worker = async () => {
    while (!failure) {
      const index = cursor;
      cursor += 1;
      if (index >= manifest.assets.length) return;
      const asset = manifest.assets[index];
      const target = path.join(dir, asset.name);
      const partial = target + '.part';
      try {
        try {
          const info = await stat(target);
          if (info.size !== asset.size || await hashFile(target) !== asset.sha256.toLowerCase()) throw new Error('Existing artifact failed verification: ' + asset.name);
          continue;
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
        let existing = 0;
        try {
          const info = await stat(partial);
          if (info.size > asset.size) throw new Error('Partial artifact exceeds expected size: ' + asset.name);
          existing = info.size;
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
        const { response } = await request(asset.url, { token, tokenHosts: allowedHosts, range: existing || undefined, fetchImpl, allowLocalHttp });
        let offset = 0;
        if (response.status === 206) {
          parseContentRange(response.headers.get('content-range'), existing, asset.size);
          offset = existing;
        } else if (response.status === 200) {
          offset = 0;
        } else {
          await response.body?.cancel();
          throw new Error(`Artifact download returned HTTP ${response.status}`);
        }
        const declaredLength = Number(response.headers.get('content-length') ?? '0');
        if (!Number.isSafeInteger(declaredLength) || declaredLength < 0 || offset + declaredLength > asset.size) throw new Error('Artifact response size exceeds its declaration');
        const handle = await open(partial, offset ? 'a' : 'w');
        let received = offset;
        try {
          for await (const chunk of response.body ?? []) {
            received += chunk.length;
            if (received > asset.size || received > maxTotalBytes) throw new Error('Downloaded size mismatch');
            await handle.write(chunk);
          }
        } finally {
          await handle.close();
        }
        if (received !== asset.size) throw new Error('Downloaded size mismatch');
        if (await hashFile(partial) !== asset.sha256.toLowerCase()) {
          await rm(partial, { force: true });
          throw new Error('Downloaded digest mismatch: ' + asset.name);
        }
        await link(partial, target);
        await rm(partial, { force: true });
      } catch (error) {
        await rm(partial, { force: true }).catch(() => {});
        if (!failure) failure = sanitize(error, token);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, manifest.assets.length) }, worker));
  if (failure) throw failure;
  return { files: manifest.assets.length, bytes: declaredTotal };
}

function argument(name) {
  const index = process.argv.indexOf('--' + name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const manifestFile = argument('manifest');
  const dir = argument('dir');
  if (!manifestFile || !dir) throw new Error('Usage: download-artifact.mjs --manifest <file> --dir <directory> [--concurrency <1-16>] [--max-total-bytes <bytes>]');
  const manifest = JSON.parse(await readFile(path.resolve(manifestFile), 'utf8'));
  const result = await downloadArtifacts({
    manifest,
    dir: path.resolve(dir),
    concurrency: argument('concurrency') === undefined ? undefined : Number(argument('concurrency')),
    maxTotalBytes: argument('max-total-bytes') === undefined ? undefined : Number(argument('max-total-bytes')),
  });
  console.log(`Verified ${result.files} artifact(s), ${result.bytes} byte(s)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}

import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { hashFile, verifyProvenanceDirectory } from './release-provenance.mjs';
import { verifyV009CoreGateEvidence } from './check-v009-core-gate.mjs';

const SHA256 = /^[0-9a-f]{64}$/i;
const COMMIT = /^[0-9a-f]{40}$/i;
const RELEASE_ID = /^\d+$/;
const MAX_ATTEMPTS = 4;

export function provenanceMarker(manifestSha256) {
  if (!SHA256.test(String(manifestSha256 ?? ''))) throw new Error('Manifest SHA-256 is invalid');
  return 'release-provenance-sha256:' + manifestSha256.toLowerCase();
}

export function expectedReleaseAssets(manifest, { manifestSize, manifestSha256, checksumsSize, checksumsSha256 }) {
  if (!manifest || !Array.isArray(manifest.assets)) throw new Error('Release manifest is invalid');
  if (!SHA256.test(String(manifestSha256 ?? '')) || !SHA256.test(String(checksumsSha256 ?? ''))) throw new Error('Control file SHA-256 is invalid');
  if (!Number.isSafeInteger(manifestSize) || manifestSize < 0 || !Number.isSafeInteger(checksumsSize) || checksumsSize < 0) throw new Error('Control file size is invalid');
  const names = new Set();
  const assets = manifest.assets.map(asset => {
    if (!asset || typeof asset.name !== 'string' || !asset.name || ['.', '..'].includes(asset.name) || /[\\/\x00-\x1f]/.test(asset.name)) throw new Error('Manifest contains an unsafe asset name');
    if (names.has(asset.name)) throw new Error('Duplicate manifest asset: ' + asset.name);
    names.add(asset.name);
    if (!Number.isSafeInteger(asset.size) || asset.size < 0 || !SHA256.test(String(asset.sha256 ?? ''))) throw new Error('Invalid manifest asset: ' + asset.name);
    return { name: asset.name, size: asset.size, sha256: String(asset.sha256).toLowerCase() };
  });
  if (names.has('RELEASE-MANIFEST.json') || names.has('SHA256SUMS.txt')) throw new Error('Manifest must not list control files as assets');
  assets.push(
    { name: 'RELEASE-MANIFEST.json', size: manifestSize, sha256: String(manifestSha256).toLowerCase() },
    { name: 'SHA256SUMS.txt', size: checksumsSize, sha256: String(checksumsSha256).toLowerCase() },
  );
  return assets;
}

function releaseIdentityErrors(release, { tag, commit }, label = 'Release') {
  const errors = [];
  if (release?.tag_name !== tag) errors.push(label + ' tag mismatch');
  if (release?.target_commitish !== commit) errors.push(label + ' target commit mismatch');
  if (release?.prerelease !== false) errors.push('Release must not be a prerelease');
  return errors;
}

export function verifyDraft(release, { tag, commit, manifestSha256, releaseId }) {
  const errors = releaseIdentityErrors(release, { tag, commit }, 'Draft');
  if (releaseId !== undefined && String(release?.id) !== String(releaseId)) errors.push('Draft Release ID mismatch');
  if (release?.draft !== true) errors.push(release?.draft === false ? 'Release is already public' : 'Release is not a Draft');
  if (manifestSha256 !== undefined) {
    const marker = provenanceMarker(manifestSha256);
    if (typeof release?.body !== 'string' || !release.body.split(/\r?\n/).includes(marker)) errors.push('Draft provenance marker mismatch');
  }
  return errors;
}

function remoteDigest(asset) {
  const value = String(asset?.digest ?? '');
  return value.startsWith('sha256:') ? value.slice(7).toLowerCase() : value.toLowerCase();
}

export function verifyAssetCompleteness(remoteAssets, expected) {
  const errors = [];
  if (!Array.isArray(remoteAssets) || !Array.isArray(expected)) return ['Release assets are invalid'];
  const remote = new Map();
  for (const asset of remoteAssets) {
    if (!asset || typeof asset.name !== 'string' || remote.has(asset.name)) {
      errors.push('Release contains an invalid or duplicate asset');
      continue;
    }
    remote.set(asset.name, asset);
  }
  const wanted = new Map();
  for (const asset of expected) {
    if (!asset || typeof asset.name !== 'string' || wanted.has(asset.name)) {
      errors.push('Expected assets contain an invalid or duplicate name');
      continue;
    }
    wanted.set(asset.name, asset);
    const actual = remote.get(asset.name);
    if (!actual) {
      errors.push('Release asset is missing: ' + asset.name);
      continue;
    }
    if (actual.size !== asset.size) errors.push('Release asset size mismatch: ' + asset.name);
    if (!SHA256.test(remoteDigest(actual))) errors.push('Release asset digest is missing: ' + asset.name);
    else if (remoteDigest(actual) !== String(asset.sha256).toLowerCase()) errors.push('Release asset digest mismatch: ' + asset.name);
  }
  for (const name of remote.keys()) if (!wanted.has(name)) errors.push('Unexpected Release asset: ' + name);
  return errors;
}

export function evaluateRelease({ release, latestTag, tag, commit, expected, releaseId, requireLatest = true }) {
  const errors = releaseIdentityErrors(release, { tag, commit });
  if (releaseId !== undefined && String(release?.id) !== String(releaseId)) errors.push('Release ID mismatch');
  const alreadyPublished = release?.draft === false;
  if (!release) return { ok: false, alreadyPublished: false, safeToPublish: false, errors: ['Release is missing'] };
  if (release.draft !== true && release.draft !== false) errors.push('Release draft state is invalid');
  errors.push(...verifyAssetCompleteness(release.assets, expected));
  if (alreadyPublished && requireLatest && release.isLatest === false) errors.push('Public Release is not marked latest');
  if (alreadyPublished && requireLatest && latestTag !== tag) errors.push('Public Release is not the latest release');
  return {
    ok: errors.length === 0,
    alreadyPublished,
    safeToPublish: release.draft === true && errors.length === 0,
    errors,
  };
}

export async function resolveReleaseVersion(root = process.cwd()) {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const versions = [pkg.version];
  try { versions.push((await readFile(path.join(root, 'VERSION'), 'utf8')).trim()); } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const contracts = await readFile(path.join(root, 'packages/contracts/src/index.ts'), 'utf8');
  const match = contracts.match(/export\s+const\s+VERSION\s*=\s*['"]([^'"]+)['"]/);
  if (!match) throw new Error('Contract VERSION constant is missing');
  versions.push(match[1]);
  if (!versions.every(version => /^\d+\.\d+\.\d+$/.test(String(version)))) throw new Error('Only stable semantic versions are allowed');
  if (!versions.every(version => version === versions[0])) throw new Error('Release version sources disagree: ' + versions.join(', '));
  return versions[0];
}

async function candidate(dir, tag, commit) {
  const manifestPath = path.join(dir, 'RELEASE-MANIFEST.json');
  const checksumsPath = path.join(dir, 'SHA256SUMS.txt');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const errors = await verifyProvenanceDirectory(dir, { tag, version: manifest.version, tagCommit: commit, skipTagCheck: true });
  if (errors.length) throw new Error(errors.join('\n'));
  const expected = expectedReleaseAssets(manifest, {
    manifestSize: (await stat(manifestPath)).size,
    manifestSha256: await hashFile(manifestPath),
    checksumsSize: (await stat(checksumsPath)).size,
    checksumsSha256: await hashFile(checksumsPath),
  });
  return { manifest, manifestSha256: await hashFile(manifestPath), expected };
}

function argument(name) {
  const index = process.argv.indexOf('--' + name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function required(name) {
  const value = argument(name);
  if (!value) throw new Error('Missing --' + name);
  return value;
}

function repository() {
  const repo = argument('repo') ?? process.env.GITHUB_REPOSITORY;
  if (!repo || !/^[^/]+\/[^/]+$/.test(repo)) throw new Error('A valid --repo or GITHUB_REPOSITORY is required');
  return repo;
}

function releaseIdArgument() {
  const value = argument('release-id');
  if (value !== undefined && !RELEASE_ID.test(value)) throw new Error('--release-id must be a numeric GitHub Release ID');
  return value;
}

function apiConfig() {
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GH_TOKEN or GITHUB_TOKEN is required');
  const base = (process.env.GH_API_URL ?? process.env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/$/, '');
  return { token, base };
}

function retryAfterSeconds(value) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, (date - Date.now()) / 1000) : 0;
}

export function retryDelayMs(attempt, retryAfterSec = 0) {
  const base = Math.min(30_000, 250 * 2 ** Math.max(0, attempt - 1));
  return Math.max(base, Math.min(120_000, retryAfterSec * 1000));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function api(route, { method = 'GET', body, headers = {}, allowNotFound = false } = {}) {
  const { token, base } = apiConfig();
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let response;
    try {
      response = await fetch(base + route, {
        method,
        headers: { authorization: 'Bearer ' + token, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...headers },
        ...(body ? { body: JSON.stringify(body), 'content-type': 'application/json' } : {}),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (error) {
      if (attempt < MAX_ATTEMPTS) { await sleep(retryDelayMs(attempt)); continue; }
      throw new Error('GitHub API network request failed' + (error instanceof Error ? ': ' + error.message : ''));
    }
    if (response.ok) return response.status === 204 ? null : response.json();
    if (allowNotFound && response.status === 404) return null;
    const retryAfter = retryAfterSeconds(response.headers.get('retry-after'));
    const rateLimited = response.status === 429 || (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0');
    const retryable = rateLimited || response.status >= 500;
    if (retryable && attempt < MAX_ATTEMPTS) { await sleep(retryDelayMs(attempt, retryAfter)); continue; }
    throw new Error(`GitHub API returned HTTP ${response.status}`);
  }
  throw new Error('GitHub API retry loop exhausted');
}

export async function listReleases(repo) {
  const releases = [];
  for (let page = 1; page <= 100; page++) {
    const batch = await api(`/repos/${repo}/releases?per_page=100&page=${page}`, { allowNotFound: page === 1 });
    if (batch === null) return releases;
    if (!Array.isArray(batch)) throw new Error('GitHub releases response is invalid');
    releases.push(...batch);
    if (batch.length < 100) return releases;
  }
  throw new Error('GitHub releases pagination exceeded 100 pages');
}

export function findReleaseByTag(releases, tag) {
  const matches = (Array.isArray(releases) ? releases : []).filter(release => release?.tag_name === tag);
  if (matches.length > 1) throw new Error(`Multiple releases found for tag ${tag}`);
  return matches[0] ?? null;
}

function assertUploadHost(url) {
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1';
  const configured = process.env.RELEASE_UPLOAD_HOST?.toLowerCase();
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new Error('Release upload URL protocol is unsafe');
  if (!loopback && url.hostname.toLowerCase() !== 'uploads.github.com' && url.hostname.toLowerCase() !== configured) throw new Error('Release upload URL host is not allowed');
}

function validateUploadUrl(release, repo) {
  if (!release?.upload_url) throw new Error('Release upload URL is missing');
  const url = new URL(release.upload_url.replace(/\{.*$/, ''));
  const expectedPath = `/repos/${repo}/releases/${release.id}/assets`;
  if (url.pathname !== expectedPath) throw new Error('Release upload URL identity mismatch');
  assertUploadHost(url);
  return url;
}

export async function verifyAnnotatedTag(repo, tag, commit) {
  const ref = await api(`/repos/${repo}/git/ref/tags/${encodeURIComponent(tag)}`, { allowNotFound: true });
  if (!ref || ref.object?.type !== 'tag') throw new Error('Annotated Tag is missing or is not a tag object');
  const object = await api(`/repos/${repo}/git/tags/${ref.object.sha}`);
  if (object.object?.type !== 'commit' || object.object.sha !== commit) throw new Error('Annotated Tag does not dereference to the frozen commit');
  return object;
}

export async function getRelease(repo, tag, releaseId) {
  if (releaseId !== undefined) {
    if (!RELEASE_ID.test(String(releaseId))) throw new Error('Release ID must be numeric');
    const release = await api(`/repos/${repo}/releases/${releaseId}`, { allowNotFound: true });
    if (!release) return null;
    if (release.tag_name !== tag) throw new Error('Release ID does not match the requested tag');
    validateUploadUrl(release, repo);
    return release;
  }
  const direct = await api(`/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, { allowNotFound: true });
  if (direct) { validateUploadUrl(direct, repo); return direct; }
  return findReleaseByTag(await listReleases(repo), tag);
}

function releaseNotes(marker) {
  return [
    '## 逆向万物候选发行',
    '',
    '此 Release 由原子发布工作流创建。仅在全部资产逐项校验名称、大小和 SHA-256 后才会公开。',
    '',
    '下载 `SHA256SUMS.txt` 后运行 `sha256sum -c SHA256SUMS.txt` 验证资产。',
    '',
    marker,
    '',
  ].join('\n');
}

function statePath(dir, tag) {
  return path.join(path.resolve(dir), '..', '.release-state', `${tag}.json`);
}

export async function loadState(dir, tag, repo, commit, manifestSha256) {
  let text;
  try { text = await readFile(statePath(dir, tag), 'utf8'); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  let state;
  try { state = JSON.parse(text); }
  catch { throw new Error(`Release resume state is corrupt: ${statePath(dir, tag)}`); }
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error(`Release resume state is corrupt: ${statePath(dir, tag)}`);
  if (state.schemaVersion !== 1 || state.repo !== repo || state.tag !== tag || state.commit !== commit || state.manifestSha256 !== manifestSha256) throw new Error('Release resume state does not match the current candidate');
  if (!RELEASE_ID.test(String(state.releaseId))) throw new Error('Release resume state has an invalid Release ID');
  return state;
}

export async function saveState(dir, state) {
  const file = statePath(dir, state.tag);
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, JSON.stringify(state, null, 2) + '\n');
  await rename(temporary, file);
}

async function withReleaseLock(dir, tag, operation) {
  const lockDir = path.join(path.resolve(dir), '..', '.release-state');
  await mkdir(lockDir, { recursive: true });
  const lock = path.join(lockDir, `${tag}.lock`);
  let handle;
  try { handle = await open(lock, 'wx'); }
  catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const info = await stat(lock);
    if (Date.now() - info.mtimeMs < 60 * 60 * 1000) throw new Error('Release operation already in progress');
    await rm(lock, { force: true });
    handle = await open(lock, 'wx');
  }
  try { await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }) + '\n'); }
  finally { await handle.close(); }
  try { return await operation(); }
  finally { await rm(lock, { force: true }); }
}

async function ensureDraft(repo, tag, commit, manifestSha256, releaseId, dir) {
  const marker = provenanceMarker(manifestSha256);
  let release = await getRelease(repo, tag, releaseId);
  if (!release) {
    try {
      release = await api(`/repos/${repo}/releases`, {
        method: 'POST',
        body: { tag_name: tag, target_commitish: commit, name: '逆向万物 ' + tag, body: releaseNotes(marker), draft: true, prerelease: false, make_latest: 'false' },
      });
    } catch (error) {
      if (!(error instanceof Error) || !error.message.endsWith('HTTP 422')) throw error;
      release = await getRelease(repo, tag, releaseId);
    }
  }
  const errors = verifyDraft(release, { tag, commit, manifestSha256, releaseId });
  if (errors.length) throw new Error(errors.join('\n'));
  validateUploadUrl(release, repo);
  if (dir) {
    const existing = await loadState(dir, tag, repo, commit, manifestSha256);
    await saveState(dir, { schemaVersion: 1, repo, tag, commit, manifestSha256, releaseId: release.id, completedAssets: existing?.completedAssets ?? [] });
  }
  return release;
}

export function releaseAssetUploadUrl(uploadUrl, name) {
  if (typeof uploadUrl !== 'string' || !/^https?:\/\//.test(uploadUrl)) throw new Error('Release upload URL is invalid');
  const url = new URL(uploadUrl.replace(/\{.*$/, ''));
  assertUploadHost(url);
  url.searchParams.set('name', name);
  return url;
}

async function findRemoteAsset(repo, releaseId, name) {
  const release = await api(`/repos/${repo}/releases/${releaseId}`);
  return release.assets?.find(asset => asset.name === name) ?? null;
}

export async function uploadAsset(repo, release, name, file, token, expected) {
  validateUploadUrl(release, repo);
  const info = await stat(file);
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let response;
    try {
      response = await fetch(releaseAssetUploadUrl(release.upload_url, name), {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + token,
          accept: 'application/vnd.github+json',
          'content-type': 'application/octet-stream',
          'content-length': String(info.size),
          'x-github-api-version': '2022-11-28',
        },
        body: createReadStream(file),
        duplex: 'half',
        signal: AbortSignal.timeout(120_000),
      });
    } catch {
      if (attempt < MAX_ATTEMPTS) { await sleep(retryDelayMs(attempt)); continue; }
      throw new Error(`Release asset upload failed for ${name}: network error`);
    }
    if (response.ok) return response.json();
    const retryAfter = retryAfterSeconds(response.headers.get('retry-after'));
    const rateLimited = response.status === 429 || (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0');
    if ((rateLimited || response.status >= 500) && attempt < MAX_ATTEMPTS) { await sleep(retryDelayMs(attempt, retryAfter)); continue; }
    if (response.status === 422 && expected) {
      const existing = await findRemoteAsset(repo, release.id, name);
      if (existing && verifyAssetCompleteness([existing], [expected]).length === 0) return existing;
    }
    throw new Error(`Release asset upload failed for ${name}: HTTP ${response.status}`);
  }
  throw new Error(`Release asset upload retry loop exhausted for ${name}`);
}

async function verifyPublicRelease(repo, release, tag, commit, expected, releaseId, requireLatest = true) {
  const latest = await api(`/repos/${repo}/releases/latest`);
  const state = evaluateRelease({ release: { ...release, isLatest: latest.tag_name === tag }, latestTag: latest.tag_name, tag, commit, expected, releaseId, requireLatest });
  if (!state.ok) throw new Error(state.errors.join('\n'));
  await verifyPublicAddress(release);
  return state;
}

async function upload(repo, tag, dir, commit, manifestSha256, expected, requestedReleaseId) {
  const state = await loadState(dir, tag, repo, commit, manifestSha256);
  const releaseId = requestedReleaseId ?? state?.releaseId;
  let release = await getRelease(repo, tag, releaseId);
  if (release?.draft === false) {
    await verifyPublicRelease(repo, release, tag, commit, expected, releaseId);
    return release;
  }
  release = await ensureDraft(repo, tag, commit, manifestSha256, releaseId, dir);
  const remote = new Map((release.assets ?? []).map(asset => [asset.name, asset]));
  for (const name of remote.keys()) if (!expected.some(asset => asset.name === name)) throw new Error('Refusing to add assets to a Draft containing unexpected asset: ' + name);
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  const completed = new Set(state?.completedAssets ?? []);
  for (const asset of expected) {
    const existing = remote.get(asset.name);
    if (existing) {
      const errors = verifyAssetCompleteness([existing], [asset]);
      if (errors.length) throw new Error('Refusing to overwrite existing Release asset: ' + asset.name + '\n' + errors.join('\n'));
      completed.add(asset.name);
      continue;
    }
    await uploadAsset(repo, release, asset.name, path.join(dir, asset.name), token, asset);
    completed.add(asset.name);
    await saveState(dir, { schemaVersion: 1, repo, tag, commit, manifestSha256, releaseId: release.id, completedAssets: [...completed] });
  }
  const uploaded = await getRelease(repo, tag, release.id);
  const errors = verifyAssetCompleteness(uploaded.assets, expected);
  if (errors.length) throw new Error(errors.join('\n'));
  await saveState(dir, { schemaVersion: 1, repo, tag, commit, manifestSha256, releaseId: release.id, completedAssets: expected.map(asset => asset.name) });
  return uploaded;
}

async function verifyPublicAddress(release) {
  const page = await fetch(release.html_url, { redirect: 'follow', signal: AbortSignal.timeout(30_000) });
  if (!page.ok) throw new Error('Public Release address verification failed');
  await page.body?.cancel();
}

async function downloadAsset(url, file) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let response;
    try {
      response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120_000) });
    } catch {
      if (attempt < MAX_ATTEMPTS) { await sleep(retryDelayMs(attempt)); continue; }
      throw new Error('Public asset download failed: network error');
    }
    if (response.ok && response.body) {
      await pipeline(response.body, createWriteStream(file));
      return;
    }
    const retryAfter = retryAfterSeconds(response.headers.get('retry-after'));
    if ((response.status === 429 || response.status >= 500) && attempt < MAX_ATTEMPTS) { await sleep(retryDelayMs(attempt, retryAfter)); continue; }
    throw new Error(`Public asset download failed: HTTP ${response.status}`);
  }
  throw new Error('Public asset download retry loop exhausted');
}

export async function verifyPublicAssets(release, expected) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 're-release-verify-'));
  try {
    const remote = new Map((release.assets ?? []).map(asset => [asset.name, asset]));
    for (const asset of expected) {
      const actual = remote.get(asset.name);
      if (!actual) throw new Error('Public Release asset is missing: ' + asset.name);
      const file = path.join(dir, asset.name);
      await downloadAsset(actual.browser_download_url ?? actual.url, file);
      const info = await stat(file);
      if (info.size !== asset.size) throw new Error('Public asset size mismatch: ' + asset.name);
      if (await hashFile(file) !== asset.sha256) throw new Error('Public asset digest mismatch: ' + asset.name);
    }
    const checksums = await readFile(path.join(dir, 'SHA256SUMS.txt'), 'utf8');
    const entries = new Map(checksums.trim().split(/\r?\n/).map(line => {
      const match = line.match(/^([0-9a-f]{64})  (.+)$/i);
      if (!match) throw new Error('Invalid SHA256SUMS line');
      return [match[2], match[1].toLowerCase()];
    }));
    for (const asset of expected) {
      if (asset.name === 'SHA256SUMS.txt') continue;
      if (entries.get(asset.name) !== asset.sha256) throw new Error('SHA256SUMS mismatch: ' + asset.name);
    }
    return { verified: expected.length };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function publish(repo, tag, dir, commit, requestedReleaseId, coreGate) {
  if (tag === 'v0.0.9') {
    if (!coreGate?.report || !coreGate?.evidenceDir) throw new Error('v0.0.9 publish requires --core-gate-report and --core-gate-evidence-dir');
    const report = JSON.parse(await readFile(path.resolve(coreGate.report), 'utf8'));
    if (report.commit !== commit) throw new Error('v0.0.9 core acceptance commit does not match the release commit');
    const errors = await verifyV009CoreGateEvidence(report, path.resolve(coreGate.evidenceDir));
    if (errors.length) throw new Error('v0.0.9 core gate failed:\n- ' + errors.join('\n- '));
  }
  const { manifest, manifestSha256, expected } = await candidate(dir, tag, commit);
  const state = await loadState(dir, tag, repo, commit, manifestSha256);
  const releaseId = requestedReleaseId ?? state?.releaseId;
  let release = await getRelease(repo, tag, releaseId);
  if (!release) throw new Error('Draft Release is missing');
  if (release.draft === false) {
    await verifyPublicRelease(repo, release, tag, commit, expected, releaseId);
    console.log('Public Release already verified: ' + tag + ' (' + manifest.version + ')');
    return;
  }
  const draftErrors = verifyDraft(release, { tag, commit, manifestSha256, releaseId });
  draftErrors.push(...verifyAssetCompleteness(release.assets, expected));
  if (draftErrors.length) throw new Error(draftErrors.join('\n'));
  release = await api(`/repos/${repo}/releases/${release.id}`, { method: 'PATCH', body: { draft: false, prerelease: false, make_latest: 'true' } });
  try {
    const latest = await api(`/repos/${repo}/releases/latest`);
    const stateValue = evaluateRelease({ release: { ...release, isLatest: latest.tag_name === tag }, latestTag: latest.tag_name, tag, commit, expected, releaseId: release.id });
    if (!stateValue.ok) throw new Error(stateValue.errors.join('\n'));
    await verifyPublicAddress(release);
  } catch (error) {
    throw new Error('Release was published but post-publish verification failed; do not re-publish or move the Tag. Inspect Release ID ' + release.id + ': ' + (error instanceof Error ? error.message : String(error)));
  }
  console.log('Public Release verified: ' + tag + ' (' + manifest.version + ')');
}

async function pruneStaleDrafts(repo, tag, dir, commit, confirmed) {
  const { manifestSha256 } = await candidate(dir, tag, commit);
  const marker = provenanceMarker(manifestSha256);
  const releases = await listReleases(repo);
  const target = findReleaseByTag(releases, tag);
  const stale = releases.filter(release => release?.draft === true && (release.assets?.length ?? 0) === 0 && release.id !== target?.id && /^untagged-/.test(release.tag_name ?? '') && typeof release.body === 'string' && release.body.split(/\r?\n/).includes(marker));
  if (!stale.length) { console.log('No matching stale Draft releases'); return; }
  if (!confirmed) throw new Error('Refusing to prune stale Drafts without --confirm-prune: ' + stale.map(release => release.id).join(', '));
  for (const release of stale) await api(`/repos/${repo}/releases/${release.id}`, { method: 'DELETE' });
  console.log('Pruned stale Draft releases: ' + stale.map(release => release.id).join(', '));
}

async function main() {
  const command = process.argv[2];
  if (command === 'version') {
    console.log(await resolveReleaseVersion(argument('root') ?? process.cwd()));
    return;
  }
  if (!['ensure-draft', 'upload', 'verify-draft', 'verify-public', 'publish', 'prune-stale-drafts'].includes(command)) {
    throw new Error('Usage: release-atomic.mjs <version|ensure-draft|upload|verify-draft|verify-public|publish|prune-stale-drafts> --dir <directory> --tag <tag> --commit <sha> [--repo owner/repo] [--release-id <id>] [--core-gate-report <acceptance.json> --core-gate-evidence-dir <directory>]');
  }
  const dir = path.resolve(required('dir'));
  const tag = required('tag');
  const commit = required('commit');
  if (!COMMIT.test(commit)) throw new Error('commit must be a full SHA-1');
  const repo = repository();
  const releaseId = releaseIdArgument();
  return withReleaseLock(dir, tag, async () => {
  await verifyAnnotatedTag(repo, tag, commit);
  const { manifestSha256, expected } = await candidate(dir, tag, commit);
  if (command === 'ensure-draft') {
    const release = await getRelease(repo, tag, releaseId);
    if (release?.draft === false) {
      await verifyPublicRelease(repo, release, tag, commit, expected, releaseId);
      console.log('Public Release already verified: ' + tag);
    } else {
      const draft = await ensureDraft(repo, tag, commit, manifestSha256, releaseId, dir);
      console.log('Draft Release verified: ' + tag);
      console.log('Release ID: ' + draft.id);
    }
  } else if (command === 'upload') {
    await upload(repo, tag, dir, commit, manifestSha256, expected, releaseId);
    console.log('Draft assets verified: ' + expected.length);
  } else if (command === 'verify-draft') {
    let release = await getRelease(repo, tag, releaseId);
    if (release?.draft === false) {
      await verifyPublicRelease(repo, release, tag, commit, expected, releaseId);
      console.log('Public assets already verified: ' + expected.length);
    } else {
      release = await ensureDraft(repo, tag, commit, manifestSha256, releaseId, dir);
      const errors = verifyAssetCompleteness(release.assets, expected);
      if (errors.length) throw new Error(errors.join('\n'));
      console.log('Draft assets verified: ' + expected.length);
    }
  } else if (command === 'verify-public') {
    const release = await getRelease(repo, tag, releaseId);
    if (!release || release.draft !== false) throw new Error('Public Release is missing or still a Draft');
    await verifyPublicRelease(repo, release, tag, commit, expected, releaseId, false);
    const result = await verifyPublicAssets(release, expected);
    console.log('Public assets downloaded and verified: ' + result.verified);
  } else if (command === 'prune-stale-drafts') {
    await pruneStaleDrafts(repo, tag, dir, commit, process.argv.includes('--confirm-prune'));
  } else {
    await publish(repo, tag, dir, commit, releaseId, { report: argument('core-gate-report'), evidenceDir: argument('core-gate-evidence-dir') });
  }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}

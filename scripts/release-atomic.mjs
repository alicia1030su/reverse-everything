import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashFile, verifyProvenanceDirectory } from './release-provenance.mjs';

const SHA256 = /^[0-9a-f]{64}$/i;
const COMMIT = /^[0-9a-f]{40}$/i;

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

export function verifyDraft(release, { tag, commit, manifestSha256 }) {
  const errors = releaseIdentityErrors(release, { tag, commit }, 'Draft');
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

export function evaluateRelease({ release, latestTag, tag, commit, expected }) {
  const errors = releaseIdentityErrors(release, { tag, commit });
  const alreadyPublished = release?.draft === false;
  if (!release) return { ok: false, alreadyPublished: false, safeToPublish: false, errors: ['Release is missing'] };
  if (release.draft !== true && release.draft !== false) errors.push('Release draft state is invalid');
  errors.push(...verifyAssetCompleteness(release.assets, expected));
  if (alreadyPublished && release.isLatest === false) errors.push('Public Release is not marked latest');
  if (alreadyPublished && latestTag !== tag) errors.push('Public Release is not the latest release');
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

function apiConfig() {
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GH_TOKEN or GITHUB_TOKEN is required');
  const base = (process.env.GH_API_URL ?? process.env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/$/, '');
  return { token, base };
}

async function api(route, { method = 'GET', body } = {}) {
  const { token, base } = apiConfig();
  const response = await fetch(base + route, {
    method,
    headers: { authorization: 'Bearer ' + token, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error(`GitHub API returned HTTP ${response.status}`);
  return response.status === 204 ? null : response.json();
}

export function findReleaseByTag(releases, tag) {
  const matches = (Array.isArray(releases) ? releases : []).filter(release => release?.tag_name === tag);
  if (matches.length > 1) throw new Error(`Multiple releases found for tag ${tag}`);
  return matches[0] ?? null;
}

async function getRelease(repo, tag) {
  try { return await api(`/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`); } catch (error) {
    if (!(error instanceof Error) || error.message !== 'GitHub API returned HTTP 404') throw error;
    const releases = await api(`/repos/${repo}/releases?per_page=100`);
    return findReleaseByTag(releases, tag);
  }
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

async function ensureDraft(repo, tag, commit, manifestSha256) {
  const marker = provenanceMarker(manifestSha256);
  let release = await getRelease(repo, tag);
  if (!release) {
    try {
      release = await api(`/repos/${repo}/releases`, {
        method: 'POST',
        body: { tag_name: tag, target_commitish: commit, name: '逆向万物 ' + tag, body: releaseNotes(marker), draft: true, prerelease: false, make_latest: 'false' },
      });
    } catch (error) {
      if (!(error instanceof Error) || !error.message.endsWith('HTTP 422')) throw error;
      release = await getRelease(repo, tag);
    }
  }
  const errors = verifyDraft(release, { tag, commit, manifestSha256 });
  if (errors.length) throw new Error(errors.join('\n'));
  return release;
}

export function releaseAssetUploadUrl(uploadUrl, name) {
  if (typeof uploadUrl !== 'string' || !/^https?:\/\//.test(uploadUrl)) throw new Error('Release upload URL is invalid');
  const url = new URL(uploadUrl.replace(/\{.*$/, ''));
  url.searchParams.set('name', name);
  return url;
}

async function uploadAsset(release, name, file, token) {
  const info = await stat(file);
  const response = await fetch(releaseAssetUploadUrl(release.upload_url, name), {
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
  });
  if (!response.ok) throw new Error(`Release asset upload failed for ${name}: HTTP ${response.status}`);
  return response.json();
}

async function verifyPublicRelease(repo, release, tag, commit, expected) {
  const latest = await api(`/repos/${repo}/releases/latest`);
  const state = evaluateRelease({ release: { ...release, isLatest: latest.tag_name === tag }, latestTag: latest.tag_name, tag, commit, expected });
  if (!state.ok) throw new Error(state.errors.join('\n'));
  await verifyPublicAddress(release);
  return state;
}

async function upload(repo, tag, dir, commit, manifestSha256, expected) {
  let release = await getRelease(repo, tag);
  if (release?.draft === false) {
    await verifyPublicRelease(repo, release, tag, commit, expected);
    return release;
  }
  const draft = await ensureDraft(repo, tag, commit, manifestSha256);
  release = draft;
  const remote = new Map((release.assets ?? []).map(asset => [asset.name, asset]));
  for (const name of remote.keys()) if (!expected.some(asset => asset.name === name)) throw new Error('Refusing to add assets to a Draft containing unexpected asset: ' + name);
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  for (const asset of expected) {
    const existing = remote.get(asset.name);
    if (existing) {
      const errors = verifyAssetCompleteness([existing], [asset]);
      if (errors.length) throw new Error('Refusing to overwrite existing Release asset: ' + asset.name + '\n' + errors.join('\n'));
      continue;
    }
    await uploadAsset(release, asset.name, path.join(dir, asset.name), token);
  }
  const uploaded = await getRelease(repo, tag);
  const errors = verifyAssetCompleteness(uploaded.assets, expected);
  if (errors.length) throw new Error(errors.join('\n'));
  return uploaded;
}

async function verifyPublicAddress(release) {
  const page = await fetch(release.html_url, { redirect: 'follow' });
  if (!page.ok) throw new Error('Public Release address verification failed');
  await page.body?.cancel();
}

async function publish(repo, tag, dir, commit) {
  const { manifest, manifestSha256, expected } = await candidate(dir, tag, commit);
  let release = await getRelease(repo, tag);
  if (!release) throw new Error('Draft Release is missing');
  if (release.draft === false) {
    await verifyPublicRelease(repo, release, tag, commit, expected);
    console.log('Public Release already verified: ' + tag + ' (' + manifest.version + ')');
    return;
  } else {
    const draftErrors = verifyDraft(release, { tag, commit, manifestSha256 });
    draftErrors.push(...verifyAssetCompleteness(release.assets, expected));
    if (draftErrors.length) throw new Error(draftErrors.join('\n'));
    release = await api(`/repos/${repo}/releases/${release.id}`, { method: 'PATCH', body: { draft: false, prerelease: false, make_latest: 'true' } });
    try {
      const latest = await api(`/repos/${repo}/releases/latest`);
      const state = evaluateRelease({ release: { ...release, isLatest: latest.tag_name === tag }, latestTag: latest.tag_name, tag, commit, expected });
      if (!state.ok) throw new Error(state.errors.join('\n'));
      await verifyPublicAddress(release);
    } catch (error) {
      try {
        await api(`/repos/${repo}/releases/${release.id}`, { method: 'PATCH', body: { draft: true, prerelease: false, make_latest: 'false' } });
      } catch {
        throw new Error((error instanceof Error ? error.message : String(error)) + '; Draft rollback also failed');
      }
      throw error;
    }
  }
  console.log('Public Release verified: ' + tag + ' (' + manifest.version + ')');
}

async function main() {
  const command = process.argv[2];
  if (command === 'version') {
    console.log(await resolveReleaseVersion(argument('root') ?? process.cwd()));
    return;
  }
  if (!['ensure-draft', 'upload', 'verify-draft', 'publish'].includes(command)) {
    throw new Error('Usage: release-atomic.mjs <version|ensure-draft|upload|verify-draft|publish> --dir <directory> --tag <tag> --commit <sha> [--repo owner/repo]');
  }
  const dir = path.resolve(required('dir'));
  const tag = required('tag');
  const commit = required('commit');
  if (!COMMIT.test(commit)) throw new Error('commit must be a full SHA-1');
  const repo = repository();
  const { manifestSha256, expected } = await candidate(dir, tag, commit);
  if (command === 'ensure-draft') {
    const release = await getRelease(repo, tag);
    if (release?.draft === false) {
      await verifyPublicRelease(repo, release, tag, commit, expected);
      console.log('Public Release already verified: ' + tag);
    } else {
      await ensureDraft(repo, tag, commit, manifestSha256);
      console.log('Draft Release verified: ' + tag);
    }
  } else if (command === 'upload') {
    await upload(repo, tag, dir, commit, manifestSha256, expected);
    console.log('Draft assets verified: ' + expected.length);
  } else if (command === 'verify-draft') {
    let release = await getRelease(repo, tag);
    if (release?.draft === false) {
      await verifyPublicRelease(repo, release, tag, commit, expected);
      console.log('Public assets already verified: ' + expected.length);
    } else {
      release = await ensureDraft(repo, tag, commit, manifestSha256);
      const errors = verifyAssetCompleteness(release.assets, expected);
      if (errors.length) throw new Error(errors.join('\n'));
      console.log('Draft assets verified: ' + expected.length);
    }
  } else {
    await publish(repo, tag, dir, commit);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}

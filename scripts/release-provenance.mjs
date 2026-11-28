import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROVENANCE_SCHEMA_VERSION = 1;
const controlFiles = new Set(['RELEASE-MANIFEST.json', 'SHA256SUMS.txt']);

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export function isCommit(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value);
}

export function isAssetName(value) {
  return typeof value === 'string' && value.length > 0 && value !== '.' && value !== '..' && !/[\\/\x00-\x1f]/.test(value);
}

export function parseChecksums(text) {
  const entries = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = line.match(/^([0-9a-f]{64})  (.+)$/i);
    if (!match) throw new Error('Invalid SHA256SUMS line');
    if (entries.has(match[2])) throw new Error('Duplicate SHA256SUMS entry: ' + match[2]);
    entries.set(match[2], match[1].toLowerCase());
  }
  return entries;
}

export function verifyProvenance({ manifest, buildInfo, acceptance, assets, tagCommit, expectedTag, expectedVersion, checksums, manifestSha256 }) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object') return ['Manifest is missing or invalid'];
  if (!buildInfo || typeof buildInfo !== 'object') errors.push('BUILD-INFO.json is missing or invalid');
  if (manifest.schemaVersion !== PROVENANCE_SCHEMA_VERSION) errors.push('Unsupported manifest schemaVersion');
  if (buildInfo?.schemaVersion !== PROVENANCE_SCHEMA_VERSION) errors.push('Unsupported BUILD-INFO schemaVersion');
  if (!isCommit(manifest.commit)) errors.push('Manifest commit must be a full SHA-1');
  if (!isCommit(buildInfo?.commit)) errors.push('BUILD-INFO commit must be a full SHA-1');
  if (manifest.commit !== buildInfo?.commit) errors.push('Manifest and BUILD-INFO commits differ');
  if (manifest.acceptance !== 'ACCEPTANCE.json') errors.push('Manifest acceptance reference is invalid');
  if (!acceptance || typeof acceptance !== 'object') errors.push('ACCEPTANCE.json is missing or invalid');
  if (acceptance?.accepted !== true) errors.push('Acceptance evidence is not accepted');
  if (!isCommit(acceptance?.commit)) errors.push('Acceptance commit must be a full SHA-1');
  if (acceptance?.version !== manifest.version) errors.push('Acceptance and manifest versions differ');
  if (acceptance?.commit !== buildInfo?.commit) errors.push('Acceptance and BUILD-INFO commits differ');
  if (!Array.isArray(acceptance?.checks) || acceptance.checks.length === 0) errors.push('Acceptance checks must be a non-empty array');
  if (!isCommit(tagCommit)) errors.push('Tag commit must be a full SHA-1');
  if (tagCommit !== manifest.commit) errors.push('Tag dereference does not match manifest commit');
  if (expectedTag && manifest.tag !== expectedTag) errors.push('Manifest tag does not match expected tag');
  if (expectedVersion && manifest.version !== expectedVersion) errors.push('Manifest version does not match expected version');
  if (buildInfo && manifest.version !== buildInfo.version) errors.push('Manifest and BUILD-INFO versions differ');
  if (manifest.tag !== 'v' + manifest.version) errors.push('Manifest tag must equal v<version>');
  if (!/^\d+\.\d+\.\d+$/.test(String(manifest.version ?? ''))) errors.push('Only stable semantic versions are allowed');

  const listed = new Map();
  if (!Array.isArray(manifest.assets) || manifest.assets.length === 0) {
    errors.push('Manifest assets must be a non-empty array');
  } else {
    for (const asset of manifest.assets) {
      if (!asset || !isAssetName(asset.name)) {
        errors.push('Manifest contains an unsafe asset name');
        continue;
      }
      if (listed.has(asset.name)) {
        errors.push('Duplicate manifest asset: ' + asset.name);
        continue;
      }
      listed.set(asset.name, asset);
      if (!Number.isInteger(asset.size) || asset.size < 0) errors.push('Invalid asset size: ' + asset.name);
      if (!/^[0-9a-f]{64}$/i.test(String(asset.sha256 ?? ''))) errors.push('Invalid asset SHA-256: ' + asset.name);
    }
  }

  const actual = new Map();
  for (const asset of assets ?? []) {
    if (!asset || !isAssetName(asset.name)) {
      errors.push('Candidate contains an unsafe asset name');
      continue;
    }
    actual.set(asset.name, asset);
    const expected = listed.get(asset.name);
    if (!expected) {
      errors.push('Asset is not listed in manifest: ' + asset.name);
      continue;
    }
    if (expected.size !== asset.size) errors.push('Asset size mismatch: ' + asset.name);
    if (String(expected.sha256).toLowerCase() !== String(asset.sha256).toLowerCase()) errors.push('Asset SHA-256 mismatch: ' + asset.name);
  }
  for (const name of listed.keys()) if (!actual.has(name)) errors.push('Manifest asset is missing: ' + name);

  if (checksums !== undefined) {
    let entries;
    try {
      entries = parseChecksums(checksums);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    if (entries) {
      for (const [name, digest] of entries) {
        const asset = actual.get(name);
        const actualDigest = name === 'RELEASE-MANIFEST.json' ? manifestSha256 : asset?.sha256;
        if (!actualDigest) errors.push('Checksum asset is missing: ' + name);
        else if (actualDigest.toLowerCase() !== digest) errors.push('Checksum mismatch: ' + name);
      }
      for (const name of actual.keys()) if (!entries.has(name)) errors.push('Asset missing from SHA256SUMS: ' + name);
    }
  }
  return errors;
}

export async function collectAssets(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const assets = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || controlFiles.has(entry.name)) continue;
    const file = path.join(dir, entry.name);
    const info = await stat(file);
    assets.push({ name: entry.name, size: info.size, sha256: await hashFile(file) });
  }
  return assets;
}

async function installedVersion(name) {
  try {
    const pkg = JSON.parse(await readFile(path.join('node_modules', name, 'package.json'), 'utf8'));
    return pkg.version;
  } catch {
    try {
      const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
      return lock.packages?.[`node_modules/${name}`]?.version ?? 'unavailable';
    } catch {
      return 'unavailable';
    }
  }
}

export async function generateProvenance(dir, { commit, ref, version, runId, acceptance, tag = 'v' + version }) {
  if (!isCommit(commit)) throw new Error('commit must be a full SHA-1');
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Only stable semantic versions are allowed');
  if (!acceptance || acceptance.accepted !== true || acceptance.commit !== commit || acceptance.version !== version) {
    throw new Error('Acceptance must be accepted at the frozen commit and version');
  }
  if (!Array.isArray(acceptance.checks) || acceptance.checks.length === 0) throw new Error('Acceptance checks are required');
  await mkdir(dir, { recursive: true });
  const buildInfo = {
    schemaVersion: PROVENANCE_SCHEMA_VERSION,
    product: 'reverse-everything',
    version,
    commit,
    ref,
    workflowRunId: String(runId ?? ''),
    builtAt: new Date().toISOString(),
    node: process.version,
    npm: execFileSync('npm', ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' }).trim(),
    platform: process.platform + '-' + process.arch,
    toolchain: {
      typescript: await installedVersion('typescript'),
      electron: await installedVersion('electron'),
      electronBuilder: await installedVersion('electron-builder'),
      playwright: await installedVersion('@playwright/test'),
      vitest: await installedVersion('vitest'),
    },
  };
  await writeFile(path.join(dir, 'BUILD-INFO.json'), JSON.stringify(buildInfo, null, 2) + '\n');
  const acceptanceEvidence = {
    schemaVersion: PROVENANCE_SCHEMA_VERSION,
    accepted: true,
    commit,
    version,
    runId: String(acceptance.runId ?? runId ?? ''),
    checks: acceptance.checks,
  };
  await writeFile(path.join(dir, 'ACCEPTANCE.json'), JSON.stringify(acceptanceEvidence, null, 2) + '\n');
  const assets = await collectAssets(dir);
  const manifest = {
    schemaVersion: PROVENANCE_SCHEMA_VERSION,
    product: 'reverse-everything',
    version,
    tag,
    commit,
    ref,
    generatedAt: new Date().toISOString(),
    buildInfo: 'BUILD-INFO.json',
    acceptance: 'ACCEPTANCE.json',
    assets,
  };
  await writeFile(path.join(dir, 'RELEASE-MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n');
  const checksumAssets = await collectAssets(dir);
  checksumAssets.push({ name: 'RELEASE-MANIFEST.json', size: (await stat(path.join(dir, 'RELEASE-MANIFEST.json'))).size, sha256: await hashFile(path.join(dir, 'RELEASE-MANIFEST.json')) });
  checksumAssets.sort((a, b) => a.name.localeCompare(b.name));
  await writeFile(path.join(dir, 'SHA256SUMS.txt'), checksumAssets.map(asset => asset.sha256 + '  ' + asset.name).join('\n') + '\n');
  return { buildInfo, manifest };
}

export function resolveTagCommit(tag) {
  return execFileSync('git', ['rev-parse', tag + '^{commit}'], { encoding: 'utf8' }).trim();
}

export async function verifyProvenanceDirectory(dir, { tag, version, tagCommit, skipTagCheck = false }) {
  const manifest = JSON.parse(await readFile(path.join(dir, 'RELEASE-MANIFEST.json'), 'utf8'));
  const buildInfo = JSON.parse(await readFile(path.join(dir, 'BUILD-INFO.json'), 'utf8'));
  let acceptance;
  try {
    acceptance = JSON.parse(await readFile(path.join(dir, 'ACCEPTANCE.json'), 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const assets = await collectAssets(dir);
  const checksums = await readFile(path.join(dir, 'SHA256SUMS.txt'), 'utf8');
  const resolvedTagCommit = skipTagCheck ? tagCommit : resolveTagCommit(tag);
  return verifyProvenance({ manifest, buildInfo, acceptance, assets, tagCommit: resolvedTagCommit, expectedTag: tag, expectedVersion: version, checksums, manifestSha256: await hashFile(path.join(dir, 'RELEASE-MANIFEST.json')) });
}

function argument(name) {
  const index = process.argv.indexOf('--' + name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function argumentValues(name) {
  const values = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === '--' + name && process.argv[index + 1]) values.push(process.argv[index + 1]);
  }
  return values;
}

async function main() {
  const command = process.argv[2];
  const dir = path.resolve(argument('dir') ?? 'dist/release');
  if (command === 'generate') {
    const commit = argument('commit');
    const version = argument('version');
    if (!commit || !version) throw new Error('generate requires --commit and --version');
    const result = await generateProvenance(dir, {
      commit,
      ref: argument('ref') ?? '',
      version,
      runId: argument('run-id'),
      tag: argument('tag') ?? 'v' + version,
      acceptance: { accepted: true, status: 'PASSED', commit, version, runId: argument('acceptance-run-id') ?? argument('run-id'), checks: argumentValues('check') },
    });
    console.log('Generated provenance for ' + result.manifest.tag + ' at ' + result.manifest.commit);
    return;
  }
  if (command === 'verify') {
    const tag = argument('tag');
    const version = argument('version');
    if (!tag || !version) throw new Error('verify requires --tag and --version');
    const errors = await verifyProvenanceDirectory(dir, { tag, version, tagCommit: argument('tag-commit'), skipTagCheck: process.argv.includes('--skip-tag-check') });
    if (errors.length) throw new Error(errors.join('\n'));
    console.log('Provenance verified: ' + tag + ' (' + version + ')');
    return;
  }
  throw new Error('Usage: release-provenance.mjs <generate|verify> --dir <directory> --tag <tag> --version <version>');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

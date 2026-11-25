import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error JavaScript release utility is exercised directly.
import { generateProvenance, verifyProvenanceDirectory } from '../../scripts/release-provenance.mjs';

const commit = 'a'.repeat(40);
const otherCommit = 'b'.repeat(40);
const dirs: string[] = [];
async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 're-provenance-'));
  dirs.push(dir);
  await writeFile(path.join(dir, 'asset.txt'), 'candidate');
  await generateProvenance(dir, { commit, ref: 'refs/heads/main', version: '0.0.3', runId: '1', acceptance: { accepted: true, commit, version: '0.0.3', runId: '1', checks: ['candidate-assets'] } });
  return dir;
}
async function verify(dir: string, tagCommit = commit) {
  return verifyProvenanceDirectory(dir, { tag: 'v0.0.3', version: '0.0.3', tagCommit, skipTagCheck: true });
}
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('release provenance', () => {
  it('accepts a complete candidate with matching commit, assets and checksums', async () => {
    const dir = await fixture();
    expect(await verify(dir)).toEqual([]);
    const manifest = JSON.parse(await readFile(path.join(dir, 'RELEASE-MANIFEST.json'), 'utf8'));
    expect(manifest.commit).toBe(commit);
    expect(manifest.assets.map((asset: { name: string }) => asset.name).sort()).toEqual(['ACCEPTANCE.json', 'BUILD-INFO.json', 'asset.txt']);
  });

  it('regenerates provenance idempotently for a retried acceptance', async () => {
    const dir = await fixture();
    await generateProvenance(dir, { commit, ref: 'refs/heads/main', version: '0.0.3', runId: '1', acceptance: { accepted: true, commit, version: '0.0.3', runId: '1', checks: ['candidate-assets'] } });
    expect(await verify(dir)).toEqual([]);
    const manifest = JSON.parse(await readFile(path.join(dir, 'RELEASE-MANIFEST.json'), 'utf8'));
    expect(new Set(manifest.assets.map((asset: { name: string }) => asset.name)).size).toBe(manifest.assets.length);
  });

  it('rejects manifest and BUILD-INFO commit mismatch', async () => {
    const dir = await fixture();
    const file = path.join(dir, 'BUILD-INFO.json');
    const buildInfo = JSON.parse(await readFile(file, 'utf8'));
    buildInfo.commit = otherCommit;
    await writeFile(file, JSON.stringify(buildInfo, null, 2) + '\n');
    expect(await verify(dir)).toContain('Manifest and BUILD-INFO commits differ');
  });

  it('rejects a tampered asset digest', async () => {
    const dir = await fixture();
    await writeFile(path.join(dir, 'asset.txt'), 'tampered');
    const errors = await verify(dir);
    expect(errors).toContain('Asset SHA-256 mismatch: asset.txt');
    expect(errors).toContain('Checksum mismatch: asset.txt');
  });

  it('requires acceptance at the same frozen commit as Tag and Build', async () => {
    const dir = await fixture();
    const file = path.join(dir, 'ACCEPTANCE.json');
    const acceptance = JSON.parse(await readFile(file, 'utf8'));
    acceptance.commit = otherCommit;
    await writeFile(file, JSON.stringify(acceptance, null, 2) + '\n');
    expect(await verify(dir)).toContain('Acceptance and BUILD-INFO commits differ');
  });

  it('rejects missing or unaccepted independent acceptance evidence', async () => {
    const dir = await fixture();
    await rm(path.join(dir, 'ACCEPTANCE.json'));
    expect(await verify(dir)).toContain('ACCEPTANCE.json is missing or invalid');
    await writeFile(path.join(dir, 'ACCEPTANCE.json'), JSON.stringify({ accepted: false, commit, version: '0.0.3' }) + '\n');
    expect(await verify(dir)).toContain('Acceptance evidence is not accepted');
  });

  it('rejects tag dereference mismatch and exits nonzero from the CLI', async () => {
    const dir = await fixture();
    expect(await verify(dir, otherCommit)).toContain('Tag dereference does not match manifest commit');
    const result = spawnSync(process.execPath, ['scripts/release-provenance.mjs', 'verify', '--dir', dir, '--tag', 'v0.0.3', '--version', '0.0.3', '--tag-commit', otherCommit, '--skip-tag-check'], { encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Tag dereference does not match manifest commit');
  });
});

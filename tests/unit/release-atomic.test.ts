import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
// @ts-expect-error JavaScript release utility is exercised directly.
import { evaluateRelease, expectedReleaseAssets, findReleaseByTag, provenanceMarker, releaseAssetUploadUrl, verifyAssetCompleteness, verifyDraft } from '../../scripts/release-atomic.mjs';

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

  it('builds asset upload URLs from the Draft release identity instead of the tag endpoint', () => {
    const uploadUrl = 'https://uploads.github.com/repos/acme/product/releases/42/assets{?name,label}';
    const url = releaseAssetUploadUrl(uploadUrl, 'asset file.bin');
    expect(url.origin).toBe('https://uploads.github.com');
    expect(url.pathname).toBe('/repos/acme/product/releases/42/assets');
    expect(url.searchParams.get('name')).toBe('asset file.bin');
    expect(() => releaseAssetUploadUrl('not-a-url', 'asset.bin')).toThrow(/upload URL is invalid/);
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
});

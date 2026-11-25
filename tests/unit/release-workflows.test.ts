import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { REQUIRED_RELEASE_WORKFLOWS, verifyReleaseWorkflowRuns } from '../../scripts/verify-release-workflows.mjs';

const commit = 'a'.repeat(40);
const run = (name: string, overrides: Record<string, unknown> = {}) => ({
  name,
  head_sha: commit,
  event: 'push',
  head_branch: 'main',
  status: 'completed',
  conclusion: 'success',
  created_at: '2026-11-25T10:00:00Z',
  ...overrides,
});

describe('release workflow identity gate', () => {
  it('requires every named workflow to have a successful main push run', () => {
    const runs = REQUIRED_RELEASE_WORKFLOWS.map(name => run(name));
    expect(verifyReleaseWorkflowRuns(runs, { commit })).toEqual([]);
  });

  it('rejects a missing workflow even when unrelated checks are green', () => {
    const runs = REQUIRED_RELEASE_WORKFLOWS.filter(name => name !== 'Ghidra V004 Real Verification').map(name => run(name));
    expect(verifyReleaseWorkflowRuns(runs, { commit })).toEqual(['Required workflow is missing: Ghidra V004 Real Verification']);
  });

  it('rejects pull-request runs and runs for another branch or commit', () => {
    const runs = REQUIRED_RELEASE_WORKFLOWS.map(name => run(name, { event: 'pull_request' }));
    expect(verifyReleaseWorkflowRuns(runs, { commit }).join('\n')).toMatch(/Required workflow is missing/);
    expect(verifyReleaseWorkflowRuns(REQUIRED_RELEASE_WORKFLOWS.map(name => run(name, { head_branch: 'feat/v0.0.4' })), { commit }).join('\n')).toMatch(/Required workflow is missing/);
    expect(verifyReleaseWorkflowRuns(REQUIRED_RELEASE_WORKFLOWS.map(name => run(name, { head_sha: 'b'.repeat(40) })), { commit }).join('\n')).toMatch(/Required workflow is missing/);
  });

  it('uses the latest main push run and rejects a later failure', () => {
    const runs = REQUIRED_RELEASE_WORKFLOWS.flatMap(name => [run(name), run(name, { created_at: '2026-11-25T11:00:00Z', conclusion: 'failure' })]);
    expect(verifyReleaseWorkflowRuns(runs, { commit }).join('\n')).toMatch(/Required workflow is not successful/);
  });

  it('uses native Windows paths for NSIS install and portable destinations', async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const workflow = await readFile(path.join(root, '.github/workflows/release-v004.yml'), 'utf8');
    expect(workflow).toContain("$dest = Join-Path $env:RUNNER_TEMP 're-release-install'");
    expect(workflow).toContain("$dest = Join-Path $env:RUNNER_TEMP 're-release-portable'");
    expect(workflow).not.toContain('$dest = "$env:RUNNER_TEMP/re-release-install"');
    expect(workflow).not.toContain('$dest = "$env:RUNNER_TEMP/re-release-portable"');
  });
});

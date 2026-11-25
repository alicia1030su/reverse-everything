import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REQUIRED_RELEASE_WORKFLOWS = Object.freeze([
  'CI',
  'Android v0.0.4 real JADX',
  'Ghidra V004 Real Verification',
]);

export function verifyReleaseWorkflowRuns(runs, { commit, branch = 'main' } = {}) {
  if (!/^[0-9a-f]{40}$/i.test(String(commit ?? ''))) return ['A full frozen commit SHA is required'];
  if (!Array.isArray(runs)) return ['Workflow runs response is invalid'];
  const matching = runs.filter(run => run?.head_sha === commit && run?.event === 'push' && run?.head_branch === branch);
  const errors = [];
  for (const workflow of REQUIRED_RELEASE_WORKFLOWS) {
    const candidates = matching.filter(run => run?.name === workflow).sort((left, right) => String(right.created_at ?? '').localeCompare(String(left.created_at ?? '')));
    const latest = candidates[0];
    if (!latest) errors.push(`Required workflow is missing: ${workflow}`);
    else if (latest.status !== 'completed' || latest.conclusion !== 'success') errors.push(`Required workflow is not successful: ${workflow}`);
  }
  return errors;
}

function argument(name) {
  const index = process.argv.indexOf('--' + name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const repo = argument('repo') ?? process.env.GITHUB_REPOSITORY;
  const commit = argument('commit') ?? process.env.COMMIT;
  const branch = argument('branch') ?? 'main';
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (!repo || !/^[^/]+\/[^/]+$/.test(repo)) throw new Error('A valid --repo or GITHUB_REPOSITORY is required');
  if (!token) throw new Error('GH_TOKEN or GITHUB_TOKEN is required');
  const base = (process.env.GH_API_URL ?? process.env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/$/, '');
  const response = await fetch(`${base}/repos/${repo}/actions/runs?head_sha=${encodeURIComponent(commit)}&per_page=100`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
  });
  if (!response.ok) throw new Error(`Workflow runs API returned HTTP ${response.status}`);
  const body = await response.json();
  const errors = verifyReleaseWorkflowRuns(body.workflow_runs, { commit, branch });
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(`Required release workflows passed for ${commit}: ${REQUIRED_RELEASE_WORKFLOWS.join(', ')}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}

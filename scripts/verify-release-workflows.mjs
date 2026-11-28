import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REQUIRED_PUSH_WORKFLOWS = Object.freeze([
  'CI',
  'Android v0.0.4 real JADX',
  'Ghidra V004 Real Verification',
  'dynamic-v009',
  'Symbolic V009 Real Verification',
  'Binary Diff V009 Real Verification',
]);

export const WORKFLOW_DISPATCH_RELEASES = Object.freeze(['Release v007', 'Release v008', 'Release v009']);
const workflowDispatchReleases = new Set(WORKFLOW_DISPATCH_RELEASES);

export function requiredReleaseWorkflows(currentWorkflow) {
  return [...REQUIRED_PUSH_WORKFLOWS, currentWorkflow];
}

export function verifyReleaseWorkflowRuns(runs, { commit, branch = 'main', currentWorkflow, currentRunId } = {}) {
  if (!/^[0-9a-f]{40}$/i.test(String(commit ?? ''))) return ['A full frozen commit SHA is required'];
  if (!Array.isArray(runs)) return ['Workflow runs response is invalid'];
  if (!workflowDispatchReleases.has(currentWorkflow)) return [`Current workflow is not a supported release workflow: ${String(currentWorkflow)}`];
  const required = requiredReleaseWorkflows(currentWorkflow);
  const matching = runs.filter(run => run?.head_sha === commit && run?.head_branch === branch);
  const errors = [];
  for (const workflow of required) {
    const event = WORKFLOW_DISPATCH_RELEASES.includes(workflow) ? 'workflow_dispatch' : 'push';
    const candidates = matching.filter(run => run?.name === workflow && run?.event === event).sort((left, right) => String(right.created_at ?? '').localeCompare(String(left.created_at ?? '')));
    const latest = candidates[0];
    const current = WORKFLOW_DISPATCH_RELEASES.includes(workflow) && workflow === currentWorkflow && currentRunId !== undefined
      ? candidates.find(run => String(run?.id) === String(currentRunId))
      : undefined;
    if (current && current === latest && (current.status === 'queued' || current.status === 'in_progress')) continue;
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
  if (process.argv.includes('--help')) {
    console.log('Usage: node scripts/verify-release-workflows.mjs --repo <owner/repo> --commit <40-hex-sha> [--branch main] [--current-workflow <name> --current-run-id <id>]');
    return;
  }
  const repo = argument('repo') ?? process.env.GITHUB_REPOSITORY;
  const commit = argument('commit') ?? process.env.COMMIT;
  const branch = argument('branch') ?? 'main';
  const currentWorkflow = argument('current-workflow') ?? process.env.WORKFLOW_NAME;
  const currentRunId = argument('current-run-id') ?? process.env.GITHUB_RUN_ID;
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (!repo || !/^[^/]+\/[^/]+$/.test(repo)) throw new Error('A valid --repo or GITHUB_REPOSITORY is required');
  if (!token) throw new Error('GH_TOKEN or GITHUB_TOKEN is required');
  const base = (process.env.GH_API_URL ?? process.env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/$/, '');
  const response = await fetch(`${base}/repos/${repo}/actions/runs?head_sha=${encodeURIComponent(commit)}&per_page=100`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
  });
  if (!response.ok) throw new Error(`Workflow runs API returned HTTP ${response.status}`);
  const body = await response.json();
  const errors = verifyReleaseWorkflowRuns(body.workflow_runs, { commit, branch, currentWorkflow, currentRunId });
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(`Required release workflows passed for ${commit}: ${requiredReleaseWorkflows(currentWorkflow).join(', ')}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { REQUIRED_PUSH_WORKFLOWS, WORKFLOW_DISPATCH_RELEASES, requiredReleaseWorkflows, verifyReleaseWorkflowRuns } from '../../scripts/verify-release-workflows.mjs';

const commit = 'a'.repeat(40);
const run = (name: string, overrides: Record<string, unknown> = {}) => ({
  name,
  head_sha: commit,
  event: WORKFLOW_DISPATCH_RELEASES.includes(name) ? 'workflow_dispatch' : 'push',
  head_branch: 'main',
  status: 'completed',
  conclusion: 'success',
  created_at: '2026-11-25T10:00:00Z',
  ...overrides,
});
const currentWorkflow = 'Release v008';
const required = requiredReleaseWorkflows(currentWorkflow);

describe('release workflow identity gate', () => {
  it('requires every push gate and only the current release workflow on main', () => {
    expect(required).toEqual([...REQUIRED_PUSH_WORKFLOWS, 'Release v008']);
    expect(required).not.toContain('Release v007');
    expect(verifyReleaseWorkflowRuns(required.map(name => run(name)), { commit, currentWorkflow })).toEqual([]);
  });

  it('does not require a historical release workflow on the new frozen commit', () => {
    const runs = [
      ...required.map(name => run(name)),
      run('Release v007', { conclusion: 'failure' }),
      run('Release v006', { conclusion: 'failure' }),
    ];
    expect(verifyReleaseWorkflowRuns(runs, { commit, currentWorkflow })).toEqual([]);
    expect(verifyReleaseWorkflowRuns(required.filter(name => name !== 'Release v008').map(name => run(name)), { commit, currentWorkflow })).toEqual(['Required workflow is missing: Release v008']);
  });

  it('keeps the v007 self-gate while v008 does not require the historical release', () => {
    const v007Required = requiredReleaseWorkflows('Release v007');
    expect(v007Required).toEqual([...REQUIRED_PUSH_WORKFLOWS, 'Release v007']);
    const runs = v007Required.map(name => run(name));
    expect(verifyReleaseWorkflowRuns(runs, { commit, currentWorkflow: 'Release v007' })).toEqual([]);
    expect(verifyReleaseWorkflowRuns(runs.filter(value => value.name !== 'Release v007'), { commit, currentWorkflow: 'Release v007' })).toEqual(['Required workflow is missing: Release v007']);
    expect(verifyReleaseWorkflowRuns([...runs, run('Release v007', { status: 'completed', conclusion: 'failure' })], { commit, currentWorkflow: 'Release v008' }).join('\n')).toMatch(/Required workflow is missing: Release v008/);
    expect(requiredReleaseWorkflows('Release v008')).not.toContain('Release v007');
  });

  it('allows only the current dispatch run to be in progress without bypassing push gates', () => {
    const current = run(currentWorkflow, { id: 42, status: 'in_progress', conclusion: null });
    const runs = required.map(name => name === currentWorkflow ? current : run(name));
    expect(verifyReleaseWorkflowRuns(runs, { commit, currentWorkflow, currentRunId: 42 })).toEqual([]);
    expect(verifyReleaseWorkflowRuns(runs, { commit, currentWorkflow, currentRunId: 43 })).toEqual(['Required workflow is not successful: Release v008']);
    expect(verifyReleaseWorkflowRuns([...runs, run(currentWorkflow, { id: 44, created_at: '2026-11-25T12:00:00Z', conclusion: 'failure' })], { commit, currentWorkflow, currentRunId: 42 })).toEqual(['Required workflow is not successful: Release v008']);
    expect(verifyReleaseWorkflowRuns(runs.slice(1), { commit, currentWorkflow, currentRunId: 42 })).toEqual(['Required workflow is missing: CI']);
  });

  it('fails closed for missing or unsupported release workflow identities', () => {
    expect(verifyReleaseWorkflowRuns(required.map(name => run(name)), { commit })).toEqual(['Current workflow is not a supported release workflow: undefined']);
    expect(verifyReleaseWorkflowRuns(required.map(name => run(name)), { commit, currentWorkflow: 'CI' })).toEqual(['Current workflow is not a supported release workflow: CI']);
  });

  it('rejects a missing workflow even when unrelated checks are green', () => {
    const runs = required.filter(name => name !== 'Ghidra V004 Real Verification').map(name => run(name));
    expect(verifyReleaseWorkflowRuns(runs, { commit, currentWorkflow })).toEqual(['Required workflow is missing: Ghidra V004 Real Verification']);
  });

  it('rejects pull-request runs and runs for another branch or commit', () => {
    const runs = required.map(name => run(name, { event: 'pull_request' }));
    expect(verifyReleaseWorkflowRuns(runs, { commit, currentWorkflow }).join('\n')).toMatch(/Required workflow is missing/);
    expect(verifyReleaseWorkflowRuns(required.map(name => run(name, { head_branch: 'feat/v0.0.4' })), { commit, currentWorkflow }).join('\n')).toMatch(/Required workflow is missing/);
    expect(verifyReleaseWorkflowRuns(required.map(name => run(name, { head_sha: 'b'.repeat(40) })), { commit, currentWorkflow }).join('\n')).toMatch(/Required workflow is missing/);
  });

  it('uses the latest main push run and rejects a later failure', () => {
    const runs = required.flatMap(name => [run(name), run(name, { created_at: '2026-11-25T11:00:00Z', conclusion: 'failure' })]);
    expect(verifyReleaseWorkflowRuns(runs, { commit, currentWorkflow }).join('\n')).toMatch(/Required workflow is not successful/);
  });

  it('runs required real-tool workflows on every main push', async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    for (const file of ['.github/workflows/android-v004.yml', '.github/workflows/ghidra-v004.yml']) {
      const workflow = await readFile(path.join(root, file), 'utf8');
      expect(workflow).toMatch(/on:\s*\n\s*push:\s*\n\s*branches: \[main\]/);
    }
  });

  it('uses native Windows paths for NSIS install and portable destinations', async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const workflow = await readFile(path.join(root, '.github/workflows/release-v004.yml'), 'utf8');
    expect(workflow).toContain("$dest = Join-Path $env:RUNNER_TEMP 're-release-install'");
    expect(workflow).toContain("$dest = Join-Path $env:RUNNER_TEMP 're-release-portable'");
    expect(workflow).not.toContain('$dest = "$env:RUNNER_TEMP/re-release-install"');
    expect(workflow).not.toContain('$dest = "$env:RUNNER_TEMP/re-release-portable"');
  });

  it('keeps v006 identity, frozen main and real game Docker acceptance gates', async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const workflow = await readFile(path.join(root, '.github/workflows/release-v006.yml'), 'utf8');
    expect(workflow).toContain('name: Release v006');
    expect(workflow).toContain('group: release-v006-${{ github.repository }}');
    expect(workflow).toContain('actions: read');
    expect(workflow.match(/environment: release-v006/g)).toHaveLength(3);
    expect(workflow).not.toContain('release-v005');
    expect(workflow).toContain('git fetch origin main');
    expect(workflow).toContain('test "$commit" = "$(git rev-parse origin/main)"');
    expect(workflow).toContain('- run: npm run docs:check');
    expect(workflow).toContain('- run: npm run version:check');
    expect(workflow).toContain('- run: npm run validate:skill');
    expect(workflow).toContain('node scripts/validate-game-docker.mjs --genre fps');
    expect(workflow).toContain('node scripts/validate-game-docker.mjs --genre rpg');
    expect(workflow).toContain('name: docker-validation');
    expect(workflow).toMatch(/candidate-game-docker:[\s\S]*?needs: \[freeze, candidate-linux\]/);
    expect(workflow).toContain('needs: [freeze, candidate-linux, candidate-game-docker, candidate-windows]');
    expect(workflow).toContain('test -s dist/release/openapi-v0.0.6.json');
    expect(workflow).toContain('node scripts/verify-game-docker-evidence.mjs');
    expect(workflow.match(/node scripts\/verify-game-docker-evidence\.mjs/g)).toHaveLength(3);
    expect(workflow.match(/--sums "dist\/game-docker\/\$genre\/SHA256SUMS\.txt"/g)).toHaveLength(3);
    expect(workflow).toContain('dist/game-docker/*/SHA256SUMS.txt');
    expect(workflow).toContain("$result.gameRevival.npmCli -notlike '*\\resources\\node_modules\\npm\\bin\\npm-cli.js'");
    expect(workflow).toContain("$result.gameRevival.nodeRuntime -ne 'packaged Electron node.cmd shim'");
    expect(workflow.match(/Installed Game Revival smoke missing passing check/g)).toHaveLength(1);
    expect(workflow.match(/Portable Game Revival smoke missing passing check/g)).toHaveLength(1);
    expect(workflow).toContain('name: windows-smoke-evidence');
    expect(workflow).toContain('--check windows-game-revival-smoke');
    expect(workflow).not.toContain('report.valid !== true || report.capabilities?.dockerDeployment !== true');
    expect(workflow).toContain('--check game-fps-rpg-docker-validation');
    expect(workflow).toContain('manifest.assets.length !== 10');
    expect(workflow).toContain('test "$(git cat-file -t "refs/tags/$TAG")" = tag');
    expect(workflow).toContain('node scripts/release-atomic.mjs ensure-draft');
    expect(workflow).toContain('node scripts/release-atomic.mjs verify-draft');
    expect(workflow).toContain('node scripts/release-atomic.mjs verify-public');
  });

  it('keeps v007 identity, frozen main, v006 upgrade and strict evidence gates', async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const workflow = await readFile(path.join(root, '.github/workflows/release-v007.yml'), 'utf8');
    expect(workflow).toContain('name: Release v007');
    expect(workflow).toContain('group: release-v007-${{ github.repository }}');
    expect(workflow.match(/environment: release-v007/g)).toHaveLength(3);
    expect(workflow).not.toContain('release-v006');
    expect(workflow).toContain('git fetch origin main');
    expect(workflow).toContain('test "$commit" = "$(git rev-parse origin/main)"');
    expect(workflow).toContain('- run: npm run docs:check');
    expect(workflow).toContain('- run: npm run defects:check');
    expect(workflow).toContain('- run: npm run version:check');
    expect(workflow).toContain('- run: npm run validate:skill');
    expect(workflow).toContain('tests/unit/legacy-revival.test.ts');
    expect(workflow).toContain('evidence-driven anti-template acceptance');
    expect(workflow).toContain('schema 4 plan binding migration integrity|schema 3 migration integrity');
    expect(workflow).toContain('gh release download v0.0.6');
    expect(workflow).toContain('Upgrade v0.0.6 installer and preserve user data');
    expect(workflow).toContain('Legacy reconstruction rebuild and independent start smoke');
    expect(workflow).toContain('node $script $resources $work $output');
    expect(workflow).toContain('$legacyExitCode = $LASTEXITCODE');
    expect(workflow).toContain('Test-Path -LiteralPath $output');
    expect(workflow).toContain('ref: main');
    expect(workflow).not.toContain('inputs.ref');
    expect(workflow).toContain("report.targetEvidence?.behavior !== 'VERIFIED' || report.targetEvidence?.originalClient !== 'UNKNOWN' || report.targetEvidence?.protocol !== 'UNKNOWN'");
    expect(workflow.match(/client\.kind === 'internal-protocol-client' && client\.count > 0/g)).toHaveLength(3);
    expect(workflow.match(/must not claim an original game client/g)).toHaveLength(3);
    expect(workflow).toContain('Expected v0.0.6 Schema 5, got');
    expect(workflow).toContain('Schema 6 upgrade or project preservation failed');
    expect(workflow).toContain('--check windows-v006-upgrade-smoke');
    expect(workflow).toContain('--check windows-legacy-revival-smoke');
    expect(workflow.match(/node scripts\/verify-game-docker-evidence\.mjs/g)).toHaveLength(3);
    expect(workflow).toContain('needs: [freeze, candidate-linux, candidate-game-docker, candidate-windows]');
    expect(workflow).toContain('test "$VERSION" = "0.0.7"');
    expect(workflow).toContain('"openapi-v$VERSION.json"');
    expect(workflow).toContain('test "$GITHUB_RUN_ID" = "$EXPECTED_RUN_ID"');
    expect(workflow).toContain('test "$LINUX_RUN_ID" = "$GITHUB_RUN_ID"');
    expect(workflow).toContain('test "$GAME_DOCKER_RUN_ID" = "$GITHUB_RUN_ID"');
    expect(workflow).toContain('test "$WINDOWS_RUN_ID" = "$GITHUB_RUN_ID"');
    expect(workflow).toContain('manifest.assets.length !== 13');
    expect(workflow).toContain('Expected exactly 15 Release assets');
    expect(workflow).toContain('reverse-everything-game-compat-demo-$VERSION.zip');
    expect(workflow).toContain('reverse-everything-legacy-demo-$VERSION.zip');
    expect(workflow).toContain("'demo-evidence.json'");
    expect(workflow).toContain('BUILD-INFO');
    expect(workflow).toContain('ACCEPTANCE');
    expect(workflow).toContain('node scripts/release-atomic.mjs verify-public');
  });

  it('keeps v008 atomic identity, Schema 7, Autopilot and honest real-model gates', async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const workflow = await readFile(path.join(root, '.github/workflows/release-v008.yml'), 'utf8');
    expect(workflow).toContain('name: Release v008');
    expect(workflow).toContain('group: release-v008-${{ github.repository }}');
    expect(workflow.match(/environment: release-v008/g)).toHaveLength(3);
    expect(workflow).not.toContain('release-v007');
    expect(workflow).toContain('ref: main');
    expect(workflow).not.toContain('inputs.ref');
    expect(workflow).toContain('test -z "$(git status --porcelain)"');
    expect(workflow).toContain('test "$commit" = "$(git rev-parse origin/main)"');
    expect(workflow).toContain('node scripts/verify-release-workflows.mjs');
    expect(workflow).toContain('runs-on: ubuntu-latest');
    expect(workflow).toContain('runs-on: windows-latest');
    expect(workflow).toContain('Require Schema 7 migration tests');
    expect(workflow).toContain('tests/unit/autopilot.test.ts -t "persists task state across SQLite close and reopen"');
    expect(workflow).toContain('Require Autopilot core and API integration tests');
    expect(workflow).toContain('tests/unit/autopilot.test.ts tests/integration/autopilot-api.test.ts');
    expect(workflow).toContain('Require Autopilot Web real API E2E');
    expect(workflow).toContain('npm run test:e2e -- tests/e2e/autopilot.spec.ts');
    expect(workflow).toContain('Require MCP stdio and Streamable HTTP transports');
    expect(workflow).toContain('tests/integration/platform.test.ts --reporter=verbose');
    expect(workflow).toContain('Generate current-commit original-client game compatibility evidence');
    const gameEvidenceStep = 'npx playwright test tests/e2e/game-compat.spec.ts --output="${{ runner.temp }}/v008-game-compat-evidence" --reporter=line';
    const packageDemosStep = 'name: Package demos with current-commit original-client evidence\n        env:\n          GAME_COMPAT_EVIDENCE_DIR: ${{ runner.temp }}/v008-game-compat-evidence\n        run: npm run package:demos';
    expect(workflow).toContain(gameEvidenceStep);
    expect(workflow).toContain(packageDemosStep);
    expect(workflow.indexOf(gameEvidenceStep)).toBeLessThan(workflow.indexOf('run: npm run package:demos'));
    expect(workflow.indexOf(packageDemosStep)).toBeGreaterThan(workflow.indexOf(gameEvidenceStep));
    expect(workflow).not.toContain('artifacts/v007-game-compat');
    expect(workflow).toContain('Validate real model without treating a missing Key as success');
    expect(workflow).toContain('continue-on-error: true');
    expect(workflow).toContain("status: 'BLOCKED'");
    expect(workflow).toContain("report.status === 'SKIPPED' && report.error?.code === 'MISSING_API_KEY'");
    expect(workflow).toContain('candidate gates continue without a real-model claim');
    expect(workflow).toContain("['PASSED', 'BLOCKED'].includes(report.status)");
    expect(workflow).toContain('name: real-model-validation');
    expect(workflow).toContain("model.status === 'BLOCKED' && (model.realModelCalled !== false || model.error?.code !== 'MISSING_API_KEY')");
    expect(workflow).toContain('--check real-model-passed-or-blocked');
    expect(workflow).toContain('gh release download v0.0.7');
    expect(workflow).toContain('Expected v0.0.7 Schema 6, got');
    expect(workflow).toContain('Schema 7 upgrade or project preservation failed');
    expect(workflow).toContain("previousVersion = '0.0.7'");
    expect(workflow).toContain('schemaVersion = 7');
    expect(workflow).toContain('--check windows-v007-upgrade-smoke');
    expect(workflow).toContain('Legacy reconstruction rebuild and independent start smoke');
    expect(workflow).toContain('Silent install smoke');
    expect(workflow).toContain('Portable smoke');
    expect(workflow).toContain('--check autopilot-core-api-web-e2e');
    expect(workflow).toContain('--check mcp-stdio-streamable-http');
    expect(workflow).toContain('--check schema-7-migration');
    expect(workflow).toContain('--check clean-cli-server-skill-smoke');
    expect(workflow).toContain('--check docker-health');
    for (const name of ['pixelknight', 'tron']) {
      expect(workflow).toContain(`for (const name of ['pixelknight', 'tron'])`);
      expect(workflow).toContain("demos.games?.[name]?.originalClient !== true");
    }
    expect(workflow).toContain('needs: [freeze, candidate-linux, candidate-game-docker, candidate-windows]');
    expect(workflow).toContain('test "$VERSION" = "0.0.8"');
    expect(workflow).toContain('release-provenance.mjs generate');
    expect(workflow).toContain('release-provenance.mjs verify');
    expect(workflow).toContain('BUILD-INFO');
    expect(workflow).toContain('ACCEPTANCE');
    expect(workflow).toContain('SHA256SUMS');
    expect(workflow).toContain('manifest.assets.length !== 13');
    expect(workflow).toContain('Expected exactly 15 Release assets');
    expect(workflow).toContain('release_id: ${{ steps.draft.outputs.release_id }}');
    expect(workflow).toContain('node scripts/release-atomic.mjs ensure-draft');
    expect(workflow).toContain('node scripts/release-atomic.mjs upload');
    expect(workflow).toContain('node scripts/release-atomic.mjs verify-draft');
    expect(workflow).toContain('node scripts/release-atomic.mjs publish');
    expect(workflow).toContain('node scripts/release-atomic.mjs verify-public');
    expect(workflow.match(/--release-id "\$RELEASE_ID"/g)).toHaveLength(4);
    expect(workflow).toContain('test "$(git rev-parse "$TAG^{commit}")" = "$COMMIT"');
    expect(workflow).toContain('Tag/Build/Acceptance identity mismatch');
  });

  it('makes CI game Docker evidence mandatory and independently verified', async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const workflow = await readFile(path.join(root, '.github/workflows/ci.yml'), 'utf8');
    const gameDocker = workflow.slice(workflow.indexOf('  game-docker:'));
    expect(workflow).toContain('- run: npm run docs:check');
    expect(workflow).toContain('- run: npm run defects:check');
    expect(gameDocker).toContain('node scripts/validate-game-docker.mjs --genre ${{ matrix.genre }}');
    expect(gameDocker).toContain('node scripts/verify-game-docker-evidence.mjs');
    expect(gameDocker).toContain('--sums .artifacts/game-docker-${{ matrix.genre }}/SHA256SUMS.txt');
    expect(gameDocker).toContain('.artifacts/game-docker-${{ matrix.genre }}/SHA256SUMS.txt');
    expect(gameDocker).toContain('if-no-files-found: error');
    expect(gameDocker).not.toContain('if-no-files-found: warn');
  });

  it('packages an exact npm closure and points desktop validation at the packaged CLI', async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as { devDependencies?: Record<string, string> };
    expect(packageJson.devDependencies?.npm).toMatch(/^\d+\.\d+\.\d+$/);
    const runtime = await readFile(path.join(root, 'scripts/package-runtime.mjs'), 'utf8');
    expect(runtime).toContain("const queue=[{name:'npm',from:root}]");
    expect(runtime).toContain("found.pkg.version!==npmVersion");
    expect(runtime).toContain("Object.keys(found.pkg.dependencies??{})");
    expect(runtime).toContain("Object.keys(found.pkg.optionalDependencies??{})");
    const main = await readFile(path.join(root, 'apps/desktop/src/main.ts'), 'utf8');
    expect(main).toContain("path.join(resourceDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')");
    expect(main).toContain('process.env.RE_NPM_CLI = npmCli');
    expect(main).toContain("process.env.ELECTRON_RUN_AS_NODE = '1'");
    expect(main).toContain("nodeRuntime = 'packaged Electron node.cmd shim'");
    const builder = await readFile(path.join(root, 'apps/desktop/electron-builder.yml'), 'utf8');
    expect(builder).toMatch(/from:\s*\.\.\/\.\.\/dist\/desktop-runtime\/node_modules\s+to:\s+node_modules/);
  });

  it('drives v0.0.5 upload publish and public verification by Release ID', async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const workflow = await readFile(path.join(root, '.github/workflows/release-v005.yml'), 'utf8');
    expect(workflow).toContain('release_id: ${{ steps.draft.outputs.release_id }}');
    expect(workflow).toContain('--release-id "$RELEASE_ID"');
    expect(workflow).toContain('node scripts/release-atomic.mjs verify-public');
    expect(workflow).toContain('environment: release-v005');
  });
});

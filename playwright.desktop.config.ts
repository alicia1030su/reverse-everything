import { defineConfig } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

interface DesktopSmokeResult {
  ok: boolean;
  desktopMetrics?: {
    status: string;
    snapshot?: {
      source: string;
      processes: Array<{ role: string; rssMB: number }>;
      limitations: string[];
    };
  };
}

async function desktopMetricsGlobalSetup(): Promise<void> {
  if (process.platform !== 'win32') return;
  const root = process.cwd();
  const electronExecutable = path.join(root, 'node_modules/electron/dist/electron.exe');
  if (!existsSync(electronExecutable)) throw new Error(`Electron 可执行文件不可用：${electronExecutable}`);
  const runtimeDir = await mkdtemp(path.join(tmpdir(), 'reverse-desktop-metrics-smoke-'));
  const output = path.join(runtimeDir, 'smoke.json');
  const env: NodeJS.ProcessEnv = { ...process.env, RE_RESOURCE_DIR: root, RE_DATA_DIR: runtimeDir, RE_SMOKE_OUTPUT: output };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronExecutable, [path.join(root, 'apps/desktop'), '--smoke-test'], {
    cwd: root,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let diagnostics = '';
  child.stdout?.on('data', chunk => { diagnostics = `${diagnostics}${String(chunk)}`.slice(-65536); });
  child.stderr?.on('data', chunk => { diagnostics = `${diagnostics}${String(chunk)}`.slice(-65536); });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    if (child.pid) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else child.kill();
  }, 120000);
  let code: number | null;
  try {
    code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', exitCode => resolve(exitCode));
    });
  } finally {
    clearTimeout(timeout);
  }
  const artifactDir = path.join(root, 'test-results/desktop');
  await mkdir(artifactDir, { recursive: true });
  await writeFile(path.join(artifactDir, 'smoke-metrics.log'), diagnostics);
  let result: DesktopSmokeResult | undefined;
  if (existsSync(output)) {
    const raw = await readFile(output, 'utf8');
    await writeFile(path.join(artifactDir, 'smoke-metrics.json'), raw);
    result = JSON.parse(raw) as DesktopSmokeResult;
  }
  try {
    assert.equal(timedOut, false, '桌面 metrics smoke 超过 120 秒，已强制结束进程树');
    assert.equal(code, 0, `桌面 metrics smoke 退出码=${code}；详见 test-results/desktop/smoke-metrics.log`);
    assert.equal(result?.ok, true, '桌面 smoke 未通过');
    assert.equal(result.desktopMetrics?.status, 'reported', '桌面 metrics 未真实写入本地 API');
    const snapshot = result.desktopMetrics?.snapshot;
    assert.equal(snapshot?.source, 'desktop', 'API 中缺少 desktop snapshot');
    assert.ok(snapshot.processes.some(process => process.role === 'main' && process.rssMB > 0), 'desktop snapshot 缺少真实 main RSS');
    assert.ok(snapshot.processes.some(process => process.role === 'renderer' && process.rssMB > 0), 'desktop snapshot 缺少真实 renderer RSS');
    assert.ok(Array.isArray(snapshot.limitations), 'desktop snapshot 缺少 limitations');
  } finally {
    if (code === 0 && result?.ok) await rm(runtimeDir, { recursive: true, force: true });
  }
}

if (process.platform === 'win32' && !process.argv.includes('--list')) await desktopMetricsGlobalSetup();

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'desktop-gui.spec.ts',
  timeout: 180000,
  expect: { timeout: 30000 },
  fullyParallel: false,
  workers: 1,
  outputDir: 'test-results/desktop/artifacts',
  reporter: [
    ['list'],
    ['json', { outputFile: 'test-results/desktop/results.json' }],
    ['html', { outputFolder: 'test-results/desktop/html', open: 'never' }],
  ],
  use: {
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});

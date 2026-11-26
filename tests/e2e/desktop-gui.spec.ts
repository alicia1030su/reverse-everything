import { expect, test, _electron, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { createHash } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve(process.cwd());
const mainEntry = path.join(root, 'apps/desktop/dist/main.js');
const electronExecutable = path.join(root, 'node_modules/electron/dist/electron.exe');

test.skip(process.platform !== 'win32', '桌面 GUI 验收仅在 Windows Electron 环境运行；当前平台明确跳过。');
test.skip(!existsSync(electronExecutable), `Electron 可执行文件不可用：${electronExecutable}。请修复现有 Electron 安装后重跑。`);

interface TaskDetail {
  status: string;
  adapter: string;
  report?: string;
  evidence: Array<{ title: string; content: unknown }>;
  artifacts: Array<{ name: string }>;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function sidecarPids(log: string): number[] {
  return [...log.matchAll(/\[sidecar\] started name=\S+ pid=(\d+)/g)].map(match => Number(match[1]));
}

async function preserveDesktopLog(dataDir: string, testInfo: TestInfo): Promise<string> {
  const logPath = path.join(dataDir, 'logs/desktop.log');
  if (!existsSync(logPath)) return '';
  const log = await readFile(logPath, 'utf8');
  const output = testInfo.outputPath('desktop.log');
  await writeFile(output, log);
  await testInfo.attach('desktop.log', { path: output, contentType: 'text/plain' });
  return log;
}

test('真实 Electron BrowserWindow 完成文件分析、报告与证据验收', async ({}, testInfo) => {
  expect(existsSync(mainEntry), `缺少桌面构建产物 ${mainEntry}，请先运行 npm run build -w @reverse/desktop`).toBe(true);
  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as { version: string };
  const expectedVersion = packageJson.version;
  const runtimeDir = await mkdtemp(path.join(tmpdir(), 'reverse-desktop-gui-'));
  const sample = {
    name: 'desktop-gui-sample',
    version: '1.2.3',
    dependencies: { 'desktop-gui-dependency': '4.5.6' },
  };
  const sampleBuffer = Buffer.from(`${JSON.stringify(sample, null, 2)}\n`);
  const sampleHash = createHash('sha256').update(sampleBuffer).digest('hex');
  const samplePath = path.join(runtimeDir, 'sample.json');
  await writeFile(samplePath, sampleBuffer);
  const launchEnv = { ...process.env };
  delete launchEnv.ELECTRON_RUN_AS_NODE;

  let electronApp: ElectronApplication | undefined;
  let electronProcess: ChildProcess | undefined;
  let page: Page | undefined;
  try {
    electronApp = await _electron.launch({
      args: [path.join(root, 'apps/desktop')],
      executablePath: electronExecutable,
      cwd: root,
      env: {
        ...launchEnv,
        RE_RESOURCE_DIR: root,
        RE_DATA_DIR: runtimeDir,
        RE_WORKER_SOFT_RSS_MB: '2048',
        RE_WORKER_MAX_RSS_MB: '2048',
        RE_TASK_TIMEOUT_MS: '120000',
      },
      timeout: 60000,
    });
    electronProcess = electronApp.process();
    page = await electronApp.firstWindow({ timeout: 60000 });
    await page.waitForLoadState('domcontentloaded');
    const browserWindow = await electronApp.browserWindow(page);
    expect(browserWindow).not.toBeNull();
    await browserWindow!.evaluate(window => window.setBounds({ x: 0, y: 0, width: 1440, height: 960 }));
    await expect(page.getByRole('heading', { name: '今天想分析什么？' })).toBeVisible();
    await expect(page.getByText(`v${expectedVersion} · Apache-2.0`, { exact: true })).toBeVisible();
    await page.getByRole('checkbox', { name: '确认已阅读并理解安全提示' }).check();
    await page.getByRole('button', { name: '关闭首次使用引导' }).click();

    await page.getByRole('link', { name: '创建项目', exact: true }).click();
    await page.getByRole('button', { name: /软件分析/ }).click();
    await page.getByPlaceholder('例如：软件分析样本').fill('桌面 GUI 文件分析验收');
    await page.locator('input[type=file]').setInputFiles(samplePath);
    await expect(page.getByText('sample.json', { exact: true })).toBeVisible();
    await page.getByRole('checkbox').check();
    const createButton = page.getByRole('button', { name: '创建项目并开始分析' });
    await expect(createButton).toBeEnabled();
    await createButton.click();

    await expect(page).toHaveURL(/\/tasks\/[^/]+$/);
    const taskId = new URL(page.url()).pathname.split('/').pop();
    expect(taskId).toBeTruthy();
    await expect(page.getByTestId('status-COMPLETED')).toBeVisible({ timeout: 120000 });
    await expect(page.getByRole('heading', { name: '桌面 GUI 文件分析验收' })).toBeVisible();

    const detailResponse = await page.request.get(new URL(`/api/tasks/${taskId}`, page.url()).toString());
    expect(detailResponse.ok()).toBe(true);
    const detail = await detailResponse.json() as TaskDetail;
    expect(detail.status).toBe('COMPLETED');
    expect(detail.adapter).toBe('file');
    expect(detail.artifacts.map(artifact => artifact.name)).toEqual(expect.arrayContaining([
      'report.md',
      'file-analysis.json',
      'manifest.json',
      'evidence.json',
    ]));

    const identityEvidence = page.getByText('Input identity verified', { exact: true });
    await expect(identityEvidence).toBeVisible();
    await identityEvidence.click();
    const evidenceContent = page.locator('details[open] pre').first();
    await expect(evidenceContent).toContainText('"sha256"');
    await expect(evidenceContent).toContainText(sampleHash);
    await page.screenshot({ path: testInfo.outputPath('desktop-gui-evidence.png'), fullPage: true });

    await page.getByRole('button', { name: /^报告\d+$/ }).click();
    const reportPanel = page.locator('pre').filter({ hasText: '逆向万物分析报告' });
    await expect(reportPanel).toContainText(`产品版本：${expectedVersion}`);
    await expect(reportPanel).toContainText('适配器：file 1.1.0');
    await expect(page.getByRole('link', { name: /report\.md/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /file-analysis\.json/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /manifest\.json/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /evidence\.json/ })).toBeVisible();

    const reportLink = page.getByRole('link', { name: /report\.md/ });
    const reportHref = await reportLink.getAttribute('href');
    expect(reportHref).toBeTruthy();
    const artifactResponse = await page.request.get(new URL(reportHref!, page.url()).toString());
    expect(artifactResponse.ok()).toBe(true);
    const reportArtifact = await artifactResponse.text();
    expect(reportArtifact).toContain(`产品版本：${expectedVersion}`);
    expect(reportArtifact).toContain('适配器：file 1.1.0');
    await writeFile(testInfo.outputPath('report.md'), reportArtifact);
    await page.screenshot({ path: testInfo.outputPath('desktop-gui-report.png'), fullPage: true });
  } finally {
    let closeError: unknown;
    if (electronApp) {
      try {
        await electronApp.close();
      } catch (error) {
        closeError = error;
      }
    }

    const log = await preserveDesktopLog(runtimeDir, testInfo);
    const pids = sidecarPids(log);
    const alive = pids.filter(processExists);
    if (!alive.length) await rm(runtimeDir, { recursive: true, force: true });
    expect(pids.length, `桌面日志未记录 API/Worker sidecar PID：\n${log}`).toBeGreaterThanOrEqual(2);
    expect(alive, `Sidecar 进程在 Electron 退出后仍存活：${alive.join(', ')}`).toEqual([]);
    expect(electronProcess).toBeDefined();
    expect(electronProcess!.exitCode).not.toBeNull();
    if (closeError) throw closeError;
  }
});

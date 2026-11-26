import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { openWorkspace } from './workspace';

async function createGameProject(page: Page, name: string): Promise<string> {
  await page.request.get('/api/session');
  const response = await page.request.post('/api/projects', {
    data: { name, kind: 'game', authorizationConfirmed: true },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json() as { id: string }).id;
}

async function saveProfileViaApi(page: Page, projectId: string, name: string): Promise<void> {
  const response = await page.request.put(`/api/projects/${projectId}/game-profile`, {
    data: {
      name,
      genre: 'fps',
      publisher: '',
      region: '',
      clientVersion: '',
      shutdownDate: '',
      engine: '',
      source: 'self-authored E2E fixture',
      authorizationScope: 'local research',
      knownProtocols: [],
      retainedMaterials: [],
      existingImplementations: [],
      unrecoveredFeatures: [],
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
}

test('game studio persists a profile and fails closed when RE_GAME_ROOTS is unset', async ({ page }, testInfo) => {
  const rootPath = await mkdtemp(path.join(tmpdir(), 're-v006-game-studio-'));
  try {
    const projectName = `V006 Game Studio ${Date.now()}`;
    const projectId = await createGameProject(page, projectName);
    await openWorkspace(page, '/game-studio');

    await expect(page.getByRole('heading', { name: '游戏复活工作台' })).toBeVisible();
    await expect(page.getByText(/独立多人服务端/)).toBeVisible();
    await expect(page.getByText(/商业客户端缺少证据时保持 BLOCKED\/UNKNOWN/)).toBeVisible();
    await expect(page.getByText('任务结束不等于游戏复活成功。')).toBeVisible();

    await page.getByLabel('研究项目').selectOption(projectId);
    await page.getByLabel('游戏名称').fill(projectName);
    await page.getByLabel('类型').selectOption('fps');
    await page.getByLabel('客户端版本').fill('1.0.0');
    await page.getByLabel('停服日期').fill('2026-01-01');
    await page.getByLabel('游戏引擎').fill('TypeScript');
    await page.getByLabel('厂商 / 地区').fill('Self-authored / Test');
    await page.getByLabel('本机游戏目录').fill(rootPath);
    await page.getByLabel('授权范围').fill('Local research on a self-authored fixture');
    await page.getByLabel('文件来源').fill('Self-authored Playwright E2E fixture');
    await page.getByLabel('尚未恢复的功能（每行一项）').fill('Original client protocol');

    const saveResponsePromise = page.waitForResponse(response =>
      response.request().method() === 'PUT'
      && response.url().endsWith(`/api/projects/${projectId}/game-profile`),
    );
    await page.getByRole('button', { name: '保存档案' }).click();
    const saveResponse = await saveResponsePromise;
    expect(saveResponse.status(), await saveResponse.text()).toBe(200);
    const saved = await saveResponse.json() as { profile: { level: string; name: string; rootPath: string } };
    expect(saved.profile.level).toBe('L0');
    expect(saved.profile.name).toBe(projectName);
    expect(saved.profile.rootPath).toBe(rootPath);
    await expect(page.getByText(/当前等级/)).toContainText('L0');

    const profileResponse = await page.request.get(`/api/projects/${projectId}/game-profile`);
    expect(profileResponse.ok(), await profileResponse.text()).toBe(true);
    const persisted = await profileResponse.json() as { profile: { clientVersion: string; authorizationScope: string; unrecoveredFeatures: string[] } };
    expect(persisted.profile.clientVersion).toBe('1.0.0');
    expect(persisted.profile.authorizationScope).toBe('Local research on a self-authored fixture');
    expect(persisted.profile.unrecoveredFeatures).toEqual(['Original client protocol']);

    await page.reload();
    await expect(page.getByLabel('游戏名称')).toHaveValue(projectName);
    await expect(page.getByLabel('客户端版本')).toHaveValue('1.0.0');
    await expect(page.getByLabel('本机游戏目录')).toHaveValue(rootPath);

    const scanResponsePromise = page.waitForResponse(response =>
      response.request().method() === 'POST'
      && response.url().endsWith(`/api/projects/${projectId}/game-scan`),
    );
    await page.getByRole('button', { name: '扫描目录' }).click();
    const scanResponse = await scanResponsePromise;
    expect(scanResponse.status(), await scanResponse.text()).toBe(403);
    const scanError = await scanResponse.json() as { error: { code: string; message: string } };
    expect(scanError.error.code).toBe('FORBIDDEN');
    expect(scanError.error.message).toContain('RE_GAME_ROOTS');

    const alert = page.getByRole('alert');
    await expect(alert).toContainText('无法完成目录扫描');
    await expect(alert).toContainText('FORBIDDEN');
    await expect(alert).toContainText('RE_GAME_ROOTS');
    await page.screenshot({ path: testInfo.outputPath('v006-game-studio.png'), fullPage: true });
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
});

test('game studio displays the complete L0-L7 evidence scale', async ({ page }) => {
  const projectId = await createGameProject(page, `V006 Level Scale ${Date.now()}`);
  await saveProfileViaApi(page, projectId, 'V006 Level Scale Fixture');
  await openWorkspace(page, '/game-studio');

  await expect(page.getByText(/当前等级/)).toContainText('L0');
  const body = page.locator('body');
  for (let level = 0; level <= 7; level += 1) {
    await expect(body, `game studio should display evidence level L${level}`).toContainText(`L${level}`);
  }
});

test('game studio keeps spec and active rebuild isolated across projects without rebuilding', async ({ page }) => {
  const suffix = Date.now();
  const projectA = await createGameProject(page, `V006 Project A ${suffix}`);
  const projectB = await createGameProject(page, `V006 Project B ${suffix}`);
  await saveProfileViaApi(page, projectA, 'V006 Project A Fixture');
  await saveProfileViaApi(page, projectB, 'V006 Project B Fixture');
  const rebuildA = {
    id: 'rebuild-project-a', projectId: projectA, specId: 'spec-project-a', status: 'FAILED', level: 'L4',
    outputPath: null, error: null, validation: { marker: 'project-a-report' }, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  };
  const rebuildB = {
    id: 'rebuild-project-b', projectId: projectB, specId: 'spec-project-b', status: 'BLOCKED', level: 'L3',
    outputPath: null, error: null, validation: { marker: 'project-b-report' }, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  };
  let rebuildRequests = 0;
  await page.route('**/api/game/rebuilds', async route => {
    if (route.request().method() === 'POST') {
      rebuildRequests += 1;
      await route.fulfill({ status: 500, json: { error: { code: 'UNEXPECTED_REBUILD', message: 'E2E must not create a rebuild' } } });
      return;
    }
    await route.fulfill({ json: { items: [rebuildA, rebuildB] } });
  });
  await page.route('**/api/game/rebuilds/*', async route => {
    const id = route.request().url().split('/').pop();
    await route.fulfill({ json: id === rebuildA.id ? rebuildA : rebuildB });
  });

  let releaseSpecA = () => {};
  const specAGate = new Promise<void>(resolve => { releaseSpecA = resolve; });
  await page.route(`**/api/projects/${projectA}/game-spec`, async route => {
    await specAGate;
    await route.continue();
  });
  try {
    await openWorkspace(page, '/game-studio');
    await page.getByLabel('研究项目').selectOption(projectA);

    const specAResponsePromise = page.waitForResponse(response => response.url().endsWith(`/api/projects/${projectA}/game-spec`) && response.request().method() === 'POST');
    await page.getByRole('button', { name: '生成服务端规格' }).click();
    await expect(page.getByRole('button', { name: '生成服务端规格' })).toBeDisabled();
    await page.getByLabel('研究项目').selectOption(projectB);
    await expect(page.getByRole('button', { name: '开始智能复活' })).toBeDisabled();
    releaseSpecA();
    const specAResponse = await specAResponsePromise;
    expect(specAResponse.status()).toBe(200);
    const specA = await specAResponse.json() as { spec: { id: string } };
    await expect(page.getByText(`spec ${specA.spec.id}`, { exact: true })).toHaveCount(0);

    const specBResponsePromise = page.waitForResponse(response => response.url().endsWith(`/api/projects/${projectB}/game-spec`) && response.request().method() === 'POST');
    await page.getByRole('button', { name: '生成服务端规格' }).click();
    const specBResponse = await specBResponsePromise;
    expect(specBResponse.status()).toBe(200);
    const specB = await specBResponse.json() as { spec: { id: string } };
    await expect(page.getByText(`spec ${specB.spec.id}`, { exact: true })).toBeVisible();

    await page.getByLabel('研究项目').selectOption(projectA);
    await expect(page.getByText(`spec ${specB.spec.id}`, { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '开始智能复活' })).toBeDisabled();
    const historyA = page.getByLabel('历史重建（可选）');
    await expect(historyA.locator('option')).toHaveCount(2);
    await expect(historyA.locator(`option[value="${rebuildB.id}"]`)).toHaveCount(0);
    await historyA.selectOption(rebuildA.id);
    await expect(page.getByTestId('status-FAILED')).toBeVisible();
    await expect(page.getByText('project-a-report', { exact: false })).toBeVisible();

    await page.getByLabel('研究项目').selectOption(projectB);
    await expect(page.getByTestId('status-FAILED')).toHaveCount(0);
    await expect(page.getByText('project-a-report', { exact: false })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '开始智能复活' })).toBeDisabled();
    const historyB = page.getByLabel('历史重建（可选）');
    await expect(historyB.locator('option')).toHaveCount(2);
    await expect(historyB.locator(`option[value="${rebuildA.id}"]`)).toHaveCount(0);
    await historyB.selectOption(rebuildB.id);
    await expect(page.getByTestId('status-BLOCKED')).toBeVisible();
    await expect(page.getByText('project-b-report', { exact: false })).toBeVisible();

    await page.reload();
    await page.getByLabel('研究项目').selectOption(projectB);
    await expect(page.getByLabel('历史重建（可选）')).toBeVisible();
    await page.getByLabel('历史重建（可选）').selectOption(rebuildB.id);
    await expect(page.getByTestId('status-BLOCKED')).toBeVisible();
    expect(rebuildRequests).toBe(0);
  } finally {
    releaseSpecA();
  }
});

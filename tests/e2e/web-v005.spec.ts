import { createReadStream } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { openWorkspace } from './workspace';

async function createConsoleProject(page: Page, name: string): Promise<string> {
  await page.request.get('/api/session');
  const response = await page.request.post('/api/projects', { data: { name, kind: 'console', authorizationConfirmed: true } });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json() as { id: string }).id;
}

async function createCompletedFileTask(page: Page, projectName: string, content = JSON.stringify({ name: 'v005-report-fixture', version: 1 })): Promise<{ projectId: string; taskId: string }> {
  await page.request.get('/api/session');
  const projectResponse = await page.request.post('/api/projects', { data: { name: projectName, kind: 'software', authorizationConfirmed: true } });
  expect(projectResponse.ok(), await projectResponse.text()).toBe(true);
  const project = await projectResponse.json() as { id: string };
  const upload = await page.request.post(`/api/projects/${project.id}/uploads`, {
    multipart: { file: { name: 'v005-report.json', mimeType: 'application/json', buffer: Buffer.from(content) } },
  });
  expect(upload.ok(), await upload.text()).toBe(true);
  const taskResponse = await page.request.post(`/api/projects/${project.id}/tasks`, { data: { adapter: 'file' } });
  expect(taskResponse.ok(), await taskResponse.text()).toBe(true);
  const task = await taskResponse.json() as { id: string };
  await expect.poll(async () => {
    const response = await page.request.get(`/api/tasks/${task.id}`);
    const detail = await response.json() as { status: string; error?: string };
    return `${detail.status}:${detail.error ?? ''}`;
  }, { timeout: 90_000, intervals: [500, 1000, 2000] }).toMatch(/^COMPLETED:/);
  return { projectId: project.id, taskId: task.id };
}

test('wizard creates and executes a real authorized plan', async ({ page }) => {
  await openWorkspace(page, '/wizard');
  await expect(page.getByRole('heading', { name: '开始智能分析' })).toBeVisible();
  await page.screenshot({ path: 'docs/assets/v005-wizard.png', fullPage: true });
  await page.getByRole('button', { name: /专业模式/ }).click();
  await page.getByRole('button', { name: /分析软件/ }).click();
  await page.getByLabel('项目名称').fill(`v005 向导 ${Date.now()}`);
  await page.getByLabel('分析文件').setInputFiles({ name: 'wizard-sample.txt', mimeType: 'text/plain', buffer: Buffer.from('v005 wizard fixture') });
  await page.getByRole('checkbox', { name: /我确认拥有该目标或已获得明确授权/ }).check();
  await page.getByRole('button', { name: '创建并执行计划' }).click();
  await expect(page.getByText('计划已创建', { exact: true })).toBeVisible();
  await expect(page.getByText('计划已交给 Worker 执行')).toBeVisible();
  await expect(page.getByRole('link', { name: '查看计划' })).toBeVisible();
  await page.getByRole('link', { name: '查看计划' }).click();
  await expect(page).toHaveURL(/\/plans\/[^/]+$/);
  await expect(page.getByRole('heading', { name: '计划详情' })).toBeVisible();
  await expect(page.getByText('执行步骤', { exact: true })).toBeVisible();
  await expect(page.getByText('资源预算', { exact: true })).toBeVisible();
});

test('console lab saves an evidence-backed host profile and computes C1', async ({ page }) => {
  const projectId = await createConsoleProject(page, `v005 主机档案 ${Date.now()}`);
  await openWorkspace(page, `/console-lab/${projectId}`);
  await expect(page.getByRole('heading', { name: '游戏主机分析' })).toBeVisible();
  await expect(page.getByText('能力矩阵', { exact: true })).toBeVisible();
  await page.getByLabel('硬件版本').fill('REV-2026-01');
  await page.getByLabel('系统版本').fill('TEST-ONLY');
  await page.getByRole('button', { name: '添加证据' }).click();
  await page.getByRole('button', { name: '添加证据' }).click();
  await page.getByLabel('证据 1 来源').fill('官方规格页');
  await page.getByLabel('证据 1 描述').fill('公开型号与版本说明');
  await page.getByLabel('证据 2 类型').selectOption('IDENTITY');
  await page.getByLabel('证据 2 来源').fill('设备标签照片');
  await page.getByLabel('证据 2 描述').fill('用户自有设备型号记录');
  await page.getByRole('button', { name: '保存档案并计算等级' }).click();
  await expect(page.getByText('档案已保存；后端根据证据计算等级为 C1。')).toBeVisible();
  await expect(page.getByText('用户记录', { exact: true })).toHaveCount(2);
  await expect(page.getByText(/C1 仅表示已记录身份与官方资料/)).toBeVisible();
  await page.screenshot({ path: 'docs/assets/v005-console-lab.png', fullPage: true });
  const response = await page.request.get(`/api/projects/${projectId}/console-profile`);
  expect(response.ok(), await response.text()).toBe(true);
  const body = await response.json() as { profile: { currentLevel: string; researchEvidence: unknown[] } };
  expect(body.profile.currentLevel).toBe('C1');
  expect(body.profile.researchEvidence).toHaveLength(2);
});

test('demo entry creates a real task without simulated progress', async ({ page }) => {
  await openWorkspace(page, '/demos');
  await expect(page.getByRole('heading', { name: '内置演示' })).toBeVisible();
  const card = page.locator('section').filter({ hasText: '自制 UF2 固件分析' });
  await expect(card.getByRole('button', { name: '一键运行' })).toBeVisible();
  await card.getByRole('button', { name: '一键运行' }).click();
  await expect(page.getByText('演示任务已创建', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: /真实进度/ })).toBeVisible();
  await expect(page.getByRole('link', { name: '查看项目' })).toBeVisible();
});

test('report page switches between user and professional views and exports markdown', async ({ page }) => {
  const fixture = await createCompletedFileTask(page, `v005 报告 ${Date.now()}`);
  await openWorkspace(page, '/reports');
  await expect(page.getByRole('heading', { name: '分析报告' })).toBeVisible();
  await page.getByLabel('报告任务').selectOption(fixture.taskId);
  await expect(page.getByRole('tab', { name: '普通用户视图' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('heading', { name: '通俗分析报告' })).toBeVisible();
  await page.screenshot({ path: 'docs/assets/v005-report.png', fullPage: true });
  await page.getByRole('tab', { name: '专业视图' }).click();
  await expect(page.getByText('阶段轨迹', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: /工具日志/ })).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 Markdown' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^report-.*\.md$/);
});

test('report opened while running polls until the real task reaches a terminal state', async ({ page }) => {
  await page.request.get('/api/session');
  const projectResponse = await page.request.post('/api/projects', { data: { name: `v005 running report ${Date.now()}`, kind: 'website', target: 'http://127.0.0.1:3199/', authorizationConfirmed: true } });
  expect(projectResponse.ok(), await projectResponse.text()).toBe(true);
  const project = await projectResponse.json() as { id: string };
  const response = await page.request.post(`/api/projects/${project.id}/tasks`, { data: { adapter: 'website', options: { allowLocal: true, confirmLocal: true, interactionSettleMs: 5000 } } });
  expect(response.ok(), await response.text()).toBe(true);
  const { id: taskId } = await response.json() as { id: string };
  const running = await page.request.get(`/api/tasks/${taskId}`);
  expect((await running.json() as { status: string }).status).toMatch(/QUEUED|RUNNING/);
  let reportRequests = 0;
  await page.route('**/api/tasks/*/report/plain*', async route => {
    reportRequests += 1;
    const result = await route.fetch();
    if (reportRequests === 1) await new Promise(resolve => setTimeout(resolve, 2500));
    await route.fulfill({ response: result });
  });
  await openWorkspace(page, '/reports');
  await page.getByLabel('报告任务').selectOption(taskId);
  await expect(page.getByRole('heading', { name: '通俗分析报告' })).toBeVisible();
  await expect(page.getByTestId('status-COMPLETED')).toBeVisible({ timeout: 90_000 });
  await expect.poll(() => reportRequests, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
});

test('report API failure shows a retryable error', async ({ page }) => {
  await page.route('**/api/tasks/*/report/plain*', route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: '报告服务暂不可用' } }) }));
  await openWorkspace(page, '/reports');
  await expect(page.getByRole('alert')).toContainText('无法完成报告读取');
  await expect(page.getByRole('alert')).toContainText('报告服务暂不可用');
});

test('HTML export downloads a real report and report HTML-like text is rendered as text', async ({ page }) => {
  const payload = '<img src=x onerror="window.__v005Xss=1"><script>window.__v005Xss=2</script>';
  const fixture = await createCompletedFileTask(page, `${payload} ${Date.now()}`);
  await openWorkspace(page, '/reports');
  await page.getByLabel('报告任务').selectOption(fixture.taskId);
  await expect(page.getByRole('heading', { name: '通俗分析报告' })).toBeVisible();
  await expect(page.locator('article')).toContainText('<script>window.__v005Xss=2</script>');
  expect(await page.locator('article img, article script').count()).toBe(0);
  expect(await page.evaluate(() => (window as Window & { __v005Xss?: number }).__v005Xss)).toBeUndefined();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 HTML' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^report-.*\.html$/);
  const path = await download.path();
  expect(path).toBeTruthy();
  const chunks: Buffer[] = [];
  for await (const chunk of createReadStream(path!)) chunks.push(Buffer.from(chunk));
  const html = Buffer.concat(chunks).toString('utf8');
  expect(html).toMatch(/<html|<!doctype html/i);
  expect(html).not.toContain('<script>window.__v005Xss=2</script>');
  expect(html).toContain('&lt;script&gt;window.__v005Xss=2&lt;/script&gt;');
});

test('first run requires explicit safety confirmation and settings retains the notice', async ({ page }) => {
  await page.goto('/');
  const confirmation = page.getByLabel('确认已阅读并理解安全提示');
  await expect(confirmation).toBeVisible();
  await expect(page.getByRole('button', { name: /下一步：选择场景/ })).toBeDisabled();
  await expect(page.getByRole('button', { name: '关闭首次使用引导' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(confirmation).toBeVisible();
  await confirmation.check();
  await page.getByRole('button', { name: /下一步：选择场景/ }).click();
  await page.getByRole('button', { name: '关闭首次使用引导' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await openWorkspace(page, '/settings');
  await page.getByRole('button', { name: '重新查看安全提示' }).click();
  await expect(page.getByRole('dialog', { name: '开始前，请了解这些限制' })).toBeVisible();
  await expect(page.getByRole('dialog', { name: '开始前，请了解这些限制' })).toContainText('隐私边界');
});

test('dashboard reflects remote AI data permission from settings', async ({ page }) => {
  let allowRemoteData = false;
  await page.route('**/api/settings', route => route.fulfill({ json: { enabled: true, baseUrl: 'https://model.example/v1', model: 'test-model', hasApiKey: true, allowRemoteData } }));
  await openWorkspace(page, '/');
  await expect(page.getByText('AI 已启用 · 远程共享未允许', { exact: true }).first()).toBeVisible();
  allowRemoteData = true;
  await page.reload();
  await expect(page.getByText('远程 AI 已允许发送摘要', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('本地运行 · 数据不出机', { exact: true })).toHaveCount(0);
});

test('wizard retry resumes completed creation steps instead of duplicating them', async ({ page }) => {
  await openWorkspace(page, '/wizard');
  await page.getByRole('button', { name: /分析软件/ }).click();
  await page.getByLabel('项目名称').fill(`v005 重试 ${Date.now()}`);
  await page.getByLabel('分析文件').setInputFiles({ name: 'retry.txt', mimeType: 'text/plain', buffer: Buffer.from('retry fixture') });
  await page.getByRole('checkbox', { name: /我确认拥有该目标或已获得明确授权/ }).check();
  let planAttempts = 0;
  const counts = { projects: 0, uploads: 0, authorizations: 0 };
  await page.route('**/api/projects', route => { if (route.request().method() === 'POST') counts.projects += 1; return route.continue(); });
  await page.route('**/api/projects/*/uploads', route => { counts.uploads += 1; return route.continue(); });
  await page.route('**/api/projects/*/authorizations', route => { counts.authorizations += 1; return route.continue(); });
  await page.route('**/api/projects/*/plans', route => {
    planAttempts += 1;
    if (planAttempts === 1) return route.fulfill({ status: 500, json: { error: { code: 'INTERNAL_ERROR', message: '计划服务暂时失败' } } });
    return route.continue();
  });
  await page.getByRole('button', { name: '创建并执行计划' }).click();
  await expect(page.getByRole('alert')).toContainText('计划服务暂时失败');
  await page.getByRole('button', { name: '重试' }).click();
  await expect(page.getByText('计划已创建', { exact: true })).toBeVisible();
  expect(counts).toEqual({ projects: 1, uploads: 1, authorizations: 1 });
  expect(planAttempts).toBe(2);
});

test('console profile background refetch does not overwrite dirty edits', async ({ page }) => {
  const projectId = await createConsoleProject(page, `v005 dirty ${Date.now()}`);
  let profileReads = 0;
  await page.route(`**/api/projects/${projectId}/console-profile`, async route => {
    profileReads += 1;
    const response = await route.fetch();
    if (profileReads > 1 && response.ok()) {
      const body = await response.json() as { profile: { hardwareVersion: string } };
      body.profile.hardwareVersion = 'BACKGROUND-VALUE';
      await route.fulfill({ response, json: body });
    } else await route.fulfill({ response });
  });
  await openWorkspace(page, `/console-lab/${projectId}`);
  await page.getByLabel('硬件版本').fill('UNSAVED-VALUE');
  await expect(page.getByText(/档案有未保存修改/)).toBeVisible();
  await page.evaluate(() => { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('visibilitychange')); });
  await expect.poll(() => profileReads, { timeout: 15_000 }).toBeGreaterThan(1);
  await expect(page.getByLabel('硬件版本')).toHaveValue('UNSAVED-VALUE');
});

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { openWorkspace } from './workspace';

test('Autopilot 首页、动态需求回答与交付空态使用真实 API', async ({ page }) => {
  await page.request.get('/api/session');
  const projectName = `Autopilot E2E ${Date.now()}`;
  const created = await page.request.post('/api/projects', { data: { name: projectName, kind: 'software', authorizationConfirmed: true } });
  expect(created.ok(), await created.text()).toBe(true);
  const projectId = (await created.json() as { id: string }).id;

  await openWorkspace(page, '/');
  await expect(page.getByRole('heading', { name: '把想法交给 Autopilot' })).toBeVisible();
  await page.getByLabel('工作项目').selectOption(projectId);
  await page.getByLabel('描述你的目标').fill('分析这个旧软件，评估兼容运行方式并输出报告');
  const taskResponsePromise = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/api/autopilot/tasks'));
  await page.getByRole('button', { name: '发送', exact: true }).click();
  const taskResponse = await taskResponsePromise;
  expect(taskResponse.status(), await taskResponse.text()).toBe(201);
  const task = await taskResponse.json() as { id: string };
  await expect(page).toHaveURL(new RegExp(`/autopilot/${task.id}$`));

  const samplePath = path.resolve('examples/legacy-samples/ini-editor/sample.ini');
  await expect(page.getByRole('heading', { name: '请提供分析目标或目标 URL。' })).toBeVisible({ timeout: 30_000 });
  await page.getByLabel('请提供分析目标或目标 URL。').fill(samplePath);
  await page.getByRole('button', { name: '继续', exact: true }).click();

  await expect(page.getByRole('heading', { name: '请提供可用的材料。' })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('textbox', { name: '请提供可用的材料。' }).fill(samplePath);
  await page.getByRole('button', { name: '继续', exact: true }).click();

  await expect(page.getByRole('heading', { name: '目标平台是什么？' })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Windows', exact: true }).click();
  await page.getByRole('button', { name: '继续', exact: true }).click();

  await expect(page.getByRole('heading', { name: '是否授权对上述目标执行只读分析，并写入任务私有工件？' })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: /^授权/ }).click();
  await page.getByRole('button', { name: '继续', exact: true }).click();

  await expect(page.getByRole('heading', { name: '确认目标契约' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('等待确认', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: '确认契约并生成计划' }).click();
  await expect(page.getByRole('heading', { name: '确认执行计划' })).toBeVisible({ timeout: 30_000 });

  await page.goto('/delivery');
  await page.getByLabel('交付项目').selectOption(projectId);
  await expect(page.getByRole('heading', { name: '交付中心' })).toBeVisible();
  await expect(page.getByText('还没有可展示的交付', { exact: true })).toBeVisible();
});

test('模型管理读取真实 Provider API 且密钥只写不返显', async ({ page }) => {
  await openWorkspace(page, '/models');
  await expect(page.getByRole('heading', { name: '模型管理' })).toBeVisible();
  await expect(page.getByText('V4 PROVIDER API', { exact: true })).toBeVisible();
  await expect(page.getByText(/API Key 仅写入，绝不返显/)).toBeVisible();
  await page.getByRole('button', { name: '新增', exact: true }).click();
  await page.getByLabel('名称', { exact: true }).fill('E2E Local Provider');
  await page.getByLabel('Base URL', { exact: true }).fill('http://127.0.0.1:11434/v1');
  await page.getByLabel('模型', { exact: true }).fill('e2e-model');
  await page.getByRole('textbox', { name: /^API Key/ }).fill('sk-e2e-write-only-secret');
  await page.getByRole('button', { name: '保存 Provider 与角色路由' }).click();
  await expect(page.getByRole('button', { name: /E2E Local Provider/ })).toBeVisible();
  await expect(page.getByRole('textbox', { name: /^API Key/ })).toHaveValue('');
  await expect(page.getByRole('textbox', { name: /^API Key/ })).toHaveAttribute('placeholder', /已配置/);
  await expect(page.getByText('sk-e2e-write-only-secret', { exact: true })).toHaveCount(0);
});

test('完成态交付中心展示真实工件、SHA256、教程、验收并支持全部下载', async ({ page }) => {
  await page.request.get('/api/session');
  const projectResponse = await page.request.post('/api/projects', { data: { name: `Autopilot Delivery ${Date.now()}`, kind: 'software', authorizationConfirmed: true } });
  expect(projectResponse.ok(), await projectResponse.text()).toBe(true);
  const projectId = (await projectResponse.json() as { id: string }).id;
  const uploaded = await page.request.post(`/api/projects/${projectId}/uploads`, { multipart: { file: { name: 'sample.ini', mimeType: 'text/plain', buffer: await readFile(path.resolve('examples/legacy-samples/ini-editor/sample.ini')) } } });
  expect(uploaded.ok(), await uploaded.text()).toBe(true);
  const uploadId = (await uploaded.json() as { id: string }).id;
  const created = await page.request.post('/api/autopilot/tasks', { data: { projectId, prompt: '分析这个旧软件，评估 Windows 兼容运行方式并输出报告', uploadIds: [uploadId], idempotencyKey: `delivery-${Date.now()}` } });
  expect(created.status(), await created.text()).toBe(201);
  let task = await created.json() as { id: string; status: string; contract: unknown; plan: unknown };
  expect(task.status).toBe('WAITING_FOR_USER');

  const permission = await page.request.post(`/api/autopilot/tasks/${task.id}/answers`, { data: { answers: { 'permission.authorization': true, authorizationConfirmed: true } } });
  expect(permission.ok(), await permission.text()).toBe(true);
  task = await permission.json() as typeof task;
  expect(task.status).toBe('WAITING_FOR_APPROVAL');
  expect(task.contract).toBeTruthy();

  const contract = await page.request.post(`/api/autopilot/tasks/${task.id}/answers`, { data: { answers: {}, approveContract: true } });
  expect(contract.ok(), await contract.text()).toBe(true);
  task = await contract.json() as typeof task;
  expect(task.status).toBe('WAITING_FOR_APPROVAL');
  expect(task.plan).toBeTruthy();

  const plan = await page.request.post(`/api/autopilot/tasks/${task.id}/answers`, { data: { answers: {}, approveContract: true, approvePlan: true } });
  expect(plan.ok(), await plan.text()).toBe(true);
  task = await plan.json() as typeof task;
  expect(['PLANNING', 'RUNNING']).toContain(task.status);

  await expect.poll(async () => {
    const response = await page.request.get(`/api/autopilot/tasks/${task.id}`);
    const current = await response.json() as { status: string };
    return current.status;
  }, { timeout: 120_000, intervals: [500, 1000, 2000] }).toMatch(/^(COMPLETED|PARTIAL_SUCCESS|FAILED|BLOCKED|CANCELLED)$/);
  const finished = await page.request.get(`/api/autopilot/tasks/${task.id}`);
  const finishedTask = await finished.json() as { status: string; error: string | null };
  expect(finishedTask.status, finishedTask.error ?? 'Autopilot task failed without details').toMatch(/^(COMPLETED|PARTIAL_SUCCESS)$/);

  const artifactsResponse = await page.request.get(`/api/autopilot/tasks/${task.id}/artifacts`);
  expect(artifactsResponse.ok(), await artifactsResponse.text()).toBe(true);
  const artifacts = await artifactsResponse.json() as Array<{ name: string; sha256: string }>;
  expect(artifacts.length).toBeGreaterThan(0);
  expect(artifacts.every(item => /^[a-f0-9]{64}$/.test(item.sha256))).toBe(true);
  for (const artifact of artifacts) {
    const artifactResponse = await page.request.get(`/api/autopilot/tasks/${task.id}/artifacts/${encodeURIComponent(artifact.name)}`);
    expect(artifactResponse.ok(), `${artifact.name}: ${await artifactResponse.text()}`).toBe(true);
    expect(createHash('sha256').update(await artifactResponse.body()).digest('hex')).toBe(artifact.sha256);
  }

  await openWorkspace(page, `/delivery/${task.id}`);
  await expect(page.getByRole('heading', { name: '交付摘要' })).toBeVisible();
  for (const name of ['START-HERE.md', '使用教程.md', 'ARTIFACT-MANIFEST.json', 'reports__ACCEPTANCE.json', 'SHA256SUMS.txt']) {
    await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
  }
  await expect(page.getByText(/sha256: [a-f0-9]{64}/).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: '教程与使用说明' })).toBeVisible();
  await expect(page.locator('pre').filter({ hasText: '检查交付包' }).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: '独立验收' })).toBeVisible();
  await expect(page.getByText(/DELIVERABLE_(VERIFIED|PARTIAL)/).first()).toBeVisible();

  const downloadCount = await page.locator('a[download]').count();
  expect(downloadCount).toBeGreaterThan(0);
  const downloads: string[] = [];
  page.on('download', download => downloads.push(download.suggestedFilename()));
  await page.getByRole('button', { name: '全部下载' }).click();
  await expect(page.getByText(`已触发 ${downloadCount} 个文件下载。若浏览器拦截多文件下载，请允许此站点继续，或使用逐文件下载。`, { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => downloads.length, { timeout: 30_000 }).toBeGreaterThan(0);
  expect(downloads).toContain('START-HERE.md');
});

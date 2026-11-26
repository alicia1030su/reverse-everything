import path from 'node:path';
import { expect, test } from '@playwright/test';
import { openWorkspace } from './workspace';

test('legacy studio recovers real data through the shared task engine', async ({ page }) => {
  await page.request.get('/api/session');
  const created = await page.request.post('/api/projects', { data: { name: `V007 Legacy ${Date.now()}`, kind: 'software', authorizationConfirmed: true } });
  expect(created.ok(), await created.text()).toBe(true);
  const projectId = (await created.json() as { id: string }).id;
  await openWorkspace(page, '/legacy-studio');
  await expect(page.getByRole('heading', { name: '古老软件复活实验室' })).toBeVisible();
  await expect(page.getByText(/不执行原程序/)).toBeVisible();
  await page.getByLabel('软件项目').selectOption(projectId);
  await page.getByLabel('本机软件目录 / 文件').fill(path.resolve('examples/legacy-samples/ini-editor/sample.ini'));
  const responsePromise = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith(`/api/projects/${projectId}/tasks`));
  await page.getByRole('button', { name: '恢复我的数据' }).click();
  const response = await responsePromise;
  expect(response.status(), await response.text()).toBe(201);
  const task = await response.json() as { id: string };
  await expect(page.getByText(`任务 ${task.id}`)).toBeVisible();
  await expect(page.getByText('recovery-manifest.json')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('link', { name: /recovery-manifest.json/ })).toHaveAttribute('href', `/api/tasks/${task.id}/artifacts/recovery-manifest.json`);
  await page.screenshot({ path: 'docs/assets/v007-legacy-studio.png', fullPage: true });
});

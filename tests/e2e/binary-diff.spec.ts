import { expect, test } from '@playwright/test';
import { openWorkspace } from './workspace';

test('binary diff workbench renders evidence boundaries', async ({ page }) => {
  await openWorkspace(page, '/binary-diff');
  await expect(page.getByRole('heading', { name: '二进制差异分析' })).toBeVisible();
  await expect(page.getByText('匹配结果属于 INFERENCE', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: '开始比较' })).toBeDisabled();
});

import type { Page } from '@playwright/test';

const onboardingKey = 'reverse-everything:onboarding:v1';

export async function openWorkspace(page: Page, path = '/new'): Promise<void> {
  await page.addInitScript(({ key }) => {
    window.localStorage.setItem(key, JSON.stringify({ completed: true }));
  }, { key: onboardingKey });
  await page.goto(path);
}

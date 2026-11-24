import { defineConfig } from '@playwright/test';

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

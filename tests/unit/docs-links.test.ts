import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('documentation integrity', () => {
  it('resolves every local Markdown link and image', () => {
    const output = execFileSync(process.execPath, ['scripts/check-docs.mjs'], { encoding: 'utf8' });
    expect(output).toMatch(/Checked \d+ local documentation links/);
  });

  it('ships the project-owned brand assets', async () => {
    const { access } = await import('node:fs/promises');
    for (const file of ['docs/assets/logo.svg', 'docs/assets/banner.svg', 'docs/assets/workflow.svg']) await access(file);
  });
});

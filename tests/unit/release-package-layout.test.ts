import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const launcher = 'scripts/ghidra-analyze-headless.mjs';

function adapterLauncher(adapter: string) {
  return new URL('../../../../' + launcher, pathToFileURL(adapter));
}

describe('Ghidra release package layout', () => {
  it('places the launcher at the path resolved by the packaged server adapter', async () => {
    const source = await readFile('scripts/package-server.mjs', 'utf8');
    const serverAdapter = path.resolve('dist/release/server/packages/core/dist/adapters/ghidra.js');
    expect(adapterLauncher(serverAdapter).href).toBe(pathToFileURL(path.resolve('dist/release/server', launcher)).href);
    expect(source).toContain("path.join(root,'scripts/ghidra-analyze-headless.mjs')");
    expect(source).toContain("path.join(stage,'scripts/ghidra-analyze-headless.mjs')");
    expect(source).toContain("'packages/hardware'");
    expect(source).toContain("'packages/firmware'");
  });

  it('places the launcher at the path resolved by the desktop runtime adapter', async () => {
    const source = await readFile('scripts/package-runtime.mjs', 'utf8');
    const desktopAdapter = path.resolve('dist/desktop-runtime/node_modules/@reverse/core/dist/adapters/ghidra.js');
    expect(adapterLauncher(desktopAdapter).href).toBe(pathToFileURL(path.resolve('dist/desktop-runtime/node_modules', launcher)).href);
    expect(source).toContain("path.join(out,'scripts')");
    expect(source).toContain("path.join(out,'scripts/ghidra-analyze-headless.mjs')");
    expect(source).toContain("path.join(path.dirname(out),'scripts')");
  });

  it('copies both runtime launcher layouts into desktop extraResources', async () => {
    const config = await readFile('apps/desktop/electron-builder.yml', 'utf8');
    expect(config).toMatch(/from:\s*\.\.\/\.\.\/dist\/desktop-runtime\/scripts\s+to:\s*scripts/);
    expect(config).toMatch(/from:\s*\.\.\/\.\.\/dist\/desktop-runtime\/node_modules\s+to:\s*node_modules/);
  });
});

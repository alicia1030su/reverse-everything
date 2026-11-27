import { readFile, readdir } from 'node:fs/promises';
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
    expect(source).toContain("'packages/console'");
    expect(source).toContain("'packages/planner'");
    expect(source).toContain("'packages/program-ir'");
    expect(source).toContain("'packages/game-revival'");
  });

  it('copies Autopilot into the standalone server and declares every direct workspace import', async () => {
    const source = await readFile('scripts/package-server.mjs', 'utf8');
    const apiPackage = JSON.parse(await readFile('apps/api/package.json', 'utf8')) as { dependencies: Record<string, string> };
    const apiSources = await readdir('apps/api/src', { recursive: true });
    expect(source).toContain("'packages/autopilot'");
    expect(source).toContain("'packages/program-ir'");
    expect(source).toContain("'packages/program-semantics'");
    for (const file of apiSources.filter(file => String(file).endsWith('.ts'))) {
      const text = await readFile(path.join('apps/api/src', String(file)), 'utf8');
      for (const match of text.matchAll(/from '(@reverse\/[^']+)'/g)) {
        expect(apiPackage.dependencies[match[1]], `${file} imports ${match[1]}`).toBe('0.0.8');
      }
    }
  });

  it('declares and resolves Program IR as a core production dependency', async () => {
    const corePackage = JSON.parse(await readFile('packages/core/package.json', 'utf8')) as { dependencies: Record<string, string> };
    expect(corePackage.dependencies['@reverse/program-ir']).toBe('0.0.8');
    const source = await readFile('scripts/package-runtime.mjs', 'utf8');
    expect(source).toContain("'packages/program-ir'");
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

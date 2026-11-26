import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { VERSION as CLI_VERSION } from '../../apps/cli/src/version.js';

const root = process.cwd();
async function json(file: string) {
  return JSON.parse(await readFile(path.join(root, file), 'utf8')) as Record<string, unknown>;
}
async function workspaceManifests() {
  const files = ['package.json'];
  for (const parent of ['apps', 'packages']) {
    for (const entry of await readdir(path.join(root, parent), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        await readFile(path.join(root, parent, entry.name, 'package.json'));
        files.push(parent + '/' + entry.name + '/package.json');
      } catch {
        // Non-package directories are not workspaces.
      }
    }
  }
  return Promise.all(files.map(async file => ({ file, pkg: await json(file) })));
}

describe('version single source', () => {
  it('keeps every workspace and internal dependency on the root version', async () => {
    const rootPackage = await json('package.json');
    const version = (await readFile(path.join(root, 'VERSION'), 'utf8')).trim();
    expect(rootPackage.version).toBe(version);
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    for (const { file, pkg } of await workspaceManifests()) {
      expect(pkg.version, file).toBe(version);
      for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
        for (const [name, dependencyVersion] of Object.entries((pkg[field] ?? {}) as Record<string, unknown>)) {
          if (name.startsWith('@reverse/')) expect(dependencyVersion, file + ':' + name).toBe(version);
        }
      }
    }
  });

  it('builds every internal dependency before its dependent workspace', async () => {
    const rootPackage = await json('package.json');
    const build = String(rootPackage.scripts?.build ?? '');
    const order = [...build.matchAll(/npm run build -w (@reverse\/[a-z0-9-]+)/g)].map(match => match[1]);
    expect(new Set(order).size).toBe(order.length);
    for (const { file, pkg } of await workspaceManifests()) {
      const name = String(pkg.name ?? '');
      if (!name.startsWith('@reverse/')) continue;
      const dependentIndex = order.indexOf(name);
      if (dependentIndex < 0) {
        expect(pkg.scripts?.build, `${file} has a build script and must be present in the root build script`).toBeUndefined();
        continue;
      }
      for (const dependency of Object.keys((pkg.dependencies ?? {}) as Record<string, unknown>)) {
        if (!dependency.startsWith('@reverse/')) continue;
        const dependencyIndex = order.indexOf(dependency);
        if (dependencyIndex < 0) {
          const dependencyManifest = (await workspaceManifests()).find(item => item.pkg.name === dependency);
          expect(dependencyManifest?.pkg.scripts?.build, `${file}: ${dependency} has a build script and must be present before ${name}`).toBeUndefined();
          continue;
        }
        expect(dependencyIndex, `${file}: ${dependency} must build before ${name}`).toBeLessThan(dependentIndex);
      }
    }
  });

  it('keeps lockfile workspace versions and CLI build version aligned', async () => {
    const rootPackage = await json('package.json');
    const lock = await json('package-lock.json');
    const packages = lock.packages as Record<string, { version?: string; dependencies?: Record<string, string> }>;
    expect(lock.version).toBe(rootPackage.version);
    expect(packages['']?.version).toBe(rootPackage.version);
    for (const [key, value] of Object.entries(packages)) {
      if (new RegExp('^(apps|packages)/[^/]+$').test(key)) expect(value.version, key).toBe(rootPackage.version);
      for (const [name, dependencyVersion] of Object.entries(value.dependencies ?? {})) {
        if (name.startsWith('@reverse/')) expect(dependencyVersion, key + ':' + name).toBe(rootPackage.version);
      }
    }
    expect(CLI_VERSION).toBe(rootPackage.version);
    const contracts = await readFile(path.join(root, 'packages/contracts/src/index.ts'), 'utf8');
    expect(contracts).toContain("export const VERSION = '" + rootPackage.version + "'");
  });
});

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
    const version = rootPackage.version;
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

import { cp, readFile, writeFile } from 'node:fs/promises';
import { resetGeneratedDirectory } from './reset-generated-dir.mjs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

function resolveLockedPackage(rootLock, from, name) {
  if (name.startsWith('@reverse/')) throw new Error(`Standalone CLI cannot depend on unpublished workspace package: ${name}`);
  let current = from;
  while (true) {
    const candidate = current && current !== '.' ? `${current}/node_modules/${name}` : `node_modules/${name}`;
    if (rootLock.packages?.[candidate]) return candidate;
    if (!current || current === '.') return undefined;
    const parent = path.posix.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export function buildCliShrinkwrap(rootLock, cliPackage) {
  const dependencies = Object.fromEntries(Object.entries(cliPackage.dependencies ?? {}).filter(([name]) => !name.startsWith('@reverse/')).map(([name]) => {
    const version = rootLock.packages?.[`node_modules/${name}`]?.version;
    if (typeof version !== 'string' || !version) throw new Error(`CLI dependency is not locked: ${name}`);
    return [name, version];
  }));
  const packages = {
    '': {
      name: 'reverse-everything-cli',
      version: cliPackage.version,
      dependencies,
    },
  };
  const queue = Object.keys(dependencies).map(name => `node_modules/${name}`);
  const seen = new Set();
  while (queue.length) {
    const location = queue.shift();
    if (seen.has(location)) continue;
    seen.add(location);
    const locked = rootLock.packages?.[location];
    if (!locked) throw new Error(`CLI dependency closure is not locked: ${location}`);
    const entry = { ...locked };
    delete entry.dev;
    packages[location] = entry;
    const required = Object.keys(entry.dependencies ?? {});
    const optional = Object.keys(entry.optionalDependencies ?? {}).filter(name => resolveLockedPackage(rootLock, location, name));
    const peers = Object.keys(entry.peerDependencies ?? {}).filter(name => entry.peerDependenciesMeta?.[name]?.optional !== true);
    for (const name of [...required, ...optional, ...peers]) {
      const resolved = resolveLockedPackage(rootLock, location, name);
      if (resolved) queue.push(resolved);
      else if (!optional.includes(name)) throw new Error(`CLI transitive dependency is not locked: ${name} from ${location}`);
    }
  }
  return {
    name: 'reverse-everything-cli',
    version: cliPackage.version,
    lockfileVersion: 3,
    requires: true,
    packages,
  };
}

async function main() {
  const root = process.cwd();
  const rootPackage = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const rootLock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
  const cliPackage = JSON.parse(await readFile(path.join(root, 'apps/cli/package.json'), 'utf8'));
  const shrinkwrap = buildCliShrinkwrap(rootLock, cliPackage);
  const stage = path.join(root, 'dist/release/cli');
  await resetGeneratedDirectory(stage, path.join(root, 'dist/release'), 'cli');
  await cp(path.join(root, 'apps/cli/dist'), path.join(stage, 'dist'), { recursive: true });
  for (const file of ['LICENSE', 'NOTICE']) await cp(path.join(root, file), path.join(stage, file));
  const pkg = {
    name: 'reverse-everything-cli',
    version: rootPackage.version,
    description: 'Reverse Everything CLI and MCP client',
    license: 'Apache-2.0',
    type: 'module',
    engines: { node: '>=22.13.0' },
    files: ['dist', 'README.md', 'LICENSE', 'NOTICE', 'npm-shrinkwrap.json'],
    bin: { 'reverse-everything': 'dist/cli.js', 'reverse-mcp': 'dist/mcp.js', reverse: 'dist/cli.js' },
    dependencies: shrinkwrap.packages[''].dependencies,
  };
  await writeFile(path.join(stage, 'package.json'), JSON.stringify(pkg, null, 2));
  await writeFile(path.join(stage, 'README.md'), '# Reverse Everything CLI ' + rootPackage.version + '\n\nRequires Node.js 22.13+. Install globally, then run reverse-everything --help. The CLI and MCP client use the local API token from RE_DATA_DIR or RE_API_TOKEN.\n');
  await writeFile(path.join(stage, 'npm-shrinkwrap.json'), JSON.stringify(shrinkwrap, null, 2) + '\n');
  const result = spawnSync('npm', ['pack', '--ignore-scripts', '--pack-destination', path.join(root, 'dist/release')], { cwd: stage, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) process.exit(result.status ?? 1);
  console.log('CLI TGZ created: ' + rootPackage.version);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();

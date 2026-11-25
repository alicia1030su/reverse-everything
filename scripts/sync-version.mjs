import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const check = process.argv.includes('--check');
const version = (await readFile(path.join(root, 'VERSION'), 'utf8')).trim();
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('VERSION must contain a stable semantic version');

async function manifests() {
  const files = ['package.json'];
  for (const parent of ['apps', 'packages']) {
    for (const entry of await readdir(path.join(root, parent), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        await readFile(path.join(root, parent, entry.name, 'package.json'));
        files.push(path.posix.join(parent, entry.name, 'package.json'));
      } catch {
        // Not a workspace package.
      }
    }
  }
  return files;
}

function alignPackage(pkg) {
  pkg.version = version;
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const name of Object.keys(pkg[field] ?? {})) {
      if (name.startsWith('@reverse/')) pkg[field][name] = version;
    }
  }
}

const files = await manifests();
const packages = [];
for (const file of files) {
  const pkg = JSON.parse(await readFile(path.join(root, file), 'utf8'));
  alignPackage(pkg);
  packages.push({ file, pkg });
}

const lockFile = 'package-lock.json';
const lock = JSON.parse(await readFile(path.join(root, lockFile), 'utf8'));
lock.version = version;
if (lock.packages?.['']) alignPackage(lock.packages['']);
for (const [key, pkg] of Object.entries(lock.packages ?? {})) {
  if (/^(apps|packages)\/[^/]+$/.test(key)) alignPackage(pkg);
}

const contractsFile = path.join(root, 'packages/contracts/src/index.ts');
const contracts = await readFile(contractsFile, 'utf8');
const alignedContracts = contracts.replace(/export const VERSION = '[^']+' as const;/, `export const VERSION = '${version}' as const;`);
if (alignedContracts === contracts && !contracts.includes(`export const VERSION = '${version}' as const;`)) throw new Error('contracts VERSION declaration not found');

const outputs = [
  ...packages.map(({ file, pkg }) => ({ file, content: JSON.stringify(pkg, null, 2) + '\n' })),
  { file: lockFile, content: JSON.stringify(lock, null, 2) + '\n' },
  { file: 'packages/contracts/src/index.ts', content: alignedContracts },
];

if (check) {
  const mismatches = [];
  for (const output of outputs) {
    const current = await readFile(path.join(root, output.file), 'utf8');
    if (current !== output.content) mismatches.push(output.file);
  }
  if (mismatches.length) {
    console.error(`Version drift: ${mismatches.join(', ')}`);
    process.exitCode = 1;
  } else {
    console.log(`Version ${version} is synchronized across ${outputs.length} files`);
  }
} else {
  for (const output of outputs) await writeFile(path.join(root, output.file), output.content, 'utf8');
  console.log(`Synchronized version ${version} across ${outputs.length} files`);
}

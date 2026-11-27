import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = (await readFile(path.join(root, 'VERSION'), 'utf8')).trim();
const errors = [];
if (!/^\d+\.\d+\.\d+$/.test(version)) errors.push('VERSION must contain a stable semantic version');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (pkg.version !== version) errors.push(`package.json version ${pkg.version} does not match VERSION ${version}`);

const claims = {
  'README.md': [
    /`legacy` 老软件/,
    /`legacy` adapter/,
    /`RE_LEGACY_ROOTS`/,
    /`RE_GAME_ROOTS`/,
    /共 \*\*44 个工具\*\*/,
  ],
  'README.en.md': [
    /`legacy` \|/,
    /`legacy` adapter/,
    /`RE_LEGACY_ROOTS`/,
    /`RE_GAME_ROOTS`/,
    /expose \*\*44 tools\*\*/,
  ],
};

let stableRelease;
for (const file of ['README.md', 'README.en.md']) {
  const text = await readFile(path.join(root, file), 'utf8');
  const require = pattern => {
    if (!pattern.test(text)) errors.push(`${file}: missing expected declaration ${pattern}`);
  };
  require(new RegExp(`\\*\\*[^*]*· v${version.replaceAll('.', '\\.')}\\*\\*`));
  require(file === 'README.md'
    ? new RegExp(`^## v${version.replaceAll('.', '\\.')}`, 'm')
    : new RegExp(`^## What is new in v${version.replaceAll('.', '\\.')}`, 'm'));
  require(new RegExp(`release-v${version.replaceAll('.', '\\.')}-`, 'i'));
  require(/releases\/(?:tag\/v\d+\.\d+\.\d+|latest)\)/);
  for (const pattern of claims[file]) require(pattern);

  const downloads = text.match(/releases\/download\/v(\d+\.\d+\.\d+)\/([^)\s]+)/g) ?? [];
  if (!downloads.length) errors.push(`${file}: no pinned release asset download URLs found`);
  if (/releases\/latest\/download\//.test(text)) errors.push(`${file}: downloads must use fixed release tags, not latest/download`);
  const stable = text.match(/current stable v(\d+\.\d+\.\d+)/i)?.[1]
    ?? text.match(/当前稳定版 v(\d+\.\d+\.\d+)/)?.[1];
  if (!stable) errors.push(`${file}: explicitly declare the current stable release version`);
  else if (stableRelease && stableRelease !== stable) errors.push('README files disagree about the current stable release');
  else stableRelease = stable;
  if (stable === version) {
    if (!/releases\/tag\/v\d+\.\d+\.\d+/.test(text)) errors.push(`${file}: published release link is missing`);
    if (!/45912292229/.test(text)) errors.push(`${file}: official release run evidence is missing`);
  }
  for (const download of downloads) {
    const pinned = download.match(/releases\/download\/v(\d+\.\d+\.\d+)\//)?.[1];
    const asset = download.split('/').at(-1);
    if (!stable || pinned !== stable || !new RegExp(`-${stable.replaceAll('.', '\\.')}(?:[.-])`).test(asset)) {
      errors.push(`${file}: download tag/asset version is inconsistent with stable v${stable}: ${download}`);
    }
  }
}

const roadmap = await readFile(path.join(root, 'docs/ROADMAP.md'), 'utf8');
if (!stableRelease || !new RegExp(`^## v${stableRelease.replaceAll('.', '\\.')}：.*（已发布）`, 'm').test(roadmap)) errors.push('docs/ROADMAP.md: current stable release must be marked published');
const contracts = await readFile(path.join(root, 'packages/contracts/src/index.ts'), 'utf8');
const schema = contracts.match(/SCHEMA_VERSION\s*=\s*(\d+)/)?.[1];
if (!schema) errors.push('packages/contracts/src/index.ts: SCHEMA_VERSION not found');
const upgrade = await readFile(path.join(root, 'docs/user-guide/UPGRADE.md'), 'utf8');
const releasedSchemas = { '0.0.7': '6' };
const releasedSchema = releasedSchemas[stableRelease];
if (!releasedSchema) errors.push(`Update releasedSchemas with the verified Schema for stable v${stableRelease}`);
if (releasedSchema && !upgrade.split('\n').slice(0, 5).join('\n').includes(`Schema ${releasedSchema}`)) errors.push(`docs/user-guide/UPGRADE.md: released Schema ${releasedSchema} is not documented`);
if (schema && !upgrade.includes(`Schema ${schema}`) && !new RegExp(`schemaVersion=${schema}`).test(upgrade)) errors.push(`docs/user-guide/UPGRADE.md: development Schema ${schema} migration is not documented`);
const known = await readFile(path.join(root, 'docs/development/KNOWN-ISSUES.md'), 'utf8');
for (const stale of [/无 Ghidra 反编译/, /不解压 APK\/DEX/, /独立 Skill 包未发布/, /跨任务缓存未实现/, /自动内存熔断[^\n]*尚未实现/]) {
  if (stale.test(known)) errors.push(`docs/development/KNOWN-ISSUES.md: stale limitation remains: ${stale}`);
}
const tests = await readFile(path.join(root, 'docs/development/V007-TEST-RESULTS.md'), 'utf8');
for (const evidence of ['a54871a57e68aa0833a1636b79cf98e15bcd7cbe', '45910219157', '784', '783', '28 passed / 1 skipped', '29 passed']) {
  if (!tests.includes(evidence)) errors.push(`docs/development/V007-TEST-RESULTS.md: missing frozen evidence ${evidence}`);
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`README consistency passed for v${version}: badges, releases, downloads, capabilities and VERSION`);
}

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HISTORICAL_SKIP_COVERAGE = Object.freeze([
  { file: 'tests/unit/deep-adapters.test.ts', name: 'accepts the all-in-one CLI jar layout from an external JADX home', target: 'android', workflow: '.github/workflows/android-v004.yml', evidence: 'RE_RUN_ANDROID_REAL=1 and real JADX verification' },
  { file: 'tests/unit/deep-adapters.test.ts', name: 'rejects symbolic links in JADX output without following them', target: 'ubuntu', required: true },
  { file: 'tests/unit/android-real.test.ts', name: 'runs pinned real JADX and compares Java, method, string, manifest and resource outputs', target: 'android', workflow: '.github/workflows/android-v004.yml', evidence: 'RE_RUN_ANDROID_REAL=1 and pinned JADX archive' },
  { file: 'tests/unit/windows-file-safety.test.ts', name: 'rejects a final-component symbolic-link reparse point', target: 'windows', required: true },
  { file: 'tests/unit/artifact-read-safety.test.ts', name: 'rejects symbolic links without reading their target', target: 'ubuntu', required: true },
  { file: 'tests/unit/hardware-enumerate.test.ts', name: 'classifies sysfs permission denial as BLOCKED', target: 'ubuntu', required: true },
  { file: 'tests/unit/upload-read-safety.test.ts', name: 'rejects a symbolic-link upload instead of following it', target: 'ubuntu', required: true },
  { file: 'tests/integration/api-safety.test.ts', name: 'refuses project deletion through a linked parent component', target: 'ubuntu', required: true },
  { file: 'tests/integration/api-safety.test.ts', name: 'never serves an artifact path that was replaced with a symbolic link', target: 'ubuntu', required: true },
]);

export const REQUIRED_SAFETY_TESTS = Object.freeze(HISTORICAL_SKIP_COVERAGE.filter(item => item.required).map(({ file, name, target }) => ({ file, name, target })));

export function verifySkipCoverageWorkflows(workflows) {
  const errors = [];
  for (const [file, patterns] of Object.entries({
    '.github/workflows/ci.yml': [
      /os:\s*\[ubuntu-latest,\s*windows-latest\]/,
      /npm test -- --reporter=json --outputFile=/,
      /node scripts\/check-skip-coverage\.mjs --platform \$\{\{ matrix\.os \}\}/,
    ],
    '.github/workflows/android-v004.yml': [
      /RE_RUN_ANDROID_REAL:\s*1/,
      /node scripts\/verify-jadx\.mjs --check-fixture/,
      /tests\/unit\/android-real\.test\.ts tests\/unit\/deep-adapters\.test\.ts/,
    ],
    '.github/workflows/ghidra-v004.yml': [
      /node scripts\/verify-ghidra\.mjs/,
      /os:\s*ubuntu-latest[\s\S]*os:\s*windows-latest/,
    ],
  })) {
    const source = workflows[file];
    if (typeof source !== 'string') errors.push(`Skip coverage workflow is missing: ${file}`);
    else for (const pattern of patterns) if (!pattern.test(source)) errors.push(`Skip coverage gate is missing in ${file}: ${pattern}`);
  }
  return errors;
}

export function verifySkipCoverageReport(report, platform) {
  if (platform !== 'ubuntu-latest' && platform !== 'windows-latest') return ['--platform must be ubuntu-latest or windows-latest'];
  if (!report || !Array.isArray(report.testResults)) return ['Vitest JSON report must contain testResults'];
  const target = platform === 'ubuntu-latest' ? 'ubuntu' : 'windows';
  const assertions = report.testResults.flatMap(file => (file.assertionResults ?? []).map(test => ({ ...test, file: file.name })));
  const errors = [];
  for (const required of REQUIRED_SAFETY_TESTS.filter(item => item.target === target)) {
    const matches = assertions.filter(test => test.file?.replaceAll('\\', '/').endsWith(required.file) && (test.fullName === required.name || test.title === required.name || test.fullName?.endsWith(' > ' + required.name)));
    if (matches.length !== 1 || matches[0].status !== 'passed') errors.push(`Required ${target} safety test must pass exactly once, not skip: ${required.file} :: ${required.name}`);
  }
  return errors;
}

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log('Usage: node scripts/check-skip-coverage.mjs [--platform <ubuntu-latest|windows-latest> --report <vitest.json>]');
    return;
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const files = [...new Set(['.github/workflows/ci.yml', '.github/workflows/android-v004.yml', '.github/workflows/ghidra-v004.yml'])];
  const workflows = Object.fromEntries(await Promise.all(files.map(async file => [file, await readFile(path.join(root, file), 'utf8')])));
  const errors = verifySkipCoverageWorkflows(workflows);
  const platform = argument('platform');
  const reportPath = argument('report');
  if (Boolean(platform) !== Boolean(reportPath)) errors.push('--platform and --report must be supplied together');
  if (platform && reportPath) errors.push(...verifySkipCoverageReport(JSON.parse(await readFile(path.resolve(reportPath), 'utf8')), platform));
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(`Skip coverage verified: ${HISTORICAL_SKIP_COVERAGE.length} historical skips mapped to Ubuntu, Windows or real-tool workflows${platform ? `; required ${platform} safety tests passed` : ''}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}

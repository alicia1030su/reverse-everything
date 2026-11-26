import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HISTORICAL_SKIP_COVERAGE, REQUIRED_SAFETY_TESTS, verifySkipCoverageReport, verifySkipCoverageWorkflows } from '../../scripts/check-skip-coverage.mjs';

const report = (tests: Array<{ file: string; name: string; status: string }>) => ({
  testResults: tests.map(test => ({
    name: path.resolve(test.file),
    assertionResults: [{ fullName: `suite > ${test.name}`, title: test.name, status: test.status }],
  })),
});

describe('historical skip coverage gate', () => {
  it('maps exactly nine historical skips to Ubuntu, Windows or real-tool jobs', () => {
    expect(HISTORICAL_SKIP_COVERAGE).toHaveLength(9);
    expect(HISTORICAL_SKIP_COVERAGE.filter(item => item.target === 'ubuntu')).toHaveLength(6);
    expect(HISTORICAL_SKIP_COVERAGE.filter(item => item.target === 'windows')).toHaveLength(1);
    expect(HISTORICAL_SKIP_COVERAGE.filter(item => item.target === 'android' || item.target === 'ghidra')).toHaveLength(2);
    expect(REQUIRED_SAFETY_TESTS).toHaveLength(7);
    expect(HISTORICAL_SKIP_COVERAGE.find(item => item.name === 'rejects symbolic links in JADX output without following them')).toMatchObject({ target: 'ubuntu', required: true });
  });

  it('requires CI matrix, JSON reports and real JADX/Ghidra workflow evidence', async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const files = ['.github/workflows/ci.yml', '.github/workflows/android-v004.yml', '.github/workflows/ghidra-v004.yml'];
    const workflows = Object.fromEntries(await Promise.all(files.map(async file => [file, await readFile(path.join(root, file), 'utf8')])));
    expect(verifySkipCoverageWorkflows(workflows)).toEqual([]);
    expect(verifySkipCoverageWorkflows({ ...workflows, '.github/workflows/ci.yml': workflows['.github/workflows/ci.yml'].replace('os: [ubuntu-latest, windows-latest]', 'os: [ubuntu-latest]') }).join('\n')).toMatch(/Skip coverage gate is missing/);
    expect(verifySkipCoverageWorkflows({ ...workflows, '.github/workflows/android-v004.yml': workflows['.github/workflows/android-v004.yml'].replace('RE_RUN_ANDROID_REAL: 1', 'RE_RUN_ANDROID_REAL: 0') }).join('\n')).toMatch(/android-v004/);
  });

  it('accepts required Ubuntu safety tests only when every one passed', () => {
    const tests = REQUIRED_SAFETY_TESTS.filter(item => item.target === 'ubuntu').map(item => ({ file: item.file, name: item.name, status: 'passed' }));
    expect(verifySkipCoverageReport(report(tests), 'ubuntu-latest')).toEqual([]);
    expect(verifySkipCoverageReport(report(tests.slice(1)), 'ubuntu-latest').join('\n')).toMatch(/must pass exactly once, not skip/);
    expect(verifySkipCoverageReport(report(tests.map((test, index) => index === 0 ? { ...test, status: 'skipped' } : test)), 'ubuntu-latest').join('\n')).toMatch(/must pass exactly once, not skip/);
  });

  it('accepts the required Windows reparse-point test only when it passed', () => {
    const required = REQUIRED_SAFETY_TESTS.find(item => item.target === 'windows')!;
    expect(verifySkipCoverageReport(report([{ ...required, status: 'passed' }]), 'windows-latest')).toEqual([]);
    expect(verifySkipCoverageReport(report([{ ...required, status: 'skipped' }]), 'windows-latest').join('\n')).toMatch(/not skip/);
    expect(verifySkipCoverageReport(report([]), 'windows-latest').join('\n')).toMatch(/not skip/);
  });

  it('rejects missing reports, invalid platforms and duplicate passing records', () => {
    expect(verifySkipCoverageReport(null, 'ubuntu-latest')).toEqual(['Vitest JSON report must contain testResults']);
    expect(verifySkipCoverageReport(report([]), 'darwin')).toEqual(['--platform must be ubuntu-latest or windows-latest']);
    const required = REQUIRED_SAFETY_TESTS.find(item => item.target === 'windows')!;
    expect(verifySkipCoverageReport(report([{ ...required, status: 'passed' }, { ...required, status: 'passed' }]), 'windows-latest').join('\n')).toMatch(/exactly once/);
  });
});

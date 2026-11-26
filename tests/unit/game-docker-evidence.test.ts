import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { REQUIRED_DOCKER_CHECK_IDS, REQUIRED_NATIVE_CHECK_IDS, verifyGameDockerEvidence, verifyGameDockerEvidenceFiles } from '../../scripts/verify-game-docker-evidence.mjs';

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

function validEvidence() {
  return {
    project: 'revival-evidence-test',
    timeoutMs: 300000,
    commands: [{ command: 'docker compose version', output: 'Docker Compose version v2.0.0' }],
    cleanedUp: true,
    healthcheck: { containerId: 'container-id', status: 'healthy', httpStatus: 200 },
    websocket: { roomId: 'room-id', players: ['player0', 'player1'], authenticated: 2 },
    admin: { deniedStatus: 401, stats: { genre: 'fps' } },
  };
}

function validReport() {
  const evidence = validEvidence();
  return {
    schemaVersion: 1,
    genre: 'fps',
    gameMode: 'team-deathmatch',
    transport: 'websocket',
    valid: true,
    errors: [],
    clients: [{ kind: 'real-game-client', count: 4 }],
    capabilities: {
      build: true,
      independentStart: true,
      twoPlayerSameMatch: true,
      roomIsolation: true,
      serverAuthoritativeState: true,
      persistence: true,
      reconnect: true,
      settlement: true,
      adminAuth: true,
      multiRoomConcurrency: true,
      dockerDeployment: true,
    },
    deployment: { docker: { tested: true, command: 'docker compose up --build -d', evidence: JSON.stringify(evidence) } },
    files: ['Dockerfile', 'docker-compose.yml', 'SHA256SUMS.txt'],
    sha256: 'a'.repeat(64),
    checks: [...REQUIRED_NATIVE_CHECK_IDS, ...REQUIRED_DOCKER_CHECK_IDS].map(id => ({ id, name: id, passed: true, detail: 'passed' })),
    projectDir: '/tmp/generated-game',
    startedAt: '2026-11-26T10:00:00.000Z',
    finishedAt: '2026-11-26T10:01:00.000Z',
  };
}

function validSums() {
  return `${'a'.repeat(64)}  Dockerfile\n${'b'.repeat(64)}  docker-compose.yml\n`;
}

async function evidenceFiles() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'game-docker-evidence-test-'));
  temporary.push(directory);
  const reportPath = path.join(directory, 'docker-validation.json');
  const evidencePath = path.join(directory, 'docker-deployment-evidence.json');
  const sumsPath = path.join(directory, 'SHA256SUMS.txt');
  const sums = validSums();
  const report = { ...validReport(), sha256: createHash('sha256').update(sums).digest('hex') };
  await writeFile(reportPath, JSON.stringify(report));
  await writeFile(evidencePath, JSON.stringify(validEvidence()));
  await writeFile(sumsPath, sums);
  return { reportPath, evidencePath, sumsPath, report };
}

describe('独立 Docker 发行证据校验', () => {
  it('接受完整且通过的真实 Docker 证据', () => {
    expect(verifyGameDockerEvidence(validReport(), validEvidence(), { genre: 'fps' })).toEqual([]);
  });

  it('拒绝空对象和缺失字段', () => {
    expect(verifyGameDockerEvidence({}, {})).toEqual(expect.arrayContaining([
      'Docker report schemaVersion must be 1',
      'Docker report errors must be an array',
      'Docker report files must be a non-empty string array',
      'Docker report sha256 must be a full SHA-256 digest',
      'Docker evidence cleanedUp must be true',
      'Docker evidence healthcheck must contain a healthy container and HTTP 200',
      'Docker evidence websocket must contain at least two unique authenticated players',
      'Docker evidence admin must contain deniedStatus 401 and matching genre stats',
    ]));
    expect(verifyGameDockerEvidence(validReport(), undefined)).toContain('Docker evidence must be an object');
    expect(verifyGameDockerEvidence(undefined, validEvidence())).toEqual(['Docker report must be an object']);
  });

  it.each([
    ['cleanedUp', false],
    ['healthcheck', { containerId: 'container-id', status: 'unhealthy', httpStatus: 200 }],
    ['websocket', { roomId: 'room-id', players: ['player0'], authenticated: 1 }],
    ['admin', { deniedStatus: 403, stats: { genre: 'fps' } }],
    ['project', ''],
    ['timeoutMs', 0],
    ['commands', []],
  ])('拒绝不合格的 %s 证据', (key, value) => {
    const evidence = { ...validEvidence(), [key]: value };
    expect(verifyGameDockerEvidence(validReport(), evidence).join('\n')).toMatch(new RegExp(`Docker evidence ${key}`));
  });

  it('拒绝非空 errors 和任何失败 check，即使汇总字段为 true', () => {
    const report = validReport();
    report.errors = ['npm ci failed'];
    expect(verifyGameDockerEvidence(report, validEvidence())).toContain('Docker report errors must be empty');
    const failed = validReport();
    failed.checks.push({ id: 'install', name: 'npm ci', passed: false, detail: 'failed' });
    expect(verifyGameDockerEvidence(failed, validEvidence())).toContain('Docker report check must pass: install');
  });

  it('拒绝只有 Docker check 而缺少构建、联机、持久化与重连证据的报告', () => {
    const report = validReport();
    report.checks = report.checks.filter(check => REQUIRED_DOCKER_CHECK_IDS.includes(check.id));
    expect(verifyGameDockerEvidence(report, validEvidence())).toEqual(expect.arrayContaining(
      REQUIRED_NATIVE_CHECK_IDS.map(id => `Docker report check must pass exactly once: ${id}`),
    ));
  });

  it('要求每个必需 Docker check 存在且恰好通过一次', () => {
    for (const id of REQUIRED_DOCKER_CHECK_IDS) {
      const missing = validReport();
      missing.checks = missing.checks.filter(check => check.id !== id);
      expect(verifyGameDockerEvidence(missing, validEvidence())).toContain(`Docker report check must pass exactly once: ${id}`);
      const failed = validReport();
      failed.checks = failed.checks.map(check => check.id === id ? { ...check, passed: false } : check);
      expect(verifyGameDockerEvidence(failed, validEvidence())).toContain(`Docker report check must pass exactly once: ${id}`);
      const duplicated = validReport();
      duplicated.checks.push({ id, passed: true });
      expect(verifyGameDockerEvidence(duplicated, validEvidence())).toContain(`Docker report check must pass exactly once: ${id}`);
    }
  });

  it('拒绝缺失的 check 字段、重复 ID 和缺失 capability', () => {
    const report = validReport();
    report.checks[0] = { id: 'docker-available', passed: true };
    delete report.capabilities.build;
    expect(verifyGameDockerEvidence(report, validEvidence())).toEqual(expect.arrayContaining([
      'Docker report check name must be a non-empty string: docker-available',
      'Docker report check detail must be a string: docker-available',
      'Docker report capability must be true: build',
    ]));
    const duplicate = validReport();
    duplicate.checks.push({ ...duplicate.checks[0] });
    expect(verifyGameDockerEvidence(duplicate, validEvidence())).toContain(`Docker report check id must be unique: ${duplicate.checks[0].id}`);
  });

  it('拒绝 embedded deployment evidence 缺失、非法或与独立证据不一致', () => {
    const missing = validReport();
    delete missing.deployment.docker.evidence;
    expect(verifyGameDockerEvidence(missing, validEvidence())).toContain('Docker report deployment.docker.evidence must be a non-empty JSON string');
    const malformed = validReport();
    malformed.deployment.docker.evidence = '{';
    expect(verifyGameDockerEvidence(malformed, validEvidence())).toContain('Docker report deployment.docker.evidence must be valid JSON');
    const mismatch = validReport();
    mismatch.deployment.docker.evidence = JSON.stringify({ ...validEvidence(), cleanedUp: false });
    expect(verifyGameDockerEvidence(mismatch, validEvidence())).toContain('Docker report embedded deployment evidence must match independent evidence');
  });

  it('校验报告 schema、files、sha 与类型身份', () => {
    const report = validReport();
    report.schemaVersion = 2;
    report.files = [];
    report.sha256 = 'not-a-digest';
    expect(verifyGameDockerEvidence(report, validEvidence()).join('\n')).toMatch(/schemaVersion[\s\S]*files[\s\S]*sha256/);
    expect(verifyGameDockerEvidence(validReport(), validEvidence(), { genre: 'rpg' })).toContain('Docker report genre must be rpg');
  });

  it('CLI 拒绝缺失证据并返回非零退出码', () => {
    const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/verify-game-docker-evidence.mjs');
    const result = spawnSync(process.execPath, [script, '--genre', 'fps', '--report', 'missing-report.json', '--evidence', 'missing-evidence.json', '--sums', 'missing-sums.txt'], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unable to read Docker report');
    expect(result.stderr).not.toContain('--genre must be');
  });

  it('从文件读取时拒绝缺失或非法 JSON', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'game-docker-evidence-test-'));
    temporary.push(directory);
    const reportPath = path.join(directory, 'docker-validation.json');
    const evidencePath = path.join(directory, 'docker-deployment-evidence.json');
    const sumsPath = path.join(directory, 'SHA256SUMS.txt');
    expect((await verifyGameDockerEvidenceFiles({ reportPath, evidencePath, sumsPath, genre: 'fps' })).join('\n')).toContain('Unable to read Docker report');
    await writeFile(reportPath, JSON.stringify(validReport()));
    expect((await verifyGameDockerEvidenceFiles({ reportPath, evidencePath, sumsPath, genre: 'fps' })).join('\n')).toContain('Unable to read Docker evidence');
    await writeFile(evidencePath, '{}');
    await writeFile(sumsPath, validSums());
    expect(await verifyGameDockerEvidenceFiles({ reportPath, evidencePath, sumsPath, genre: 'fps' })).toEqual(expect.arrayContaining(['Docker evidence cleanedUp must be true']));
    await writeFile(reportPath, '{');
    expect((await verifyGameDockerEvidenceFiles({ reportPath, evidencePath, sumsPath, genre: 'fps' })).join('\n')).toContain('Unable to read Docker report');
  });

  it('要求 SHA256SUMS 路径并按上传文件的实际字节验证 sha256', async () => {
    expect(await verifyGameDockerEvidenceFiles({ reportPath: 'report', evidencePath: 'evidence', genre: 'fps' })).toEqual(['SHA256SUMS path is required']);
    const files = await evidenceFiles();
    expect(await verifyGameDockerEvidenceFiles({ ...files, genre: 'fps' })).toEqual([]);
    await writeFile(files.sumsPath, validSums() + '\n');
    expect((await verifyGameDockerEvidenceFiles({ ...files, genre: 'fps' })).join('\n')).toContain('sha256 does not match SHA256SUMS content');
  });

  it('拒绝缺失、格式非法或与 report.files 不一致的 SHA256SUMS', async () => {
    const files = await evidenceFiles();
    await rm(files.sumsPath);
    expect((await verifyGameDockerEvidenceFiles({ ...files, genre: 'fps' })).join('\n')).toContain('Unable to read SHA256SUMS');
    await writeFile(files.sumsPath, 'not-a-checksum\n');
    const report = { ...files.report, sha256: createHash('sha256').update('not-a-checksum\n').digest('hex') };
    await writeFile(files.reportPath, JSON.stringify(report));
    expect((await verifyGameDockerEvidenceFiles({ ...files, genre: 'fps' })).join('\n')).toMatch(/invalid format[\s\S]*entries must match/);
  });

  it('CLI 接受实际 SHA256SUMS 与报告哈希一致的完整证据', async () => {
    const files = await evidenceFiles();
    const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/verify-game-docker-evidence.mjs');
    const result = spawnSync(process.execPath, [script, '--genre', 'fps', '--report', files.reportPath, '--evidence', files.evidencePath, '--sums', files.sumsPath], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, genre: 'fps', sha256: files.report.sha256 });
  });
});

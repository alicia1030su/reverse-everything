import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

export const REQUIRED_DOCKER_CHECK_IDS = Object.freeze([
  'docker-available',
  'docker-up',
  'docker-health',
  'docker-admin-auth',
  'docker-ws-two-players',
  'docker-cleanup',
]);

export const REQUIRED_NATIVE_CHECK_IDS = Object.freeze([
  'checksums',
  'install',
  'build',
  'unit-tests',
  'independent-start',
  'admin-auth',
  'authentication',
  'room-isolation',
  'authoritative-state',
  'gameplay-settlement',
  'reconnect',
  'persistence-restart',
]);

const REQUIRED_CAPABILITIES = Object.freeze([
  'build',
  'independentStart',
  'twoPlayerSameMatch',
  'roomIsolation',
  'serverAuthoritativeState',
  'persistence',
  'reconnect',
  'settlement',
  'adminAuth',
  'multiRoomConcurrency',
  'dockerDeployment',
]);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isTimestamp(value) {
  return isNonEmptyString(value) && Number.isFinite(Date.parse(value));
}

/** 独立校验真实 Docker 报告与部署证据，不信任 report.valid 等汇总字段。 */
export function verifyGameDockerEvidence(report, evidence, { genre } = {}) {
  if (!isRecord(report)) return ['Docker report must be an object'];
  const errors = [];
  if (!isRecord(evidence)) errors.push('Docker evidence must be an object');
  if (report.schemaVersion !== 1) errors.push('Docker report schemaVersion must be 1');
  if (report.genre !== 'fps' && report.genre !== 'rpg') errors.push('Docker report genre must be fps or rpg');
  if (genre && report.genre !== genre) errors.push(`Docker report genre must be ${genre}`);
  if (!isNonEmptyString(report.gameMode)) errors.push('Docker report gameMode must be a non-empty string');
  if (report.transport !== 'websocket') errors.push('Docker report transport must be websocket');
  if (report.valid !== true) errors.push('Docker report valid must be true');
  if (!Array.isArray(report.errors)) errors.push('Docker report errors must be an array');
  else if (report.errors.length > 0) errors.push('Docker report errors must be empty');
  if (!isRecord(report.capabilities)) {
    errors.push('Docker report capabilities must be an object');
  } else {
    for (const capability of REQUIRED_CAPABILITIES) {
      if (report.capabilities[capability] !== true) errors.push(`Docker report capability must be true: ${capability}`);
    }
  }
  if (!isRecord(report.deployment) || !isRecord(report.deployment.docker)) {
    errors.push('Docker report deployment.docker must be an object');
  } else {
    const docker = report.deployment.docker;
    if (docker.tested !== true) errors.push('Docker report deployment.docker.tested must be true');
    if (!isNonEmptyString(docker.command)) errors.push('Docker report deployment.docker.command must be a non-empty string');
    if (!isNonEmptyString(docker.evidence)) errors.push('Docker report deployment.docker.evidence must be a non-empty JSON string');
  }
  if (!Array.isArray(report.files) || report.files.length === 0 || report.files.some(file => !isNonEmptyString(file))) {
    errors.push('Docker report files must be a non-empty string array');
  } else {
    if (!report.files.includes('SHA256SUMS.txt')) errors.push('Docker report files must include SHA256SUMS.txt');
    if (new Set(report.files).size !== report.files.length) errors.push('Docker report files must not contain duplicates');
  }
  if (typeof report.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(report.sha256)) errors.push('Docker report sha256 must be a full SHA-256 digest');
  if (!isNonEmptyString(report.projectDir)) errors.push('Docker report projectDir must be a non-empty string');
  if (!isTimestamp(report.startedAt)) errors.push('Docker report startedAt must be a valid timestamp');
  if (!isTimestamp(report.finishedAt)) errors.push('Docker report finishedAt must be a valid timestamp');
  if (!Array.isArray(report.clients) || report.clients.length === 0 || report.clients.some(client => !isRecord(client)
    || !['internal-protocol-client', 'simulated-load', 'original-game-client'].includes(client.kind)
    || !Number.isSafeInteger(client.count) || client.count < 0)) {
    errors.push('Docker report clients must be a non-empty client array');
  }
  if (!isRecord(report.targetEvidence)
    || !['UNKNOWN', 'OBSERVED', 'VERIFIED'].includes(report.targetEvidence.behavior)
    || !['UNKNOWN', 'VERIFIED'].includes(report.targetEvidence.originalClient)
    || !['UNKNOWN', 'VERIFIED'].includes(report.targetEvidence.protocol)) {
    errors.push('Docker report targetEvidence must separately grade behavior, original client and protocol');
  }
  if (report.targetEvidence?.originalClient === 'VERIFIED' && !report.clients?.some(client => client.kind === 'original-game-client' && client.count > 0)) {
    errors.push('Original client VERIFIED requires an original-game-client evidence entry');
  }
  if (!Array.isArray(report.checks)) {
    errors.push('Docker report checks must be an array');
  } else {
    if (report.checks.length === 0) errors.push('Docker report checks must not be empty');
    const ids = new Set();
    for (const [index, check] of report.checks.entries()) {
      if (!isRecord(check)) {
        errors.push(`Docker report check must be an object: ${index}`);
        continue;
      }
      if (!isNonEmptyString(check.id)) errors.push(`Docker report check id must be a non-empty string: ${index}`);
      else if (ids.has(check.id)) errors.push(`Docker report check id must be unique: ${check.id}`);
      else ids.add(check.id);
      if (!isNonEmptyString(check.name)) errors.push(`Docker report check name must be a non-empty string: ${check.id ?? index}`);
      if (typeof check.detail !== 'string') errors.push(`Docker report check detail must be a string: ${check.id ?? index}`);
      if (check.passed !== true) errors.push(`Docker report check must pass: ${check.id ?? index}`);
    }
    for (const id of [...REQUIRED_NATIVE_CHECK_IDS, ...REQUIRED_DOCKER_CHECK_IDS]) {
      const matches = report.checks.filter(check => isRecord(check) && check.id === id);
      if (matches.length !== 1 || matches[0].passed !== true) errors.push(`Docker report check must pass exactly once: ${id}`);
    }
  }

  if (isRecord(evidence)) {
    if (!isNonEmptyString(evidence.project)) errors.push('Docker evidence project must be a non-empty string');
    if (!Number.isSafeInteger(evidence.timeoutMs) || evidence.timeoutMs < 1000 || evidence.timeoutMs > 900000) errors.push('Docker evidence timeoutMs must be an integer in 1000..900000');
    if (!Array.isArray(evidence.commands) || evidence.commands.length === 0 || evidence.commands.some(command => !isRecord(command) || !isNonEmptyString(command.command) || typeof command.output !== 'string')) {
      errors.push('Docker evidence commands must be a non-empty command/output array');
    }
    if (evidence.cleanedUp !== true) errors.push('Docker evidence cleanedUp must be true');
    if (!isRecord(evidence.healthcheck) || !isNonEmptyString(evidence.healthcheck.containerId)
      || evidence.healthcheck.status !== 'healthy' || evidence.healthcheck.httpStatus !== 200) {
      errors.push('Docker evidence healthcheck must contain a healthy container and HTTP 200');
    }
    if (!isRecord(evidence.websocket) || !isNonEmptyString(evidence.websocket.roomId)
      || !Array.isArray(evidence.websocket.players) || evidence.websocket.players.length < 2
      || evidence.websocket.players.some(player => !isNonEmptyString(player))
      || new Set(evidence.websocket.players).size !== evidence.websocket.players.length
      || evidence.websocket.authenticated !== evidence.websocket.players.length) {
      errors.push('Docker evidence websocket must contain at least two unique authenticated players');
    }
    if (!isRecord(evidence.admin) || evidence.admin.deniedStatus !== 401 || !isRecord(evidence.admin.stats)
      || evidence.admin.stats.genre !== report.genre) {
      errors.push('Docker evidence admin must contain deniedStatus 401 and matching genre stats');
    }

    if (isRecord(report.deployment) && isRecord(report.deployment.docker) && isNonEmptyString(report.deployment.docker.evidence)) {
      try {
        const embedded = JSON.parse(report.deployment.docker.evidence);
        if (!isDeepStrictEqual(embedded, evidence)) errors.push('Docker report embedded deployment evidence must match independent evidence');
      } catch {
        errors.push('Docker report deployment.docker.evidence must be valid JSON');
      }
    }
  }
  return errors;
}

export async function verifyGameDockerEvidenceFiles({ reportPath, evidencePath, sumsPath, genre }) {
  if (!sumsPath) return ['SHA256SUMS path is required'];
  let report;
  let evidence;
  let sums;
  try {
    report = JSON.parse(await readFile(reportPath, 'utf8'));
  } catch (error) {
    return [`Unable to read Docker report ${reportPath}: ${error instanceof Error ? error.message : String(error)}`];
  }
  try {
    evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
  } catch (error) {
    return [`Unable to read Docker evidence ${evidencePath}: ${error instanceof Error ? error.message : String(error)}`];
  }
  try {
    sums = await readFile(sumsPath);
  } catch (error) {
    return [`Unable to read SHA256SUMS ${sumsPath}: ${error instanceof Error ? error.message : String(error)}`];
  }
  const errors = verifyGameDockerEvidence(report, evidence, { genre });
  const actualSha256 = createHash('sha256').update(sums).digest('hex');
  if (report?.sha256 !== actualSha256) errors.push(`Docker report sha256 does not match SHA256SUMS content: expected ${actualSha256}`);
  const lines = sums.toString('utf8').split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  const listedFiles = [];
  for (const [index, line] of lines.entries()) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    if (!match) {
      errors.push(`SHA256SUMS line ${index + 1} has an invalid format`);
      continue;
    }
    const relative = match[2];
    if (path.posix.isAbsolute(relative) || relative.split('/').some(part => !part || part === '.' || part === '..') || relative.includes('\\')) {
      errors.push(`SHA256SUMS line ${index + 1} has an unsafe path`);
      continue;
    }
    listedFiles.push(relative);
  }
  if (Array.isArray(report?.files)) {
    const expectedFiles = report.files.filter(file => file !== 'SHA256SUMS.txt').sort();
    if (!isDeepStrictEqual([...listedFiles].sort(), expectedFiles)) errors.push('SHA256SUMS entries must match Docker report files');
  }
  return errors;
}

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`--${name} requires a value`);
  return value;
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log('Usage: node scripts/verify-game-docker-evidence.mjs --genre <fps|rpg> --report <docker-validation.json> --evidence <docker-deployment-evidence.json> --sums <SHA256SUMS.txt>');
    return;
  }
  const allowed = new Set(['--genre', '--report', '--evidence', '--sums', '--help']);
  const unknown = process.argv.slice(2).find(value => value.startsWith('--') && !allowed.has(value));
  if (unknown) throw new Error(`Unknown argument: ${unknown}`);
  const genre = argument('genre');
  const reportPath = argument('report');
  const evidencePath = argument('evidence');
  const sumsPath = argument('sums');
  if (genre !== 'fps' && genre !== 'rpg') throw new Error('--genre must be fps or rpg');
  if (!reportPath || !evidencePath || !sumsPath) throw new Error('--report, --evidence and --sums are required');
  const errors = await verifyGameDockerEvidenceFiles({ reportPath: path.resolve(reportPath), evidencePath: path.resolve(evidencePath), sumsPath: path.resolve(sumsPath), genre });
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(JSON.stringify({ ok: true, genre, sha256: createHash('sha256').update(await readFile(sumsPath)).digest('hex'), requiredChecks: [...REQUIRED_NATIVE_CHECK_IDS, ...REQUIRED_DOCKER_CHECK_IDS] }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGameServerSpec, generateGameServer, scanGameDirectory, validateGeneratedServer } from '../packages/game-revival/dist/index.js';
import { verifyGameDockerEvidenceFiles } from './verify-game-docker-evidence.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} 缺少值`);
  return value;
};
const genre = option('--genre', '');
if (genre !== 'fps' && genre !== 'rpg') throw new Error('用法: node scripts/validate-game-docker.mjs --genre <fps|rpg> [--output <dir>]');
const output = path.resolve(root, option('--output', path.join('.artifacts', `game-docker-${genre}`)));
const timeoutMs = Number(option('--docker-timeout-ms', '300000'));
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 900000) throw new Error('--docker-timeout-ms 必须是 1000..900000 的整数');
const temporary = await mkdtemp(path.join(os.tmpdir(), `game-docker-${genre}-`));
try {
  const assets = path.join(temporary, 'assets');
  await mkdir(assets);
  await writeFile(path.join(assets, `${genre}-map.json`), JSON.stringify({ name: `${genre}-docker-arena`, width: 96, height: 64 }));
  await writeFile(path.join(temporary, 'client.exe'), Buffer.from([0x4d, 0x5a, 1, 2, 3]));
  const scan = await scanGameDirectory(temporary);
  const spec = createGameServerSpec(
    { name: `docker-${genre}`, root: temporary, genre, assets: ['assets'], observations: [{ path: 'client.exe', detail: 'Docker 验证夹具' }], limitations: [] },
    scan.files,
    [{ kind: 'map', ref: `assets/${genre}-map.json`, detail: '地图尺寸', value: { name: `${genre}-docker-arena`, width: 96, height: 64 }, status: 'OBSERVED' }],
  );
  const generated = await generateGameServer(spec, output);
  const report = await validateGeneratedServer(output, { players: 4, rounds: 1, docker: true, dockerTimeoutMs: timeoutMs });
  await writeFile(path.join(output, 'docker-validation.json'), JSON.stringify({ ...report, files: generated.files }, null, 2) + '\n');
  if (report.deployment?.docker.evidence) {
    await writeFile(path.join(output, 'docker-deployment-evidence.json'), JSON.stringify(JSON.parse(report.deployment.docker.evidence), null, 2) + '\n');
  }
  const evidenceErrors = await verifyGameDockerEvidenceFiles({
    genre,
    reportPath: path.join(output, 'docker-validation.json'),
    evidencePath: path.join(output, 'docker-deployment-evidence.json'),
    sumsPath: path.join(output, 'SHA256SUMS.txt'),
  });
  if (!report.valid || !report.capabilities.dockerDeployment || evidenceErrors.length) {
    console.error(JSON.stringify({ valid: report.valid, capabilities: report.capabilities, errors: report.errors, evidenceErrors, checks: report.checks }, null, 2));
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify({ genre, output, valid: report.valid, sha256: report.sha256, dockerDeployment: report.capabilities.dockerDeployment, checks: report.checks }, null, 2));
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}

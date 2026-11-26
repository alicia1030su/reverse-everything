import { rm, writeFile } from 'node:fs/promises';
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
try {
  const sample = genre === 'fps' ? 'duel' : 'survival';
  const sampleRoot = path.join(root, 'examples', 'revival-games', 'anti-template', sample);
  const scan = await scanGameDirectory(sampleRoot);
  if (!scan.behaviorEvidence) throw new Error(`反模板样本缺少 behavior.json: ${sample}`);
  const spec = createGameServerSpec(
    { name: `docker-${sample}`, root: sampleRoot, genre: 'unknown', assets: [], observations: [], limitations: [] },
    scan.files,
    [],
    scan.behaviorEvidence,
  );
  await rm(output, { recursive: true, force: true });
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
  // 生成工程保留在 output，供独立证据校验与候选资产验收。
}

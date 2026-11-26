import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGameServerSpec, generateGameServer, requiredMatchSize, scanGameDirectory, validateGeneratedServer } from '../../packages/game-revival/src/index.js';

const dockerCalls: string[][] = [];
const spawnCalls: Array<{ command: string; args: readonly string[] }> = [];
let dockerUnavailable = false;
let cleanupResourcesRemain = true;
let dockerContainerQueries = 0;
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: ((command: string, args: readonly string[], options: Parameters<typeof spawn>[2]) => {
      spawnCalls.push({ command, args });
      if (command === 'docker') {
        if (dockerUnavailable) throw new Error('Docker 不可用（测试夹具）');
        dockerCalls.push([...args]);
        const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
        setImmediate(() => {
          if (args.includes('version')) child.stdout.end('Docker Compose version test');
          else if (args.includes('up')) child.stderr.end('up failed');
          else if (args[0] === 'ps') {
            dockerContainerQueries += 1;
            child.stdout.end(cleanupResourcesRemain || dockerContainerQueries === 1 ? 'residual-container\n' : '');
          } else if (args[0] === 'volume' && args[1] === 'ls') child.stdout.end(cleanupResourcesRemain ? 'residual-volume\n' : '');
          else if (args[0] === 'network' && args[1] === 'ls') child.stdout.end(cleanupResourcesRemain ? 'residual-network\n' : '');
          const failed = args.includes('up') || args.includes('down');
          child.emit('close', failed ? 1 : 0);
        });
        return child;
      }
      return actual.spawn(command, args, options);
    }) as typeof spawn,
  };
});

const temporary: string[] = [];
afterEach(async () => {
  dockerCalls.length = 0;
  spawnCalls.length = 0;
  dockerUnavailable = false;
  cleanupResourcesRemain = true;
  dockerContainerQueries = 0;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(temporary.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function fixture(genre: 'fps' | 'rpg' = 'fps'): Promise<{ root: string; output: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'game-docker-test-'));
  temporary.push(root);
  await mkdir(path.join(root, 'assets'));
  await writeFile(path.join(root, 'assets', 'map.json'), JSON.stringify({ name: 'arena', width: 64, height: 64 }));
  await writeFile(path.join(root, 'client.exe'), Buffer.from([0x4d, 0x5a, 1]));
  const scan = await scanGameDirectory(root);
  const spec = createGameServerSpec({ name: 'docker-test', root, genre, assets: ['assets'], observations: [], limitations: [] }, scan.files);
  const output = path.join(root, 'server');
  await generateGameServer(spec, output);
  return { root, output };
}

describe('游戏 Docker 验证', () => {
  it('生成容器内可用的 healthcheck 与 Compose 健康检查', async () => {
    const { output } = await fixture();
    const healthcheck = await readFile(path.join(output, 'scripts/healthcheck.mjs'), 'utf8');
    const compose = await readFile(path.join(output, 'docker-compose.yml'), 'utf8');
    expect(healthcheck).toContain("process.env.ADMIN_HOST ?? '127.0.0.1'");
    expect(healthcheck).toContain('AbortSignal.timeout(4000)');
    expect(compose).toContain('ADMIN_HOST: 0.0.0.0');
    expect(compose).toContain('test: ["CMD", "node", "scripts/healthcheck.mjs"]');
  });

  it('Docker 多人 harness 使用行为规格的最低人数', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'game-docker-min-players-'));
    temporary.push(root);
    await mkdir(path.join(root, 'assets'));
    await writeFile(path.join(root, 'assets', 'map.json'), JSON.stringify({ name: 'arena', width: 64, height: 64 }));
    await writeFile(path.join(root, 'behavior.json'), JSON.stringify({
      format: 'revival-behavior/v1', id: 'docker-min-three', title: 'Docker Min Three', mode: 'docker-min-three',
      rules: { minPlayers: 3, maxPlayers: 4, roundSeconds: 30, movementSpeed: 3, maxHealth: 50, respawn: false },
      actions: [{ id: 'gather', kind: 'gather', cooldownMs: 0, item: 'herb', amount: 2 }],
      winCondition: { type: 'collect', target: 2 }, map: { width: 40, height: 30, obstacles: [] },
    }));
    const scan = await scanGameDirectory(root);
    const spec = createGameServerSpec({ name: 'docker-min-three', root, genre: 'unknown', assets: ['assets'], observations: [], limitations: [] }, scan.files, [], scan.behaviorEvidence);
    expect(requiredMatchSize(spec.behaviorEvidence?.behavior)).toBe(3);
    const output = path.join(root, 'server');
    await generateGameServer(spec, output);
    const validator = await readFile(path.join(process.cwd(), 'packages/game-revival/src/validator.ts'), 'utf8');
    expect(validator).toContain('const dockerCount = requiredMatchSize(config.behavior)');
  });
  it('默认校验不调用 Docker 且保持 dockerDeployment=false', async () => {
    const { output } = await fixture();
    const report = await validateGeneratedServer(output, { players: 4, rounds: 1 });
    expect(report.valid, report.errors.join('\n')).toBe(true);
    expect(report.capabilities.dockerDeployment).toBe(false);
    expect(report.deployment).toBeUndefined();
    expect(report.checks.some(check => check.id.startsWith('docker-'))).toBe(false);
  }, 180_000);

  it('Docker 启动失败后仅删除容器但卷、网络残留时不得标记清理成功', async () => {
    const { output } = await fixture();
    const report = await validateGeneratedServer(output, { docker: true, dockerTimeoutMs: 60_000 });
    expect(report.valid).toBe(false);
    expect(report.capabilities.dockerDeployment).toBe(false);
    expect(report.deployment?.docker.tested).toBe(true);
    expect(report.checks.find(check => check.id === 'docker-cleanup')?.passed).toBe(false);
    expect(report.checks.find(check => check.id === 'docker-cleanup')?.detail, JSON.stringify(dockerCalls)).toContain('Docker 清理失败');
    const evidence = JSON.parse(report.deployment?.docker.evidence ?? '{}') as { cleanedUp: boolean };
    expect(evidence.cleanedUp).toBe(false);
    expect(dockerCalls.filter(args => args.includes('down'))).toHaveLength(2);
    expect(dockerCalls.some(args => args.some(arg => arg.startsWith('label=com.docker.compose.project='))), JSON.stringify(dockerCalls)).toBe(true);
    expect(dockerCalls.some(args => args.includes('rm') && args.includes('residual-container')), JSON.stringify(dockerCalls)).toBe(true);
    expect(dockerCalls.some(args => args[0] === 'volume' && args.includes('rm')), JSON.stringify(dockerCalls)).toBe(true);
    expect(dockerCalls.some(args => args[0] === 'network' && args.includes('rm')), JSON.stringify(dockerCalls)).toBe(true);
  }, 180_000);

  it('Docker 清理只有容器、卷与网络均无残留才写入 cleanedUp=true', async () => {
    cleanupResourcesRemain = false;
    const { output } = await fixture();
    const report = await validateGeneratedServer(output, { docker: true, dockerTimeoutMs: 60_000 });
    expect(report.valid).toBe(false);
    expect(report.checks.find(check => check.id === 'docker-cleanup')?.passed).toBe(true);
    const evidence = JSON.parse(report.deployment?.docker.evidence ?? '{}') as { cleanedUp: boolean };
    expect(evidence.cleanedUp).toBe(true);
  }, 180_000);

  it('配置 RE_NPM_CLI 时使用当前 Node 执行 npm CLI', async () => {
    const { output } = await fixture();
    const root = await mkdtemp(path.join(os.tmpdir(), 'game-npm-cli-test-'));
    temporary.push(root);
    const cli = path.join(root, 'npm-cli.mjs');
    const log = path.join(root, 'npm-args.jsonl');
    await writeFile(cli, `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');`);
    vi.stubEnv('RE_NPM_CLI', cli);
    await validateGeneratedServer(output);
    const npmCalls = spawnCalls.filter(call => call.command === process.execPath && call.args[0] === cli);
    expect(npmCalls.map(call => call.args[1])).toEqual(['ci', 'run', 'test']);
    expect(npmCalls[0]?.args).toContain('--ignore-scripts');
  });

  it('显式启用后 Docker 不可用必须失败而不是跳过或虚标', async () => {
    const { output } = await fixture();
    dockerUnavailable = true;
    const previousPath = process.env.PATH;
    process.env.PATH = '';
    try {
      const report = await validateGeneratedServer(output, { docker: true, signal: AbortSignal.timeout(5000) });
      expect(report.valid).toBe(false);
      expect(report.capabilities.dockerDeployment).toBe(false);
      expect(report.deployment?.docker.tested).toBe(true);
      expect(report.checks.find(check => check.id === 'docker-available')?.passed).toBe(false);
      expect(report.errors.join('\n')).toContain('Docker');
    } finally {
      dockerUnavailable = false;
      process.env.PATH = previousPath;
    }
  });
});

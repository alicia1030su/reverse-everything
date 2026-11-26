import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createGameServerSpec, generateGameServer, scanGameDirectory, validateGeneratedServer } from '../../packages/game-revival/src/index.js';
import type { GameProfile, GameServerSpec } from '../../packages/game-revival/src/index.js';

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

async function workspace(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'game-revival-test-'));
  temporary.push(directory);
  return directory;
}

async function fixture(genre: 'fps' | 'rpg'): Promise<{ root: string; spec: GameServerSpec }> {
  const root = await workspace();
  await mkdir(path.join(root, 'assets'));
  await writeFile(path.join(root, 'assets', `${genre}-map.json`), JSON.stringify({ name: `${genre}-arena`, width: 96, height: 64 }));
  await writeFile(path.join(root, 'client.exe'), Buffer.from([0x4d, 0x5a, 1, 2, 3]));
  const files = await scanGameDirectory(root);
  const profile: GameProfile = { name: `test-${genre}`, root, genre, assets: ['assets'], observations: [{ path: 'client.exe', detail: '客户端二进制已观察' }], limitations: [] };
  return { root, spec: createGameServerSpec(profile, files.files, [{ kind: 'map', ref: `assets/${genre}-map.json`, detail: '地图尺寸', value: { name: `${genre}-arena`, width: 96, height: 64 }, status: 'OBSERVED' }]) };
}

describe('scanGameDirectory', () => {
  it('流式哈希、增量复用、上限与只读行为', async () => {
    const root = await workspace();
    await writeFile(path.join(root, 'a.bin'), Buffer.alloc(4096, 7));
    await mkdir(path.join(root, 'nested'));
    await writeFile(path.join(root, 'nested', 'b.txt'), 'hello');
    const first = await scanGameDirectory(root);
    expect(first.filesScanned).toBe(2);
    expect(first.bytesScanned).toBe(4101);
    expect(first.files[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.files[0]?.evidenceStatus).toBe('OBSERVED');
    const second = await scanGameDirectory(root, { previous: first });
    expect(second.files.map(file => file.sha256)).toEqual(first.files.map(file => file.sha256));
    expect(second.files[0]?.evidenceRefs[0]?.detail).toContain('未重读');
    expect(second.files[0]?.evidenceStatus).toBe('INFERRED');
    expect(second.bytesScanned).toBe(0);
    const relativePrevious = first.files.map(file => ({ ...file, path: file.relativePath }));
    const relativeReuse = await scanGameDirectory(root, { previous: relativePrevious });
    expect(relativeReuse.files.every(file => file.evidenceRefs[0]?.detail.includes('未重读'))).toBe(true);
    const changedInode = first.files.map(file => ({ ...file, ino: (BigInt(String(file.ino ?? '0')) + 1n).toString() }));
    const inodeMiss = await scanGameDirectory(root, { previous: changedInode });
    expect(inodeMiss.files.every(file => file.evidenceStatus === 'OBSERVED')).toBe(true);
    expect(inodeMiss.bytesScanned).toBe(4101);
    expect(await readFile(path.join(root, 'a.bin'))).toEqual(Buffer.alloc(4096, 7));
    const limited = await scanGameDirectory(root, { maxFiles: 1 });
    expect(limited.files).toHaveLength(1);
    expect(limited.truncated).toBe(true);
    const budgetRoot = await workspace();
    await writeFile(path.join(budgetRoot, 'small.txt'), 'hello');
    await writeFile(path.join(budgetRoot, 'large.bin'), Buffer.alloc(10));
    const bytes = await scanGameDirectory(budgetRoot, { maxBytes: 10 });
    expect(bytes.files).toHaveLength(1);
    expect(bytes.bytesScanned).toBe(bytes.files[0]?.size);
    expect(bytes.truncated).toBe(true);
    expect(bytes.skipped).toHaveLength(1);
    const stopped = await scanGameDirectory(root, { maxBytes: 1 });
    expect(stopped.files).toEqual([]);
    expect(stopped.bytesScanned).toBe(0);
    expect(stopped.truncated).toBe(true);
    expect(stopped.skipped).toHaveLength(1);
    expect(stopped.skipped[0]?.reason).toContain('总字节上限');
  });

  it('内容变化后即使 size 与 mtime 还原也不复用摘要', async () => {
    const root = await workspace();
    const file = path.join(root, 'changing.bin');
    await writeFile(file, 'before');
    const first = await scanGameDirectory(root);
    const oldTime = new Date(first.files[0]!.mtimeMs);
    await writeFile(file, 'after!');
    await utimes(file, oldTime, oldTime);
    const second = await scanGameDirectory(root, { previous: first });
    expect(second.files[0]?.sha256).not.toBe(first.files[0]?.sha256);
    expect(second.files[0]?.evidenceStatus).toBe('OBSERVED');
  });

  it('拒绝符号链接并支持取消', async () => {
    const root = await workspace();
    await writeFile(path.join(root, 'real.txt'), 'real');
    try { await symlink(path.join(root, 'real.txt'), path.join(root, 'link.txt')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error; return; }
    const result = await scanGameDirectory(root);
    expect(result.files).toHaveLength(1);
    expect(result.skipped[0]?.reason).toContain('符号链接');
    const controller = new AbortController();
    controller.abort();
    await expect(scanGameDirectory(root, { signal: controller.signal })).rejects.toThrow();
  });
});

describe('createGameServerSpec', () => {
  it('按观察设计 RPG 模块且不伪造 VERIFIED 或客户端兼容', async () => {
    const { spec } = await fixture('rpg');
    expect(spec.genre).toBe('rpg');
    expect(spec.modules.map(module => module.name)).toEqual(expect.arrayContaining(['rpg', 'inventory', 'quests', 'persistence', 'reconnection']));
    expect(spec.map.value.name).toBe('rpg-arena');
    expect(spec.map.evidenceStatus).toBe('OBSERVED');
    expect(spec.compatibility.value.originalClient).toBe('UNKNOWN');
    expect(spec.modules.every(module => module.evidenceStatus !== 'VERIFIED')).toBe(true);
    const id = createHash('sha256').update(JSON.stringify(spec.map.value)).digest('hex');
    expect(id).toHaveLength(64);
  });

  it('无关文件不得把地图、规则或无证据模块提升为 INFERRED', () => {
    const profile: GameProfile = { name: 'unrelated', root: '.', genre: 'unknown', assets: [], observations: [], limitations: [] };
    const files = [{ path: '/game/notes.txt', relativePath: 'notes.txt', size: 4, mtimeMs: 1, extension: '.txt', evidenceStatus: 'OBSERVED' as const, evidenceRefs: [] }];
    const spec = createGameServerSpec(profile, files);
    expect(spec.level).toBe('L2');
    expect(spec.map.evidenceStatus).toBe('UNKNOWN');
    expect(spec.rules.evidenceStatus).toBe('UNKNOWN');
    expect(spec.modules.every(module => module.evidenceStatus === 'UNKNOWN')).toBe(true);
    expect(spec.map.value.width).toBe(128);
    expect(spec.rules.value.maxPlayers).toBe(8);
  });

  it('负向 observation 不改变类型、地图、规则或模块证据', () => {
    const profile: GameProfile = { name: 'negative', root: '.', genre: 'unknown', assets: [], observations: [], limitations: [] };
    const spec = createGameServerSpec(profile, [], [
      { kind: 'rpg', ref: 'missing-rpg', detail: 'not implemented', status: 'NOT_IMPLEMENTED' },
      { kind: 'map', ref: 'missing-map', detail: 'inaccessible', status: 'INACCESSIBLE', value: { width: 999 } },
      { kind: 'rule', ref: 'locked-rule', detail: 'not implemented', status: 'NOT_IMPLEMENTED', value: { roundSeconds: 1 } },
    ]);
    expect(spec.genre).toBe('fps');
    expect(spec.map.evidenceStatus).toBe('UNKNOWN');
    expect(spec.map.value.width).toBe(128);
    expect(spec.rules.evidenceStatus).toBe('UNKNOWN');
    expect(spec.rules.value.roundSeconds).toBe(300);
    expect(spec.modules.every(module => module.evidenceStatus === 'UNKNOWN')).toBe(true);
  });

  it('无文件证据时保持 UNKNOWN', () => {
    const profile: GameProfile = { name: 'empty', root: '.', genre: 'unknown', assets: [], observations: [], limitations: ['空目录'] };
    const spec = createGameServerSpec(profile, []);
    expect(spec.level).toBe('L0');
    expect(spec.map.evidenceStatus).toBe('UNKNOWN');
    expect(spec.compatibility.evidenceStatus).toBe('UNKNOWN');
    expect(spec.modules.find(module => module.name === spec.genre)?.evidenceStatus).toBe('UNKNOWN');
  });
});

describe('generateGameServer', () => {
  it('生成完整独立工程、具体规格与可校验摘要，拒绝覆盖', async () => {
    const { spec } = await fixture('fps');
    const output = path.join(await workspace(), 'server');
    const generated = await generateGameServer(spec, output);
    expect(generated.files).toEqual(expect.arrayContaining(['README.md', 'server/src/main.ts', 'database/migrations.json', 'admin-web/index.html', 'config/default.json', 'tests/server.test.mjs', 'scripts/start.mjs', 'scripts/stop.mjs', 'scripts/healthcheck.mjs', 'scripts/backup.mjs', 'scripts/restore.mjs', 'Dockerfile', 'docker-compose.yml', '.env.example', 'BUILD-INFO.json', 'GAME-COMPATIBILITY.json', 'SHA256SUMS.txt']));
    const config = JSON.parse(await readFile(path.join(output, 'config/default.json'), 'utf8')) as { map: { name: string }; rules: { damage: number } };
    expect(config.map.name).toBe('fps-arena');
    expect(config.rules.damage).toBe(25);
    const pkg = JSON.parse(await readFile(path.join(output, 'package.json'), 'utf8')) as { scripts: { build: string }; dependencies: Record<string, string> };
    expect(pkg.scripts.build).toContain('tsc');
    expect(pkg.dependencies).toEqual({ ws: '8.23.0' });
    expect(generated.sha256).toMatch(/^[a-f0-9]{64}$/);
    await expect(generateGameServer(spec, output)).rejects.toThrow('必须为空');
  });
});

describe('validateGeneratedServer', () => {
  it('真实安装编译并以多客户端完成 FPS 同场游戏', async () => {
    const { spec } = await fixture('fps');
    const output = path.join(await workspace(), 'fps-server');
    await generateGameServer(spec, output);
    const report = await validateGeneratedServer(output, { players: 4, rounds: 1 });
    expect(report.errors).toEqual([]);
    expect(report.checks.every(check => check.passed)).toBe(true);
    expect(report.checks.map(check => check.name)).toEqual(expect.arrayContaining(['npm run build 真实 tsc 编译', '服务端权威位置与独立玩家状态', 'FPS 动作、血量与回合结算', '断线 resume token 重连']));
    expect(report.valid).toBe(true);
  }, 180_000);

  it('真实安装编译并以多客户端完成 RPG 任务、隔离与重启恢复', async () => {
    const { spec } = await fixture('rpg');
    const output = path.join(await workspace(), 'rpg-server');
    await generateGameServer(spec, output);
    const report = await validateGeneratedServer(output, { players: 4, rounds: 1 });
    expect(report.errors).toEqual([]);
    expect(report.checks.every(check => check.passed)).toBe(true);
    expect(report.checks.map(check => check.name)).toEqual(expect.arrayContaining(['RPG 共享场景、背包、任务与结算', '服务重启后恢复房间与玩家状态']));
    expect(report.valid).toBe(true);
  }, 180_000);
});

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGameServerSpec } from '../../packages/game-revival/src/spec.js';
import { projectFiles } from '../../packages/game-revival/src/templates.js';

const exec = promisify(execFile);
const temporary: string[] = [];
let projectRoot = '';
let files: Map<string, string>;

interface TokenStoreModule {
  TokenStore: new (maxTokens?: number, ttlMs?: number, sweepIntervalMs?: number) => {
    issue(username: string): string;
    validate(token: string, username?: string): boolean;
    readonly size: number;
    dispose(): void;
  };
  ScryptSemaphore: new (maxConcurrent?: number, maxQueued?: number) => {
    run<T>(task: () => Promise<T>): Promise<T>;
  };
  AuthRateLimiter: new (maxAttempts?: number, windowMs?: number, maxEntries?: number, sweepIntervalMs?: number) => {
    consume(key: string): boolean;
    dispose(): void;
  };
  issueToken(username: string): string;
  validToken(token: string, username?: string): boolean;
}

interface EngineModule {
  GameEngine: new (database: unknown, dataFile: string, config: Record<string, unknown>) => {
    rooms: Map<string, { id: string; players: Map<string, unknown> }>;
    sessions: Map<string, Record<string, unknown>>;
    persistenceError: string | undefined;
    persist(): Promise<void>;
    flush(timeoutMs?: number): Promise<boolean>;
    attach(session: Record<string, unknown>): void;
    detach(session: Record<string, unknown>): void;
    resume(token: string): { id: string; username: string; roomId: string; resumeToken: string } | undefined;
    handle(session: Record<string, unknown>, envelope: Record<string, unknown>): void;
    tick(): void;
    stats(): Record<string, unknown>;
  };
}

async function command(name: string, args: string[], cwd: string): Promise<void> {
  await exec(name, args, { cwd, timeout: 120_000, maxBuffer: 4 * 1024 * 1024, shell: process.platform === 'win32' });
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => address && typeof address === 'object' ? resolve(address.port) : reject(new Error('无法分配端口')));
    });
  });
}

function generatedSpec() {
  return createGameServerSpec({ name: 'generated-security', root: '.', genre: 'fps', assets: [], observations: [], limitations: [] }, []);
}

async function loadGenerated<T>(relative: string): Promise<T> {
  return createRequire(import.meta.url)(path.join(projectRoot, 'dist', relative)) as T;
}

function session(id: string, username: string) {
  const messages: Array<{ type: string; payload?: Record<string, unknown> }> = [];
  return {
    id,
    username,
    roomId: '',
    token: 'test-token',
    send: (value: unknown) => messages.push(value as { type: string; payload?: Record<string, unknown> }),
    lastMessage: Date.now(),
    close: () => undefined,
    messages,
  };
}

async function waitForClose(socket: WebSocket): Promise<number> {
  if (socket.readyState === WebSocket.CLOSED) return socket.closeCode ?? -1;
  return await new Promise<number>(resolve => socket.once('close', code => resolve(code)));
}

async function openGameSocket(port: number): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { Host: `127.0.0.1:${port}` } });
  await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  return socket;
}

function nextMessage(socket: WebSocket, type: string): Promise<{ type: string; payload?: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off('message', onMessage); reject(new Error(`等待消息超时: ${type}`)); }, 5_000);
    const onMessage = (raw: WebSocket.RawData): void => {
      const message = JSON.parse(raw.toString()) as { type: string; payload?: Record<string, unknown> };
      if (message.type !== type) return;
      clearTimeout(timer);
      socket.off('message', onMessage);
      resolve(message);
    };
    socket.on('message', onMessage);
  });
}

beforeAll(async () => {
  projectRoot = await mkdtemp(path.join(tmpdir(), 'generated-server-security-'));
  temporary.push(projectRoot);
  files = projectFiles(generatedSpec());
  for (const [relative, content] of files) {
    const destination = path.join(projectRoot, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, content);
  }
  await command('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], projectRoot);
  await command('npm', ['run', 'build'], projectRoot);
  await command('npm', ['test'], projectRoot);
}, 180_000);

afterAll(async () => {
  await Promise.all(temporary.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('生成服务安全模板', () => {
  it('限制未认证连接、每 IP 认证速率、scrypt 并发与 token 生命周期', () => {
    expect(files.get('server/src/main.ts')).toContain('MAX_CONNECTIONS');
    expect(files.get('server/src/main.ts')).toContain('authRateLimiter.consume');
    expect(files.get('server/src/main.ts')).toContain('authentication timeout');
    expect(files.get('server/src/auth.ts')).toContain('class ScryptSemaphore');
    expect(files.get('server/src/auth.ts')).toContain('class TokenStore');
    expect(files.get('server/src/auth.ts')).toContain('setInterval');
    expect(files.get('server/src/auth.ts')).toContain('maxTokens');
  });

  it('实施房间全局/单用户配额与空房间 TTL，并在重启时丢弃空房间', () => {
    const engine = files.get('server/src/engine.ts') ?? '';
    expect(engine).toContain('maxRoomsPerUser');
    expect(engine).toContain('房间数量已达上限');
    expect(engine).toContain('emptyRoomTtlSeconds');
    expect(engine).toContain('emptySince');
    expect(engine).toContain('database.players.some');
  });

  it('resume 轮换 token、吊销旧会话并防止旧 close 误删新会话', () => {
    const engine = files.get('server/src/engine.ts') ?? '';
    expect(engine).toContain('resumed elsewhere');
    expect(engine).toContain('revokeToken(existingSession.token)');
    expect(engine).toContain('player.resumeToken = randomBytes(24)');
    expect(engine).toContain('this.sessions.get(session.id) !== session');
  });

  it('暴露持久化失败、/health 返回非 2xx，shutdown 有界等待 flush', () => {
    expect(files.get('server/src/engine.ts')).toContain('persistenceError');
    expect(files.get('server/src/engine.ts')).toContain('flush(timeoutMs');
    expect(files.get('server/src/admin.ts')).toContain('writeHead(503');
    expect(files.get('server/src/main.ts')).toContain('engine.flush(5_000)');
  });

  it('仅接受显式 Host/Origin 白名单，远程监听必须配置白名单', () => {
    const main = files.get('server/src/main.ts') ?? '';
    expect(main).toContain('ALLOWED_HOSTS');
    expect(main).toContain('ALLOWED_ORIGINS');
    expect(main).toContain('远程监听必须显式配置 ALLOWED_HOSTS');
    expect(main).toContain('allowedHosts.has(requestHost)');
    expect(main).toContain('allowedHosts.has(requestHostname');
    expect(main).toContain('allowedOrigins.has(origin)');
  });

  it('生成安全 Docker 配置并移除管理后台硬编码端口', () => {
    const dockerignore = files.get('.dockerignore') ?? '';
    for (const entry of ['node_modules', 'dist', 'data', '.env*', '.git']) expect(dockerignore.split(/\r?\n/)).toContain(entry);
    const dockerfile = files.get('Dockerfile') ?? '';
    expect(dockerfile).toContain('USER node');
    expect(dockerfile).toContain('chown -R node:node /app');
    expect(dockerfile).not.toContain('COPY . .');
    expect(files.get('admin-web/index.html')).not.toContain(`http://127.0.0.1:${generatedSpec().ports.value.admin}`);
    expect(files.get('admin-web/index.html')).toContain("fetch('/stats'");
  });
});

describe('生成服务安全运行回归', () => {
  it('同一 socket 并发认证不同账号只允许一个 session', async () => {
    const gamePort = await freePort();
    const adminPort = await freePort();
    const token = `security-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const child = exec(process.execPath, ['dist/main.js'], {
      cwd: projectRoot,
      timeout: 30_000,
      env: {
        ...process.env,
        ADMIN_TOKEN: token,
        GAME_HOST: '127.0.0.1',
        GAME_PORT: String(gamePort),
        ADMIN_HOST: '127.0.0.1',
        ADMIN_PORT: String(adminPort),
        ALLOWED_HOSTS: `127.0.0.1:${gamePort}`,
        DATA_FILE: path.join(projectRoot, 'auth-race-data', 'game.json'),
        AUDIT_FILE: path.join(projectRoot, 'auth-race-data', 'audit.jsonl'),
        PID_FILE: path.join(projectRoot, 'auth-race-data', 'game.pid'),
      },
    });
    let socket: WebSocket | undefined;
    try {
      const deadline = Date.now() + 10_000;
      while (true) {
        try {
          const response = await fetch(`http://127.0.0.1:${adminPort}/health`, { headers: { Authorization: `Bearer ${token}` } });
          if (response.ok) break;
        } catch { /* 服务尚未就绪 */ }
        if (Date.now() > deadline) throw new Error('生成服务未就绪');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      for (const username of ['alice', 'bob']) {
        socket = await openGameSocket(gamePort);
        const authenticated = nextMessage(socket, 'authenticated');
        socket.send(JSON.stringify({ type: 'authenticate', payload: { mode: 'register', username, password: 'correct-password' } }));
        await authenticated;
        socket.close();
        await waitForClose(socket);
      }
      socket = await openGameSocket(gamePort);
      let authenticatedCount = 0;
      socket.on('message', raw => {
        const message = JSON.parse(raw.toString()) as { type: string };
        if (message.type === 'authenticated') authenticatedCount += 1;
      });
      socket.send(JSON.stringify({ type: 'authenticate', payload: { username: 'alice', password: 'correct-password' } }));
      socket.send(JSON.stringify({ type: 'authenticate', payload: { username: 'bob', password: 'correct-password' } }));
      const closeCode = await Promise.race([waitForClose(socket), new Promise<number>(resolve => setTimeout(() => resolve(-1), 500))]);
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(authenticatedCount).toBeLessThanOrEqual(1);
      expect(closeCode).toBe(1008);
    } finally {
      socket?.terminate();
      child.child.kill('SIGTERM');
      await child.catch(() => undefined);
    }
  }, 30_000);

  it('高频持久化请求合并为有界队列', async () => {
    const { GameEngine } = await loadGenerated<EngineModule>('engine.js');
    const { emptyDatabase } = await loadGenerated<{ emptyDatabase(): unknown }>('storage.js');
    const config = JSON.parse(files.get('config/default.json') ?? '{}') as Record<string, unknown>;
    const engine = new GameEngine(emptyDatabase(), ':memory:', config);
    const saves = Array.from({ length: 500 }, () => engine.persist());
    const persistence = engine.stats().persistence as { pendingWrites: number };
    expect(persistence.pendingWrites).toBeLessThanOrEqual(1);
    await Promise.all(saves);
    expect(await engine.flush()).toBe(true);
    expect((engine.stats().persistence as { pendingWrites: number }).pendingWrites).toBe(0);
  });

  it('token store 限制最大数量并定期清扫', async () => {
    const auth = await loadGenerated<TokenStoreModule>('auth.js');
    const store = new auth.TokenStore(2, 15, 5);
    try {
      const first = store.issue('alice');
      const second = store.issue('bob');
      store.issue('carol');
      expect(store.size).toBe(2);
      expect(store.validate(first)).toBe(false);
      expect(store.validate(second)).toBe(true);
      await new Promise(resolve => setTimeout(resolve, 40));
      expect(store.size).toBe(0);
    } finally { store.dispose(); }
  });

  it('scrypt 信号量限制并发并拒绝无界等待队列', async () => {
    const auth = await loadGenerated<TokenStoreModule>('auth.js');
    const semaphore = new auth.ScryptSemaphore(1, 1);
    let active = 0;
    let peak = 0;
    const work = async (): Promise<void> => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 20));
      active -= 1;
    };
    await Promise.all([semaphore.run(work), semaphore.run(work)]);
    expect(peak).toBe(1);
    const pending = semaphore.run(() => new Promise<void>(resolve => setTimeout(resolve, 50)));
    const queued = semaphore.run(() => new Promise<void>(resolve => setTimeout(resolve, 10)));
    await expect(semaphore.run(work)).rejects.toThrow('认证请求过多');
    await Promise.all([pending, queued]);
  });

  it('每 IP 认证速率在窗口后恢复', async () => {
    const auth = await loadGenerated<TokenStoreModule>('auth.js');
    const limiter = new auth.AuthRateLimiter(2, 20, 16, 5);
    try {
      expect(limiter.consume('127.0.0.1')).toBe(true);
      expect(limiter.consume('127.0.0.1')).toBe(true);
      expect(limiter.consume('127.0.0.1')).toBe(false);
      await new Promise(resolve => setTimeout(resolve, 40));
      expect(limiter.consume('127.0.0.1')).toBe(true);
    } finally { limiter.dispose(); }
  });

  it('房间配额生效且空房间按 TTL 回收', async () => {
    const { GameEngine } = await loadGenerated<EngineModule>('engine.js');
    const { emptyDatabase } = await loadGenerated<{ emptyDatabase(): unknown }>('storage.js');
    const config = JSON.parse(files.get('config/default.json') ?? '{}') as Record<string, unknown>;
    config.rules = { ...(config.rules as Record<string, unknown>), maxRooms: 2, maxRoomsPerUser: 1, emptyRoomTtlSeconds: 0.01 };
    const engine = new GameEngine(emptyDatabase(), ':memory:', config);
    const alice = session('alice', 'alice');
    const bob = session('bob', 'bob');
    engine.handle(alice, { type: 'createRoom', payload: { name: 'alice-room' } });
    engine.handle(alice, { type: 'createRoom', payload: { name: 'alice-room-2' } });
    expect(alice.messages.at(-1)?.payload?.message).toBe('单用户房间数已达上限');
    engine.handle(bob, { type: 'createRoom', payload: { name: 'bob-room' } });
    expect(engine.rooms.size).toBe(2);
    engine.handle(bob, { type: 'createRoom', payload: { name: 'bob-room-2' } });
    expect(bob.messages.at(-1)?.payload?.message).toBe('房间数量已达上限');
    await new Promise(resolve => setTimeout(resolve, 30));
    engine.tick();
    expect(engine.rooms.size).toBe(0);
  });

  it('resume 使旧 token 与旧 socket 失效且旧 close 不影响新会话', async () => {
    const auth = await loadGenerated<TokenStoreModule>('auth.js');
    const { GameEngine } = await loadGenerated<EngineModule>('engine.js');
    const { emptyDatabase } = await loadGenerated<{ emptyDatabase(): unknown }>('storage.js');
    const config = JSON.parse(files.get('config/default.json') ?? '{}') as Record<string, unknown>;
    const engine = new GameEngine(emptyDatabase(), ':memory:', config);
    const original = session('player-1', 'alice');
    original.token = auth.issueToken('alice');
    engine.handle(original, { type: 'createRoom', payload: { name: 'room' } });
    const roomId = String(original.messages.find(message => message.type === 'createRoom:result')?.payload?.roomId ?? '');
    engine.handle(original, { type: 'join', payload: { roomId } });
    const resumeToken = String(original.messages.find(message => message.type === 'welcome')?.payload?.resumeToken ?? '');
    expect(resumeToken).not.toBe('');
    let oldClosed = false;
    original.close = () => { oldClosed = true; };
    const resumed = engine.resume(resumeToken);
    expect(resumed).toBeDefined();
    expect(resumed?.resumeToken).not.toBe(resumeToken);
    expect(oldClosed).toBe(true);
    expect(auth.validToken(original.token, 'alice')).toBe(false);
    expect(engine.resume(resumeToken)).toBeUndefined();
    const replacement = session('player-1', 'alice');
    replacement.token = auth.issueToken('alice');
    engine.attach(replacement);
    engine.detach(original);
    expect(engine.sessions.get('player-1')).toBe(replacement);
  });

  it('持久化失败时 flush=false 且管理 /health 返回 503', async () => {
    const { GameEngine } = await loadGenerated<EngineModule>('engine.js');
    const { emptyDatabase } = await loadGenerated<{ emptyDatabase(): unknown }>('storage.js');
    const { startAdmin } = await loadGenerated<{ startAdmin(engine: unknown, token: string, port: number, host: string, auditFile: string): Promise<{ close(): Promise<void> }> }>('admin.js');
    const config = JSON.parse(files.get('config/default.json') ?? '{}') as Record<string, unknown>;
    const blocked = path.join(projectRoot, 'blocked-data');
    await mkdir(blocked);
    const engine = new GameEngine(emptyDatabase(), blocked, config);
    await engine.persist();
    expect(engine.persistenceError).toBeTruthy();
    expect(await engine.flush()).toBe(false);
    const port = await freePort();
    const admin = await startAdmin(engine, 'security-admin-token', port, '127.0.0.1', path.join(projectRoot, 'audit.jsonl'));
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { headers: { Authorization: 'Bearer security-admin-token' } });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ ok: false });
    } finally { await admin.close(); }
  });

  it('运行时拒绝 DNS rebinding 的 Host/Origin 并允许显式白名单', async () => {
    const gamePort = await freePort();
    const adminPort = await freePort();
    const token = `security-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const child = exec(process.execPath, ['dist/main.js'], {
      cwd: projectRoot,
      timeout: 30_000,
      env: {
        ...process.env,
        ADMIN_TOKEN: token,
        GAME_HOST: '127.0.0.1',
        GAME_PORT: String(gamePort),
        ADMIN_HOST: '127.0.0.1',
        ADMIN_PORT: String(adminPort),
        ALLOWED_HOSTS: `127.0.0.1:${gamePort}`,
        ALLOWED_ORIGINS: 'http://allowed.example',
        MAX_CONNECTIONS: '1',
        DATA_FILE: path.join(projectRoot, 'runtime-data', 'game.json'),
        AUDIT_FILE: path.join(projectRoot, 'runtime-data', 'audit.jsonl'),
        PID_FILE: path.join(projectRoot, 'runtime-data', 'game.pid'),
      },
    });
    try {
      const deadline = Date.now() + 10_000;
      while (true) {
        try {
          const response = await fetch(`http://127.0.0.1:${adminPort}/health`, { headers: { Authorization: `Bearer ${token}` } });
          if (response.ok) break;
        } catch { /* 服务尚未就绪 */ }
        if (Date.now() > deadline) throw new Error('生成服务未就绪');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      const badHost = new WebSocket(`ws://127.0.0.1:${gamePort}`, { headers: { Host: 'evil.example' } });
      expect(await waitForClose(badHost)).toBe(1008);
      const badOrigin = new WebSocket(`ws://127.0.0.1:${gamePort}`, { headers: { Host: `127.0.0.1:${gamePort}`, Origin: 'http://evil.example' } });
      expect(await waitForClose(badOrigin)).toBe(1008);
      const allowed = new WebSocket(`ws://127.0.0.1:${gamePort}`, { headers: { Host: `127.0.0.1:${gamePort}`, Origin: 'http://allowed.example' } });
      await new Promise<void>((resolve, reject) => { allowed.once('open', resolve); allowed.once('error', reject); });
      const excess = new WebSocket(`ws://127.0.0.1:${gamePort}`, { headers: { Host: `127.0.0.1:${gamePort}`, Origin: 'http://allowed.example' } });
      expect(await waitForClose(excess)).toBe(1013);
      allowed.close();
    } finally {
      child.child.kill('SIGTERM');
      await child.catch(() => undefined);
    }
  }, 30_000);
});

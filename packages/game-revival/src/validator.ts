import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import type { GameValidationCapabilities, GameValidationCheck, GameValidationReport } from './types.js';

export interface ValidationOptions {
  signal?: AbortSignal;
  players?: number;
  loadClients?: number;
  rounds?: number;
  /** 默认关闭；仅显式启用时才允许执行真实 Docker Compose 部署。 */
  docker?: boolean;
  dockerTimeoutMs?: number;
  /** 单条命令与 WS 握手的默认上限，可按生成工程规模调大。 */
  commandTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  fetchTimeoutMs?: number;
}
interface Message { type: string; payload?: Record<string, unknown>; requestId?: string }
interface Client {
  socket: WebSocket;
  id: string;
  username: string;
  token: string;
  resumeToken: string;
  send: (type: string, payload?: Record<string, unknown>) => void;
  wait: (type: string, timeoutMs?: number) => Promise<Message>;
  state: () => Promise<Message>;
  close: () => Promise<void>;
}

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') { server.close(); reject(new Error('无法分配端口')); return; }
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

export interface ValidationCommandOptions {
  signal?: AbortSignal | undefined;
  maxOutput?: number | undefined;
  timeoutMs?: number | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}

function npmCommand(args: string[]): { command: string; args: string[] } {
  const cli = process.env.RE_NPM_CLI?.trim();
  return cli
    ? { command: process.execPath, args: [cli, ...args] }
    : { command: process.platform === 'win32' ? 'npm.cmd' : 'npm', args };
}

export async function runValidationCommand(command: string, args: string[], cwd: string, options: ValidationCommandOptions = {}): Promise<string> {
  const { signal, maxOutput = 1024 * 1024, timeoutMs = 120_000, env } = options;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error(`${command} 执行被取消或超时`)); return; }
    const child = spawn(command, args, {
      cwd, env, shell: process.platform === 'win32' && command.toLowerCase().endsWith('.cmd'), detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let output = '';
    let settled = false;
    let spawnError: Error | undefined;
    let terminationError: Error | undefined;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(output);
    };
    const collect = (chunk: Buffer): void => { output = (output + chunk.toString()).slice(-maxOutput); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const abort = (): void => {
      if (terminationError || settled) return;
      terminationError = new Error(`${command} 执行被取消或超时`);
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (!child.pid) return;
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        killer.once('error', () => child.kill());
        killer.once('close', () => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch { child.kill(); }
      }
    };
    const timer = setTimeout(abort, Math.max(1, timeoutMs));
    timer.unref();
    signal?.addEventListener('abort', abort, { once: true });
    child.once('error', error => { spawnError = error; });
    child.once('close', code => finish(terminationError ?? spawnError ?? (code === 0 ? undefined : new Error(`${command} ${args.join(' ')} 退出码 ${code}\n${output}`))));
  });
}

export function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 5_000): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.any([...(init.signal ? [init.signal] : []), AbortSignal.timeout(Math.max(1, timeoutMs))]) });
}

interface ClientOptions { signal?: AbortSignal | undefined; handshakeTimeoutMs?: number | undefined; messageTimeoutMs?: number | undefined }
interface Waiter { type: string; resolve: (message: Message) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }

async function openClient(url: string, options: ClientOptions): Promise<{ socket: WebSocket; messages: Message[]; wait: (type: string, timeoutMs?: number) => Promise<Message>; send: (type: string, payload?: Record<string, unknown>) => void; close: () => Promise<void> }> {
  const socket = new WebSocket(url, { maxPayload: 64 * 1024 });
  const messages: Message[] = [];
  const waiters: Waiter[] = [];
  let failure: Error | undefined;
  const rejectWaiters = (error: Error): void => {
    failure = error;
    for (const waiter of waiters.splice(0)) { clearTimeout(waiter.timer); waiter.reject(error); }
  };
  socket.on('message', raw => {
    let message: Message;
    try {
      const parsed = JSON.parse(raw.toString()) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || typeof (parsed as Message).type !== 'string') throw new Error('消息结构无效');
      message = parsed as Message;
    } catch (error) {
      rejectWaiters(new Error(`WebSocket 非法 JSON: ${error instanceof Error ? error.message : String(error)}`));
      socket.close(1002, 'Invalid JSON');
      return;
    }
    const errorWaiter = message.type === 'error' ? waiters.findIndex(waiter => waiter.type !== 'error') : -1;
    if (errorWaiter >= 0) {
      const waiter = waiters.splice(errorWaiter, 1)[0]!;
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`服务端错误: ${JSON.stringify(message.payload)}`));
      return;
    }
    const index = waiters.findIndex(waiter => waiter.type === message.type);
    if (index >= 0) {
      const waiter = waiters.splice(index, 1)[0]!;
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    } else messages.push(message);
  });
  socket.on('error', error => rejectWaiters(new Error(`WebSocket 错误: ${error.message}`)));
  socket.on('close', () => rejectWaiters(new Error('WebSocket 已关闭')));
  const handshakeTimeout = Math.max(1, options.handshakeTimeoutMs ?? 10_000);
  const handshakeTimer = setTimeout(() => {
    rejectWaiters(new Error(`WebSocket 握手超时 ${handshakeTimeout}ms`));
    socket.terminate();
  }, handshakeTimeout);
  handshakeTimer.unref();
  const abort = (): void => { rejectWaiters(new Error('WebSocket 握手被取消或超时')); socket.terminate(); };
  options.signal?.addEventListener('abort', abort, { once: true });
  const wait = (type: string, timeoutMs = options.messageTimeoutMs ?? 8_000): Promise<Message> => {
    if (failure) return Promise.reject(failure);
    const index = messages.findIndex(message => message.type === type);
    if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]!);
    if (type !== 'error') {
      const errorIndex = messages.findIndex(message => message.type === 'error');
      if (errorIndex >= 0) { const message = messages.splice(errorIndex, 1)[0]!; return Promise.reject(new Error(`服务端错误: ${JSON.stringify(message.payload)}`)); }
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const position = waiters.findIndex(waiter => waiter.type === type);
        if (position >= 0) waiters.splice(position, 1);
        reject(new Error(`等待消息 ${type} 超时`));
      }, Math.max(1, timeoutMs));
      waiters.push({ type, resolve, reject, timer });
    });
  };
  const send = (type: string, payload: Record<string, unknown> = {}): void => socket.send(JSON.stringify({ type, payload, requestId: `${Date.now()}-${Math.random()}` }));
  const close = (): Promise<void> => new Promise(resolve => {
    if (socket.readyState === WebSocket.CLOSED) resolve();
    else { socket.once('close', () => resolve()); socket.close(); }
  });
  try {
    if (options.signal?.aborted) throw new Error('WebSocket 握手被取消或超时');
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
      socket.once('close', () => reject(new Error('WebSocket 握手期间关闭')));
    });
    return { socket, messages, wait, send, close };
  } finally {
    clearTimeout(handshakeTimer);
    socket.once('close', () => options.signal?.removeEventListener('abort', abort));
  }
}

export async function connectValidationClient(url: string, username: string, password: string, mode: 'register' | 'login' = 'register', options: ClientOptions = {}): Promise<Client> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Error(`WebSocket 握手超时 ${options.handshakeTimeoutMs ?? 10_000}ms`)), Math.max(1, options.handshakeTimeoutMs ?? 10_000));
  timer.unref();
  const client = await openClient(url, { ...options, signal: AbortSignal.any([...(options.signal ? [options.signal] : []), deadline.signal]) }).catch(error => { clearTimeout(timer); throw error; });
  try {
    client.send('authenticate', { username, password, mode });
    const authenticated = await client.wait('authenticated', options.handshakeTimeoutMs);
    const token = String(authenticated.payload?.token ?? '');
    client.send('authenticate', { token });
    await client.wait('authorized', options.handshakeTimeoutMs);
    return {
      ...client, id: String(authenticated.payload?.playerId ?? ''), username, token, resumeToken: '',
      state: async () => {
        for (let index = client.messages.length - 1; index >= 0; index -= 1) if (client.messages[index]?.type === 'state') client.messages.splice(index, 1);
        client.send('state');
        return client.wait('state');
      },
    };
  } catch (error) { await client.close(); throw error; }
  finally { clearTimeout(timer); }
}

async function resume(url: string, token: string, options: ClientOptions = {}): Promise<Client> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Error(`WebSocket 握手超时 ${options.handshakeTimeoutMs ?? 10_000}ms`)), Math.max(1, options.handshakeTimeoutMs ?? 10_000));
  timer.unref();
  const client = await openClient(url, { ...options, signal: AbortSignal.any([...(options.signal ? [options.signal] : []), deadline.signal]) }).catch(error => { clearTimeout(timer); throw error; });
  try {
    client.send('resume', { token });
    const welcome = await client.wait('welcome', options.handshakeTimeoutMs);
    return {
      ...client, id: String(welcome.payload?.playerId ?? ''), username: '', token: '', resumeToken: String(welcome.payload?.resumeToken ?? ''),
      state: async () => { client.send('state'); return client.wait('state'); },
    };
  } catch (error) { await client.close(); throw error; }
  finally { clearTimeout(timer); }
}

export interface DockerCleanupOptions {
  project: string;
  root: string;
  containerIds?: string[];
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  runCommand?: typeof runValidationCommand;
}

/** 重试 Compose 清理，按项目 label 兜底删除，并核验容器、卷与网络均无残留。 */
export async function cleanupDockerProject(options: DockerCleanupOptions): Promise<string> {
  const { project, root, containerIds = [], timeoutMs, env } = options;
  const execute = options.runCommand ?? runValidationCommand;
  const failures: string[] = [];
  const outputs: string[] = [];
  const command = async (args: string[]): Promise<string> => {
    const output = await execute('docker', args, root, { env, timeoutMs });
    outputs.push(output);
    return output;
  };
  const compose = ['compose', '-p', project, '-f', 'docker-compose.yml'];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try { await command([...compose, 'down', '-v', '--remove-orphans']); break; }
    catch (error) { failures.push(`Compose 清理第 ${attempt} 次失败: ${error instanceof Error ? error.message : String(error)}`); }
  }
  const projectLabel = `label=com.docker.compose.project=${project}`;
  const ids = new Set(containerIds.filter(Boolean));
  try {
    const listed = await command(['ps', '-aq', '--filter', projectLabel]);
    for (const id of listed.split(/\s+/).filter(Boolean)) ids.add(id);
  } catch (error) { failures.push(`按项目 label 查询容器失败: ${error instanceof Error ? error.message : String(error)}`); }
  if (ids.size) {
    try { await command(['rm', '-f', ...ids]); }
    catch (error) { failures.push(`强制删除容器失败: ${error instanceof Error ? error.message : String(error)}`); }
  }
  const resources: Array<{ kind: string; args: string[] }> = [
    { kind: '容器', args: ['ps', '-aq', '--filter', projectLabel] },
    { kind: '卷', args: ['volume', 'ls', '-q', '--filter', projectLabel] },
    { kind: '网络', args: ['network', 'ls', '-q', '--filter', projectLabel] },
  ];
  for (const resource of resources) {
    try {
      const remaining = (await command(resource.args)).split(/\s+/).filter(Boolean);
      if (resource.kind !== '容器' && remaining.length) {
        try { await command([resource.kind === '卷' ? 'volume' : 'network', 'rm', ...remaining]); }
        catch (error) { failures.push(`强制删除项目${resource.kind}失败: ${error instanceof Error ? error.message : String(error)}`); }
      }
    } catch (error) { failures.push(`核验项目${resource.kind}残留失败: ${error instanceof Error ? error.message : String(error)}`); }
  }
  const residual: string[] = [];
  for (const resource of resources) {
    try {
      if ((await command(resource.args)).split(/\s+/).filter(Boolean).length) residual.push(resource.kind);
    } catch (error) { failures.push(`最终核验项目${resource.kind}残留失败: ${error instanceof Error ? error.message : String(error)}`); }
  }
  if (residual.length) failures.push(`项目资源仍残留: ${residual.join('、')}`);
  const unrecovered = failures.filter(failure => !failure.startsWith('Compose 清理第'));
  if (residual.length || unrecovered.length) throw new Error(`Docker 清理失败: ${failures.join('; ')}`);
  return outputs.join('\n');
}

async function joinRoom(client: Client, roomId: string): Promise<void> {
  client.send('join', { roomId });
  await client.wait('join:result');
  const welcome = await client.wait('welcome');
  client.id = String(welcome.payload?.playerId ?? client.id);
  client.resumeToken = String(welcome.payload?.resumeToken ?? '');
}

async function waitHealthy(url: string, token: string, child: ReturnType<typeof spawn>, signal?: AbortSignal): Promise<void> {
  let logs = '';
  child.stdout?.on('data', chunk => { logs = (logs + chunk.toString()).slice(-4_096); });
  child.stderr?.on('data', chunk => { logs = (logs + chunk.toString()).slice(-4_096); });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    if (child.exitCode !== null) throw new Error(`服务提前退出: ${logs}`);
    try { const response = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${token}` } }, 3_000); if (response.ok) return; } catch { /* 尚未监听 */ }
    await delay(100);
  }
  throw new Error('服务启动超时');
}

/** 真正安装、编译、启动服务并通过 WebSocket 客户端执行同场游戏与恢复验证。 */
export async function validateGeneratedServer(projectDir: string, options: ValidationOptions = {}): Promise<GameValidationReport> {
  const root = path.resolve(projectDir);
  const startedAt = new Date().toISOString();
  const checks: GameValidationCheck[] = [];
  const errors: string[] = [];
  const generatedFiles: string[] = [];
  let generatedSha = '';
  let config: { gamePort: number; adminPort: number; adminHost: string; genre: 'fps' | 'rpg' } = { gamePort: 8080, adminPort: 8081, adminHost: '127.0.0.1', genre: 'fps' };
  let server: ReturnType<typeof spawn> | undefined;
  let tempDir: string | undefined;
  let deployment: GameValidationReport['deployment'];
  const clients: Client[] = [];
  const passed = (id: string): boolean => checks.some(check => check.id === id && check.passed);
  const check = async (id: string, name: string, action: () => Promise<string>): Promise<boolean> => {
    const start = Date.now();
    if (process.env.GAME_REVIVAL_DEBUG) console.error('[validation] start', id);
    try { const detail = await action(); checks.push({ id, name, passed: true, detail, durationMs: Date.now() - start }); return true; }
    catch (error) { const detail = error instanceof Error ? error.message : String(error); checks.push({ id, name, passed: false, detail, durationMs: Date.now() - start }); errors.push(`${name}: ${detail}`); return false; }
  };
  try {
    await check('checksums', '生成物校验和', async () => {
      const sums = await readFile(path.join(root, 'SHA256SUMS.txt'), 'utf8');
      const { createHash } = await import('node:crypto');
      for (const line of sums.trim().split('\n')) {
        const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
        if (!match) throw new Error('SHA256SUMS 格式无效');
        const actual = createHash('sha256').update(await readFile(path.join(root, match[2]!))).digest('hex');
        generatedFiles.push(match[2]!);
        if (actual !== match[1]) throw new Error(`校验和不匹配: ${match[2]}`);
      }
      generatedSha = createHash('sha256').update(sums).digest('hex');
      return `验证 ${generatedFiles.length} 个文件`;
    });
    const commandOptions = { signal: options.signal, timeoutMs: options.commandTimeoutMs ?? 120_000 };
    await check('install', 'npm ci 独立安装', () => { const npm = npmCommand(['ci', '--ignore-scripts', '--no-audit', '--no-fund']); return runValidationCommand(npm.command, npm.args, root, commandOptions); });
    await check('build', 'npm run build 真实 tsc 编译', () => { const npm = npmCommand(['run', 'build']); return runValidationCommand(npm.command, npm.args, root, commandOptions); });
    await check('unit-tests', '生成工程单元测试', () => { const npm = npmCommand(['test']); return runValidationCommand(npm.command, npm.args, root, commandOptions); });
    config = JSON.parse(await readFile(path.join(root, 'config/default.json'), 'utf8')) as typeof config;
    const gamePort = await freePort();
    const adminPort = await freePort();
    tempDir = await mkdtemp(path.join(os.tmpdir(), 're-v006-validation-'));
    const dataFile = path.join(tempDir, 'game.json');
    const auditFile = path.join(tempDir, 'admin-audit.jsonl');
    const token = `validation-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const env = { ...process.env, ADMIN_TOKEN: token, GAME_PORT: String(gamePort), ADMIN_PORT: String(adminPort), GAME_HOST: '127.0.0.1', ADMIN_HOST: '127.0.0.1', DATA_FILE: dataFile, AUDIT_FILE: auditFile, PID_FILE: path.join(tempDir, 'game.pid') };
    const adminUrl = `http://127.0.0.1:${adminPort}`;
    const url = `ws://127.0.0.1:${gamePort}`;
    const startServer = async (): Promise<void> => {
      server = spawn(process.execPath, ['dist/main.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
      await waitHealthy(`${adminUrl}/health`, token, server, options.signal);
    };
    await check('independent-start', '启动生成服务', async () => { await startServer(); return `game=${gamePort} admin=${adminPort}`; });
    await check('admin-auth', '管理 API 认证、统计与审计', async () => {
      const fetchOptions = { headers: { Authorization: `Bearer ${token}` }, signal: options.signal ?? null };
      const denied = await fetchWithTimeout(`${adminUrl}/stats`, { signal: options.signal ?? null }, options.fetchTimeoutMs);
      if (denied.status !== 401) throw new Error('未认证管理请求未返回 401');
      const stats = await (await fetchWithTimeout(`${adminUrl}/stats`, fetchOptions, options.fetchTimeoutMs)).json() as Record<string, unknown>;
      const audit = await (await fetchWithTimeout(`${adminUrl}/audit`, fetchOptions, options.fetchTimeoutMs)).text();
      if (stats.genre !== config.genre || !audit.includes('denied /stats')) throw new Error('管理统计或审计日志缺失');
      return JSON.stringify(stats);
    });
    const count = Math.max(4, options.players ?? 4);
    const clientOptions = { signal: options.signal, handshakeTimeoutMs: options.handshakeTimeoutMs, messageTimeoutMs: options.handshakeTimeoutMs };
    await check('authentication', '真实账号注册与登录', async () => {
      for (let index = 0; index < count; index += 1) clients.push(await connectValidationClient(url, `player${index}`, `password-${index}-secret`, 'register', clientOptions));
      const login = await connectValidationClient(url, 'player0', `password-0-secret`, 'login', clientOptions);
      await login.close(); clients.push(login);
      const data = await readFile(dataFile, 'utf8');
      if (data.includes('password-0-secret') || data.includes(token)) throw new Error('数据库持久化了明文密码或 token');
      return `${count} 个账号注册并重复登录，密码仅保存 scrypt 散列`;
    });
    let firstId = '';
    await check('room-isolation', '大厅、房间创建与多房间隔离', async () => {
      firstId = String((await (async () => { clients[0]!.send('createRoom', { name: 'alpha' }); return clients[0]!.wait('createRoom:result'); })()).payload?.roomId ?? '');
      await joinRoom(clients[1]!, firstId);
      await joinRoom(clients[0]!, firstId);
      clients[2]!.send('createRoom', { name: 'beta' }); const second = await clients[2]!.wait('createRoom:result');
      const secondId = String(second.payload?.roomId);
      await joinRoom(clients[3]!, secondId);
      await joinRoom(clients[2]!, secondId);
      clients[0]!.send('start'); await clients[0]!.wait('start:result');
      clients[2]!.send('start'); await clients[2]!.wait('start:result');
      return `两个独立房间 ${firstId} / ${secondId} 同时运行`;
    });
    await check('authoritative-state', '服务端权威位置与独立玩家状态', async () => {
      clients[0]!.send('move', { position: { x: 3, y: 1 } }); await clients[0]!.wait('move:result');
      clients[1]!.send('move', { position: { x: 1, y: 2 } }); await clients[1]!.wait('move:result');
      const state = await clients[1]!.state();
      const players = state.payload?.players as Array<{ username: string; position: { x: number; y: number } }>;
      const p0 = players.find(player => player.username === 'player0');
      const p1 = players.find(player => player.username === 'player1');
      if (p0?.position.x !== 3 || p1?.position.x !== 1 || players.some(player => player.username === 'player2')) throw new Error('位置未独立或房间状态串扰');
      clients[0]!.send('move', { position: { x: 9999, y: 9999 } });
      const error = await clients[0]!.wait('error');
      if (!String(error.payload?.message).includes('越界')) throw new Error('非法坐标未被拒绝');
      return '两名玩家位置独立，越界移动被服务端拒绝';
    });
    const rounds = Math.max(1, options.rounds ?? 1);
    await check('gameplay-settlement', config.genre === 'fps' ? 'FPS 动作、血量与回合结算' : 'RPG 共享场景、背包、任务与结算', async () => {
      for (let round = 0; round < rounds; round += 1) {
        if (round > 0) { clients[0]!.send('start'); await clients[0]!.wait('start:result'); }
        await delay(180);
        if (config.genre === 'fps') {
          for (let hit = 0; hit < 4; hit += 1) { clients[0]!.send('action', { targetId: clients[1]!.id }); await clients[0]!.wait('action:result'); await delay(180); }
          const state = await clients[0]!.state();
          const players = state.payload?.players as Array<{ username: string; score: number; health: number }>;
          if ((players.find(player => player.username === 'player0')?.score ?? 0) < 1) throw new Error('击杀计分未生效');
          if ((players.find(player => player.username === 'player1')?.health ?? 0) !== 100) throw new Error('重生血量未恢复');
        } else {
          for (let action = 0; action < 3; action += 1) { clients[0]!.send('action', { action: 'gather' }); await clients[0]!.wait('action:result'); await delay(180); }
          const state = await clients[0]!.state();
          const players = state.payload?.players as Array<{ username: string; quest: number; inventory: Record<string, number> }>;
          const player = players.find(item => item.username === 'player0');
          if (!player || player.quest !== 3 || player.inventory.herb !== 3 || player.inventory.reward !== 1) throw new Error('任务/背包/奖励未生效');
          if ((players.find(item => item.username === 'player1')?.quest ?? -1) !== 0) throw new Error('任务进度未隔离');
        }
        clients[0]!.send('end'); const result = await clients[0]!.wait('end:result');
        const scores = result.payload?.scores as unknown[];
        if (!Array.isArray(scores) || scores.length !== 2) throw new Error('结算缺少同场玩家');
      }
      return `${rounds} 回合真实动作与服务端结算完成`;
    });
    let resumedClient: Client | undefined;
    await check('reconnect', '断线 resume token 重连', async () => {
      const original = clients[0]!;
      const id = original.id;
      const tokenValue = original.resumeToken;
      if (!tokenValue) throw new Error('未下发 resume token');
      await original.close();
      const restored = await resume(url, tokenValue, clientOptions);
      resumedClient = restored;
      clients.push(restored);
      if (restored.id !== id) throw new Error('重连后玩家身份变化');
      return `恢复玩家 ${id}`;
    });
    await check('persistence-restart', '服务重启后恢复房间与玩家状态', async () => {
      if (!resumedClient) throw new Error('没有可用的重连客户端');
      const before = await resumedClient.state();
      const beforePlayer = before.payload?.player as { score?: number; quest?: number; inventory?: Record<string, number> } | undefined;
      for (const client of clients) await client.close();
      if (server) { server.kill(); await Promise.race([new Promise<void>(resolve => server!.once('close', () => resolve())), delay(3_000)]); }
      await startServer();
      const restored = await connectValidationClient(url, 'player0', 'password-0-secret', 'login', clientOptions);
      await joinRoom(restored, firstId);
      const after = await restored.state();
      const recovered = after.payload?.player as { score?: number; quest?: number; inventory?: Record<string, number> } | undefined;
      if (config.genre === 'rpg') {
        if (!recovered || recovered.quest !== beforePlayer?.quest || recovered.inventory?.herb !== beforePlayer?.inventory?.herb) throw new Error('重启后 RPG 状态丢失');
      } else if (!recovered || recovered.score !== beforePlayer?.score) throw new Error('重启后 FPS 积分丢失');
      clients.push(restored);
      return config.genre === 'rpg' ? `任务=${recovered.quest} 草药=${recovered.inventory?.herb}` : `积分=${recovered.score}`;
    });
    const load = Math.max(0, options.loadClients ?? 0);
    if (load > 0) await check('load-gameplay', '模拟客户端真实房间与状态变更负载', async () => {
      for (let index = 0; index < load; index += 1) {
        const client = await connectValidationClient(url, `load${index}`, `load-password-${index}`, 'register', clientOptions);
        clients.push(client);
        client.send('createRoom', { name: `load-${index}` });
        const created = await client.wait('createRoom:result');
        await joinRoom(client, String(created.payload?.roomId));
        if (index % 2 === 1) {
          const peer = clients[clients.length - 2]!;
          if (peer.username.startsWith('load')) { peer.send('join', { roomId: String(created.payload?.roomId) }); await peer.wait('join:result'); await peer.wait('welcome'); }
        }
        client.send('start'); await client.wait('start:result');
        client.send('move', { position: { x: 2, y: 2 } }); await client.wait('move:result');
        client.send('action', config.genre === 'fps' ? { targetId: client.id } : { action: 'gather' });
        await client.wait('action:result');
      }
      return `${load} 个模拟客户端完成真实房间、移动与动作状态变更`;
    });
    if (options.docker === true) {
      for (const client of clients) await client.close().catch(() => undefined);
      if (server && server.exitCode === null) { const nativeServer = server; server = undefined; nativeServer.kill(); await Promise.race([new Promise<void>(resolve => nativeServer.once('close', () => resolve())), delay(3_000)]); }
      const timeoutMs = Math.min(900_000, Math.max(1_000, options.dockerTimeoutMs ?? 300_000));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error(`Docker 验证超过 ${timeoutMs}ms`)), timeoutMs);
      timer.unref();
      const abort = (): void => controller.abort(options.signal?.reason);
      if (options.signal?.aborted) abort(); else options.signal?.addEventListener('abort', abort, { once: true });
      const dockerClients: Client[] = [];
      const project = `revival-${path.basename(root).toLowerCase().replace(/[^a-z0-9_-]/g, '-')}-${process.pid}`;
      const compose = ['compose', '-p', project, '-f', 'docker-compose.yml'];
      const dockerEnv = { ...process.env, ADMIN_TOKEN: token, ADMIN_HOST: '0.0.0.0', GAME_PUBLISH_PORT: String(gamePort), ADMIN_PUBLISH_PORT: String(adminPort) };
      const commands: Array<{ command: string; output: string }> = [];
      const evidence: Record<string, unknown> = { project, timeoutMs, commands, healthcheck: null, websocket: null, admin: null, cleanedUp: false };
      let upAttempted = false;
      const docker = (args: string[], commandTimeout = 60_000): Promise<string> => runValidationCommand('docker', [...compose, ...args], root, { signal: controller.signal, maxOutput: 64 * 1024, timeoutMs: Math.max(1, Math.min(commandTimeout, timeoutMs)), env: dockerEnv });
      deployment = { docker: { tested: true, command: `docker ${compose.join(' ')} up --build -d; docker ${compose.join(' ')} down -v` } };
      try {
        const available = await check('docker-available', 'Docker Compose 可用', async () => {
          const version = await runValidationCommand('docker', ['compose', 'version'], root, { signal: controller.signal, maxOutput: 4_096, timeoutMs: Math.min(15_000, timeoutMs) });
          commands.push({ command: 'docker compose version', output: version.trim() });
          return version.trim();
        });
        if (available) {
          await check('docker-up', '真实 docker compose up --build -d', async () => {
            upAttempted = true;
            const output = await docker(['up', '--build', '-d'], Math.max(1, timeoutMs - 30_000));
            commands.push({ command: `docker ${compose.join(' ')} up --build -d`, output: output.trim().slice(-4_096) });
            return output.trim().slice(-1_024) || '容器已启动';
          });
          if (passed('docker-up')) await check('docker-health', '轮询容器健康检查与管理健康端点', async () => {
            const deadline = Date.now() + Math.min(90_000, timeoutMs);
            let last = '';
            while (Date.now() < deadline) {
              controller.signal.throwIfAborted();
              const id = (await docker(['ps', '-aq', 'game'], 10_000)).trim();
              if (id) {
                const status = (await runValidationCommand('docker', ['inspect', '--format', '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}', id], root, { signal: controller.signal, maxOutput: 1_024, timeoutMs: 10_000 })).trim();
                if (status === 'exited' || status === 'dead') {
                  const logs = await docker(['logs', '--tail', '200', 'game'], 10_000).catch(() => '');
                  throw new Error(`Docker 容器启动后退出: ${status}\n${logs}`);
                }
                try {
                  const response = await fetchWithTimeout(`${adminUrl}/health`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal }, 3_000);
                  last = `container=${status} http=${response.status}`;
                  if (status === 'healthy' && response.ok && (await response.json() as { ok?: boolean }).ok === true) {
                    evidence.healthcheck = { containerId: id, status, httpStatus: response.status };
                    return last;
                  }
                } catch (error) {
                  if (controller.signal.aborted) throw error;
                  last = `container=${status} http=unavailable`;
                }
              } else last = '容器尚未创建';
              await delay(500);
            }
            const diagnostics = await Promise.all([
              docker(['ps', '-a'], 10_000).catch(() => ''),
              docker(['logs', '--tail', '200', 'game'], 10_000).catch(() => ''),
            ]);
            throw new Error(`Docker 健康检查超时: ${last}\n${diagnostics.join('\n')}`);
          });
          if (passed('docker-health')) await check('docker-admin-auth', 'Docker 管理 API 认证、统计与审计', async () => {
            const denied = await fetchWithTimeout(`${adminUrl}/stats`, { signal: controller.signal }, options.fetchTimeoutMs);
            if (denied.status !== 401) throw new Error('未认证管理请求未返回 401');
            const response = await fetchWithTimeout(`${adminUrl}/stats`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal }, options.fetchTimeoutMs);
            if (!response.ok) throw new Error(`管理统计返回 ${response.status}`);
            const stats = await response.json() as Record<string, unknown>;
            const audit = await (await fetchWithTimeout(`${adminUrl}/audit`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal }, options.fetchTimeoutMs)).text();
            if (stats.genre !== config.genre || !audit.includes('denied /stats')) throw new Error('管理统计或审计日志缺失');
            evidence.admin = { deniedStatus: denied.status, stats };
            return JSON.stringify(stats);
          });
          if (passed('docker-admin-auth')) await check('docker-ws-two-players', 'Docker 至少两个 WebSocket 客户端同场认证与对局', async () => {
            const first = await connectValidationClient(url, 'dockerplayer0', 'docker-password-0', 'register', { signal: controller.signal, handshakeTimeoutMs: options.handshakeTimeoutMs });
            dockerClients.push(first);
            const second = await connectValidationClient(url, 'dockerplayer1', 'docker-password-1', 'register', { signal: controller.signal, handshakeTimeoutMs: options.handshakeTimeoutMs });
            dockerClients.push(second);
            first.send('createRoom', { name: 'docker-match' });
            const created = await first.wait('createRoom:result');
            const roomId = String(created.payload?.roomId ?? '');
            if (!roomId) throw new Error('未创建 Docker 对局房间');
            await joinRoom(first, roomId);
            await joinRoom(second, roomId);
            first.send('start');
            await first.wait('start:result');
            const state = await second.state();
            const players = state.payload?.players as Array<{ username: string }>;
            if (!players.some(player => player.username === 'dockerplayer0') || !players.some(player => player.username === 'dockerplayer1')) throw new Error('两个 Docker 客户端未同场');
            evidence.websocket = { roomId, players: players.map(player => player.username), authenticated: 2 };
            return `房间 ${roomId} 内两名认证玩家同场`;
          });
        }
      } catch (error) {
        errors.push(`Docker 验证: ${error instanceof Error ? error.message : String(error)}`);
        if (!checks.some(item => item.id === 'docker-up' && !item.passed)) checks.push({ id: 'docker-up', name: '真实 docker compose up --build -d', passed: false, detail: error instanceof Error ? error.message : String(error) });
      } finally {
        for (const client of dockerClients) await client.close().catch(() => undefined);
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
        if (upAttempted) await check('docker-cleanup', '真实 docker compose down -v 清理（重试与项目级兜底）', async () => {
          const cleanupController = new AbortController();
          const cleanupTimer = setTimeout(() => cleanupController.abort(), Math.min(60_000, timeoutMs));
          cleanupTimer.unref();
          try {
            const output = await cleanupDockerProject({
              project, root, timeoutMs: Math.min(60_000, timeoutMs), env: dockerEnv,
              containerIds: [String((evidence.healthcheck as { containerId?: string } | null)?.containerId ?? '')],
              runCommand: (command, args, cwd, commandOptions) => runValidationCommand(command, args, cwd, { ...commandOptions, signal: cleanupController.signal }),
            });
            commands.push({ command: `docker ${compose.join(' ')} down -v --remove-orphans（含重试与项目 label 兜底）`, output: output.trim().slice(-4_096) });
            evidence.cleanedUp = true;
            return output.trim().slice(-1_024) || '容器与卷已删除';
          } finally { clearTimeout(cleanupTimer); }
        });
        deployment!.docker.evidence = JSON.stringify(evidence);
      }
    }
  } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  finally {
    for (const client of clients) await client.close().catch(() => undefined);
    if (server && server.exitCode === null) { server.kill(); await Promise.race([new Promise<void>(resolve => server!.once('close', () => resolve())), delay(3_000)]); }
    if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
  const spec = JSON.parse(await readFile(path.join(root, 'BUILD-INFO.json'), 'utf8').catch(() => '{"genre":"fps"}')) as { genre: 'fps' | 'rpg' };
  const capabilities: GameValidationCapabilities = {
    build: passed('install') && passed('build') && passed('unit-tests'),
    independentStart: passed('independent-start'),
    twoPlayerSameMatch: passed('room-isolation') && passed('gameplay-settlement'),
    roomIsolation: passed('room-isolation'),
    serverAuthoritativeState: passed('authoritative-state'),
    persistence: passed('persistence-restart'),
    reconnect: passed('reconnect'),
    settlement: passed('gameplay-settlement'),
    adminAuth: passed('admin-auth'),
    multiRoomConcurrency: passed('room-isolation'),
    dockerDeployment: options.docker === true && ['docker-available', 'docker-up', 'docker-health', 'docker-admin-auth', 'docker-ws-two-players', 'docker-cleanup'].every(id => passed(id)),
  };
  return {
    schemaVersion: 1,
    valid: errors.length === 0 && checks.length > 0 && checks.every(item => item.passed),
    genre: spec.genre ?? config.genre,
    gameMode: config.genre === 'fps' ? 'team-deathmatch' : 'shared-quest',
    transport: 'websocket',
    clients: [{ kind: 'real-game-client', count: Math.max(4, options.players ?? 4) }, ...(options.loadClients ? [{ kind: 'simulated-load' as const, count: Math.max(0, options.loadClients) }] : [])],
    capabilities,
    ...(deployment ? { deployment } : {}),
    metrics: { durationMs: Date.now() - Date.parse(startedAt), rooms: 2, players: Math.max(4, options.players ?? 4), rounds: Math.max(1, options.rounds ?? 1), loadClients: Math.max(0, options.loadClients ?? 0) },
    checks,
    projectDir: root,
    files: generatedFiles,
    sha256: generatedSha,
    errors,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}

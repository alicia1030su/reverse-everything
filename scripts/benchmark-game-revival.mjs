import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MB = 1024 * 1024;
const DEFAULT_CLIENTS = [2, 8, 16, 32, 64];
const DEFAULT_OUTPUT = 'artifacts/v006-game-benchmark.json';
const COMMAND_TIMEOUT_MS = 180_000;
const TIER_TIMEOUT_MS = 180_000;
const START_TIMEOUT_MS = 20_000;
const WS_HANDSHAKE_TIMEOUT_MS = 10_000;
const WS_MESSAGE_TIMEOUT_MS = 10_000;
const AUTH_BATCH_SIZE = 16;
const ACTION_ROUNDS = 20;
const ACTION_INTERVAL_MS = 175;
const RESOURCE_SAMPLE_INTERVAL_MS = 250;

function parseArgs(argv) {
  const config = { clients: [...DEFAULT_CLIENTS], output: DEFAULT_OUTPUT, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') config.help = true;
    else if (argument === '--clients') {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error('--clients 缺少逗号分隔的客户端数量');
      config.clients = value.split(',').map(item => {
        const parsed = Number(item.trim());
        if (!Number.isSafeInteger(parsed) || parsed < 2 || parsed > 256) throw new Error(`--clients 包含无效数量: ${item}`);
        return parsed;
      });
    } else if (argument === '--output') {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error('--output 缺少文件路径');
      config.output = value;
    } else throw new Error(`未知参数: ${argument}`);
  }
  if (new Set(config.clients).size !== config.clients.length) throw new Error('--clients 不允许重复数量');
  return config;
}

function round(value, digits = 3) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function summarizeLatencies(values) {
  if (!values.length) return { count: 0, p50Ms: null, p95Ms: null, minMs: null, maxMs: null, meanMs: null };
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    count: values.length,
    p50Ms: round(percentile(values, 0.5)),
    p95Ms: round(percentile(values, 0.95)),
    minMs: round(Math.min(...values)),
    maxMs: round(Math.max(...values)),
    meanMs: round(total / values.length),
  };
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function killTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
}

function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function runCommand(command, args, cwd, timeoutMs, env = process.env) {
  return new Promise(resolve => {
    const started = performance.now();
    const child = spawn(command, args, {
      cwd,
      env,
      shell: process.platform === 'win32',
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ command: [command, ...args].join(' '), cwd, durationMs: round(performance.now() - started), stdoutTail: stdout.slice(-8_192), stderrTail: stderr.slice(-8_192), ...result });
    };
    child.stdout.on('data', chunk => { stdout = (stdout + chunk.toString()).slice(-64_000); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-64_000); });
    child.once('error', error => finish({ ok: false, exitCode: null, signal: null, timedOut: false, error: error.message }));
    child.once('close', (code, signal) => finish({ ok: code === 0, exitCode: code, signal, timedOut: false }));
    const timer = setTimeout(() => {
      const error = `命令超时 ${timeoutMs}ms: ${command} ${args.join(' ')}`;
      killTree(child);
      finish({ ok: false, exitCode: null, signal: null, timedOut: true, error });
    }, timeoutMs);
  });
}

function assertCommand(result, name) {
  if (result.ok) return;
  throw new Error(`${name}失败: ${result.error ?? `退出码 ${result.exitCode}`}\n${result.stderrTail || result.stdoutTail}`);
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(signal?.reason ?? new Error('操作被取消'));
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function freePort() {
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

class BenchmarkClient {
  constructor(url, index) {
    this.index = index;
    this.username = `bench${index}`;
    this.password = `benchmark-password-${index}`;
    this.socket = new WebSocket(url, { maxPayload: 64 * 1024 });
    this.messages = [];
    this.waiters = [];
    this.failure = null;
    this.token = '';
    this.playerId = '';
    this.handshakeMs = null;
    this.socket.on('message', raw => this.onMessage(raw));
    this.socket.on('error', error => this.fail(new Error(`WebSocket 错误: ${error.message}`)));
    this.socket.on('close', () => this.fail(new Error('WebSocket 已关闭')));
  }

  onMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw.toString());
      if (!message || typeof message !== 'object' || typeof message.type !== 'string') throw new Error('消息结构无效');
    } catch (error) {
      this.fail(new Error(`WebSocket 非法 JSON: ${error instanceof Error ? error.message : String(error)}`));
      this.socket.close(1002, 'Invalid JSON');
      return;
    }
    if (message.type === 'error') {
      const waiter = this.waiters.find(item => item.type !== 'error');
      if (waiter) {
        this.removeWaiter(waiter);
        waiter.reject(new Error(`服务端错误: ${JSON.stringify(message.payload ?? {})}`));
      } else this.messages.push(message);
      return;
    }
    const waiter = this.waiters.find(item => item.type === message.type);
    if (waiter) {
      this.removeWaiter(waiter);
      waiter.resolve(message);
    } else this.messages.push(message);
  }

  fail(error) {
    if (this.failure) return;
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.abort?.();
      waiter.reject(error);
    }
  }

  removeWaiter(waiter) {
    const index = this.waiters.indexOf(waiter);
    if (index >= 0) this.waiters.splice(index, 1);
    clearTimeout(waiter.timer);
    waiter.abort?.();
  }

  static async connect(url, index, signal) {
    const client = new BenchmarkClient(url, index);
    const started = performance.now();
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          client.socket.terminate();
          reject(new Error(`WebSocket 握手超时 ${WS_HANDSHAKE_TIMEOUT_MS}ms`));
        }, WS_HANDSHAKE_TIMEOUT_MS);
        const abort = () => {
          clearTimeout(timer);
          client.socket.terminate();
          reject(signal?.reason ?? new Error('WebSocket 握手被取消'));
        };
        signal?.addEventListener('abort', abort, { once: true });
        client.socket.once('open', () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          resolve();
        });
        client.socket.once('error', error => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          reject(error);
        });
        client.socket.once('close', () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          reject(new Error('WebSocket 握手期间关闭'));
        });
      });
      client.handshakeMs = performance.now() - started;
      return client;
    } catch (error) {
      client.socket.terminate();
      throw error;
    }
  }

  send(type, payload = {}) {
    if (this.socket.readyState !== WebSocket.OPEN) throw this.failure ?? new Error('WebSocket 未打开');
    this.socket.send(JSON.stringify({ type, payload, requestId: `${Date.now()}-${Math.random()}` }));
  }

  wait(type, timeoutMs = WS_MESSAGE_TIMEOUT_MS, signal) {
    if (this.failure) return Promise.reject(this.failure);
    const queued = this.messages.findIndex(message => message.type === type);
    if (queued >= 0) return Promise.resolve(this.messages.splice(queued, 1)[0]);
    const errorIndex = this.messages.findIndex(message => message.type === 'error');
    if (errorIndex >= 0) {
      const message = this.messages.splice(errorIndex, 1)[0];
      return Promise.reject(new Error(`服务端错误: ${JSON.stringify(message.payload ?? {})}`));
    }
    return new Promise((resolve, reject) => {
      const waiter = { type, resolve, reject, timer: null, abort: null };
      waiter.timer = setTimeout(() => {
        this.removeWaiter(waiter);
        reject(new Error(`等待消息 ${type} 超时 ${timeoutMs}ms`));
      }, timeoutMs);
      waiter.abort = () => signal?.removeEventListener('abort', abort);
      const abort = () => {
        this.removeWaiter(waiter);
        reject(signal?.reason ?? new Error('等待消息被取消'));
      };
      if (signal?.aborted) { abort(); return; }
      signal?.addEventListener('abort', abort, { once: true });
      this.waiters.push(waiter);
    });
  }

  async authenticate(signal) {
    const started = performance.now();
    this.send('authenticate', { username: this.username, password: this.password, mode: 'register' });
    const authenticated = await this.wait('authenticated', WS_MESSAGE_TIMEOUT_MS, signal);
    this.token = String(authenticated.payload?.token ?? '');
    this.playerId = String(authenticated.payload?.playerId ?? '');
    if (!this.token || !this.playerId) throw new Error('认证响应缺少 token 或 playerId');
    this.send('authenticate', { token: this.token });
    await this.wait('authorized', WS_MESSAGE_TIMEOUT_MS, signal);
    return performance.now() - started;
  }

  async joinRoom(roomId, signal) {
    const started = performance.now();
    this.send('join', { roomId });
    const welcome = await this.wait('welcome', WS_MESSAGE_TIMEOUT_MS, signal);
    this.playerId = String(welcome.payload?.playerId ?? this.playerId);
    await this.wait('join:result', WS_MESSAGE_TIMEOUT_MS, signal);
    return performance.now() - started;
  }

  async move(position, signal) {
    const started = performance.now();
    this.send('move', { position });
    await this.wait('move:result', WS_MESSAGE_TIMEOUT_MS, signal);
    return performance.now() - started;
  }

  async action(targetId, signal) {
    const started = performance.now();
    this.send('action', { targetId });
    await this.wait('action:result', WS_MESSAGE_TIMEOUT_MS, signal);
    return performance.now() - started;
  }

  async close() {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    if (this.socket.readyState === WebSocket.CONNECTING) { this.socket.terminate(); return; }
    await new Promise(resolve => {
      const timer = setTimeout(() => { this.socket.terminate(); resolve(); }, 1_000);
      this.socket.once('close', () => { clearTimeout(timer); resolve(); });
      this.socket.close();
    });
  }
}

function parsePsCpuTime(value) {
  const parts = String(value ?? '').trim().split(':').map(Number);
  if (parts.some(part => !Number.isFinite(part))) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 1) return parts[0];
  return null;
}

function summarizeResources(samples, source, error) {
  if (!samples.length) return { available: false, source, sampleCount: 0, error: error ?? '未采集到进程样本' };
  const rss = samples.map(sample => sample.rssBytes / MB);
  const cpu = samples.map(sample => sample.cpuPercent).filter(value => Number.isFinite(value));
  const stats = values => values.length ? {
    min: round(Math.min(...values)),
    max: round(Math.max(...values)),
    mean: round(values.reduce((sum, value) => sum + value, 0) / values.length),
    last: round(values[values.length - 1]),
  } : null;
  return {
    available: true,
    source,
    sampleCount: samples.length,
    samplingIntervalMs: RESOURCE_SAMPLE_INTERVAL_MS,
    rssMB: stats(rss),
    cpuPercent: stats(cpu),
    cpuPercentNote: 'CPU 为单逻辑核百分比；超过 100% 表示使用多个逻辑核。',
    samples,
  };
}

function createResourceSampler(pid) {
  const samples = [];
  let samplerError = '';
  let child = null;
  let interval = null;
  let stopped = false;
  let buffer = '';

  const addSample = (rssBytes, cpuSeconds) => {
    if (!Number.isFinite(rssBytes) || !Number.isFinite(cpuSeconds)) return;
    const previous = samples[samples.length - 1];
    const sample = { at: Date.now(), rssBytes, cpuSeconds: round(cpuSeconds, 6), cpuPercent: null };
    if (previous) {
      const wallSeconds = (sample.at - previous.at) / 1000;
      const cpuDelta = sample.cpuSeconds - previous.cpuSeconds;
      if (wallSeconds > 0 && cpuDelta >= 0) sample.cpuPercent = round((cpuDelta / wallSeconds) * 100);
    }
    samples.push(sample);
  };

  if (process.platform === 'win32') {
    const script = [
      '$ErrorActionPreference = "Stop"',
      `$processId = ${pid}`,
      'while ($true) {',
      '  try {',
      '    $process = Get-Process -Id $processId -ErrorAction Stop',
      '    $process.Refresh()',
      '    $sample = [pscustomobject]@{ rssBytes = [int64]$process.WorkingSet64; cpuSeconds = [double]$process.CPU }',
      '    [Console]::Out.WriteLine(($sample | ConvertTo-Json -Compress))',
      '    [Console]::Out.Flush()',
      '  } catch { break }',
      `  Start-Sleep -Milliseconds ${RESOURCE_SAMPLE_INTERVAL_MS}`,
      '}',
    ].join('; ');
    child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        try {
          const sample = JSON.parse(line);
          addSample(Number(sample.rssBytes), Number(sample.cpuSeconds));
        } catch { /* 忽略监控进程的非 JSON 输出 */ }
      }
    });
    child.stderr.on('data', chunk => { samplerError = (samplerError + chunk.toString()).slice(-2_000); });
    child.on('error', error => { samplerError = error.message; });
  } else {
    const sample = () => {
      if (stopped) return;
      const ps = spawn('ps', ['-p', String(pid), '-o', 'rss=,time='], { stdio: ['ignore', 'pipe', 'ignore'] });
      let output = '';
      ps.stdout.setEncoding('utf8');
      ps.stdout.on('data', chunk => { output += chunk; });
      ps.once('close', code => {
        if (code === 0) {
          const match = output.trim().match(/^(\d+)\s+(\S+)$/);
          if (match) addSample(Number(match[1]) * 1024, parsePsCpuTime(match[2]));
        }
        if (!stopped) interval = setTimeout(sample, RESOURCE_SAMPLE_INTERVAL_MS);
      });
      ps.once('error', error => { samplerError = error.message; });
    };
    sample();
  }

  return {
    async stop() {
      if (stopped) return summarizeResources(samples, process.platform === 'win32' ? 'windows-powershell' : 'posix-ps', samplerError);
      stopped = true;
      if (interval) clearTimeout(interval);
      if (child && child.exitCode === null) {
        child.kill();
        await Promise.race([once(child, 'close').catch(() => undefined), delay(2_000).catch(() => undefined)]);
      }
      return summarizeResources(samples, process.platform === 'win32' ? 'windows-powershell' : 'posix-ps', samplerError);
    },
  };
}

async function updateChecksum(projectDir, relativePath, content) {
  const checksumPath = path.join(projectDir, 'SHA256SUMS.txt');
  const lines = (await readFile(checksumPath, 'utf8')).trimEnd().split('\n');
  const updated = lines.map(line => line.endsWith(`  ${relativePath}`) ? `${sha256(content)}  ${relativePath}` : line);
  const output = `${updated.join('\n')}\n`;
  await writeFile(checksumPath, output);
  return sha256(output);
}

async function generateProject(gameRevival, temporaryRoot, maxClients) {
  const fixtureDir = path.join(temporaryRoot, 'fixture');
  const projectDir = path.join(temporaryRoot, 'generated-fps');
  await mkdir(path.join(fixtureDir, 'assets'), { recursive: true });
  await writeFile(path.join(fixtureDir, 'assets', 'fps-map.json'), JSON.stringify({ name: 'v006-benchmark-arena', width: 128, height: 128 }));
  await writeFile(path.join(fixtureDir, 'client.exe'), Buffer.from([0x4d, 0x5a, 1, 2, 3]));
  const scan = await gameRevival.scanGameDirectory(fixtureDir);
  const spec = gameRevival.createGameServerSpec(
    { name: 'v006-benchmark-fps', root: fixtureDir, genre: 'fps', assets: ['assets'], observations: [{ path: 'client.exe', detail: '基准夹具客户端占位文件' }], limitations: [] },
    scan.files,
    [
      { kind: 'map', ref: 'assets/fps-map.json', detail: '基准地图尺寸', value: { name: 'v006-benchmark-arena', width: 128, height: 128 }, status: 'OBSERVED' },
      { kind: 'rule', ref: 'benchmark-config', detail: '基准房间容量与回合时长', value: { maxPlayers: maxClients, roundSeconds: 600 }, status: 'OBSERVED' },
    ],
  );
  const generated = await gameRevival.generateGameServer(spec, projectDir);
  const authPath = path.join(projectDir, 'server/src/auth.ts');
  const authBefore = await readFile(authPath, 'utf8');
  const authPattern = /const authRateLimiter = new AuthRateLimiter\([^;]*\);/;
  if (!authPattern.test(authBefore)) throw new Error('无法定位生成工程的认证限流配置');
  const authAfter = authBefore.replace(authPattern, 'const authRateLimiter = new AuthRateLimiter(10000);');
  await writeFile(authPath, authAfter);
  const patchedSha256 = await updateChecksum(projectDir, 'server/src/auth.ts', authAfter);
  const config = JSON.parse(await readFile(path.join(projectDir, 'config/default.json'), 'utf8'));
  if (config.genre !== 'fps' || Number(config.rules.maxPlayers) < maxClients) throw new Error('生成工程不是可容纳全部客户端的 FPS 工程');
  return {
    projectDir,
    projectName: spec.name,
    specId: spec.id,
    genre: spec.genre,
    level: spec.level,
    modules: spec.modules.map(module => module.name),
    fixtureFiles: scan.files.map(file => ({ path: file.relativePath, size: file.size, sha256: file.sha256 })),
    generatedFileCount: generated.files.length,
    generatorSha256: generated.sha256,
    patchedSha256,
    patches: [{
      file: 'server/src/auth.ts',
      beforeSha256: sha256(authBefore),
      afterSha256: sha256(authAfter),
      reason: '基准需在同一分钟注册超过 10 个账号；仅放大认证限流，不改变散列、token 或房间逻辑。',
    }],
    temporaryProjectRetained: false,
  };
}

async function startServer(projectDir, tierDir, clientCount) {
  const gamePort = await freePort();
  const adminPort = await freePort();
  const token = `v006-bench-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const dataFile = path.join(tierDir, 'game.json');
  const auditFile = path.join(tierDir, 'admin-audit.jsonl');
  const pidFile = path.join(tierDir, 'game.pid');
  const env = {
    ...process.env,
    ADMIN_TOKEN: token,
    GAME_PORT: String(gamePort),
    ADMIN_PORT: String(adminPort),
    GAME_HOST: '127.0.0.1',
    ADMIN_HOST: '127.0.0.1',
    ALLOWED_HOSTS: '127.0.0.1',
    MAX_CONNECTIONS: String(Math.max(256, clientCount + 16)),
    DATA_FILE: dataFile,
    AUDIT_FILE: auditFile,
    PID_FILE: pidFile,
  };
  const child = spawn(npmCommand(), ['start'], {
    cwd: projectDir,
    env,
    shell: process.platform === 'win32',
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  let spawnError = '';
  child.stdout.on('data', chunk => { stdout = (stdout + chunk.toString()).slice(-64_000); });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-64_000); });
  child.once('error', error => { spawnError = error.message; });
  const handle = { child, pid: null, gamePort, adminPort, token, dataFile, auditFile, pidFile, stdout: () => stdout, stderr: () => stderr };
  const started = Date.now();
  try {
    while (Date.now() - started < START_TIMEOUT_MS) {
      if (spawnError) throw new Error(`npm start 无法启动: ${spawnError}`);
      if (child.exitCode !== null) throw new Error(`npm start 提前退出 ${child.exitCode}: ${stderr || stdout}`);
      const pidText = await readFile(pidFile, 'utf8').catch(() => '');
      const pid = Number(pidText.trim());
      if (Number.isSafeInteger(pid) && pid > 0) handle.pid = pid;
      if (handle.pid && isProcessAlive(handle.pid)) {
        try {
          const response = await fetch(`http://127.0.0.1:${adminPort}/health`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(500) });
          if (response.ok && (await response.json()).ok === true) return handle;
        } catch { /* 服务尚未就绪 */ }
      }
      await delay(100);
    }
    throw new Error(`npm start 健康检查超时 ${START_TIMEOUT_MS}ms: ${stderr || stdout}`);
  } catch (error) {
    await stopServer(handle).catch(() => undefined);
    throw error;
  }
}

async function stopServer(handle) {
  if (!handle) return;
  if (handle.child.exitCode === null) killTree(handle.child);
  if (handle.pid && isProcessAlive(handle.pid)) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(handle.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else { try { process.kill(handle.pid, 'SIGKILL'); } catch { /* 已退出 */ } }
  }
  if (handle.child.exitCode === null) {
    await Promise.race([once(handle.child, 'close').catch(() => undefined), delay(3_000).catch(() => undefined)]);
  }
}

function failedTier(clientCount, error) {
  return {
    clients: clientCount,
    status: 'failed',
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    failureCount: 1,
    failures: [{ phase: 'setup', clientIndex: null, error: error instanceof Error ? error.message : String(error) }],
    actions: { roundsConfigured: ACTION_ROUNDS, roundsCompleted: 0, moveAttempts: 0, moveSuccesses: 0, actionAttempts: 0, actionSuccesses: 0 },
    serverProcess: { available: false, error: '服务未启动' },
  };
}

async function runTier(projectDir, temporaryRoot, clientCount, signal) {
  const startedAt = new Date().toISOString();
  const tierStarted = performance.now();
  const measurementStarted = performance.now();
  const tierDir = path.join(temporaryRoot, `tier-${clientCount}`);
  await mkdir(tierDir, { recursive: true });
  const result = {
    clients: clientCount,
    status: 'running',
    startedAt,
    finishedAt: null,
    durationMs: null,
    ports: null,
    phases: {},
    actions: { roundsConfigured: ACTION_ROUNDS, roundsCompleted: 0, moveAttempts: 0, moveSuccesses: 0, actionAttempts: 0, actionSuccesses: 0 },
    throughput: null,
    failures: [],
    failureCount: 0,
    serverProcess: { available: false },
    serverLogs: null,
  };
  const clients = [];
  let server = null;
  let sampler = null;
  const fail = (phase, clientIndex, error) => {
    result.failures.push({ phase, clientIndex, error: error instanceof Error ? error.message : String(error) });
    result.failureCount = result.failures.length;
  };
  try {
    server = await startServer(projectDir, tierDir, clientCount);
    result.ports = { game: server.gamePort, admin: server.adminPort, transport: 'websocket' };
    sampler = createResourceSampler(server.pid);
    const url = `ws://127.0.0.1:${server.gamePort}`;
    const authLatencies = [];
    const handshakeLatencies = [];
    for (let start = 0; start < clientCount; start += AUTH_BATCH_SIZE) {
      const indexes = Array.from({ length: Math.min(AUTH_BATCH_SIZE, clientCount - start) }, (_, offset) => start + offset);
      const batch = await Promise.allSettled(indexes.map(async index => {
        const client = await BenchmarkClient.connect(url, index, signal);
        clients.push(client);
        handshakeLatencies.push(client.handshakeMs);
        const authMs = await client.authenticate(signal);
        return { client, authMs };
      }));
      for (let index = 0; index < batch.length; index += 1) {
        const item = batch[index];
        if (item.status === 'fulfilled') authLatencies.push(item.value.authMs);
        else fail('authentication', indexes[index], item.reason);
      }
      if (result.failureCount) throw new Error('一个或多个客户端注册认证失败');
    }
    result.phases.websocketHandshake = summarizeLatencies(handshakeLatencies);
    result.phases.authentication = summarizeLatencies(authLatencies);

    const createStarted = performance.now();
    clients[0].send('createRoom', { name: `benchmark-${clientCount}` });
    const created = await clients[0].wait('createRoom:result', WS_MESSAGE_TIMEOUT_MS, signal);
    const roomId = String(created.payload?.roomId ?? '');
    if (!roomId) throw new Error('创建房间响应缺少 roomId');
    result.room = { id: roomId, createMs: round(performance.now() - createStarted) };

    const joinLatencies = [];
    const joins = await Promise.allSettled(clients.map(client => client.joinRoom(roomId, signal)));
    for (let index = 0; index < joins.length; index += 1) {
      if (joins[index].status === 'fulfilled') joinLatencies.push(joins[index].value);
      else fail('joinRoom', index, joins[index].reason);
    }
    result.phases.joinRoom = summarizeLatencies(joinLatencies);
    if (result.failureCount) throw new Error('一个或多个客户端加入房间失败');

    clients[0].send('start');
    await clients[0].wait('start:result', WS_MESSAGE_TIMEOUT_MS, signal);
    await delay(200, signal);

    const moveLatencies = [];
    const actionLatencies = [];
    const gameplayStarted = performance.now();
    const baseX = 1 + clientCount;
    for (let roundIndex = 0; roundIndex < ACTION_ROUNDS; roundIndex += 1) {
      const x = baseX + ((roundIndex % 5) - 2) * 0.1;
      const roundResults = await Promise.allSettled(clients.map(async (client, index) => {
        result.actions.moveAttempts += 1;
        let moveMs;
        try {
          moveMs = await client.move({ x, y: 1 + (index % 7) * 0.01 }, signal);
        } catch (error) {
          throw { phase: 'move', error };
        }
        result.actions.moveSuccesses += 1;
        result.actions.actionAttempts += 1;
        let actionMs;
        try {
          actionMs = await client.action(clients[(index + 1) % clients.length].playerId, signal);
        } catch (error) {
          throw { phase: 'action', error };
        }
        result.actions.actionSuccesses += 1;
        return { moveMs, actionMs };
      }));
      for (let index = 0; index < roundResults.length; index += 1) {
        const item = roundResults[index];
        if (item.status === 'fulfilled') {
          moveLatencies.push(item.value.moveMs);
          actionLatencies.push(item.value.actionMs);
        } else fail(item.reason?.phase ?? 'gameplay', index, item.reason?.error ?? item.reason);
      }
      result.actions.roundsCompleted = roundIndex + 1;
      if (result.failureCount) throw new Error('游戏动作轮次出现失败');
      if (roundIndex + 1 < ACTION_ROUNDS) await delay(ACTION_INTERVAL_MS, signal);
    }
    const gameplayWallMs = performance.now() - gameplayStarted;
    result.phases.move = summarizeLatencies(moveLatencies);
    result.phases.action = summarizeLatencies(actionLatencies);
    const measurementWallMs = performance.now() - measurementStarted;
    const authAndJoinOperations = authLatencies.length + joinLatencies.length;
    const gameplayOperations = moveLatencies.length + actionLatencies.length;
    result.throughput = {
      measurementWallMs: round(measurementWallMs),
      gameplayWallMs: round(gameplayWallMs),
      totalOperations: authAndJoinOperations + gameplayOperations,
      totalOperationsPerSecond: round((authAndJoinOperations + gameplayOperations) / (measurementWallMs / 1000)),
      gameplayOperations: gameplayOperations,
      gameplayOperationsPerSecond: round(gameplayOperations / (gameplayWallMs / 1000)),
      note: '总吞吐按认证、加入房间、移动和动作的成功请求/响应数除以对应墙钟时间；游戏吞吐仅统计移动与动作。',
    };
    result.status = 'passed';
  } catch (error) {
    result.status = 'failed';
    result.error = error instanceof Error ? error.message : String(error);
    if (!result.failureCount) fail('tier', null, error);
  } finally {
    for (const client of clients) await client.close().catch(() => undefined);
    if (sampler) {
      try { result.serverProcess = await sampler.stop(); }
      catch (error) { result.serverProcess = { available: false, error: error instanceof Error ? error.message : String(error) }; }
    }
    if (server) {
      result.serverLogs = { stdoutTail: server.stdout().slice(-4_096), stderrTail: server.stderr().slice(-4_096) };
      try { await stopServer(server); }
      catch (error) {
        fail('cleanup', null, error);
        result.status = 'failed';
      }
    }
    result.finishedAt = new Date().toISOString();
    result.durationMs = round(performance.now() - tierStarted);
  }
  return result;
}

async function runTierWithTimeout(projectDir, temporaryRoot, clientCount) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`档位 ${clientCount} 超过硬超时 ${TIER_TIMEOUT_MS}ms`)), TIER_TIMEOUT_MS);
  const inner = runTier(projectDir, temporaryRoot, clientCount, controller.signal);
  const aborted = new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }));
  try {
    return await Promise.race([inner, aborted]);
  } catch (error) {
    const partial = await inner.catch(() => null);
    return partial ?? failedTier(clientCount, error);
  } finally {
    clearTimeout(timer);
    controller.abort();
    await inner.catch(() => undefined);
  }
}

function environment() {
  const npmVersion = spawnSync(npmCommand(), ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' }).stdout?.trim() ?? null;
  const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout?.trim() ?? null;
  const cpus = os.cpus();
  return {
    platform: process.platform,
    arch: process.arch,
    os: `${os.type()} ${os.release()}`,
    node: process.version,
    npm: npmVersion,
    v8: process.versions.v8,
    cpu: cpus[0]?.model ?? 'unknown',
    logicalCores: cpus.length,
    totalMemoryMB: round(os.totalmem() / MB),
    freeMemoryMB: round(os.freemem() / MB),
    commit,
  };
}

async function writeReport(output, report) {
  const destination = path.resolve(ROOT, output);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(report, null, 2)}\n`);
  return destination;
}

async function main() {
  const config = parseArgs(process.argv.slice(2));
  if (config.help) {
    console.log(JSON.stringify({ usage: 'node scripts/benchmark-game-revival.mjs [--clients 2,8,16,32,64] [--output artifacts/v006-game-benchmark.json]', defaults: { clients: DEFAULT_CLIENTS, output: DEFAULT_OUTPUT }, actionRounds: ACTION_ROUNDS, tierTimeoutMs: TIER_TIMEOUT_MS }, null, 2));
    return;
  }
  const productVersion = (await readFile(path.join(ROOT, 'VERSION'), 'utf8')).trim();
  const report = {
    schemaVersion: 1,
    benchmark: 'v006-game-multiplayer-fps',
    productVersion,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    status: 'running',
    passed: false,
    exitCode: 0,
    environment: environment(),
    configuration: {
      clientCounts: config.clients,
      actionRounds: ACTION_ROUNDS,
      actionIntervalMs: ACTION_INTERVAL_MS,
      authBatchSize: AUTH_BATCH_SIZE,
      commandTimeoutMs: COMMAND_TIMEOUT_MS,
      tierTimeoutMs: TIER_TIMEOUT_MS,
      startTimeoutMs: START_TIMEOUT_MS,
      websocketHandshakeTimeoutMs: WS_HANDSHAKE_TIMEOUT_MS,
      websocketMessageTimeoutMs: WS_MESSAGE_TIMEOUT_MS,
      resourceSampleIntervalMs: RESOURCE_SAMPLE_INTERVAL_MS,
    },
    methodology: [
      '使用项目自身 game-revival 生成器创建临时独立 FPS 工程，并真实执行 npm ci、npm run build、每档 npm start。',
      '临时工程仅放大 AuthRateLimiter 上限以允许同分钟注册超过 10 个账号；注册按每批 16 个并发执行，避免触发模板默认 ScryptSemaphore 队列上限。',
      '每个档位使用独立服务进程、数据目录与房间；所有客户端加入同一房间并开始回合。',
      '每档执行 20 轮；每轮每个客户端各执行一次 move 和一次 action，因此每客户端至少 20 次移动和 20 次动作。',
      '延迟为客户端发送请求到收到对应响应的墙钟时间；p50/p95 使用 nearest-rank 百分位。',
      'RSS 与 CPU 来自服务端 PID 的周期采样；CPU 为单逻辑核百分比，采样不可用时明确记录而不伪造。',
    ],
    generation: null,
    setup: { npmCi: null, build: null },
    tiers: [],
    failures: [],
    summary: null,
  };
  let temporaryRoot = null;
  try {
    const gameRevival = await import('../packages/game-revival/dist/index.js');
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'v006-game-benchmark-'));
    report.generation = await generateProject(gameRevival, temporaryRoot, Math.max(...config.clients));
    report.setup.npmCi = await runCommand(npmCommand(), ['ci', '--no-audit', '--no-fund'], report.generation.projectDir, COMMAND_TIMEOUT_MS);
    assertCommand(report.setup.npmCi, 'npm ci');
    report.setup.build = await runCommand(npmCommand(), ['run', 'build'], report.generation.projectDir, COMMAND_TIMEOUT_MS);
    assertCommand(report.setup.build, 'npm run build');
    for (const clientCount of config.clients) {
      console.error(`[benchmark] 开始 ${clientCount} 客户端档位`);
      const tier = await runTierWithTimeout(report.generation.projectDir, temporaryRoot, clientCount);
      report.tiers.push(tier);
      console.error(`[benchmark] ${clientCount} 客户端档位: ${tier.status}, 失败=${tier.failureCount}, 动作成功=${tier.actions.actionSuccesses}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    report.failures.push({ phase: 'setup', error: message });
    for (const clientCount of config.clients) {
      if (!report.tiers.some(tier => tier.clients === clientCount)) report.tiers.push(failedTier(clientCount, message));
    }
  } finally {
    report.finishedAt = new Date().toISOString();
    report.summary = {
      tiersPassed: report.tiers.filter(tier => tier.status === 'passed').length,
      tiersFailed: report.tiers.filter(tier => tier.status === 'failed').length,
      totalFailures: report.failures.length + report.tiers.reduce((sum, tier) => sum + tier.failureCount, 0),
      totalClients: report.tiers.reduce((sum, tier) => sum + tier.clients, 0),
      totalActionAttempts: report.tiers.reduce((sum, tier) => sum + tier.actions.actionAttempts, 0),
      totalActionSuccesses: report.tiers.reduce((sum, tier) => sum + tier.actions.actionSuccesses, 0),
    };
    report.passed = report.failures.length === 0 && report.tiers.length === config.clients.length && report.tiers.every(tier => tier.status === 'passed');
    report.status = report.passed ? 'passed' : 'failed';
    report.exitCode = report.passed ? 0 : 1;
    const destination = await writeReport(config.output, report);
    report.output = destination;
    console.log(JSON.stringify({ output: destination, passed: report.passed, exitCode: report.exitCode, summary: report.summary, tiers: report.tiers.map(tier => ({ clients: tier.clients, status: tier.status, failureCount: tier.failureCount, actions: tier.actions, phases: tier.phases, throughput: tier.throughput, serverProcess: tier.serverProcess?.available ? { available: true, rssMB: tier.serverProcess.rssMB, cpuPercent: tier.serverProcess.cpuPercent } : tier.serverProcess })) }, null, 2));
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
    if (!report.passed) process.exitCode = 1;
  }
}

main().catch(error => {
  console.error(JSON.stringify({ schemaVersion: 1, benchmark: 'v006-game-multiplayer-fps', passed: false, fatalError: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
});

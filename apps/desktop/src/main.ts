import { app, BrowserWindow, Menu, Tray, nativeImage, shell, session } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createDesktopMetricsCollector,
  isUsableDesktopSnapshot,
  reportDesktopMetrics,
  type DesktopMetricsReport,
  type DesktopMetricsSnapshot,
  type DesktopMetricTrigger,
  type DesktopSidecarSnapshot,
} from './metrics.js';

const product = 'reverse-everything';
const version = app.getVersion();
const smoke = process.argv.includes('--smoke-test') || process.env.RE_SMOKE_TEST === '1';
const resourceDir = path.resolve(process.env.RE_RESOURCE_DIR ?? process.resourcesPath);
const npmCli = path.join(resourceDir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
process.env.RE_NPM_CLI = npmCli;
const dataDir = path.resolve(process.env.RE_DATA_DIR ?? path.join(app.getPath('appData'), product));
const logDir = path.join(dataDir, 'logs');
let api: ChildProcess | undefined;
let worker: ChildProcess | undefined;
let window: BrowserWindow | undefined;
let tray: Tray | undefined;
let baseUrl = '';
let localToken = '';
let quitting = false;
let stopping: Promise<void> | undefined;
let metricsTimer: NodeJS.Timeout | undefined;
let metricsQueue: Promise<void> = Promise.resolve();
let lastMetricsReport: DesktopMetricsReport | undefined;
let lastMetricsSnapshot: DesktopMetricsSnapshot | undefined;
let lastRunningTasks = 0;
const metricsCollector = createDesktopMetricsCollector({
  mainPid: process.pid,
  getAppMetrics: () => app.getAppMetrics(),
  getMemoryUsage: () => process.memoryUsage(),
  getCpuUsage: () => process.cpuUsage(),
  getActiveResourceCount: () => process.getActiveResourcesInfo().length,
  cpuCount: () => os.cpus().length,
});

app.setName(product);
app.setAppUserModelId('com.alicia1030su.reverse-everything');

const lock = app.requestSingleInstanceLock();
if (!lock) {
  app.exit(0);
} else {
  app.on('second-instance', () => {
    window?.show();
    window?.focus();
  });
}

async function log(message: string): Promise<void> {
  try {
    await mkdir(logDir, { recursive: true });
    await writeFile(path.join(logDir, 'desktop.log'), `${new Date().toISOString()} ${message}\n`, { flag: 'a' });
  } catch (error) {
    console.error('[desktop] failed to write diagnostic log', error);
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 4173;
      server.close(() => resolve(port));
    });
  });
}

interface Sidecar {
  child: ChildProcess;
  failure: Promise<never>;
}

function sidecar(relativeEntry: string, env: NodeJS.ProcessEnv): Sidecar {
  const entry = path.join(resourceDir, relativeEntry);
  const name = path.basename(entry);
  let rejectFailure!: (error: Error) => void;
  const failure = new Promise<never>((_resolve, reject) => {
    rejectFailure = reject;
  });
  void failure.catch(() => undefined);

  const child = spawn(process.execPath, [entry], {
    cwd: resourceDir,
    env: { ...process.env, ...env, ELECTRON_RUN_AS_NODE: '1', RE_RESOURCE_DIR: resourceDir },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: process.platform !== 'win32',
  });
  child.stdout?.on('data', chunk => void log(`[${name}] ${String(chunk).trim()}`));
  child.stderr?.on('data', chunk => void log(`[${name}] ${String(chunk).trim()}`));
  child.once('error', error => {
    void log(`[${name}] spawn error entry=${entry} resourceDir=${resourceDir}: ${error.stack ?? error}`);
    rejectFailure(new Error(`Sidecar ${name} failed to spawn: ${error.message}`));
  });
  child.on('exit', (code, signal) => void log(`${entry} exited code=${code} signal=${signal}`));
  void log(`[sidecar] started name=${name} pid=${child.pid ?? 'unknown'} entry=${entry} resourceDir=${resourceDir}`);
  return { child, failure };
}

async function serviceHealthy(): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1000) });
    if (!response.ok) return false;
    const health = await response.json() as { product?: string; version?: string };
    return health.product === product && health.version === version;
  } catch {
    return false;
  }
}

async function localResourceSnapshots(): Promise<{ api?: DesktopSidecarSnapshot; worker?: DesktopSidecarSnapshot }> {
  if (!baseUrl || !localToken) return {};
  try {
    const response = await fetch(`${baseUrl}/api/resources`, {
      headers: { authorization: `Bearer ${localToken}` },
      redirect: 'error',
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return {};
    const resources = await response.json() as { api?: DesktopSidecarSnapshot; worker?: DesktopSidecarSnapshot };
    return { ...(resources.api ? { api: resources.api } : {}), ...(resources.worker ? { worker: resources.worker } : {}) };
  } catch {
    return {};
  }
}

function sampleDesktopMetrics(requestedTrigger: DesktopMetricTrigger): Promise<DesktopMetricsReport | undefined> {
  const pending = metricsQueue.then(async () => {
    if (!baseUrl || !localToken) return undefined;
    try {
      const resources = await localResourceSnapshots();
      const runningTasks = resources.api?.runningTasks ?? resources.worker?.runningTasks ?? 0;
      const trigger = requestedTrigger === 'periodic' && runningTasks > 0 && lastRunningTasks === 0 ? 'task-running' : requestedTrigger;
      lastRunningTasks = runningTasks;
      const snapshot = metricsCollector.collect(trigger, [
        { kind: 'api', ...(api?.pid ? { pid: api.pid } : {}), ...(resources.api ? { snapshot: resources.api } : {}) },
        { kind: 'worker', ...(worker?.pid ? { pid: worker.pid } : {}), ...(resources.worker ? { snapshot: resources.worker } : {}) },
      ]);
      lastMetricsSnapshot = snapshot;
      const report = await reportDesktopMetrics({ baseUrl, token: localToken, snapshot });
      lastMetricsReport = report;
      await log(`[metrics] trigger=${trigger} reported=${report.ok} status=${report.status ?? 'network-error'} attempts=${report.attempts} processes=${snapshot.processes.length}/${snapshot.treeRssMB}MB limitations=${snapshot.limitations.length}`);
      return report;
    } catch {
      const report: DesktopMetricsReport = { ok: false, attempts: 0, error: 'Metrics collection failed' };
      lastMetricsReport = report;
      await log(`[metrics] trigger=${requestedTrigger} reported=false status=collection-error`);
      return report;
    }
  });
  metricsQueue = pending.then(() => undefined, () => undefined);
  return pending;
}

function startMetricsTimer(): void {
  if (metricsTimer) return;
  metricsTimer = setInterval(() => { void sampleDesktopMetrics('periodic'); }, 5000);
  metricsTimer.unref();
}

async function startServices(): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await log(`desktop starting version=${version} resourceDir=${resourceDir} dataDir=${dataDir}`);
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  const env = {
    RE_DATA_DIR: dataDir,
    RE_PORT: String(port),
    RE_HOST: '127.0.0.1',
    RE_ALLOW_REMOTE: 'false',
  };

  const apiEntry = path.join(resourceDir, 'apps/api/dist/server-entry.js');
  const workerEntry = path.join(resourceDir, 'apps/worker/dist/worker.js');
  await Promise.all([
    access(apiEntry).catch(() => { throw new Error(`Sidecar entry not found: ${apiEntry} (RE_RESOURCE_DIR=${resourceDir})`); }),
    access(workerEntry).catch(() => { throw new Error(`Sidecar entry not found: ${workerEntry} (RE_RESOURCE_DIR=${resourceDir})`); }),
  ]);

  const apiSidecar = sidecar('apps/api/dist/server-entry.js', env);
  api = apiSidecar.child;
  const workerSidecar = sidecar('apps/worker/dist/worker.js', env);
  worker = workerSidecar.child;

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const healthy = await Promise.race([serviceHealthy(), apiSidecar.failure, workerSidecar.failure]);
    if (healthy && api?.exitCode === null && worker?.exitCode === null) {
      localToken = (await readFile(path.join(dataDir, 'local-token'), 'utf8')).trim();
      if (!localToken) throw new Error('Local API token is empty');
      return;
    }
    if (api?.exitCode !== null && api?.exitCode !== undefined) {
      throw new Error(`API sidecar exited before becoming healthy (code=${api.exitCode}). See ${logDir}`);
    }
    if (worker?.exitCode !== null && worker?.exitCode !== undefined) {
      throw new Error(`Worker sidecar exited before becoming healthy (code=${worker.exitCode}). See ${logDir}`);
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Local services failed to become healthy. See ${logDir}`);
}

async function createWindow(): Promise<void> {
  await session.defaultSession.cookies.set({
    url: baseUrl,
    name: 're_local',
    value: localToken,
    httpOnly: true,
    sameSite: 'strict',
  });
  session.defaultSession.webRequest.onCompleted({
    urls: [`${baseUrl}/api/projects/*/tasks`, `${baseUrl}/api/tasks/*/resume`, `${baseUrl}/api/tasks/*/retry`],
  }, details => {
    if (details.method === 'POST' && details.statusCode >= 200 && details.statusCode < 300) {
      setTimeout(() => { if (!quitting) void sampleDesktopMetrics('task-running'); }, 250);
    }
  });
  window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1024,
    minHeight: 700,
    show: !smoke,
    title: `逆向万物 ${version}`,
    backgroundColor: '#080d14',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, devTools: !app.isPackaged },
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  await window.loadURL(baseUrl);
  if (!smoke) {
    tray = new Tray(nativeImage.createEmpty());
    tray.setToolTip(`逆向万物 ${version}`);
    tray.on('click', () => window?.show());
  }
}

async function runGameRevivalSmoke(): Promise<{ valid: boolean; genre: string; sha256: string; errors: string[]; checks: Array<{ id: string; passed: boolean }>; npmCli: string; nodeRuntime: string }> {
  const temporary = await mkdtemp(path.join(dataDir, 'game-revival-smoke-'));
  const previousPath = process.env.PATH;
  const previousElectronRunAsNode = process.env.ELECTRON_RUN_AS_NODE;
  try {
    const { createGameServerSpec, generateGameServer, scanGameDirectory, validateGeneratedServer } = await import(pathToFileURL(path.join(resourceDir, 'node_modules', '@reverse', 'game-revival', 'dist', 'index.js')).href);
    const assets = path.join(temporary, 'assets');
    await mkdir(assets);
    await writeFile(path.join(assets, 'fps-map.json'), JSON.stringify({ name: 'windows-smoke-arena', width: 96, height: 64 }));
    await writeFile(path.join(temporary, 'client.exe'), Buffer.from([0x4d, 0x5a, 1, 2, 3]));
    const scan = await scanGameDirectory(temporary);
    const spec = createGameServerSpec(
      { name: 'windows-smoke-fps', root: temporary, genre: 'fps', assets: ['assets'], observations: [{ path: 'client.exe', detail: 'Windows 安装 smoke 自有夹具' }], limitations: [] },
      scan.files,
      [{ kind: 'map', ref: 'assets/fps-map.json', detail: '地图尺寸', value: { name: 'windows-smoke-arena', width: 96, height: 64 }, status: 'OBSERVED' }],
    );
    const output = path.join(temporary, 'generated');
    await generateGameServer(spec, output);
    process.env.ELECTRON_RUN_AS_NODE = '1';
    process.env.RE_NPM_CLI = npmCli;
    let nodeRuntime = 'process.execPath';
    if (process.platform === 'win32') {
      const bin = path.join(temporary, 'bin');
      await mkdir(bin);
      await writeFile(path.join(bin, 'node.cmd'), `@"${process.execPath}" %*\r\n`);
      const systemRoot = process.env.SystemRoot;
      if (!systemRoot) throw new Error('SystemRoot is required for the isolated Windows smoke PATH');
      process.env.PATH = `${bin};${path.join(systemRoot, 'System32')};${systemRoot}`;
      nodeRuntime = 'packaged Electron node.cmd shim';
    }
    const report = await validateGeneratedServer(output, { players: 4, rounds: 1, commandTimeoutMs: 180000 }) as {
      valid: boolean;
      genre: string;
      sha256: string;
      errors: string[];
      checks: Array<{ id: string; passed: boolean }>;
    };
    const result = { valid: report.valid, genre: report.genre, sha256: report.sha256, errors: report.errors, checks: report.checks.map(check => ({ id: check.id, passed: check.passed })), npmCli, nodeRuntime };
    if (!report.valid || report.errors.length || report.checks.some(check => !check.passed)) throw new Error(`Game Revival smoke failed: ${report.errors.join('; ')}`);
    return result;
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    if (previousElectronRunAsNode === undefined) delete process.env.ELECTRON_RUN_AS_NODE; else process.env.ELECTRON_RUN_AS_NODE = previousElectronRunAsNode;
    await rm(temporary, { recursive: true, force: true });
  }
}

async function runSmoke(): Promise<void> {
  const gameRevival = await runGameRevivalSmoke();
  const result = await window!.webContents.executeJavaScript(`(async()=>{const health=await fetch('/api/health');const capabilities=await fetch('/api/capabilities');const resources=await fetch('/api/resources');return {healthStatus:health.status,health:await health.json(),capabilitiesStatus:capabilities.status,capabilities:await capabilities.json(),resourcesStatus:resources.status,resources:await resources.json()};})()`) as {
    healthStatus?: number;
    health?: { product?: string; version?: string };
    capabilitiesStatus?: number;
    capabilities?: { product?: { version?: string } };
    resourcesStatus?: number;
    resources?: { desktop?: unknown };
  };
  const desktop = result.resources?.desktop;
  const metricsStatus = lastMetricsReport?.ok && isUsableDesktopSnapshot(desktop) ? 'reported' : lastMetricsReport ? 'failed' : 'unavailable';
  const ok = result.health?.product === product && result.health?.version === version
    && result.capabilities?.product?.version === version
    && metricsStatus === 'reported'
    && gameRevival.valid;
  const output = process.env.RE_SMOKE_OUTPUT;
  if (output) {
    await writeFile(output, JSON.stringify({
      ok,
      version: result.capabilities?.product?.version,
      dataDir,
      resourceDir,
      gameRevival,
      diagnostics: result,
      desktopMetrics: {
        status: metricsStatus,
        report: lastMetricsReport,
        snapshot: isUsableDesktopSnapshot(desktop) ? desktop : lastMetricsSnapshot,
        roles: isUsableDesktopSnapshot(desktop) ? desktop.processes.map(process => process.role) : [],
      },
    }, null, 2));
  }
  await stop(ok ? 0 : 1);
}

function captureCommand(command: string, args: string[], timeoutMs = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let settled = false;
    const finish = (error?: Error, value = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout?.on('data', chunk => { output += String(chunk); });
    child.stderr?.on('data', chunk => { output += String(chunk); });
    child.once('error', error => finish(error));
    child.once('close', code => {
      if (code === 0) finish(undefined, output);
      else finish(new Error(`${command} exited code=${code}: ${output.trim()}`));
    });
  });
}

async function runCommand(command: string, args: string[]): Promise<void> {
  await captureCommand(command, args);
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', onExit);
  });
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function windowsProcessTree(rootPid: number): Promise<number[]> {
  const script = '$p=Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId; $p | ConvertTo-Json -Compress';
  const output = await captureCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
  const parsed = JSON.parse(output) as { ProcessId: number; ParentProcessId: number } | Array<{ ProcessId: number; ParentProcessId: number }> | null;
  const rows = parsed ? (Array.isArray(parsed) ? parsed : [parsed]) : [];
  const byParent = new Map<number, number[]>();
  for (const row of rows) {
    if (!Number.isSafeInteger(row.ProcessId) || !Number.isSafeInteger(row.ParentProcessId)) continue;
    const children = byParent.get(row.ParentProcessId) ?? [];
    children.push(row.ProcessId);
    byParent.set(row.ParentProcessId, children);
  }
  const result = [rootPid];
  const seen = new Set(result);
  for (let index = 0; index < result.length; index++) {
    for (const pid of byParent.get(result[index]!) ?? []) {
      if (seen.has(pid)) continue;
      seen.add(pid);
      result.push(pid);
    }
  }
  return result;
}

async function stopSidecar(child: ChildProcess | undefined, name: string): Promise<boolean> {
  if (!child?.pid) return true;
  const pid = child.pid;
  if (process.platform === 'win32') {
    let ownedPids: number[] | undefined;
    try {
      ownedPids = await windowsProcessTree(pid);
    } catch (error) {
      await log(`[sidecar] descendant snapshot unavailable name=${name} pid=${pid}: ${String(error)}`);
    }
    try {
      await runCommand('taskkill', ['/PID', String(pid), '/T', '/F']);
      await log(`[sidecar] taskkill completed name=${name} pid=${pid}`);
    } catch (error) {
      await log(`[sidecar] taskkill failed name=${name} pid=${pid}: ${String(error)}`);
      if (child.exitCode === null) child.kill();
    }
    const exited = await waitForExit(child, 5000);
    if (!exited) await log(`[sidecar] timed out waiting for process tree name=${name} pid=${pid}`);
    if (!ownedPids) return false;
    const alive = ownedPids.filter(processExists);
    if (alive.length) await log(`[sidecar] orphan processes remain name=${name} pids=${alive.join(',')}`);
    else await log(`[sidecar] orphan check clear name=${name} checked=${ownedPids.length}`);
    return exited && alive.length === 0;
  }

  try {
    process.kill(-pid, 'SIGTERM');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') await log(`[sidecar] SIGTERM failed name=${name} pid=${pid}: ${String(error)}`);
  }
  await waitForExit(child, 3000);
  if (processGroupExists(pid)) {
    try {
      process.kill(-pid, 'SIGKILL');
      await log(`[sidecar] escalated process group to SIGKILL name=${name} pid=${pid}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') await log(`[sidecar] SIGKILL failed name=${name} pid=${pid}: ${String(error)}`);
    }
  }
  const exited = await waitForExit(child, 5000);
  if (!exited) await log(`[sidecar] timed out waiting for process group name=${name} pid=${pid}`);
  const clear = exited && !processGroupExists(pid);
  await log(`[sidecar] orphan check ${clear ? 'clear' : 'failed'} name=${name} pid=${pid}`);
  return clear;
}

function stop(code = 0): Promise<void> {
  if (stopping) return stopping;
  quitting = true;
  stopping = (async () => {
    if (metricsTimer) clearInterval(metricsTimer);
    metricsTimer = undefined;
    await sampleDesktopMetrics('before-quit');
    window?.destroy();
    tray?.destroy();
    const [workerClear, apiClear] = await Promise.all([
      stopSidecar(worker, 'worker'),
      stopSidecar(api, 'api'),
    ]);
    await log(`desktop stopped exitCode=${code} sidecarOrphanCheck=${workerClear && apiClear ? 'clear' : 'failed'}`);
    app.exit(code);
  })();
  return stopping;
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  try {
    await startServices();
    await createWindow();
    await sampleDesktopMetrics('startup');
    startMetricsTimer();
    if (smoke) await runSmoke();
  } catch (error) {
    await log(`desktop startup failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    await stop(1);
  }
}).catch(async error => {
  await log(`desktop ready failed: ${String(error)}`);
  await stop(1);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') void stop();
});
app.on('before-quit', event => {
  if (!quitting) {
    event.preventDefault();
    void stop();
  }
});
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());

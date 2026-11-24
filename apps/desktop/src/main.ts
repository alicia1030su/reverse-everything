import { app, BrowserWindow, Menu, Tray, nativeImage, shell, session } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const product = 'reverse-everything';
const version = app.getVersion();
const smoke = process.argv.includes('--smoke-test');
const resourceDir = path.resolve(process.env.RE_RESOURCE_DIR ?? process.resourcesPath);
const dataDir = path.resolve(process.env.RE_DATA_DIR ?? path.join(app.getPath('appData'), product));
const logDir = path.join(dataDir, 'logs');
let api: ChildProcess | undefined;
let worker: ChildProcess | undefined;
let window: BrowserWindow | undefined;
let tray: Tray | undefined;
let baseUrl = '';
let quitting = false;
let stopping: Promise<void> | undefined;

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
    if (healthy && api?.exitCode === null && worker?.exitCode === null) return;
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
  const localToken = (await readFile(path.join(dataDir, 'local-token'), 'utf8')).trim();
  await session.defaultSession.cookies.set({
    url: baseUrl,
    name: 're_local',
    value: localToken,
    httpOnly: true,
    sameSite: 'strict',
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
  if (smoke) {
    const result = await window.webContents.executeJavaScript(`(async()=>{const health=await fetch('/api/health');const capabilities=await fetch('/api/capabilities');return {healthStatus:health.status,health:await health.json(),capabilitiesStatus:capabilities.status,capabilities:await capabilities.json()};})()`) as {
      healthStatus?: number;
      health?: { product?: string; version?: string };
      capabilitiesStatus?: number;
      capabilities?: { product?: { version?: string } };
    };
    const ok = result.health?.product === product && result.health?.version === version && result.capabilities?.product?.version === version;
    const output = process.env.RE_SMOKE_OUTPUT;
    if (output) {
      await writeFile(output, JSON.stringify({ ok, version: result.capabilities?.product?.version, dataDir, resourceDir, diagnostics: result }, null, 2));
    }
    await stop(ok ? 0 : 1);
  } else {
    tray = new Tray(nativeImage.createEmpty());
    tray.setToolTip(`逆向万物 ${version}`);
    tray.on('click', () => window?.show());
  }
}

function runCommand(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout?.on('data', chunk => { output += String(chunk); });
    child.stderr?.on('data', chunk => { output += String(chunk); });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited code=${code} signal=${signal}: ${output.trim()}`));
    });
  });
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

async function stopSidecar(child: ChildProcess | undefined, name: string): Promise<void> {
  if (!child?.pid) return;
  const pid = child.pid;
  if (process.platform === 'win32') {
    try {
      await runCommand('taskkill', ['/PID', String(pid), '/T', '/F']);
      await log(`[sidecar] taskkill completed name=${name} pid=${pid}`);
    } catch (error) {
      await log(`[sidecar] taskkill failed name=${name} pid=${pid}: ${String(error)}`);
      if (child.exitCode === null) child.kill();
    }
    const exited = await waitForExit(child, 5000);
    if (!exited) await log(`[sidecar] timed out waiting for process tree name=${name} pid=${pid}`);
    return;
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
}

function stop(code = 0): Promise<void> {
  if (stopping) return stopping;
  quitting = true;
  stopping = (async () => {
    window?.destroy();
    tray?.destroy();
    await Promise.all([
      stopSidecar(worker, 'worker'),
      stopSidecar(api, 'api'),
    ]);
    await log(`desktop stopped exitCode=${code}`);
    app.exit(code);
  })();
  return stopping;
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  try {
    await startServices();
    await createWindow();
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

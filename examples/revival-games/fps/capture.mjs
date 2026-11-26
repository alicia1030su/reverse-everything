import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runFpsScenario, GameClient } from './client.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'owned-fps-'));
const dataFile = join(temporary, 'accounts.json');
const messages = [];
const record = (event) => messages.push({ sequence: messages.length + 1, at: new Date().toISOString(), ...event });
let child;

async function startServer() {
  child = spawn(process.execPath, [join(here, 'original-server.mjs')], {
    env: { ...process.env, FPS_PORT: '0', FPS_DATA_FILE: dataFile }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('FPS 服务启动超时')), 5000);
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const line = buffer.split('\n').find((entry) => entry.startsWith('FPS_SERVER_READY '));
      if (line) { clearTimeout(timer); resolve(JSON.parse(line.slice('FPS_SERVER_READY '.length)).url); }
    });
    child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`FPS 服务提前退出 ${code}`)); });
  });
}

async function stopServer() {
  if (!child || child.exitCode !== null) return;
  await new Promise((resolve) => { child.once('exit', resolve); child.kill('SIGTERM'); });
}

try {
  const url = await startServer();
  const scenario = await runFpsScenario(url, record);
  await stopServer();
  const restartUrl = await startServer();
  const restored = new GameClient(restartUrl, 'restart-check', record);
  await restored.connect();
  const account = await restored.send('auth.login', { username: 'alpha_owned', password: 'owned-test-password' });
  if (account.account.wins !== 1) throw new Error('重启后账号胜场未恢复');
  restored.close();
  scenario.restartRestoredWins = account.account.wins;
  const output = join(here, 'captured-trace.json');
  await writeFile(output, JSON.stringify({
    schemaVersion: 1, game: 'owned-fps', capturedAt: new Date().toISOString(),
    source: 'original-server.mjs + real WebSocket clients', messageCount: messages.length,
    messages, verification: scenario,
  }, null, 2));
  console.log(JSON.stringify({ output, messageCount: messages.length, verification: scenario }, null, 2));
} finally {
  await stopServer();
  await rm(temporary, { recursive: true, force: true });
}

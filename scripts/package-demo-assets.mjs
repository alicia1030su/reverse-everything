import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeLegacySoftware, createReconstructionSpec, generateReconstructionProject, writeReconstructionProject } from '../packages/legacy-revival/dist/index.js';
import { zipDirectory } from '../apps/api/dist/game-archive.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TAR = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'tar.exe') : 'tar';
const { version } = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
await mkdir(path.join(ROOT, 'dist'), { recursive: true });
const stage = await mkdtemp(path.join(ROOT, 'dist/demos-'));
const release = path.join(ROOT, 'dist/release');
await mkdir(release, { recursive: true });

function run(command, args, cwd, timeoutMs = 60_000, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: process.platform === 'win32' && /\.cmd$/i.test(command) });
    let output = '';
    child.stdout.on('data', chunk => { output = (output + chunk.toString()).slice(-16_000); });
    child.stderr.on('data', chunk => { output = (output + chunk.toString()).slice(-16_000); });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${command} timed out: ${output}`)); }, timeoutMs);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); code === 0 ? resolve(output) : reject(new Error(`${command} exited ${code}: ${output}`)); });
  });
}
async function freePort() {
  const { createServer } = await import('node:net');
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') { server.close(); reject(new Error('No free port')); return; }
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

const legacyRoot = path.join(stage, 'legacy-ini-editor');
const analysis = await analyzeLegacySoftware(path.join(ROOT, 'examples/legacy-samples/ini-editor'));
const functionalSpec = JSON.parse(await readFile(path.join(ROOT, 'examples/legacy-samples/ini-editor/functional-spec.json'), 'utf8'));
const reconstruction = createReconstructionSpec({ kind: functionalSpec.kind, name: functionalSpec.name, requirements: functionalSpec.requirements, profile: analysis.profile });
const project = generateReconstructionProject(reconstruction);
const legacyFiles = await writeReconstructionProject(project, legacyRoot);
await cp(path.join(ROOT, 'examples/legacy-samples/ini-editor/sample.ini'), path.join(legacyRoot, 'sample.ini'));
await run(process.execPath, ['--test'], legacyRoot);
const port = await freePort();
const server = spawn(process.execPath, ['server.mjs'], { cwd: legacyRoot, env: { ...process.env, PORT: String(port) }, stdio: 'ignore', windowsHide: true });
let independentStart = false;
try {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) }); if (response.ok) { independentStart = true; break; } } catch { /* starting */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
} finally {
  server.kill();
  await new Promise(resolve => { const timer = setTimeout(() => { server.off('close', onClose); resolve(); }, 3000); const onClose = () => { clearTimeout(timer); resolve(); }; server.once('close', onClose); });
}
if (!independentStart) throw new Error('Legacy demo did not start independently');
const legacyEvidence = { version, source: 'examples/legacy-samples/ini-editor', format: analysis.profile.formats, reconstruction: reconstruction.id, testsPassed: true, independentStart, projectFiles: legacyFiles.length, evidenceStatus: 'VERIFIED' };
await writeFile(path.join(legacyRoot, 'DEMO-EVIDENCE.json'), JSON.stringify(legacyEvidence, null, 2) + '\n');
const legacyZip = path.join(release, `reverse-everything-legacy-demo-${version}.zip`);
await writeFile(legacyZip, await zipDirectory(legacyRoot, { maxTotalBytes: 32 * 1024 * 1024 }));
const cleanLegacyRoot = await mkdtemp(path.join(stage, 'clean-legacy-'));
await run(TAR, ['-xf', path.relative(ROOT, legacyZip), '-C', cleanLegacyRoot], ROOT);
await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], cleanLegacyRoot, 180_000);
await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['test'], cleanLegacyRoot, 120_000);
const cleanLegacyPort = await freePort();
const cleanLegacyServer = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'start'], { cwd: cleanLegacyRoot, env: { ...process.env, PORT: String(cleanLegacyPort) }, stdio: 'ignore', windowsHide: true, shell: process.platform === 'win32' });
let cleanLegacyStart = false;
try {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { const response = await fetch(`http://127.0.0.1:${cleanLegacyPort}/`, { signal: AbortSignal.timeout(500) }); if (response.ok) { cleanLegacyStart = true; break; } } catch { /* starting */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
} finally {
  cleanLegacyServer.kill();
  await new Promise(resolve => { const timer = setTimeout(() => { cleanLegacyServer.off('close', onClose); resolve(); }, 3000); const onClose = () => { clearTimeout(timer); resolve(); }; cleanLegacyServer.once('close', onClose); });
  if (process.platform === 'win32' && cleanLegacyServer.pid) { const { spawnSync } = await import('node:child_process'); spawnSync('taskkill', ['/pid', String(cleanLegacyServer.pid), '/T', '/F'], { stdio: 'ignore' }); }
}
if (!cleanLegacyStart) throw new Error('Clean legacy ZIP did not start with its default script');
const legacyZipSha256 = createHash('sha256').update(await readFile(legacyZip)).digest('hex');
const legacyCleanEvidence = { zipSha256: legacyZipSha256, cleanDirectory: true, packageDefaultInstall: true, packageDefaultTest: true, packageDefaultStart: true, evidenceStatus: 'VERIFIED' };

const gameRoot = path.join(stage, 'game-compat');
await mkdir(path.join(gameRoot, 'examples'), { recursive: true });
await mkdir(path.join(gameRoot, 'packages'), { recursive: true });
await cp(path.join(ROOT, 'examples/game-compat'), path.join(gameRoot, 'examples/game-compat'), { recursive: true });
await cp(path.join(ROOT, 'packages/game-compat'), path.join(gameRoot, 'packages/game-compat'), { recursive: true });
await mkdir(path.join(gameRoot, 'evidence'), { recursive: true });
const gameEvidenceDir = process.env.GAME_COMPAT_EVIDENCE_DIR;
if (!gameEvidenceDir) throw new Error('GAME_COMPAT_EVIDENCE_DIR must point to the Playwright temporary evidence output');
const gameEvidence = {};
const evidenceFiles = await readdir(gameEvidenceDir, { recursive: true });
for (const name of ['pixelknight', 'tron']) {
  const matches = evidenceFiles.filter(file => path.basename(file) === `${name}.json`);
  if (matches.length !== 1) throw new Error(`Expected exactly one temporary evidence file for ${name}, found ${matches.length}`);
  const source = path.join(gameEvidenceDir, matches[0]);
  const evidence = JSON.parse(await readFile(source, 'utf8'));
  if (evidence.evidenceStatus !== 'VERIFIED' || evidence.originalClient !== true) throw new Error(`Missing real original-client evidence: ${name}`);
  gameEvidence[name] = { ...evidence, screenshot: `evidence/${name}.png` };
  await writeFile(path.join(gameRoot, `evidence/${name}.json`), JSON.stringify(gameEvidence[name], null, 2) + '\n');
  await cp(path.join(path.dirname(source), `${name}.png`), path.join(gameRoot, `evidence/${name}.png`));
}
await mkdir(path.join(gameRoot, 'tests'), { recursive: true });
await writeFile(path.join(gameRoot, 'package.json'), JSON.stringify({ name: 'reverse-everything-game-compat-demo', version, private: true, type: 'module', scripts: { 'start:pixelknight': 'node packages/game-compat/src/pixelknight-server.mjs', 'start:tron': 'node packages/game-compat/src/tron-server.mjs', test: 'node tests/original-client.smoke.mjs' }, dependencies: { 'socket.io': '4.8.4', ws: '8.23.0' }, devDependencies: { '@playwright/test': '1.65.1' } }, null, 2) + '\n');
await writeFile(path.join(gameRoot, 'README.md'), `# Game compatibility demo ${version}\n\nThis archive contains independent servers and retained original browser clients for Pixelknight and Tron. Upstream server source is not included.\n\n\`\`\`sh\nnpm install\nnpm run start:pixelknight\n# open http://localhost:18080 (WebSocket: ws://localhost:8080)\nnpm run start:tron\n# open http://localhost:18081/game/compat-room\n\`\`\`\n\nPixelknight uses HTTP port 18080 and a separate WebSocket port 8080. Tron HTTP and Socket.IO share port 18081. Set PK_HTTP_PORT/PK_WS_PORT or TRON_PORT to override them.\n\nRun \`npm test\` for a headless original-client connection/movement/reconnect smoke test. Install a Playwright Chromium browser first if needed. Evidence is in \`evidence/\`. Both clients are ISC-licensed upstream works; see \`examples/game-compat/UPSTREAM.md\`, \`examples/game-compat/CLIENT-SHA256.json\` and \`LICENSE-ISC.txt\`.\n`);
await writeFile(path.join(gameRoot, 'tests/original-client.smoke.mjs'), `import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function freePort(){return new Promise((resolve,reject)=>{const server=createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const address=server.address();const port=address.port;server.close(error=>error?reject(error):resolve(port));});});}
async function ready(url){for(let attempt=0;attempt<100;attempt++){try{const response=await fetch(url+'/health',{signal:AbortSignal.timeout(500)});if(response.ok)return;}catch{}await delay(100);}throw new Error('Server did not start: '+url);}
async function stop(child){if(!child||child.exitCode!==null)return;child.kill();await Promise.race([new Promise(resolve=>child.once('close',resolve)),delay(3000)]);if(process.platform==='win32'&&child.pid){const {spawnSync}=await import('node:child_process');spawnSync('taskkill',['/pid',String(child.pid),'/T','/F'],{stdio:'ignore'});}}
const npm=process.platform==='win32'?'npm.cmd':'npm';
async function start(script,env){const child=spawn(npm,['run',script],{env:{...process.env,...env},stdio:'ignore',windowsHide:true,shell:process.platform==='win32'});return child;}
let pixel,tron,browser;
try{
  const httpPort=await freePort(),wsPort=await freePort(),tronPort=await freePort();
  pixel=await start('start:pixelknight',{PK_HTTP_PORT:String(httpPort),PK_WS_PORT:String(wsPort),PK_DATA_DIR:'data/pixelknight'});
  await ready('http://localhost:'+httpPort);
  tron=await start('start:tron',{TRON_PORT:String(tronPort),TRON_DATA_DIR:'data/tron',TRON_RECONNECT_GRACE_MS:'10000'});
  await ready('http://localhost:'+tronPort);
  browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{})});
  const tronPages=[];for(const nickname of ['alice','bob']){const context=await browser.newContext();await context.addInitScript(value=>localStorage.setItem('nickname',value),nickname);const page=await context.newPage();tronPages.push({context,page,nickname});await page.goto('http://localhost:'+tronPort+'/game/smoke-room');await page.locator('#lobby-content').waitFor();}
  for(const {page} of tronPages)await page.locator('#startButton').click();
  await tronPages[0].page.keyboard.press('ArrowUp');await tronPages[0].page.reload();for(const {page,nickname} of tronPages){await page.locator('#lobby-content').filter({hasText:nickname}).waitFor({timeout:15000});await page.context().close();}
  const context=await browser.newContext();const page=await context.newPage();await page.goto('http://localhost:'+httpPort+'/');await page.locator('#connection-status').filter({hasText:'Connected'}).waitFor({timeout:15000});await page.keyboard.down('ArrowRight');await page.waitForTimeout(500);await page.keyboard.up('ArrowRight');await page.reload();await page.locator('#connection-status').filter({hasText:'Connected'}).waitFor({timeout:15000});await context.close();
  console.log('Original-client smoke test passed');
}finally{await browser?.close();await stop(tron);await stop(pixel);}
`);
await writeFile(path.join(gameRoot, 'LICENSE-ISC.txt'), `ISC License\n\nCopyright (c) 2025 Pixelknight contributors\nCopyright (c) 2025 Miguel Angel Gata\n\nPermission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.\n\nTHE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.\n`);
const gameZip = path.join(release, `reverse-everything-game-compat-demo-${version}.zip`);
await writeFile(gameZip, await zipDirectory(gameRoot, { maxTotalBytes: 32 * 1024 * 1024 }));

// Validate the exact archived bytes, not the staging tree: clean extraction,
// package-default installation/start scripts and the retained original clients.
const cleanRoot = await mkdtemp(path.join(stage, 'clean-game-'));
await run(TAR, ['-xf', path.relative(ROOT, gameZip), '-C', cleanRoot], ROOT);
await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], cleanRoot, 180_000);
const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['test'], cleanRoot, 120_000, { ...process.env, ...(existsSync(chrome) ? { PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: chrome } : {}) });
const gameZipSha256 = createHash('sha256').update(await readFile(gameZip)).digest('hex');
const cleanEvidence = { zipSha256: gameZipSha256, cleanDirectory: true, packageDefaultInstall: true, packageDefaultStart: true, originalClientTest: true, testsPassed: true, evidenceStatus: 'VERIFIED' };
await writeFile(path.join(cleanRoot, 'evidence/clean-unpack.json'), JSON.stringify(cleanEvidence, null, 2) + '\n');
await writeFile(path.join(release, 'demo-evidence.json'), JSON.stringify({ version, legacy: legacyEvidence, games: gameEvidence, cleanUnpack: { legacy: legacyCleanEvidence, games: cleanEvidence }, archives: { gameZip: path.basename(gameZip), gameZipSha256, legacyZip: path.basename(legacyZip), legacyZipSha256 } }, null, 2) + '\n');
console.log(JSON.stringify({ version, legacyZip, legacyZipSha256, gameZip, gameZipSha256, evidence: path.join(release, 'demo-evidence.json') }, null, 2));

import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeLegacySoftware, createReconstructionSpec, generateReconstructionProject, writeReconstructionProject } from '../packages/legacy-revival/dist/index.js';
import { zipDirectory } from '../apps/api/dist/game-archive.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
await mkdir(path.join(ROOT, 'dist'), { recursive: true });
const stage = await mkdtemp(path.join(ROOT, 'dist/demos-'));
const release = path.join(ROOT, 'dist/release');
await mkdir(release, { recursive: true });

function run(command, args, cwd, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
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

const gameRoot = path.join(stage, 'game-compat');
await mkdir(path.join(gameRoot, 'examples'), { recursive: true });
await mkdir(path.join(gameRoot, 'packages'), { recursive: true });
await cp(path.join(ROOT, 'examples/game-compat'), path.join(gameRoot, 'examples/game-compat'), { recursive: true });
await cp(path.join(ROOT, 'packages/game-compat'), path.join(gameRoot, 'packages/game-compat'), { recursive: true });
await mkdir(path.join(gameRoot, 'evidence'), { recursive: true });
const gameEvidence = {};
for (const name of ['pixelknight', 'tron']) {
  const evidence = JSON.parse(await readFile(path.join(ROOT, `artifacts/v007-game-compat/${name}.json`), 'utf8'));
  if (evidence.evidenceStatus !== 'VERIFIED' || evidence.originalClient !== true) throw new Error(`Missing real original-client evidence: ${name}`);
  gameEvidence[name] = evidence;
  await cp(path.join(ROOT, `artifacts/v007-game-compat/${name}.json`), path.join(gameRoot, `evidence/${name}.json`));
}
await cp(path.join(ROOT, 'docs/assets/v007-pixelknight-compat.png'), path.join(gameRoot, 'evidence/pixelknight.png'));
await cp(path.join(ROOT, 'docs/assets/v007-tron-compat.png'), path.join(gameRoot, 'evidence/tron.png'));
await writeFile(path.join(gameRoot, 'package.json'), JSON.stringify({ name: 'reverse-everything-game-compat-demo', version, private: true, type: 'module', scripts: { 'start:pixelknight': 'node packages/game-compat/src/pixelknight-server.mjs', 'start:tron': 'node packages/game-compat/src/tron-server.mjs' }, dependencies: { 'socket.io': '4.8.4', ws: '8.23.0' } }, null, 2) + '\n');
await writeFile(path.join(gameRoot, 'README.md'), `# Game compatibility demo ${version}\n\nThis archive contains independent servers and retained original browser clients for Pixelknight and Tron. Upstream server source is not included.\n\n\`\`\`sh\nnpm install\nnpm run start:pixelknight\n# open http://localhost:8080\nnpm run start:tron\n# open http://localhost:18081/game/compat-room\n\`\`\`\n\nEvidence is in \`evidence/\`. Both clients are ISC-licensed upstream works; see \`examples/game-compat/UPSTREAM.md\`, \`examples/game-compat/CLIENT-SHA256.json\` and \`LICENSE-ISC.txt\`.\n`);
await writeFile(path.join(gameRoot, 'LICENSE-ISC.txt'), `ISC License\n\nCopyright (c) 2025 Pixelknight contributors\nCopyright (c) 2025 Miguel Angel Gata\n\nPermission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.\n\nTHE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.\n`);
const gameZip = path.join(release, `reverse-everything-game-compat-demo-${version}.zip`);
await writeFile(gameZip, await zipDirectory(gameRoot, { maxTotalBytes: 32 * 1024 * 1024 }));
await writeFile(path.join(release, 'demo-evidence.json'), JSON.stringify({ version, legacy: legacyEvidence, games: gameEvidence }, null, 2) + '\n');
console.log(JSON.stringify({ version, legacyZip, gameZip, evidence: path.join(release, 'demo-evidence.json') }, null, 2));

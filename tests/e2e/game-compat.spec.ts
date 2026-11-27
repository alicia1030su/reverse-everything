import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { startPixelknightServer, startTronServer } from '../../packages/game-compat/src/index.js';

const clientHashes = JSON.parse(await readFile('examples/game-compat/CLIENT-SHA256.json', 'utf8')) as Record<string, { commit: string; files: Record<string, string> }>;
async function verifyClientHashes(game: 'pixelknight' | 'tron'): Promise<void> {
  for (const [relative, expected] of Object.entries(clientHashes[game]!.files)) {
    const raw = await readFile(path.join('examples/game-compat/clients', game, relative));
    const normalized = /\.(?:js|html|css|json|md)$/i.test(relative) ? raw.toString('utf8').replace(/\r\n/g, '\n') : raw;
    const actual = createHash('sha256').update(normalized).digest('hex');
    expect(actual, `${game}/${relative}`).toBe(expected);
  }
}
async function freePort(): Promise<number> {
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
async function evidence(outputDir: string, name: string, value: unknown, screenshot?: string): Promise<string> {
  await mkdir(outputDir, { recursive: true });
  const file = path.join(outputDir, `${name}.json`);
  await writeFile(file, JSON.stringify(value, null, 2) + '\n');
  return screenshot ? path.relative(process.cwd(), screenshot) : file;
}

const testToken = 'v007-game-compat-test-token';
process.env.PK_TEST_TOKEN = testToken;
process.env.TRON_TEST_TOKEN = testToken;
async function state(url: string) {
  const response = await fetch(`${url}/__state`, { headers: { 'x-test-token': testToken } });
  expect(response.ok).toBe(true);
  return response.json();
}
let pixel: Awaited<ReturnType<typeof startPixelknightServer>> | undefined;
let tron: Awaited<ReturnType<typeof startTronServer>> | undefined;
let pixelHttpPort = 0;
let pixelWsPort = 0;
let tronPort = 0;

test.beforeAll(async () => {
  await verifyClientHashes('pixelknight');
  await verifyClientHashes('tron');
  pixelHttpPort = await freePort(); pixelWsPort = 8080; tronPort = await freePort();
  pixel = await startPixelknightServer({ port: pixelHttpPort, wsPort: pixelWsPort, reset: true });
  tron = await startTronServer({ port: tronPort, reset: true, reconnectGraceMs: 10_000 });
});
test.afterAll(async () => { await pixel?.close(); await tron?.close(); });

async function newContext(browser: Browser, nickname: string) {
  const context = await browser.newContext();
  await context.addInitScript(value => localStorage.setItem('nickname', value), nickname);
  return context;
}

test('Pixelknight original client connects two players, moves, persists and reconnects', async ({ browser }, testInfo) => {
  const contextA = await newContext(browser, 'tron-player');
  const contextB = await newContext(browser, 'tron-player');
  const pageA: Page = await contextA.newPage();
  const pageB: Page = await contextB.newPage();
  await pageA.goto(`${pixel!.url}/`);
  await pageB.goto(`${pixel!.url}/`);
  await expect(pageA.locator('#connection-status')).toContainText('Connected', { timeout: 15_000 });
  await expect(pageB.locator('#connection-status')).toContainText('Connected', { timeout: 15_000 });
  await expect(pageA.locator('#players-count')).toHaveText('2', { timeout: 15_000 });
  const before = await state(pixel!.url) as { players: Record<string, { pos_x: number }> };
  const idA = (await contextA.cookies()).find(cookie => cookie.name === 'pk_player')!.value;
  const xBefore = before.players[idA]!.pos_x;
  await pageA.keyboard.down('ArrowRight');
  await pageA.waitForTimeout(700);
  await pageA.keyboard.up('ArrowRight');
  await expect.poll(async () => {
    const stateValue = await state(pixel!.url) as { players: Record<string, { pos_x: number }> };
    return stateValue.players[idA]!.pos_x;
  }, { timeout: 10_000 }).toBeGreaterThan(xBefore + 20);
  await pixel!.close(); pixel = undefined;
  pixel = await startPixelknightServer({ port: pixelHttpPort, wsPort: pixelWsPort, reset: false });
  await expect(pageA.locator('#connection-status')).toContainText('Connected', { timeout: 20_000 });
  const after = await state(pixel!.url) as { players: Record<string, { pos_x: number }> };
  expect(after.players[idA]!.pos_x).toBeGreaterThan(xBefore + 20);
  const screenshot = testInfo.outputPath('pixelknight.png');
  await pageA.screenshot({ path: screenshot, fullPage: true });
  await evidence(testInfo.outputPath(), 'pixelknight', { game: 'pixelknight', upstream: 'https://github.com/imdvls/Pixelknight', commit: clientHashes.pixelknight!.commit, clientFiles: clientHashes.pixelknight!.files, license: 'ISC', originalClient: true, twoPlayers: true, movement: true, persistence: true, reconnect: true, serverRestart: true, evidenceStatus: 'VERIFIED', screenshot }, screenshot);
  await contextA.close(); await contextB.close();
});

test('Tron original client keeps room and player position through refresh and server restart', async ({ browser }, testInfo) => {
  const contextA = await newContext(browser, 'alice');
  const contextB = await newContext(browser, 'bob');
  const pageA: Page = await contextA.newPage();
  const pageB: Page = await contextB.newPage();
  await pageA.goto(`${tron!.url}/game/compat-room`);
  await pageB.goto(`${tron!.url}/game/compat-room`);
  await expect(pageA.locator('#lobby-content')).toContainText('alice', { timeout: 15_000 });
  await expect(pageA.locator('#lobby-content')).toContainText('bob', { timeout: 15_000 });
  await pageA.locator('#startButton').click();
  await pageB.locator('#startButton').click();
  await expect.poll(async () => (await state(tron!.url) as { rooms: Array<{ state: string }> }).rooms[0]?.state, { timeout: 10_000 }).toBe('playing');
  const before = await state(tron!.url) as { rooms: Array<{ state: string; players: Array<{ id: string; nickname: string; x: number; y: number; connected: boolean }> }> };
  const alice = before.rooms[0]!.players.find(player => player.nickname === 'alice')!;
  await pageA.keyboard.press('ArrowUp');
  await expect.poll(async () => {
    const stateValue = await state(tron!.url) as { rooms: Array<{ players: Array<{ nickname: string; y: number }> }> };
    return stateValue.rooms[0]!.players.find(item => item.nickname === 'alice')!.y;
  }, { timeout: 10_000 }).toBeLessThan(alice.y);
  const beforeRefresh = await state(tron!.url) as typeof before;
  const positionBeforeRefresh = beforeRefresh.rooms[0]!.players.find(player => player.nickname === 'alice')!;
  await pageA.reload();
  await expect(pageA.locator('#lobby-content')).toContainText('alice', { timeout: 15_000 });
  const refreshed = await state(tron!.url) as typeof before;
  const resumed = refreshed.rooms[0]!.players.find(player => player.nickname === 'alice')!;
  expect(refreshed.rooms[0]!.state).toBe('playing');
  expect(resumed.id).toBe(alice.id);
  expect(resumed.x).toBe(positionBeforeRefresh.x);
  expect(resumed.y).toBeLessThanOrEqual(positionBeforeRefresh.y);
  expect(resumed.connected).toBe(true);
  await tron!.close(); tron = undefined;
  tron = await startTronServer({ port: tronPort, reset: false, reconnectGraceMs: 10_000 });
  // The retained client emits joinRoom only on page load; reload after the
  // independent server is listening so its stable room/nickname identity resumes.
  await pageA.reload();
  await expect(pageA.locator('#lobby-content')).toContainText('alice', { timeout: 20_000 });
  await expect.poll(async () => {
    const value = await state(tron!.url) as typeof before;
    return value.rooms[0]?.players.find(player => player.nickname === 'alice')?.connected;
  }, { timeout: 20_000 }).toBe(true);
  const restarted = await state(tron!.url) as typeof before;
  const restored = restarted.rooms[0]!.players.find(player => player.nickname === 'alice')!;
  expect(restarted.rooms[0]!.state).toBe('playing');
  expect(restored.id).toBe(alice.id);
  expect(restored.x).toBe(resumed.x);
  expect(restored.connected).toBe(true);
  await pageA.keyboard.press('ArrowUp');
  await expect.poll(async () => (await state(tron!.url) as { rooms: Array<{ state: string }> }).rooms[0]?.state, { timeout: 20_000 }).toBe('finished');
  await expect(pageA.locator('#log-content')).toContainText('Game Over!', { timeout: 10_000 });
  const screenshot = testInfo.outputPath('tron.png');
  await pageA.screenshot({ path: screenshot, fullPage: true });
  await evidence(testInfo.outputPath(), 'tron', { game: 'tron', upstream: 'https://github.com/leodhin/trongame', commit: clientHashes.tron!.commit, clientFiles: clientHashes.tron!.files, license: 'ISC', originalClient: true, twoPlayers: true, roomJoin: true, ready: true, movement: true, reconnect: true, reconnectGraceMs: 10_000, samePlayerId: true, sameRoom: true, positionContinued: true, serverRestart: true, matchFinished: true, evidenceStatus: 'VERIFIED', screenshot }, screenshot);
  await contextA.close(); await contextB.close();
});

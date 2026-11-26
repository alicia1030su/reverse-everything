import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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

const testToken = 'v007-game-compat-test-token';
process.env.PK_TEST_TOKEN = testToken;
process.env.TRON_TEST_TOKEN = testToken;
async function state(url: string) {
  const response = await fetch(`${url}/__state`, { headers: { 'x-test-token': testToken } });
  expect(response.ok).toBe(true);
  return response.json();
}
let pixel: Awaited<ReturnType<typeof startPixelknightServer>>;
let tron: Awaited<ReturnType<typeof startTronServer>>;

test.beforeAll(async () => {
  await verifyClientHashes('pixelknight');
  await verifyClientHashes('tron');
  pixel = await startPixelknightServer({ port: 8080, wsPort: 8080, reset: true });
  tron = await startTronServer({ port: 18081, reset: true });
});
test.afterAll(async () => { await pixel?.close(); await tron?.close(); });

async function newContext(browser: Browser) {
  const context = await browser.newContext();
  await context.addInitScript(() => localStorage.setItem('nickname', 'tron-player'));
  return context;
}

test('Pixelknight original client connects two players, moves, persists and reconnects', async ({ browser }, testInfo) => {
  const contextA = await newContext(browser);
  const contextB = await newContext(browser);
  const pageA: Page = await contextA.newPage();
  const pageB: Page = await contextB.newPage();
  await pageA.goto(`${pixel.url}/`);
  await pageB.goto(`${pixel.url}/`);
  await expect(pageA.locator('#connection-status')).toContainText('Connected', { timeout: 15_000 });
  await expect(pageB.locator('#connection-status')).toContainText('Connected', { timeout: 15_000 });
  await expect(pageA.locator('#players-count')).toHaveText('2', { timeout: 15_000 });
  const before = await state(pixel.url) as { players: Record<string, { pos_x: number }> };
  const idA = (await contextA.cookies()).find(cookie => cookie.name === 'pk_player')!.value;
  const xBefore = before.players[idA]!.pos_x;
  await pageA.keyboard.down('ArrowRight');
  await pageA.waitForTimeout(700);
  await pageA.keyboard.up('ArrowRight');
  await expect.poll(async () => {
    const stateValue = await state(pixel.url) as { players: Record<string, { pos_x: number }> };
    return stateValue.players[idA]!.pos_x;
  }, { timeout: 10_000 }).toBeGreaterThan(xBefore + 20);
  await pixel.close();
  pixel = await startPixelknightServer({ port: 8080, wsPort: 8080, reset: false });
  await expect(pageA.locator('#connection-status')).toContainText('Connected', { timeout: 20_000 });
  const after = await state(pixel.url) as { players: Record<string, { pos_x: number }> };
  expect(after.players[idA]!.pos_x).toBeGreaterThan(xBefore + 20);
  await pageA.screenshot({ path: 'docs/assets/v007-pixelknight-compat.png', fullPage: true });
  await mkdir('artifacts/v007-game-compat', { recursive: true });
  await writeFile('artifacts/v007-game-compat/pixelknight.json', JSON.stringify({ game: 'pixelknight', upstream: 'https://github.com/imdvls/Pixelknight', commit: clientHashes.pixelknight!.commit, clientFiles: clientHashes.pixelknight!.files, license: 'ISC', originalClient: true, twoPlayers: true, movement: true, persistence: true, reconnect: true, serverRestart: true, evidenceStatus: 'VERIFIED', screenshot: 'docs/assets/v007-pixelknight-compat.png' }, null, 2) + '\n');
  await contextA.close(); await contextB.close();
});

test('Tron original client joins a room, starts, moves, reconnects and finishes a match', async ({ browser }, testInfo) => {
  const contextA = await newContext(browser);
  const contextB = await newContext(browser);
  await contextA.addInitScript(() => localStorage.setItem('nickname', 'alice'));
  await contextB.addInitScript(() => localStorage.setItem('nickname', 'bob'));
  const pageA: Page = await contextA.newPage();
  const pageB: Page = await contextB.newPage();
  await pageA.goto(`${tron.url}/game/compat-room`);
  await pageB.goto(`${tron.url}/game/compat-room`);
  await expect(pageA.locator('#lobby-content')).toContainText('alice', { timeout: 15_000 });
  await expect(pageA.locator('#lobby-content')).toContainText('bob', { timeout: 15_000 });
  await pageA.locator('#startButton').click();
  await pageB.locator('#startButton').click();
  await expect.poll(async () => {
    const stateValue = await state(tron.url) as { rooms: Array<{ state: string; players: Record<string, { x: number; y: number }> }> };
    return stateValue.rooms[0]?.state;
  }, { timeout: 10_000 }).toBe('playing');
  const before = await state(tron.url) as { rooms: Array<{ players: Array<{ nickname: string; x: number; y: number }> }> };
  const alice = before.rooms[0]!.players.find(player => player.nickname === 'alice')!;
  await pageA.keyboard.press('ArrowUp');
  await expect.poll(async () => {
    const stateValue = await state(tron.url) as { rooms: Array<{ players: Array<{ nickname: string; x: number; y: number }> }> };
    const player = stateValue.rooms[0]!.players.find(item => item.nickname === 'alice')!;
    return player.y;
  }, { timeout: 10_000 }).toBeLessThan(alice.y);
  await pageA.reload();
  await expect(pageA.locator('#lobby-content')).toContainText('alice', { timeout: 15_000 });
  await expect.poll(async () => {
    const stateValue = await state(tron.url) as { rooms: Array<{ state: string }> };
    return stateValue.rooms[0]?.state;
  }, { timeout: 20_000 }).toBe('finished');
  await expect(pageA.locator('#log-content')).toContainText('Game Over!', { timeout: 10_000 });
  await pageA.screenshot({ path: 'docs/assets/v007-tron-compat.png', fullPage: true });
  await mkdir('artifacts/v007-game-compat', { recursive: true });
  await writeFile('artifacts/v007-game-compat/tron.json', JSON.stringify({ game: 'tron', upstream: 'https://github.com/leodhin/trongame', commit: clientHashes.tron!.commit, clientFiles: clientHashes.tron!.files, license: 'ISC', originalClient: true, twoPlayers: true, roomJoin: true, ready: true, movement: true, reconnect: true, matchFinished: true, evidenceStatus: 'VERIFIED', screenshot: 'docs/assets/v007-tron-compat.png' }, null, 2) + '\n');
  await contextA.close(); await contextB.close();
});

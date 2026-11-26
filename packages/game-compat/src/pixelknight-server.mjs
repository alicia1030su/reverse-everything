import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CLIENT_DIR = path.join(ROOT, 'examples/game-compat/clients/pixelknight');
const MAP_WIDTH = 60;
const MAP_HEIGHT = 20;
const TILE = 16;
const STEP = 1 / 30;
const SAVE_INTERVAL = 2_000;

function buildMap() {
  const map = Array.from({ length: MAP_HEIGHT }, (_, y) => Array.from({ length: MAP_WIDTH }, (_, x) => ({ type: 'empty', solid: false, color: '#000' })));
  for (let x = 0; x < MAP_WIDTH; x += 1) {
    map[MAP_HEIGHT - 1][x] = { type: 'ground', solid: true, color: '#8B4513' };
    map[MAP_HEIGHT - 2][x] = { type: 'grass', solid: true, color: '#228B22' };
  }
  for (const [x, y, width] of [[6, 14, 8], [20, 11, 8], [36, 14, 9], [48, 9, 7]]) {
    for (let i = 0; i < width; i += 1) map[y][x + i] = { type: 'platform', solid: true, color: '#8B4513' };
  }
  return map;
}
function initialCollectibles() {
  return [
    { id: 0, x: 80, y: 250, width: 8, height: 8, type: 'coin', collected: false },
    { id: 1, x: 180, y: 150, width: 8, height: 8, type: 'coin', collected: false },
    { id: 2, x: 310, y: 250, width: 8, height: 8, type: 'coin', collected: false },
    { id: 3, x: 420, y: 190, width: 8, height: 8, type: 'coin', collected: false },
  ];
}
function cookie(req, name) {
  const raw = String(req.headers.cookie ?? '');
  for (const part of raw.split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) { try { return decodeURIComponent(value.join('=')); } catch { return undefined; } }
  }
  return undefined;
}
function testAuthorized(req, url) {
  const expected = process.env.PK_TEST_TOKEN;
  if (!expected) return false;
  const provided = req.headers['x-test-token'];
  return provided === expected && /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(String(req.headers.host ?? ''));
}
function send(socket, value) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
}
function isSolid(map, x, y) {
  const tx = Math.floor(x / TILE);
  const ty = Math.floor(y / TILE);
  return tx < 0 || ty < 0 || tx >= MAP_WIDTH || ty >= MAP_HEIGHT || Boolean(map[ty]?.[tx]?.solid);
}

export async function startPixelknightServer(options = {}) {
  const httpPort = Number(options.port ?? process.env.PK_HTTP_PORT ?? 18080);
  const wsPort = Number(options.wsPort ?? process.env.PK_WS_PORT ?? 8080);
  const dataDir = path.resolve(options.dataDir ?? process.env.PK_DATA_DIR ?? path.join(ROOT, 'data/game-compat/pixelknight'));
  const stateFile = path.join(dataDir, 'state.json');
  if (!Number.isSafeInteger(httpPort) || !Number.isSafeInteger(wsPort)) throw new Error('Invalid Pixelknight port');
  await mkdir(dataDir, { recursive: true });
  if (options.reset) await rm(stateFile, { force: true });
  const map = buildMap();
  let saved = { players: {}, collectibles: initialCollectibles() };
  try { saved = JSON.parse(await readFile(stateFile, 'utf8')); } catch { /* first start */ }
  const players = new Map();
  for (const [id, player] of Object.entries(saved.players ?? {})) players.set(id, { ...player, connected: false, keys: {}, lastProcessedInput: player.lastProcessedInput ?? 0 });
  let collectibles = Array.isArray(saved.collectibles) && saved.collectibles.length ? saved.collectibles : initialCollectibles();
  let dirty = false;
  let nextPlayer = 1;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, game: 'pixelknight', wsPort })); return; }
    if (url.pathname === '/__state' && testAuthorized(req, url)) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ players: Object.fromEntries(players), collectibles, connections: wss.clients.size, persisted: dirty === false }));
      return;
    }
    if (url.pathname === '/__reset' && req.method === 'POST' && testAuthorized(req, url)) {
      players.clear(); collectibles = initialCollectibles(); dirty = true; await persist();
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); return;
    }
    const requested = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = path.resolve(CLIENT_DIR, `.${requested}`);
    if (!file.startsWith(CLIENT_DIR + path.sep) && file !== path.join(CLIENT_DIR, 'index.html')) { res.writeHead(403); res.end(); return; }
    try {
      const body = await readFile(file);
      const id = cookie(req, 'pk_player');
      const headers = { 'content-type': file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'application/octet-stream', 'cache-control': 'no-store' };
      if (!id) headers['set-cookie'] = `pk_player=pk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}; Path=/; HttpOnly; SameSite=None; Secure`;
      res.writeHead(200, headers); res.end(body);
    } catch { res.writeHead(404); res.end('not found'); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(httpPort, '127.0.0.1', resolve); });
  const wss = httpPort === wsPort
    ? new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 })
    : new WebSocketServer({ host: '127.0.0.1', port: wsPort, maxPayload: 16 * 1024 });
  if (httpPort === wsPort) server.on('upgrade', (request, socket, head) => {
    const host = String(request.headers.host ?? '');
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) { socket.destroy(); return; }
    wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request));
  });

  wss.on('connection', (socket, req) => {
    const host = String(req.headers.host ?? '');
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) { socket.close(1008, 'host denied'); return; }
    let id = cookie(req, 'pk_player');
    if (!id) id = `pk-${Date.now().toString(36)}-${nextPlayer++}`;
    if (!players.has(id)) {
      players.set(id, { id, pos_x: 50, pos_y: 100, vel_x: 0, vel_y: 0, onGround: false, facingRight: true, lastProcessedInput: 0, score: 0, connected: true, keys: {} });
    } else {
      const player = players.get(id); player.connected = true; player.keys = {};
    }
    socket.playerId = id;
    send(socket, { type: 'handshake', playerId: id, mapData: map, enemiesData: [], collectiblesData: collectibles, characterProperties: { speed: 150, jumpSpeed: -350, gravity: 800, minJumpVelocity: -200 }, serverTime: Date.now() });
    broadcastState();
    socket.on('message', raw => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { socket.close(1007, 'invalid JSON'); return; }
      const player = players.get(id);
      if (!player || !message || typeof message.type !== 'string') return;
      if (message.type === 'input') {
        const keys = message.keys && typeof message.keys === 'object' ? message.keys : {};
        player.keys = { left: keys.left === true, right: keys.right === true, jump: keys.jump === true, attack: keys.attack === true };
        if (Number.isSafeInteger(message.sequence)) player.lastProcessedInput = Math.max(player.lastProcessedInput, message.sequence);
        dirty = true;
      } else if (message.type === 'collectCoin') {
        const coin = collectibles[Number(message.coinIndex)];
        if (coin && !coin.collected && Math.hypot(coin.x - player.pos_x, coin.y - player.pos_y) < 80) { coin.collected = true; player.score += 10; dirty = true; broadcastState(); }
      } else if (message.type === 'swordAttack') {
        for (const peer of wss.clients) if (peer !== socket && peer.readyState === WebSocket.OPEN) send(peer, { type: 'playerSwordAttack', playerId: id, facingRight: player.facingRight });
      } else if (message.type === 'disconnect') {
        player.connected = false; player.keys = {}; dirty = true; socket.close();
      }
    });
    socket.on('close', () => { const player = players.get(id); if (player) { player.connected = false; player.keys = {}; dirty = true; } });
    socket.on('error', () => undefined);
  });

  function broadcastState() {
    const state = { type: 'gameState', players: Object.fromEntries([...players].filter(([, player]) => player.connected).map(([id, player]) => [id, { ...player, keys: undefined }])), enemies: [], collectibles, serverTime: Date.now() };
    for (const client of wss.clients) if (client.readyState === WebSocket.OPEN) send(client, state);
  }
  function tick() {
    for (const player of players.values()) {
      if (!player.connected) continue;
      const direction = Number(player.keys.right === true) - Number(player.keys.left === true);
      player.vel_x = direction * 150;
      if (direction) player.facingRight = direction > 0;
      if (player.keys.jump && player.onGround) { player.vel_y = -350; player.onGround = false; }
      player.vel_y += 800 * STEP;
      const nextX = Math.max(0, Math.min(MAP_WIDTH * TILE - 16, player.pos_x + player.vel_x * STEP));
      if (!isSolid(map, nextX + (direction > 0 ? 16 : 0), player.pos_y + 12)) player.pos_x = nextX;
      let nextY = player.pos_y + player.vel_y * STEP;
      player.onGround = false;
      if (player.vel_y >= 0 && isSolid(map, player.pos_x + 8, nextY + 24)) {
        nextY = Math.floor((nextY + 24) / TILE) * TILE - 24;
        player.vel_y = 0; player.onGround = true;
      }
      player.pos_y = nextY;
      if (player.pos_y > MAP_HEIGHT * TILE + 80) { player.pos_x = 50; player.pos_y = 100; player.vel_y = 0; }
    }
    broadcastState();
  }
  async function persist() {
    const payload = JSON.stringify({ players: Object.fromEntries(players), collectibles }, null, 2);
    const temp = `${stateFile}.${process.pid}.tmp`;
    await writeFile(temp, payload, { mode: 0o600 });
    await rename(temp, stateFile);
    dirty = false;
  }
  const ticker = setInterval(tick, 1000 / 30);
  const saver = setInterval(() => { if (dirty) void persist().catch(() => undefined); }, SAVE_INTERVAL);
  async function close() {
    clearInterval(ticker); clearInterval(saver);
    for (const client of wss.clients) client.terminate();
    await new Promise(resolve => wss.close(() => resolve()));
    server.closeAllConnections();
    await new Promise(resolve => server.close(() => resolve()));
    await persist();
  }
  return { close, url: `http://localhost:${httpPort}` };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startPixelknightServer().then(server => console.log(`Pixelknight original client: ${server.url}; WebSocket: ws://localhost:8080`)).catch(error => { console.error(error); process.exitCode = 1; });
}

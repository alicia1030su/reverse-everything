import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CLIENT_DIR = path.join(ROOT, 'examples/game-compat/clients/tron');
const WIDTH = 1200;
const HEIGHT = 900;
const SPEED = 10;
const TICK_MS = 50;
const SAVE_INTERVAL = 2_000;
const COLORS = ['#55ACFF', '#FF5F55', '#55FF77', '#FFFF55'];

function roomState(room) {
  return {
    id: room.id,
    state: room.state,
    players: [...room.players.values()].map(player => ({ id: player.id, nickname: player.nickname, color: player.color, x: player.x, y: player.y, direction: player.direction, state: player.state, ready: player.ready, connected: player.connected })),
  };
}
function validateRoomId(value) {
  const room = String(value ?? '').trim();
  if (!/^[a-zA-Z0-9_-]{1,40}$/.test(room)) throw new Error('Invalid room id');
  return room;
}
function validateNickname(value) {
  const nickname = String(value ?? 'anonymous').trim().slice(0, 15);
  return nickname || 'anonymous';
}

function testAuthorized(req) {
  const expected = process.env.TRON_TEST_TOKEN;
  if (!expected) return false;
  return req.headers['x-test-token'] === expected && /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(String(req.headers.host ?? ''));
}
export async function startTronServer(options = {}) {
  const port = Number(options.port ?? process.env.TRON_PORT ?? 18081);
  const dataDir = path.resolve(options.dataDir ?? process.env.TRON_DATA_DIR ?? path.join(ROOT, 'data/game-compat/tron'));
  const reconnectGraceMs = Number(options.reconnectGraceMs ?? process.env.TRON_RECONNECT_GRACE_MS ?? 10_000);
  const stateFile = path.join(dataDir, 'state.json');
  if (!Number.isSafeInteger(port)) throw new Error('Invalid Tron port');
  if (!Number.isSafeInteger(reconnectGraceMs) || reconnectGraceMs < 1_000 || reconnectGraceMs > 60_000) throw new Error('Invalid Tron reconnect grace window');
  await mkdir(dataDir, { recursive: true });
  if (options.reset) await rm(stateFile, { force: true });
  const rooms = new Map();
  try {
    const saved = JSON.parse(await readFile(stateFile, 'utf8'));
    for (const raw of saved.rooms ?? []) {
      const room = { id: raw.id, state: raw.state, players: new Map(), trails: new Map(Object.entries(raw.trails ?? {})), reconnectDeadline: raw.state === 'playing' ? Date.now() + reconnectGraceMs : undefined };
      for (const player of raw.players ?? []) room.players.set(player.id, { ...player, connected: false, socketId: undefined });
      rooms.set(room.id, room);
    }
  } catch { /* first start */ }
  let dirty = false;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, game: 'tron', rooms: rooms.size })); return; }
    if (url.pathname === '/__state' && testAuthorized(req)) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ rooms: [...rooms.values()].map(roomState), persisted: !dirty })); return; }
    if (url.pathname === '/__reset' && req.method === 'POST' && testAuthorized(req)) { rooms.clear(); dirty = true; await persist(); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); return; }
    let requested;
    if (url.pathname === '/') requested = '/index.html';
    else if (/^\/game\/[a-zA-Z0-9_-]+$/.test(url.pathname)) requested = '/game.html';
    else requested = url.pathname;
    const file = path.resolve(CLIENT_DIR, `.${requested}`);
    if (!file.startsWith(CLIENT_DIR + path.sep) && file !== path.join(CLIENT_DIR, 'index.html') && file !== path.join(CLIENT_DIR, 'game.html')) { res.writeHead(403); res.end(); return; }
    try {
      const body = await readFile(file);
      const type = file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : file.endsWith('.js') ? 'text/javascript; charset=utf-8' : file.endsWith('.mp3') ? 'audio/mpeg' : 'application/octet-stream';
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body);
    } catch { res.writeHead(404); res.end('not found'); }
  });
  const io = new Server(server, { path: '/socket.io', maxHttpBufferSize: 16 * 1024, serveClient: true });
  io.use((socket, next) => {
    const host = String(socket.handshake.headers.host ?? '');
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) return next(new Error('host denied'));
    next();
  });
  const game = io.of('/game');
  game.on('connection', socket => {
    let joinedRoom;
    let joinedPlayer;
    socket.on('joinRoom', (rawRoom, rawNickname) => {
      try {
        const roomId = validateRoomId(rawRoom);
        const nickname = validateNickname(rawNickname);
        if (joinedRoom) { socket.emit('error', 'already joined'); return; }
        let room = rooms.get(roomId);
        if (!room) { room = { id: roomId, state: 'waiting', players: new Map(), trails: new Map() }; rooms.set(roomId, room); }
        const existing = [...room.players.values()].find(player => player.nickname === nickname);
        if (existing?.connected) { socket.emit('error', 'nickname already in room'); return; }
        const player = existing ?? { id: `tron-${roomId}-${nickname}`, nickname, color: COLORS[room.players.size % COLORS.length], x: 0, y: 0, direction: 'right', state: 'waiting', ready: false, trail: [] };
        if (!existing) {
          const index = room.players.size;
          player.x = index === 0 ? 100 : WIDTH - 100;
          player.y = index === 0 ? 100 : HEIGHT - 100;
          player.direction = index === 0 ? 'right' : 'left';
        }
        player.connected = true; player.socketId = socket.id;
        player.state = room.state === 'playing' ? (player.state === 'finished' ? 'finished' : 'playing') : 'waiting';
        if (room.state === 'playing' && [...room.players.values()].filter(item => item.connected && item.state === 'playing').length >= 2) room.reconnectDeadline = undefined;
        room.players.set(player.id, player);
        joinedRoom = room; joinedPlayer = player;
        dirty = true;
        socket.join(roomId);
        socket.to(roomId).emit('playerConnected', nickname);
        game.to(roomId).emit('syncGameState', roomState(room));
        game.to(roomId).emit('state', room.state);
        if (room.state === 'finished') socket.emit('gameOver');
      } catch (error) { socket.emit('error', error instanceof Error ? error.message : 'join failed'); }
    });
    socket.on('ready', () => {
      if (!joinedRoom || !joinedPlayer) return;
      joinedPlayer.ready = true; dirty = true;
      const active = [...joinedRoom.players.values()].filter(player => player.connected);
      if (active.length >= 2 && active.every(player => player.ready)) startRoom(joinedRoom);
      else game.to(joinedRoom.id).emit('syncGameState', roomState(joinedRoom));
    });
    socket.on('move', direction => {
      if (!joinedRoom || !joinedPlayer || joinedRoom.state !== 'playing' || joinedPlayer.state !== 'playing') return;
      if (!['up', 'down', 'left', 'right'].includes(direction)) return;
      const opposite = { up: 'down', down: 'up', left: 'right', right: 'left' };
      if (opposite[direction] === joinedPlayer.direction) return;
      joinedPlayer.direction = direction; dirty = true;
    });
    socket.on('ping', () => socket.emit('pong'));
    socket.on('sendMessage', message => {
      if (!joinedRoom || !joinedPlayer) return;
      const text = String(message ?? '').slice(0, 200);
      if (text) game.to(joinedRoom.id).emit('receiveMessage', { nickname: joinedPlayer.nickname, color: joinedPlayer.color }, text);
    });
    socket.on('disconnect', () => {
      if (!joinedRoom || !joinedPlayer) return;
      joinedPlayer.connected = false; joinedPlayer.socketId = undefined; joinedPlayer.ready = false; dirty = true;
      if (joinedRoom.state === 'playing' && joinedPlayer.state === 'playing' && !joinedRoom.reconnectDeadline) joinedRoom.reconnectDeadline = Date.now() + reconnectGraceMs;
      socket.to(joinedRoom.id).emit('playerDisconnected', joinedPlayer.nickname);
      game.to(joinedRoom.id).emit('syncGameState', roomState(joinedRoom));
    });
  });

  function startRoom(room) {
    room.state = 'playing'; room.trails = new Map();
    let index = 0;
    for (const player of room.players.values()) {
      if (!player.connected) continue;
      player.state = 'playing'; player.ready = true;
      player.x = index === 0 ? 100 : WIDTH - 100;
      player.y = index === 0 ? 100 : HEIGHT - 100;
      player.direction = index === 0 ? 'right' : 'left';
      room.trails.set(player.id, [`${player.x},${player.y}`]);
      index += 1;
    }
    dirty = true;
    game.to(room.id).emit('state', room.state);
    game.to(room.id).emit('syncGameState', roomState(room));
  }
  function finishRoom(room, winner) {
    room.state = 'finished'; room.reconnectDeadline = undefined;
    for (const player of room.players.values()) if (player.state === 'playing') player.state = 'finished';
    dirty = true;
    game.to(room.id).emit('state', `finished winner=${winner ?? 'none'}`);
    game.to(room.id).emit('syncGameState', roomState(room));
    game.to(room.id).emit('gameOver');
  }
  function tick() {
    for (const room of rooms.values()) {
      if (room.state !== 'playing') continue;
      const active = [...room.players.values()].filter(player => player.connected && player.state === 'playing');
      const reconnecting = [...room.players.values()].some(player => !player.connected && player.state === 'playing');
      if (reconnecting && room.reconnectDeadline && Date.now() >= room.reconnectDeadline) {
        for (const player of room.players.values()) if (!player.connected && player.state === 'playing') player.state = 'finished';
        room.reconnectDeadline = undefined;
      }
      const pending = [...room.players.values()].some(player => !player.connected && player.state === 'playing');
      if (active.length < 2 && !pending) { finishRoom(room, active[0]?.nickname); continue; }
      for (const player of active) {
        const delta = { up: [0, -SPEED], down: [0, SPEED], left: [-SPEED, 0], right: [SPEED, 0] }[player.direction];
        const x = player.x + delta[0]; const y = player.y + delta[1];
        const key = `${x},${y}`;
        const occupied = active.some(other => {
          const trail = room.trails.get(other.id) ?? [];
          return trail.includes(key) && !(other.id === player.id && trail[trail.length - 1] === key);
        });
        if (x < 0 || y < 0 || x > WIDTH || y > HEIGHT || occupied) { player.state = 'finished'; continue; }
        player.x = x; player.y = y;
        const trail = room.trails.get(player.id) ?? []; trail.push(key); room.trails.set(player.id, trail.slice(-500));
      }
      dirty = true;
      const alive = [...room.players.values()].filter(player => player.connected && player.state === 'playing');
      if (alive.length <= 1 && ![...room.players.values()].some(player => !player.connected && player.state === 'playing')) finishRoom(room, alive[0]?.nickname);
      else game.to(room.id).emit('syncGameState', roomState(room));
    }
  }
  async function persist() {
    const payload = JSON.stringify({ rooms: [...rooms.values()].map(room => ({ id: room.id, state: room.state, players: [...room.players.values()].map(({ socketId, ...player }) => player), trails: Object.fromEntries(room.trails) })) }, null, 2);
    const temp = `${stateFile}.${process.pid}.tmp`;
    await writeFile(temp, payload, { mode: 0o600 }); await rename(temp, stateFile); dirty = false;
  }
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const ticker = setInterval(tick, TICK_MS);
  const saver = setInterval(() => { if (dirty) void persist().catch(() => undefined); }, SAVE_INTERVAL);
  async function close() {
    clearInterval(ticker); clearInterval(saver);
    // Socket.IO's close callback waits for the HTTP server to finish closing,
    // which in turn waits for active connections. Force those connections down
    // first so an attached original client cannot deadlock shutdown/restart.
    const closing = io.close();
    server.closeAllConnections();
    await closing;
    if (server.listening) await new Promise(resolve => server.close(() => resolve()));
    await persist();
  }
  return { close, url: `http://127.0.0.1:${port}` };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startTronServer().then(server => console.log(`Tron original client: ${server.url}`)).catch(error => { console.error(error); process.exitCode = 1; });
}

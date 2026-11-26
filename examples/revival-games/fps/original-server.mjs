import { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAPS = ['courtyard', 'foundry'];

export function createFpsServer({ port = 0, host = '127.0.0.1', dataFile } = {}) {
  const accounts = new Map();
  const sessions = new Map();
  const rooms = new Map();
  const wss = new WebSocketServer({ host, port });
  let persistenceChain = Promise.resolve();

  async function load() {
    if (!dataFile) return;
    try {
      const saved = JSON.parse(await readFile(dataFile, 'utf8'));
      for (const account of saved.accounts ?? []) accounts.set(account.username, account);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  function persist() {
    if (!dataFile) return persistenceChain;
    persistenceChain = persistenceChain.then(async () => {
      await mkdir(dirname(dataFile), { recursive: true });
      const temp = `${dataFile}.tmp`;
      await writeFile(temp, JSON.stringify({ version: 1, accounts: [...accounts.values()] }, null, 2));
      await rename(temp, dataFile);
    });
    return persistenceChain;
  }

  function publicAccount(account) {
    return { username: account.username, wins: account.wins, kills: account.kills, rounds: account.rounds };
  }

  function roomView(room) {
    return {
      id: room.id, name: room.name, map: room.map, status: room.status,
      capacity: room.capacity, round: room.round, scores: room.scores,
      players: [...room.players.values()].map((player) => ({
        username: player.username, team: player.team, hp: player.hp,
        position: player.position, action: player.action, ready: player.ready,
      })),
    };
  }

  function broadcast(room, type, payload, exclude) {
    const message = JSON.stringify({ type, payload });
    for (const player of room.players.values()) {
      if (player.username !== exclude && player.socket?.readyState === 1) player.socket.send(message);
    }
  }

  function send(socket, type, payload, requestId) {
    if (socket?.readyState === 1) socket.send(JSON.stringify({ type, payload, ...(requestId ? { requestId } : {}) }));
  }

  function sync(room) {
    broadcast(room, 'room.snapshot', { room: roomView(room) });
  }

  function leave(username) {
    const session = sessions.get(username);
    const room = session?.roomId ? rooms.get(session.roomId) : null;
    if (!room) return;
    room.players.delete(username);
    session.roomId = null;
    broadcast(room, 'room.player_left', { username, room: roomView(room) });
    if (!room.players.size) rooms.delete(room.id);
  }

  function authenticate(payload) {
    const { username, password, mode } = payload;
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username ?? '') || typeof password !== 'string' || !password) {
      throw new Error('用户名需为 3-20 位字母数字下划线，密码不能为空');
    }
    let account = accounts.get(username);
    if (mode === 'register') {
      if (account) throw new Error('账号已存在');
      account = { username, password, wins: 0, kills: 0, rounds: 0 };
      accounts.set(username, account);
      persist().catch(() => {});
    } else {
      if (!account || account.password !== password) throw new Error('账号或密码错误');
    }
    return { token: randomUUID(), account: publicAccount(account) };
  }

  function requireSession(state) {
    if (!state.username) throw new Error('请先登录');
    return sessions.get(state.username);
  }

  async function handle(socket, state, message) {
    const { type, payload = {}, requestId } = message;
    const reply = (responseType, responsePayload) => send(socket, responseType, responsePayload, requestId);
    if (type === 'auth.register' || type === 'auth.login') {
      if (state.username && state.username !== payload.username) throw new Error('连接已登录');
      const result = authenticate({ ...payload, mode: type === 'auth.register' ? 'register' : 'login' });
      state.username = payload.username;
      state.token = result.token;
      sessions.set(payload.username, { token: result.token, socket, roomId: null });
      reply('auth.ok', result);
      return;
    }
    if (type === 'auth.resume') {
      const target = sessions.get(payload.username);
      if (!target || payload.token !== target.token) throw new Error('恢复令牌无效');
      state.username = payload.username;
      target.socket = socket;
      const room = target.roomId ? rooms.get(target.roomId) : null;
      if (room) {
        const player = room.players.get(payload.username);
        if (player) { player.connected = true; player.socket = socket; }
        sync(room);
      }
      reply('auth.resumed', { account: publicAccount(accounts.get(payload.username)), roomId: target.roomId });
      return;
    }
    const session = requireSession(state);
    if (type === 'lobby.list_rooms') {
      reply('lobby.rooms', { rooms: [...rooms.values()].map(roomView) });
      return;
    }
    if (type === 'room.create') {
      leave(state.username);
      const map = payload.map ?? MAPS[0];
      if (!MAPS.includes(map)) throw new Error('未知地图');
      const id = randomUUID().slice(0, 8);
      const team = payload.team === 'alpha' ? 'alpha' : 'bravo';
      const room = {
        id, name: payload.name || `${state.username} 的房间`, map, capacity: 4,
        status: 'waiting', round: 0, scores: { alpha: 0, bravo: 0 }, players: new Map(),
      };
      room.players.set(state.username, {
        username: state.username, team, hp: 100, position: { x: 0, y: 0, z: 0 },
        action: { kind: 'idle', sequence: 0 }, ready: false, socket,
      });
      rooms.set(id, room);
      session.roomId = id;
      reply('room.created', { room: roomView(room) });
      return;
    }
    if (type === 'room.join') {
      leave(state.username);
      const room = rooms.get(payload.roomId);
      if (!room) throw new Error('房间不存在');
      if (room.players.size >= room.capacity) throw new Error('房间已满');
      room.players.set(state.username, {
        username: state.username, team: room.players.size === 1 ? (room.players.values().next().value.team === 'alpha' ? 'bravo' : 'alpha') : 'alpha',
        hp: 100, position: { x: 0, y: 0, z: 0 }, action: { kind: 'idle', sequence: 0 }, ready: false, socket,
      });
      session.roomId = room.id;
      reply('room.joined', { room: roomView(room) });
      sync(room);
      return;
    }
    if (type === 'room.leave') {
      leave(state.username);
      reply('room.left', {});
      return;
    }
    const room = session.roomId ? rooms.get(session.roomId) : null;
    if (!room) throw new Error('不在房间中');
    if (type === 'room.ready') {
      room.players.get(state.username).ready = Boolean(payload.ready);
      sync(room);
      if (room.players.size >= 2 && [...room.players.values()].every((player) => player.ready)) {
        room.status = 'playing'; room.round += 1;
        for (const player of room.players.values()) { player.hp = 100; player.position = { x: 0, y: 0, z: 0 }; }
        broadcast(room, 'round.started', { room: roomView(room) });
        reply('room.snapshot', { room: roomView(room) });
      } else reply('room.snapshot', { room: roomView(room) });
      return;
    }
    if (type === 'map.load') {
      if (payload.map !== room.map) throw new Error('地图与房间不一致');
      reply('map.loaded', { map: payload.map, checksum: `own-${room.map}-v1` });
      return;
    }
    if (type === 'player.move') {
      if (room.status !== 'playing') throw new Error('回合未开始');
      const { x, y, z } = payload.position ?? {};
      if (![x, y, z].every(Number.isFinite) || Math.abs(x) > 100 || Math.abs(y) > 100 || Math.abs(z) > 100) throw new Error('位置无效');
      room.players.get(state.username).position = { x, y, z };
      broadcast(room, 'player.moved', { username: state.username, position: { x, y, z }, serverTick: room.tick = (room.tick ?? 0) + 1 });
      reply('player.moved', { position: { x, y, z }, serverTick: room.tick });
      return;
    }
    if (type === 'player.action') {
      if (!['jump', 'crouch', 'fire', 'reload'].includes(payload.kind)) throw new Error('未知动作');
      const player = room.players.get(state.username);
      player.action = { kind: payload.kind, sequence: (player.action.sequence ?? 0) + 1 };
      broadcast(room, 'player.action', { username: state.username, ...player.action });
      reply('player.action', { ...player.action });
      return;
    }
    if (type === 'combat.damage') {
      if (room.status !== 'playing') throw new Error('回合未开始');
      const target = room.players.get(payload.target);
      const amount = Number(payload.amount);
      if (!target || target.username === state.username || !Number.isInteger(amount) || amount < 1 || amount > 50) throw new Error('伤害目标或数值无效');
      target.hp = Math.max(0, target.hp - amount);
      broadcast(room, 'combat.damaged', { attacker: state.username, target: target.username, amount, hp: target.hp });
      reply('combat.damaged', { target: target.username, hp: target.hp });
      return;
    }
    if (type === 'round.end') {
      if (room.status !== 'playing') throw new Error('没有进行中的回合');
      room.status = 'finished';
      room.scores[room.players.get(state.username).team] += 1;
      const account = accounts.get(state.username);
      account.wins += 1;
      for (const player of room.players.values()) {
        const stats = accounts.get(player.username); stats.rounds += 1;
        if (player.username !== state.username) stats.kills += 1;
      }
      await persist();
      const result = { winner: room.players.get(state.username).team, scores: { ...room.scores }, room: roomView(room) };
      broadcast(room, 'round.ended', result);
      reply('score.saved', { account: publicAccount(account), scores: result.scores });
      return;
    }
    throw new Error(`未知消息类型 ${type}`);
  }

  wss.on('connection', (socket) => {
    const state = {};
    send(socket, 'welcome', { game: 'owned-fps', version: '1.0.0', heartbeatMs: 30000 });
    socket.on('message', async (raw) => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { send(socket, 'error', { message: 'JSON 无效' }); return; }
      try { await handle(socket, state, message); }
      catch (error) {
        if (error.message === '不在房间中') return;
        send(socket, 'error', { message: error.message }, message.requestId);
      }
    });
    socket.on('close', () => {
      if (!state.username) return;
      const session = sessions.get(state.username);
      if (session?.socket !== socket) return;
      session.socket = null;
      const room = session.roomId ? rooms.get(session.roomId) : null;
      if (room) {
        const player = room.players.get(state.username);
        if (player) player.connected = false;
        broadcast(room, 'room.connection', { username: state.username, connected: false });
      }
    });
  });

  const ready = load().then(() => new Promise((resolve) => {
    if (wss.address()) resolve(); else wss.once('listening', resolve);
  }));
  return {
    wss, ready,
    url: () => `ws://127.0.0.1:${wss.address().port}`,
    close: async () => { await persistenceChain; await new Promise((resolve) => wss.close(resolve)); },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const dataFile = process.env.FPS_DATA_FILE;
  const server = createFpsServer({ port: Number(process.env.FPS_PORT || 3901), dataFile });
  await server.ready;
  console.log(`FPS_SERVER_READY ${JSON.stringify({ url: server.url(), pid: process.pid })}`);
  const shutdown = async () => { await server.close(); process.exit(0); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

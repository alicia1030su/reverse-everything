import WebSocket from 'ws';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class GameClient {
  constructor(url, name, record) {
    this.url = url; this.name = name; this.record = record;
    this.socket = new WebSocket(url); this.pending = new Map(); this.events = [];
    this.sequence = 0; this.token = null; this.profile = null; this.room = null;
    this.socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      record?.({ direction: 'server-to-client', client: name, type: message.type, payload: message.payload });
      this.events.push(message);
      if (message.requestId) {
        const pending = this.pending.get(message.requestId);
        if (pending) { this.pending.delete(message.requestId); message.type === 'error' ? pending.reject(new Error(message.payload.message)) : pending.resolve(message.payload); }
      }
    });
    this.opened = new Promise((resolve, reject) => { this.socket.once('open', resolve); this.socket.once('error', reject); });
  }
  async connect() { await this.opened; await this.waitFor('welcome'); }
  send(type, payload = {}) {
    const requestId = `${this.name}-${++this.sequence}`;
    const message = { type, payload, requestId };
    this.record?.({ direction: 'client-to-server', client: this.name, type, payload });
    this.socket.send(JSON.stringify(message));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error(`${type} 超时`)); }, 5000);
      this.pending.set(requestId, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
    });
  }
  waitFor(type, timeout = 5000) {
    const existing = this.events.find((message) => message.type === type);
    if (existing) return Promise.resolve(existing.payload);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.socket.off('message', listener); reject(new Error(`等待 ${type} 超时`)); }, timeout);
      const listener = (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type === type) { clearTimeout(timer); this.socket.off('message', listener); resolve(message.payload); }
      };
      this.socket.on('message', listener);
    });
  }
  close() { this.socket.close(); }
}

function assert(condition, message) { if (!condition) throw new Error(`断言失败: ${message}`); }

export async function runFpsScenario(url, record) {
  const alpha = new GameClient(url, 'alpha', record);
  const bravo = new GameClient(url, 'bravo', record);
  await alpha.connect(); await bravo.connect();
  const password = 'owned-test-password';
  await alpha.send('auth.register', { username: 'alpha_owned', password });
  alpha.token = (await alpha.send('auth.login', { username: 'alpha_owned', password })).token;
  alpha.profile = { username: 'alpha_owned' };
  await bravo.send('auth.register', { username: 'bravo_owned', password });
  bravo.token = (await bravo.send('auth.login', { username: 'bravo_owned', password })).token;
  bravo.profile = { username: 'bravo_owned' };
  assert(alpha.token && bravo.token, '两名玩家均取得会话令牌');

  const sideRoom = await bravo.send('room.create', { name: '训练侧房', map: 'foundry', team: 'bravo' });
  const mainRoom = await alpha.send('room.create', { name: '主对战房', map: 'courtyard', team: 'alpha' });
  alpha.room = mainRoom.room;
  const lobby = await bravo.send('lobby.list_rooms');
  assert(lobby.rooms.length === 2 && lobby.rooms.some((room) => room.id === sideRoom.room.id), '大厅展示多个房间');
  await bravo.send('room.join', { roomId: mainRoom.room.id });
  bravo.room = (await bravo.send('lobby.list_rooms')).rooms.find((room) => room.id === mainRoom.room.id);
  assert(bravo.room.players.length === 2, '房间内有两名独立玩家');
  const roundStarted = alpha.waitFor('round.started');
  const alphaReady = alpha.send('room.ready', { ready: true });
  await bravo.send('room.ready', { ready: true });
  await alphaReady;
  await roundStarted;
  await Promise.all([alpha.send('map.load', { map: 'courtyard' }), bravo.send('map.load', { map: 'courtyard' })]);
  const movedAlpha = alpha.waitFor('player.moved');
  await alpha.send('player.move', { position: { x: 3.5, y: 0, z: -2 } });
  await movedAlpha;
  await bravo.send('player.move', { position: { x: -4, y: 0, z: 6 } });
  const alphaAction = bravo.waitFor('player.action');
  await alpha.send('player.action', { kind: 'jump' }); await alphaAction;
  const bravoAction = alpha.waitFor('player.action');
  await bravo.send('player.action', { kind: 'crouch' }); await bravoAction;

  const bravoDamage = alpha.waitFor('combat.damaged');
  await bravo.send('combat.damage', { target: 'alpha_owned', amount: 25 }); await bravoDamage;
  const alphaDamage = bravo.waitFor('combat.damaged');
  await alpha.send('combat.damage', { target: 'bravo_owned', amount: 40 }); await alphaDamage;
  const lastDamage = bravo.waitFor('combat.damaged');
  await alpha.send('combat.damage', { target: 'bravo_owned', amount: 35 }); await lastDamage;

  bravo.close(); await wait(100);
  const resumed = new GameClient(url, 'bravo-reconnected', record);
  await resumed.connect();
  const auth = await resumed.send('auth.resume', { token: bravo.token, username: 'bravo_owned' });
  assert(auth.account.username === 'bravo_owned' && auth.roomId === mainRoom.room.id, '断线重连恢复会话与房间');
  await alpha.send('player.action', { kind: 'reload' });

  const ended = resumed.waitFor('round.ended');
  const score = await alpha.send('round.end', {});
  await ended;
  assert(score.account.wins === 1 && score.scores.alpha === 1, '回合结算与持久化计分');
  const observed = [...alpha.events, ...bravo.events, ...resumed.events];
  const latestByPlayer = new Map();
  for (const message of observed) if (message.type === 'player.moved' && message.payload.username) latestByPlayer.set(message.payload.username, message.payload.position);
  const latestActions = new Map();
  for (const message of observed) if (message.type === 'player.action' && message.payload.username) latestActions.set(message.payload.username, message.payload.kind);
  const positions = [...latestByPlayer.values()];
  const actions = [...latestActions.values()];
  const hp = {};
  for (const message of observed) if (message.type === 'combat.damaged' && message.payload.attacker) hp[message.payload.target] = message.payload.hp;
  const verification = {
    players: mainRoom.room.players.length + 1, mapsLoaded: [mainRoom.room.map], actions,
    independentPositions: positions, bravoHp: hp.bravo_owned, alphaHp: hp.alpha_owned,
    reconnected: true, multiRoom: true, score: score.scores, winner: 'alpha',
    persistedWins: score.account.wins, eventsObserved: observed.length,
  };
  alpha.close(); resumed.close();
  return verification;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await runFpsScenario(process.argv[2] || 'ws://127.0.0.1:3901');
  console.log(JSON.stringify(result, null, 2));
}

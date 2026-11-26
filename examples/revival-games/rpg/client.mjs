import WebSocket from 'ws';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export class RpgClient {
  constructor(url, name, record) {
    this.url = url; this.name = name; this.record = record;
    this.socket = new WebSocket(url); this.pending = new Map(); this.events = [];
    this.sequence = 0; this.token = null; this.character = null;
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
  waitFor(type, predicate = () => true, timeout = 5000) {
    const existing = this.events.find((message) => message.type === type && predicate(message.payload));
    if (existing) return Promise.resolve(existing.payload);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.socket.off('message', listener); reject(new Error(`等待 ${type} 超时`)); }, timeout);
      const listener = (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type === type && predicate(message.payload)) { clearTimeout(timer); this.socket.off('message', listener); resolve(message.payload); }
      };
      this.socket.on('message', listener);
    });
  }
  close() { this.socket.close(); }
}

function assert(condition, message) { if (!condition) throw new Error(`断言失败: ${message}`); }

export async function runRpgScenario(url, record) {
  const one = new RpgClient(url, 'player-one', record);
  const two = new RpgClient(url, 'player-two', record);
  await one.connect(); await two.connect();
  const password = 'owned-rpg-password';
  await one.send('auth.register', { username: 'ranger_owned', password });
  await two.send('auth.register', { username: 'mage_owned', password });
  one.token = (await one.send('auth.login', { username: 'ranger_owned', password })).token;
  two.token = (await two.send('auth.login', { username: 'mage_owned', password })).token;
  const first = await one.send('character.create', { name: '林溪' });
  const second = await two.send('character.create', { name: '星野' });
  one.character = first.character; two.character = second.character;
  assert(first.character.inventory.length === 0 && second.character.inventory.length === 0, '新角色背包独立且为空');
  await Promise.all([one.send('scene.enter', { characterId: first.character.id }), two.send('scene.enter', { characterId: second.character.id })]);
  const sceneOne = await one.send('scene.snapshot');
  const sceneTwo = await two.send('scene.snapshot');
  assert(sceneOne.scene.id === sceneTwo.scene.id && sceneOne.scene.id === 'greenvale', '两名玩家进入同一共享场景');

  const observedMove = two.waitFor('scene.entity_updated', (payload) => payload.character.id === first.character.id && payload.character.position.x === 7);
  await one.send('player.move', { position: { x: 7, y: 0, z: -3 } });
  const observed = await observedMove;
  assert(observed.character.owner === 'ranger_owned' && observed.character.name === '林溪', '共享场景同步玩家实体状态');

  await one.send('quest.accept', { questId: 'first_steps' });
  const pickupObserved = two.waitFor('scene.entity_updated', (payload) => payload.character.inventory.some((item) => item.itemId === 'health_herb'));
  await one.send('inventory.pickup', { itemId: 'health_herb' }); await pickupObserved;
  const stoneObserved = one.waitFor('scene.entity_updated', (payload) => payload.character.inventory.some((item) => item.itemId === 'moon_stone'));
  await one.send('inventory.pickup', { itemId: 'moon_stone' }); await stoneObserved;
  await two.send('inventory.pickup', { itemId: 'iron_sword' });
  const twoSnapshot = await two.send('scene.snapshot');
  assert(twoSnapshot.character.inventory.length === 1 && twoSnapshot.character.inventory[0].itemId === 'iron_sword', '多玩家背包状态隔离');
  assert(!twoSnapshot.character.inventory.some((item) => item.itemId === 'moon_stone'), '角色一任务物品未泄漏到角色二');
  const questObserved = two.waitFor('scene.entity_updated', (payload) => payload.character.id === first.character.id && payload.character.quests.first_steps === 'completed');
  const completed = await one.send('quest.complete', { questId: 'first_steps' }); await questObserved;
  assert(completed.status === 'completed' && completed.level === 2, '任务状态推进与等级变化');

  await one.send('inventory.drop', { itemId: 'health_herb' });
  await one.send('inventory.pickup', { itemId: 'health_herb' });
  await one.send('inventory.use', { itemId: 'health_herb' });
  await one.send('player.move', { position: { x: 8, y: 0, z: -3 } });
  const twoMove = await two.send('player.move', { position: { x: -5, y: 0, z: 4 } });
  const saved = await one.send('save.request', {});
  const list = await one.send('character.list');
  assert(list.characters.length === 1 && list.characters[0].quests.first_steps === 'completed', '角色列表反映最新任务状态');

  one.close();
  const resumed = new RpgClient(url, 'player-one-resumed', record);
  await resumed.connect();
  const auth = await resumed.send('auth.resume', { token: one.token, username: 'ranger_owned' });
  assert(auth.account.characterIds[0] === first.character.id, 'RPG 会话可恢复');
  const restored = await resumed.send('scene.enter', { characterId: first.character.id });
  assert(restored.character.quests.first_steps === 'completed' && restored.character.inventory.some((item) => item.itemId === 'moon_stone'), '重连后恢复任务与背包');
  const verification = {
    players: 2, sharedScene: 'greenvale', characters: ['林溪', '星野'],
    playerOneInventory: restored.character.inventory, playerTwoInventory: twoSnapshot.character.inventory,
    quest: { id: 'first_steps', status: restored.character.quests.first_steps }, level: restored.character.level,
    isolated: true, reconnected: true, savedAt: saved.savedAt,
    positions: [restored.character.position, twoMove.position],
    eventsObserved: one.events.length + two.events.length + resumed.events.length,
  };
  resumed.close(); two.close();
  return verification;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await runRpgScenario(process.argv[2] || 'ws://127.0.0.1:3902');
  console.log(JSON.stringify(result, null, 2));
}

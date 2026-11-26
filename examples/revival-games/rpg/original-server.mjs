import { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ITEMS = {
  iron_sword: { id: 'iron_sword', name: '自有铁剑', kind: 'weapon', attack: 12 },
  health_herb: { id: 'health_herb', name: '自有草药', kind: 'consumable', heal: 30 },
  moon_stone: { id: 'moon_stone', name: '月纹石', kind: 'quest', quest: 'first_steps' },
};

export function createRpgServer({ port = 0, host = '127.0.0.1', dataFile } = {}) {
  const accounts = new Map();
  const sessions = new Map();
  const characters = new Map();
  const world = new Map();
  const wss = new WebSocketServer({ host, port });
  let persistenceChain = Promise.resolve();

  async function load() {
    if (!dataFile) return;
    try {
      const saved = JSON.parse(await readFile(dataFile, 'utf8'));
      for (const account of saved.accounts ?? []) accounts.set(account.username, account);
      for (const [id, character] of saved.characters ?? []) characters.set(id, character);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }

  function persist() {
    if (!dataFile) return persistenceChain;
    persistenceChain = persistenceChain.then(async () => {
      await mkdir(dirname(dataFile), { recursive: true });
      const temp = `${dataFile}.tmp`;
      await writeFile(temp, JSON.stringify({ version: 1, accounts: [...accounts.values()], characters: [...characters.entries()] }, null, 2));
      await rename(temp, dataFile);
    });
    return persistenceChain;
  }

  function publicAccount(account) { return { username: account.username, characterIds: account.characterIds }; }
  function characterView(character) {
    return {
      id: character.id, owner: character.owner, name: character.name, level: character.level,
      hp: character.hp, position: character.position, inventory: character.inventory,
      quests: character.quests, sceneVersion: character.sceneVersion,
    };
  }
  function send(socket, type, payload, requestId) {
    if (socket?.readyState === 1) socket.send(JSON.stringify({ type, payload, ...(requestId ? { requestId } : {}) }));
  }
  function sceneFor(character) {
    return { id: 'greenvale', name: '自有绿谷', version: character.sceneVersion, entities: [...world.values()] };
  }
  function publishCharacter(character) {
    const view = characterView(character);
    for (const session of sessions.values()) {
      if (session.socket?.readyState === 1) send(session.socket, 'scene.entity_updated', { character: view });
    }
  }

  async function handle(socket, state, message) {
    const { type, payload = {}, requestId } = message;
    const reply = (responseType, responsePayload) => send(socket, responseType, responsePayload, requestId);
    if (type === 'auth.register' || type === 'auth.login') {
      const { username, password } = payload;
      if (!/^[a-zA-Z0-9_]{3,20}$/.test(username ?? '') || typeof password !== 'string' || !password) throw new Error('账号信息无效');
      let account = accounts.get(username);
      if (type === 'auth.register') {
        if (account) throw new Error('账号已存在');
        account = { username, password, characterIds: [] }; accounts.set(username, account);
      } else if (!account || account.password !== password) throw new Error('账号或密码错误');
      state.username = username;
      sessions.set(username, { token: randomUUID(), socket });
      reply('auth.ok', { token: sessions.get(username).token, account: publicAccount(account) });
      persist().catch(() => {});
      return;
    }
    if (type === 'auth.resume') {
      const account = accounts.get(payload.username);
      if (!account || payload.token !== sessions.get(payload.username)?.token) throw new Error('恢复令牌无效');
      state.username = payload.username;
      sessions.get(payload.username).socket = socket;
      reply('auth.resumed', { account: publicAccount(account) });
      return;
    }
    if (!state.username) throw new Error('请先登录');
    if (type === 'character.create') {
      const name = payload.name;
      if (!/^[\p{L}\p{N}_-]{2,16}$/u.test(name ?? '')) throw new Error('角色名无效');
      const account = accounts.get(state.username);
      if (account.characterIds.length >= 3) throw new Error('角色数量已达上限');
      const character = {
        id: randomUUID(), owner: state.username, name, level: 1, hp: 100,
        position: { x: account.characterIds.length * 2, y: 0, z: 0 }, inventory: [],
        quests: { first_steps: 'available', grove_guardian: 'locked' }, sceneVersion: 1,
      };
      characters.set(character.id, character); account.characterIds.push(character.id);
      persist().catch(() => {});
      reply('character.created', { character: characterView(character), scene: sceneFor(character) });
      return;
    }
    if (type === 'character.list') {
      reply('character.list', { characters: accounts.get(state.username).characterIds.map((id) => characterView(characters.get(id))) });
      return;
    }
    if (type === 'character.select' || type === 'scene.enter') {
      const character = characters.get(payload.characterId);
      if (!character || character.owner !== state.username) throw new Error('角色不存在或不属于当前账号');
      state.characterId = character.id;
      reply(type === 'scene.enter' ? 'scene.entered' : 'character.selected', { character: characterView(character), scene: sceneFor(character) });
      return;
    }
    const character = characters.get(state.characterId);
    if (!character) throw new Error('请选择角色');
    if (type === 'scene.snapshot') {
      reply('scene.snapshot', { scene: sceneFor(character), character: characterView(character) });
      return;
    }
    if (type === 'player.move') {
      const { x, y, z } = payload.position ?? {};
      if (![x, y, z].every(Number.isFinite) || Math.abs(x) > 200 || Math.abs(z) > 200) throw new Error('位置无效');
      character.position = { x, y, z }; character.sceneVersion += 1;
      publishCharacter(character); reply('player.moved', { position: character.position });
      return;
    }
    if (type === 'inventory.pickup') {
      const definition = ITEMS[payload.itemId];
      const entity = world.get(payload.itemId);
      if (!definition || !entity || entity.owner) throw new Error('物品不存在或已被拾取');
      if (character.inventory.length >= 12) throw new Error('背包已满');
      entity.owner = character.owner; entity.characterId = character.id; entity.pickedAt = character.sceneVersion + 1;
      character.inventory.push({ itemId: definition.id, quantity: 1 });
      character.sceneVersion += 1;
      persist().catch(() => {}); publishCharacter(character);
      reply('inventory.updated', { inventory: character.inventory, sceneVersion: character.sceneVersion });
      return;
    }
    if (type === 'inventory.drop') {
      const index = character.inventory.findIndex((item) => item.itemId === payload.itemId);
      if (index < 0) throw new Error('背包中没有该物品');
      const [removed] = character.inventory.splice(index, 1);
      const entity = world.get(removed.itemId);
      if (entity) { delete entity.owner; delete entity.characterId; delete entity.pickedAt; }
      character.sceneVersion += 1; persist().catch(() => {}); publishCharacter(character);
      reply('inventory.updated', { inventory: character.inventory, sceneVersion: character.sceneVersion });
      return;
    }
    if (type === 'inventory.use') {
      const item = character.inventory.find((entry) => entry.itemId === payload.itemId);
      if (!item || item.itemId !== 'health_herb') throw new Error('只能使用自有草药');
      character.hp = Math.min(100, character.hp + ITEMS.health_herb.heal); item.quantity -= 1;
      if (!item.quantity) character.inventory.splice(character.inventory.indexOf(item), 1);
      character.sceneVersion += 1; persist().catch(() => {}); publishCharacter(character);
      reply('inventory.used', { itemId: payload.itemId, hp: character.hp, inventory: character.inventory });
      return;
    }
    if (type === 'quest.accept' || type === 'quest.complete') {
      const questId = payload.questId;
      if (!Object.hasOwn(character.quests, questId)) throw new Error('任务不存在');
      if (type === 'quest.accept') {
        if (character.quests[questId] !== 'available') throw new Error('任务当前不可接取');
        character.quests[questId] = 'active';
      } else {
        if (character.quests[questId] !== 'active') throw new Error('任务尚未接取');
        const required = questId === 'first_steps' ? 'moon_stone' : 'iron_sword';
        if (!character.inventory.some((item) => item.itemId === required)) throw new Error(`缺少任务物品 ${required}`);
        character.quests[questId] = 'completed'; character.level += 1;
      }
      character.sceneVersion += 1; persist().catch(() => {}); publishCharacter(character);
      reply(type === 'quest.accept' ? 'quest.accepted' : 'quest.completed', { questId, status: character.quests[questId], level: character.level });
      return;
    }
    if (type === 'save.request') {
      await persist();
      reply('save.completed', { characterId: character.id, savedAt: new Date().toISOString(), sceneVersion: character.sceneVersion });
      return;
    }
    throw new Error(`未知消息类型 ${type}`);
  }

  wss.on('connection', (socket) => {
    const state = {};
    send(socket, 'welcome', { game: 'owned-rpg', version: '1.0.0', scene: 'greenvale', heartbeatMs: 30000 });
    socket.on('message', async (raw) => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { send(socket, 'error', { message: 'JSON 无效' }); return; }
      try { await handle(socket, state, message); }
      catch (error) { send(socket, 'error', { message: error.message }, message.requestId); }
    });
    socket.on('close', () => {
      if (!state.username) return;
      const session = sessions.get(state.username);
      if (session?.socket === socket) session.socket = null;
    });
  });

  const ready = load().then(() => {
    for (const [id, item] of Object.entries(ITEMS)) {
      if (!world.has(id)) world.set(id, { id, name: item.name, kind: item.kind, scene: 'greenvale' });
    }
    return new Promise((resolve) => {
      if (wss.address()) resolve(); else wss.once('listening', resolve);
    });
  });
  return { wss, ready, url: () => `ws://127.0.0.1:${wss.address().port}`, close: async () => { await persistenceChain; await new Promise((resolve) => wss.close(resolve)); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const server = createRpgServer({ port: Number(process.env.RPG_PORT || 3902), dataFile: process.env.RPG_DATA_FILE });
  await server.ready;
  console.log(`RPG_SERVER_READY ${JSON.stringify({ url: server.url(), pid: process.pid })}`);
  const shutdown = async () => { await server.close(); process.exit(0); };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
}

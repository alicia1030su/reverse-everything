import type { GameBehavior, GameBehaviorAction, GameBehaviorEvidence } from './types.js';

const MAX_BEHAVIOR_BYTES = 64 * 1024;
const MAX_ACTIONS = 16;
const MAX_OBSTACLES = 256;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 必须是对象`);
  return value as Record<string, unknown>;
}
function integer(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${label} 必须是 ${min}-${max} 的整数`);
  return value;
}
function text(value: unknown, label: string, maxLength = 80): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength || /[\u0000-\u001f]/.test(value)) throw new Error(`${label} 无效`);
  return value.trim();
}
function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} 必须是布尔值`);
  return value;
}

export function requiredMatchSize(behavior?: GameBehavior): number {
  if (!behavior) return 2;
  const scorePlayers = behavior.winCondition.type === 'firstToScore' && !behavior.rules.respawn ? behavior.winCondition.target + 1 : 2;
  return Math.max(2, behavior.rules.minPlayers, scorePlayers);
}

export function selectWinningActions(behavior: GameBehavior): { attack?: GameBehaviorAction; gather?: GameBehaviorAction } {
  const roundMs = behavior.rules.roundSeconds * 1000;
  const kills = behavior.winCondition.type === 'firstToScore'
    ? (behavior.rules.respawn ? behavior.winCondition.target : 1)
    : behavior.winCondition.type === 'survive' ? requiredMatchSize(behavior) - 1 : 0;
  const attack = behavior.actions.find(action => {
    if (action.kind !== 'attack') return false;
    const required = kills * Math.ceil(behavior.rules.maxHealth / action.damage!);
    return required <= 100 && required * action.cooldownMs <= roundMs;
  });
  const gather = behavior.actions.find(action => {
    if (action.kind !== 'gather') return false;
    const required = Math.ceil(behavior.winCondition.target / action.amount!);
    return required <= 100 && required * action.cooldownMs <= roundMs;
  });
  return { ...(attack ? { attack } : {}), ...(gather ? { gather } : {}) };
}

/** Parse a bounded, explicit behavior contract. Missing or invalid contracts never become facts. */
export function parseGameBehavior(content: string, sourcePath: string, sha256: string): GameBehaviorEvidence {
  if (Buffer.byteLength(content) > MAX_BEHAVIOR_BYTES) throw new Error('行为规格超过 64KiB 上限');
  const root = record(JSON.parse(content) as unknown, '行为规格');
  if (root.format !== 'revival-behavior/v1') throw new Error('不支持的行为规格格式');
  const rules = record(root.rules, 'rules');
  const map = record(root.map, 'map');
  if (!Array.isArray(root.actions) || root.actions.length < 1 || root.actions.length > MAX_ACTIONS) throw new Error('actions 必须包含 1-16 个动作');
  const actionIds = new Set<string>();
  const actions: GameBehaviorAction[] = root.actions.map((value, index) => {
    const item = record(value, `actions[${index}]`);
    const id = text(item.id, `actions[${index}].id`, 40);
    if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(id) || actionIds.has(id)) throw new Error(`动作 id 无效或重复: ${id}`);
    actionIds.add(id);
    const kind = item.kind;
    if (kind !== 'attack' && kind !== 'gather' && kind !== 'heal') throw new Error(`不支持的动作类型: ${String(kind)}`);
    const action: GameBehaviorAction = { id, kind, cooldownMs: integer(item.cooldownMs, `${id}.cooldownMs`, 0, 60_000) };
    if (kind === 'attack') {
      action.damage = integer(item.damage, `${id}.damage`, 1, 10_000);
      action.range = integer(item.range, `${id}.range`, 1, 10_000);
    } else {
      action.item = text(item.item, `${id}.item`, 40);
      action.amount = integer(item.amount, `${id}.amount`, 1, 10_000);
      if (kind === 'heal') action.health = integer(item.health, `${id}.health`, 1, 10_000);
    }
    return action;
  });
  const win = record(root.winCondition, 'winCondition');
  const winType = win.type;
  if (winType !== 'firstToScore' && winType !== 'survive' && winType !== 'collect') throw new Error('不支持的胜负条件');
  if (!Array.isArray(map.obstacles) || map.obstacles.length > MAX_OBSTACLES) throw new Error('map.obstacles 无效');
  const width = integer(map.width, 'map.width', 8, 4096);
  const height = integer(map.height, 'map.height', 8, 4096);
  const obstacles = map.obstacles.map((value, index) => {
    const item = record(value, `map.obstacles[${index}]`);
    return { x: integer(item.x, `obstacle[${index}].x`, 0, width - 1), y: integer(item.y, `obstacle[${index}].y`, 0, height - 1) };
  });
  const behavior: GameBehavior = {
    format: 'revival-behavior/v1', id: text(root.id, 'id', 64), title: text(root.title, 'title', 120), mode: text(root.mode, 'mode', 40),
    rules: {
      minPlayers: integer(rules.minPlayers, 'rules.minPlayers', 2, 32), maxPlayers: integer(rules.maxPlayers, 'rules.maxPlayers', 2, 64),
      roundSeconds: integer(rules.roundSeconds, 'rules.roundSeconds', 5, 3600), movementSpeed: integer(rules.movementSpeed, 'rules.movementSpeed', 1, 1000),
      maxHealth: integer(rules.maxHealth, 'rules.maxHealth', 1, 100_000), respawn: boolean(rules.respawn, 'rules.respawn'),
    },
    actions, winCondition: { type: winType, target: integer(win.target, 'winCondition.target', 1, 1_000_000) }, map: { width, height, obstacles },
  };
  if (behavior.rules.maxPlayers < behavior.rules.minPlayers) throw new Error('rules.maxPlayers 不能小于 minPlayers');
  const attacks = actions.filter(action => action.kind === 'attack');
  const gathers = actions.filter(action => action.kind === 'gather');
  const heals = actions.filter(action => action.kind === 'heal');
  if (winType === 'survive' && (behavior.rules.respawn || !attacks.length)) throw new Error('survive 需要攻击动作且不能重生');
  if (winType === 'firstToScore' && !attacks.length) throw new Error('firstToScore 需要攻击动作');
  if (winType === 'firstToScore' && !behavior.rules.respawn && behavior.winCondition.target > behavior.rules.maxPlayers - 1) throw new Error('firstToScore 在无重生时目标分数超过可淘汰玩家数');
  if (winType === 'collect' && !gathers.length) throw new Error('collect 需要采集动作');
  const winning = selectWinningActions(behavior);
  if (winType === 'firstToScore' && !winning.attack) throw new Error('firstToScore 在回合时限内不可达');
  if (winType === 'survive' && !winning.attack) throw new Error('survive 在回合时限内无法淘汰全部玩家');
  if (winType === 'collect' && !winning.gather) throw new Error('collect 在回合时限内不可达');
  for (const heal of heals) if (!gathers.some(gather => gather.item === heal.item)) throw new Error(`治疗物品 ${heal.item} 没有可获取来源`);
  const freeCells = (width + 1) * (height + 1) - new Set(obstacles.map(obstacle => `${obstacle.x},${obstacle.y}`)).size;
  if (freeCells < behavior.rules.maxPlayers) throw new Error('地图可用出生点少于 maxPlayers');
  return { behavior, sourcePath, sha256, evidenceStatus: 'OBSERVED', detail: '从目标目录中的显式行为规格读取并校验；它证明规格存在，不证明原客户端兼容' };
}

export { MAX_BEHAVIOR_BYTES };

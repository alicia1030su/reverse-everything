import { createHash } from 'node:crypto';
import type { Evidence, EvidenceRef, EvidenceStatus, GameBehaviorEvidence, GameFileRecord, GameModuleName, GameObservation, GameProfile, GameServerSpec } from './types.js';

function refsFromFiles(files: GameFileRecord[], pattern: RegExp): EvidenceRef[] {
  return files.filter(file => pattern.test(file.relativePath)).slice(0, 20).map(file => ({ path: file.relativePath, detail: `已观察文件 ${file.extension || '(无扩展名)'}，SHA-256 ${file.sha256 ?? '未计算'}` }));
}

function positiveObservation(item: GameObservation): boolean {
  return item.status === 'OBSERVED' || item.status === 'INFERRED' || item.status === 'VERIFIED';
}

function inferGenre(profile: GameProfile, files: GameFileRecord[], observations: GameObservation[]): 'fps' | 'rpg' {
  if (observations.some(item => item.kind === 'fps' && positiveObservation(item))) return 'fps';
  if (observations.some(item => item.kind === 'rpg' && positiveObservation(item))) return 'rpg';
  if (profile.genre !== 'unknown') return profile.genre;
  const text = [...files.map(file => file.relativePath), profile.name, ...profile.observations.map(ref => ref.detail)].join(' ').toLowerCase();
  if (/(fps|shooter|csgo|counter.strike|pubg|valorant|call.of.duty)/.test(text)) return 'fps';
  if (/(rpg|quest|inventory|wow|final.fantasy|diablo)/.test(text)) return 'rpg';
  return 'fps';
}

function evidence<T>(value: T, refs: EvidenceRef[], status: EvidenceStatus = 'INFERRED', note?: string): Evidence<T> {
  const safeStatus = refs.length ? (status === 'UNKNOWN' ? 'UNKNOWN' : status === 'VERIFIED' ? 'OBSERVED' : status) : 'UNKNOWN';
  return { value, evidenceStatus: safeStatus, evidenceRefs: refs.length ? refs : [{ path: '', detail: note ?? '没有可用文件或观察证据；当前值仅为独立服务设计默认值' }] };
}

function observationRefs(observations: GameObservation[], kind: GameObservation['kind']): EvidenceRef[] {
  return observations.filter(item => item.kind === kind && positiveObservation(item)).map(item => ({ path: item.ref, detail: item.detail }));
}

/** 规格是明确区分事实、推断与未知的独立服务设计，不冒充原版协议兼容。 */
export function createGameServerSpec(profile: GameProfile, files: GameFileRecord[], observations: GameObservation[] = [], behaviorEvidence?: GameBehaviorEvidence): GameServerSpec {
  const behavior = behaviorEvidence?.behavior;
  const behaviorRefs: EvidenceRef[] = behaviorEvidence ? [{ path: behaviorEvidence.sourcePath, detail: behaviorEvidence.detail }] : [];
  const genre = behavior ? (behavior.actions.some(action => action.kind === 'attack') ? 'fps' : 'rpg') : inferGenre(profile, files, observations);
  const mapRefs = [...behaviorRefs, ...observationRefs(observations, 'map'), ...refsFromFiles(files, /(?:^|\/)(?:maps?|levels?|scenes?)(?:\/|\.)|\.(?:tmx|tmj)$/i)];
  const ruleRefs = [...behaviorRefs, ...observationRefs(observations, 'rule'), ...refsFromFiles(files, /(?:^|\/)(?:rules?|config)(?:\/|\.)|(?:^|[/_.-])rules?[/_.-]/i)];
  const genreRefs = [...behaviorRefs, ...observationRefs(observations, 'fps'), ...observationRefs(observations, 'rpg')];
  const engineRefs = [...observationRefs(observations, 'engine'), ...refsFromFiles(files, /(?:project\.settings|package\.json|\.uproject|godot\.project|data\.win|\.exe$|\.dll$)/i)];
  const clientRefs = [...observationRefs(observations, 'client'), ...refsFromFiles(files, /(?:^|\/)(?:client|game)(?:[._/-]|$)|\.exe$/i)];
  const compatibilityRefs = [...engineRefs, ...clientRefs].slice(0, 5);
  const mapObservation = observations.find(item => item.kind === 'map' && positiveObservation(item));
  const ruleObservation = observations.find(item => item.kind === 'rule' && positiveObservation(item));
  const mapValue = mapObservation?.value && typeof mapObservation.value === 'object'
    ? mapObservation.value as { name?: string; width?: number; height?: number }
    : undefined;
  const ruleValue = ruleObservation?.value && typeof ruleObservation.value === 'object' ? ruleObservation.value as Record<string, number | boolean | string> : {};
  const mapName = behavior?.title ?? (typeof mapValue?.name === 'string' ? mapValue.name : profile.name);
  const moduleDesign = (name: GameModuleName): { name: GameModuleName; evidenceStatus: EvidenceStatus; evidenceRefs: EvidenceRef[]; design: string } => ({
    name,
    evidenceStatus: name === 'behavior' ? (behaviorEvidence ? 'OBSERVED' : 'UNKNOWN') : name === genre && genreRefs.length ? (genreRefs.some(ref => observations.some(item => item.kind === genre && item.ref === ref.path && item.status === 'OBSERVED')) ? 'OBSERVED' : 'INFERRED') : 'UNKNOWN',
    evidenceRefs: name === 'behavior' ? behaviorRefs : name === genre ? genreRefs.slice(0, 5) : [],
    design: name === 'behavior' ? `目标行为 ${behavior?.id ?? 'UNKNOWN'}：${behavior?.actions.map(action => `${action.id}:${action.kind}`).join(', ') ?? '无显式行为规格'}；胜负 ${behavior?.winCondition.type ?? 'UNKNOWN'}`
      : name === 'authentication' ? 'scrypt 随机盐账号与短期登录 token；原客户端认证协议 UNKNOWN'
      : name === 'rooms' ? '独立多房间状态、开始/结束与并发隔离'
      : name === 'fps' ? '服务端权威位置、攻击、血量与回合结算'
      : name === 'rpg' ? '共享场景角色、背包、任务、隔离与重启恢复'
      : name === 'movement' ? '坐标与速度边界校验，服务端状态为准'
      : name === 'combat' ? '距离/角度/冷却约束的伤害动作'
      : name === 'inventory' ? '拾取、使用与持久化背包物品'
      : name === 'quests' ? '共享场景动作推进任务计数与奖励'
      : name === 'persistence' ? 'JSON 临时文件 + rename 原子持久化，重启恢复账号与游戏状态'
      : name === 'reconnection' ? '短期随机 resume token 恢复玩家会话'
      : name === 'settlement' ? '回合结束冻结动作并生成服务端结算'
      : 'ADMIN_TOKEN 强制认证的统计与追加审计日志',
  });
  const modules: GameServerSpec['modules'] = [
    moduleDesign('authentication'), moduleDesign('rooms'), moduleDesign(genre), moduleDesign('movement'),
    ...(behaviorEvidence ? [moduleDesign('behavior')] : []),
    moduleDesign(genre === 'fps' ? 'combat' : 'inventory'),
    ...(genre === 'rpg' ? [moduleDesign('quests')] : []),
    moduleDesign('persistence'), moduleDesign('reconnection'), moduleDesign('settlement'), moduleDesign('admin'),
  ];
  return {
    id: `game-${createHash('sha256').update(`${profile.name}:${files.map(file => file.sha256 ?? file.path).join('|')}`).digest('hex').slice(0, 16)}`,
    name: profile.name.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 64) || 'revived-game',
    genre,
    level: files.length ? 'L2' : 'L0',
    modules,
    map: evidence(behavior ? { name: behavior.title, width: behavior.map.width, height: behavior.map.height, obstacles: behavior.map.obstacles } : { name: mapName, width: typeof mapValue?.width === 'number' ? mapValue.width : 128, height: typeof mapValue?.height === 'number' ? mapValue.height : 128, obstacles: [] }, mapRefs.slice(0, 5), behavior ? 'OBSERVED' : mapObservation?.status ?? 'INFERRED'),
    rules: evidence(behavior ? { ...behavior.rules, winCondition: behavior.winCondition.type, winTarget: behavior.winCondition.target } : genre === 'fps'
      ? { roundSeconds: 300, maxPlayers: 8, movementSpeed: 7, damage: 25, respawnSeconds: 5, ...ruleValue }
      : { maxPlayers: 8, movementSpeed: 6, questTarget: 3, inventoryLimit: 20, ...ruleValue }, ruleRefs.slice(0, 5), behavior ? 'OBSERVED' : ruleObservation?.status ?? 'INFERRED'),
    ports: evidence({ game: 8080, admin: 8081, adminHost: '127.0.0.1' }, [], 'INFERRED', '端口为独立工程设计默认值，并非原客户端证据'),
    compatibility: evidence({ originalClient: 'UNKNOWN', notes: ['未证明与原版网络协议兼容', behavior ? '目标行为规格已观察，但传输协议仍为独立 WebSocket 设计' : '提供本工程专用 WebSocket 协议', '只有观察或明确验证的声明才可提升为 VERIFIED'] }, compatibilityRefs),
    ...(behaviorEvidence ? { behaviorEvidence } : {}),
    provenance: {
      targetSpecific: behavior ? [`behavior:${behavior.id}`, `mode:${behavior.mode}`, `actions:${behavior.actions.map(action => action.id).join(',')}`, `win:${behavior.winCondition.type}:${behavior.winCondition.target}`, `map:${behavior.map.width}x${behavior.map.height}`] : [],
      sharedTemplateComponents: ['websocket-transport', 'scrypt-authentication', 'room-lifecycle', 'atomic-json-persistence', 'admin-api', 'docker-deployment'],
      originalClient: 'UNKNOWN',
    },
    files,
    limitations: [...profile.limitations, '生成服务是新实现，不是原始二进制或协议恢复', behavior ? '行为规格来自目标目录，但原客户端协议兼容性仍未验证' : '没有显式行为规格；当前实现使用共享 FPS/RPG 模板，不能宣称目标玩法已恢复', '原始客户端兼容性保持 UNKNOWN，除非提供独立验证'],
  };
}

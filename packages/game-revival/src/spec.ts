import { createHash } from 'node:crypto';
import type { Evidence, EvidenceRef, EvidenceStatus, GameFileRecord, GameModuleName, GameObservation, GameProfile, GameServerSpec } from './types.js';

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
export function createGameServerSpec(profile: GameProfile, files: GameFileRecord[], observations: GameObservation[] = []): GameServerSpec {
  const genre = inferGenre(profile, files, observations);
  const mapRefs = [...observationRefs(observations, 'map'), ...refsFromFiles(files, /(?:^|\/)(?:maps?|levels?|scenes?)(?:\/|\.)|\.(?:tmx|tmj)$/i)];
  const ruleRefs = [...observationRefs(observations, 'rule'), ...refsFromFiles(files, /(?:^|\/)(?:rules?|config)(?:\/|\.)|(?:^|[/_.-])rules?[/_.-]/i)];
  const genreRefs = [...observationRefs(observations, 'fps'), ...observationRefs(observations, 'rpg')];
  const engineRefs = [...observationRefs(observations, 'engine'), ...refsFromFiles(files, /(?:project\.settings|package\.json|\.uproject|godot\.project|data\.win|\.exe$|\.dll$)/i)];
  const clientRefs = [...observationRefs(observations, 'client'), ...refsFromFiles(files, /(?:^|\/)(?:client|game)(?:[._/-]|$)|\.exe$/i)];
  const compatibilityRefs = [...engineRefs, ...clientRefs].slice(0, 5);
  const mapObservation = observations.find(item => item.kind === 'map' && positiveObservation(item));
  const ruleObservation = observations.find(item => item.kind === 'rule' && positiveObservation(item));
  const mapValue = mapObservation?.value && typeof mapObservation.value === 'object'
    ? mapObservation.value as { name?: string; width?: number; height?: number }
    : undefined;
  const ruleValue = ruleObservation?.value && typeof ruleObservation.value === 'object' ? ruleObservation.value as Record<string, number | boolean | string> : {};
  const mapName = typeof mapValue?.name === 'string' ? mapValue.name : profile.name;
  const moduleDesign = (name: GameModuleName): { name: GameModuleName; evidenceStatus: EvidenceStatus; evidenceRefs: EvidenceRef[]; design: string } => ({
    name,
    evidenceStatus: name === genre && genreRefs.length ? (genreRefs.some(ref => observations.some(item => item.kind === genre && item.ref === ref.path && item.status === 'OBSERVED')) ? 'OBSERVED' : 'INFERRED') : 'UNKNOWN',
    evidenceRefs: name === genre ? genreRefs.slice(0, 5) : [],
    design: name === 'authentication' ? 'scrypt 随机盐账号与短期登录 token；原客户端认证协议 UNKNOWN'
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
    map: evidence({ name: mapName, width: typeof mapValue?.width === 'number' ? mapValue.width : 128, height: typeof mapValue?.height === 'number' ? mapValue.height : 128, obstacles: [{ x: 32, y: 32 }, { x: 96, y: 96 }] }, mapRefs.slice(0, 5), mapObservation?.status ?? 'INFERRED'),
    rules: evidence(genre === 'fps'
      ? { roundSeconds: 300, maxPlayers: 8, movementSpeed: 7, damage: 25, respawnSeconds: 5, ...ruleValue }
      : { maxPlayers: 8, movementSpeed: 6, questTarget: 3, inventoryLimit: 20, ...ruleValue }, ruleRefs.slice(0, 5), ruleObservation?.status ?? 'INFERRED'),
    ports: evidence({ game: 8080, admin: 8081, adminHost: '127.0.0.1' }, [], 'INFERRED', '端口为独立工程设计默认值，并非原客户端证据'),
    compatibility: evidence({ originalClient: 'UNKNOWN', notes: ['未证明与原版网络协议兼容', '提供本工程专用 WebSocket 协议', '只有观察或明确验证的声明才可提升为 VERIFIED'] }, compatibilityRefs),
    files,
    limitations: [...profile.limitations, '生成服务是新实现，不是原始二进制或协议恢复', '原始客户端兼容性保持 UNKNOWN，除非提供独立验证'],
  };
}

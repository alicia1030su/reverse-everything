import type { ConsoleEvidenceKind, ConsoleLevel, ConsoleLevelDefinition, ConsoleProfile } from './types.js';

/** Cumulative evidence gates: a higher level is valid only when every preceding gate is proven. */
export const CONSOLE_LEVELS: readonly ConsoleLevelDefinition[] = [
  {
    level: 'C0', name: '已建立主机档案', requiredEvidence: [],
    requirements: ['档案字段完整，来源与未知项明确'],
    allows: ['记录用户陈述、官方资料和未知项'],
    prohibits: ['把档案存在当作设备身份、接口或破解能力证据'],
  },
  {
    level: 'C1', name: '身份与官方资料记录', requiredEvidence: ['IDENTITY', 'OFFICIAL_DOCUMENT'],
    requirements: ['设备身份有可追溯记录', '至少一份官方资料支持当前描述'],
    allows: ['整理型号、硬件版本、系统版本和公开接口'],
    prohibits: ['把用户填写或外观识别当作独立验证', 'C1 只表示资料已记录，不表示设备或接口已验证'],
  },
  {
    level: 'C2', name: '合法可用设备接口', requiredEvidence: ['AUTHORIZED_INTERFACE_OBSERVATION'],
    requirements: ['在合法授权范围内确认可用接口', 'actualAccess 为 AUTHORIZED_DEV_INTERFACE 或 READ_ONLY'],
    allows: ['研究该接口明确公开的操作与限制'],
    prohibits: ['把 USB-C 外形、枚举或未公开接口当作调试授权'],
  },
  {
    level: 'C3', name: '公开固件或自有应用静态分析', requiredEvidence: ['FIRMWARE_SAMPLE'],
    requirements: ['样本来源合法且可追溯', '记录样本 SHA-256 与离线静态分析方法'],
    allows: ['在隔离环境中分析已提供的固件或应用样本'],
    prohibits: ['把样本存在当作设备可被调试、修改或绕过的证明'],
  },
  {
    level: 'C4', name: '授权开发环境实测', requiredEvidence: ['AUTHORIZED_DEV_TEST'],
    requirements: ['在官方获批开发环境中完成应用测试或兼容性验证', '记录环境、方法、结果与证据'],
    allows: ['发布限定于该开发环境的测试结论'],
    prohibits: ['把开发环境权限外推到零售系统全部权限'],
  },
  {
    level: 'C5', name: '自有实验设备独立兼容实现', requiredEvidence: ['CONTROLLED_REPRODUCTION'],
    requirements: ['在自有实验设备中完成可重复的独立兼容实现', '结论可由独立复核且不超出授权范围'],
    allows: ['发布有证据边界的兼容性研究结论'],
    prohibits: ['把单次观察推广为所有硬件版本或提供破解步骤'],
  },
];

const levelOrder: ConsoleLevel[] = ['C0', 'C1', 'C2', 'C3', 'C4', 'C5'];

export function computeConsoleLevel(profile: Pick<ConsoleProfile, 'authorizedDevEnvironments' | 'actualAccess' | 'researchEvidence'>): ConsoleLevel {
  const recordedKinds = new Set(profile.researchEvidence.map((evidence) => evidence.kind));
  const verifiedKinds = new Set(profile.researchEvidence.filter((evidence) => evidence.verification === 'TOOL_VERIFIED').map((evidence) => evidence.kind));
  let proven: ConsoleLevel = 'C0';
  for (const definition of CONSOLE_LEVELS.slice(1)) {
    const kinds = definition.level === 'C1' ? recordedKinds : verifiedKinds;
    if (!definition.requiredEvidence.every((kind) => kinds.has(kind))) break;
    if (definition.level === 'C2' && profile.actualAccess !== 'AUTHORIZED_DEV_INTERFACE') break;
    proven = definition.level;
  }
  return proven;
}

export function getConsoleLevel(level: ConsoleLevel): ConsoleLevelDefinition {
  const definition = CONSOLE_LEVELS.find((entry) => entry.level === level);
  if (!definition) throw new Error(`Unknown console level: ${String(level)}`);
  return definition;
}

export function compareConsoleLevels(left: ConsoleLevel, right: ConsoleLevel): number {
  return levelOrder.indexOf(left) - levelOrder.indexOf(right);
}

export function isConsoleEvidenceKind(value: unknown): value is ConsoleEvidenceKind {
  return ['IDENTITY', 'OFFICIAL_DOCUMENT', 'READ_ONLY_ENUMERATION', 'AUTHORIZED_INTERFACE_OBSERVATION', 'FIRMWARE_SAMPLE', 'AUTHORIZED_DEV_TEST', 'CONTROLLED_REPRODUCTION'].includes(String(value));
}

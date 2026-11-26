import { CONSOLE_LEVELS, getConsoleLevel } from './levels.js';
import { validateConsoleProfile } from './profile.js';
import { getConsoleSupportEntry } from './support.js';
import type { ConsoleDeviceId, ConsoleLevel, ConsoleProfile } from './types.js';

export interface ConsoleReport {
  userView: {
    title: string;
    device: string;
    currentLevel: ConsoleLevel;
    levelName: string;
    evidenceCount: number;
    recordedEvidenceCount: number;
    verifiedEvidenceCount: number;
    summary: string;
    limitations: string[];
    nextSteps: string[];
  };
  professionalView: {
    profile: ConsoleProfile;
    levelRequirements: typeof CONSOLE_LEVELS;
    missingEvidence: string[];
    evidenceBoundaries: string[];
    support?: ReturnType<typeof getConsoleSupportEntry>;
  };
}

function missingEvidence(profile: ConsoleProfile): string[] {
  const recordedKinds = new Set(profile.researchEvidence.map((entry) => entry.kind));
  const verifiedKinds = new Set(profile.researchEvidence.filter((entry) => entry.verification === 'TOOL_VERIFIED').map((entry) => entry.kind));
  const missing: string[] = [];
  for (const definition of CONSOLE_LEVELS.slice(1)) {
    const kinds = definition.level === 'C1' ? recordedKinds : verifiedKinds;
    for (const kind of definition.requiredEvidence) if (!kinds.has(kind)) missing.push(`${definition.level}:${kind}${definition.level === 'C1' ? '' : ':TOOL_VERIFIED'}`);
    if (definition.level === 'C2' && profile.actualAccess !== 'AUTHORIZED_DEV_INTERFACE') missing.push('C2:AUTHORIZED_INTERFACE_ACCESS');
  }
  return missing;
}

function nextSteps(level: ConsoleLevel): string[] {
  switch (level) {
    case 'C0': return ['补充设备型号、硬件版本、系统版本及其来源', '保存至少一份官方资料，避免把用户陈述当作已验证事实'];
    case 'C1': return ['C1 仅表示身份与官方资料已记录；C2 及以上必须由后端验证证据', '在合法授权范围内确认可用的设备接口', '不要根据 USB-C 外形尝试主机对主机连接'];
    case 'C2': return ['分析合法取得并可追溯的固件或自有应用样本', '记录样本 SHA-256 与离线静态分析方法'];
    case 'C3': return ['在官方获批开发环境中完成应用测试或兼容性验证', '保存环境、方法、结果与证据'];
    case 'C4': return ['在自有实验设备中完成可重复的独立兼容实现', '由独立复核者验证结论和硬件版本边界'];
    case 'C5': return ['发布可复核证据时保留授权与版本限制', '不将结论外推到未验证的硬件或系统版本'];
  }
}

/** Builds both audiences' views from validated evidence; a caller-supplied level can never elevate the result. */
export function generateConsoleReport(value: unknown, deviceId?: ConsoleDeviceId): ConsoleReport {
  const profile = validateConsoleProfile(value);
  const level = getConsoleLevel(profile.currentLevel);
  const limitations = [...profile.limitations, '本报告不自动识别设备，不执行设备操作，也不提供解锁、绕过或破解步骤'];
  if (deviceId) limitations.push(...getConsoleSupportEntry(deviceId).limitations);
  return {
    userView: {
      title: '主机研究报告', device: `${profile.manufacturer} ${profile.series} ${profile.model}`,
      currentLevel: level.level, levelName: level.name, evidenceCount: profile.researchEvidence.length,
      recordedEvidenceCount: profile.researchEvidence.filter((entry) => entry.verification !== 'TOOL_VERIFIED').length,
      verifiedEvidenceCount: profile.researchEvidence.filter((entry) => entry.verification === 'TOOL_VERIFIED').length,
      summary: `当前证据支持 ${level.level}（${level.name}）。C1 仅记录身份与官方资料；C2 及以上只计入后端验证证据，用户自述不能提升等级。`,
      limitations, nextSteps: nextSteps(level.level),
    },
    professionalView: {
      profile, levelRequirements: CONSOLE_LEVELS, missingEvidence: missingEvidence(profile),
      evidenceBoundaries: [
        'C0-C5 是证据等级，不是设备价值、权限或可破解程度评级',
        '用户提交的证据固定为 USER_RECORDED；只有可信后端验证的证据 ID 才能保留 TOOL_VERIFIED 并提升至 C2 及以上',
        '操作系统识别和描述符可读仅证明只读枚举，不证明调试能力',
        'USB-C 物理形态不是调试接口证据；不支持普通零售主机对主机连接',
        '官方开发环境必须通过获批计划取得，链接与说明不构成访问授权',
        '固件样本必须合法取得、可追溯并记录 SHA-256；离线分析不等于设备可修改',
        '结论仅适用于证据覆盖的硬件版本、系统版本和授权环境',
      ],
      ...(deviceId ? { support: getConsoleSupportEntry(deviceId) } : {}),
    },
  };
}

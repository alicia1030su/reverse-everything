import type { ConsoleUsbDiagnosis, UsbEnumerationSummary } from './types.js';

const fields = ['osRecognized', 'descriptorReadable', 'normalInterfaceAvailable', 'connectorForm', 'peerType', 'developerModeAuthorized', 'cableCondition'] as const;
const connectorForms = ['USB-A', 'USB-C', 'MICRO_USB', 'OTHER', 'UNKNOWN'];
const peerTypes = ['DEVELOPMENT_CONSOLE', 'RETAIL_CONSOLE', 'ANDROID_TV', 'UNKNOWN'];
const cableConditions = ['INTACT_STANDARD', 'DAMAGED', 'UNKNOWN'];

function validateSummary(value: unknown): UsbEnumerationSummary {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('USB summary must be a plain object');
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) if (!fields.includes(key as typeof fields[number])) throw new Error(`USB summary contains unknown field: ${key}`);
  for (const key of ['osRecognized', 'descriptorReadable', 'normalInterfaceAvailable', 'developerModeAuthorized'] as const) if (typeof raw[key] !== 'boolean') throw new Error(`${key} must be boolean`);
  if (!connectorForms.includes(String(raw.connectorForm))) throw new Error('connectorForm is invalid');
  if (!peerTypes.includes(String(raw.peerType))) throw new Error('peerType is invalid');
  if (!cableConditions.includes(String(raw.cableCondition))) throw new Error('cableCondition is invalid');
  return raw as unknown as UsbEnumerationSummary;
}

/** Diagnoses only a read-only enumeration summary; it never opens a device or recommends a cable modification. */
export function diagnoseConsoleUsb(value: unknown): ConsoleUsbDiagnosis {
  const summary = validateSummary(value);
  const closedRetailConsole = summary.peerType === 'RETAIL_CONSOLE';
  const android = summary.peerType === 'ANDROID_TV';
  const needsOfficialDevEnvironment = closedRetailConsole || summary.peerType === 'UNKNOWN';
  const supportedTopology = summary.peerType === 'DEVELOPMENT_CONSOLE'
    ? summary.normalInterfaceAvailable && summary.developerModeAuthorized
    : android && summary.normalInterfaceAvailable && summary.developerModeAuthorized;
  const hardwareSafetyRisk = closedRetailConsole || summary.cableCondition === 'DAMAGED';
  const findings = [
    summary.osRecognized ? '操作系统已枚举到设备。' : '操作系统未识别设备；不能据此判断内部接口。',
    summary.descriptorReadable ? '描述符可读，仅表示元数据访问成功。' : '描述符不可读或未提供。',
    summary.normalInterfaceAvailable ? '枚举中存在普通接口。' : '没有证据表明存在可用普通接口。',
    'USB-C 物理形态不能作为调试、刷写或主机对主机连接依据。',
  ];
  if (closedRetailConsole) findings.push('不支持普通零售主机对主机连接；应停止连接尝试。');
  if (!supportedTopology) findings.push('当前摘要不足以支持设备操作；仅保留离线研究路径。');
  const nextSteps: string[] = [];
  if (summary.cableCondition === 'DAMAGED') nextSteps.push('停止使用损坏线缆；仅使用设备制造商规定的完好标准线缆。');
  if (closedRetailConsole || summary.peerType === 'UNKNOWN') nextSteps.push('查阅平台官方开发者计划，确认获批开发硬件、软件和授权范围。');
  else if (android && !summary.developerModeAuthorized) nextSteps.push('由设备所有者在官方文档指引下明确启用并授权调试；本工具不执行该操作。');
  else if (!summary.normalInterfaceAvailable) nextSteps.push('向 OEM 或平台官方支持确认该型号是否有受支持的普通接口。');
  nextSteps.push('如有合法取得的固件或应用样本，记录来源与 SHA-256 后转为离线分析。');
  return {
    osRecognized: summary.osRecognized, descriptorReadable: summary.descriptorReadable,
    normalInterfaceAvailable: summary.normalInterfaceAvailable, supportedTopology,
    needsOfficialDevEnvironment, needsOfflineSample: !supportedTopology || !summary.normalInterfaceAvailable,
    hardwareSafetyRisk, findings, nextSteps,
  };
}

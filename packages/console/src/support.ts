import { CONSOLE_DEVICES } from './catalog.js';
import type { ConsoleDeviceId, ConsoleSupportEntry, OfficialDevelopmentEnvironment } from './types.js';

/** Capability matrix describes research routes, not an ability to unlock or operate retail consoles. */
export const CONSOLE_SUPPORT_MATRIX: readonly ConsoleSupportEntry[] = CONSOLE_DEVICES.map((device) => {
  const android = device.id === 'android-tv' || device.id === 'android-tv-box';
  return {
    deviceId: device.id,
    researchSupport: android ? 'DOCUMENTED_STANDARD_INTERFACE' : device.id === 'other-open-embedded' ? 'OEM_DEPENDENT' : 'OFFICIAL_PROGRAM',
    offlineSampleAnalysis: android || device.id === 'other-open-embedded' ? 'DOCUMENTED_STANDARD_INTERFACE' : 'OEM_DEPENDENT',
    officialEnvironment: android ? 'Android SDK、Android Studio 与设备所有者明确授权的 USB 调试' : device.id === 'other-open-embedded' ? '型号对应的开源项目工具链与文档' : '平台获批开发者计划、开发硬件与受保密协议约束的工具',
    officialDocs: device.officialDocs,
    limitations: [...device.limitations],
  };
});

/** Documentation-only guidance. This module never executes device commands. */
export const OFFICIAL_DEVELOPMENT_ENVIRONMENTS: readonly OfficialDevelopmentEnvironment[] = [
  {
    deviceIds: ['ps5', 'ps5-slim', 'ps5-pro', 'ps4'], name: 'PlayStation Partners / DevNet',
    access: '需要 Sony 批准；开发套件、SDK 和文档受计划条款及保密协议约束',
    description: '从官方合作伙伴入口申请，按获批项目获取开发硬件与文档。零售 USB-C 端口不是调试入口。',
    docs: [{ label: 'PlayStation Partners', url: 'https://partners.playstation.net/' }, { label: 'SIE development hardware program', url: 'https://www.sie.com/en/blog/playstation-indies-development-hardware-loan-program' }],
    operationsExecuted: false,
  },
  {
    deviceIds: ['xbox-series-x', 'xbox-series-s', 'xbox-one'], name: 'Microsoft GDK with Xbox Extensions (GDKX)',
    access: 'Xbox 主机目标需要获批计划、相应许可和开发硬件',
    description: '公开 GDK 文档可用于学习；Xbox Extensions 和主机开发工具受许可约束，不能从零售 USB 接口推定可用。',
    docs: [{ label: 'Microsoft Game Development Kit', url: 'https://learn.microsoft.com/en-us/gaming/gdk/' }, { label: 'Xbox One and Series X|S GDK tools', url: 'https://devdocs.xbox.com/tools/tools-console/tools-sdk' }],
    operationsExecuted: false,
  },
  {
    deviceIds: ['android-tv', 'android-tv-box'], name: 'Android SDK / Android Studio TV development',
    access: '设备所有者授权；具体接口受 OEM、系统版本和构建策略限制',
    description: '使用官方 Android TV 开发文档和 SDK。USB 调试需要用户显式启用并授权；本包不执行 ADB 或修改设备。',
    docs: [{ label: 'Create and run a TV app', url: 'https://developer.android.com/training/tv/start/start' }, { label: 'Android TV receiver debugging', url: 'https://developers.google.com/cast/docs/android_tv_receiver/debugging' }, { label: 'Android Debug Bridge', url: 'https://developer.android.com/tools/adb' }],
    operationsExecuted: false,
  },
  {
    deviceIds: ['other-open-embedded'], name: '型号对应的开源项目工具链',
    access: '以具体项目许可证、硬件文档和所有者授权为边界',
    description: '先确认具体型号及公开接口，再使用项目官方文档。未提供资料时不推定支持。',
    docs: [{ label: '用户提供的型号项目文档（无通用官方链接）', url: '' }], operationsExecuted: false,
  },
];

export function getConsoleSupportEntry(deviceId: ConsoleDeviceId): ConsoleSupportEntry {
  const entry = CONSOLE_SUPPORT_MATRIX.find((candidate) => candidate.deviceId === deviceId);
  if (!entry) throw new Error(`Unknown console device: ${String(deviceId)}`);
  return entry;
}

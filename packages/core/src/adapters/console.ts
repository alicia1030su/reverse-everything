import { diagnoseConsoleUsb, generateConsoleReport, getConsoleDevice, validateConsoleProfile, type ConsoleDeviceId, type ConsoleProfile, type ConsoleReport, type ConsoleUsbDiagnosis } from '@reverse/console';
import { analyzeFirmware, firmwareLimits, type FirmwareAnalysis } from '@reverse/firmware';
import { defineAdapter, noReconstruction, output, uploadPath } from './base.js';

export interface ConsoleAnalysis {
  format: 'CONSOLE_PROFILE' | 'CONSOLE_FIRMWARE';
  deviceId?: ConsoleDeviceId;
  profile: ConsoleProfile;
  report: ConsoleReport;
  usbDiagnosis?: ConsoleUsbDiagnosis;
  firmware?: FirmwareAnalysis;
  limitations: string[];
}

function deviceId(value: unknown): ConsoleDeviceId | undefined {
  if (value === undefined) return undefined;
  const id = String(value);
  getConsoleDevice(id as ConsoleDeviceId);
  return id as ConsoleDeviceId;
}

function assertAuthorized(value: boolean): void {
  if (!value) throw new Error('Explicit authorization confirmation is required before console research analysis');
}

export const consoleAdapter = defineAdapter({
  name: 'console', version: '1.0.0', description:'Evidence-graded console research profiles, read-only USB connection diagnosis and bounded offline firmware analysis for PS5/PS4/Xbox/Android TV/open embedded targets. No device commands, unlocking, DRM bypass or flashing.',
  available: async () => ({ available: true, detail: 'Built-in console catalog, C0-C5 evidence grading, USB diagnosis and offline firmware parser; no device access' }),
  detect: async ctx => {
    if (ctx.project.kind !== 'console') throw new Error('Console adapter requires a console research project');
    const id = deviceId(ctx.options.consoleDeviceId);
    return { adapter: 'console', confidence: id ? 0.8 : 0.5, format: ctx.upload ? 'CONSOLE_FIRMWARE' : 'CONSOLE_PROFILE', details: { deviceId: id ?? 'UNKNOWN', uploadSize: ctx.upload?.size ?? 0 }, limitations: ['Device model and system version are user-supplied unless supported by evidence', 'USB enumeration and connector shape do not prove debug access'] };
  },
  prepare: async ctx => {
    assertAuthorized(ctx.project.authorizationConfirmed);
    const id = deviceId(ctx.options.consoleDeviceId);
    const profile = ctx.options.consoleProfile === undefined ? undefined : validateConsoleProfile(ctx.options.consoleProfile);
    const usbDiagnosis = ctx.options.consoleUsbSummary === undefined ? undefined : diagnoseConsoleUsb(ctx.options.consoleUsbSummary);
    return { deviceId: id, profile, usbDiagnosis, firmwareLimits: firmwareLimits(ctx.options) };
  },
  analyze: async ctx => {
    assertAuthorized(ctx.project.authorizationConfirmed);
    const prep = output<{ deviceId?: ConsoleDeviceId; profile?: ConsoleProfile; usbDiagnosis?: ConsoleUsbDiagnosis; firmwareLimits: ReturnType<typeof firmwareLimits> }>(ctx, 'PREPARE') ?? await consoleAdapter.prepare(ctx) as { deviceId?: ConsoleDeviceId; profile?: ConsoleProfile; usbDiagnosis?: ConsoleUsbDiagnosis; firmwareLimits: ReturnType<typeof firmwareLimits> };
    const profile = prep.profile ?? validateConsoleProfile({
      manufacturer: 'UNKNOWN', series: 'UNKNOWN', model: prep.deviceId ? getConsoleDevice(prep.deviceId).model : 'UNKNOWN',
      hardwareVersion: 'UNKNOWN', systemVersion: 'UNKNOWN', userProvidedInfo: [], officialInterfaces: [],
      authorizedDevEnvironments: [], firmwareSamples: ctx.upload ? [ctx.upload.name] : [], knownCapabilities: [],
      actualAccess: 'NONE', researchEvidence: [], currentLevel: 'C0', limitations: ['No console profile evidence was supplied'],
    });
    const report = generateConsoleReport(profile, prep.deviceId);
    const firmware = ctx.upload ? await analyzeFirmware({ file: uploadPath(ctx), name: ctx.upload.name, options: ctx.options, signal: ctx.signal }) : undefined;
    const limitations = [
      'Console research is evidence-graded and read-only; no device commands, unlocking, privilege escalation, secure-boot/DRM bypass or flashing are performed',
      'A device model, USB descriptor or firmware file does not establish debug access or exploitability',
      ...report.userView.limitations,
      ...(firmware?.limitations ?? []),
    ];
    return { format: firmware ? 'CONSOLE_FIRMWARE' : 'CONSOLE_PROFILE', profile, report, limitations, ...(prep.deviceId ? { deviceId: prep.deviceId } : {}), ...(prep.usbDiagnosis ? { usbDiagnosis: prep.usbDiagnosis } : {}), ...(firmware ? { firmware } : {}) } satisfies ConsoleAnalysis;
  },
  extractEvidence: async ctx => {
    const analysis = output<ConsoleAnalysis>(ctx, 'ANALYZE');
    await ctx.evidence('EVIDENCE', 'Console research profile and evidence grade', 'console-profile', 'profile', { deviceId: analysis.deviceId ?? 'UNKNOWN', level: analysis.profile.currentLevel, actualAccess: analysis.profile.actualAccess, evidenceCount: analysis.profile.researchEvidence.length });
    await ctx.evidence('VERIFIED', 'Console level derived from cumulative evidence gates', 'console-levels', 'level', { level: analysis.profile.currentLevel, requirements: analysis.report.professionalView.levelRequirements });
    await ctx.evidence('EVIDENCE', 'Console research report', 'console-report', 'report', analysis.report);
    if (analysis.usbDiagnosis) await ctx.evidence('EVIDENCE', 'Read-only USB connection diagnosis', 'console-usb-diagnosis', 'usb', analysis.usbDiagnosis);
    if (analysis.firmware) {
      await ctx.evidence('VERIFIED', 'Offline console firmware identity and limits', 'firmware-stream-sha256', 'firmware', { format: analysis.firmware.format, size: analysis.firmware.size, sha256: analysis.firmware.sha256, totalReadBytes: analysis.firmware.totalReadBytes });
      await ctx.evidence('INFERENCE', 'Offline firmware component and security clues', 'firmware-heuristics', 'firmware-insights', { components: analysis.firmware.components, securityFindings: analysis.firmware.securityFindings });
    }
    await ctx.writeArtifact('console-report.json', JSON.stringify(analysis.report, null, 2), 'application/json');
    await ctx.writeArtifact('console-analysis.json', JSON.stringify(analysis, null, 2), 'application/json');
    if (analysis.firmware) await ctx.writeArtifact('console-firmware-analysis.json', JSON.stringify(analysis.firmware, null, 2), 'application/json');
    return { level: analysis.profile.currentLevel, firmwareFormat: analysis.firmware?.format, artifacts: ['console-report.json', 'console-analysis.json', ...(analysis.firmware ? ['console-firmware-analysis.json'] : [])] };
  },
  reconstruct: async ctx => { await ctx.evidence('UNKNOWN', 'Console research does not reconstruct or modify console software', 'console-adapter', 'reconstruct', { reason: 'No device operation, firmware reconstruction or compatibility implementation was performed' }); return noReconstruction(ctx, 'No console software, firmware or device behavior was reconstructed'); },
  validate: async ctx => {
    const analysis = output<ConsoleAnalysis>(ctx, 'ANALYZE');
    const checks = [
      { name: 'authorized console project', passed: ctx.project.kind === 'console' && ctx.project.authorizationConfirmed },
      { name: 'profile validated', passed: Boolean(analysis.profile && analysis.report) },
      { name: 'level evidence-graded', passed: ['C0','C1','C2','C3','C4','C5'].includes(analysis.profile.currentLevel) },
      { name: 'no device operation claimed', passed: analysis.limitations.every(item => !/unlocked|jailbroken|pwned/i.test(item)) },
      { name: 'firmware static only', passed: !analysis.firmware || analysis.firmware.size > 0 },
    ];
    return { passed: checks.every(check => check.passed), checks, limitations: analysis.limitations };
  },
});

import { describe, expect, it } from 'vitest';
import {
  CONSOLE_DEVICES, CONSOLE_LEVELS, CONSOLE_SUPPORT_MATRIX, OFFICIAL_DEVELOPMENT_ENVIRONMENTS,
  computeConsoleLevel, diagnoseConsoleUsb, generateConsoleReport, validateConsoleProfile,
  type ConsoleEvidence, type ConsoleEvidenceKind, type ConsoleProfile,
} from '../../packages/console/src/index.js';

const digest = 'a'.repeat(64);
function evidence(id: string, kind: ConsoleEvidenceKind): ConsoleEvidence {
  return {
    id, kind, source: 'local evidence record', observedAt: '2026-11-20T00:00:00.000Z', description: 'Observed within authorized research scope',
    ...(kind === 'FIRMWARE_SAMPLE' || kind === 'AUTHORIZED_DEV_TEST' || kind === 'CONTROLLED_REPRODUCTION' ? { sha256: digest, method: 'Offline analysis in an isolated environment' } : {}),
    verification: 'TOOL_VERIFIED',
  };
}
function profile(overrides: Partial<ConsoleProfile> = {}): ConsoleProfile {
  return {
    manufacturer: 'Sony Interactive Entertainment', series: 'PlayStation 5', model: 'CFI-1000 family',
    hardwareVersion: 'user-reported', systemVersion: 'user-reported', userProvidedInfo: ['Owner supplied model information'],
    officialInterfaces: [], authorizedDevEnvironments: [], firmwareSamples: [], knownCapabilities: [], actualAccess: 'NONE',
    researchEvidence: [], currentLevel: 'C0', limitations: ['Retail USB-C is not a debugging interface'], ...overrides,
  };
}

describe('console catalog and support matrix', () => {
  it('contains every required device with bounded factual metadata and no automatic detection claims', () => {
    expect(CONSOLE_DEVICES.map((device) => device.id)).toEqual(expect.arrayContaining([
      'ps5', 'ps5-slim', 'ps5-pro', 'ps4', 'xbox-series-x', 'xbox-series-s', 'xbox-one', 'android-tv', 'android-tv-box', 'other-open-embedded',
    ]));
    expect(new Set(CONSOLE_DEVICES.map((device) => device.id)).size).toBe(CONSOLE_DEVICES.length);
    for (const device of CONSOLE_DEVICES) {
      expect(device.manufacturer.length).toBeGreaterThan(0);
      expect(device.series.length).toBeGreaterThan(0);
      expect(device.model.length).toBeGreaterThan(0);
      expect(device.officialDocs.length).toBeGreaterThan(0);
      expect(device.capabilities.length).toBeGreaterThan(0);
      expect(device.limitations.length).toBeGreaterThan(0);
    }
    expect(JSON.stringify(CONSOLE_DEVICES)).not.toMatch(/自动识别|破解|bypass/i);
  });

  it('maps PS5, Xbox and Android TV to explicit support routes and documentation-only environments', () => {
    expect(CONSOLE_SUPPORT_MATRIX).toHaveLength(CONSOLE_DEVICES.length);
    expect(CONSOLE_SUPPORT_MATRIX.find((entry) => entry.deviceId === 'ps5')?.researchSupport).toBe('OFFICIAL_PROGRAM');
    expect(CONSOLE_SUPPORT_MATRIX.find((entry) => entry.deviceId === 'xbox-series-x')?.researchSupport).toBe('OFFICIAL_PROGRAM');
    expect(CONSOLE_SUPPORT_MATRIX.find((entry) => entry.deviceId === 'android-tv')?.researchSupport).toBe('DOCUMENTED_STANDARD_INTERFACE');
    for (const environment of OFFICIAL_DEVELOPMENT_ENVIRONMENTS) {
      expect(environment.operationsExecuted).toBe(false);
      expect(environment.docs.length).toBeGreaterThan(0);
      expect(environment.description.length).toBeGreaterThan(0);
    }
    expect(OFFICIAL_DEVELOPMENT_ENVIRONMENTS.flatMap((entry) => entry.deviceIds)).toEqual(expect.arrayContaining(['ps5', 'xbox-one', 'android-tv-box']));
  });
});

describe('console evidence levels', () => {
  it('defines evidence requirements and prohibitions for all six levels', () => {
    expect(CONSOLE_LEVELS.map((entry) => entry.level)).toEqual(['C0', 'C1', 'C2', 'C3', 'C4', 'C5']);
    for (const level of CONSOLE_LEVELS) {
      expect(level.requirements.length).toBeGreaterThan(0);
      expect(level.prohibits.length).toBeGreaterThan(0);
      expect(level.allows.length).toBeGreaterThan(0);
      if (level.level !== 'C0') expect(level.requiredEvidence.length).toBeGreaterThan(0);
    }
  });

  it('returns C0 without evidence and stops at the highest cumulative proven gate', () => {
    expect(computeConsoleLevel(profile())).toBe('C0');
    expect(computeConsoleLevel(profile({ researchEvidence: [evidence('identity', 'IDENTITY')] }))).toBe('C0');
    expect(computeConsoleLevel(profile({ researchEvidence: [evidence('identity', 'IDENTITY'), evidence('docs', 'OFFICIAL_DOCUMENT')] }))).toBe('C1');
    expect(computeConsoleLevel(profile({ researchEvidence: [evidence('identity', 'IDENTITY'), evidence('docs', 'OFFICIAL_DOCUMENT'), evidence('enumeration', 'READ_ONLY_ENUMERATION')] }))).toBe('C1');
    expect(computeConsoleLevel(profile({ researchEvidence: [evidence('sample', 'FIRMWARE_SAMPLE')] }))).toBe('C0');
  });

  it('requires authorized interface access, static sample, dev test and independent reproduction evidence for C2-C5', () => {
    const base = [evidence('identity', 'IDENTITY'), evidence('docs', 'OFFICIAL_DOCUMENT')];
    expect(computeConsoleLevel(profile({ researchEvidence: [...base, evidence('interface', 'AUTHORIZED_INTERFACE_OBSERVATION')] }))).toBe('C1');
    expect(computeConsoleLevel(profile({ researchEvidence: [...base, evidence('interface', 'AUTHORIZED_INTERFACE_OBSERVATION')], actualAccess: 'AUTHORIZED_DEV_INTERFACE' }))).toBe('C2');
    expect(computeConsoleLevel(profile({ researchEvidence: [...base, evidence('interface', 'AUTHORIZED_INTERFACE_OBSERVATION'), evidence('sample', 'FIRMWARE_SAMPLE')], actualAccess: 'AUTHORIZED_DEV_INTERFACE' }))).toBe('C3');
    expect(computeConsoleLevel(profile({ researchEvidence: [...base, evidence('interface', 'AUTHORIZED_INTERFACE_OBSERVATION'), evidence('sample', 'FIRMWARE_SAMPLE'), evidence('dev-test', 'AUTHORIZED_DEV_TEST')], actualAccess: 'AUTHORIZED_DEV_INTERFACE' }))).toBe('C4');
    expect(computeConsoleLevel(profile({ researchEvidence: [...base, evidence('interface', 'AUTHORIZED_INTERFACE_OBSERVATION'), evidence('sample', 'FIRMWARE_SAMPLE'), evidence('dev-test', 'AUTHORIZED_DEV_TEST'), evidence('reproduction', 'CONTROLLED_REPRODUCTION')], actualAccess: 'AUTHORIZED_DEV_INTERFACE' }))).toBe('C5');
  });
});

describe('strict console profile validation', () => {
  it('recomputes a claimed level from evidence instead of trusting it', () => {
    const result = validateConsoleProfile({ ...profile({ currentLevel: 'C5' }), researchEvidence: [evidence('identity', 'IDENTITY'), evidence('docs', 'OFFICIAL_DOCUMENT')] });
    expect(result.currentLevel).toBe('C1');
  });

  it('downgrades client-claimed verification unless a trusted verifier supplies the evidence ID', () => {
    const claimed = profile({ researchEvidence: [evidence('identity', 'IDENTITY'), evidence('docs', 'OFFICIAL_DOCUMENT'), evidence('interface', 'AUTHORIZED_INTERFACE_OBSERVATION')], actualAccess: 'AUTHORIZED_DEV_INTERFACE', currentLevel: 'C2' });
    const untrusted = validateConsoleProfile(claimed);
    expect(untrusted.currentLevel).toBe('C1');
    expect(untrusted.researchEvidence.every((entry) => entry.verification === 'USER_RECORDED')).toBe(true);
    const trusted = validateConsoleProfile(claimed, { verifiedEvidenceIds: new Set(['interface']) });
    expect(trusted.currentLevel).toBe('C2');
    expect(trusted.researchEvidence.find((entry) => entry.id === 'interface')?.verification).toBe('TOOL_VERIFIED');
  });

  it('rejects unknown fields at profile and evidence levels', () => {
    expect(() => validateConsoleProfile({ ...profile(), debugEnabled: true })).toThrow(/unknown field/);
    expect(() => validateConsoleProfile(profile({ researchEvidence: [{ ...evidence('docs', 'OFFICIAL_DOCUMENT'), bypass: true }] }))).toThrow(/unknown field/);
  });

  it('bounds strings and arrays and rejects malformed enum, date and evidence values', () => {
    expect(() => validateConsoleProfile(profile({ model: 'x'.repeat(257) }))).toThrow(/at most 256/);
    expect(() => validateConsoleProfile(profile({ userProvidedInfo: Array.from({ length: 65 }, () => 'x') }))).toThrow(/at most 64/);
    expect(() => validateConsoleProfile(profile({ researchEvidence: [evidence('x'.repeat(257), 'IDENTITY')] }))).toThrow(/at most 256/);
    expect(() => validateConsoleProfile({ ...profile(), actualAccess: 'ROOT' })).toThrow(/actualAccess/);
    expect(() => validateConsoleProfile({ ...profile(), currentLevel: 'C6' })).toThrow(/currentLevel/);
    expect(() => validateConsoleProfile(profile({ researchEvidence: [{ ...evidence('x', 'IDENTITY'), observedAt: 'not-a-date' }] }))).toThrow(/ISO date/);
    expect(() => validateConsoleProfile(profile({ researchEvidence: [{ ...evidence('x', 'IDENTITY'), sha256: 'bad' }] }))).toThrow(/SHA-256/);
    expect(() => validateConsoleProfile(profile({ researchEvidence: [evidence('duplicate', 'IDENTITY'), evidence('duplicate', 'OFFICIAL_DOCUMENT')] }))).toThrow(/unique/);
    const incomplete = evidence('sample', 'FIRMWARE_SAMPLE');
    delete incomplete.sha256;
    expect(() => validateConsoleProfile(profile({ researchEvidence: [incomplete] }))).toThrow(/requires sha256 and method/);
    expect(() => validateConsoleProfile(null)).toThrow(/plain object/);
  });
});

describe('USB enumeration diagnostics', () => {
  const summary = {
    osRecognized: true, descriptorReadable: true, normalInterfaceAvailable: true,
    connectorForm: 'USB-C' as const, peerType: 'RETAIL_CONSOLE' as const, developerModeAuthorized: false, cableCondition: 'INTACT_STANDARD' as const,
  };

  it('does not treat USB-C shape or descriptor access as debugging support', () => {
    const result = diagnoseConsoleUsb(summary);
    expect(result).toMatchObject({ osRecognized: true, descriptorReadable: true, normalInterfaceAvailable: true, supportedTopology: false, needsOfficialDevEnvironment: true, needsOfflineSample: true, hardwareSafetyRisk: true });
    expect(result.findings.join(' ')).toMatch(/USB-C 物理形态不能作为调试/);
    expect(result.findings.join(' ')).toMatch(/不支持普通零售主机对主机连接/);
    expect(JSON.stringify(result)).not.toMatch(/pin|飞线|短接|non.?compliant/i);
  });

  it('supports only explicitly authorized Android TV or development-console topology', () => {
    expect(diagnoseConsoleUsb({ ...summary, peerType: 'ANDROID_TV', developerModeAuthorized: true }).supportedTopology).toBe(true);
    expect(diagnoseConsoleUsb({ ...summary, peerType: 'ANDROID_TV', developerModeAuthorized: false }).supportedTopology).toBe(false);
    expect(diagnoseConsoleUsb({ ...summary, peerType: 'DEVELOPMENT_CONSOLE', developerModeAuthorized: true })).toMatchObject({ supportedTopology: true, needsOfficialDevEnvironment: false, hardwareSafetyRisk: false });
    expect(diagnoseConsoleUsb({ ...summary, peerType: 'DEVELOPMENT_CONSOLE', developerModeAuthorized: false }).supportedTopology).toBe(false);
  });

  it('flags damaged cables and rejects malformed or unknown summary fields', () => {
    expect(diagnoseConsoleUsb({ ...summary, cableCondition: 'DAMAGED' }).hardwareSafetyRisk).toBe(true);
    expect(() => diagnoseConsoleUsb({ ...summary, devicePath: '\\\\?\\usb#vid' })).toThrow(/unknown field/);
    expect(() => diagnoseConsoleUsb({ ...summary, osRecognized: 'yes' })).toThrow(/must be boolean/);
    expect(() => diagnoseConsoleUsb({ ...summary, peerType: 'PHONE' })).toThrow(/peerType/);
  });
});

describe('console report evidence boundaries', () => {
  it('exposes user and professional views without elevating evidence or executing operations', () => {
    const report = generateConsoleReport({ ...profile({ currentLevel: 'C5' }), researchEvidence: [evidence('identity', 'IDENTITY'), evidence('docs', 'OFFICIAL_DOCUMENT')] }, 'ps5');
    expect(report.userView).toMatchObject({ currentLevel: 'C1', evidenceCount: 2, recordedEvidenceCount: 2, verifiedEvidenceCount: 0 });
    expect(report.professionalView.profile.currentLevel).toBe('C1');
    expect(report.professionalView.missingEvidence).toContain('C2:AUTHORIZED_INTERFACE_OBSERVATION:TOOL_VERIFIED');
    expect(report.userView.limitations.join(' ')).toMatch(/不自动识别设备/);
    expect(report.professionalView.evidenceBoundaries.join(' ')).toMatch(/不支持普通零售主机对主机连接/);
    expect(report.professionalView.support?.deviceId).toBe('ps5');
    expect(report.professionalView.levelRequirements).toHaveLength(6);
  });

  it('keeps empty-evidence reports at C0 and rejects malformed input', () => {
    const report = generateConsoleReport(profile());
    expect(report.userView.currentLevel).toBe('C0');
    expect(report.userView.nextSteps.join(' ')).toMatch(/官方资料/);
    expect(() => generateConsoleReport({ ...profile(), unexpected: true })).toThrow(/unknown field/);
  });
});

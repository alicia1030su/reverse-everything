import type { AnalyzerCapability, AnalyzerId, AnalyzerSelection, TargetDetection, TargetKind } from './types.js';

export const ANALYZER_IDS: readonly AnalyzerId[] = ['ghidra', 'jadx', 'firmware', 'usb', 'network', 'website', 'android', 'game', 'security', 'file'];

interface AnalyzerProfile {
  targets: TargetKind[];
  required: boolean;
  reason: string;
  official: string;
  safeAlternative: string;
}

const PROFILES: Record<AnalyzerId, AnalyzerProfile> = {
  ghidra: { targets: ['PE', 'ELF', 'DEX', 'FIRMWARE'], required: true, reason: 'Static disassembly and decompilation capability is unavailable', official: 'https://ghidra-sre.org/', safeAlternative: 'Use bounded header/string inspection with the built-in file analyzer' },
  jadx: { targets: ['APK', 'DEX'], required: true, reason: 'APK/DEX decompilation capability is unavailable', official: 'https://github.com/skylot/jadx', safeAlternative: 'Use bounded ZIP metadata and DEX header inspection without executing the sample' },
  firmware: { targets: ['FIRMWARE', 'UF2', 'INTEL_HEX'], required: true, reason: 'Firmware extraction capability is unavailable', official: 'https://github.com/ReFirmLabs/binwalk', safeAlternative: 'Use bounded entropy and signature inspection with the built-in file analyzer' },
  usb: { targets: ['PCAP', 'PCAPNG'], required: true, reason: 'USB capture analysis capability is unavailable', official: 'https://www.wireshark.org/', safeAlternative: 'Use bounded capture metadata inspection with the built-in file analyzer' },
  network: { targets: ['HAR', 'PCAP', 'PCAPNG'], required: true, reason: 'Network capture analysis capability is unavailable', official: 'https://www.wireshark.org/', safeAlternative: 'Use offline request metadata and protocol summary inspection only' },
  website: { targets: ['HAR', 'UNKNOWN'], required: false, reason: 'Website replay capability is unavailable', official: 'https://playwright.dev/', safeAlternative: 'Review HAR request/response metadata offline without network replay' },
  android: { targets: ['APK', 'DEX'], required: false, reason: 'Android platform analysis capability is unavailable', official: 'https://developer.android.com/studio', safeAlternative: 'Use offline APK/DEX static analysis only' },
  game: { targets: ['PE', 'ELF', 'FIRMWARE'], required: false, reason: 'Game-specific analysis capability is unavailable', official: 'https://ghidra-sre.org/', safeAlternative: 'Use general static analysis with Ghidra or the built-in file analyzer' },
  security: { targets: ['PE', 'ELF', 'APK', 'DEX', 'FIRMWARE', 'ZIP'], required: false, reason: 'Security scanner capability is unavailable', official: 'https://semgrep.dev/', safeAlternative: 'Use bounded static signature inspection; do not execute untrusted content' },
  file: { targets: ['HAR', 'PCAP', 'PCAPNG', 'APK', 'DEX', 'PE', 'ELF', 'UF2', 'INTEL_HEX', 'ZIP', 'FIRMWARE', 'UNKNOWN'], required: false, reason: 'Generic file inspection capability is unavailable', official: 'https://github.com/oaldersai/ripgrep', safeAlternative: 'Use read-only bounded hex and header inspection' },
};

export function requiredAnalyzers(target: TargetDetection): AnalyzerId[] {
  return ANALYZER_IDS.filter(id => PROFILES[id].targets.includes(target.kind));
}

/** Selection reflects supplied capability truth only; installation guidance never implies availability. */
export function selectAnalyzers(target: TargetDetection, capabilities: AnalyzerCapability[]): AnalyzerSelection[] {
  const supplied = new Map(capabilities.map(capability => [capability.id, capability]));
  return ANALYZER_IDS.filter(id => PROFILES[id].targets.includes(target.kind)).map(id => {
    const capability = supplied.get(id);
    const profile = PROFILES[id];
    const available = capability?.available === true && capability.detail.trim().length > 0;
    return {
      id,
      available,
      required: profile.required,
      silentSkip: false,
      ...(capability?.version ? { version: capability.version } : {}),
      detail: capability?.detail ?? 'No capability probe result supplied',
      ...(!available ? { guidance: { reason: capability?.detail || profile.reason, official: profile.official, safeAlternative: profile.safeAlternative } } : {}),
    };
  });
}

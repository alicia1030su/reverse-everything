import type { DetectionSignal, EvidenceLevel, TargetDetection, TargetKind } from './types.js';

export interface DetectTargetInput {
  bytes: Uint8Array;
  fileName?: string;
  declaredKind?: TargetKind;
  maxBytes?: number;
}

const MAGIC_KINDS: Array<{ kind: TargetKind; matches: (bytes: Uint8Array) => boolean; detail: string }> = [
  { kind: 'PCAPNG', matches: b => b.length >= 12 && b[0] === 0x0a && b[1] === 0x0d && b[2] === 0x0d && b[3] === 0x0a, detail: 'PCAPNG Section Header Block magic' },
  { kind: 'UF2', matches: b => b.length >= 8 && b[0] === 0x55 && b[1] === 0x46 && b[2] === 0x32 && b[3] === 0x0a && b[4] === 0x30 && b[5] === 0x16 && b[6] === 0x9e && b[7] === 0x5d, detail: 'UF2 block magic' },
  { kind: 'PE', matches: b => { if (b.length < 64 || b[0] !== 0x4d || b[1] !== 0x5a) return false; const offset = b[0x3c]! | b[0x3d]! << 8 | b[0x3e]! << 16 | b[0x3f]! << 24; return offset >= 0 && offset + 4 <= b.length && b[offset] === 0x50 && b[offset + 1] === 0x45 && b[offset + 2] === 0 && b[offset + 3] === 0; }, detail: 'DOS header and PE signature' },
  { kind: 'ELF', matches: b => b.length >= 4 && b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46, detail: 'ELF magic' },
  { kind: 'DEX', matches: b => b.length >= 8 && b.subarray(0, 4).every((v, i) => v === [0x64, 0x65, 0x78, 0x0a][i]) && b[7] === 0, detail: 'DEX version magic' },
  { kind: 'ZIP', matches: b => b.length >= 4 && ((b[0] === 0x50 && b[1] === 0x4b && b[2] === 3 && b[3] === 4) || (b[0] === 0x50 && b[1] === 0x4b && b[2] === 5 && b[3] === 6)), detail: 'ZIP local-file or end-of-directory magic' },
  { kind: 'PCAP', matches: b => b.length >= 24 && ((b[0] === 0xd4 && b[1] === 0xc3 && b[2] === 0xb2 && b[3] === 0xa1) || (b[0] === 0xa1 && b[1] === 0xb2 && b[2] === 0xc3 && b[3] === 0xd4) || (b[0] === 0x4d && b[1] === 0x3c && b[2] === 0xb2 && b[3] === 0xa1) || (b[0] === 0xa1 && b[1] === 0xb2 && b[2] === 0x3c && b[3] === 0x4d)), detail: 'Classic PCAP micro/nanosecond magic' },
];

function extensionKind(fileName: string | undefined): { extension: string; kind: TargetKind } | undefined {
  if (!fileName) return undefined;
  const extension = fileName.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (!extension) return undefined;
  const kinds: Record<string, TargetKind> = { har: 'HAR', pcap: 'PCAP', pcapng: 'PCAPNG', apk: 'APK', dex: 'DEX', exe: 'PE', dll: 'PE', elf: 'ELF', bin: 'FIRMWARE', uf2: 'UF2', hex: 'INTEL_HEX', ihex: 'INTEL_HEX', zip: 'ZIP' };
  const kind = kinds[extension];
  return kind ? { extension, kind } : { extension, kind: 'UNKNOWN' };
}

function detectIntelHex(bytes: Uint8Array): boolean {
  if (bytes.length === 0 || bytes.length > 16 * 1024 * 1024) return false;
  let text = '';
  for (const byte of bytes) { if (byte > 0x7f) return false; text += String.fromCharCode(byte); }
  const records = text.split(/\r?\n/).filter(line => line.trim().length > 0);
  return records.length > 0 && records.every(line => /^:[0-9a-fA-F]+$/.test(line) && line.length >= 11 && (line.length - 1) % 2 === 0);
}

function detectHar(bytes: Uint8Array): boolean {
  if (bytes.length > 16 * 1024 * 1024 || bytes[0] !== 0x7b) return false;
  try {
    const value = JSON.parse(Buffer.from(bytes).toString('utf8')) as { log?: { version?: unknown; entries?: unknown } };
    return !!value.log && typeof value.log.version === 'string' && Array.isArray(value.log.entries);
  } catch { return false; }
}

function inferKind(signals: DetectionSignal[], declaration: TargetKind | undefined): { kind: TargetKind; level: EvidenceLevel; confidence: number } {
  const magic = signals.find(signal => (signal.source === 'magic' || signal.source === 'content') && signal.level === 'EVIDENCE');
  if (magic) {
    const kind: TargetKind = magic.detail.startsWith('PCAPNG') ? 'PCAPNG' : magic.detail.startsWith('UF2') ? 'UF2' : magic.detail.startsWith('DOS') ? 'PE' : magic.detail.startsWith('ELF') ? 'ELF' : magic.detail.startsWith('DEX') ? 'DEX' : magic.detail.startsWith('ZIP') ? 'ZIP' : magic.detail.startsWith('HAR') ? 'HAR' : magic.detail.startsWith('INTEL_HEX') ? 'INTEL_HEX' : 'PCAP';
    if (kind === 'ZIP') {
      const extension = signals.find(signal => signal.source === 'extension');
      const apk = extension?.detail.endsWith('.apk') || declaration === 'APK';
      return apk ? { kind: 'APK', level: 'INFERENCE', confidence: 0.72 } : { kind: 'ZIP', level: 'EVIDENCE', confidence: 0.9 };
    }
    return { kind, level: 'EVIDENCE', confidence: 0.98 };
  }
  const inferred = signals.find(signal => signal.level === 'INFERENCE');
  if (inferred?.source === 'content') return { kind: inferred.detail as TargetKind, level: 'INFERENCE', confidence: 0.7 };
  if (declaration && declaration !== 'UNKNOWN') return { kind: declaration, level: 'INFERENCE', confidence: 0.35 };
  return { kind: 'UNKNOWN', level: 'UNKNOWN', confidence: 0 };
}

/** File names and declarations are hints; only validated magic/content signals are evidence. */
export function detectTarget(input: DetectTargetInput): TargetDetection {
  const bytes = input.bytes.subarray(0, Math.max(0, input.maxBytes ?? 1024 * 1024));
  const signals: DetectionSignal[] = [{ level: 'UNKNOWN', source: 'size', detail: `${input.bytes.length} bytes; size alone cannot establish format` }];
  for (const candidate of MAGIC_KINDS) {
    if (candidate.matches(bytes)) signals.push({ level: 'EVIDENCE', source: 'magic', detail: candidate.detail });
  }
  if (detectIntelHex(bytes)) signals.push({ level: 'EVIDENCE', source: 'content', detail: 'INTEL_HEX records with valid textual shape' });
  if (detectHar(bytes)) signals.push({ level: 'EVIDENCE', source: 'content', detail: 'HAR log object with version and entries' });
  const extension = extensionKind(input.fileName);
  if (extension) signals.push({ level: 'INFERENCE', source: 'extension', detail: `.${extension.extension}` });
  if (input.declaredKind && input.declaredKind !== 'UNKNOWN') signals.push({ level: 'INFERENCE', source: 'declaration', detail: input.declaredKind });
  const result = inferKind(signals, input.declaredKind);
  if (result.kind === 'UNKNOWN') {
    const hint = extension?.kind ?? input.declaredKind;
    if (hint && hint !== 'UNKNOWN') {
      signals.push({ level: 'INFERENCE', source: input.declaredKind ? 'declaration' : 'extension', detail: hint });
      return { ...result, kind: hint, level: 'INFERENCE', confidence: 0.35, signals, size: input.bytes.length, limitations: ['Filename extensions and user declarations are not treated as file-format evidence'] };
    }
  }
  const limitations = ['Filename extensions and user declarations are not treated as file-format evidence'];
  if (bytes.length < input.bytes.length) limitations.push('Detection inspected only the bounded byte prefix');
  return { ...result, size: input.bytes.length, signals, limitations };
}

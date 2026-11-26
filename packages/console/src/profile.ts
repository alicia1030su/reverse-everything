import { computeConsoleLevel, isConsoleEvidenceKind } from './levels.js';
import type { ActualAccess, ConsoleEvidence, ConsoleEvidenceVerification, ConsoleLevel, ConsoleProfile } from './types.js';

const fields = ['manufacturer', 'series', 'model', 'hardwareVersion', 'systemVersion', 'userProvidedInfo', 'officialInterfaces', 'authorizedDevEnvironments', 'firmwareSamples', 'knownCapabilities', 'actualAccess', 'researchEvidence', 'currentLevel', 'limitations'] as const;
const evidenceFields = ['id', 'kind', 'source', 'observedAt', 'description', 'sha256', 'method', 'verification'] as const;
const verifications: ConsoleEvidenceVerification[] = ['USER_RECORDED', 'TOOL_VERIFIED'];
const levels: ConsoleLevel[] = ['C0', 'C1', 'C2', 'C3', 'C4', 'C5'];
const accesses: ActualAccess[] = ['NONE', 'READ_ONLY', 'AUTHORIZED_DEV_INTERFACE'];
const limits = { string: 256, item: 1024, array: 64, evidence: 128 } as const;

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(`${label} must be a plain object`);
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${label} contains unknown field: ${key}`);
}

function text(value: unknown, label: string, max: number = limits.string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) throw new Error(`${label} must be a non-empty string of at most ${max} characters`);
  return value;
}

function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > limits.array) throw new Error(`${label} must be an array of at most ${limits.array} entries`);
  return value.map((entry, index) => text(entry, `${label}[${index}]`, limits.item));
}

function evidence(value: unknown, index: number, verifiedEvidenceIds: ReadonlySet<string>): ConsoleEvidence {
  const label = `researchEvidence[${index}]`, raw = object(value, label);
  keys(raw, evidenceFields, label);
  const kind = raw.kind;
  if (!isConsoleEvidenceKind(kind)) throw new Error(`${label}.kind is invalid`);
  if (raw.verification !== undefined && !verifications.includes(raw.verification as ConsoleEvidenceVerification)) throw new Error(`${label}.verification is invalid`);
  const observedAt = text(raw.observedAt, `${label}.observedAt`, 64);
  if (!Number.isFinite(Date.parse(observedAt))) throw new Error(`${label}.observedAt must be an ISO date`);
  const result: ConsoleEvidence = {
    id: text(raw.id, `${label}.id`), kind,
    source: text(raw.source, `${label}.source`, limits.item),
    observedAt, description: text(raw.description, `${label}.description`, limits.item),
  };
  if (raw.sha256 !== undefined) {
    const sha256 = text(raw.sha256, `${label}.sha256`, 64);
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error(`${label}.sha256 must be a lowercase SHA-256 digest`);
    result.sha256 = sha256;
  }
  if (raw.method !== undefined) result.method = text(raw.method, `${label}.method`, limits.item);
  result.verification = raw.verification === 'TOOL_VERIFIED' && verifiedEvidenceIds.has(result.id) ? 'TOOL_VERIFIED' : 'USER_RECORDED';
  if ((kind === 'FIRMWARE_SAMPLE' || kind === 'AUTHORIZED_DEV_TEST' || kind === 'CONTROLLED_REPRODUCTION') && (!result.sha256 || !result.method)) throw new Error(`${label} requires sha256 and method`);
  return result;
}

export interface ConsoleProfileValidationOptions {
  /** Only a trusted backend verifier may supply IDs whose TOOL_VERIFIED status is preserved. */
  verifiedEvidenceIds?: ReadonlySet<string>;
}

/** Strictly validates untrusted profiles and returns a bounded copy with the evidence-derived level. */
export function validateConsoleProfile(value: unknown, options: ConsoleProfileValidationOptions = {}): ConsoleProfile {
  const raw = object(value, 'ConsoleProfile');
  keys(raw, fields, 'ConsoleProfile');
  for (const key of ['manufacturer', 'series', 'model', 'hardwareVersion', 'systemVersion'] as const) text(raw[key], key);
  if (!accesses.includes(raw.actualAccess as ActualAccess)) throw new Error('actualAccess is invalid');
  if (!levels.includes(raw.currentLevel as ConsoleLevel)) throw new Error('currentLevel is invalid');
  if (!Array.isArray(raw.researchEvidence) || raw.researchEvidence.length > limits.evidence) throw new Error(`researchEvidence must be an array of at most ${limits.evidence} entries`);
  const researchEvidence = raw.researchEvidence.map((entry, index) => evidence(entry, index, options.verifiedEvidenceIds ?? new Set<string>()));
  if (new Set(researchEvidence.map((entry) => entry.id)).size !== researchEvidence.length) throw new Error('researchEvidence ids must be unique');
  const profile: ConsoleProfile = {
    manufacturer: text(raw.manufacturer, 'manufacturer'), series: text(raw.series, 'series'), model: text(raw.model, 'model'),
    hardwareVersion: text(raw.hardwareVersion, 'hardwareVersion'), systemVersion: text(raw.systemVersion, 'systemVersion'),
    userProvidedInfo: strings(raw.userProvidedInfo, 'userProvidedInfo'), officialInterfaces: strings(raw.officialInterfaces, 'officialInterfaces'),
    authorizedDevEnvironments: strings(raw.authorizedDevEnvironments, 'authorizedDevEnvironments'),
    firmwareSamples: strings(raw.firmwareSamples, 'firmwareSamples'), knownCapabilities: strings(raw.knownCapabilities, 'knownCapabilities'),
    actualAccess: raw.actualAccess as ActualAccess, researchEvidence, currentLevel: 'C0',
    limitations: strings(raw.limitations, 'limitations'),
  };
  profile.currentLevel = computeConsoleLevel(profile);
  return profile;
}

import type { EvidenceKind, ProgramIr } from '@reverse/program-ir';

export type BinaryDiffStatus = 'PASSED' | 'PARTIAL' | 'FAILED';
export type FunctionMatchMethod = 'exact-fingerprint' | 'unique-name' | 'similarity';

export interface BinaryDiffOptions {
  maxFunctions?: number;
  minSimilarity?: number;
  maxChanges?: number;
}

export interface BinaryIdentity {
  id: string;
  format: string;
  architecture: string;
  inputSha256: string | null;
  analyzer: string | null;
  analyzerVersion: string | null;
}

export interface ByteRangeDiff {
  offset: number;
  length: number;
  beforeHex: string;
  afterHex: string;
}

export interface BinaryByteDiffReport {
  schemaVersion: 1;
  status: BinaryDiffStatus;
  beforeSize: number;
  afterSize: number;
  beforeSha256: string;
  afterSha256: string;
  identical: boolean;
  commonPrefixBytes: number;
  commonSuffixBytes: number;
  changedBytes: number;
  changedRanges: ByteRangeDiff[];
  entropyBefore: number;
  entropyAfter: number;
  truncated: boolean;
  limitations: string[];
}

export interface FunctionFingerprint {
  mnemonicSha256: string;
  bytesSha256: string;
  pcodeSha256: string | null;
  cfgSha256: string;
  callsSha256: string;
  callSequenceSha256: string;
  dataSha256: string;
  signatureSha256: string | null;
  combinedSha256: string;
  instructionCount: number;
  blockCount: number;
  edgeCount: number;
  completeInstructionDetail: boolean;
}

export type FunctionChangeKind = 'name' | 'entry' | 'signature' | 'calling-convention' | 'return-type' | 'blocks' | 'instructions' | 'calls' | 'data' | 'cfg' | 'pcode' | 'variables';

export interface FunctionChange {
  kind: FunctionChangeKind;
  before: unknown;
  after: unknown;
}

export interface FunctionMatch {
  beforeId: string;
  afterId: string;
  beforeName: string;
  afterName: string;
  beforeEntry: string;
  afterEntry: string;
  similarity: number;
  method: FunctionMatchMethod;
  changes: FunctionChange[];
  beforeEvidenceIds: string[];
  afterEvidenceIds: string[];
}

export interface BinaryDiffSummary {
  beforeFunctions: number;
  afterFunctions: number;
  matchedFunctions: number;
  addedFunctions: number;
  removedFunctions: number;
  modifiedFunctions: number;
  unchangedFunctions: number;
}

export interface BinaryDiffEvidence {
  kind: EvidenceKind;
  source: string;
  locator: string;
  summary: string;
}

export interface ProgramBinaryDiffReport {
  schemaVersion: 1;
  status: BinaryDiffStatus;
  generatedAt: string;
  comparedBinaries: 2;
  matchedFunctions: number;
  before: BinaryIdentity;
  after: BinaryIdentity;
  summary: BinaryDiffSummary;
  matches: FunctionMatch[];
  addedFunctions: Array<{ id: string; name: string; entry: string; evidenceIds: string[] }>;
  removedFunctions: Array<{ id: string; name: string; entry: string; evidenceIds: string[] }>;
  evidence: BinaryDiffEvidence[];
  limitations: string[];
}

export interface ProgramDiffInput {
  before: ProgramIr;
  after: ProgramIr;
  options?: BinaryDiffOptions;
}

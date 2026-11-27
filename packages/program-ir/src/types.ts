export type EvidenceKind = 'EVIDENCE' | 'INFERENCE' | 'UNKNOWN' | 'VERIFIED';
export type VariableKind = 'parameter' | 'local' | 'global';
export type DataKind = 'string' | 'pointer' | 'integer' | 'bytes' | 'unknown';
export type PcodeStatus = 'available' | 'unavailable';

export interface EvidenceRef {
  id: string;
  kind: EvidenceKind;
  source: string;
  locator: string;
  summary: string;
}

export interface InstructionIr {
  id: string;
  functionId: string;
  blockId: string;
  address: string;
  mnemonic: string;
  bytes?: string;
  pcode?: string[];
  pcodeStatus: PcodeStatus;
  evidenceIds: string[];
}

export interface BasicBlockIr {
  id: string;
  functionId: string;
  start: string;
  end: string;
  instructionIds: string[];
  successorIds: string[];
  predecessorIds: string[];
  evidenceIds: string[];
}

export interface VariableIr {
  id: string;
  functionId: string | null;
  name: string;
  kind: VariableKind;
  dataType: string;
  storage?: string;
  parameterIndex?: number;
  evidenceIds: string[];
}

export interface FunctionIr {
  id: string;
  name: string;
  entry: string;
  bodyStart: string;
  thunk: boolean;
  external: boolean;
  signature?: string;
  callingConvention?: string;
  returnType?: string;
  parameterIds: string[];
  localIds: string[];
  blockIds: string[];
  calleeIds: string[];
  callerIds: string[];
  pseudocode?: string;
  evidenceIds: string[];
}

export interface CallSiteIr {
  id: string;
  callerId: string;
  calleeId: string;
  address?: string;
  instructionId?: string;
  evidenceIds: string[];
}

export interface DataItemIr {
  id: string;
  address: string;
  kind: DataKind;
  value?: string;
  dataType?: string;
  size?: number;
  evidenceIds: string[];
}

export interface XrefIr {
  id: string;
  from: string;
  to: string;
  type: string;
  functionId: string | null;
  evidenceIds: string[];
}

export interface SemanticHypothesis {
  id: string;
  functionId: string;
  kind: string;
  summary: string;
  confidence: number;
  kindEvidence: EvidenceKind;
  evidenceIds: string[];
  falsification: string;
}

export interface ProgramProvenance {
  inputSha256?: string;
  analyzer?: string;
  analyzerVersion?: string;
  commit?: string;
  generatedAt?: string;
  environment?: string;
}

export interface ProgramIr {
  schemaVersion: 1;
  id: string;
  provenance?: ProgramProvenance;
  format: string;
  architecture: string;
  compilerSpec: string;
  imageBase: string;
  modules: Array<{ id: string; name: string; evidenceIds: string[] }>;
  functions: FunctionIr[];
  blocks: BasicBlockIr[];
  instructions: InstructionIr[];
  variables: VariableIr[];
  calls: CallSiteIr[];
  data: DataItemIr[];
  xrefs: XrefIr[];
  evidence: EvidenceRef[];
  hypotheses: SemanticHypothesis[];
  limitations: string[];
}

export interface FunctionContext {
  fn: FunctionIr;
  blocks: BasicBlockIr[];
  variables: VariableIr[];
  callees: FunctionIr[];
  callers: FunctionIr[];
  data: DataItemIr[];
  hypotheses: SemanticHypothesis[];
  evidence: EvidenceRef[];
}

export interface ProgramStats {
  functions: number;
  internalFunctions: number;
  externalFunctions: number;
  blocks: number;
  instructions: number;
  variables: number;
  calls: number;
  dataItems: number;
  xrefs: number;
  hypotheses: number;
  decompiledFunctions: number;
}

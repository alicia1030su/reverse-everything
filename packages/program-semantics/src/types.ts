import type { EvidenceRef, FunctionIr, ProgramIr, VariableIr } from '@reverse/program-ir';

export interface SemanticModelUsage { promptTokens: number; completionTokens: number; totalTokens: number }
export interface SemanticModelRequest { system: string; prompt: string; maxTokens: number; signal?: AbortSignal }
export interface SemanticModelResult {
  content: string; providerId: string; model: string; usage: SemanticModelUsage;
  invocation: 'real' | 'test-double'; completedAt: string;
  requestId?: string; finishReason?: string; usageSource?: 'provider' | 'estimated';
  responseSha256?: string; refusal?: boolean;
}
export type SemanticCompletionPort = (request: SemanticModelRequest) => Promise<SemanticModelResult>;

export interface VariableSemantics { name: string; semanticType: string; description: string }
export interface BehaviorSemantics { description: string; kind: string; confidence: number; evidenceIds: string[] }
export interface HypothesisSemantics { summary: string; evidenceIds: string[]; falsification: string }
export interface FunctionSemanticOutput {
  functionId: string;
  purpose: string;
  variables: VariableSemantics[];
  behaviors: BehaviorSemantics[];
  hypotheses: HypothesisSemantics[];
  architectureNotes: string;
  unknowns: string[];
}
export interface SemanticAnalysis {
  schemaVersion: 1;
  programId: string;
  functionId: string;
  output: FunctionSemanticOutput;
  classification: 'INFERENCE';
  model: Omit<SemanticModelResult, 'content'>;
  promptSha256: string;
  evidence: EvidenceRef[];
  limitations: string[];
}

export interface SemanticAnalysisOptions {
  maxPromptChars?: number;
  maxFunctions?: number;
  signal?: AbortSignal;
}

export interface SemanticContext {
  program: ProgramIr;
  fn: FunctionIr;
  variables: VariableIr[];
  callees: FunctionIr[];
  callers: FunctionIr[];
  evidence: EvidenceRef[];
}

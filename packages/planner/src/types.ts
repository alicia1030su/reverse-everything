export type EvidenceLevel = 'EVIDENCE' | 'INFERENCE' | 'UNKNOWN';
export type TargetKind = 'HAR' | 'PCAP' | 'PCAPNG' | 'APK' | 'DEX' | 'PE' | 'ELF' | 'UF2' | 'INTEL_HEX' | 'ZIP' | 'FIRMWARE' | 'UNKNOWN';
export type AnalyzerId = 'ghidra' | 'jadx' | 'firmware' | 'usb' | 'network' | 'website' | 'android' | 'game' | 'security' | 'file';
export type PlanStepKind = 'target-identification' | 'environment-detection' | 'authorization-check' | 'capability-match' | 'planning' | 'execution' | 'evidence-summary' | 'conclusion-validation' | 'report';
export type StepStatus = 'PENDING' | 'READY' | 'BLOCKED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'SKIPPED';

export interface DetectionSignal {
  level: EvidenceLevel;
  source: 'filename' | 'magic' | 'extension' | 'size' | 'declaration' | 'content';
  detail: string;
}

export interface TargetDetection {
  kind: TargetKind;
  level: EvidenceLevel;
  confidence: number;
  signals: DetectionSignal[];
  extension?: string;
  size: number;
  limitations: string[];
}

export interface AnalyzerCapability {
  id: AnalyzerId;
  available: boolean;
  version?: string;
  detail: string;
}

export interface AnalyzerInstallGuidance {
  official: string;
  safeAlternative: string;
  reason: string;
}

export interface AnalyzerSelection {
  id: AnalyzerId;
  available: boolean;
  required: boolean;
  silentSkip: false;
  version?: string;
  detail: string;
  guidance?: AnalyzerInstallGuidance;
}

export type AuthorizationOperation = 'read-target' | 'execute-analyzer' | 'extract-archive' | 'network-access' | 'device-access';

export interface AuthorizationScope {
  granted: boolean;
  operations: AuthorizationOperation[];
  allowedAdapters: AnalyzerId[];
  allowedTargetKinds: TargetKind[];
  expiresAt?: string;
}

export interface PlanBudget {
  timeoutMs: number;
  maxToolCalls: number;
  maxModelIterations: number;
  maxTokens: number;
  maxCostUsd: number;
  maxMemoryBytes: number;
  maxDiskBytes: number;
  maxNoProgressSteps: number;
}

export interface BudgetUsage {
  elapsedMs: number;
  toolCalls: number;
  modelIterations: number;
  tokens: number;
  costUsd: number;
  memoryBytes: number;
  diskBytes: number;
  noProgressSteps: number;
}

export interface PlanStep {
  id: string;
  kind: PlanStepKind;
  title: string;
  critical: boolean;
  status: StepStatus;
  analyzer?: AnalyzerId;
  authorization: AuthorizationOperation[];
  dependsOn: string[];
  adapterAllowlist: AnalyzerId[];
  maxDepth: number;
  reason?: string;
}

export interface AnalysisPlan {
  id: string;
  deterministic: true;
  target: TargetDetection;
  authorization: AuthorizationScope;
  objective: string;
  steps: PlanStep[];
  budget: PlanBudget;
  adapterAllowlist: AnalyzerId[];
  maxDepth: number;
  limitations: string[];
  aiSuggestions: string[];
}

export interface ReplanInput {
  plan: AnalysisPlan;
  failedStepId: string;
  reason: string;
  capabilities: AnalyzerCapability[];
  alternativePath?: string;
}

export interface ReplanResult {
  plan: AnalysisPlan;
  changed: boolean;
  failureRecorded: boolean;
  reason: string;
}

export class PlannerError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'PlannerError';
  }
}

export class BudgetExceededError extends PlannerError {
  constructor(message: string, readonly resource: keyof PlanBudget) {
    super(message, 'BUDGET_EXCEEDED');
    this.name = 'BudgetExceededError';
  }
}

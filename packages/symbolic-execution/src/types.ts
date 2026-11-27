export interface SymbolicInputSpec {
  /** Only file-backed stdin is supported in Wave 2. */
  source: 'stdin';
  sizeBytes: number;
  /** Concrete bytes are equality-constrained; remaining bytes stay symbolic. */
  inputBytes?: string;
}

export interface SymbolicTarget {
  function?: string;
  address?: string;
  expectedOutput?: string;
}

export interface SymbolicAnalysisRequest {
  binaryPath: string;
  target: SymbolicTarget;
  input: SymbolicInputSpec;
  timeoutMs?: number;
  maxPaths?: number;
  maxStates?: number;
  /** Explicit assertion that the caller may analyze and execute this binary. */
  authorized: boolean;
  entry?: { function?: string; address?: string };
}

export interface SymbolicConstraint {
  expression: string;
  address?: string;
  truncated?: boolean;
}

export interface SymbolicExecution {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  verified: boolean;
  timedOut: boolean;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  outputLimitExceeded?: boolean;
  terminatedBySignal?: boolean;
}

export interface SymbolicPath {
  id: string;
  targetAddress: string;
  addressHistory: string[];
  constraints: SymbolicConstraint[];
  constraintsTruncated?: boolean;
  constraintCount?: number;
  constraintsIncluded?: number;
  constraintsOmitted?: number;
  constraintChars?: number;
  constraintCharsTotal?: number;
  historyTruncated?: boolean;
  historyCount?: number;
  historyIncluded?: number;
  historyOmitted?: number;
  historyChars?: number;
  historyCharsTotal?: number;
  satisfiable: boolean;
  reachedTarget: boolean;
  statesExplored: number;
}

export interface SolvedSymbolicInput {
  pathId: string;
  inputHex: string;
  inputBase64: string;
  execution: SymbolicExecution;
}

export type SymbolicPartialReason = 'state-budget' | 'path-budget' | 'evidence-truncated' | 'native-verification' | 'output-budget';

export interface SymbolicAnalysisResult {
  schemaVersion: 1;
  status: 'completed' | 'partial' | 'timeout' | 'cancelled' | 'error' | 'unauthorized';
  partialReasons?: SymbolicPartialReason[];
  outputBudgetExceeded?: boolean;
  paths: SymbolicPath[];
  solvedInputs: SolvedSymbolicInput[];
  solver: { name: string; version: string };
  stats: { statesExplored: number; pathsFound: number; elapsedMs: number; maxStates?: number; maxPaths?: number; activeStates?: number };
  limitations: string[];
  provenance: {
    binaryPath: string;
    binarySnapshotPath?: string;
    binarySha256: string;
    workerSha256: string;
    pythonVersion: string;
    angrVersion: string;
    requestedAt: string;
    completedAt: string;
  };
  error?: string;
}

export interface SymbolicEngineOptions {
  pythonExecutable?: string;
  workerPath?: string;
  maxOutputBytes?: number;
  maxRequestBytes?: number;
  /** Maximum binary size copied into the private analysis snapshot. */
  maxBinaryBytes?: number;
  /** Injected for deterministic worker-process tests. */
  spawn?: typeof import('node:child_process').spawn;
}

import type { ProgramIr } from '@reverse/program-ir';

export type DynamicAnalysisStatus = 'completed' | 'timeout' | 'cancelled' | 'failed' | 'rejected';
export type DynamicEventType = 'start' | 'stop' | 'exit' | 'breakpoint' | 'thread' | 'module' | 'register' | 'stack' | 'output';

export interface DynamicFrame {
  level: number;
  address?: string;
  function?: string;
  file?: string;
  line?: number;
}

export interface DynamicEvent {
  timestamp: string;
  type: DynamicEventType;
  threadId?: string;
  frame?: DynamicFrame;
  registers?: Record<string, string>;
  module?: string;
  address?: string;
  data?: unknown;
}

export interface DynamicThread {
  id: string;
  current: boolean;
  frame?: DynamicFrame;
}

export interface DynamicModule {
  name: string;
  from?: string;
  to?: string;
  size?: number;
}

export interface DynamicAnalysisRequest {
  binaryPath: string;
  args?: string[];
  cwd: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  maxOutputBytes?: number;
  maxEvents?: number;
  breakpoints?: string[];
  authorized: boolean;
}

export interface DynamicProvenance {
  engine: string;
  engineVersion: string;
  executable: string;
  binarySha256: string;
  platform: NodeJS.Platform;
  cwd: string;
  networkIsolation: 'external-required' | 'none';
  startedAt: string;
  stoppedAt: string;
  durationMs: number;
  environmentVariables: string[];
}

export interface DynamicTrace {
  events: DynamicEvent[];
  threads: DynamicThread[];
  modules: DynamicModule[];
  outputBytes: number;
  truncated: boolean;
}

export interface DynamicAnalysisResult {
  status: DynamicAnalysisStatus;
  events: DynamicEvent[];
  threads: DynamicThread[];
  modules: DynamicModule[];
  timeline: Array<{ index: number; timestamp: string; type: DynamicEventType }>;
  limitations: string[];
  outputBytes: number;
  truncated: boolean;
  provenance: DynamicProvenance;
  programIr?: ProgramIr;
  error?: string;
}

export interface DynamicAnalysisEngineOptions {
  /** Dedicated analysis root. The actual cwd is a fresh child directory below it. */
  isolationRoot?: string;
  gdbPath?: string;
  networkIsolation?: 'external-required' | 'none';
  clientFactory?: (options: import('./mi-client.js').GdbMiClientOptions) => import('./mi-client.js').GdbMiClient;
}

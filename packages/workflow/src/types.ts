import type { AdapterName, EvidenceKind, JsonObject, Project, Severity, Stage, Upload } from '@reverse/contracts';

export interface TaskContext {
  taskId: string;
  project: Project;
  upload?: Upload;
  options: JsonObject;
  stageOutputs: Partial<Record<Stage, unknown>>;
  artifactDir: string;
  dataDir: string;
  log(level: 'info' | 'warn' | 'error', message: string, tool?: string): Promise<void>;
  evidence(kind: EvidenceKind, title: string, source: string, locator: string, content: unknown): Promise<string>;
  finding(input: { title: string; category: string; severity: Severity; confidence: number; evidenceIds: string[]; details: string; recommendation: string; status?: 'observed' | 'needs_review' | 'verified' }): Promise<string>;
  writeArtifact(name: string, content: string | Uint8Array, mime: string): Promise<void>;
}
export interface Detection { adapter: AdapterName; confidence: number; format: string; details: JsonObject; limitations: string[] }
export interface AdapterDefinition {
  name: AdapterName;
  version: string;
  description: string;
  available(): Promise<{ available: boolean; detail: string }>;
  detect(ctx: TaskContext): Promise<Detection>;
  prepare(ctx: TaskContext): Promise<unknown>;
  analyze(ctx: TaskContext): Promise<unknown>;
  extractEvidence(ctx: TaskContext): Promise<unknown>;
  reconstruct(ctx: TaskContext): Promise<unknown>;
  validate(ctx: TaskContext): Promise<unknown>;
}

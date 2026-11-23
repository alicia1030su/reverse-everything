export const VERSION = '0.0.1' as const;
export const STAGES = ['INTAKE','CLASSIFY','AUTHORIZATION_CHECK','PLAN','PREPARE','ANALYZE','COLLECT_EVIDENCE','MODEL_BEHAVIOR','RECONSTRUCT','VALIDATE','REPORT','EXPORT','COMPLETED'] as const;
export type Stage = typeof STAGES[number];
export type TaskStatus = 'CREATED' | 'QUEUED' | 'RUNNING' | 'PAUSED' | 'BLOCKED' | 'FAILED' | 'CANCELLED' | 'PARTIAL_SUCCESS' | 'COMPLETED';
export type StageStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'SKIPPED';
export type ProjectKind = 'website' | 'software' | 'game' | 'security';
export type AdapterName = 'website' | 'file' | 'security' | 'game';
export type EvidenceKind = 'EVIDENCE' | 'INFERENCE' | 'UNKNOWN' | 'VERIFIED';
export type Severity = 'info' | 'low' | 'medium' | 'high' | 'critical';
export interface JsonObject { [key: string]: unknown }
export interface Project { id: string; name: string; kind: ProjectKind; target: string; authorizationConfirmed: boolean; createdAt: string }
export interface Upload { id: string; projectId: string; name: string; storedName: string; mime: string; size: number; sha256: string; createdAt: string }
export interface TaskStage { name: Stage; status: StageStatus; attempt: number; startedAt?: string; endedAt?: string; error?: string; cacheKey?: string }
export interface Task { id: string; projectId: string; adapter: AdapterName; status: TaskStatus; currentStage: Stage; progress: number; currentTool: string | null; attempt: number; inputHash: string; options: Record<string, unknown>; createdAt: string; updatedAt: string; startedAt?: string; endedAt?: string; error?: string; pauseRequested: boolean; cancelRequested: boolean }
export interface Evidence { id: string; taskId: string; kind: EvidenceKind; title: string; source: string; locator: string; content: unknown; sha256: string; createdAt: string }
export interface Finding { id: string; taskId: string; title: string; category: string; severity: Severity; confidence: number; evidenceIds: string[]; details: string; recommendation: string; status: 'observed' | 'needs_review' | 'verified' }
export interface Artifact { name: string; size: number; sha256: string; mime: string; downloadPath: string }
export interface LogEntry { id: number; taskId: string; level: 'info' | 'warn' | 'error'; message: string; tool?: string; createdAt: string }
export interface TaskDetail extends Task { stages: TaskStage[]; evidence: Evidence[]; findings: Finding[]; logs: LogEntry[]; artifacts: Artifact[]; report?: string; project: Project; uploads: Upload[] }
export interface Stats { projects: number; tasks: number; running: number; completed: number; failed: number; evidence: number; findings: number; highFindings: number; adapters: { name: AdapterName; available: boolean; detail: string }[] }
export interface CreateProjectInput { name: string; kind: ProjectKind; target?: string; authorizationConfirmed: boolean }
export interface CreateTaskInput { adapter: AdapterName; options?: Record<string, unknown> }
export interface AiSettings { enabled: boolean; baseUrl: string; model: string; hasApiKey: boolean; allowRemoteData: boolean }

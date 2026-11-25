export const VERSION = '0.0.4' as const;
export const SCHEMA_VERSION = 3 as const;
export const EVIDENCE_MODEL_VERSION = '3.0.0' as const;
export const SECURITY_POLICY_VERSION = '3.0.0' as const;
export const CACHE_POLICY_VERSION = '3.0.0' as const;
export const STAGES = ['INTAKE','CLASSIFY','AUTHORIZATION_CHECK','PLAN','PREPARE','ANALYZE','COLLECT_EVIDENCE','MODEL_BEHAVIOR','RECONSTRUCT','VALIDATE','REPORT','EXPORT','COMPLETED'] as const;
export type Stage = typeof STAGES[number];
export type TaskStatus = 'CREATED' | 'QUEUED' | 'RUNNING' | 'PAUSED' | 'BLOCKED' | 'FAILED' | 'CANCELLED' | 'PARTIAL_SUCCESS' | 'COMPLETED';
export type StageStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'SKIPPED';
export type ProjectKind = 'website' | 'software' | 'game' | 'security' | 'protocol' | 'hardware' | 'firmware';
export type AdapterName = 'website' | 'file' | 'security' | 'game' | 'network' | 'apk' | 'ghidra' | 'hardware' | 'firmware';
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
export interface Page<T> { items: T[]; total: number; limit: number; offset: number }
export interface ProductInfo { product: 'reverse-everything'; version: string; schemaVersion: number; apiVersions: string[]; evidenceModelVersion: string; securityPolicyVersion: string }
export type ErrorCode = 'BAD_REQUEST' | 'UNAUTHORIZED' | 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT' | 'PAYLOAD_TOO_LARGE' | 'UNSUPPORTED_MEDIA_TYPE' | 'RATE_LIMITED' | 'RESOURCE_LIMIT' | 'QUEUE_FULL' | 'ADAPTER_UNAVAILABLE' | 'TASK_TIMEOUT' | 'INPUT_HASH_MISMATCH' | 'MIGRATION_FAILED' | 'DATABASE_CORRUPT' | 'INTERNAL_ERROR';
export interface ErrorResponse { error: { code: ErrorCode; message: string; requestId: string; details?: JsonObject } }
export class AppError extends Error {
  constructor(readonly code: ErrorCode, message: string, readonly status: number, readonly details?: JsonObject, readonly requestId: string = crypto.randomUUID()) { super(message); this.name = 'AppError'; }
}
export interface TaskBudget { timeoutMs?: number; maxMemoryMB?: number; maxDiskMB?: number }
export interface ResourceProcess { pid: number; ppid: number; rssMB: number; cpuSeconds: number; name?: string; role?: 'main'|'renderer'|'gpu'|'utility'|'other'|'api'|'worker'|'sidecar-child'; cpuPercent?: number; observedAt?: string; source?: 'electron-app-metrics'|'node-self'|'api-resource-snapshot'|'worker-resource-snapshot' }
export interface ResourceSnapshot { sampledAt: string; source: 'api' | 'worker' | 'desktop'; trigger?: 'startup'|'periodic'|'task-running'|'before-quit'; sampledProcessCount?: number; processesTruncated?: boolean; treeRssMB: number; selfRssMB: number; childRssMB: number; heapUsedMB: number; cpuPercent: number; handles: number; processes: ResourceProcess[]; systemFreeMemoryMB: number; systemTotalMemoryMB: number; dataDirBytes: number; diskAvailableBytes: number; queuedTasks: number; runningTasks: number; peakTreeRssMB: number; pressure: 'normal' | 'pressure' | 'danger'; limitations: string[] }
export type CacheKind = 'static-analysis' | 'web-snapshot' | 'protocol' | 'ai-inference' | 'reconstruction' | 'validation';
export interface CacheEntry { key: string; kind: CacheKind; scope: 'project' | 'global'; projectId: string | null; adapter: AdapterName; stage: Stage; sizeBytes: number; sha256: string; hits: number; misses: number; refCount: number; createdAt: string; lastAccessedAt: string; expiresAt: string | null }
export interface CacheStatistics { entries: number; sizeBytes: number; hits: number; misses: number; writes: number; corrupt: number; evictions: number; hitRate: number }
export interface BackupInfo { id:string; createdAt:string; kind:'manual'|'pre-migration'|'scheduled'; sizeBytes:number; fileCount:number; sha256:string; databaseSha256:string; schemaVersion:number; status:'complete'|'corrupt'; path:string }
export interface BackupPreview { backup:BackupInfo; targetDir:string; files:{path:string;sizeBytes:number}[]; totalBytes:number; warnings:string[] }
export type DataCategory = 'temporary' | 'browser-cache' | 'task-logs' | 'analysis-cache' | 'metrics';
export interface RetentionPolicy { temporaryDays: number; logDays: number; cacheDays: number; cacheMaxBytes: number; taskArtifactMaxBytes: number; diskWarningFreeBytes: number }
export const DEFAULT_RETENTION_POLICY: RetentionPolicy = { temporaryDays: 7, logDays: 30, cacheDays: 30, cacheMaxBytes: 2 * 1024 * 1024 * 1024, taskArtifactMaxBytes: 1024 * 1024 * 1024, diskWarningFreeBytes: 2 * 1024 * 1024 * 1024 };
export interface CleanupItem { path: string; category: DataCategory; sizeBytes: number; reason: string; taskId?: string }
export interface CleanupPreview { items: CleanupItem[]; totalBytes: number; protectedBytes: number; policy: RetentionPolicy }
export interface CleanupResult { deleted: CleanupItem[]; skipped: CleanupItem[]; deletedBytes: number; auditId: string }
export interface CapabilityInfo { name: string; version: string; available: boolean; detail: string }
export interface SystemStatus { product: ProductInfo; api: { available: boolean; version: string }; worker: { available: boolean; sampledAt?: string; pressure?: ResourceSnapshot['pressure'] }; browser: { available: boolean; detail: string; executablePath?: string }; mcp: { stdio: boolean; streamableHttp: boolean }; adapters: CapabilityInfo[] }

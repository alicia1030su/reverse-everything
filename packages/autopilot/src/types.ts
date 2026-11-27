import type { AdapterName, JsonObject } from '@reverse/contracts';

export const AUTOPILOT_STATUSES = ['DRAFT','DISCOVERING_REQUIREMENTS','PLANNING','WAITING_FOR_APPROVAL','RUNNING','ANALYZING','RECONSTRUCTING','BUILDING','TESTING','REPAIRING','PACKAGING','VERIFYING','WAITING_FOR_USER','PAUSED','BLOCKED','PARTIAL_SUCCESS','FAILED','CANCELLED','COMPLETED'] as const;
export type AutopilotStatus = typeof AUTOPILOT_STATUSES[number];
export type IntentKind = 'game-revival'|'legacy-revival'|'website-rebuild'|'data-recovery'|'defensive-security'|'firmware-analysis'|'software-rebuild'|'resume-project'|'unknown';
export type Feasibility = 'FEASIBLE'|'PARTIAL'|'NEEDS_INPUT'|'NEEDS_PERMISSION'|'NEEDS_TOOL'|'UNSUPPORTED'|'BLOCKED';
export type QuestionKind = 'single'|'multi'|'file'|'directory'|'text'|'version'|'platform'|'depth'|'permission'|'sharing';

export interface IntentInputs { uploadIds:string[]; paths:string[]; urls:string[]; imageIds:string[]; logIds:string[]; deviceInfo:string[] }
export interface AutopilotIntent {
  kind:IntentKind; objectives:string[]; finalPurpose:string; inputs:IntentInputs; targetPlatform:string;
  requiredCapabilities:AdapterName[]; delivery:string[]; missing:string[]; permissions:string[];
  feasibility:Feasibility; risks:string[]; limitations:string[]; confidence:number; source:'rules'|'model'|'mixed';
}
export interface DiscoveryQuestion {
  id:string; kind:QuestionKind; prompt:string; help:string; required:boolean; field:string;
  options?:{value:string;label:string;description?:string}[]; defaultValue?:string;
}
export interface GoalContract {
  version:number; userGoal:string; inputs:IntentInputs; analysisTargets:string[]; authorizedScope:string[];
  allowedOperations:string[]; forbiddenOperations:string[]; expectedOutputs:string[]; requiredDeliverables:string[];
  acceptanceCriteria:string[]; budget:{timeoutMs:number;maxDiskMB:number;maxMemoryMB:number;maxModelCalls:number;maxTokens:number;maxCostUsd:number;maxRepairAttempts:number};
  dataSharing:'local-only'|'remote-approved'; knownLimitations:string[]; unknowns:string[]; userParticipation:string[];
}
export type AutopilotStepStatus = 'PENDING'|'READY'|'RUNNING'|'WAITING_FOR_USER'|'SUCCEEDED'|'FAILED'|'SKIPPED'|'BLOCKED';
export interface AutopilotStep {
  id:string; goal:string; title:string; kind:'discover'|'analyze'|'reconstruct'|'build'|'test'|'repair'|'package'|'verify'|'document';
  dependsOn:string[]; tool:string; inputRefs:string[]; expectedOutput:string; acceptance:string;
  budget:{timeoutMs:number;maxDiskMB:number}; retries:number; status:AutopilotStepStatus; attempt:number;
  taskId?:string; outputRefs:string[]; error?:string; startedAt?:string; endedAt?:string;
}
export interface AutopilotPlan { version:number; goal:string; steps:AutopilotStep[]; createdAt:string; rationale:string }
export interface AutopilotMetrics { questionsAsked:number; repeatedQuestions:number; interventions:number; modelCalls:number; tokens:number; costUsd:number; repairAttempts:number; repairSuccesses:number; noProgressSteps:number; peakMemoryMB:number; startedAt?:string; endedAt?:string }
export interface AutopilotTask {
  id:string; projectId:string; conversationId:string; prompt:string; intent:AutopilotIntent; questions:DiscoveryQuestion[];
  answers:JsonObject; contract:GoalContract|null; plan:AutopilotPlan|null; status:AutopilotStatus;
  planVersion:number; stateVersion:number; checkpoint:string; idempotencyKey:string; error:string|null;
  metrics:AutopilotMetrics; leaseOwner:string|null; leaseExpiresAt:string|null; createdAt:string; updatedAt:string;
}
export interface AutopilotMessage { id:number; taskId:string; role:'user'|'assistant'|'system'; content:string; metadata:JsonObject; createdAt:string }
export interface CreateAutopilotInput { projectId:string; prompt:string; idempotencyKey?:string; conversationId?:string; uploadIds?:string[]; paths?:string[]; urls?:string[] }
export interface SubmitAnswersInput { answers:JsonObject; approveContract?:boolean; approvePlan?:boolean }
export interface ToolDefinition {
  name:string; description:string; inputSchema:JsonObject; outputSchema:JsonObject; platforms:string[]; formats:string[];
  permissions:string[]; environment:string; budget:{timeoutMs:number;maxDiskMB:number}; version:string;
  available:boolean; verification:'IMPLEMENTED'|'VERIFIED'|'UNAVAILABLE'; source:string;
}
export interface DeliveryAcceptance {
  status:'DELIVERABLE_VERIFIED'|'DELIVERABLE_PARTIAL'|'BUILD_FAILED'|'TEST_FAILED'|'COMPATIBILITY_UNVERIFIED'|'BLOCKED'|'REPORT_ONLY';
  checks:{name:string;passed:boolean;evidence:string}[]; reviewer:'independent-rules'|'model'; limitations:string[];
}
export interface DeliveryManifest {
  taskId:string; version:string; summary:string; originalGoal:string; completed:string[]; incomplete:string[];
  artifacts:{name:string;path:string;size:number;sha256:string;sourceTask:string;version:string;status:string;platforms:string[];conditions:string[]}[];
  acceptance:DeliveryAcceptance; tutorial:string; deployment:string; risks:string[];
}
export class AutopilotError extends Error { constructor(message:string,readonly code:string,readonly status=409){super(message);this.name='AutopilotError';} }

import { selectAnalyzers } from './analyzers.js';
import type { AnalyzerCapability, AnalyzerId, AnalysisPlan, AuthorizationOperation, AuthorizationScope, PlanBudget, PlanStep, PlanStepKind, TargetDetection } from './types.js';
import { PlannerError } from './types.js';

export const DEFAULT_PLAN_BUDGET: PlanBudget = {
  timeoutMs: 30 * 60 * 1000,
  maxToolCalls: 50,
  maxModelIterations: 8,
  maxTokens: 100_000,
  maxCostUsd: 2,
  maxMemoryBytes: 2 * 1024 * 1024 * 1024,
  maxDiskBytes: 5 * 1024 * 1024 * 1024,
  maxNoProgressSteps: 5,
};

export interface CreateAnalysisPlanInput {
  target: TargetDetection;
  authorization: AuthorizationScope;
  capabilities: AnalyzerCapability[];
  objective: string;
  budget?: Partial<PlanBudget>;
  maxSteps?: number;
  maxDepth?: number;
  adapterAllowlist?: AnalyzerId[];
  aiSuggestions?: string[];
}

function positive(value: number): boolean { return Number.isFinite(value) && value > 0; }

function validateBudget(budget: PlanBudget): void {
  for (const key of Object.keys(budget) as Array<keyof PlanBudget>) {
    if (!positive(budget[key])) throw new PlannerError(`Budget ${key} must be a positive finite number`, 'INVALID_BUDGET');
  }
  if (!Number.isInteger(budget.maxToolCalls) || !Number.isInteger(budget.maxModelIterations) || !Number.isInteger(budget.maxTokens) || !Number.isInteger(budget.maxMemoryBytes) || !Number.isInteger(budget.maxDiskBytes) || !Number.isInteger(budget.maxNoProgressSteps)) {
    throw new PlannerError('Count and byte budgets must be integers', 'INVALID_BUDGET');
  }
}

function allowed(scope: AuthorizationScope, operation: AuthorizationOperation): boolean {
  return scope.granted && scope.operations.includes(operation) && (!scope.expiresAt || Date.parse(scope.expiresAt) > Date.now());
}

function coreSteps(target: TargetDetection, scope: AuthorizationScope, selected: ReturnType<typeof selectAnalyzers>, adapters: AnalyzerId[], maxDepth: number): PlanStep[] {
  const canExecute = allowed(scope, 'execute-analyzer');
  const canRead = allowed(scope, 'read-target');
  const canExtract = allowed(scope, 'extract-archive');
  const targetAllowed = scope.allowedTargetKinds.includes(target.kind);
  const usable = selected.filter(item => item.available && adapters.includes(item.id));
  const missingRequired = selected.filter(item => item.required && !usable.some(available => available.id === item.id));
  const executionBlocked = !canRead || !canExecute || !targetAllowed || missingRequired.length > 0 || usable.length === 0;
  const reasons = [
    !canRead ? 'Target read authorization is missing or expired' : '',
    !canExecute ? 'Analyzer execution authorization is missing or expired' : '',
    !targetAllowed ? 'Target kind is outside the authorized target scope' : '',
    missingRequired.length ? `Required analyzers unavailable or outside adapter allowlist: ${missingRequired.map(item => item.id).join(', ')}` : '',
    usable.length === 0 ? 'No authorized available analyzer can execute this plan' : '',
  ].filter(Boolean);
  const authorizationOperations: AuthorizationOperation[] = ['read-target', 'execute-analyzer', ...(target.kind === 'ZIP' || target.kind === 'APK' ? ['extract-archive' as const] : [])];
  const extractionBlocked = (target.kind === 'ZIP' || target.kind === 'APK') && !canExtract;
  return [
    { id: 'target-identification', kind: 'target-identification', title: 'Confirm target using bounded evidence', critical: true, status: 'READY', authorization: ['read-target'], dependsOn: [], adapterAllowlist: [], maxDepth: 0, ...(!canRead ? { status: 'BLOCKED' as const, reason: 'Target read authorization is missing or expired' } : {}) },
    { id: 'environment-detection', kind: 'environment-detection', title: 'Probe analyzer environment', critical: true, status: 'READY', authorization: [], dependsOn: ['target-identification'], adapterAllowlist: [], maxDepth: 0 },
    { id: 'authorization-check', kind: 'authorization-check', title: 'Validate operation, target and adapter scope', critical: true, status: 'READY', authorization: [], dependsOn: ['target-identification'], adapterAllowlist: [], maxDepth: 0, ...(!canExecute || !targetAllowed ? { status: 'BLOCKED' as const, reason: 'Authorization scope does not permit requested execution' } : {}) },
    { id: 'capability-match', kind: 'capability-match', title: 'Match available analyzers to target', critical: true, status: missingRequired.length ? 'BLOCKED' : 'READY', authorization: [], dependsOn: ['environment-detection'], adapterAllowlist: [...adapters], maxDepth: 0, ...(missingRequired.length ? { reason: reasons.join('; ') } : {}) },
    { id: 'planning', kind: 'planning', title: 'Select deterministic bounded execution path', critical: true, status: 'READY', authorization: [], dependsOn: ['authorization-check', 'capability-match'], adapterAllowlist: [...adapters], maxDepth },
    { id: 'execution', kind: 'execution', title: 'Run authorized static analysis', critical: true, status: executionBlocked || extractionBlocked ? 'BLOCKED' : 'READY', authorization: authorizationOperations, dependsOn: ['planning'], adapterAllowlist: [...adapters], maxDepth, ...(usable[0] ? { analyzer: usable[0].id } : {}), ...(executionBlocked || extractionBlocked ? { reason: [...reasons, extractionBlocked ? 'Archive extraction authorization is missing' : ''].filter(Boolean).join('; ') } : {}) },
    { id: 'evidence-summary', kind: 'evidence-summary', title: 'Summarize observed evidence and limitations', critical: true, status: 'READY', authorization: [], dependsOn: ['execution'], adapterAllowlist: [], maxDepth: 0 },
    { id: 'conclusion-validation', kind: 'conclusion-validation', title: 'Validate conclusions against evidence', critical: true, status: 'READY', authorization: [], dependsOn: ['evidence-summary'], adapterAllowlist: [], maxDepth: 0 },
    { id: 'report', kind: 'report', title: 'Generate bounded analysis report', critical: true, status: 'READY', authorization: [], dependsOn: ['conclusion-validation'], adapterAllowlist: [], maxDepth: 0 },
  ];
}

/** Deterministic planning: suggestions never add adapters, operations, targets, depth or budget. */
export function createAnalysisPlan(input: CreateAnalysisPlanInput): AnalysisPlan {
  const budget = { ...DEFAULT_PLAN_BUDGET, ...input.budget };
  validateBudget(budget);
  const maxSteps = input.maxSteps ?? 16;
  const maxDepth = input.maxDepth ?? 3;
  if (!Number.isInteger(maxSteps) || maxSteps < 9 || maxSteps > 32) throw new PlannerError('maxSteps must be an integer between 9 and 32', 'INVALID_PLAN_BOUND');
  if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 10) throw new PlannerError('maxDepth must be an integer between 0 and 10', 'INVALID_PLAN_BOUND');
  const selected = selectAnalyzers(input.target, input.capabilities);
  const adapters = [...new Set(selected.filter(item => item.available).map(item => item.id))].filter(id => input.authorization.allowedAdapters.includes(id) && (!input.adapterAllowlist || input.adapterAllowlist.includes(id)));
  const steps = coreSteps(input.target, input.authorization, selected, adapters, maxDepth).slice(0, maxSteps);
  const limitations = [...input.target.limitations, `Plan bounded to ${steps.length} steps and depth ${maxDepth}`];
  const blocked = steps.filter(step => step.status === 'BLOCKED');
  if (blocked.length) limitations.push(...blocked.map(step => `${step.id}: ${step.reason ?? 'blocked'}`));
  const aiSuggestions = (input.aiSuggestions ?? []).filter(suggestion => typeof suggestion === 'string' && suggestion.trim()).slice(0, maxSteps).map(suggestion => `INFERENCE only: ${suggestion.slice(0, 500)}`);
  return {
    id: `plan:${input.target.kind.toLowerCase()}:${steps.length}:${maxDepth}`,
    deterministic: true,
    target: input.target,
    authorization: { ...input.authorization, operations: [...input.authorization.operations], allowedAdapters: [...input.authorization.allowedAdapters], allowedTargetKinds: [...input.authorization.allowedTargetKinds] },
    objective: input.objective.slice(0, 1000),
    steps,
    budget,
    adapterAllowlist: [...adapters],
    maxDepth,
    limitations,
    aiSuggestions,
  };
}

export function validatePlan(plan: AnalysisPlan): void {
  if (plan.steps.length > 32 || plan.maxDepth > 10) throw new PlannerError('Plan exceeds hard bounds', 'PLAN_BOUND_EXCEEDED');
  const ids = new Set(plan.steps.map(step => step.id));
  if (ids.size !== plan.steps.length) throw new PlannerError('Duplicate plan step identifiers', 'INVALID_PLAN');
  for (const step of plan.steps) {
    if (step.dependsOn.some(id => !ids.has(id))) throw new PlannerError(`Unknown dependency for ${step.id}`, 'INVALID_PLAN');
    if (step.adapterAllowlist.some(id => !plan.adapterAllowlist.includes(id) || !plan.authorization.allowedAdapters.includes(id))) throw new PlannerError(`Adapter scope violation in ${step.id}`, 'AUTHORIZATION_VIOLATION');
    if (step.maxDepth > plan.maxDepth) throw new PlannerError(`Depth violation in ${step.id}`, 'PLAN_BOUND_EXCEEDED');
    if (step.kind === 'execution' && (step.authorization.some(operation => !plan.authorization.granted || !plan.authorization.operations.includes(operation)) || (plan.authorization.expiresAt !== undefined && Date.parse(plan.authorization.expiresAt) <= Date.now()))) {
      step.status = 'BLOCKED';
      step.reason = 'Execution requires explicit operation authorization';
    }
  }
}

export type { PlanStepKind };

import { createHash } from 'node:crypto';
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

export interface ObjectiveRequirements {
  recovery: boolean;
  deployment: boolean;
  decompilation: boolean;
  reconstruction: boolean;
}

/** 目标只影响确定性步骤，不扩大授权、适配器、深度或预算。 */
export function objectiveRequirements(objective: string): ObjectiveRequirements {
  const text = objective.toLowerCase();
  const recovery = /恢复|还原数据|数据恢复|提取数据|recover(?:y| data)?|data recovery|extract data/.test(text);
  const deployment = /部署|发布|交付|打包|deploy(?:ment)?|release|deliver|package/.test(text);
  const decompilation = !recovery && /反编译| decompil/.test(text);
  const reconstruction = /重建|重构|兼容|rebuild|reconstruct|compatib/.test(text);
  return { recovery, deployment, decompilation, reconstruction };
}

function step(id: string, kind: PlanStepKind, title: string, dependsOn: string[], maxDepth: number, extra: Partial<PlanStep> = {}): PlanStep {
  return { id, kind, title, critical: true, status: 'READY', authorization: [], dependsOn, adapterAllowlist: [], maxDepth, ...extra };
}

function coreSteps(target: TargetDetection, scope: AuthorizationScope, selected: ReturnType<typeof selectAnalyzers>, adapters: AnalyzerId[], maxDepth: number, requirements: ObjectiveRequirements): PlanStep[] {
  const canExecute = allowed(scope, 'execute-analyzer');
  const canRead = allowed(scope, 'read-target');
  const canExtract = allowed(scope, 'extract-archive');
  const targetAllowed = scope.allowedTargetKinds.includes(target.kind);
  const usable = selected.filter(item => item.available && adapters.includes(item.id));
  const missingRequired = selected.filter(item => item.required && !(requirements.recovery && ['ghidra', 'jadx', 'android'].includes(item.id)) && !usable.some(available => available.id === item.id));
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
  // 数据恢复优先无损提取；只有明确反编译目标才优先选择反编译器。
  const preferred = requirements.recovery ? usable.find(item => item.id === 'file') ?? usable[0]
    : requirements.decompilation ? usable.find(item => item.id === 'ghidra') ?? usable[0] : usable[0];
  const executionStatus = executionBlocked || extractionBlocked ? 'BLOCKED' : 'READY';
  const steps: PlanStep[] = [
    step('target-identification', 'target-identification', 'Confirm target using bounded evidence', [], 0, { authorization: ['read-target'], ...(!canRead ? { status: 'BLOCKED', reason: 'Target read authorization is missing or expired' } : {}) }),
    step('environment-detection', 'environment-detection', 'Probe analyzer environment', ['target-identification'], 0),
    step('authorization-check', 'authorization-check', 'Validate operation, target and adapter scope', ['target-identification'], 0, { ...(!canExecute || !targetAllowed ? { status: 'BLOCKED', reason: 'Authorization scope does not permit requested execution' } : {}) }),
    step('capability-match', 'capability-match', 'Match available analyzers to target', ['environment-detection'], 0, { adapterAllowlist: [...adapters], ...(missingRequired.length ? { status: 'BLOCKED', reason: reasons.join('; ') } : {}) }),
    step('planning', 'planning', 'Select deterministic bounded execution path', ['authorization-check', 'capability-match'], maxDepth, { adapterAllowlist: [...adapters] }),
    step('execution', 'execution', requirements.recovery ? 'Extract and preserve recoverable data without forced decompilation' : 'Run authorized static analysis', ['planning'], maxDepth, { authorization: authorizationOperations, adapterAllowlist: [...adapters], status: executionStatus, ...(preferred ? { analyzer: preferred.id } : {}), ...(executionBlocked || extractionBlocked ? { reason: [...reasons, extractionBlocked ? 'Archive extraction authorization is missing' : ''].filter(Boolean).join('; ') } : {}) }),
  ];
  if (requirements.recovery) steps.push(step('data-recovery', 'restore', 'Restore recovered data into a separate output area', ['execution'], maxDepth, { status: executionStatus, ...(executionStatus === 'BLOCKED' ? { reason: 'Recovery requires an authorized executable analysis step' } : {}) }));
  if (requirements.reconstruction && steps.length < 14) steps.push(step('reconstruction', 'restore', 'Build an independent compatibility reconstruction from evidence', [steps[steps.length - 1]!.id], maxDepth, { status: executionStatus }));
  if (requirements.deployment) {
    let previous = steps[steps.length - 1]!.id;
    for (const [id, kind, title] of [
      ['build', 'build', 'Build deployable artifacts in an isolated output directory'],
      ['test', 'test', 'Run bounded tests against built artifacts'],
      ['package', 'package', 'Package verified artifacts with provenance'],
      ['document', 'document', 'Document deployment inputs, limitations and rollback'],
    ] as const) {
      steps.push(step(id, kind, title, [previous], maxDepth, { status: executionStatus }));
      previous = id;
    }
  }
  steps.push(
    step('evidence-summary', 'evidence-summary', 'Summarize observed evidence and limitations', [steps[steps.length - 1]!.id], 0),
    step('conclusion-validation', 'conclusion-validation', 'Validate conclusions against evidence', ['evidence-summary'], 0),
    step('report', 'report', 'Generate bounded analysis report', ['conclusion-validation'], 0),
  );
  return steps;
}

/** Deterministic planning: suggestions never add adapters, operations, targets, depth or budget. */
export function createAnalysisPlan(input: CreateAnalysisPlanInput): AnalysisPlan {
  const budget = { ...DEFAULT_PLAN_BUDGET, ...input.budget };
  validateBudget(budget);
  const maxSteps = input.maxSteps ?? 16;
  const maxDepth = input.maxDepth ?? 3;
  if (!Number.isInteger(maxSteps) || maxSteps < 9 || maxSteps > 32) throw new PlannerError('maxSteps must be an integer between 9 and 32', 'INVALID_PLAN_BOUND');
  if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 10) throw new PlannerError('maxDepth must be an integer between 0 and 10', 'INVALID_PLAN_BOUND');
  const requirements = objectiveRequirements(input.objective);
  const selected = selectAnalyzers(input.target, input.capabilities);
  const adapters = [...new Set(selected.filter(item => item.available).map(item => item.id))].filter(id => input.authorization.allowedAdapters.includes(id) && (!input.adapterAllowlist || input.adapterAllowlist.includes(id)));
  const generated = coreSteps(input.target, input.authorization, selected, adapters, maxDepth, requirements);
  if (generated.length > maxSteps) throw new PlannerError(`Objective requires ${generated.length} steps but maxSteps is ${maxSteps}`, 'PLAN_BOUND_EXCEEDED');
  const steps = generated;
  const limitations = [...input.target.limitations, `Plan bounded to ${steps.length} steps and depth ${maxDepth}`];
  if (requirements.recovery) limitations.push('Data recovery does not require decompilation; recovered content remains evidence, not verified source code');
  if (requirements.deployment) limitations.push('Deployment requires successful build, test, package and documentation steps before report generation');
  const blocked = steps.filter(item => item.status === 'BLOCKED');
  if (blocked.length) limitations.push(...blocked.map(item => `${item.id}: ${item.reason ?? 'blocked'}`));
  const aiSuggestions = (input.aiSuggestions ?? []).filter(suggestion => typeof suggestion === 'string' && suggestion.trim()).slice(0, maxSteps).map(suggestion => `INFERENCE only: ${suggestion.slice(0, 500)}`);
  const identity = createHash('sha256').update(JSON.stringify({ target: input.target, objective: input.objective, adapters, maxSteps, maxDepth, budget, kinds: steps.map(item => item.kind) })).digest('hex').slice(0, 16);
  return {
    id: `plan:${input.target.kind.toLowerCase()}:${identity}`,
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
    version: 1,
    failures: [],
  };
}

export function validatePlan(plan: AnalysisPlan): void {
  if (plan.steps.length > 32 || plan.maxDepth > 10) throw new PlannerError('Plan exceeds hard bounds', 'PLAN_BOUND_EXCEEDED');
  const ids = new Set(plan.steps.map(item => item.id));
  if (ids.size !== plan.steps.length) throw new PlannerError('Duplicate plan step identifiers', 'INVALID_PLAN');
  for (const item of plan.steps) {
    if (item.dependsOn.some(id => !ids.has(id))) throw new PlannerError(`Unknown dependency for ${item.id}`, 'INVALID_PLAN');
    if (item.adapterAllowlist.some(id => !plan.adapterAllowlist.includes(id) || !plan.authorization.allowedAdapters.includes(id))) throw new PlannerError(`Adapter scope violation in ${item.id}`, 'AUTHORIZATION_VIOLATION');
    if (item.maxDepth > plan.maxDepth) throw new PlannerError(`Depth violation in ${item.id}`, 'PLAN_BOUND_EXCEEDED');
    if (item.kind === 'execution' && (item.authorization.some(operation => !plan.authorization.granted || !plan.authorization.operations.includes(operation)) || (plan.authorization.expiresAt !== undefined && Date.parse(plan.authorization.expiresAt) <= Date.now()))) {
      item.status = 'BLOCKED';
      item.reason = 'Execution requires explicit operation authorization';
    }
  }
}

export type { PlanStepKind };

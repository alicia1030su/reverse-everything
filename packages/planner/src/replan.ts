import type { AnalyzerCapability, AnalyzerId, PlanFailure, PlanStep, ReplanInput, ReplanResult } from './types.js';

const SAFE_ALTERNATIVES: Partial<Record<AnalyzerId, AnalyzerId[]>> = {
  ghidra: ['file'],
  jadx: ['android', 'file'],
  firmware: ['file'],
  usb: ['network', 'file'],
  network: ['file'],
  website: ['network', 'file'],
  android: ['jadx', 'file'],
  game: ['ghidra', 'file'],
  security: ['file'],
  file: [],
};

function clonePlan(input: ReplanInput): ReplanInput['plan'] {
  return {
    ...input.plan,
    target: { ...input.plan.target, signals: input.plan.target.signals.map(signal => ({ ...signal })), limitations: [...input.plan.target.limitations] },
    authorization: { ...input.plan.authorization, operations: [...input.plan.authorization.operations], allowedAdapters: [...input.plan.authorization.allowedAdapters], allowedTargetKinds: [...input.plan.authorization.allowedTargetKinds] },
    steps: input.plan.steps.map(step => ({ ...step, dependsOn: [...step.dependsOn], adapterAllowlist: [...step.adapterAllowlist], authorization: [...step.authorization] })),
    budget: { ...input.plan.budget },
    adapterAllowlist: [...input.plan.adapterAllowlist],
    limitations: [...input.plan.limitations],
    aiSuggestions: [...input.plan.aiSuggestions],
    failures: (input.plan.failures ?? []).map(failure => ({ ...failure })),
  };
}

function authorizedAlternative(plan: ReplanInput['plan'], id: AnalyzerId): boolean {
  return plan.authorization.granted && plan.authorization.allowedAdapters.includes(id) && plan.authorization.allowedTargetKinds.includes(plan.target.kind) && plan.authorization.operations.includes('execute-analyzer') && plan.adapterAllowlist.includes(id) && (!plan.authorization.expiresAt || Date.parse(plan.authorization.expiresAt) > Date.now());
}

/** 失败步骤原样保留；只在存在可用、授权且安全的替代时追加独立重试步骤。 */
export function replan(input: ReplanInput): ReplanResult {
  const plan = clonePlan(input);
  const failed = plan.steps.find(step => step.id === input.failedStepId);
  const reason = `Replanning denied: ${input.reason}`;
  if (!failed) return { plan, changed: false, failureRecorded: false, reason };
  const failureKind = input.failureKind ?? (failed.status === 'BLOCKED' ? 'BLOCKED' : 'FAILED');
  const failure: PlanFailure = { stepId: failed.id, kind: failureKind, reason: input.reason.slice(0, 1000), recordedAt: new Date().toISOString() };
  plan.failures!.push(failure);
  failed.status = failureKind === 'BLOCKED' || failureKind === 'MISSING_TOOL' ? 'BLOCKED' : 'FAILED';
  failed.reason = input.reason.slice(0, 1000);

  const safe = failed.analyzer ? SAFE_ALTERNATIVES[failed.analyzer] ?? [] : failed.adapterAllowlist;
  const requested = input.alternativePath as AnalyzerId | undefined;
  if (requested && !safe.includes(requested)) return { plan, changed: false, failureRecorded: true, reason: `${reason}; alternative is not on the safe path` };
  const candidates = requested ? [requested] : safe;
  const alternative = candidates.find(id => {
    const capability: AnalyzerCapability | undefined = input.capabilities.find(item => item.id === id);
    return capability?.available && capability.detail.trim() && authorizedAlternative(plan, id);
  });
  if (!alternative) return { plan, changed: false, failureRecorded: true, reason: `${reason}; no available authorized safe alternative` };
  if (plan.steps.length >= 32 || plan.maxDepth > 10) return { plan, changed: false, failureRecorded: true, reason: `${reason}; plan bounds reached` };

  const retry: PlanStep = {
    ...failed,
    id: `${failed.id}:retry-${plan.failures!.length}`,
    status: 'READY',
    analyzer: alternative,
    adapterAllowlist: [alternative],
    dependsOn: [failed.id],
    reason: `Retry after ${failureKind.toLowerCase()} (${input.reason.slice(0, 500)}) using safe alternative ${alternative}`,
  };
  const index = plan.steps.findIndex(step => step.id === failed.id);
  plan.steps.splice(index + 1, 0, retry);
  plan.version = (plan.version ?? 1) + 1;
  plan.limitations.push(`Replanned ${input.failedStepId} to ${alternative}; failed step retained and retry appended`);
  return { plan, changed: true, failureRecorded: true, reason: `Appended retry using authorized safe alternative ${alternative}` };
}

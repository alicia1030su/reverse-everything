import type { AnalyzerCapability, AnalyzerId, ReplanInput, ReplanResult } from './types.js';

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
  };
}

/** Replanning records failures and may only switch to an available, explicitly authorized safe adapter. */
export function replan(input: ReplanInput): ReplanResult {
  const plan = clonePlan(input);
  const failed = plan.steps.find(step => step.id === input.failedStepId);
  const reason = `Replanning denied: ${input.reason}`;
  if (!failed) return { plan, changed: false, failureRecorded: false, reason };
  failed.status = 'FAILED';
  failed.reason = input.reason.slice(0, 1000);
  if (failed.kind !== 'execution' || !failed.analyzer) return { plan, changed: false, failureRecorded: true, reason };
  const candidates = SAFE_ALTERNATIVES[failed.analyzer] ?? [];
  const alternative = input.alternativePath && candidates.includes(input.alternativePath as AnalyzerId) ? input.alternativePath as AnalyzerId : undefined;
  if (!alternative) return { plan, changed: false, failureRecorded: true, reason };
  const capability: AnalyzerCapability | undefined = input.capabilities.find(item => item.id === alternative);
  const authorized = plan.authorization.granted && plan.authorization.allowedAdapters.includes(alternative) && plan.authorization.allowedTargetKinds.includes(plan.target.kind) && plan.authorization.operations.includes('execute-analyzer') && plan.adapterAllowlist.includes(alternative) && (!plan.authorization.expiresAt || Date.parse(plan.authorization.expiresAt) > Date.now());
  if (!capability?.available || !capability.detail.trim() || !authorized) return { plan, changed: false, failureRecorded: true, reason: `${reason}; no available authorized safe alternative` };
  if (plan.steps.length >= 32 || plan.maxDepth > 10) return { plan, changed: false, failureRecorded: true, reason: `${reason}; plan bounds reached` };
  failed.analyzer = alternative;
  failed.adapterAllowlist = [alternative];
  failed.status = 'READY';
  failed.reason = `Retry after failure (${input.reason.slice(0, 500)}) using safe alternative ${alternative}`;
  plan.limitations.push(`Replanned ${input.failedStepId} to ${alternative}; failure retained in step reason`);
  return { plan, changed: true, failureRecorded: true, reason: `Switched to authorized safe alternative ${alternative}` };
}

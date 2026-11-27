import type { AutopilotIntent, AutopilotPlan, AutopilotStep, GoalContract } from './types.js';
import { AutopilotError } from './types.js';

export interface PlanOptions { version?: number; now?: string }

function step(id: string, goal: string, title: string, kind: AutopilotStep['kind'], tool: string, dependsOn: string[], expectedOutput: string, acceptance: string, contract: GoalContract, inputRefs: string[] = [], toolInput?: AutopilotStep['toolInput']): AutopilotStep {
  return { id, goal, title, kind, tool, dependsOn, inputRefs, ...(toolInput ? { toolInput } : {}), expectedOutput, acceptance, budget: { timeoutMs: contract.budget.timeoutMs, maxDiskMB: contract.budget.maxDiskMB }, retries: Math.min(2, contract.budget.maxRepairAttempts), status: 'PENDING', attempt: 0, outputRefs: [] };
}

function isDeployment(contract: GoalContract, intent: AutopilotIntent): boolean {
  const text = [...contract.expectedOutputs, ...contract.requiredDeliverables, intent.finalPurpose].join(' ').toLowerCase();
  return /deploy|部署|上线|package|打包|static-website|source-project|website|网站|网页/.test(text);
}

export function createAutopilotPlan(intent: AutopilotIntent, contract: GoalContract, options?: PlanOptions): AutopilotPlan;
export function createAutopilotPlan(input: { intent: AutopilotIntent; contract: GoalContract; version?: number; now?: string }): AutopilotPlan;
export function createAutopilotPlan(intentOrInput: AutopilotIntent | { intent: AutopilotIntent; contract: GoalContract; version?: number; now?: string }, contractOrOptions?: GoalContract | PlanOptions, maybeOptions: PlanOptions = {}): AutopilotPlan {
  const intent = 'intent' in intentOrInput ? intentOrInput.intent : intentOrInput;
  const contract = 'intent' in intentOrInput ? intentOrInput.contract : contractOrOptions as GoalContract;
  const options = 'intent' in intentOrInput ? intentOrInput : maybeOptions;
  const steps: AutopilotStep[] = [];
  const analysisIds: string[] = [];
  const addAnalysis = (suffix: string, capability: AutopilotIntent['requiredCapabilities'][number], title: string) => {
    const id = `analyze-${suffix}`; analysisIds.push(id);
    const tool = `analyzer:${capability}`;
    steps.push(step(id, intent.objectives[0] ?? intent.finalPurpose, title, 'analyze', tool, [], `${capability} 分析结果与证据`, '存在真实工作流任务终态和至少一项证据/工件', contract, intent.inputs.uploadIds.length ? intent.inputs.uploadIds : intent.inputs.paths));
  };
  if (intent.kind === 'website-rebuild') addAnalysis('website', 'website', '采集并分析目标站点');
  else if (intent.kind === 'defensive-security') addAnalysis('security', 'security', '执行被动防御性安全检查');
  else if (intent.kind === 'firmware-analysis') addAnalysis('firmware', 'firmware', '识别并静态分析固件');
  else if (intent.kind === 'game-revival') addAnalysis('game', 'game', '分析授权游戏材料与协议证据');
  else if (intent.kind === 'data-recovery') addAnalysis('legacy', 'legacy', '只读识别材料并评估数据恢复路径');
  else if (intent.kind === 'legacy-revival') addAnalysis('legacy', 'legacy', '只读分析旧软件与兼容性');
  else if (intent.kind === 'resume-project') addAnalysis('project', 'file', '识别现有工程与可复用工件');
  else if (intent.kind === 'software-rebuild') {
    addAnalysis('file', 'file', '静态识别软件材料');
    if (intent.requiredCapabilities.includes('ghidra')) addAnalysis('ghidra', 'ghidra', '执行授权二进制的结构化静态分析');
    if (/android|安卓|apk/i.test(`${intent.finalPurpose} ${intent.targetPlatform}`)) addAnalysis('apk', 'apk', '静态分析 Android 应用材料');
  } else addAnalysis('file', 'file', '识别未知材料');
  if (intent.kind === 'software-rebuild' && intent.requiredCapabilities.includes('ghidra')) {
    const id = 'query-program-ir'; analysisIds.push(id);
    steps.push(step(id, '形成可查询的程序模型', '查询 Program IR 并保存证据报告', 'analyze', 'program-ir:query', ['analyze-ghidra'], 'Program IR 查询报告', '报告绑定真实 Program IR 哈希并保留证据与限制', contract, ['analyze-ghidra'], { operation: 'stats' }));
  }
  if (intent.objectives.length > 1 && analysisIds.length === 1) {
    const base = steps[0]!;
    for (let index = 1; index < Math.min(4, intent.objectives.length); index++) {
      const id = `${base.id}-objective-${index + 1}`; analysisIds.push(id);
      steps.push({ ...base, id, title: `独立目标 ${index + 1}：${intent.objectives[index]}`, goal: intent.objectives[index]!, dependsOn: [], outputRefs: [] });
    }
  }
  const deployment = isDeployment(contract, intent);
  const webDeployment = deployment && /web|website|网站|网页|静态|static/i.test(`${intent.targetPlatform} ${intent.finalPurpose} ${contract.expectedOutputs.join(' ')}`);
  if (deployment) {
    const reconstructId = 'reconstruct-delivery';
    const buildId = 'build-delivery';
    const testId = 'test-delivery';
    const packageId = 'package-delivery';
    const documentId = 'document-delivery';
    const verifyId = 'verify-delivery';
    steps.push(step(reconstructId, intent.objectives[0] ?? intent.finalPurpose, webDeployment ? '生成独立静态网站候选' : '整理可构建工程候选', 'reconstruct', webDeployment ? 'reconstruct:static-site' : 'reconstruct:workspace', analysisIds, webDeployment ? '可独立打开的静态站点源文件' : '工程源文件与构建说明', '文件真实存在且不依赖个人目录', contract, analysisIds));
    steps.push(step(buildId, '生成部署产物', webDeployment ? '构建静态站点' : '使用 allowlist 构建命令', 'build', webDeployment ? 'build:static-site' : 'build:allowlisted', [reconstructId], 'dist 构建产物', '构建命令在隔离 cwd 内真实成功', contract, [reconstructId]));
    steps.push(step(testId, '验证部署产物', '执行规则测试', 'test', webDeployment ? 'test:static-site' : 'test:allowlisted', [buildId], '测试结果', '测试真实执行且关键断言通过', contract, [buildId]));
    steps.push(step(packageId, '形成部署包', '打包并生成校验清单', 'package', webDeployment ? 'package:static-site' : 'package:allowlisted', [testId], '部署包与 SHA256 清单', '包内文件与清单哈希一致', contract, [testId]));
    steps.push(step(documentId, '交付使用说明', '生成教程与部署说明', 'document', 'document:delivery', [packageId], '使用教程与部署文档', '文档引用真实工件并说明限制', contract, [packageId]));
    steps.push(step(verifyId, '独立规则验收', '复核工件、哈希与验收证据', 'verify', 'verify:delivery', [packageId, documentId], '独立验收报告', '所有必需检查由规则引擎判定，模型不能自称成功', contract, [packageId, documentId]));
  } else {
    const documentId = 'document-delivery';
    const verifyId = 'verify-delivery';
    steps.push(step(documentId, '形成分析交付', '生成分析报告与使用说明', 'document', 'document:delivery', analysisIds, '报告与说明文档', '内容来自真实任务工件并标注未知项', contract, analysisIds));
    steps.push(step(verifyId, '独立规则验收', '复核证据与报告完整性', 'verify', 'verify:delivery', [documentId, ...analysisIds], '独立验收报告', '证据、文档和限制均由规则核对', contract, [documentId, ...analysisIds]));
  }
  const plan: AutopilotPlan = { version: options.version ?? 1, goal: contract.userGoal, steps, createdAt: options.now ?? new Date().toISOString(), rationale: `按 ${intent.kind} 的真实目标动态生成 ${steps.length} 个步骤；${deployment ? '部署目标包含 build/test/package/document' : '非部署目标不强制反编译或构建'}。` };
  validateAutopilotPlan(plan);
  return plan;
}

export const buildPlan = createAutopilotPlan;
export const createPlan = createAutopilotPlan;

export function validateAutopilotPlan(plan: AutopilotPlan): void {
  if (!Number.isInteger(plan.version) || plan.version < 1) throw new AutopilotError('计划版本无效', 'PLAN_INVALID', 400);
  if (!Array.isArray(plan.steps) || plan.steps.length === 0 || plan.steps.length > 64) throw new AutopilotError('计划步骤数量无效', 'PLAN_INVALID', 400);
  const ids = new Set<string>();
  for (const item of plan.steps) {
    if (!item.id || ids.has(item.id)) throw new AutopilotError(`计划步骤 ID 重复或无效: ${item.id}`, 'PLAN_INVALID', 400);
    ids.add(item.id);
  }
  for (const item of plan.steps) for (const dependency of item.dependsOn) if (!ids.has(dependency)) throw new AutopilotError(`步骤 ${item.id} 依赖不存在: ${dependency}`, 'PLAN_INVALID', 400);
  const visiting = new Set<string>(); const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new AutopilotError(`计划存在循环依赖: ${id}`, 'PLAN_CYCLE', 400);
    if (visited.has(id)) return; visiting.add(id);
    for (const dependency of plan.steps.find(item => item.id === id)?.dependsOn ?? []) visit(dependency);
    visiting.delete(id); visited.add(id);
  };
  for (const id of ids) visit(id);
}

export const validatePlan = validateAutopilotPlan;

export function readySteps(plan: AutopilotPlan, completed: ReadonlySet<string> = new Set()): AutopilotStep[] {
  return plan.steps.filter(item => !completed.has(item.id) && !['SUCCEEDED', 'SKIPPED', 'FAILED', 'BLOCKED'].includes(item.status) && item.dependsOn.every(id => completed.has(id)));
}

export function nextReadyStep(plan: AutopilotPlan, completed: ReadonlySet<string> = new Set()): AutopilotStep | undefined {
  return readySteps(plan, completed)[0];
}

export function planDependencies(plan: AutopilotPlan): Record<string, string[]> {
  return Object.fromEntries(plan.steps.map(item => [item.id, [...item.dependsOn]]));
}

export interface ReplanOptions {
  failedStepId: string;
  reason: string;
  /** Only the runtime may allow a bounded retry after classifying a transient failure. */
  allowRetry?: boolean;
  /** Runtime-verified tools only; static registry metadata is deliberately insufficient. */
  availableTools?: readonly string[];
  now?: string;
}
export interface ReplanResult {
  plan: AutopilotPlan;
  changed: boolean;
  previousTool?: string;
  replacementTool?: string;
  retryStepId?: string;
}

/** Clone the durable plan; never mutate completed steps, their outputs or their dependencies. */
export function replanAutopilotPlan(plan: AutopilotPlan, intent: AutopilotIntent, contract: GoalContract, options: ReplanOptions): ReplanResult {
  const failed = plan.steps.find(item => item.id === options.failedStepId);
  if (!failed || failed.status !== 'FAILED') return { plan, changed: false };
  if (failed.kind !== 'analyze' && failed.kind !== 'build' && failed.kind !== 'test') return { plan, changed: false };
  if (failed.kind === 'analyze') {
    if (!failed.tool.startsWith('analyzer:') || !contract.allowedOperations.includes('execute-analyzer')) return { plan, changed: false };
  } else if (options.allowRetry !== true) return { plan, changed: false };
  const previousTool = failed.tool;
  const candidates = (failed.kind === 'analyze' ? intent.requiredCapabilities.map(capability => `analyzer:${capability}`) : [previousTool])
    .filter(tool => options.availableTools?.includes(tool) === true);
  const replacementTool = candidates.find(tool => tool !== previousTool) ?? (options.allowRetry === true ? candidates.find(tool => tool === previousTool) : undefined);
  if (!replacementTool) return { plan, changed: false };
  const timestamp = options.now ?? new Date().toISOString();
  const retryStepId = `${failed.id}-retry-v${plan.version + 1}`;
  const retried: AutopilotStep = {
    ...failed, id: retryStepId, tool: replacementTool, status: 'PENDING', attempt: 0, outputRefs: [],
    dependsOn: [...failed.dependsOn], inputRefs: [...failed.inputRefs], budget: { ...failed.budget },
  };
  delete retried.taskId; delete retried.startedAt; delete retried.endedAt; delete retried.error;
  const next: AutopilotPlan = {
    ...plan,
    version: plan.version + 1,
    createdAt: timestamp,
    rationale: `${plan.rationale} 重规划：${options.failedStepId} 因 ${options.reason} 从 ${previousTool} 切换为 ${replacementTool}。`,
    steps: [
      ...plan.steps.map(item => item.id === failed.id ? { ...item, dependsOn: [...item.dependsOn], inputRefs: [...item.inputRefs], outputRefs: [...item.outputRefs], budget: { ...item.budget } } : {
        ...item, dependsOn: item.dependsOn.map(id => id === failed.id ? retryStepId : id), inputRefs: item.inputRefs.map(id => id === failed.id ? retryStepId : id),
        outputRefs: [...item.outputRefs], budget: { ...item.budget },
      }),
      retried,
    ],
  };
  validateAutopilotPlan(next);
  return { plan: next, changed: true, previousTool, replacementTool, retryStepId };
}

import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { AdapterName, JsonObject, Task } from '@reverse/contracts';
import { Database } from '@reverse/workflow';
import { detectIntent } from './intent.js';
import { discoveryQuestions, mergeAnswers, unansweredRequired } from './questions.js';
import { createAutopilotPlan, readySteps, replanAutopilotPlan } from './planner.js';
import { createDefaultToolRegistry, ToolRegistry } from './tools.js';
import { createDeliveryPackage, type DeliveryArtifactSource, type DeliveryCheckSource } from './delivery.js';
import {
  AUTOPILOT_STATUSES, AutopilotError, type AutopilotIntent, type AutopilotMessage, type AutopilotMetrics, type AutopilotPlan,
  type AutopilotStatus, type AutopilotStep, type AutopilotTask, type CreateAutopilotInput, type GoalContract, type SubmitAnswersInput,
} from './types.js';

export interface AutopilotArtifactRecord { name: string; path: string; size: number; sha256: string; mime: string }
export interface WorkflowPort {
  create(projectId: string, input: { adapter: AdapterName; options?: JsonObject }): Promise<Task>;
  execute(taskId: string): Promise<void>;
  pause?(taskId: string): boolean;
  resume?(taskId: string): boolean;
  cancel?(taskId: string): boolean;
  recover?(): void;
  /** Runtime adapter availability; static tool metadata must not authorize a replacement. */
  available?(adapter: AdapterName): boolean | Promise<boolean>;
}
export interface AutopilotEngineOptions {
  dataDir: string; workflow?: WorkflowPort; tools?: ToolRegistry; leaseMs?: number; pollMs?: number; workerId?: string; maxNoProgressSteps?: number;
}
interface AutopilotRow {
  id: string; project_id: string; conversation_id: string; prompt: string; idempotency_key: string; intent_json: string; questions_json: string;
  answers_json: string; contract_json: string | null; plan_json: string | null; status: string; plan_version: number; state_version: number;
  checkpoint: string; metrics_json: string; error: string | null; lease_owner: string | null; lease_expires_at: string | null; created_at: string; updated_at: string;
}
interface StoredArtifact { name: string; path: string; sourceTask: string; version: string; status: string; platforms: string[]; conditions: string[]; size?: number; sha256?: string }
interface StepResult { status: 'SUCCEEDED' | 'FAILED'; outputRefs: string[]; taskId?: string; artifacts?: StoredArtifact[]; checks?: DeliveryCheckSource[]; error?: string; summary?: string }
interface ReplanFailure { stepId: string; reason: string; error: string; failedTool: string; replacementTool: string; failedTaskId?: string | undefined; retryStepId?: string; occurredAt: string; planVersion: number; stateVersion: number }
interface Checkpoint { resumeStatus?: AutopilotStatus; stepId?: string; planVersion?: number; stateVersion?: number; planApproved?: boolean; lastSignature?: string; lastProgressAt?: string; lastFailure?: ReplanFailure; replanHistory?: ReplanFailure[] }
type CheckpointPatch = { [K in keyof Checkpoint]?: Checkpoint[K] | undefined };
type StepPatch = { [K in keyof AutopilotStep]?: AutopilotStep[K] | undefined };

const TERMINAL = new Set<AutopilotStatus>(['COMPLETED', 'CANCELLED', 'FAILED', 'BLOCKED']);
const DEFAULT_METRICS: AutopilotMetrics = { questionsAsked: 0, repeatedQuestions: 0, interventions: 0, modelCalls: 0, tokens: 0, costUsd: 0, repairAttempts: 0, repairSuccesses: 0, noProgressSteps: 0, peakMemoryMB: 0 };

function now(): string { return new Date().toISOString(); }
function parse<T>(value: string): T { return JSON.parse(value) as T; }
function positive(value: number, fallback: number, name: string): number { const result = value ?? fallback; if (!Number.isFinite(result) || result <= 0) throw new AutopilotError(`${name} 必须为正数`, 'AUTOPILOT_OPTION_INVALID', 400); return result; }
function safeAutopilotArtifactName(value: string): string {
  const flattened = value.replace(/\\/g, '/').split('/').filter(part => part && part !== '.' && part !== '..').join('__');
  const clean = flattened.normalize('NFC').replace(/[\\/\u0000-\u001f\u007f]/g, '_').replace(/[. ]+$/g, '');
  if (!clean || clean === '.' || clean === '..' || /~[0-9]/i.test(clean)) throw new AutopilotError('Autopilot 工件名称无效', 'AUTOPILOT_ARTIFACT_NAME_INVALID', 400);
  return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(clean) ? `_${clean.toLowerCase()}` : clean;
}
function mimeFor(name: string): string {
  if (name.endsWith('.json')) return 'application/json';
  if (name.endsWith('.md')) return 'text/markdown; charset=utf-8';
  if (name.endsWith('.html')) return 'text/html; charset=utf-8';
  if (name.endsWith('.css')) return 'text/css; charset=utf-8';
  if (name.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (name.endsWith('.txt')) return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

export function createGoalContract(intent: AutopilotIntent, answers: JsonObject): GoalContract {
  const authorized = answers.authorizationConfirmed === true || answers.authorized === true || answers.permission === true;
  const numberAnswer = (key: string, fallback: number, max: number): number => { const value = answers[key]; return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.min(max, Math.floor(value)) : fallback; };
  const scope = [
    ...intent.inputs.urls, ...intent.inputs.paths, ...intent.inputs.uploadIds, ...intent.inputs.logIds,
    ...(typeof answers.target === 'string' && answers.target ? [answers.target] : []),
    ...(Array.isArray(answers.materials) ? answers.materials.filter((item): item is string => typeof item === 'string') : []),
  ];
  const deployment = intent.delivery.some(item => /deploy|package|website|project/i.test(item)) || /deploy|部署|上线|打包|网站|网页/i.test(intent.finalPurpose);
  const allowedOperations = ['read-task-artifacts', 'write-task-artifacts'];
  if (authorized) allowedOperations.push('read-target', 'execute-analyzer');
  if (authorized && deployment && answers.allowBuild === true) allowedOperations.push('execute-allowlisted-build');
  return {
    version: 1, userGoal: intent.finalPurpose, inputs: intent.inputs, analysisTargets: [...new Set(scope)], authorizedScope: authorized ? [...new Set(scope)] : [],
    allowedOperations, forbiddenOperations: ['arbitrary-shell', 'execute-unknown-code', 'write-outside-task-workspace', 'network-exfiltration', 'remote-model-without-consent', 'modify-original-input'],
    expectedOutputs: intent.delivery.length ? intent.delivery : ['report'], requiredDeliverables: ['START-HERE.md', '使用教程.md', 'reports/ACCEPTANCE.json', 'ARTIFACT-MANIFEST.json', 'SHA256SUMS.txt'],
    acceptanceCriteria: ['所有执行步骤有真实任务终态或真实工具结果', '交付工件哈希可复核', '验收由 independent-rules 生成', '未验证项明确标注，不由模型自称成功'],
    budget: { timeoutMs: numberAnswer('timeoutMs', 300_000, 3_600_000), maxDiskMB: numberAnswer('maxDiskMB', 1024, 20_480), maxMemoryMB: numberAnswer('maxMemoryMB', 2048, 16_384), maxModelCalls: numberAnswer('maxModelCalls', 0, 100), maxTokens: numberAnswer('maxTokens', 0, 10_000_000), maxCostUsd: numberAnswer('maxCostUsd', 0, 10_000), maxRepairAttempts: numberAnswer('maxRepairAttempts', 2, 10) },
    dataSharing: answers.dataSharing === 'remote-approved' || answers.sharing === 'remote-approved' ? 'remote-approved' : 'local-only',
    knownLimitations: intent.limitations, unknowns: intent.missing, userParticipation: authorized ? ['查看验收报告', '决定是否部署'] : ['补充明确授权'],
  };
}

export class AutopilotEngine {
  private readonly workerId: string;
  private readonly leaseMs: number;
  private readonly maxNoProgressSteps: number;
  private readonly activeTasks = new Set<string>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly leaseTimers = new Map<string, NodeJS.Timeout>();
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private closed = false;
  constructor(readonly db: Database, private readonly options: AutopilotEngineOptions) {
    if (!options?.dataDir) throw new AutopilotError('dataDir 必填', 'AUTOPILOT_OPTION_INVALID', 400);
    this.workerId = options.workerId ?? `autopilot-${process.pid}-${randomUUID()}`;
    this.leaseMs = positive(options.leaseMs ?? 15_000, 15_000, 'leaseMs');
    this.maxNoProgressSteps = positive(options.maxNoProgressSteps ?? 3, 3, 'maxNoProgressSteps');
  }
  get workflow(): WorkflowPort | undefined { return this.options.workflow; }
  get tools(): ToolRegistry { return this.options.tools ??= createDefaultToolRegistry(); }

  private immediate<T>(work: () => T): T {
    this.db.raw.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.db.raw.exec('COMMIT'); return result; }
    catch (error) { try { this.db.raw.exec('ROLLBACK'); } catch { /* preserve original */ } throw error; }
  }
  private map(row: AutopilotRow): AutopilotTask {
    return {
      id: row.id, projectId: row.project_id, conversationId: row.conversation_id, prompt: row.prompt, intent: parse<AutopilotIntent>(row.intent_json),
      questions: parse(row.questions_json), answers: parse<JsonObject>(row.answers_json), contract: row.contract_json ? parse<GoalContract>(row.contract_json) : null,
      plan: row.plan_json ? parse<AutopilotPlan>(row.plan_json) : null, status: row.status as AutopilotStatus, planVersion: row.plan_version,
      stateVersion: row.state_version, checkpoint: row.checkpoint, idempotencyKey: row.idempotency_key, error: row.error, metrics: parse<AutopilotMetrics>(row.metrics_json),
      leaseOwner: row.lease_owner, leaseExpiresAt: row.lease_expires_at, createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }
  get(id: string): AutopilotTask | undefined { const row = this.db.raw.prepare('SELECT * FROM autopilot_tasks WHERE id=?').get(id) as AutopilotRow | undefined; return row ? this.map(row) : undefined; }
  require(id: string): AutopilotTask { const task = this.get(id); if (!task) throw new AutopilotError('Autopilot 任务不存在', 'AUTOPILOT_NOT_FOUND', 404); return task; }
  list(projectId?: string, limit = 100, offset = 0): AutopilotTask[] {
    const safeLimit = Math.max(1, Math.min(500, Math.floor(limit))); const safeOffset = Math.max(0, Math.floor(offset));
    const rows = projectId ? this.db.raw.prepare('SELECT * FROM autopilot_tasks WHERE project_id=? ORDER BY created_at DESC LIMIT ? OFFSET ?').all(projectId, safeLimit, safeOffset) as unknown as AutopilotRow[] : this.db.raw.prepare('SELECT * FROM autopilot_tasks ORDER BY created_at DESC LIMIT ? OFFSET ?').all(safeLimit, safeOffset) as unknown as AutopilotRow[];
    return rows.map(row => this.map(row));
  }
  private addMessage(taskId: string, role: AutopilotMessage['role'], content: string, metadata: JsonObject = {}): void {
    const createdAt = now();
    this.db.raw.prepare('INSERT INTO autopilot_messages (task_id,role,content,metadata_json,created_at) VALUES (?,?,?,?,?)').run(taskId, role, content, JSON.stringify(metadata), createdAt);
    this.db.addEvent(taskId, 'autopilot.message', { taskId, role, content, metadata, createdAt });
  }
  artifacts(taskId: string): AutopilotArtifactRecord[] {
    this.require(taskId);
    const rows = this.db.raw.prepare('SELECT name,stored_path,size,sha256,mime FROM autopilot_artifacts WHERE task_id=? ORDER BY name').all(taskId) as { name: string; stored_path: string; size: number; sha256: string; mime: string }[];
    if (rows.length) return rows.map(row => ({ name: row.name, path: row.stored_path, size: Number(row.size), sha256: row.sha256, mime: row.mime }));
    // Read-only compatibility for deliveries produced before autopilot_artifacts was introduced.
    const records: AutopilotArtifactRecord[] = [];
    for (const directory of ['artifacts', 'delivery']) {
      const root = path.join(this.options.dataDir, 'autopilot', taskId, directory);
      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const file = path.join(dir, entry.name);
          if (entry.isSymbolicLink()) continue;
          if (entry.isDirectory()) { walk(file); continue; }
          if (!entry.isFile()) continue;
          const info = lstatSync(file); const relative = path.relative(root, file).split(path.sep).join('/');
          records.push({ name: safeAutopilotArtifactName(relative), path: file, size: info.size, sha256: createHash('sha256').update(readFileSync(file)).digest('hex'), mime: mimeFor(entry.name) });
        }
      };
      try { walk(root); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    return records.sort((a, b) => a.name.localeCompare(b.name));
  }
  artifactPath(taskId: string, name: string): string | undefined {
    this.require(taskId); const safeName = safeAutopilotArtifactName(name);
    const row = this.db.raw.prepare('SELECT stored_path FROM autopilot_artifacts WHERE task_id=? AND name=? COLLATE NOCASE').get(taskId, safeName) as { stored_path: string } | undefined;
    return row?.stored_path ?? this.artifacts(taskId).find(item => item.name.toLowerCase() === safeName.toLowerCase())?.path;
  }
  private publishDeliveryArtifacts(taskId: string): void {
    const root = path.join(this.options.dataDir, 'autopilot', taskId, 'artifacts'); const records: AutopilotArtifactRecord[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) { walk(file); continue; }
        if (!entry.isFile()) continue;
        const info = lstatSync(file); const relative = path.relative(root, file).split(path.sep).join('/'); const name = safeAutopilotArtifactName(relative);
        records.push({ name, path: file, size: info.size, sha256: createHash('sha256').update(readFileSync(file)).digest('hex'), mime: mimeFor(entry.name) });
      }
    };
    walk(root);
    this.immediate(() => {
      this.db.raw.prepare('DELETE FROM autopilot_artifacts WHERE task_id=?').run(taskId);
      const insert = this.db.raw.prepare('INSERT INTO autopilot_artifacts (id,task_id,name,stored_path,size,sha256,mime,created_at) VALUES (?,?,?,?,?,?,?,?)');
      for (const record of records) insert.run(randomUUID(), taskId, record.name, record.path, record.size, record.sha256, record.mime, now());
    });
    this.db.addEvent(taskId, 'autopilot.artifacts.published', { taskId, count: records.length });
  }
  messages(taskId: string): AutopilotMessage[] {
    this.require(taskId);
    return (this.db.raw.prepare('SELECT * FROM autopilot_messages WHERE task_id=? ORDER BY id').all(taskId) as { id: number; task_id: string; role: AutopilotMessage['role']; content: string; metadata_json: string; created_at: string }[]).map(row => ({ id: row.id, taskId: row.task_id, role: row.role, content: row.content, metadata: parse<JsonObject>(row.metadata_json), createdAt: row.created_at }));
  }
  private save(task: AutopilotTask, token?: string): boolean {
    const values = [JSON.stringify(task.intent), JSON.stringify(task.questions), JSON.stringify(task.answers), task.contract ? JSON.stringify(task.contract) : null, task.plan ? JSON.stringify(task.plan) : null, task.status, task.planVersion, task.stateVersion, task.checkpoint, JSON.stringify(task.metrics), task.error, task.leaseOwner, task.leaseExpiresAt, now(), task.id];
    const result = token
      ? this.db.raw.prepare(`UPDATE autopilot_tasks SET intent_json=?,questions_json=?,answers_json=?,contract_json=?,plan_json=?,status=?,plan_version=?,state_version=?,checkpoint=?,metrics_json=?,error=?,lease_owner=?,lease_expires_at=?,updated_at=? WHERE id=? AND lease_owner=? AND lease_expires_at>?`).run(...values, token, now())
      : this.db.raw.prepare(`UPDATE autopilot_tasks SET intent_json=?,questions_json=?,answers_json=?,contract_json=?,plan_json=?,status=?,plan_version=?,state_version=?,checkpoint=?,metrics_json=?,error=?,lease_owner=?,lease_expires_at=?,updated_at=? WHERE id=?`).run(...values);
    const changed = Number(result.changes) === 1;
    if (changed) this.db.addEvent(task.id, 'autopilot.state_changed', { taskId: task.id, status: task.status, stateVersion: task.stateVersion, planVersion: task.planVersion });
    return changed;
  }
  private checkpoint(task: AutopilotTask, value: CheckpointPatch): string {
    const current = parse<Checkpoint>(task.checkpoint || '{}'); const next = { ...current, ...value, planVersion: task.planVersion, stateVersion: task.stateVersion };
    task.checkpoint = JSON.stringify(next); return task.checkpoint;
  }

  async create(input: CreateAutopilotInput): Promise<AutopilotTask> {
    if (!input.projectId || !input.prompt?.trim()) throw new AutopilotError('projectId 与 prompt 必填', 'AUTOPILOT_INPUT_INVALID', 400);
    if (!this.db.getProject(input.projectId)) throw new AutopilotError('项目不存在', 'AUTOPILOT_NOT_FOUND', 404);
    const idempotencyKey = input.idempotencyKey ?? randomUUID();
    const existingRow = this.db.raw.prepare('SELECT * FROM autopilot_tasks WHERE idempotency_key=?').get(idempotencyKey) as AutopilotRow | undefined;
    if (existingRow) {
      if (existingRow.project_id !== input.projectId || existingRow.prompt !== input.prompt) throw new AutopilotError('幂等键已用于不同请求', 'AUTOPILOT_IDEMPOTENCY_CONFLICT', 409);
      return this.map(existingRow);
    }
    const intent = detectIntent(input.prompt, { inputs: { uploadIds: input.uploadIds ?? [], paths: input.paths ?? [], urls: input.urls ?? [] } });
    const questions = discoveryQuestions(intent, {}); const waiting = questions.some(question => question.required);
    const task: AutopilotTask = {
      id: randomUUID(), projectId: input.projectId, conversationId: input.conversationId ?? randomUUID(), prompt: input.prompt, intent, questions, answers: {}, contract: null, plan: null,
      status: waiting ? 'WAITING_FOR_USER' : 'DISCOVERING_REQUIREMENTS', planVersion: 0, stateVersion: 1, checkpoint: '{}', idempotencyKey, error: null,
      metrics: { ...DEFAULT_METRICS }, leaseOwner: null, leaseExpiresAt: null, createdAt: now(), updatedAt: now(),
    };
    try {
      this.immediate(() => {
        this.db.raw.prepare(`INSERT INTO autopilot_tasks (id,project_id,conversation_id,prompt,idempotency_key,intent_json,questions_json,answers_json,contract_json,plan_json,status,plan_version,state_version,checkpoint,metrics_json,error,lease_owner,lease_expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          task.id, task.projectId, task.conversationId, task.prompt, task.idempotencyKey, JSON.stringify(task.intent), JSON.stringify(task.questions), '{}', null, null, task.status, 0, 1, '{}', JSON.stringify(task.metrics), null, null, null, task.createdAt, task.updatedAt,
        );
        this.addMessage(task.id, 'assistant', waiting ? `需要补充 ${questions.filter(item => item.required).length} 项需求后继续。` : '需求已识别，可以确认目标契约。', { questions });
        this.db.addEvent(task.id, 'autopilot.created', { taskId: task.id, projectId: task.projectId, status: task.status });
      });
    } catch (error) {
      const raced = this.db.raw.prepare('SELECT * FROM autopilot_tasks WHERE idempotency_key=?').get(idempotencyKey) as AutopilotRow | undefined;
      if (raced && raced.project_id === input.projectId && raced.prompt === input.prompt) return this.map(raced);
      throw error;
    }
    return task;
  }

  submitAnswers(id: string, input: SubmitAnswersInput): AutopilotTask {
    const task = this.require(id);
    if (TERMINAL.has(task.status) || task.status === 'RUNNING') throw new AutopilotError('当前状态不能提交答案', 'AUTOPILOT_STATE_CONFLICT', 409);
    if (task.metrics.startedAt || task.plan?.steps.some(step => step.attempt > 0 || Boolean(step.taskId)) || this.succeededStepIds(id).length) {
      throw new AutopilotError('执行开始后禁止修改授权输入或材料；如需修订请创建新任务', 'AUTOPILOT_INPUTS_LOCKED', 409);
    }
    const before = new Set(Object.keys(task.answers));
    const repeated = Object.keys(input.answers).filter(key => before.has(key)).length;
    task.answers = mergeAnswers(task.answers, input.answers, task.questions);
    task.questions = discoveryQuestions(task.intent, task.answers);
    task.metrics.questionsAsked = Object.keys(task.answers).length; task.metrics.repeatedQuestions += repeated;
    const missing = unansweredRequired(task.questions, task.answers);
    if (missing.length) { task.status = 'WAITING_FOR_USER'; task.error = null; task.stateVersion++; this.save(task); this.addMessage(id, 'assistant', `还需补充：${missing.map(item => item.prompt).join('；')}`, { questionIds: missing.map(item => item.id) }); return task; }
    task.contract = createGoalContract(task.intent, task.answers);
    if (task.contract.authorizedScope.length === 0 && !task.contract.allowedOperations.includes('read-target')) {
      task.status = 'BLOCKED'; task.error = '用户未授权目标分析'; task.stateVersion++; this.save(task); this.addMessage(id, 'system', task.error); return task;
    }
    if (!input.approveContract) { task.status = 'WAITING_FOR_APPROVAL'; task.error = null; task.stateVersion++; this.save(task); this.addMessage(id, 'assistant', '目标契约已生成，请确认授权范围、预算和交付物。', { contract: task.contract }); return task; }
    task.plan = createAutopilotPlan(task.intent, task.contract, { version: task.planVersion + 1 }); task.planVersion = task.plan.version;
    this.checkpoint(task, { planApproved: input.approvePlan === true, resumeStatus: input.approvePlan ? 'PLANNING' : 'WAITING_FOR_APPROVAL' });
    task.status = input.approvePlan ? 'PLANNING' : 'WAITING_FOR_APPROVAL'; task.error = null; task.stateVersion++; this.save(task);
    this.addMessage(id, 'assistant', input.approvePlan ? '计划已批准，可以启动执行。' : '动态计划已生成，请确认后启动。', { plan: task.plan });
    return task;
  }

  private claim(id: string, statuses: AutopilotStatus[] = ['PLANNING', 'RUNNING', 'REPAIRING']): string | undefined {
    const token = `${this.workerId}:${randomUUID()}`; const timestamp = now(); const expires = new Date(Date.now() + this.leaseMs).toISOString(); const placeholders = statuses.map(() => '?').join(',');
    return this.immediate(() => {
      const row = this.db.raw.prepare(`UPDATE autopilot_tasks SET status='RUNNING',lease_owner=?,lease_expires_at=?,updated_at=?,state_version=state_version+1 WHERE id=? AND status IN (${placeholders}) AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at<=?) RETURNING id`).get(token, expires, timestamp, id, ...statuses, timestamp) as { id: string } | undefined;
      return row?.id ? token : undefined;
    });
  }
  private owned(id: string, token: string): boolean {
    const row = this.db.raw.prepare("SELECT id FROM autopilot_tasks WHERE id=? AND status='RUNNING' AND lease_owner=? AND lease_expires_at>?").get(id, token, now()) as { id: string } | undefined;
    return Boolean(row);
  }
  private release(id: string, token: string): void { this.db.raw.prepare('UPDATE autopilot_tasks SET lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND lease_owner=?').run(now(), id, token); }
  private renewLease(id: string, token: string): boolean {
    const timestamp = now(); const expires = new Date(Date.now() + this.leaseMs).toISOString();
    const result = this.db.raw.prepare("UPDATE autopilot_tasks SET lease_expires_at=?,updated_at=? WHERE id=? AND status='RUNNING' AND lease_owner=? AND lease_expires_at>?").run(expires, timestamp, id, token, timestamp);
    return Number(result.changes) === 1;
  }
  private startLeaseHeartbeat(id: string, token: string, controller: AbortController): void {
    this.stopLeaseHeartbeat(id);
    const interval = Math.max(1, Math.floor(this.leaseMs / 2) - 1);
    const timer = setInterval(() => {
      if (this.renewLease(id, token)) return;
      this.stopLeaseHeartbeat(id); controller.abort(new AutopilotError('Autopilot 租约续期失败，已停止执行且禁止发布结果', 'AUTOPILOT_LEASE_LOST', 409));
      const childId = this.require(id).plan?.steps.find(step => step.status === 'RUNNING')?.taskId; if (childId) this.workflow?.cancel?.(childId);
    }, interval);
    timer.unref(); this.leaseTimers.set(id, timer);
  }
  private stopLeaseHeartbeat(id: string): void { const timer = this.leaseTimers.get(id); if (timer) clearInterval(timer); this.leaseTimers.delete(id); }

  async run(id: string): Promise<AutopilotTask> {
    const initial = this.require(id);
    if (!initial.contract || !initial.plan) throw new AutopilotError('任务缺少已批准的目标契约或计划', 'AUTOPILOT_PLAN_MISSING', 409);
    if (initial.status === 'WAITING_FOR_APPROVAL') throw new AutopilotError('计划尚未批准', 'AUTOPILOT_APPROVAL_REQUIRED', 409);
    if (TERMINAL.has(initial.status) || initial.status === 'PAUSED') return initial;
    if (this.activeTasks.has(id)) return this.require(id);
    const token = this.claim(id); if (!token) return this.require(id);
    this.activeTasks.add(id); const controller = new AbortController(); this.controllers.set(id, controller); this.startLeaseHeartbeat(id, token, controller);
    let task = this.require(id);
    try {
      if (!this.owned(id, token)) return task;
      task = this.require(id); this.checkpoint(task, { resumeStatus: 'RUNNING', planApproved: true }); task.metrics.startedAt ??= now(); task.stateVersion++; if (!this.save(task, token)) return task;
      while (this.owned(id, token) && !controller.signal.aborted) {
        task = this.require(id); if (task.status !== 'RUNNING') break;
        const completed = new Set(this.succeededStepIds(id)); const next = readySteps(task.plan!, completed)[0];
        if (!next) {
          const allSucceeded = task.plan!.steps.every(step => completed.has(step.id) || (step.status === 'FAILED' && task.plan!.steps.some(candidate => candidate.id.startsWith(`${step.id}-retry-v`) && completed.has(candidate.id))));
          if (allSucceeded) { await this.finishDelivery(id, token); break; }
          throw new AutopilotError('存在无法继续的阻塞步骤', 'AUTOPILOT_NO_PROGRESS', 409);
        }
        const result = await this.executeStep(task, next, token, controller.signal);
        if (!this.owned(id, token)) break;
        if (result === 'RETRY') continue;
        if (result === 'PAUSED' || result === 'CANCELLED') break;
      }
    } catch (error) {
      if (this.owned(id, token)) {
        task = this.require(id); task.status = controller.signal.aborted ? 'CANCELLED' : 'FAILED'; task.error = error instanceof Error ? error.message.slice(0, 2000) : String(error).slice(0, 2000); task.metrics.endedAt = now(); task.stateVersion++; this.save(task); this.addMessage(id, 'system', task.error);
      }
    } finally {
      this.controllers.delete(id); this.activeTasks.delete(id); this.stopLeaseHeartbeat(id); this.release(id, token);
    }
    return this.require(id);
  }

  private stepResult(taskId: string, stepId: string): StepResult | undefined {
    const row = this.db.raw.prepare('SELECT output_json FROM autopilot_step_results WHERE task_id=? AND step_id=?').get(taskId, stepId) as { output_json: string } | undefined;
    return row ? parse<StepResult>(row.output_json) : undefined;
  }
  private succeededStepIds(taskId: string): string[] {
    return (this.db.raw.prepare("SELECT step_id FROM autopilot_step_results WHERE task_id=? AND status='SUCCEEDED'").all(taskId) as { step_id: string }[]).map(row => row.step_id);
  }
  private storeStepResult(taskId: string, stepId: string, key: string, result: StepResult): void {
    this.db.raw.prepare(`INSERT INTO autopilot_step_results (task_id,step_id,idempotency_key,status,output_json,created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(task_id,step_id) DO UPDATE SET idempotency_key=excluded.idempotency_key,status=excluded.status,output_json=excluded.output_json,created_at=excluded.created_at`).run(taskId, stepId, key, result.status, JSON.stringify(result), now());
  }
  private updateStep(task: AutopilotTask, stepId: string, values: StepPatch): void {
    if (!task.plan) return; const step = task.plan.steps.find(item => item.id === stepId); if (!step) return; Object.assign(step, values); task.plan.version = task.planVersion; task.stateVersion++;
  }

  private async executeStep(task: AutopilotTask, step: AutopilotStep, token: string, signal: AbortSignal): Promise<'DONE' | 'RETRY' | 'PAUSED' | 'CANCELLED'> {
    const previous = this.stepResult(task.id, step.id);
    if (previous?.status === 'SUCCEEDED' || step.status === 'SUCCEEDED') { this.updateStep(task, step.id, { status: 'SUCCEEDED', outputRefs: previous?.outputRefs ?? step.outputRefs }); if (!this.save(task, token)) return 'CANCELLED'; return 'DONE'; }
    task.metrics.noProgressSteps = task.metrics.noProgressSteps ?? 0;
    if (task.metrics.noProgressSteps >= this.maxNoProgressSteps) throw new AutopilotError('无进展熔断：步骤未产生新证据或工件', 'AUTOPILOT_CIRCUIT_OPEN', 409);
    const key = `${task.id}:${task.planVersion}:${step.id}:${step.attempt + 1}`;
    step.status = 'RUNNING'; step.attempt += 1; step.startedAt = now(); delete step.error; task.stateVersion++; this.checkpoint(task, { stepId: step.id, lastSignature: step.id, lastProgressAt: now(), resumeStatus: 'RUNNING' }); if (!this.save(task, token)) return 'CANCELLED';
    try {
      const workspaceRoot = path.join(this.options.dataDir, 'autopilot', task.id); const cwd = path.join(workspaceRoot, 'steps', step.id); await mkdir(cwd, { recursive: true });
      const result = step.tool.startsWith('analyzer:') ? await this.executeAnalyzer(task, step, token, signal) : await this.executeLocal(task, step, cwd, signal);
      if (!this.owned(task.id, token)) return 'CANCELLED';
      const stored: StepResult = { status: 'SUCCEEDED', ...result };
      this.immediate(() => { if (!this.owned(task.id, token)) throw new AutopilotError('步骤结果发布前租约失效', 'AUTOPILOT_LEASE_LOST', 409); this.storeStepResult(task.id, step.id, key, stored); });
      task = this.require(task.id); this.updateStep(task, step.id, { status: 'SUCCEEDED', outputRefs: result.outputRefs, taskId: result.taskId, endedAt: now(), error: undefined }); task.error = null; task.metrics.noProgressSteps = 0; task.metrics.repairSuccesses += task.metrics.repairAttempts > 0 ? 1 : 0; if (!this.save(task, token)) return 'CANCELLED';
      this.addMessage(task.id, 'assistant', `步骤完成：${step.title}`, { stepId: step.id, outputRefs: result.outputRefs, taskId: result.taskId });
      return 'DONE';
    } catch (error) {
      if (!this.owned(task.id, token)) return 'CANCELLED';
      const message = error instanceof Error ? error.message.slice(0, 2000) : String(error).slice(0, 2000);
      this.immediate(() => { if (!this.owned(task.id, token)) throw new AutopilotError('失败结果发布前租约失效', 'AUTOPILOT_LEASE_LOST', 409); this.storeStepResult(task.id, step.id, key, { status: 'FAILED', outputRefs: [], error: message }); });
      task = this.require(task.id); this.updateStep(task, step.id, { status: 'FAILED', endedAt: now(), error: message }); task.error = message;
      const transient = /timeout|timed out|temporar|transient|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|rate.?limit|429|502|503|504|超时|暂时/i.test(message);
      const withinBudget = task.metrics.repairAttempts < Math.min(step.retries, task.contract?.budget.maxRepairAttempts ?? 0)
        && task.metrics.noProgressSteps + 1 < this.maxNoProgressSteps;
      const availableTools = step.kind === 'analyze' && this.workflow?.available
        ? (await Promise.all(task.intent.requiredCapabilities.map(async capability => {
          try { return await this.workflow!.available!(capability) ? `analyzer:${capability}` : undefined; } catch { return undefined; }
        }))).filter((tool): tool is string => Boolean(tool))
        : step.kind === 'analyze' ? [] : [step.tool];
      const replanned = withinBudget ? replanAutopilotPlan(task.plan!, task.intent, task.contract!, { failedStepId: step.id, reason: transient ? '临时失败' : '真实执行失败', allowRetry: transient || ['build', 'test'].includes(step.kind), availableTools }) : { plan: task.plan!, changed: false };
      if (replanned.changed) {
        task.plan = replanned.plan; task.planVersion = task.plan.version; task.metrics.repairAttempts++; task.metrics.noProgressSteps++; task.status = 'RUNNING'; task.stateVersion++;
        const failure: ReplanFailure = { stepId: step.id, reason: transient ? '临时失败' : '真实执行失败', error: message, failedTool: replanned.previousTool!, replacementTool: replanned.replacementTool!, failedTaskId: step.taskId, retryStepId: replanned.retryStepId!, occurredAt: now(), planVersion: task.planVersion, stateVersion: task.stateVersion };
        const history = [...(parse<Checkpoint>(task.checkpoint || '{}').replanHistory ?? []), failure].slice(-20);
        this.checkpoint(task, { resumeStatus: 'RUNNING', stepId: replanned.retryStepId, lastFailure: failure, replanHistory: history });
        if (!this.save(task, token)) return 'CANCELLED';
        this.addMessage(task.id, 'system', `重规划步骤 ${step.id} → ${replanned.retryStepId}：${replanned.previousTool} → ${replanned.replacementTool}；保留原失败证据 ${message}`, { stepId: step.id, retryStepId: replanned.retryStepId, failure });
        return 'RETRY';
      }
      task.metrics.noProgressSteps++; task.status = withinBudget ? 'BLOCKED' : 'FAILED'; task.metrics.endedAt = now();
      const terminalFailure: ReplanFailure = { stepId: step.id, reason: withinBudget ? '无运行时可用且已声明的替代工具' : '重规划预算或无进展熔断已用尽', error: message, failedTool: step.tool, replacementTool: '', failedTaskId: step.taskId, occurredAt: now(), planVersion: task.planVersion, stateVersion: task.stateVersion + 1 };
      const terminalHistory = [...(parse<Checkpoint>(task.checkpoint || '{}').replanHistory ?? []), terminalFailure].slice(-20);
      this.checkpoint(task, { resumeStatus: task.status, stepId: step.id, lastFailure: terminalFailure, replanHistory: terminalHistory });
      if (!this.save(task, token)) return 'CANCELLED'; this.addMessage(task.id, 'system', `步骤失败：${step.title} — ${message}`, { stepId: step.id, failure: terminalFailure }); return 'DONE';
    }
  }

  private async executeAnalyzer(task: AutopilotTask, step: AutopilotStep, token: string, signal: AbortSignal): Promise<Omit<StepResult, 'status'>> {
    const workflow = this.workflow; if (!workflow) throw new AutopilotError('未配置 WorkflowEngine，无法执行真实分析器', 'AUTOPILOT_WORKFLOW_MISSING', 503);
    const adapter = step.tool.slice('analyzer:'.length) as AdapterName;
    if (!task.intent.requiredCapabilities.includes(adapter) || !task.contract?.allowedOperations.includes('execute-analyzer')) throw new AutopilotError('分析器超出目标契约授权范围', 'AUTOPILOT_FORBIDDEN', 403);
    let child = step.taskId ? this.db.getTask(step.taskId) : undefined;
    if (!child) {
      const options: JsonObject = {};
      const uploadId = task.intent.inputs.uploadIds[0] ?? (Array.isArray(task.answers.materials) ? task.answers.materials.find((item): item is string => typeof item === 'string' && this.db.uploads(task.projectId).some(upload => upload.id === item)) : undefined);
      const directPath = task.intent.inputs.paths[0] ?? (Array.isArray(task.answers.materials) ? task.answers.materials.find((item): item is string => typeof item === 'string' && path.isAbsolute(item)) : undefined);
      if (uploadId) options.uploadId = uploadId; else if (directPath) options.path = directPath;
      if (task.intent.inputs.urls[0] && !this.db.getProject(task.projectId)?.target) this.db.raw.prepare("UPDATE projects SET target=? WHERE id=? AND target=''").run(task.intent.inputs.urls[0], task.projectId);
      child = await workflow.create(task.projectId, { adapter, options });
      if (!this.owned(task.id, token)) { this.workflow?.cancel?.(child.id); throw new AutopilotError('子任务创建后 Autopilot 租约已失效', 'AUTOPILOT_LEASE_LOST', 409); }
      task = this.require(task.id); this.updateStep(task, step.id, { taskId: child.id }); if (!this.save(task, token)) { this.workflow?.cancel?.(child.id); throw new AutopilotError('子任务绑定发布时租约失效', 'AUTOPILOT_LEASE_LOST', 409); }
    }
    await workflow.execute(child.id);
    const timeout = Math.min(step.budget.timeoutMs, task.contract?.budget.timeoutMs ?? step.budget.timeoutMs); const deadline = Date.now() + timeout;
    while (Date.now() < deadline && !signal.aborted) {
      const current = this.db.getTask(child.id); if (!current) throw new AutopilotError('子任务记录丢失', 'AUTOPILOT_CHILD_MISSING', 500);
      if (['COMPLETED', 'PARTIAL_SUCCESS', 'FAILED', 'BLOCKED', 'CANCELLED'].includes(current.status)) {
        if (!['COMPLETED', 'PARTIAL_SUCCESS'].includes(current.status)) throw new AutopilotError(`子任务真实终态为 ${current.status}: ${current.error ?? '无错误详情'}`, 'AUTOPILOT_CHILD_FAILED', 422);
        const artifacts = this.db.artifacts(child.id).flatMap(artifact => { const storedPath = this.db.artifactPath(child.id, artifact.name); return storedPath ? [{ name: artifact.name, path: storedPath, sourceTask: child.id, version: '1.0.0', status: 'verified-workflow-artifact', platforms: [], conditions: [], size: artifact.size, sha256: artifact.sha256 }] : []; });
        return { outputRefs: artifacts.map(item => item.path), taskId: child.id, artifacts, checks: [{ name: `workflow:${adapter}`, passed: true, evidence: `child task ${child.id} status ${current.status}` }], summary: `${adapter} 分析真实完成` };
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))));
    }
    throw new AutopilotError('等待子任务真实终态超时', 'AUTOPILOT_CHILD_TIMEOUT', 408);
  }

  private dependencyResult(task: AutopilotTask, step: AutopilotStep, index = 0): StepResult | undefined { const id = step.dependsOn[index]; return id ? this.stepResult(task.id, id) : undefined; }
  private allDependencyRefs(task: AutopilotTask, step: AutopilotStep): string[] {
    const refs: string[] = []; const visited = new Set<string>();
    const visit = (id: string): void => { if (visited.has(id)) return; visited.add(id); const result = this.stepResult(task.id, id); if (result) refs.push(...result.outputRefs); for (const dependency of task.plan?.steps.find(item => item.id === id)?.dependsOn ?? []) visit(dependency); };
    for (const id of step.dependsOn) visit(id); return [...new Set(refs)];
  }
  private async executeLocal(task: AutopilotTask, step: AutopilotStep, cwd: string, signal: AbortSignal): Promise<Omit<StepResult, 'status'>> {
    let input: JsonObject;
    switch (step.tool) {
      case 'reconstruct:static-site': input = { goal: task.contract?.userGoal ?? task.prompt, title: task.intent.objectives[0]?.slice(0, 120) }; break;
      case 'build:static-site': { const refs = this.dependencyResult(task, step)?.outputRefs ?? []; const index = refs.find(file => path.basename(file) === 'index.html'); if (!index) throw new AutopilotError('缺少静态站点源 index.html', 'AUTOPILOT_ARTIFACT_MISSING', 422); input = { sourceDir: path.dirname(index) }; break; }
      case 'test:static-site': input = { files: this.dependencyResult(task, step)?.outputRefs ?? [] }; break;
      case 'package:static-site': { const testId = step.dependsOn[0]; const buildId = task.plan?.steps.find(item => item.id === testId)?.dependsOn[0]; input = { files: (buildId ? this.stepResult(task.id, buildId)?.outputRefs ?? [] : []) }; break; }
      case 'document:delivery': input = { goal: task.contract?.userGoal ?? task.prompt, completed: task.plan?.steps.filter(item => item.status === 'SUCCEEDED').map(item => item.title) ?? [], incomplete: task.contract?.knownLimitations ?? [] }; break;
      case 'verify:delivery': input = { files: this.allDependencyRefs(task, step), checks: step.dependsOn.flatMap(id => this.stepResult(task.id, id)?.checks ?? []) }; break;
      case 'reconstruct:workspace': input = { goal: task.contract?.userGoal ?? task.prompt }; break;
      case 'build:allowlisted': case 'test:allowlisted': case 'package:allowlisted': input = { cwd }; break;
      default: throw new AutopilotError(`本地工具未实现: ${step.tool}`, 'TOOL_UNAVAILABLE', 503);
    }
    const contract = task.contract!;
    const result = await this.tools.invoke(step.tool, input, { permissions: contract.allowedOperations, budget: { timeoutMs: Math.min(step.budget.timeoutMs, contract.budget.timeoutMs), maxDiskMB: Math.min(step.budget.maxDiskMB, contract.budget.maxDiskMB) }, cwd, workspaceRoot: path.join(this.options.dataDir, 'autopilot', task.id), taskId: task.id, projectId: task.projectId, signal });
    const outputRefs = Array.isArray(result.outputRefs) ? result.outputRefs.filter((item): item is string => typeof item === 'string') : [];
    const checks = Array.isArray(result.checks) ? result.checks.filter((item): item is JsonObject => Boolean(item && typeof item === 'object')) .map(item => ({ name: String(item.name ?? 'tool-check'), passed: item.passed === true, evidence: String(item.evidence ?? step.tool) })) : [{ name: step.tool, passed: true, evidence: '工具真实返回成功' }];
    return { outputRefs, checks, summary: typeof result.summary === 'string' ? result.summary : `${step.tool} 真实完成` };
  }

  private async finishDelivery(id: string, token: string): Promise<void> {
    if (!this.owned(id, token)) return; let task = this.require(id);
    const artifacts: StoredArtifact[] = [];
    for (const step of task.plan?.steps ?? []) {
      const result = this.stepResult(id, step.id); if (!result) continue;
      if (result.artifacts) artifacts.push(...result.artifacts);
      else for (const ref of result.outputRefs) artifacts.push({ name: `${step.id}/${path.basename(ref)}`, path: ref, sourceTask: id, version: String(task.planVersion), status: 'generated', platforms: task.intent.targetPlatform ? [task.intent.targetPlatform] : [], conditions: [] });
    }
    const unique = [...new Map(artifacts.map(item => [`${item.sourceTask}:${item.path}`, item])).values()];
    const checks = task.plan?.steps.flatMap(step => this.stepResult(id, step.id)?.checks ?? []) ?? [];
    const deliveryDir = path.join(this.options.dataDir, 'autopilot', id, 'artifacts');
    const manifest = await createDeliveryPackage(deliveryDir, {
      taskId: id, originalGoal: task.contract?.userGoal ?? task.prompt, completed: task.plan?.steps.filter(step => step.status === 'SUCCEEDED').map(step => step.title) ?? [], incomplete: task.contract?.knownLimitations ?? [],
      artifacts: unique as DeliveryArtifactSource[], checks, limitations: task.contract?.knownLimitations ?? [], risks: task.intent.risks, deployment: task.intent.targetPlatform === 'Web' ? '直接打开发布包 artifacts 中的 index.html；也可将整个 artefacts 目录托管到任意静态服务器。' : '请按照来源工件与构建说明部署；未执行构建的产物不得声称可运行。',
    });
    if (!this.owned(id, token)) return; this.publishDeliveryArtifacts(id); task = this.require(id); task.status = manifest.acceptance.status === 'DELIVERABLE_VERIFIED' ? 'COMPLETED' : 'PARTIAL_SUCCESS'; task.metrics.endedAt = now(); task.stateVersion++; this.checkpoint(task, { resumeStatus: task.status, stepId: undefined }); if (!this.save(task, token)) return; this.addMessage(id, 'assistant', `交付包已生成：${manifest.acceptance.status}`, { acceptance: manifest.acceptance, outputDir: deliveryDir });
  }

  async deliver(id: string): Promise<AutopilotTask> {
    const task = this.require(id); if (!task.contract || !task.plan) throw new AutopilotError('任务没有可交付计划', 'AUTOPILOT_PLAN_MISSING', 409);
    if (!['COMPLETED', 'PARTIAL_SUCCESS'].includes(task.status)) throw new AutopilotError('仅完成或部分完成的任务可生成交付包', 'AUTOPILOT_STATE_CONFLICT', 409);
    await mkdir(path.join(this.options.dataDir, 'autopilot', id), { recursive: true });
    const token = this.claim(id, ['COMPLETED', 'PARTIAL_SUCCESS']);
    if (!token) throw new AutopilotError('交付任务租约繁忙', 'AUTOPILOT_LEASE_BUSY', 409);
    const previousStatus = task.status; const controller = new AbortController(); this.controllers.set(id, controller); this.startLeaseHeartbeat(id, token, controller);
    try { await this.finishDelivery(id, token); }
    catch (error) { const current = this.require(id); if (current.status === 'RUNNING') { current.status = previousStatus; current.stateVersion++; this.save(current); } throw error; }
    finally { this.stopLeaseHeartbeat(id); this.controllers.delete(id); this.release(id, token); }
    return this.require(id);
  }

  pause(id: string): boolean {
    const task = this.require(id); if (!['RUNNING', 'REPAIRING', 'PLANNING'].includes(task.status)) return false;
    this.controllers.get(id)?.abort(); this.stopLeaseHeartbeat(id); this.workflow?.pause?.(task.plan?.steps.find(step => step.status === 'RUNNING')?.taskId ?? '');
    this.immediate(() => { const row = this.db.raw.prepare("UPDATE autopilot_tasks SET status='PAUSED',lease_owner=NULL,lease_expires_at=NULL,state_version=state_version+1,checkpoint=?,updated_at=? WHERE id=? AND status IN ('RUNNING','REPAIRING','PLANNING') RETURNING id").get(JSON.stringify({ ...parse<Checkpoint>(task.checkpoint || '{}'), resumeStatus: 'PAUSED' }), now(), id) as { id: string } | undefined; if (!row) throw new AutopilotError('暂停请求未命中活跃租约', 'AUTOPILOT_LEASE_LOST', 409); });
    this.db.addEvent(id, 'autopilot.paused', { taskId: id }); this.addMessage(id, 'system', '任务已暂停，已完成步骤将复用。'); return true;
  }
  resume(id: string): boolean {
    const task = this.require(id); if (task.status !== 'PAUSED' || !task.plan) return false;
    const childId = task.plan.steps.find(step => step.status === 'RUNNING' && step.taskId)?.taskId;
    if (childId && this.workflow?.resume) {
      const child = this.db.getTask(childId);
      if (child?.status === 'PAUSED' && !this.workflow.resume(childId)) throw new AutopilotError('暂停的子任务恢复失败，Autopilot 保持暂停', 'AUTOPILOT_CHILD_RESUME_FAILED', 409);
    }
    this.immediate(() => { this.db.raw.prepare("UPDATE autopilot_tasks SET status='PLANNING',lease_owner=NULL,lease_expires_at=NULL,error=NULL,state_version=state_version+1,checkpoint=?,updated_at=? WHERE id=? AND status='PAUSED'").run(JSON.stringify({ ...parse<Checkpoint>(task.checkpoint || '{}'), resumeStatus: 'PLANNING', planApproved: true }), now(), id); });
    this.db.addEvent(id, 'autopilot.resumed', { taskId: id }); this.addMessage(id, 'system', '任务已恢复，将从首个未完成步骤继续。'); return true;
  }
  cancel(id: string): boolean {
    const task = this.require(id); if (['COMPLETED', 'CANCELLED', 'FAILED'].includes(task.status)) return false;
    this.controllers.get(id)?.abort(); this.stopLeaseHeartbeat(id); const childId = task.plan?.steps.find(step => step.status === 'RUNNING')?.taskId; if (childId) this.workflow?.cancel?.(childId);
    this.immediate(() => { this.db.raw.prepare("UPDATE autopilot_tasks SET status='CANCELLED',lease_owner=NULL,lease_expires_at=NULL,error='用户取消',state_version=state_version+1,checkpoint=?,updated_at=? WHERE id=? AND status<>'CANCELLED'").run(JSON.stringify({ ...parse<Checkpoint>(task.checkpoint || '{}'), resumeStatus: 'CANCELLED' }), now(), id); });
    this.db.addEvent(id, 'autopilot.cancelled', { taskId: id }); this.addMessage(id, 'system', '任务已取消。'); return true;
  }
  recover(): void {
    const timestamp = now(); const rows = this.db.raw.prepare("SELECT * FROM autopilot_tasks WHERE status IN ('RUNNING','REPAIRING') AND (lease_expires_at IS NULL OR lease_expires_at<=?)").all(timestamp) as unknown as AutopilotRow[];
    for (const row of rows) {
      const checkpoint = parse<Checkpoint>(row.checkpoint || '{}'); const status = checkpoint.resumeStatus === 'PAUSED' ? 'PAUSED' : 'PLANNING';
      const storedPlan = row.plan_json ? parse<AutopilotPlan>(row.plan_json) : null; let planChanged = false;
      if (storedPlan) for (const step of storedPlan.steps) {
        if (!step.taskId || this.stepResult(row.id, step.id)?.status === 'SUCCEEDED') continue;
        if (this.db.getTask(step.taskId)?.status === 'CANCELLED') { delete step.taskId; planChanged = true; }
      }
      this.immediate(() => { this.db.raw.prepare("UPDATE autopilot_tasks SET status=?,plan_json=?,lease_owner=NULL,lease_expires_at=NULL,state_version=state_version+1,updated_at=? WHERE id=? AND status IN ('RUNNING','REPAIRING') AND (lease_expires_at IS NULL OR lease_expires_at<=?)").run(status, planChanged ? JSON.stringify(storedPlan) : row.plan_json, timestamp, row.id, timestamp); });
      this.db.addEvent(row.id, 'autopilot.recovered', { taskId: row.id, recoveredAt: timestamp }); this.addMessage(row.id, 'system', '已恢复过期租约；未虚构步骤执行结果。', { recoveredAt: timestamp });
    }
    this.workflow?.recover?.();
  }
  start(): void {
    if (this.closed || this.timer) return;
    this.recover(); void this.tickOnce();
    this.timer = setInterval(() => { void this.tickOnce(); }, positive(this.options.pollMs ?? 500, 500, 'pollMs'));
    this.timer.unref();
  }
  async tickOnce(): Promise<void> {
    if (this.closed || this.ticking) return;
    this.ticking = true;
    try {
      this.recover();
      const row = this.db.raw.prepare("SELECT id FROM autopilot_tasks WHERE status='PLANNING' AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at<=?) ORDER BY created_at LIMIT 1").get(now()) as { id: string } | undefined;
      if (row) await this.run(row.id);
    } catch { /* run persists task failures; the next tick can recover later work */ }
    finally { this.ticking = false; }
  }
  async close(): Promise<void> {
    this.closed = true; if (this.timer) clearInterval(this.timer); this.timer = null;
    for (const id of this.leaseTimers.keys()) this.stopLeaseHeartbeat(id);
    for (const controller of this.controllers.values()) controller.abort();
    while (this.activeTasks.size || this.ticking) await new Promise(resolve => setTimeout(resolve, 10));
  }
}

export const createAutopilotEngine = (db: Database, options: AutopilotEngineOptions): AutopilotEngine => new AutopilotEngine(db, options);
export { AUTOPILOT_STATUSES };

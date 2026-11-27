import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Database, WorkflowEngine, type AdapterDefinition, type AdapterName } from '@reverse/workflow';
import {
  AutopilotEngine, ToolRegistry, createAutopilotPlan, createDefaultToolRegistry, createDeliveryPackage, createGoalContract, detectIntent,
  discoveryQuestions, mergeAnswers, nextUnansweredQuestion, parseModelIntent, runAllowlistedCommand, validateAutopilotPlan,
  verifyDelivery, type AutopilotTask, type WorkflowPort,
} from '../../packages/autopilot/src/index.js';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function tempDir(): Promise<string> { const dir = await mkdtemp(path.join(os.tmpdir(), 're-autopilot-')); dirs.push(dir); return dir; }
function adapter(name: AdapterName = 'website', failAnalyze = false): AdapterDefinition {
  return {
    name, version: 'test', description: `test ${name} adapter`, available: async () => ({ available: true, detail: 'ready' }),
    detect: async () => ({ adapter: name, confidence: 1, format: 'HTML', details: {}, limitations: [] }), prepare: async () => ({ prepared: true }),
    analyze: async () => { if (failAnalyze) throw new Error(`real ${name} analyzer failure`); return { analyzed: true }; }, extractEvidence: async () => ({ evidence: true }),
    reconstruct: async ctx => { await ctx.writeArtifact('analysis.txt', 'real workflow artifact', 'text/plain'); return { reconstructed: true }; },
    validate: async () => ({ passed: true, checks: [{ name: 'fixture', passed: true }] }),
  };
}
async function approvedTask(dataDir: string): Promise<{ db: Database; engine: AutopilotEngine; task: AutopilotTask }> {
  const db = new Database(':memory:'); const project = db.project({ name: 'autopilot', kind: 'website', target: 'https://example.test', authorizationConfirmed: true });
  const workflow = new WorkflowEngine(db, { dataDir, adapters: [adapter(), adapter('file')], pollMs: 100_000 });
  const engine = new AutopilotEngine(db, { dataDir, workflow });
  const task = await engine.create({ projectId: project.id, prompt: 'Rebuild https://example.test as a static website and deploy it', idempotencyKey: 'approved-task' });
  engine.submitAnswers(task.id, { answers: { authorizationConfirmed: true }, approveContract: true, approvePlan: true });
  return { db, engine, task: engine.require(task.id) };
}
async function replanTask(dataDir: string, adapters: AdapterDefinition[], prompt = 'Rebuild https://example.test as a static website and deploy it', answers: Record<string, unknown> = { authorizationConfirmed: true }): Promise<{ db: Database; engine: AutopilotEngine; task: AutopilotTask }> {
  const db = new Database(':memory:'); const project = db.project({ name: 'autopilot', kind: 'website', target: 'https://example.test', authorizationConfirmed: true });
  const workflow: WorkflowPort = {
    available: adapter => adapters.some(item => item.name === adapter),
    create: async (projectId, input) => db.createTask(projectId, input.adapter, input, randomUUID()),
    execute: async taskId => {
      const child = db.getTask(taskId); if (!child) throw new Error('missing child');
      const definition = adapters.find(item => item.name === child.adapter);
      db.updateTask(taskId, { status: 'RUNNING' });
      if (!definition) { db.updateTask(taskId, { status: 'BLOCKED', error: `Adapter ${child.adapter} is not installed` }); return; }
      try {
        if (definition.analyze) await definition.analyze({} as never);
        const file = path.join(dataDir, `${taskId}.txt`); const content = `real ${child.adapter} artifact`; await writeFile(file, content);
        db.raw.prepare('INSERT INTO artifacts (id,task_id,name,stored_path,size,sha256,mime,created_at) VALUES (?,?,?,?,?,?,?,?)').run(randomUUID(), taskId, 'analysis.txt', file, Buffer.byteLength(content), createHash('sha256').update(content).digest('hex'), 'text/plain', new Date().toISOString());
        db.updateTask(taskId, { status: 'COMPLETED' });
      } catch (error) { db.updateTask(taskId, { status: 'FAILED', error: error instanceof Error ? error.message : String(error) }); }
    },
  };
  const engine = new AutopilotEngine(db, { dataDir, workflow });
  const task = await engine.create({ projectId: project.id, prompt, idempotencyKey: randomKey() });
  engine.submitAnswers(task.id, { answers, approveContract: true, approvePlan: true });
  return { db, engine, task: engine.require(task.id) };
}
function randomKey(): string { return `replan-${Math.random()}`; }

describe('autopilot intent and discovery', () => {
  it('recognizes Chinese and English intents, multiple objectives, URLs and platforms', () => {
    const zh = detectIntent('恢复这个旧软件的数据；并生成网站 https://example.test，部署到 Web');
    expect(zh.kind).toBe('data-recovery');
    expect(zh.objectives.length).toBeGreaterThanOrEqual(2);
    expect(zh.inputs.urls).toContain('https://example.test');
    expect(zh.targetPlatform).toBe('Web');
    const en = detectIntent('Rebuild the website https://example.test for iOS and deploy it');
    expect(en.kind).toBe('website-rebuild');
    expect(en.targetPlatform).toBe('iOS');
    expect(en.delivery).toContain('deployment-package');
  });

  it('asks only missing dynamic questions and never repeats answered fields', () => {
    const intent = detectIntent('Rebuild https://example.test as a static website');
    const first = discoveryQuestions(intent, {});
    expect(first.map(question => question.id)).toEqual(['permission.authorization']);
    expect(nextUnansweredQuestion(first, {})?.id).toBe('permission.authorization');
    const answers = mergeAnswers({}, { authorizationConfirmed: 'true', freeText: '同意授权' }, first);
    expect(answers.authorizationConfirmed).toBe(true);
    expect(discoveryQuestions(intent, answers)).toEqual([]);
    const recovery = detectIntent('恢复数据');
    expect(discoveryQuestions(recovery, {}).map(question => question.id)).toEqual(expect.arrayContaining(['target', 'materials', 'platform', 'permission.authorization']));
  });

  it('validates model intent output and never treats it as authorization', () => {
    const intent = detectIntent('分析固件');
    expect(parseModelIntent(intent)).toMatchObject({ kind: 'firmware-analysis', source: 'rules' });
    expect(() => parseModelIntent({ kind: 'firmware-analysis' })).toThrow(/missing/);
  });
});

describe('autopilot planning and tools', () => {
  it('builds dependency-aware plans without forcing decompilation for data recovery', () => {
    const recoveryIntent = detectIntent('恢复数据');
    const recoveryContract = createGoalContract(recoveryIntent, { authorizationConfirmed: true, target: '/tmp/disk.img', materials: ['/tmp/disk.img'], targetPlatform: 'Windows' });
    const recovery = createAutopilotPlan(recoveryIntent, recoveryContract);
    expect(recovery.steps.map(step => step.kind)).toEqual(['analyze', 'document', 'verify']);
    expect(recovery.steps.some(step => step.tool.includes('decompil') || step.tool.includes('ghidra'))).toBe(false);
    validateAutopilotPlan(recovery);
  });

  it('requires build/test/package/document for deployment targets', () => {
    const intent = detectIntent('Rebuild https://example.test as a static website and deploy it');
    const contract = createGoalContract(intent, { authorizationConfirmed: true });
    const plan = createAutopilotPlan(intent, contract);
    expect(plan.steps.map(step => step.kind)).toEqual(expect.arrayContaining(['build', 'test', 'package', 'document', 'verify']));
    expect(plan.steps.find(step => step.kind === 'package')?.dependsOn).toContain('test-delivery');
    expect(plan.steps.find(step => step.kind === 'verify')?.dependsOn).toEqual(expect.arrayContaining(['package-delivery', 'document-delivery']));
  });

  it('enforces tool schemas, permissions, isolated cwd and command allowlist', async () => {
    const dataDir = await tempDir(); const registry = createDefaultToolRegistry();
    await expect(registry.invoke('reconstruct:static-site', {}, { permissions: ['write-task-artifacts'], budget: { timeoutMs: 1000, maxDiskMB: 10 }, cwd: path.join(dataDir, 'work'), workspaceRoot: dataDir, taskId: 't', projectId: 'p' })).rejects.toThrow(/必填|missing|required/i);
    await expect(registry.invoke('reconstruct:static-site', { goal: 'x' }, { permissions: [], budget: { timeoutMs: 1000, maxDiskMB: 10 }, cwd: path.join(dataDir, 'work'), workspaceRoot: dataDir, taskId: 't', projectId: 'p' })).rejects.toThrow(/权限|FORBIDDEN/);
    await expect(runAllowlistedCommand('rm' as 'build', dataDir, dataDir, { timeoutMs: 1000, maxDiskMB: 10 })).rejects.toThrow(/仅允许/);
    await expect(runAllowlistedCommand('build', os.homedir(), dataDir, { timeoutMs: 1000, maxDiskMB: 10 })).rejects.toThrow(/隔离工作区/);
    expect(new ToolRegistry().list()).toEqual([]);
  });
});

describe('durable autopilot engine', () => {
  it('enables JADX for the Android APK analyzer in the real Autopilot main chain', async () => {
    const dataDir = await tempDir();
    const apkPath = path.join(dataDir, 'sample.apk');
    const { db, engine } = await replanTask(dataDir, [adapter('file'), adapter('apk')], 'Rebuild this Android APK as an independent app and deploy it', { authorizationConfirmed: true, materials: [apkPath], targetPlatform: 'Android', allowBuild: true });
    await engine.run(engine.list()[0]!.id);
    const row = db.raw.prepare("SELECT options_json FROM tasks WHERE adapter='apk'").get() as { options_json: string } | undefined;
    expect(row).toBeDefined();
    expect(JSON.parse(row!.options_json)).toMatchObject({ path: apkPath, apkDecompile: true });
  });

  it('persists idempotent creation and rejects key reuse with another prompt', async () => {
    const dataDir = await tempDir(); const db = new Database(':memory:'); const project = db.project({ name: 'p', kind: 'website', authorizationConfirmed: true });
    const engine = new AutopilotEngine(db, { dataDir });
    const first = await engine.create({ projectId: project.id, prompt: 'Rebuild https://example.test website', idempotencyKey: 'same' });
    const second = await engine.create({ projectId: project.id, prompt: 'Rebuild https://example.test website', idempotencyKey: 'same' });
    expect(second.id).toBe(first.id);
    await expect(engine.create({ projectId: project.id, prompt: 'different', idempotencyKey: 'same' })).rejects.toThrow(/幂等键/);
    expect(db.raw.prepare('SELECT COUNT(*) count FROM autopilot_tasks').get()).toEqual({ count: 1 });
  });

  it('blocks unauthorized work and never invents a plan or child task', async () => {
    const dataDir = await tempDir(); const db = new Database(':memory:'); const project = db.project({ name: 'p', kind: 'website', target: 'https://example.test', authorizationConfirmed: true });
    const engine = new AutopilotEngine(db, { dataDir });
    const task = await engine.create({ projectId: project.id, prompt: 'Rebuild https://example.test website' });
    const blocked = engine.submitAnswers(task.id, { answers: { authorizationConfirmed: false }, approveContract: true, approvePlan: true });
    expect(blocked.status).toBe('BLOCKED');
    expect(blocked.plan).toBeNull();
    expect(db.raw.prepare('SELECT COUNT(*) count FROM tasks').get()).toEqual({ count: 0 });
    await expect(engine.run(task.id)).rejects.toThrow(/契约|计划/);
  });

  it('recovers expired leases and resumes without rerunning completed steps', async () => {
    const dataDir = await tempDir(); const { db, engine, task } = await approvedTask(dataDir);
    db.raw.prepare("UPDATE autopilot_tasks SET status='RUNNING',lease_owner='dead-worker',lease_expires_at='2000-01-01T00:00:00.000Z',checkpoint=? WHERE id=?").run(JSON.stringify({ resumeStatus: 'RUNNING', planApproved: true }), task.id);
    const restarted = new AutopilotEngine(db, { dataDir, workflow: engine.workflow });
    restarted.recover();
    expect(restarted.require(task.id).status).toBe('PLANNING');
    expect(restarted.require(task.id).leaseOwner).toBeNull();
    const completed = await restarted.run(task.id);
    expect(completed.status).toBe('COMPLETED');
    const count = db.raw.prepare('SELECT COUNT(*) count FROM autopilot_step_results WHERE task_id=? AND status=\'SUCCEEDED\'').get(task.id);
    expect(Number((count as { count: number }).count)).toBe(completed.plan?.steps.length);
    const childCount = db.raw.prepare('SELECT COUNT(*) count FROM tasks WHERE project_id=?').get(task.projectId);
    expect(Number((childCount as { count: number }).count)).toBe(1);
  });

  it('persists task state across SQLite close and reopen', async () => {
    const dataDir = await tempDir(); const file = path.join(dataDir, 'state.sqlite'); let db = new Database(file);
    const project = db.project({ name: 'persistent', kind: 'website', authorizationConfirmed: true });
    const engine = new AutopilotEngine(db, { dataDir }); const created = await engine.create({ projectId: project.id, prompt: 'Rebuild https://example.test website', idempotencyKey: 'persistent-key' });
    db.raw.exec('DROP TABLE autopilot_artifacts'); db.close(); db = new Database(file);
    expect(db.raw.isOpen).toBe(true);
    expect(db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='autopilot_artifacts'").get()).toEqual({ name: 'autopilot_artifacts' });
    expect(new AutopilotEngine(db, { dataDir }).get(created.id)).toMatchObject({ id: created.id, status: created.status, idempotencyKey: 'persistent-key' });
    db.close();
  });

  it('reuses a persisted successful step instead of creating a duplicate child task', async () => {
    const dataDir = await tempDir(); const { db, engine, task } = await approvedTask(dataDir); const first = task.plan!.steps[0]!;
    const artifact = path.join(dataDir, 'analysis.txt'); await writeFile(artifact, 'already completed');
    const output = { status: 'SUCCEEDED', outputRefs: [artifact], artifacts: [{ name: 'analysis.txt', path: artifact, sourceTask: 'prior-child', version: '1', status: 'verified', platforms: [], conditions: [] }], checks: [{ name: 'workflow:website', passed: true, evidence: 'persisted prior result' }], summary: 'reused' };
    db.raw.prepare("INSERT INTO autopilot_step_results (task_id,step_id,idempotency_key,status,output_json,created_at) VALUES (?,?,?,'SUCCEEDED',?,?)").run(task.id, first.id, `${task.id}:prior`, JSON.stringify(output), new Date().toISOString());
    first.status = 'SUCCEEDED'; first.outputRefs = [artifact]; db.raw.prepare('UPDATE autopilot_tasks SET plan_json=? WHERE id=?').run(JSON.stringify(task.plan), task.id);
    const completed = await engine.run(task.id);
    expect(completed.status, completed.error ?? '').toBe('COMPLETED');
    expect(db.raw.prepare('SELECT COUNT(*) count FROM tasks WHERE project_id=?').get(task.projectId)).toEqual({ count: 0 });
    expect(completed.plan?.steps.find(step => step.id === first.id)?.attempt).toBe(0);
  });

  it('replans a failed analyzer to a declared alternative and reuses completed steps and artifacts', async () => {
    const dataDir = await tempDir();
    const { db, engine, task } = await replanTask(dataDir, [adapter('website', true), adapter('file')], 'Rebuild https://example.test as a static website and deploy it；保留已有分析证据');
    expect(task.plan?.steps.filter(step => step.kind === 'analyze')).toHaveLength(2);
    const first = task.plan!.steps[0]!; const artifact = path.join(dataDir, 'prior-analysis.txt'); await writeFile(artifact, 'prior real evidence');
    const prior = { status: 'SUCCEEDED', outputRefs: [artifact], artifacts: [{ name: 'prior-analysis.txt', path: artifact, sourceTask: 'prior-child', version: '1', status: 'verified', platforms: [], conditions: [] }], checks: [{ name: 'workflow:file', passed: true, evidence: 'persisted prior result' }], summary: 'reused after recovery' };
    db.raw.prepare("INSERT INTO autopilot_step_results (task_id,step_id,idempotency_key,status,output_json,created_at) VALUES (?,?,?,'SUCCEEDED',?,?)").run(task.id, first.id, `${task.id}:prior`, JSON.stringify(prior), new Date().toISOString());
    first.status = 'SUCCEEDED'; first.outputRefs = [artifact]; db.raw.prepare('UPDATE autopilot_tasks SET plan_json=? WHERE id=?').run(JSON.stringify(task.plan), task.id);
    const completed = await engine.run(task.id);
    expect(completed.status, completed.error ?? '').toBe('COMPLETED');
    expect(completed.planVersion).toBe(task.planVersion + 1);
    expect(completed.stateVersion).toBeGreaterThan(task.stateVersion);
    expect(completed.plan?.steps.find(step => step.id === first.id)?.attempt).toBe(0);
    const originalFailed = completed.plan!.steps.find(item => item.id === task.plan!.steps[1]!.id)!;
    const retry = completed.plan!.steps.find(item => item.id === `${originalFailed.id}-retry-v${task.planVersion + 1}`)!;
    expect(originalFailed.status).toBe('FAILED'); expect(retry.status).toBe('SUCCEEDED'); expect(retry.tool).toBe('analyzer:file');
    expect(db.raw.prepare("SELECT status FROM autopilot_step_results WHERE task_id=? AND step_id=?").get(task.id, originalFailed.id)).toEqual({ status: 'FAILED' });
    expect(db.raw.prepare("SELECT status FROM autopilot_step_results WHERE task_id=? AND step_id=?").get(task.id, retry.id)).toEqual({ status: 'SUCCEEDED' });
    const children = db.raw.prepare('SELECT adapter,status FROM tasks WHERE project_id=? ORDER BY created_at').all(task.projectId) as { adapter: string; status: string }[];
    expect(children.map(child => child.adapter)).toEqual(['website', 'file']);
    expect(children[0]?.status).toBe('FAILED');
    expect(children[1]?.status).toBe('COMPLETED');
    const checkpoint = JSON.parse(completed.checkpoint);
    expect(checkpoint.lastFailure).toMatchObject({ stepId: task.plan!.steps[1]!.id, failedTool: 'analyzer:website', replacementTool: 'analyzer:file' });
    expect(checkpoint.lastFailure.error).toContain('real website analyzer failure');
    expect(checkpoint.lastFailure.occurredAt).toBeTruthy();
    expect(checkpoint.replanHistory).toHaveLength(1);
    expect(checkpoint.lastFailure.retryStepId).toBe(retry.id);
    expect(completed.metrics.repairAttempts).toBe(1);
    expect(completed.plan?.steps.filter(step => step.status === 'SUCCEEDED')).toHaveLength(task.plan!.steps.length);
    expect(completed.plan?.steps.find(step => step.id === first.id)?.outputRefs).toEqual([artifact]);
  });

  it('fails honestly without a declared alternative and preserves real failure evidence', async () => {
    const dataDir = await tempDir(); const { db, engine, task } = await replanTask(dataDir, [adapter('website', true)]);
    task.intent.requiredCapabilities = ['website']; db.raw.prepare('UPDATE autopilot_tasks SET intent_json=? WHERE id=?').run(JSON.stringify(task.intent), task.id);
    const failed = await engine.run(task.id);
    expect(failed.status).toBe('BLOCKED'); expect(failed.planVersion).toBe(task.planVersion);
    expect(failed.error).toContain('real website analyzer failure');
    expect(db.raw.prepare('SELECT COUNT(*) count FROM tasks WHERE project_id=?').get(task.projectId)).toEqual({ count: 1 });
    const stored = db.raw.prepare("SELECT output_json FROM autopilot_step_results WHERE task_id=? AND status='FAILED'").get(task.id) as { output_json: string };
    expect(JSON.parse(stored.output_json).error).toContain('real website analyzer failure');
    expect(JSON.parse(failed.checkpoint).lastFailure).toMatchObject({ replacementTool: '', reason: '无运行时可用且已声明的替代工具' });
  });

  it('blocks an unavailable replacement even when it is statically declared', async () => {
    const dataDir = await tempDir(); const { engine, task } = await replanTask(dataDir, [adapter('website', true), adapter('file')]);
    const workflow = engine.workflow!; workflow.available = async adapter => adapter === 'website';
    const blocked = await engine.run(task.id);
    expect(blocked.status).toBe('BLOCKED'); expect(blocked.planVersion).toBe(task.planVersion);
    expect(JSON.parse(blocked.checkpoint).lastFailure).toMatchObject({ stepId: task.plan!.steps[0]!.id, replacementTool: '' });
  });

  it('rejects a replacement outside the authorized capabilities without invoking it', async () => {
    const dataDir = await tempDir(); const { db, engine, task } = await replanTask(dataDir, [adapter('website', true), adapter('file')]);
    task.intent.requiredCapabilities = ['website']; db.raw.prepare('UPDATE autopilot_tasks SET intent_json=? WHERE id=?').run(JSON.stringify(task.intent), task.id);
    const blocked = await engine.run(task.id);
    expect(blocked.status).toBe('BLOCKED');
    expect(db.raw.prepare('SELECT COUNT(*) count FROM tasks WHERE project_id=?').get(task.projectId)).toEqual({ count: 1 });
    expect(JSON.parse(blocked.checkpoint).lastFailure.error).toContain('real website analyzer failure');
  });

  it('stops at the repair budget and retains earlier failure and successful evidence', async () => {
    const dataDir = await tempDir(); const { db, engine, task } = await replanTask(dataDir, [adapter('website', true), adapter('file', true)]);
    task.contract!.budget.maxRepairAttempts = 1; task.plan!.steps.forEach(step => { step.retries = 1; });
    db.raw.prepare('UPDATE autopilot_tasks SET contract_json=?,plan_json=? WHERE id=?').run(JSON.stringify(task.contract), JSON.stringify(task.plan), task.id);
    const failed = await engine.run(task.id);
    expect(failed.status).toBe('FAILED'); expect(failed.planVersion).toBe(task.planVersion + 1);
    expect(failed.metrics.repairAttempts).toBe(1);
    const children = db.raw.prepare('SELECT adapter,status,error FROM tasks WHERE project_id=? ORDER BY created_at').all(task.projectId);
    expect(children).toHaveLength(2);
    const checkpoint = JSON.parse(failed.checkpoint);
    expect(checkpoint.replanHistory).toHaveLength(2);
    expect(checkpoint.lastFailure.error).toContain('real file analyzer failure');
    expect(checkpoint.lastFailure.reason).toContain('预算');
  });

  it('bounds transient analyzer retries and never treats failed child output as success', async () => {
    const dataDir = await tempDir(); let calls = 0;
    const flaky = adapter('website'); flaky.analyze = async () => { calls++; if (calls === 1) throw new Error('temporary timeout'); return { analyzed: true }; };
    const { db, engine, task } = await replanTask(dataDir, [flaky]);
    task.intent.requiredCapabilities = ['website']; db.raw.prepare('UPDATE autopilot_tasks SET intent_json=? WHERE id=?').run(JSON.stringify(task.intent), task.id);
    const completed = await engine.run(task.id);
    expect(completed.status, completed.error ?? '').toBe('COMPLETED');
    expect(calls).toBe(2); expect(completed.planVersion).toBe(task.planVersion + 1);
    expect(completed.plan?.steps[0]?.attempt).toBe(1);
    expect(completed.plan?.steps[0]?.status).toBe('FAILED');
    expect(completed.plan?.steps.find(step => step.id === `${task.plan!.steps[0]!.id}-retry-v${task.planVersion + 1}`)?.attempt).toBe(1);
    expect(JSON.parse(completed.checkpoint).lastFailure).toMatchObject({ failedTool: 'analyzer:website', replacementTool: 'analyzer:website', reason: '临时失败' });
    expect(db.raw.prepare('SELECT COUNT(*) count FROM tasks WHERE project_id=?').get(task.projectId)).toEqual({ count: 2 });
  });

  it('renews the lease beyond one lease period without duplicating child workflows or steps', async () => {
    const dataDir = await tempDir(); const db = new Database(':memory:'); const project = db.project({ name: 'autopilot', kind: 'website', target: 'https://example.test', authorizationConfirmed: true });
    const slow = adapter(); slow.analyze = async () => { await new Promise(resolve => setTimeout(resolve, 180)); return { analyzed: true }; };
    const workflow = new WorkflowEngine(db, { dataDir, adapters: [slow], pollMs: 100_000 });
    const engine = new AutopilotEngine(db, { dataDir, workflow, leaseMs: 50, pollMs: 5 });
    const task = await engine.create({ projectId: project.id, prompt: 'Rebuild https://example.test as a static website and deploy it' });
    engine.submitAnswers(task.id, { answers: { authorizationConfirmed: true }, approveContract: true, approvePlan: true });
    const running = engine.run(task.id); await new Promise(resolve => setTimeout(resolve, 100)); engine.recover();
    const completed = await running;
    expect(completed.status, completed.error ?? '').toBe('COMPLETED');
    expect(db.raw.prepare('SELECT COUNT(*) count FROM tasks WHERE project_id=?').get(task.projectId)).toEqual({ count: 1 });
    expect(db.raw.prepare('SELECT COUNT(*) count FROM autopilot_step_results WHERE task_id=?').get(task.id)).toEqual({ count: completed.plan?.steps.length });
    expect(completed.plan?.steps.every(step => step.attempt === 1)).toBe(true);
    await engine.close();
  });

  it('keeps the lease alive during a local tool that exceeds the lease period', async () => {
    const dataDir = await tempDir(); const db = new Database(':memory:'); const project = db.project({ name: 'autopilot', kind: 'website', target: 'https://example.test', authorizationConfirmed: true });
    const workflow = new WorkflowEngine(db, { dataDir, adapters: [adapter()], pollMs: 100_000 });
    const tools = createDefaultToolRegistry(); const invoke = tools.invoke.bind(tools);
    tools.invoke = async (name, input, context) => { if (name === 'build:static-site') await new Promise(resolve => setTimeout(resolve, 180)); return invoke(name, input, context); };
    const engine = new AutopilotEngine(db, { dataDir, workflow, tools, leaseMs: 50, pollMs: 5 });
    const task = await engine.create({ projectId: project.id, prompt: 'Rebuild https://example.test as a static website and deploy it' });
    engine.submitAnswers(task.id, { answers: { authorizationConfirmed: true }, approveContract: true, approvePlan: true });
    const running = engine.run(task.id); await new Promise(resolve => setTimeout(resolve, 100)); engine.recover();
    const completed = await running;
    expect(completed.status, completed.error ?? '').toBe('COMPLETED');
    expect(completed.plan?.steps.find(step => step.id === 'build-delivery')?.attempt).toBe(1);
    expect(db.raw.prepare('SELECT COUNT(*) count FROM tasks WHERE project_id=?').get(task.projectId)).toEqual({ count: 1 });
    await engine.close();
  });

  it('resumes a real paused child workflow before resuming Autopilot', async () => {
    const dataDir = await tempDir(); const db = new Database(':memory:'); const project = db.project({ name: 'autopilot', kind: 'website', target: 'https://example.test', authorizationConfirmed: true });
    let release!: () => void; let started!: () => void; const analyzing = new Promise<void>(resolve => { started = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
    const pausable = adapter(); pausable.analyze = async () => { started(); await gate; return { analyzed: true }; };
    const workflow = new WorkflowEngine(db, { dataDir, adapters: [pausable], pollMs: 5 });
    const engine = new AutopilotEngine(db, { dataDir, workflow, leaseMs: 200, pollMs: 5 });
    const task = await engine.create({ projectId: project.id, prompt: 'Rebuild https://example.test as a static website and deploy it' });
    engine.submitAnswers(task.id, { answers: { authorizationConfirmed: true }, approveContract: true, approvePlan: true });
    const running = engine.run(task.id); await analyzing;
    expect(engine.pause(task.id)).toBe(true); release(); await running;
    const child = db.raw.prepare('SELECT id,status FROM tasks WHERE project_id=?').get(task.projectId) as { id: string; status: string };
    expect(child.status).toBe('PAUSED'); expect(engine.require(task.id).status).toBe('PAUSED');
    expect(engine.resume(task.id)).toBe(true);
    expect(db.getTask(child.id)?.status).toBe('QUEUED');
    const completed = await engine.run(task.id);
    expect(completed.status, JSON.stringify({ error: completed.error, checkpoint: completed.checkpoint, child: db.getTask(child.id)?.status })).toBe('COMPLETED');
    expect(db.raw.prepare('SELECT COUNT(*) count FROM tasks WHERE project_id=?').get(task.projectId)).toEqual({ count: 1 });
    await engine.close();
  });

  it('recovers an expired running lease on the next polling tick without restarting', async () => {
    const dataDir = await tempDir(); const db = new Database(':memory:'); const project = db.project({ name: 'autopilot', kind: 'website', target: 'https://example.test', authorizationConfirmed: true });
    const slow = adapter(); slow.analyze = async () => { await new Promise(resolve => setTimeout(resolve, 180)); return { analyzed: true }; };
    const workflow = new WorkflowEngine(db, { dataDir, adapters: [slow], pollMs: 100_000 });
    const engine = new AutopilotEngine(db, { dataDir, workflow, leaseMs: 50, pollMs: 5 });
    const task = await engine.create({ projectId: project.id, prompt: 'Rebuild https://example.test as a static website and deploy it' });
    engine.submitAnswers(task.id, { answers: { authorizationConfirmed: true }, approveContract: true, approvePlan: true });
    const running = engine.run(task.id); await new Promise(resolve => setTimeout(resolve, 30));
    db.raw.prepare("UPDATE autopilot_tasks SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(task.id);
    await running;
    expect(db.raw.prepare('SELECT COUNT(*) count FROM autopilot_step_results WHERE task_id=?').get(task.id)).toEqual({ count: 0 });
    engine.start();
    const deadline = Date.now() + 5000;
    while (!['COMPLETED', 'FAILED', 'BLOCKED'].includes(engine.require(task.id).status) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    await engine.close();
    expect(engine.require(task.id).status, engine.require(task.id).error ?? '').toBe('COMPLETED');
    expect(db.raw.prepare("SELECT COUNT(*) count FROM autopilot_step_results WHERE task_id=? AND status='FAILED'").get(task.id)).toEqual({ count: 0 });
  });

  it('locks authorization inputs after execution starts but permits revision before execution', async () => {
    const dataDir = await tempDir(); const { db, engine, task } = await approvedTask(dataDir);
    const child = db.createTask(task.projectId, 'website', { adapter: 'website' }, 'locked-child');
    task.plan!.steps[0]!.taskId = child.id; task.plan!.steps[0]!.status = 'RUNNING'; db.raw.prepare('UPDATE autopilot_tasks SET plan_json=? WHERE id=?').run(JSON.stringify(task.plan), task.id);
    const before = JSON.stringify(task.plan);
    const childBefore = db.raw.prepare('SELECT COUNT(*) count FROM tasks').get();
    db.raw.prepare("UPDATE autopilot_tasks SET status='PAUSED',metrics_json=? WHERE id=?").run(JSON.stringify({ ...task.metrics, startedAt: new Date().toISOString() }), task.id);
    expect(() => engine.submitAnswers(task.id, { answers: { target: 'https://other.test', materials: ['/tmp/other'] }, approveContract: true, approvePlan: true })).toThrow(/执行开始后禁止/);
    expect(JSON.stringify(engine.require(task.id).plan)).toBe(before);
    expect(db.getTask(child.id)?.status).toBe('QUEUED');
    expect(db.raw.prepare('SELECT COUNT(*) count FROM tasks').get()).toEqual(childBefore);
    const fresh = await engine.create({ projectId: task.projectId, prompt: 'Recover data for Windows and produce a report', idempotencyKey: 'revision-before-run' });
    engine.submitAnswers(fresh.id, { answers: { authorizationConfirmed: true, target: '/tmp/disk.img', materials: ['/tmp/disk.img'] }, approveContract: true, approvePlan: true });
    expect(engine.require(fresh.id).contract?.analysisTargets).toContain('/tmp/disk.img');
  });

  it('renews the delivery lease while publishing a large artifact', async () => {
    const dataDir = await tempDir(); const { db, engine, task } = await approvedTask(dataDir);
    await engine.run(task.id); const large = path.join(dataDir, 'large.bin'); await writeFile(large, Buffer.alloc(24 * 1024 * 1024, 7));
    const step = task.plan!.steps.find(item => item.kind === 'analyze')!;
    const row = db.raw.prepare('SELECT output_json FROM autopilot_step_results WHERE task_id=? AND step_id=?').get(task.id, step.id) as { output_json: string };
    const result = JSON.parse(row.output_json); result.outputRefs.push(large); result.artifacts.push({ name: 'large.bin', path: large, sourceTask: task.id, version: '1', status: 'generated', platforms: [], conditions: [] });
    db.raw.prepare('UPDATE autopilot_step_results SET output_json=? WHERE task_id=? AND step_id=?').run(JSON.stringify(result), task.id, step.id);
    const shortLived = new AutopilotEngine(db, { dataDir, workflow: engine.workflow, leaseMs: 500 });
    const delivered = await shortLived.deliver(task.id);
    expect(delivered.status).toBe('COMPLETED'); expect(shortLived.artifacts(task.id).some(item => item.name.endsWith('large.bin'))).toBe(true);
  });

  it('does not report success when the delivery lease cannot be renewed', async () => {
    const dataDir = await tempDir(); const { db, engine, task } = await approvedTask(dataDir);
    await engine.run(task.id); const large = path.join(dataDir, 'large.bin'); await writeFile(large, Buffer.alloc(24 * 1024 * 1024, 9));
    const step = task.plan!.steps.find(item => item.kind === 'analyze')!;
    const row = db.raw.prepare('SELECT output_json FROM autopilot_step_results WHERE task_id=? AND step_id=?').get(task.id, step.id) as { output_json: string };
    const result = JSON.parse(row.output_json); result.outputRefs.push(large); result.artifacts.push({ name: 'large.bin', path: large, sourceTask: task.id, version: '1', status: 'generated', platforms: [], conditions: [] });
    db.raw.prepare('UPDATE autopilot_step_results SET output_json=? WHERE task_id=? AND step_id=?').run(JSON.stringify(result), task.id, step.id);
    const shortLived = new AutopilotEngine(db, { dataDir, workflow: engine.workflow, leaseMs: 100 });
    const messagesBefore = shortLived.messages(task.id).length;
    const delivering = shortLived.deliver(task.id); await new Promise(resolve => setTimeout(resolve, 20));
    db.raw.prepare("UPDATE autopilot_tasks SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(task.id);
    const delivered = await delivering;
    expect(delivered.status).toBe('RUNNING'); expect(String(delivered.error ?? '')).not.toMatch(/交付包已生成/);
    expect(shortLived.messages(task.id).slice(messagesBefore).some(message => message.content.includes('交付包已生成'))).toBe(false);
  });

  it('supports pause, resume and cancel with explicit state versions', async () => {
    const dataDir = await tempDir(); const { db, engine, task } = await approvedTask(dataDir);
    db.raw.prepare("UPDATE autopilot_tasks SET status='RUNNING',lease_owner='worker',lease_expires_at='2999-01-01T00:00:00.000Z' WHERE id=?").run(task.id);
    expect(engine.pause(task.id)).toBe(true);
    expect(engine.require(task.id).status).toBe('PAUSED');
    expect(engine.resume(task.id)).toBe(true);
    expect(engine.require(task.id).status).toBe('PLANNING');
    expect(engine.cancel(task.id)).toBe(true);
    expect(engine.require(task.id).status).toBe('CANCELLED');
    expect(engine.require(task.id).stateVersion).toBeGreaterThan(task.stateVersion);
    expect(await engine.run(task.id)).toMatchObject({ status: 'CANCELLED' });
  });

  it('starts a durable polling loop for approved plans', async () => {
    const dataDir = await tempDir(); const { db, task } = await approvedTask(dataDir);
    const workflow = new WorkflowEngine(db, { dataDir, adapters: [adapter(), adapter('file')], pollMs: 100_000 });
    const engine = new AutopilotEngine(db, { dataDir, workflow, pollMs: 5 }); engine.start();
    const deadline = Date.now() + 5000;
    while (!['COMPLETED', 'FAILED', 'PARTIAL_SUCCESS'].includes(engine.require(task.id).status) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    await engine.close();
    expect(engine.require(task.id).status, engine.require(task.id).error ?? '').toBe('COMPLETED');
  });

  it('executes real child workflow and local tools, then creates an independently verified delivery', async () => {
    const dataDir = await tempDir(); const { db, engine, task } = await approvedTask(dataDir);
    const completed = await engine.run(task.id);
    expect(completed.status, completed.error ?? '').toBe('COMPLETED');
    expect(completed.plan?.steps.every(step => step.status === 'SUCCEEDED')).toBe(true);
    const child = db.raw.prepare('SELECT status FROM tasks WHERE project_id=?').get(task.projectId) as { status: string };
    expect(child.status).toBe('COMPLETED');
    const deliveryDir = path.join(dataDir, 'autopilot', task.id, 'artifacts');
    for (const required of ['START-HERE.md', '使用教程.md', 'reports/ACCEPTANCE.json', 'ARTIFACT-MANIFEST.json', 'SHA256SUMS.txt']) expect(await readFile(path.join(deliveryDir, required), 'utf8')).toContain('');
    const verification = await verifyDelivery(deliveryDir);
    expect(verification.passed, JSON.stringify(verification.checks)).toBe(true);
    const manifest = JSON.parse(await readFile(path.join(deliveryDir, 'ARTIFACT-MANIFEST.json'), 'utf8'));
    expect(manifest.acceptance.reviewer).toBe('independent-rules');
    expect(manifest.acceptance.status).toBe('DELIVERABLE_VERIFIED');
    expect(manifest.artifacts.length).toBeGreaterThan(0);
    const published = engine.artifacts(task.id);
    expect(published.some(item => item.name === '使用教程.md')).toBe(true);
    expect(engine.artifactPath(task.id, '使用教程.md')).toBe(path.join(deliveryDir, '使用教程.md'));
    expect(db.raw.prepare('SELECT COUNT(*) count FROM autopilot_artifacts WHERE task_id=?').get(task.id)).toEqual({ count: published.length });
  });
});

describe('delivery packaging', () => {
  it('derives manifests and hashes from real artifacts and marks partial delivery honestly', async () => {
    const dataDir = await tempDir(); const source = path.join(dataDir, 'result.txt'); await writeFile(source, 'real result');
    const output = path.join(dataDir, 'delivery');
    const manifest = await createDeliveryPackage(output, { taskId: 'task', originalGoal: 'recover data', completed: [], incomplete: ['manual review'], artifacts: [{ name: 'result.txt', path: source, sourceTask: 'child' }], checks: [{ name: 'build', passed: false, evidence: 'not requested' }] });
    expect(manifest.acceptance.status).toBe('BUILD_FAILED');
    expect(manifest.artifacts[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect((await verifyDelivery(output)).passed).toBe(true);
  });
});

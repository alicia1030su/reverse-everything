import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Database } from '@reverse/workflow';
import { AppError } from '@reverse/contracts';
import { AutopilotError, type AutopilotTask } from '@reverse/autopilot';
import { registerAutopilotRoutes } from '../../apps/api/src/autopilot-routes.js';
import { buildServer } from '../../apps/api/src/server.js';

const token = 'autopilot-test-token';
const auth = { authorization: `Bearer ${token}` };
const json = { ...auth, 'content-type': 'application/json' };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function task(id: string, projectId: string): AutopilotTask {
  const now = new Date().toISOString();
  return { id, projectId, conversationId: '', prompt: 'Recover my data', intent: {} as AutopilotTask['intent'], questions: [], answers: {}, contract: null, plan: null, status: 'DRAFT', planVersion: 0, stateVersion: 1, checkpoint: '', idempotencyKey: '', error: null, metrics: {} as AutopilotTask['metrics'], leaseOwner: null, leaseExpiresAt: null, createdAt: now, updatedAt: now };
}

async function setup() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 're-autopilot-api-'));
  const db = new Database(':memory:');
  const project = db.project({ name: 'Autopilot project', kind: 'software', authorizationConfirmed: true });
  const other = db.project({ name: 'Other project', kind: 'software', authorizationConfirmed: true });
  const current = task('autopilot-one', project.id);
  const tasks = [current];
  const artifactDir = path.join(dataDir, 'autopilot', current.id);
  await mkdir(artifactDir, { recursive: true });
  const content = '# Tutorial\nVerify this delivery.';
  const file = path.join(artifactDir, 'tutorial.md');
  await writeFile(file, content);
  const sha256 = createHash('sha256').update(content).digest('hex');
  const startContent = '# Start here\nRead the delivery guide.';
  const startFile = path.join(artifactDir, 'START-HERE.md');
  await writeFile(startFile, startContent);
  const startSha256 = createHash('sha256').update(startContent).digest('hex');
  const artifacts = [
    { name: 'tutorial.md', path: file, size: Buffer.byteLength(content), sha256, mime: 'text/markdown' },
    { name: 'START-HERE.md', path: startFile, size: Buffer.byteLength(startContent), sha256: startSha256, mime: 'text/markdown' },
  ];
  const engine = {
    create: vi.fn(async (input: { projectId: string; prompt: string; idempotencyKey?: string }) => {
      const existing = tasks.find(item => item.projectId === input.projectId && input.idempotencyKey && item.idempotencyKey === input.idempotencyKey);
      if (existing) return existing;
      const created = { ...task(`autopilot-${tasks.length + 1}`, input.projectId), prompt: input.prompt, idempotencyKey: input.idempotencyKey ?? '' };
      tasks.push(created); db.addEvent(created.id, 'autopilot.created', { id: created.id }); return created;
    }),
    get: vi.fn((id: string) => tasks.find(item => item.id === id)),
    list: vi.fn((projectId: string) => tasks.filter(item => item.projectId === projectId)),
    submitAnswers: vi.fn(async (id: string) => tasks.find(item => item.id === id)),
    pause: vi.fn(async (id: string) => tasks.find(item => item.id === id)),
    resume: vi.fn(async (id: string) => tasks.find(item => item.id === id)),
    cancel: vi.fn(async (id: string) => tasks.find(item => item.id === id)),
    messages: vi.fn((id: string) => [{ id: 1, taskId: id, role: 'assistant', content: 'What platform?', metadata: {}, createdAt: new Date().toISOString() }]),
    artifacts: vi.fn((id: string) => id === current.id ? artifacts : []),
    artifactPath: vi.fn((id: string, name: string) => id === current.id && name === 'tutorial.md' ? file : undefined),
  };
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _req, reply) => {
    const status = error instanceof AppError ? error.status : Number((error as { statusCode?: number }).statusCode ?? 500);
    return reply.code(status).send({ error: { code: error instanceof AppError ? error.code : 'ERROR', message: error.message } });
  });
  app.addHook('onRequest', async req => { if (req.headers.authorization !== `Bearer ${token}`) throw Object.assign(new Error('Unauthorized'), { statusCode: 401 }); });
  registerAutopilotRoutes(app, { db, engine: engine as never, dataDir, serializeProjectMutation: (_projectId, operation) => operation() });
  cleanups.push(async () => { await app.close(); if (db.raw.isOpen) db.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { app, db, project, other, current, tasks, artifacts, file, engine };
}

describe('Autopilot API contract and safety', () => {
  it('registers the real engine in buildServer and closes its lifecycle cleanly', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 're-autopilot-server-'));
    const db = new Database(':memory:');
    const built = await buildServer({ dataDir, db, token, backgroundResources: false });
    cleanups.push(async () => { await built.app.close(); if (db.raw.isOpen) db.close(); await rm(dataDir, { recursive: true, force: true }); });
    const project = await built.app.inject({ method: 'POST', url: '/api/projects', headers: json, body: JSON.stringify({ name: 'Real Autopilot', kind: 'software', authorizationConfirmed: true }) });
    expect(project.statusCode).toBe(201);
    const body = JSON.stringify({ projectId: project.json().id, prompt: 'Help recover my authorized local data', idempotencyKey: 'real-engine-create' });
    const created = await built.app.inject({ method: 'POST', url: '/api/autopilot/tasks', headers: json, body });
    expect(created.statusCode, created.body).toBe(201);
    const duplicate = await built.app.inject({ method: 'POST', url: '/api/autopilot/tasks', headers: json, body });
    expect(duplicate.json().id).toBe(created.json().id);
    expect((await built.app.inject({ method: 'GET', url: `/api/autopilot/tasks/${created.json().id}`, headers: auth })).json().id).toBe(created.json().id);
    const delivery = path.join(dataDir, 'autopilot', created.json().id, 'delivery');
    await mkdir(delivery, { recursive: true }); await writeFile(path.join(delivery, '使用教程.md'), '# Real tutorial');
    expect(built.autopilot.artifacts(created.json().id).map(item => item.name)).toContain('使用教程.md');
    const tutorial = await built.app.inject({ method: 'GET', url: `/api/autopilot/tasks/${created.json().id}/artifacts/${encodeURIComponent('使用教程.md')}`, headers: auth });
    expect(tutorial.statusCode, tutorial.body).toBe(200); expect(tutorial.body).toContain('Real tutorial');
  });

  it('accepts the CLI/MCP plan confirmation payload with contract approval', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 're-autopilot-approval-'));
    const db = new Database(':memory:');
    const built = await buildServer({ dataDir, db, token, backgroundResources: false });
    cleanups.push(async () => { await built.app.close(); if (db.raw.isOpen) db.close(); await rm(dataDir, { recursive: true, force: true }); });
    const project = await built.app.inject({ method: 'POST', url: '/api/projects', headers: json, body: JSON.stringify({ name: 'Approval Autopilot', kind: 'website', target: 'https://example.test', authorizationConfirmed: true }) });
    expect(project.statusCode).toBe(201);
    const created = await built.app.inject({ method: 'POST', url: '/api/autopilot/tasks', headers: json, body: JSON.stringify({ projectId: project.json().id, prompt: 'Rebuild https://example.test as a static website and deploy it', idempotencyKey: 'cli-mcp-plan-approval' }) });
    expect(created.statusCode, created.body).toBe(201);
    const taskId = created.json().id as string;
    const answered = await built.app.inject({ method: 'POST', url: `/api/autopilot/tasks/${taskId}/answers`, headers: json, body: JSON.stringify({ answers: { authorizationConfirmed: true } }) });
    expect(answered.statusCode, answered.body).toBe(200);
    expect(answered.json().status).toBe('WAITING_FOR_APPROVAL');
    const confirmed = await built.app.inject({ method: 'POST', url: `/api/autopilot/tasks/${taskId}/answers`, headers: json, body: JSON.stringify({ answers: {}, approveContract: true, approvePlan: true }) });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    expect(confirmed.json().contract).toBeTruthy();
    expect(confirmed.json().plan).toBeTruthy();
    expect(confirmed.json().status).not.toBe('WAITING_FOR_APPROVAL');
  });

  it('requires authentication and validates create input before engine invocation', async () => {
    const { app, engine, project } = await setup();
    expect((await app.inject({ method: 'GET', url: '/api/autopilot/tasks?projectId=p' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/autopilot/tasks', headers: json, body: JSON.stringify({ projectId: project.id, prompt: '' }) })).statusCode).toBe(400);
    expect(engine.create).not.toHaveBeenCalled();
  });

  it('creates idempotently and isolates list/get by project', async () => {
    const { app, project, other } = await setup();
    const body = JSON.stringify({ projectId: project.id, prompt: 'Recover my data', idempotencyKey: 'same-request' });
    const first = await app.inject({ method: 'POST', url: '/api/autopilot/tasks', headers: json, body });
    const second = await app.inject({ method: 'POST', url: '/api/autopilot/tasks', headers: json, body });
    expect(first.statusCode).toBe(201); expect(second.statusCode).toBe(201); expect(second.json().id).toBe(first.json().id);
    const list = await app.inject({ method: 'GET', url: `/api/autopilot/tasks?projectId=${project.id}`, headers: auth });
    expect(list.json().items.map((item: { id: string }) => item.id)).toContain(first.json().id);
    expect((await app.inject({ method: 'GET', url: `/api/autopilot/tasks?projectId=${other.id}`, headers: auth })).json().items).toEqual([]);
    expect((await app.inject({ method: 'GET', url: `/api/autopilot/tasks/${first.json().id}?projectId=${other.id}`, headers: auth })).statusCode).toBe(404);
  });

  it('answers confirms and pauses resumes cancels through project serialization', async () => {
    const { app, current, engine } = await setup();
    const answered = await app.inject({ method: 'POST', url: `/api/autopilot/tasks/${current.id}/answers`, headers: json, body: JSON.stringify({ answers: { platform: 'Windows' }, approveContract: true, approvePlan: true }) });
    expect(answered.statusCode).toBe(200); expect(engine.submitAnswers).toHaveBeenCalledWith(current.id, { answers: { platform: 'Windows' }, approveContract: true, approvePlan: true });
    for (const action of ['pause', 'resume', 'cancel'] as const) expect((await app.inject({ method: 'POST', url: `/api/autopilot/tasks/${current.id}/${action}`, headers: auth })).statusCode).toBe(200);
  });

  it('returns messages and only serves manifest-listed verified artifacts', async () => {
    const { app, current, file, artifacts } = await setup();
    const messages = await app.inject({ method: 'GET', url: `/api/autopilot/tasks/${current.id}/messages`, headers: auth });
    expect(messages.json().items[0].content).toBe('What platform?');
    const download = await app.inject({ method: 'GET', url: `/api/autopilot/tasks/${current.id}/artifacts/tutorial.md`, headers: auth });
    expect(download.statusCode).toBe(200); expect(download.body).toContain('Verify this delivery'); expect(download.headers['x-artifact-sha256']).toBe(artifacts[0]!.sha256);
    const caseInsensitive = await app.inject({ method: 'GET', url: `/api/autopilot/tasks/${current.id}/artifacts/start-here.md`, headers: auth });
    expect(caseInsensitive.statusCode, caseInsensitive.body).toBe(200); expect(caseInsensitive.body).toContain('Read the delivery guide'); expect(caseInsensitive.headers['x-artifact-sha256']).toBe(artifacts[1]!.sha256);
    await writeFile(file, 'tampered');
    expect((await app.inject({ method: 'GET', url: `/api/autopilot/tasks/${current.id}/artifacts/tutorial.md`, headers: auth })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/autopilot/tasks/${current.id}/artifacts/missing.md`, headers: auth })).statusCode).toBe(404);
  });

  it('maps AutopilotError status and code without leaking internal failures', async () => {
    const { app, current, engine } = await setup();
    engine.cancel.mockRejectedValueOnce(new AutopilotError('Cannot cancel in current state', 'INVALID_STATE', 409));
    const response = await app.inject({ method: 'POST', url: `/api/autopilot/tasks/${current.id}/cancel`, headers: auth });
    expect(response.statusCode).toBe(409); expect(response.json().error).toMatchObject({ code: 'INVALID_STATE', message: 'Cannot cancel in current state' });
  });

  it('streams persisted task events over SSE', async () => {
    const { app, current } = await setup();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const response = await fetch(`${address}/api/autopilot/tasks/${current.id}/events`, { headers: auth, signal: AbortSignal.timeout(5000) });
    expect(response.status).toBe(200); expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body!.getReader(); let stream = '';
    try { while (!stream.includes('event: snapshot')) stream += new TextDecoder().decode((await reader.read()).value); } finally { await reader.cancel(); }
    expect(stream).toContain('event: snapshot'); expect(stream).toContain(current.id);
  });
});

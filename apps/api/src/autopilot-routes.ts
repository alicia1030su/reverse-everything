import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { AppError, type ErrorCode, type JsonObject, type Page } from '@reverse/contracts';
import { safeArtifactName, snapshotVerifiedFile } from '@reverse/evidence';
import { AutopilotEngine, AutopilotError, type AutopilotArtifactRecord, type AutopilotTask, type CreateAutopilotInput, type SubmitAnswersInput } from '@reverse/autopilot';
import type { Database } from '@reverse/workflow';

export interface AutopilotRouteOptions {
  db: Database;
  engine: AutopilotEngine;
  dataDir: string;
  serializeProjectMutation: <T>(projectId: string, operation: () => Promise<T>) => Promise<T>;
}

function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError('BAD_REQUEST', 'A JSON object body is required', 400);
  return value as Record<string, unknown>;
}
function boundedText(value: unknown, name: string, max: number, required = true): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw new AppError('BAD_REQUEST', `${name} must be a${required ? ' non-empty' : ''} string of at most ${max} characters`, 400);
  return required ? (value as string).trim() : value as string;
}
function stringArray(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 64 || value.some(item => typeof item !== 'string' || !item.trim() || item.length > 2048)) throw new AppError('BAD_REQUEST', `${name} must contain at most 64 bounded strings`, 400);
  return [...new Set(value as string[])];
}
function idempotencyKey(req: { headers: Record<string, unknown> }, body: Record<string, unknown>): string | undefined {
  const header = req.headers['idempotency-key'];
  const fromBody = body.idempotencyKey;
  if (header !== undefined && typeof header !== 'string') throw new AppError('BAD_REQUEST', 'Idempotency-Key must be a string', 400);
  const value = header ?? fromBody;
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) throw new AppError('BAD_REQUEST', 'Idempotency-Key must contain 1-128 safe characters', 400);
  return value;
}
function autopilotFailure(error: unknown): never {
  if (error instanceof AutopilotError) {
    const status = error.status >= 400 && error.status <= 599 ? error.status : 409;
    throw new AppError(error.code as ErrorCode, error.message, status);
  }
  throw error;
}
function artifactName(value: string): string {
  if (!value || value === '.' || value === '..' || /[\\/\u0000-\u001f\u007f]/.test(value)) throw new AppError('BAD_REQUEST', 'Invalid artifact name', 400);
  const clean = value.normalize('NFC').replace(/[^a-zA-Z0-9._\-\u4e00-\u9fff]/g, '_').replace(/[. ]+$/, '');
  if (!clean || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(clean)) throw new AppError('BAD_REQUEST', 'Invalid artifact name', 400);
  return clean.toLowerCase();
}
function pagination(query: Record<string, unknown>): { limit: number; offset: number } {
  const limit = query.limit === undefined ? 100 : Number(query.limit);
  const offset = query.offset === undefined ? 0 : Number(query.offset);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500 || !Number.isSafeInteger(offset) || offset < 0) throw new AppError('BAD_REQUEST', 'limit must be 1-500 and offset must be non-negative', 400);
  return { limit, offset };
}

export function registerAutopilotRoutes(app: FastifyInstance, options: AutopilotRouteOptions): void {
  const { db, engine, dataDir, serializeProjectMutation } = options;
  const artifactRoot = path.resolve(dataDir, 'autopilot');
  const project = (id: string) => {
    const value = db.getProject(id);
    if (!value) throw new AppError('NOT_FOUND', 'Project not found', 404);
    return value;
  };
  const task = (id: string, projectId?: string): AutopilotTask => {
    const value = engine.get(id);
    if (!value || (projectId !== undefined && value.projectId !== projectId)) throw new AppError('NOT_FOUND', 'Autopilot task not found', 404);
    return value;
  };
  const mutate = <T>(projectId: string, operation: () => T | Promise<T>): Promise<T> => serializeProjectMutation(projectId, async () => {
    try { return await operation(); } catch (error) { autopilotFailure(error); }
  });
  const page = <T>(items: T[], total: number, limit: number, offset: number): Page<T> => ({ items, total, limit, offset });

  app.post('/api/autopilot/tasks', async (req, reply) => {
    const body = objectBody(req.body);
    const projectId = boundedText(body.projectId, 'projectId', 128)!;
    project(projectId);
    const prompt = boundedText(body.prompt, 'prompt', 16000)!;
    const key = idempotencyKey(req, body), conversationId = boundedText(body.conversationId, 'conversationId', 128, false);
    const uploadIds = stringArray(body.uploadIds, 'uploadIds'), paths = stringArray(body.paths, 'paths'), urls = stringArray(body.urls, 'urls');
    const input: CreateAutopilotInput = {
      projectId, prompt,
      ...(key ? { idempotencyKey: key } : {}),
      ...(conversationId ? { conversationId } : {}),
      ...(uploadIds ? { uploadIds } : {}),
      ...(paths ? { paths } : {}),
      ...(urls ? { urls } : {}),
    };
    const created = await mutate(projectId, () => engine.create(input));
    return reply.code(201).send(created);
  });

  app.get('/api/autopilot/tasks', async req => {
    const query = req.query as Record<string, unknown>;
    const projectId = boundedText(query.projectId, 'projectId', 128)!;
    project(projectId);
    const { limit, offset } = pagination(query);
    const status = boundedText(query.status, 'status', 64, false);
    const where = 'project_id=?' + (status ? ' AND status=?' : '');
    const args = status ? [projectId, status] : [projectId];
    const total = Number((db.raw.prepare(`SELECT COUNT(*) count FROM autopilot_tasks WHERE ${where}`).get(...args) as { count: number }).count);
    if (!status) return page(engine.list(projectId, limit, offset), total, limit, offset);
    const rows = db.raw.prepare(`SELECT id FROM autopilot_tasks WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...args, limit, offset) as { id: string }[];
    return page(rows.map(row => task(row.id, projectId)), total, limit, offset);
  });

  app.get<{ Params: { id: string } }>('/api/autopilot/tasks/:id', async req => {
    const query = req.query as Record<string, unknown>;
    const projectId = query.projectId === undefined ? undefined : boundedText(query.projectId, 'projectId', 128)!;
    if (projectId) project(projectId);
    return task(req.params.id, projectId);
  });

  app.post<{ Params: { id: string } }>('/api/autopilot/tasks/:id/answers', async req => {
    const current = task(req.params.id);
    const body = objectBody(req.body);
    const answers = body.answers;
    if (!answers || typeof answers !== 'object' || Array.isArray(answers) || Object.keys(answers).length > 128 || JSON.stringify(answers).length > 500_000) throw new AppError('BAD_REQUEST', 'answers must be a bounded JSON object with at most 128 fields', 400);
    if (body.approveContract !== undefined && typeof body.approveContract !== 'boolean') throw new AppError('BAD_REQUEST', 'approveContract must be boolean', 400);
    if (body.approvePlan !== undefined && typeof body.approvePlan !== 'boolean') throw new AppError('BAD_REQUEST', 'approvePlan must be boolean', 400);
    const input: SubmitAnswersInput = { answers: answers as JsonObject, ...(body.approveContract === true ? { approveContract: true } : {}), ...(body.approvePlan === true ? { approvePlan: true } : {}) };
    return mutate(current.projectId, () => engine.submitAnswers(req.params.id, input));
  });

  const action = (kind: 'pause' | 'resume' | 'cancel') => async (id: string) => {
    const current = task(id);
    return mutate(current.projectId, async () => {
      const changed = await engine[kind](id);
      if (changed === false) throw new AppError('CONFLICT', `Cannot ${kind} Autopilot task in its current state`, 409);
      return engine.get(id);
    });
  };
  app.post<{ Params: { id: string } }>('/api/autopilot/tasks/:id/pause', async req => action('pause')(req.params.id));
  app.post<{ Params: { id: string } }>('/api/autopilot/tasks/:id/resume', async req => action('resume')(req.params.id));
  app.post<{ Params: { id: string } }>('/api/autopilot/tasks/:id/cancel', async req => action('cancel')(req.params.id));

  app.get<{ Params: { id: string } }>('/api/autopilot/tasks/:id/messages', async req => {
    task(req.params.id);
    const { limit, offset } = pagination(req.query as Record<string, unknown>);
    const messages = engine.messages(req.params.id);
    return page(messages.slice(offset, offset + limit), messages.length, limit, offset);
  });

  app.get<{ Params: { id: string } }>('/api/autopilot/tasks/:id/artifacts', async req => { task(req.params.id); return engine.artifacts(req.params.id); });

  app.get<{ Params: { id: string; name: string } }>('/api/autopilot/tasks/:id/artifacts/:name', async (req, reply) => {
    task(req.params.id);
    const name = artifactName(req.params.name);
    let legacyName: string;
    try { legacyName = safeArtifactName(req.params.name); } catch { throw new AppError('BAD_REQUEST', 'Invalid artifact name', 400); }
    const entries = engine.artifacts(req.params.id);
    const artifact = entries.find((item: AutopilotArtifactRecord) => item.name === name || item.name === legacyName)
      ?? entries.find((item: AutopilotArtifactRecord) => item.name.toLowerCase() === name.toLowerCase() || item.name.toLowerCase() === legacyName.toLowerCase());
    if (!artifact) throw new AppError('NOT_FOUND', 'Artifact not found', 404);
    const file = artifact.path;
    if (!file) throw new AppError('NOT_FOUND', 'Artifact not found', 404);
    const relative = path.relative(artifactRoot, path.resolve(file));
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new AppError('FORBIDDEN', 'Artifact path escapes the managed artifact root', 403);
    let opened: Awaited<ReturnType<typeof snapshotVerifiedFile>>;
    try { opened = await snapshotVerifiedFile(file, artifact.size, artifact.sha256); }
    catch { throw new AppError('NOT_FOUND', 'Artifact is unavailable or failed integrity verification', 404); }
    const stream = opened.handle.createReadStream();
    const cleanup = () => { void opened.cleanup().catch(() => {}); };
    stream.once('close', cleanup); stream.once('error', cleanup);
    try {
      return reply.header('x-artifact-sha256', artifact.sha256).header('content-disposition', `attachment; filename="artifact"; filename*=UTF-8''${encodeURIComponent(name)}`).type(artifact.mime ?? 'application/octet-stream').send(stream);
    } catch (error) { cleanup(); throw error; }
  });

  app.get<{ Params: { id: string } }>('/api/autopilot/tasks/:id/events', async (req, reply) => {
    task(req.params.id);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    const header = req.headers['last-event-id'];
    const parsed = header === undefined ? 0 : Number(header);
    let last = Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
    const send = () => {
      for (const event of db.eventsAfter(req.params.id, last, 200)) {
        last = event.id;
        res.write(`id: ${last}\nevent: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`);
      }
    };
    send();
    res.write(`event: snapshot\ndata: ${JSON.stringify(engine.get(req.params.id))}\n\n`);
    const timer = setInterval(() => { send(); res.write(': heartbeat\n\n'); }, 1000);
    timer.unref();
    req.raw.on('close', () => clearInterval(timer));
  });
}

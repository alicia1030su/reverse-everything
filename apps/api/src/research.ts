import { randomUUID } from 'node:crypto';
import { mkdir, open, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { AppError, type AdapterName, type CreateTaskInput, type ProjectKind } from '@reverse/contracts';
import { adapters } from '@reverse/core';
import { CONSOLE_DEVICES, CONSOLE_SUPPORT_MATRIX, OFFICIAL_DEVELOPMENT_ENVIRONMENTS, diagnoseConsoleUsb, getConsoleDevice, getConsoleSupportEntry, validateConsoleProfile } from '@reverse/console';
import { createAnalysisPlan, detectTarget, PlannerError, validatePlan, type AnalysisPlan, type AnalyzerCapability, type AnalyzerId, type AuthorizationScope, type PlanBudget, type PlanStep, type TargetDetection, type TargetKind } from '@reverse/planner';
import { hashFile } from '@reverse/evidence';
import type { Database, WorkflowEngine } from '@reverse/workflow';
import { normalizeInputTarget } from '@reverse/workflow';
import { publicTask } from './security.js';

interface ResearchOptions { db: Database; engine: WorkflowEngine; dataDir: string; resourceDir: string }
interface PlanRow { id: string; projectId: string; taskId: string | null; mode: string; target: TargetDetection; detection: TargetDetection; authorizationId: string | null; uploadId: string | null; inputHash: string | null; steps: PlanStep[]; budget: PlanBudget; status: string; createdAt: string; updatedAt: string }

const ADAPTER_BY_ANALYZER: Record<AnalyzerId, AdapterName> = { ghidra: 'ghidra', jadx: 'apk', firmware: 'firmware', usb: 'hardware', network: 'network', website: 'website', android: 'apk', game: 'game', security: 'security', file: 'file' };
const ANALYZER_BY_ADAPTER: Partial<Record<AdapterName, AnalyzerId>> = { ghidra: 'ghidra', apk: 'jadx', firmware: 'firmware', hardware: 'usb', network: 'network', website: 'website', game: 'game', security: 'security', file: 'file' };
const DEMOS = [
  { name: 'website', title: '自制网页采集', description: '采集内置演示网页的 DOM、脚本与同源网络元数据', kind: 'website', adapter: 'website', target: 'demo' },
  { name: 'game', title: '迷你游戏兼容分析', description: '分析内置游戏回放并生成独立兼容服务', kind: 'game', adapter: 'game', fixture: 'examples/demo-game/captured-trace.json' },
  { name: 'android', title: '自制 APK 静态分析', description: '解析确定性 APK 的 Manifest、DEX 与资源元数据', kind: 'software', adapter: 'apk', fixture: 'tests/fixtures/android/minimal.apk' },
  { name: 'firmware', title: '自制 UF2 固件分析', description: '流式分析自制 UF2 块、地址区域与字符串', kind: 'firmware', adapter: 'firmware', generated: 'uf2' },
  { name: 'usb', title: '自制 USB 通信记录', description: '解析自制 usbmon 请求/响应元数据', kind: 'hardware', adapter: 'hardware', generated: 'usbmon' },
  { name: 'protocol', title: '自制 HAR 协议分析', description: '解析自制 HAR 的端点、方法与状态元数据', kind: 'protocol', adapter: 'network', generated: 'har' },
  { name: 'security', title: '自制安全样本', description: '对自制文本样本运行静态安全规则', kind: 'security', adapter: 'security', generated: 'security' },
] as const;

function project(db: Database, id: string) { const value = db.getProject(id); if (!value) throw new AppError('NOT_FOUND', 'Project not found', 404); return value; }
function planRow(row: Record<string, unknown>) { return { id: String(row.id), projectId: String(row.project_id), taskId: row.task_id ? String(row.task_id) : null, mode: String(row.mode), target: JSON.parse(String(row.target_json)), detection: JSON.parse(String(row.detection_json)), authorizationId: row.authorization_id ? String(row.authorization_id) : null, uploadId: row.upload_id ? String(row.upload_id) : null, inputHash: row.upload_sha256 ? String(row.upload_sha256) : null, steps: JSON.parse(String(row.steps_json)), budget: JSON.parse(String(row.budget_json)), status: String(row.status), createdAt: String(row.created_at), updatedAt: String(row.updated_at) }; }
function requirePlan(db: Database, id: string): PlanRow { const row = db.raw.prepare('SELECT * FROM analysis_plans WHERE id=?').get(id) as Record<string, unknown> | undefined; if (!row) throw new AppError('NOT_FOUND', 'Analysis plan not found', 404); return planRow(row); }

async function analyzerCapabilities(): Promise<AnalyzerCapability[]> {
  const result: AnalyzerCapability[] = [];
  for (const adapter of adapters) {
    const id = ANALYZER_BY_ADAPTER[adapter.name];
    if (!id) continue;
    const capability = await adapter.available();
    result.push({ id, available: capability.available, detail: capability.detail, ...(adapter.version ? { version: adapter.version } : {}) });
  }
  return result;
}

async function readHead(file: string, max = 1024 * 1024): Promise<Buffer> {
  const handle = await open(file, 'r');
  try { const buffer = Buffer.alloc(max); const { bytesRead } = await handle.read(buffer, 0, max, 0); return buffer.subarray(0, bytesRead); }
  finally { await handle.close(); }
}

function scopeFromRow(row: Record<string, unknown>): AuthorizationScope {
  return { granted: row.revoked_at === null || row.revoked_at === undefined, operations: JSON.parse(String(row.allowed_operations_json)), allowedAdapters: JSON.parse(String(row.allowed_interfaces_json)), allowedTargetKinds: JSON.parse(String(row.data_access_json)), ...(row.expires_at ? { expiresAt: String(row.expires_at) } : {}) };
}

function normalizeTargetReference(value: string): string { return normalizeInputTarget(value); }
function plainBody(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError('BAD_REQUEST', 'A JSON object body is required', 400); return value as Record<string, unknown>; }
function stringField(body: Record<string, unknown>, key: string, max = 2048): string { const value = body[key]; if (typeof value !== 'string' || !value.trim() || value.length > max) throw new AppError('BAD_REQUEST', `${key} must be a non-empty string of at most ${max} characters`, 400); return value; }
function stringArray(body: Record<string, unknown>, key: string, allowed?: readonly string[]): string[] { const value = body[key]; if (!Array.isArray(value) || value.length > 64 || value.some(item => typeof item !== 'string' || !item.trim() || item.length > 128 || (allowed && !allowed.includes(item)))) throw new AppError('BAD_REQUEST', `${key} must be a string array with at most 64 bounded values`, 400); return value as string[]; }
function authorizationScope(value: unknown): AuthorizationScope { const body = plainBody(value); const operations = stringArray(body, 'operations', ['read-target', 'execute-analyzer', 'extract-archive', 'network-access', 'device-access']) as AuthorizationScope['operations']; const allowedAdapters = stringArray(body, 'allowedAdapters', Object.keys(ADAPTER_BY_ANALYZER)) as AnalyzerId[]; const allowedTargetKinds = stringArray(body, 'allowedTargetKinds', ['HAR', 'PCAP', 'PCAPNG', 'APK', 'DEX', 'PE', 'ELF', 'UF2', 'INTEL_HEX', 'ZIP', 'FIRMWARE', 'UNKNOWN']) as TargetKind[]; if (body.granted !== true || typeof body.expiresAt !== 'undefined' && (typeof body.expiresAt !== 'string' || !Number.isFinite(Date.parse(body.expiresAt)) || Date.parse(body.expiresAt) <= Date.now())) throw new AppError('BAD_REQUEST', 'Invalid authorization scope', 400); return { granted: true, operations, allowedAdapters, allowedTargetKinds, ...(typeof body.expiresAt === 'string' ? { expiresAt: body.expiresAt } : {}) }; }
function generatedFixture(kind: 'uf2' | 'usbmon' | 'har' | 'security'): { name: string; bytes: Buffer } {
  if (kind === 'usbmon') return { name: 'demo-usbmon.txt', bytes: Buffer.from('aaaa 10 S Bi:1:001:1 0 4 = 0102\naaaa 11 C Bi:1:001:1 0 4 = 0102\n') };
  if (kind === 'har') return { name: 'demo.har', bytes: Buffer.from(JSON.stringify({ log: { version: '1.2', entries: [{ request: { method: 'GET', url: 'https://example.test/demo', headers: [{ name: 'Accept', value: 'application/json' }] }, response: { status: 200, headers: [], content: { size: 2, mimeType: 'application/json' } } }] } })) };
  if (kind === 'security') return { name: 'demo-security.txt', bytes: Buffer.from('password=demo-secret\nGET /?token=demo-token HTTP/1.1\n') };
  const block = Buffer.alloc(512); block.writeUInt32LE(0x0a324655, 0); block.writeUInt32LE(0x9e5d3150, 4); block.writeUInt32LE(0, 8); block.writeUInt32LE(256, 12); block.writeUInt32LE(0, 16); block.writeUInt32LE(0x00000000, 20); block.writeUInt32LE(0xe48bff56, 24); block.write('demo-uf2', 28, 'utf8'); return { name: 'demo.uf2', bytes: block };
}

async function attachFixture(db: Database, dataDir: string, projectId: string, fixture: string, generated?: 'uf2' | 'usbmon' | 'har' | 'security') {
  const source = generated ? generatedFixture(generated) : { name: path.basename(fixture), bytes: await readHead(path.join(fixture), 100 * 1024 * 1024) };
  const dir = path.join(dataDir, 'uploads', projectId); await mkdir(dir, { recursive: true });
  const storedName = randomUUID() + path.extname(source.name); const file = path.join(dir, storedName); await writeFile(file, source.bytes);
  const upload = { id: randomUUID(), projectId, name: source.name, storedName, mime: 'application/octet-stream', size: source.bytes.length, sha256: await hashFile(file), createdAt: new Date().toISOString() };
  db.addUpload(upload); return upload;
}

export function registerResearchRoutes(app: FastifyInstance, options: ResearchOptions): void {
  const { db, engine, dataDir, resourceDir } = options;

  app.get('/api/console/devices', async () => ({ items: CONSOLE_DEVICES }));
  app.get<{ Params: { id: string } }>('/api/console/devices/:id', async req => { const device = getConsoleDevice(req.params.id as Parameters<typeof getConsoleDevice>[0]); return { device, support: getConsoleSupportEntry(device.id) }; });
  app.get('/api/console/support', async () => ({ devices: CONSOLE_SUPPORT_MATRIX, officialEnvironments: OFFICIAL_DEVELOPMENT_ENVIRONMENTS }));
  app.post('/api/console/diagnose-usb', async req => { try { return { diagnosis: diagnoseConsoleUsb(req.body) }; } catch (error) { throw new AppError('BAD_REQUEST', error instanceof Error ? error.message : 'Invalid USB enumeration summary', 400); } });

  app.get<{ Params: { id: string } }>('/api/projects/:id/console-profile', async req => {
    project(db, req.params.id); const row = db.raw.prepare('SELECT * FROM console_profiles WHERE project_id=?').get(req.params.id) as Record<string, unknown> | undefined;
    if (!row) throw new AppError('NOT_FOUND', 'Console profile not found', 404);
    return { profile: validateConsoleProfile(JSON.parse(String(row.profile_json ?? '{}'))) };
  });
  app.put<{ Params: { id: string } }>('/api/projects/:id/console-profile', async req => {
    const current = project(db, req.params.id); if (current.kind !== 'console') throw new AppError('BAD_REQUEST', 'Project is not a console research project', 400);
    let profile; try { profile = validateConsoleProfile(req.body); } catch (error) { throw new AppError('BAD_REQUEST', error instanceof Error ? error.message : 'Invalid console profile', 400); } const now = new Date().toISOString();
    db.raw.prepare(`INSERT INTO console_profiles (id,project_id,manufacturer,series,model,hardware_version,system_version,user_info_json,official_interfaces_json,authorized_environments_json,firmware_samples_json,known_capabilities_json,actual_access_json,evidence_json,level,limitations_json,profile_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET manufacturer=excluded.manufacturer,series=excluded.series,model=excluded.model,hardware_version=excluded.hardware_version,system_version=excluded.system_version,user_info_json=excluded.user_info_json,official_interfaces_json=excluded.official_interfaces_json,authorized_environments_json=excluded.authorized_environments_json,firmware_samples_json=excluded.firmware_samples_json,known_capabilities_json=excluded.known_capabilities_json,actual_access_json=excluded.actual_access_json,evidence_json=excluded.evidence_json,level=excluded.level,limitations_json=excluded.limitations_json,profile_json=excluded.profile_json,updated_at=excluded.updated_at`).run(randomUUID(), current.id, profile.manufacturer, profile.series, profile.model, profile.hardwareVersion, profile.systemVersion, JSON.stringify(profile.userProvidedInfo), JSON.stringify(profile.officialInterfaces), JSON.stringify(profile.authorizedDevEnvironments), JSON.stringify(profile.firmwareSamples), JSON.stringify(profile.knownCapabilities), JSON.stringify(profile.actualAccess), JSON.stringify(profile.researchEvidence), profile.currentLevel, JSON.stringify(profile.limitations), JSON.stringify(profile), now, now);
    return { profile };
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id/authorizations', async req => { project(db, req.params.id); return { items: (db.raw.prepare('SELECT * FROM authorization_scopes WHERE project_id=? ORDER BY created_at DESC').all(req.params.id) as Record<string, unknown>[]).map(row => ({ id: String(row.id), target: String(row.target), scope: JSON.parse(String(row.scope_json)), allowedInterfaces: JSON.parse(String(row.allowed_interfaces_json)), allowedOperations: JSON.parse(String(row.allowed_operations_json)), dataAccess: JSON.parse(String(row.data_access_json)), remoteAiAllowed: Boolean(row.remote_ai_allowed), expiresAt: row.expires_at ? String(row.expires_at) : null, createdAt: String(row.created_at), revokedAt: row.revoked_at ? String(row.revoked_at) : null })) }; });
  app.post<{ Params: { id: string } }>('/api/projects/:id/authorizations', async req => {
    const current = project(db, req.params.id); const body = plainBody(req.body); const target = normalizeTargetReference(stringField(body, 'target')); const scope = stringArray(body, 'scope'); const allowedInterfaces = stringArray(body, 'allowedInterfaces'); const allowedOperations = stringArray(body, 'allowedOperations', ['read-target', 'execute-analyzer', 'extract-archive', 'network-access', 'device-access']); const dataAccess = stringArray(body, 'dataAccess');
    if (body.remoteAiAllowed !== undefined && typeof body.remoteAiAllowed !== 'boolean') throw new AppError('BAD_REQUEST', 'remoteAiAllowed must be boolean', 400);
    if (body.expiresAt !== undefined && (typeof body.expiresAt !== 'string' || !Number.isFinite(Date.parse(body.expiresAt)) || Date.parse(body.expiresAt) <= Date.now())) throw new AppError('BAD_REQUEST', 'expiresAt must be a future ISO date', 400);
    const id = randomUUID(), now = new Date().toISOString(); db.raw.prepare('INSERT INTO authorization_scopes (id,project_id,target,scope_json,allowed_interfaces_json,allowed_operations_json,data_access_json,remote_ai_allowed,expires_at,created_at,revoked_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id, current.id, target, JSON.stringify(scope), JSON.stringify(allowedInterfaces), JSON.stringify(allowedOperations), JSON.stringify(dataAccess), body.remoteAiAllowed === true ? 1 : 0, typeof body.expiresAt === 'string' ? body.expiresAt : null, now, null);
    return { id };
  });
  app.post<{ Params: { id: string } }>('/api/authorizations/:id/revoke', async req => { const result = db.raw.prepare('UPDATE authorization_scopes SET revoked_at=? WHERE id=? AND revoked_at IS NULL').run(new Date().toISOString(), req.params.id); if (!result.changes) throw new AppError('NOT_FOUND', 'Authorization not found or already revoked', 404); return { revoked: true }; });

  app.post<{ Params: { id: string } }>('/api/projects/:id/plans', async req => {
    const current = project(db, req.params.id); const body = plainBody(req.body); const mode = stringField(body, 'mode', 32), objective = stringField(body, 'objective', 1000);
    if (!['beginner','professional','agent'].includes(mode)) throw new AppError('BAD_REQUEST', 'Unsupported plan mode', 400);
    if (body.declaredKind !== undefined && typeof body.declaredKind !== 'string') throw new AppError('BAD_REQUEST', 'declaredKind must be a target kind', 400);
    for (const key of ['maxSteps', 'maxDepth'] as const) if (body[key] !== undefined && typeof body[key] !== 'number') throw new AppError('BAD_REQUEST', `${key} must be a number`, 400);
    const uploadId = body.uploadId === undefined ? null : stringField(body, 'uploadId', 128);
    const upload = uploadId ? db.uploads(current.id).find(item => item.id === uploadId) : undefined;
    if (uploadId && !upload) throw new AppError('NOT_FOUND', 'Upload not found', 404);
    const targetKey = upload?.id ?? normalizeTargetReference(stringField(body, 'target', 2048));
    if (!upload && (current.kind !== 'website' || normalizeTargetReference(current.target) !== targetKey)) throw new AppError('CONFLICT', 'Authorization target does not match the project URL target', 409);
    let head: Uint8Array = Buffer.alloc(0), inputHash: string | null = null, size = 0, fileName: string | undefined;
    if (upload) {
      const file = path.join(dataDir, 'uploads', current.id, upload.storedName);
      head = await readHead(file); inputHash = await hashFile(file); size = upload.size; fileName = upload.name;
      if (inputHash !== upload.sha256 || size !== (await stat(file)).size) throw new AppError('CONFLICT', 'Upload content no longer matches its recorded identity', 409);
    }
    const detection = { ...detectTarget({ bytes: head, ...(fileName ? { fileName } : {}), ...(body.declaredKind ? { declaredKind: body.declaredKind as TargetKind } : {}) }), size };
    if (!upload && detection.kind !== 'UNKNOWN') throw new AppError('BAD_REQUEST', 'No-upload plans require a URL target', 400);
    let authorization: AuthorizationScope; let authorizationId: string;
    if (body.authorizationId !== undefined) { authorizationId = stringField(body, 'authorizationId', 128); const row = db.raw.prepare('SELECT * FROM authorization_scopes WHERE id=? AND project_id=?').get(authorizationId, current.id) as Record<string, unknown> | undefined; if (!row) throw new AppError('NOT_FOUND', 'Authorization scope not found', 404); if (String(row.target) !== targetKey) throw new AppError('CONFLICT', 'Authorization target does not match the bound input', 409); if (row.revoked_at || (row.expires_at && Date.parse(String(row.expires_at)) <= Date.now())) throw new AppError('CONFLICT', 'Authorization is revoked or expired', 409); authorization = scopeFromRow(row); }
    else if (body.authorization !== undefined) { authorization = authorizationScope(body.authorization); const interfaces = authorization.allowedAdapters; const operations = authorization.operations; const kinds = authorization.allowedTargetKinds; authorizationId = randomUUID(); db.raw.prepare('INSERT INTO authorization_scopes (id,project_id,target,scope_json,allowed_interfaces_json,allowed_operations_json,data_access_json,remote_ai_allowed,expires_at,created_at,revoked_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(authorizationId, current.id, targetKey, JSON.stringify(['inline-normalized']), JSON.stringify(interfaces), JSON.stringify(operations), JSON.stringify(kinds), 0, authorization.expiresAt ?? null, new Date().toISOString(), null); }
    else throw new AppError('BAD_REQUEST', 'authorization or authorizationId is required', 400);
    if (!authorization.granted || !authorization.operations.includes('read-target') || !authorization.operations.includes('execute-analyzer') || !authorization.allowedAdapters.length || !authorization.allowedTargetKinds.includes(detection.kind)) throw new AppError('CONFLICT', 'Authorization does not permit this input and analyzer', 409);
    if (body.budget !== undefined) plainBody(body.budget);
    let plan: AnalysisPlan;
    try { plan = createAnalysisPlan({ target: detection, authorization, capabilities: await analyzerCapabilities(), objective, ...(body.budget ? { budget: body.budget as Partial<PlanBudget> } : {}), ...(body.maxSteps !== undefined ? { maxSteps: Number(body.maxSteps) } : {}), ...(body.maxDepth !== undefined ? { maxDepth: Number(body.maxDepth) } : {}), ...(body.adapterAllowlist !== undefined ? { adapterAllowlist: stringArray(body, 'adapterAllowlist', Object.keys(ADAPTER_BY_ANALYZER)) as AnalyzerId[] } : {}) }); validatePlan(plan); }
    catch (error) { if (error instanceof PlannerError) throw new AppError('BAD_REQUEST', error.message, 400); throw error; }
    const id = randomUUID(), now = new Date().toISOString();
    db.raw.prepare('INSERT INTO analysis_plans (id,project_id,task_id,mode,target_json,detection_json,authorization_id,upload_id,upload_sha256,steps_json,budget_json,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, current.id, null, mode, JSON.stringify(plan.target), JSON.stringify(detection), authorizationId, upload?.id ?? null, inputHash, JSON.stringify(plan.steps), JSON.stringify(plan.budget), 'CREATED', now, now);
    return { plan: { ...plan, id, authorizationId, uploadId: upload?.id ?? null, inputHash }, status: 'CREATED' };
  });
  app.get<{ Params: { id: string } }>('/api/projects/:id/plans', async req => { project(db, req.params.id); return { items: (db.raw.prepare('SELECT * FROM analysis_plans WHERE project_id=? ORDER BY created_at DESC').all(req.params.id) as Record<string, unknown>[]).map(planRow) }; });
  app.get<{ Params: { id: string } }>('/api/plans/:id', async req => ({ plan: requirePlan(db, req.params.id) }));
  app.post<{ Params: { id: string } }>('/api/plans/:id/execute', async req => {
    const row = requirePlan(db, req.params.id), current = project(db, row.projectId);
    if (row.taskId) { const existing = db.getTask(row.taskId); if (existing) return { task: publicTask(existing) }; throw new AppError('CONFLICT', 'Plan is bound to a missing task', 409); }
    if (!row.authorizationId || (row.uploadId ? !row.inputHash : !current.target)) throw new AppError('CONFLICT', 'Plan has no persisted authorization and input binding', 409);
    const upload = row.uploadId ? db.uploads(current.id).find(item => item.id === row.uploadId) : undefined;
    if (row.uploadId && (!upload || upload.sha256 !== row.inputHash)) throw new AppError('CONFLICT', 'Bound upload is missing or changed', 409);
    const auth = db.raw.prepare('SELECT * FROM authorization_scopes WHERE id=? AND project_id=?').get(row.authorizationId, current.id) as Record<string, unknown> | undefined;
    if (!row.uploadId && (current.kind !== 'website' || row.target.kind !== 'UNKNOWN')) throw new AppError('CONFLICT', 'Plan has no valid URL target binding', 409);
    const expectedTarget = upload?.id ?? normalizeTargetReference(current.target);
    if (!auth || auth.revoked_at || (auth.expires_at && Date.parse(String(auth.expires_at)) <= Date.now()) || String(auth.target) !== expectedTarget) throw new AppError('CONFLICT', 'Authorization is missing, revoked, expired or targets another input', 409);
    if (upload) { const file = path.join(dataDir, 'uploads', current.id, upload.storedName); if (await hashFile(file) !== row.inputHash) throw new AppError('CONFLICT', 'Bound upload hash changed', 409); }
    const authorization = scopeFromRow(auth); const plan: AnalysisPlan = { id: row.id, deterministic: true, target: row.target, authorization, objective: 'Execute stored analysis plan', steps: row.steps, budget: row.budget, adapterAllowlist: [...new Set(row.steps.flatMap(step => step.adapterAllowlist))], maxDepth: Math.max(0, ...row.steps.map(step => step.maxDepth)), limitations: [], aiSuggestions: [] };
    validatePlan(plan); const execution = plan.steps.find(step => step.kind === 'execution' && step.status !== 'FAILED' && step.status !== 'BLOCKED') ?? plan.steps.find(step => step.kind === 'execution'); if (!execution || execution.status === 'BLOCKED' || !authorization.granted || !authorization.operations.includes('read-target') || !authorization.operations.includes('execute-analyzer') || !authorization.allowedTargetKinds.includes(row.target.kind)) throw new AppError('CONFLICT', 'Plan execution is blocked', 409); const analyzer = execution.analyzer ?? plan.adapterAllowlist[0]; if (!analyzer || !authorization.allowedAdapters.includes(analyzer) || !execution.adapterAllowlist.includes(analyzer)) throw new AppError('CONFLICT', 'Plan analyzer is outside authorization scope', 409);
    let task;
    try { task = await engine.create(row.projectId, { adapter: ADAPTER_BY_ANALYZER[analyzer], options: { planId: row.id, planUpdatedAt: row.updatedAt, ...(row.uploadId ? { uploadId: row.uploadId } : {}), mode: row.mode, aiV3: row.mode === 'agent' } }); }
    catch (error) { if (error instanceof Error && /changed after it was read|already bound|missing or already bound/i.test(error.message)) throw new AppError('CONFLICT', 'Analysis plan changed or was already bound before task creation', 409); throw error; }
    db.raw.prepare("UPDATE analysis_plans SET task_id=?,status='RUNNING',updated_at=? WHERE id=?").run(task.id, new Date().toISOString(), row.id); return { task: publicTask(task) };
  });

  app.get('/api/tools', async () => ({ items: await analyzerCapabilities(), note: 'Large tools require explicit user confirmation and official sources; this endpoint never installs software automatically' }));
  app.get('/api/demos', async () => ({ items: DEMOS }));
  app.post<{ Params: { name: string } }>('/api/demos/:name/run', async req => {
    const demo = DEMOS.find(item => item.name === req.params.name); if (!demo) throw new AppError('NOT_FOUND', 'Demo not found', 404);
    const current = db.project({ name: `内置演示-${demo.title}`, kind: demo.kind as ProjectKind, target: 'built-in-demo', authorizationConfirmed: true });
    if ('fixture' in demo) await attachFixture(db, dataDir, current.id, path.join(resourceDir, demo.fixture)); else if ('generated' in demo) await attachFixture(db, dataDir, current.id, '', demo.generated);
    const input: CreateTaskInput = { adapter: demo.adapter, options: demo.adapter === 'website' ? { allowLocal: true, confirmLocal: true, target: `http://127.0.0.1:${process.env.RE_DEMO_PORT ?? 4180}` } : {} };
    const task = await engine.create(current.id, input); const id = randomUUID(), now = new Date().toISOString(); db.raw.prepare('INSERT INTO demo_runs (id,demo_name,status,steps_json,result_json,started_at,ended_at) VALUES (?,?,?,?,?,?,?)').run(id, demo.name, 'RUNNING', JSON.stringify([]), JSON.stringify({ projectId: current.id, taskId: task.id }), now, null); return { demo: demo.name, projectId: current.id, taskId: task.id, runId: id };
  });

  app.get<{ Params: { id: string } }>('/api/tasks/:id/report/plain', async req => {
    const detail = db.detail(req.params.id); if (!detail) throw new AppError('NOT_FOUND', 'Task not found', 404);
    const confirmed = detail.evidence.filter(item => item.kind === 'EVIDENCE' || item.kind === 'VERIFIED'); const inferred = detail.evidence.filter(item => item.kind === 'INFERENCE'); const unknown = detail.evidence.filter(item => item.kind === 'UNKNOWN');
    const summary = `本次分析对象为「${detail.project.name}」，任务状态为 ${detail.status}。系统完成了 ${confirmed.length} 项有证据支持的分析，并记录 ${inferred.length} 项推断和 ${unknown.length} 项未知信息。`;
    const nextSteps = ['核对原始证据与工具日志。', '在独立隔离环境中验证推断。', '仅继续合法授权范围内的研究。'];
    const report = { title: '通俗分析报告', summary, target: { name: detail.project.name, kind: detail.project.kind, adapter: detail.adapter, status: detail.status }, completed: confirmed.slice(0, 20).map(item => item.title), confirmed: confirmed.slice(0, 20).map(item => ({ title: item.title, source: item.source })), unknown: [...inferred.slice(0, 20).map(item => `${item.title}：推断，不能作为事实`), ...unknown.slice(0, 20).map(item => `${item.title}：未知`)], risks: detail.findings.map(item => ({ severity: item.severity, title: item.title, recommendation: item.recommendation })), nextSteps, technical: { evidence: detail.evidence, findings: detail.findings } };
    const format = String((req.query as { format?: string }).format ?? 'markdown');
    if (format === 'json') return { format: 'json', content: report };
    if (format === 'html') {
      const escape = (value: unknown) => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
      const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(report.title)}</title><style>body{font:16px/1.7 system-ui,sans-serif;max-width:900px;margin:40px auto;padding:0 20px;background:#f8fafc;color:#172033}h1,h2{color:#0f172a}section{background:white;border:1px solid #e2e8f0;border-radius:12px;padding:20px;margin:16px 0}li{margin:6px 0}.muted{color:#64748b}</style></head><body><h1>${escape(report.title)}</h1><section><h2>一句话总结</h2><p>${escape(summary)}</p></section><section><h2>目标信息</h2><p>${escape(detail.project.name)} · ${escape(detail.project.kind)} · ${escape(detail.adapter)} · ${escape(detail.status)}</p></section><section><h2>已完成的分析</h2><ul>${report.completed.map(item => `<li>${escape(item)}</li>`).join('')}</ul></section><section><h2>尚未确认的信息</h2><ul>${report.unknown.map(item => `<li>${escape(item)}</li>`).join('')}</ul></section><section><h2>风险</h2><ul>${report.risks.length ? report.risks.map(item => `<li>${escape(item.severity)}: ${escape(item.title)} — ${escape(item.recommendation)}</li>`).join('') : '<li>未记录已确认风险；这不代表目标没有风险。</li>'}</ul></section><section><h2>下一步建议</h2><ul>${nextSteps.map(item => `<li>${escape(item)}</li>`).join('')}</ul></section><p class="muted">专业证据、工具日志与技术详情请查看任务工作台。</p></body></html>`;
      return { format: 'html', content: html };
    }
    const lines = ['# 通俗分析报告', '', '## 一句话总结', summary, '', '## 目标信息', `- 项目：${detail.project.name}`, `- 类型：${detail.project.kind}`, `- 分析器：${detail.adapter}`, '', '## 已完成的分析', ...report.completed.map(item => `- ${item}`), '', '## 可确认的结论', ...report.confirmed.map(item => `- ${item.title}（来源：${item.source}）`), '', '## 尚未确认的信息', ...report.unknown.map(item => `- ${item}`), '', '## 风险', ...(report.risks.length ? report.risks.map(item => `- ${item.severity}: ${item.title} — ${item.recommendation}`) : ['- 未记录已确认风险；这不代表目标没有风险']), '', '## 下一步建议', ...nextSteps.map(item => `- ${item}`), ''];
    return { format: 'markdown', content: lines.join('\n') };
  });
}

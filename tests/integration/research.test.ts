import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../../apps/api/src/server.js';

const token = 'research-token';
const auth = { authorization: `Bearer ${token}` };
const dirs: string[] = [];
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function setup() { const dataDir = await mkdtemp(path.join(os.tmpdir(), 're-research-')); dirs.push(dataDir); const built = await buildServer({ dataDir, token, backgroundResources: false }); cleanups.push(async () => { await built.app.close(); if (built.db.raw.isOpen) built.db.close(); }); return { ...built, dataDir }; }

async function upload(db: import('@reverse/workflow').Database, dataDir: string, projectId: string, bytes = Buffer.from(JSON.stringify({ log: { version: '1.2', entries: [] } }))) { const { randomUUID } = await import('node:crypto'); const { mkdir } = await import('node:fs/promises'); const { hashFile } = await import('@reverse/evidence'); const dir = path.join(dataDir, 'uploads', projectId); await mkdir(dir, { recursive: true }); const storedName = randomUUID() + '.har'; await writeFile(path.join(dir, storedName), bytes); const value = { id: randomUUID(), projectId, name: 'demo.har', storedName, mime: 'application/octet-stream', size: bytes.length, sha256: await hashFile(path.join(dir, storedName)), createdAt: new Date().toISOString() }; db.addUpload(value); return value; }
async function authorization(app: import('fastify').FastifyInstance, projectId: string, uploadId: string, extra: Record<string, unknown> = {}) { return app.inject({ method: 'POST', url: `/api/projects/${projectId}/authorizations`, headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ target: uploadId, scope: ['read-only'], allowedInterfaces: ['network', 'file'], allowedOperations: ['read-target', 'execute-analyzer'], dataAccess: ['HAR'], remoteAiAllowed: false, ...extra }) }); }

describe('console research and intelligent planning API', () => {
  it('lists console devices and stores an evidence-graded profile', async () => {
    const { app, db } = await setup();
    const devices = await app.inject({ method: 'GET', url: '/api/console/devices', headers: auth });
    expect(devices.statusCode).toBe(200); expect(devices.json().items).toHaveLength(10);
    const project = db.project({ name: 'PS5 research', kind: 'console', authorizationConfirmed: true });
    const profile = { manufacturer: 'Sony', series: 'PlayStation 5', model: 'CFI-1000', hardwareVersion: 'user-provided', systemVersion: 'user-provided', userProvidedInfo: ['owner supplied'], officialInterfaces: [], authorizedDevEnvironments: [], firmwareSamples: [], knownCapabilities: [], actualAccess: 'NONE', researchEvidence: [{ id: 'identity', kind: 'IDENTITY', source: 'user', observedAt: new Date().toISOString(), description: 'owner supplied model' }, { id: 'official', kind: 'OFFICIAL_DOCUMENT', source: 'official', observedAt: new Date().toISOString(), description: 'public product page' }], currentLevel: 'C0', limitations: [] };
    const saved = await app.inject({ method: 'PUT', url: `/api/projects/${project.id}/console-profile`, headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(profile) });
    expect(saved.statusCode).toBe(200); expect(saved.json().profile.currentLevel).toBe('C1');
    const loaded = await app.inject({ method: 'GET', url: `/api/projects/${project.id}/console-profile`, headers: auth });
    expect(loaded.statusCode).toBe(200); expect(loaded.json().profile.currentLevel).toBe('C1');
    const stale = { ...saved.json().profile, currentLevel: 'C5' };
    db.raw.prepare('UPDATE console_profiles SET profile_json=?,level=5 WHERE project_id=?').run(JSON.stringify(stale), project.id);
    const recomputed = await app.inject({ method: 'GET', url: `/api/projects/${project.id}/console-profile`, headers: auth });
    expect(recomputed.statusCode).toBe(200); expect(recomputed.json().profile.currentLevel).toBe('C1');
    db.raw.prepare('UPDATE console_profiles SET profile_json=?,level=5 WHERE project_id=?').run(JSON.stringify({ ...profile, currentLevel: 'C5' }), project.id);
    const downgraded = await app.inject({ method: 'GET', url: `/api/projects/${project.id}/console-profile`, headers: auth });
    expect(downgraded.json().profile.currentLevel).toBe('C1');
  });

  it('creates and executes an authorized deterministic HAR plan', async () => {
    const { app, db, dataDir } = await setup(); const project = db.project({ name: 'HAR plan', kind: 'protocol', authorizationConfirmed: true });
    const file = await upload(db, dataDir, project.id);
    const scope = await authorization(app, project.id, file.id);
    expect(scope.statusCode).toBe(200);
    const plan = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/plans`, headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'beginner', objective: 'Summarize offline requests', uploadId: file.id, authorizationId: scope.json().id, budget: { timeoutMs: 1000 } }) });
    expect(plan.statusCode).toBe(200); expect(plan.json().plan.target.kind).toBe('HAR'); expect(plan.json().plan.steps).toHaveLength(9); expect(plan.json().plan).toMatchObject({ uploadId: file.id, inputHash: file.sha256 });
    const detail = await app.inject({ method: 'GET', url: `/api/plans/${plan.json().plan.id}`, headers: auth }); expect(detail.json().plan).toMatchObject({ uploadId: file.id, inputHash: file.sha256 });
    const executed = await app.inject({ method: 'POST', url: `/api/plans/${plan.json().plan.id}/execute`, headers: auth });
    expect(executed.statusCode).toBe(200); expect(executed.json().task.adapter).toBe('network'); expect(executed.json().task.options).toMatchObject({ uploadId: file.id }); expect(executed.json().task.options.maxDiskMB).toBeUndefined();
    const repeated = await app.inject({ method: 'POST', url: `/api/plans/${plan.json().plan.id}/execute`, headers: auth }); expect(repeated.statusCode).toBe(200); expect(repeated.json().task.id).toBe(executed.json().task.id);
  });

  it('rejects a plan replaced between the execute read and task creation', async () => {
    const { app, db, engine, dataDir } = await setup(); const project = db.project({ name: 'plan CAS', kind: 'protocol', authorizationConfirmed: true }); const file = await upload(db, dataDir, project.id); const scope = await authorization(app, project.id, file.id); expect(scope.statusCode).toBe(200);
    const created = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/plans`, headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'beginner', objective: 'bounded', uploadId: file.id, authorizationId: scope.json().id }) }); expect(created.statusCode).toBe(200);
    const originalCreate = engine.create.bind(engine); let replaced = false; let failure = '';
    engine.create = async (projectId, input) => {
      if (!replaced && input.options?.planId === created.json().plan.id) {
        replaced = true;
        db.raw.prepare("UPDATE analysis_plans SET steps_json=?,updated_at='2030-01-01T00:00:00.000Z' WHERE id=?").run(JSON.stringify([{ id: 'execution', kind: 'execution', status: 'READY', analyzer: 'file', adapterAllowlist: ['file'] }]), created.json().plan.id);
      }
      try { return await originalCreate(projectId, input); } catch (error) { failure = error instanceof Error ? error.message : String(error); throw error; }
    };
    const executed = await app.inject({ method: 'POST', url: `/api/plans/${created.json().plan.id}/execute`, headers: auth });
    expect(replaced).toBe(true); expect(executed.statusCode).toBe(409); expect(failure).toContain('changed after it was read');
    expect(db.raw.prepare('SELECT COUNT(*) count FROM tasks WHERE project_id=?').get(project.id)).toEqual({ count: 0 });
    expect(db.raw.prepare('SELECT task_id FROM analysis_plans WHERE id=?').get(created.json().plan.id)).toEqual({ task_id: null });
  });

  it('normalizes inline authorization and rejects revoked or expired execution', async () => {
    const { app, db, dataDir } = await setup(); const project = db.project({ name: 'inline auth', kind: 'protocol', authorizationConfirmed: true }); const file = await upload(db, dataDir, project.id);
    const plan = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/plans`, headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'beginner', objective: 'bounded', uploadId: file.id, authorization: { granted: true, operations: ['read-target', 'execute-analyzer'], allowedAdapters: ['network'], allowedTargetKinds: ['HAR'] } }) });
    expect(plan.statusCode).toBe(200); expect(plan.json().plan.authorizationId).toBeTruthy(); expect(db.raw.prepare('SELECT target FROM authorization_scopes WHERE id=?').get(plan.json().plan.authorizationId)).toEqual({ target: file.id });
    expect((await app.inject({ method: 'POST', url: '/api/authorizations/' + plan.json().plan.authorizationId + '/revoke', headers: auth })).statusCode).toBe(200);
    const revoked = await app.inject({ method: 'POST', url: `/api/plans/${plan.json().plan.id}/execute`, headers: auth }); expect(revoked.statusCode).toBe(409);
    const scope = await authorization(app, project.id, file.id); expect(scope.statusCode).toBe(200);
    const expiredPlan = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/plans`, headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'beginner', objective: 'bounded', uploadId: file.id, authorizationId: scope.json().id }) }); expect(expiredPlan.statusCode).toBe(200); db.raw.prepare("UPDATE authorization_scopes SET revoked_at=NULL,expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(scope.json().id); expect((await app.inject({ method: 'POST', url: `/api/plans/${expiredPlan.json().plan.id}/execute`, headers: auth })).statusCode).toBe(409);
  });

  it('fails closed for a changed upload and legacy unbound plans', async () => {
    const { app, db, dataDir } = await setup(); const project = db.project({ name: 'binding', kind: 'protocol', authorizationConfirmed: true }); const file = await upload(db, dataDir, project.id); const scope = await authorization(app, project.id, file.id);
    const create = () => app.inject({ method: 'POST', url: `/api/projects/${project.id}/plans`, headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'beginner', objective: 'bounded', uploadId: file.id, authorizationId: scope.json().id }) });
    const original = Buffer.from(JSON.stringify({ log: { version: '1.2', entries: [] } }));
    const first = await create(); expect(first.statusCode).toBe(200); await writeFile(path.join(dataDir, 'uploads', project.id, file.storedName), 'tampered'); expect((await app.inject({ method: 'POST', url: `/api/plans/${first.json().plan.id}/execute`, headers: auth })).statusCode).toBe(409);
    await writeFile(path.join(dataDir, 'uploads', project.id, file.storedName), original);
    const legacy = await create(); expect(legacy.statusCode).toBe(200); db.raw.prepare('UPDATE analysis_plans SET upload_id=NULL,upload_sha256=NULL WHERE id=?').run(legacy.json().plan.id); expect((await app.inject({ method: 'POST', url: `/api/plans/${legacy.json().plan.id}/execute`, headers: auth })).statusCode).toBe(409);
  });

  it('binds normalized no-upload URL plans to the project target without selecting an unrelated upload', async () => {
    const { app, db, dataDir } = await setup(); const target = ' HTTPS://EXAMPLE.TEST:443/research#overview '; const project = db.project({ name: 'URL plan', kind: 'website', target, authorizationConfirmed: true }); await upload(db, dataDir, project.id);
    const scope = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/authorizations`, headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ target, scope: ['read-only'], allowedInterfaces: ['website'], allowedOperations: ['read-target', 'execute-analyzer'], dataAccess: ['UNKNOWN'] }) }); expect(scope.statusCode).toBe(200);
    expect(db.raw.prepare('SELECT target FROM authorization_scopes WHERE id=?').get(scope.json().id)).toEqual({ target: 'https://example.test/research' });
    const plan = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/plans`, headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'beginner', objective: 'Inspect authorized page', target, declaredKind: 'UNKNOWN', authorizationId: scope.json().id, adapterAllowlist: ['website'] }) });
    expect(plan.statusCode).toBe(200); expect(plan.json().plan).toMatchObject({ uploadId: null, inputHash: null });
    const executed = await app.inject({ method: 'POST', url: `/api/plans/${plan.json().plan.id}/execute`, headers: auth });
    expect(executed.statusCode, `${executed.body}\nPLAN=${plan.body}`).toBe(200); expect(executed.json().task.adapter).toBe('website'); expect(executed.json().task.options.uploadId).toBeUndefined();
    const pending = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/plans`, headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'beginner', objective: 'Inspect authorized page', target, declaredKind: 'UNKNOWN', authorizationId: scope.json().id, adapterAllowlist: ['website'] }) });
    db.raw.prepare('UPDATE projects SET target=? WHERE id=?').run('https://example.test/changed', project.id);
    expect((await app.inject({ method: 'POST', url: `/api/plans/${pending.json().plan.id}/execute`, headers: auth })).statusCode).toBe(409);
  });

  it('rejects malformed authorization and plan bodies with 400', async () => {
    const { app, db, dataDir } = await setup(); const project = db.project({ name: 'validation', kind: 'protocol', authorizationConfirmed: true }); const file = await upload(db, dataDir, project.id);
    const other = await upload(db, dataDir, project.id); const wrongTarget = await authorization(app, project.id, other.id); expect(wrongTarget.statusCode).toBe(200); expect((await app.inject({ method: 'POST', url: `/api/projects/${project.id}/plans`, headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'beginner', objective: 'bounded', uploadId: file.id, authorizationId: wrongTarget.json().id }) })).statusCode).toBe(409);
    for (const body of ['null', '[]', JSON.stringify({ target: 'x', scope: [1], allowedInterfaces: [], allowedOperations: [], dataAccess: [] }), JSON.stringify({ target: 'x', scope: ['a'.repeat(129)], allowedInterfaces: [], allowedOperations: [], dataAccess: [] })]) expect((await app.inject({ method: 'POST', url: `/api/projects/${project.id}/authorizations`, headers: { ...auth, 'content-type': 'application/json' }, body })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `/api/projects/${project.id}/plans`, headers: { ...auth, 'content-type': 'application/json' }, body: 'null' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/console/diagnose-usb', headers: { ...auth, 'content-type': 'application/json' }, body: 'null' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/console/diagnose-usb', headers: { ...auth, 'content-type': 'application/json' }, body: '[]' })).statusCode).toBe(400);
    const consoleProject = db.project({ name: 'console validation', kind: 'console', authorizationConfirmed: true });
    expect((await app.inject({ method: 'PUT', url: `/api/projects/${consoleProject.id}/console-profile`, headers: { ...auth, 'content-type': 'application/json' }, body: 'null' })).statusCode).toBe(400);
  });

  it('runs a built-in firmware demo and returns a plain-language report', async () => {
    const { app, db } = await setup();
    const demo = await app.inject({ method: 'POST', url: '/api/demos/firmware/run', headers: auth });
    expect(demo.statusCode).toBe(200); expect(demo.json().taskId).toBeTruthy();
    const task = db.getTask(demo.json().taskId)!; db.addEvidence({ taskId: task.id, kind: 'EVIDENCE', title: 'UF2 block metadata', source: 'firmware', locator: 'demo', content: { blocks: 1 }, sha256: 'a'.repeat(64) });
    const report = await app.inject({ method: 'GET', url: `/api/tasks/${task.id}/report/plain`, headers: auth });
    expect(report.statusCode).toBe(200); expect(report.json().content).toContain('UF2 block metadata'); expect(report.json().content).toContain('一句话总结');
    const json = await app.inject({ method: 'GET', url: `/api/tasks/${task.id}/report/plain?format=json`, headers: auth });
    expect(json.statusCode).toBe(200); expect(json.json().content.summary).toContain('UF2'); expect(json.json().content.technical.evidence).toHaveLength(1);
    const html = await app.inject({ method: 'GET', url: `/api/tasks/${task.id}/report/plain?format=html`, headers: auth });
    expect(html.statusCode).toBe(200); expect(html.json().content).toContain('<!doctype html>'); expect(html.json().content).toContain('UF2 block metadata');
  });
});

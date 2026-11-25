import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../../apps/api/src/server.js';

const gate = vi.hoisted(() => ({ entered: undefined as (() => void) | undefined, release: undefined as (() => void) | undefined }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rm: async (...args: Parameters<typeof actual.rm>) => {
    if (String(args[0]).includes(`${path.sep}uploads${path.sep}`) && gate.entered) { const entered = gate.entered; gate.entered = undefined; entered(); await new Promise<void>(resolve => { gate.release = resolve; }); }
    return actual.rm(...args);
  } };
});
const dirs: string[] = [];
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { gate.release?.(); gate.release = undefined; gate.entered = undefined; for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe('project deletion races', () => {
  it('does not leave a task directory when creation races the deletion snapshot', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 're-project-delete-race-')); dirs.push(dataDir);
    const built = await buildServer({ dataDir, token: 'race-token', backgroundResources: false }); cleanups.push(async () => { await built.app.close(); built.db.close(); });
    const project = built.db.project({ name: 'delete race', kind: 'software', authorizationConfirmed: true });
    let enteredResolve!: () => void; const entered = new Promise<void>(resolve => { enteredResolve = resolve; }); gate.entered = enteredResolve;
    const headers = { authorization: 'Bearer race-token', 'content-type': 'application/json' };
    const deletion = built.app.inject({ method: 'DELETE', url: `/api/projects/${project.id}`, headers, body: JSON.stringify({ confirm: project.name }) });
    await entered;
    let createdTaskId: string | undefined;
    const creation = built.app.inject({ method: 'POST', url: `/api/projects/${project.id}/tasks`, headers, body: JSON.stringify({ adapter: 'file' }) }).then(response => {
      if (response.statusCode === 201) { createdTaskId = response.json().id as string; const dir = path.join(dataDir, 'tasks', createdTaskId); mkdirSync(path.join(dir, 'artifacts'), { recursive: true }); writeFileSync(path.join(dir, 'artifacts', 'marker'), 'raced'); }
      return response;
    });
    await new Promise<void>(resolve => setImmediate(resolve)); gate.release!();
    const [deleted, created] = await Promise.all([deletion, creation]);
    expect(deleted.statusCode).toBe(200); expect(created.statusCode).toBe(404); expect(createdTaskId).toBeUndefined();
    expect(built.db.getProject(project.id)).toBeUndefined();
    const tasksDir = path.join(dataDir, 'tasks'); expect(existsSync(tasksDir) ? await readdir(tasksDir) : []).toEqual([]);
  });
});

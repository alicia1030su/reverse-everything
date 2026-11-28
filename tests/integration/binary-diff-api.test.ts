import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { AppError } from '@reverse/contracts';
import { ghidraMetadataToProgram, type GhidraProgramInput } from '@reverse/program-ir';
import { registerBinaryDiffRoutes } from '../../apps/api/src/binary-diff-routes.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function setup(sameInput = false) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 're-binary-diff-api-'));
  const metadata = JSON.parse(await readFile('tests/fixtures/program-ir/ghidra-metadata.json', 'utf8')) as GhidraProgramInput;
  const before = ghidraMetadataToProgram(metadata, 'before');
  const changed = structuredClone(metadata); changed.functions[0]!.name = 'sum_bytes_v2';
  const after = ghidraMetadataToProgram(changed, 'after');
  if (after.provenance && before.provenance) after.provenance.inputSha256 = sameInput ? before.provenance.inputSha256 : 'b'.repeat(64);
  const files = new Map<string, string>();
  const artifacts = new Map<string, Array<{ name: string; size: number; sha256: string }>>();
  for (const [taskId, program] of [['before-task', before], ['after-task', after]] as const) {
    const file = path.join(dir, `${taskId}.json`); const content = `${JSON.stringify(program, null, 2)}\n`;
    await writeFile(file, content); files.set(taskId, file);
    artifacts.set(taskId, [{ name: 'program-ir.json', size: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex') }]);
  }
  const db = {
    getTask: (id: string) => files.has(id) ? { id, status: 'COMPLETED' } : undefined,
    artifacts: (id: string) => artifacts.get(id) ?? [],
    artifactPath: (id: string, name: string) => files.has(id) && name === 'program-ir.json' ? files.get(id) : undefined,
  };
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _req, reply) => {
    const status = error instanceof AppError ? error.status : Number((error as { statusCode?: number }).statusCode ?? 500);
    return reply.code(status).send({ error: { code: error instanceof AppError ? error.code : 'ERROR', message: error.message } });
  });
  registerBinaryDiffRoutes(app, { db: db as never });
  cleanups.push(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  return { app, dir, before, after, files, artifacts };
}

describe('Binary Diff API', () => {
  it('compares verified Program IR artifacts and returns evidence-bound matches', async () => {
    const { app } = await setup();
    const response = await app.inject({ method: 'POST', url: '/api/binary-diff', payload: { beforeTaskId: 'before-task', afterTaskId: 'after-task' } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ status: 'PASSED', comparedBinaries: 2, summary: { matchedFunctions: 3, modifiedFunctions: 2 } });
    expect(response.json().matches.find((item: { beforeName: string }) => item.beforeName === 'sum_bytes')).toMatchObject({ afterName: 'sum_bytes_v2', method: 'exact-fingerprint' });
  });

  it('rejects identical tasks and identical input binaries', async () => {
    const { app } = await setup();
    expect((await app.inject({ method: 'POST', url: '/api/binary-diff', payload: { beforeTaskId: 'before-task', afterTaskId: 'before-task' } })).statusCode).toBe(400);
    const same = await setup(true);
    expect((await same.app.inject({ method: 'POST', url: '/api/binary-diff', payload: { beforeTaskId: 'before-task', afterTaskId: 'after-task' } })).statusCode).toBe(400);
  });

  it('rejects missing artifacts and invalid bounds', async () => {
    const { app } = await setup();
    expect((await app.inject({ method: 'POST', url: '/api/binary-diff', payload: { beforeTaskId: 'missing', afterTaskId: 'after-task' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/binary-diff', payload: { beforeTaskId: 'before-task', afterTaskId: 'after-task', maxFunctions: 0 } })).statusCode).toBe(400);
  });

  it('fails closed when artifact content no longer matches its manifest', async () => {
    const { app, files } = await setup();
    await writeFile(files.get('after-task')!, '{}');
    const response = await app.inject({ method: 'POST', url: '/api/binary-diff', payload: { beforeTaskId: 'before-task', afterTaskId: 'after-task' } });
    expect(response.statusCode).toBe(409);
  });
});

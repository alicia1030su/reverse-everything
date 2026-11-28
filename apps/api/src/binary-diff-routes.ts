import type { FastifyInstance } from 'fastify';
import { diffPrograms, type BinaryDiffOptions } from '@reverse/binary-diff';
import { assertProgramIr, type ProgramIr } from '@reverse/program-ir';
import { readVerifiedFile, safeArtifactName } from '@reverse/evidence';
import { AppError } from '@reverse/contracts';
import type { Database } from '@reverse/workflow';

interface BinaryDiffRouteOptions { db: Database }
const MAX_PROGRAM_IR_BYTES = 32 * 1024 * 1024;

function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || !value.trim() || value.length > 128 || /[\u0000-\u001f\u007f\\/]/.test(value)) throw new AppError('BAD_REQUEST', `${key} must be a bounded identifier`, 400);
  return value;
}

function optionsFrom(body: Record<string, unknown>): BinaryDiffOptions {
  const options: BinaryDiffOptions = {};
  if (body.maxFunctions !== undefined) {
    if (typeof body.maxFunctions !== 'number' || !Number.isSafeInteger(body.maxFunctions) || body.maxFunctions < 1 || body.maxFunctions > 5000) throw new AppError('BAD_REQUEST', 'maxFunctions must be an integer from 1 to 5000', 400);
    options.maxFunctions = body.maxFunctions;
  }
  if (body.minSimilarity !== undefined) {
    if (typeof body.minSimilarity !== 'number' || !Number.isFinite(body.minSimilarity) || body.minSimilarity < 0 || body.minSimilarity > 1) throw new AppError('BAD_REQUEST', 'minSimilarity must be between 0 and 1', 400);
    options.minSimilarity = body.minSimilarity;
  }
  if (body.maxChanges !== undefined) {
    if (typeof body.maxChanges !== 'number' || !Number.isSafeInteger(body.maxChanges) || body.maxChanges < 1 || body.maxChanges > 500) throw new AppError('BAD_REQUEST', 'maxChanges must be an integer from 1 to 500', 400);
    options.maxChanges = body.maxChanges;
  }
  return options;
}

async function loadProgramIr(db: Database, taskId: string, artifactName: string): Promise<ProgramIr> {
  const task = db.getTask(taskId);
  if (!task) throw new AppError('NOT_FOUND', 'Task not found', 404);
  if (!['COMPLETED', 'PARTIAL_SUCCESS'].includes(task.status)) throw new AppError('CONFLICT', 'Task must be completed before its Program IR can be compared', 409);
  let name: string;
  try { name = safeArtifactName(artifactName); }
  catch { throw new AppError('BAD_REQUEST', 'Invalid Program IR artifact name', 400); }
  const artifact = db.artifacts(taskId).find(item => item.name === name);
  const file = db.artifactPath(taskId, name);
  if (!artifact || !file) throw new AppError('NOT_FOUND', 'Program IR artifact not found', 404);
  if (artifact.size > MAX_PROGRAM_IR_BYTES) throw new AppError('PAYLOAD_TOO_LARGE', 'Program IR artifact exceeds the 32 MiB diff limit', 413);
  let bytes: Buffer;
  try { bytes = await readVerifiedFile(file, artifact.size, artifact.sha256); }
  catch { throw new AppError('CONFLICT', 'Program IR artifact failed size or SHA-256 verification', 409); }
  let program: ProgramIr;
  try { program = JSON.parse(bytes.toString('utf8')) as ProgramIr; assertProgramIr(program, { allowPartial: true }); }
  catch (error) { throw new AppError('BAD_REQUEST', `Invalid Program IR artifact: ${error instanceof Error ? error.message : String(error)}`, 400); }
  return program;
}

export function registerBinaryDiffRoutes(app: FastifyInstance, options: BinaryDiffRouteOptions): void {
  app.post('/api/binary-diff', async req => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) throw new AppError('BAD_REQUEST', 'A JSON object body is required', 400);
    const body = req.body as Record<string, unknown>;
    const beforeTaskId = stringField(body, 'beforeTaskId');
    const afterTaskId = stringField(body, 'afterTaskId');
    if (beforeTaskId === afterTaskId) throw new AppError('BAD_REQUEST', 'beforeTaskId and afterTaskId must be different', 400);
    const beforeArtifact = body.beforeArtifact === undefined ? 'program-ir.json' : stringField(body, 'beforeArtifact');
    const afterArtifact = body.afterArtifact === undefined ? 'program-ir.json' : stringField(body, 'afterArtifact');
    const diffOptions = optionsFrom(body);
    const [before, after] = await Promise.all([
      loadProgramIr(options.db, beforeTaskId, beforeArtifact),
      loadProgramIr(options.db, afterTaskId, afterArtifact),
    ]);
    if (before.provenance?.inputSha256 && before.provenance.inputSha256 === after.provenance?.inputSha256) throw new AppError('BAD_REQUEST', 'Both tasks reference the same input binary SHA-256', 400);
    try { return diffPrograms({ before, after, options: diffOptions }); }
    catch (error) { throw new AppError('BAD_REQUEST', error instanceof Error ? error.message : 'Binary diff failed', 400); }
  });
}

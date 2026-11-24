import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { VERSION } from '@reverse/contracts';
import { fileAdapter } from '@reverse/core';
import { AnalysisCache, Database, WorkflowEngine } from '@reverse/workflow';

const DEFAULT_TASKS = 100;
const DEFAULT_SAMPLE_EVERY = 10;
const DEFAULT_RSS_GROWTH_MB = 128;
const DEFAULT_RSS_SLOPE_MB_PER_100_TASKS = 64;
const DEFAULT_HANDLE_GROWTH = 2;
const MEMORY_TREND_MIN_TASKS = 40;
const MB = 1024 * 1024;

export function positiveInteger(value, fallback, name, minimum = 1) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(`${name} must be an integer >= ${minimum}`);
  return parsed;
}

export function nonNegativeNumber(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be a finite number >= 0`);
  return parsed;
}

export function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

export function summarize(values) {
  return {
    samples: values.length,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    min: values.length ? Math.min(...values) : 0,
    max: values.length ? Math.max(...values) : 0,
  };
}

export function quickCheck(db) {
  const rows = db.raw.prepare('PRAGMA quick_check').all();
  const result = rows.map(row => String(row.quick_check));
  return { passed: result.length === 1 && result[0] === 'ok', result };
}

function linearSlope(points) {
  if (points.length < 2) return 0;
  const meanX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
  const meanY = points.reduce((sum, point) => sum + point.y, 0) / points.length;
  const denominator = points.reduce((sum, point) => sum + (point.x - meanX) ** 2, 0);
  if (denominator === 0) return 0;
  return points.reduce((sum, point) => sum + (point.x - meanX) * (point.y - meanY), 0) / denominator;
}

export function analyzeMemoryTrend(samples, limits = {}) {
  const growthLimitMB = limits.growthLimitMB ?? DEFAULT_RSS_GROWTH_MB;
  const slopeLimitMBPer100Tasks = limits.slopeLimitMBPer100Tasks ?? DEFAULT_RSS_SLOPE_MB_PER_100_TASKS;
  const midpoint = Math.floor(samples.length / 2);
  const firstHalf = samples.slice(0, midpoint);
  const secondHalf = samples.slice(midpoint);
  if (samples.length < 4 || secondHalf.length < 2) {
    return {
      passed: false,
      sufficientSamples: false,
      reason: 'At least four memory samples with two in the second half are required',
      sampleCount: samples.length,
      growthMB: 0,
      slopeMBPerTask: 0,
      slopeMBPer100Tasks: 0,
      growthLimitMB,
      slopeLimitMBPer100Tasks,
    };
  }
  const points = secondHalf.map(sample => ({ x: sample.taskNumber, y: sample.rssMB }));
  const firstMean = firstHalf.reduce((sum, sample) => sum + sample.rssMB, 0) / firstHalf.length;
  const secondMean = secondHalf.reduce((sum, sample) => sum + sample.rssMB, 0) / secondHalf.length;
  const slopeMBPerTask = linearSlope(points);
  const growthMB = secondMean - firstMean;
  const slopeMBPer100Tasks = slopeMBPerTask * 100;
  return {
    passed: growthMB <= growthLimitMB && slopeMBPer100Tasks <= slopeLimitMBPer100Tasks,
    sufficientSamples: true,
    sampleCount: samples.length,
    firstHalfMeanRssMB: firstMean,
    secondHalfMeanRssMB: secondMean,
    growthMB,
    endToEndGrowthMB: secondHalf.at(-1).rssMB - secondHalf[0].rssMB,
    slopeMBPerTask,
    slopeMBPer100Tasks,
    growthLimitMB,
    slopeLimitMBPer100Tasks,
  };
}

function activeHandles() {
  return process._getActiveHandles().length;
}

function taskStateIssues(db, taskIds) {
  const issues = [];
  for (const taskId of taskIds) {
    const task = db.getTask(taskId);
    if (!task) {
      issues.push({ taskId, issue: 'task missing' });
      continue;
    }
    if (task.status !== 'COMPLETED') {
      issues.push({ taskId, issue: `unexpected terminal status ${task.status}`, error: task.error });
      continue;
    }
    if (task.currentStage !== 'COMPLETED' || task.progress !== 100 || task.currentTool !== null) {
      issues.push({ taskId, issue: 'inconsistent completed task fields', currentStage: task.currentStage, progress: task.progress, currentTool: task.currentTool });
    }
    const stages = db.stages(taskId);
    const unsuccessful = stages.filter(stage => stage.status !== 'SUCCEEDED').map(stage => `${stage.name}:${stage.status}`);
    if (unsuccessful.length || stages.length !== 13) issues.push({ taskId, issue: 'stage terminal state mismatch', unsuccessful, stageCount: stages.length });
    if (!db.artifacts(taskId).length) issues.push({ taskId, issue: 'completed task has no artifacts' });
  }
  return issues;
}

async function createProjectWithUpload(db, dataDir, index) {
  const project = db.project({ name: `soak-${index}`, kind: 'software', target: 'soak-input.json', authorizationConfirmed: true });
  const content = JSON.stringify({ name: 'soak-fixture', version: '1.0.0', dependencies: { fixture: '1.0.0' } });
  const bytes = Buffer.from(content);
  const uploadDir = path.join(dataDir, 'uploads', project.id);
  await mkdir(uploadDir, { recursive: true });
  const storedName = 'soak-input.json';
  await writeFile(path.join(uploadDir, storedName), bytes);
  const digest = createHash('sha256').update(bytes).digest('hex');
  db.addUpload({ id: randomUUID(), projectId: project.id, name: 'soak-input.json', storedName, mime: 'application/json', size: bytes.length, sha256: digest, createdAt: new Date().toISOString() });
  return project;
}

export async function runSoak(options = {}) {
  const taskCount = positiveInteger(options.taskCount ?? process.env.RE_SOAK_TASKS, DEFAULT_TASKS, 'RE_SOAK_TASKS');
  const sampleEvery = positiveInteger(options.sampleEvery ?? process.env.RE_SOAK_SAMPLE_EVERY, DEFAULT_SAMPLE_EVERY, 'RE_SOAK_SAMPLE_EVERY');
  const growthLimitMB = nonNegativeNumber(options.growthLimitMB ?? process.env.RE_SOAK_MAX_RSS_GROWTH_MB, DEFAULT_RSS_GROWTH_MB, 'RE_SOAK_MAX_RSS_GROWTH_MB');
  const slopeLimitMBPer100Tasks = nonNegativeNumber(options.slopeLimitMBPer100Tasks ?? process.env.RE_SOAK_MAX_RSS_SLOPE_MB_PER_100_TASKS, DEFAULT_RSS_SLOPE_MB_PER_100_TASKS, 'RE_SOAK_MAX_RSS_SLOPE_MB_PER_100_TASKS');
  const handleGrowthLimit = positiveInteger(options.handleGrowthLimit ?? process.env.RE_SOAK_MAX_HANDLE_GROWTH, DEFAULT_HANDLE_GROWTH, 'RE_SOAK_MAX_HANDLE_GROWTH', 0);
  const failAt = options.failAt === undefined ? undefined : positiveInteger(options.failAt, 1, 'failAt');
  if (failAt !== undefined && failAt > taskCount) throw new Error('failAt must be <= taskCount');
  if (taskCount < sampleEvery * 4) throw new Error('taskCount must be >= sampleEvery * 4 for second-half RSS trend analysis');
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const dataDir = options.dataDir ?? await mkdtemp(path.join(os.tmpdir(), 're-soak-'));
  await mkdir(dataDir, { recursive: true });
  const db = new Database(':memory:');
  const cache = new AnalysisCache(db, dataDir, { maxBytes: 64 * MB, ttlDays: 1 });
  let engine;
  const baselineHandles = activeHandles();
  const baselineMemory = process.memoryUsage();
  const samples = [];
  const taskIds = [];
  const durationsMs = [];
  const artifactCounts = [];
  const failures = [];
  let finalCache;
  let quickCheckResult;
  let finalHandles;
  let closeError = null;
  let capturedStateIssues = [];
  try {
    const adapter = failAt === undefined ? fileAdapter : {
      ...fileAdapter,
      extractEvidence: async ctx => {
        if (taskIds.length === failAt) throw new Error(`Injected soak failure at task ${failAt}`);
        return fileAdapter.extractEvidence(ctx);
      },
    };
    engine = new WorkflowEngine(db, { dataDir, adapters: [adapter], cache, timeoutMs: 30000, pollMs: 60000, maxQueue: taskCount + 1 });
    const project = await createProjectWithUpload(db, dataDir, 0);
    for (let index = 1; index <= taskCount; index++) {
      const task = await engine.create(project.id, { adapter: 'file' });
      taskIds.push(task.id);
      const taskStarted = performance.now();
      await engine.execute(task.id);
      durationsMs.push(performance.now() - taskStarted);
      const current = db.getTask(task.id);
      const artifacts = db.artifacts(task.id);
      artifactCounts.push(artifacts.length);
      if (current?.status !== 'COMPLETED') failures.push({ taskNumber: index, taskId: task.id, status: current?.status ?? 'MISSING', error: current?.error });
      if (index % sampleEvery === 0 || index === taskCount) {
        const memory = process.memoryUsage();
        samples.push({
          taskNumber: index,
          rssMB: memory.rss / MB,
          heapTotalMB: memory.heapTotal / MB,
          heapUsedMB: memory.heapUsed / MB,
          externalMB: memory.external / MB,
          arrayBuffersMB: memory.arrayBuffers / MB,
          handles: activeHandles(),
          quickCheck: quickCheck(db),
          cache: cache.statistics(),
          failed: failures.length,
          completed: db.stats().completed,
        });
      }
    }
    finalCache = cache.statistics();
    quickCheckResult = quickCheck(db);
    capturedStateIssues = taskStateIssues(db, taskIds);
    await engine.close();
    engine = undefined;
    db.close();
    await new Promise(resolve => setImmediate(resolve));
    finalHandles = activeHandles();
  } catch (error) {
    closeError = error instanceof Error ? error.message : String(error);
    capturedStateIssues = taskStateIssues(db, taskIds);
  } finally {
    if (engine) await engine.close().catch(() => undefined);
    if (db.raw.isOpen) db.close();
    if (options.dataDir === undefined) await rm(dataDir, { recursive: true, force: true });
  }
  const endMemory = process.memoryUsage();
  const trend = analyzeMemoryTrend(samples, { growthLimitMB, slopeLimitMBPer100Tasks });
  const stateIssues = capturedStateIssues;
  const failedQuickChecks = samples.filter(sample => !sample.quickCheck.passed).length + (quickCheckResult?.passed ? 0 : 1);
  const handleGrowth = finalHandles === undefined ? null : finalHandles - baselineHandles;
  const measuredSeconds = (performance.now() - started) / 1000;
  const memoryTrendGateApplied = taskCount >= MEMORY_TREND_MIN_TASKS;
  const passed = !closeError && failures.length === 0 && stateIssues.length === 0 && failedQuickChecks === 0 && (!memoryTrendGateApplied || trend.passed) && (handleGrowth === null || handleGrowth <= handleGrowthLimit);
  return {
    schemaVersion: 1,
    product: 'reverse-everything',
    productVersion: VERSION,
    measuredAt: startedAt,
    platform: process.platform,
    node: process.version,
    environment: { arch: process.arch, cpu: os.cpus()[0]?.model, logicalCores: os.cpus().length, totalMemoryMB: os.totalmem() / MB },
    configuration: { taskCount, sampleEvery, concurrency: 1, adapter: 'file', adapterVersion: fileAdapter.version, database: ':memory:', growthLimitMB, slopeLimitMBPer100Tasks, memoryTrendMinTasks: MEMORY_TREND_MIN_TASKS, memoryTrendGateApplied, handleGrowthLimit, failAt: failAt ?? null },
    durationMs: performance.now() - started,
    throughput: { completed: taskIds.length - failures.length, failed: failures.length, tasksPerSecond: taskIds.length / measuredSeconds },
    durationsMs: summarize(durationsMs),
    artifacts: { total: artifactCounts.reduce((sum, count) => sum + count, 0), perTask: summarize(artifactCounts) },
    cache: { initial: { hits: 0, misses: 0, writes: 0, entries: 0 }, final: finalCache, verifiedHotCache: finalCache ? failures.length === 0 && finalCache.misses === 3 && finalCache.writes === taskCount * 3 && finalCache.hits === (taskCount - 1) * 3 : false },
    memory: {
      baseline: { rssMB: baselineMemory.rss / MB, heapUsedMB: baselineMemory.heapUsed / MB },
      final: { rssMB: endMemory.rss / MB, heapUsedMB: endMemory.heapUsed / MB },
      peakRssMB: Math.max(baselineMemory.rss / MB, ...samples.map(sample => sample.rssMB)),
      peakHeapUsedMB: Math.max(baselineMemory.heapUsed / MB, ...samples.map(sample => sample.heapUsedMB)),
      trend,
      baselineHandles,
      finalHandles,
      handleGrowth,
      handleGrowthLimit,
    },
    integrity: { finalQuickCheck: quickCheckResult, failedQuickChecks, taskStateIssues: stateIssues },
    failures,
    fatalError: closeError,
    samples,
    passed,
  };
}

export function dryRunReport(options = {}) {
  const taskCount = positiveInteger(options.taskCount ?? process.env.RE_SOAK_TASKS, DEFAULT_TASKS, 'RE_SOAK_TASKS');
  const sampleEvery = positiveInteger(options.sampleEvery ?? process.env.RE_SOAK_SAMPLE_EVERY, DEFAULT_SAMPLE_EVERY, 'RE_SOAK_SAMPLE_EVERY');
  return {
    schemaVersion: 1,
    product: 'reverse-everything',
    productVersion: VERSION,
    mode: 'dry-run',
    executedTasks: 0,
    configuration: { taskCount, sampleEvery, concurrency: 1, adapter: 'file', database: ':memory:' },
    message: 'Dry run only. Re-run with --confirm SOAK to execute the workload.',
    passed: true,
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log(JSON.stringify({ usage: 'node scripts/soak.mjs [--dry-run] [--confirm SOAK]', environment: ['RE_SOAK_TASKS (default 100)', 'RE_SOAK_SAMPLE_EVERY (default 10)', 'RE_SOAK_MAX_RSS_GROWTH_MB (default 128)', 'RE_SOAK_MAX_RSS_SLOPE_MB_PER_100_TASKS (default 64)', 'RE_SOAK_MAX_HANDLE_GROWTH (default 2)'] }, null, 2));
    return;
  }
  if (!args.includes('--confirm') || args[args.indexOf('--confirm') + 1] !== 'SOAK') {
    console.log(JSON.stringify(dryRunReport(), null, 2));
    return;
  }
  const report = await runSoak();
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(JSON.stringify({ passed: false, fatalError: error instanceof Error ? error.message : String(error) }, null, 2));
    process.exitCode = 1;
  });
}

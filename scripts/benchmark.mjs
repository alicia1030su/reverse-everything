import { spawn, execFileSync, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { PerformanceObserver } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { getHeapStatistics } from 'node:v8';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRODUCT_VERSION = (await readFile(path.join(ROOT, 'VERSION'), 'utf8')).trim();
const MB = 1024 * 1024;
const DEFAULT_SAMPLES = 7;
const DEFAULT_WARMUP = 2;

function positiveInteger(value, fallback, name, minimum = 1) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(`${name} must be an integer >= ${minimum}`);
  return parsed;
}

function nonNegativeNumber(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be a finite number >= 0`);
  return parsed;
}

function ratio(value, fallback, name) {
  const parsed = nonNegativeNumber(value, fallback, name);
  if (parsed > 1) throw new Error(`${name} must be between 0 and 1`);
  return parsed;
}

function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function summarize(values) {
  return {
    samples: values.length,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    min: values.length ? Math.min(...values) : 0,
    max: values.length ? Math.max(...values) : 0,
    mean: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0,
  };
}

class MemorySampler {
  constructor() {
    this.peak = process.memoryUsage();
    this.interval = setInterval(() => this.sample(), 5);
  }
  sample() {
    const current = process.memoryUsage();
    for (const key of ['rss', 'heapTotal', 'heapUsed', 'external', 'arrayBuffers']) this.peak[key] = Math.max(this.peak[key], current[key]);
  }
  stop() {
    clearInterval(this.interval);
    this.sample();
    return {
      peakRssMB: this.peak.rss / MB,
      peakHeapTotalMB: this.peak.heapTotal / MB,
      peakHeapUsedMB: this.peak.heapUsed / MB,
      peakExternalMB: this.peak.external / MB,
      peakArrayBuffersMB: this.peak.arrayBuffers / MB,
      samplingIntervalMs: 5,
    };
  }
}

function cacheDelta(before, after) {
  return {
    hits: after.hits - before.hits,
    misses: after.misses - before.misses,
    writes: after.writes - before.writes,
    corrupt: after.corrupt - before.corrupt,
    evictions: after.evictions - before.evictions,
    hitRate: after.hits + after.misses === before.hits + before.misses ? 0 : (after.hits - before.hits) / ((after.hits - before.hits) + (after.misses - before.misses)),
  };
}

async function createProjectWithUpload(db, dataDir, index) {
  const project = db.project({ name: `benchmark-${index}`, kind: 'software', target: 'benchmark-input.json', authorizationConfirmed: true });
  const content = JSON.stringify({ name: 'benchmark-fixture', version: '1.0.0', dependencies: { fixture: '1.0.0' } });
  const bytes = Buffer.from(content);
  const uploadDir = path.join(dataDir, 'uploads', project.id);
  await mkdir(uploadDir, { recursive: true });
  const storedName = 'benchmark-input.json';
  await writeFile(path.join(uploadDir, storedName), bytes);
  const digest = createHash('sha256').update(bytes).digest('hex');
  db.addUpload({ id: randomUUID(), projectId: project.id, name: storedName, storedName, mime: 'application/json', size: bytes.length, sha256: digest, createdAt: new Date().toISOString() });
  return project;
}

async function measureTask(engine, db, cache, project, taskNumber) {
  const task = await engine.create(project.id, { adapter: 'file' });
  const before = cache.statistics();
  const beforeCacheHits = new Map((db.raw.prepare('SELECT key,hits FROM cache_entries').all()).map(row => [row.key, Number(row.hits)]));
  const sampler = new MemorySampler();
  const started = performance.now();
  await engine.execute(task.id);
  const durationMs = performance.now() - started;
  const memory = sampler.stop();
  const current = db.getTask(task.id);
  const stages = db.stages(task.id).map(stage => ({
    name: stage.name,
    status: stage.status,
    durationMs: stage.startedAt && stage.endedAt ? Date.parse(stage.endedAt) - Date.parse(stage.startedAt) : null,
    cacheHit: Boolean(stage.cacheKey && ['CLASSIFY', 'PREPARE', 'ANALYZE'].includes(stage.name) && Number(db.raw.prepare('SELECT hits FROM cache_entries WHERE key=?').get(stage.cacheKey)?.hits ?? 0) > Number(beforeCacheHits.get(stage.cacheKey) ?? 0)),
  }));
  return {
    taskNumber,
    taskId: task.id,
    status: current?.status ?? 'MISSING',
    error: current?.error,
    durationMs,
    stages,
    evidence: db.evidence(task.id).length,
    detectedEvidenceSha256: createHash('sha256').update(JSON.stringify(db.evidence(task.id).filter(item => item.title.startsWith('Detected ')).map(({ kind, title, source, locator, content, sha256 }) => ({ kind, title, source, locator, content, sha256 })))).digest('hex'),
    detectedEvidenceCount: db.evidence(task.id).filter(item => item.title.startsWith('Detected ')).length,
    artifacts: db.artifacts(task.id).length,
    artifactBytes: db.artifacts(task.id).reduce((sum, artifact) => sum + artifact.size, 0),
    cache: cacheDelta(before, cache.statistics()),
    memory,
  };
}

function environment() {
  const cpus = os.cpus();
  return {
    platform: process.platform,
    arch: process.arch,
    os: `${os.type()} ${os.release()}`,
    node: process.version,
    v8: process.versions.v8,
    cpu: cpus[0]?.model ?? 'unknown',
    logicalCores: cpus.length,
    totalMemoryMB: os.totalmem() / MB,
    freeMemoryMB: os.freemem() / MB,
    execArgv: process.execArgv,
    concurrency: 1,
  };
}

function phaseSummary(samples, elapsedMs, cache) {
  return {
    sampleCount: samples.length,
    elapsedMs,
    tasksPerSecond: samples.length / (elapsedMs / 1000),
    durationMs: summarize(samples.map(sample => sample.durationMs)),
    artifactsPerTask: summarize(samples.map(sample => sample.artifacts)),
    evidencePerTask: summarize(samples.map(sample => sample.evidence)),
    detectedEvidenceCount: summarize(samples.map(sample => sample.detectedEvidenceCount)),
    detectedEvidenceSha256: [...new Set(samples.map(sample => sample.detectedEvidenceSha256))],
    peakRssMB: Math.max(...samples.map(sample => sample.memory.peakRssMB)),
    peakHeapUsedMB: Math.max(...samples.map(sample => sample.memory.peakHeapUsedMB)),
    cache,
    samples,
  };
}

function stageStatistics(samples) {
  const grouped = new Map();
  for (const sample of samples) for (const stage of sample.stages) {
    if (!grouped.has(stage.name)) grouped.set(stage.name, []);
    if (stage.durationMs !== null) grouped.get(stage.name).push(stage.durationMs);
  }
  return Object.fromEntries([...grouped].map(([name, durations]) => [name, summarize(durations)]));
}

function addCheck(checks, name, actual, operator, limit) {
  const passed = operator === '<=' ? actual <= limit : operator === '>=' ? actual >= limit : actual === limit;
  checks.push({ name, actual, operator, limit, passed });
}

async function runEngineBenchmark(config) {
  const [{ VERSION, STAGES }, { fileAdapter }, { AnalysisCache, Database, WorkflowEngine }] = await Promise.all([
    import('@reverse/contracts'),
    import('@reverse/core'),
    import('@reverse/workflow'),
  ]);
  const packageJson = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  if (packageJson.version !== VERSION) throw new Error(`Version mismatch: package.json ${packageJson.version}, contracts ${VERSION}`);
  const dataDir = config.keepData ? path.resolve(config.dataDir ?? path.join(ROOT, 'data', `benchmark-${Date.now()}`)) : await mkdtemp(path.join(os.tmpdir(), 're-benchmark-'));
  await mkdir(dataDir, { recursive: true });
  const db = new Database(':memory:');
  const cache = new AnalysisCache(db, dataDir, { maxBytes: 64 * MB, ttlDays: 1 });
  const gcEvents = [];
  let gcObserver;
  try {
    gcObserver = new PerformanceObserver(list => gcEvents.push(...list.getEntries()));
    gcObserver.observe({ entryTypes: ['gc'] });
  } catch {
    gcObserver = undefined;
  }
  const engine = new WorkflowEngine(db, { dataDir, adapters: [fileAdapter], cache, timeoutMs: 30000, pollMs: 60000, maxQueue: config.samples + config.warmup + 1 });
  const warmup = { cold: [], hot: [] };
  const coldSamples = [];
  const hotSamples = [];
  let fatalError;
  try {
    for (let index = 1; index <= config.warmup; index++) {
      const project = await createProjectWithUpload(db, dataDir, `cold-warmup-${index}`);
      warmup.cold.push(await measureTask(engine, db, cache, project, index));
    }
    const hotProject = await createProjectWithUpload(db, dataDir, 'hot-warmup');
    warmup.hot.push(await measureTask(engine, db, cache, hotProject, 1));

    const coldCacheBefore = cache.statistics();
    const coldProject = await createProjectWithUpload(db, dataDir, 'cold-same-input');
    const coldStarted = performance.now();
    for (let index = 1; index <= config.samples; index++) {
      await cache.clear({ projectId: coldProject.id });
      coldSamples.push(await measureTask(engine, db, cache, coldProject, index));
    }
    const coldElapsedMs = performance.now() - coldStarted;
    const coldCache = cacheDelta(coldCacheBefore, cache.statistics());

    const hotCacheBefore = cache.statistics();
    const hotStarted = performance.now();
    for (let index = 1; index <= config.samples; index++) hotSamples.push(await measureTask(engine, db, cache, hotProject, index));
    const hotElapsedMs = performance.now() - hotStarted;
    const hotCache = cacheDelta(hotCacheBefore, cache.statistics());

    const cold = phaseSummary(coldSamples, coldElapsedMs, coldCache);
    const hot = phaseSummary(hotSamples, hotElapsedMs, hotCache);
    const allSamples = [...coldSamples, ...hotSamples];
    const failures = allSamples.filter(sample => sample.status !== 'COMPLETED');
    const gcPausesMs = gcEvents.map(entry => entry.duration / 1000);
    const gcByKind = {};
    for (const entry of gcEvents) {
      const kind = String(entry.detail?.kind ?? 'unknown');
      gcByKind[kind] = (gcByKind[kind] ?? 0) + 1;
    }
    const peakRssMB = Math.max(...allSamples.map(sample => sample.memory.peakRssMB));
    const peakHeapUsedMB = Math.max(...allSamples.map(sample => sample.memory.peakHeapUsedMB));
    const thresholds = config.thresholds;
    const checks = [];
    addCheck(checks, 'failedTasks', failures.length, '===', 0);
    addCheck(checks, 'coldTaskP95Ms', cold.durationMs.p95, '<=', thresholds.maxTaskP95Ms);
    addCheck(checks, 'hotTaskP95Ms', hot.durationMs.p95, '<=', thresholds.maxTaskP95Ms);
    addCheck(checks, 'coldTasksPerSecond', cold.tasksPerSecond, '>=', thresholds.minTasksPerSecond);
    addCheck(checks, 'hotTasksPerSecond', hot.tasksPerSecond, '>=', thresholds.minTasksPerSecond);
    addCheck(checks, 'coldCacheHitRate', cold.cache.hitRate, '<=', thresholds.maxColdCacheHitRate);
    addCheck(checks, 'hotCacheHitRate', hot.cache.hitRate, '>=', thresholds.minHotCacheHitRate);
    addCheck(checks, 'coldDetectedEvidenceCount', cold.detectedEvidenceCount.min, '>=', 1);
    addCheck(checks, 'hotDetectedEvidenceCount', hot.detectedEvidenceCount.min, '>=', 1);
    addCheck(checks, 'detectedEvidenceSignatures', new Set([...cold.detectedEvidenceSha256, ...hot.detectedEvidenceSha256]).size, '===', 1);
    addCheck(checks, 'peakRssMB', peakRssMB, '<=', thresholds.maxPeakRssMB);
    addCheck(checks, 'peakHeapUsedMB', peakHeapUsedMB, '<=', thresholds.maxPeakHeapMB);
    addCheck(checks, 'gcPauseP95Ms', summarize(gcPausesMs).p95, '<=', thresholds.maxGcPauseP95Ms);
    addCheck(checks, 'artifactsPerTaskP50', cold.artifactsPerTask.p50, '>=', thresholds.minArtifactsPerTask);
    for (const [stage, stats] of Object.entries(stageStatistics(allSamples))) addCheck(checks, `stageP95Ms:${stage}`, stats.p95, '<=', thresholds.maxStageP95Ms);
    let commit;
    try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(); } catch { commit = null; }
    return {
      schemaVersion: 1,
      product: 'reverse-everything',
      productVersion: VERSION,
      measuredAt: new Date().toISOString(),
      commit,
      environment: environment(),
      workload: { adapter: 'file', adapterVersion: fileAdapter.version, database: ':memory:', fixture: 'JSON package with one dependency', concurrency: 1, samplesPerPhase: config.samples, warmupColdTasks: config.warmup, warmupHotTasks: 1, totalTasks: config.warmup + 1 + config.samples * 2, stages: STAGES },
      methodology: ['Cold and hot samples use the same project and input; the project cache is cleared before each cold sample.', 'Hot samples reuse one project and input after one unmeasured cache-populating task.', 'Stage durations are persisted stage started_at/ended_at intervals and include engine, cache and SQLite overhead.', 'Memory is sampled in-process every 5 ms during measured tasks; short sub-interval peaks may be missed.', 'GC metrics are PerformanceObserver events; no forced GC is performed.'],
      thresholds,
      checks,
      passed: checks.every(check => check.passed),
      warmup: {
        coldTasks: warmup.cold.map(sample => ({ status: sample.status, durationMs: sample.durationMs })),
        hotTasks: warmup.hot.map(sample => ({ status: sample.status, durationMs: sample.durationMs })),
      },
      cold,
      hot,
      stages: stageStatistics(allSamples),
      resources: {
        peakRssMB,
        peakHeapUsedMB,
        heapStatistics: getHeapStatistics(),
        gc: { supported: Boolean(gcObserver), count: gcEvents.length, pauseMs: summarize(gcPausesMs), byKind: gcByKind, forcedGc: false },
        finalCache: cache.statistics(),
        sqliteQuickCheck: db.raw.prepare('PRAGMA quick_check').all().map(row => String(row.quick_check)),
      },
      failures: failures.map(sample => ({ taskId: sample.taskId, status: sample.status, error: sample.error })),
      dataDir,
      retainedData: config.keepData,
    };
  } catch (error) {
    fatalError = error instanceof Error ? error.message : String(error);
    return { schemaVersion: 1, product: 'reverse-everything', productVersion: VERSION, measuredAt: new Date().toISOString(), environment: environment(), passed: false, fatalError, dataDir, retainedData: config.keepData };
  } finally {
    gcObserver?.disconnect();
    await engine.close();
    db.close();
    if (!config.keepData) await rm(dataDir, { recursive: true, force: true });
  }
}

async function runE2EBenchmark(output) {
  const started = Date.now();
  const dataDir = path.resolve(ROOT, 'data', `benchmark-${started}`);
  await mkdir(dataDir, { recursive: true });
  const freePort = () => new Promise((resolve, reject) => { const server = createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const address = server.address(); const port = address && typeof address === 'object' ? address.port : 0; server.close(error => error ? reject(error) : resolve(port)); }); });
  const apiPort = await freePort();
  const demoPort = await freePort();
  const base = `http://127.0.0.1:${apiPort}`;
  const demoBase = `http://127.0.0.1:${demoPort}`;
  const children = [];
  const diagnostics = {};
  function start(name, args, env = {}) {
    const child = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    children.push(child);
    let text = '';
    child.stdout.on('data', bytes => { text += bytes.toString(); if (process.env.RE_BENCH_VERBOSE) process.stdout.write(`[${name}] ${bytes}`); });
    child.stderr.on('data', bytes => { text += bytes.toString(); if (process.env.RE_BENCH_VERBOSE) process.stderr.write(`[${name}] ${bytes}`); });
    child.on('exit', code => { diagnostics[name] = { exitCode: code, output: text.slice(-4000) }; });
    return child;
  }
  start('api', ['apps/api/dist/server-entry.js'], { RE_PORT: String(apiPort), RE_DATA_DIR: dataDir });
  start('worker', ['apps/worker/dist/worker.js'], { RE_DATA_DIR: dataDir });
  start('demo', ['examples/demo-website/server.mjs'], { PORT: String(demoPort) });
  try {
    const deadline = Date.now() + 20000;
    let token = '';
    let healthy = false;
    while (Date.now() < deadline) {
      if (children.some(child => child.exitCode !== null)) throw new Error(`Benchmark service exited early: ${JSON.stringify(diagnostics)}`);
      try {
        const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(500) });
        const health = response.ok ? await response.json() : undefined;
        token = await readFile(path.join(dataDir, 'local-token'), 'utf8').catch(() => '');
        if (health?.product === 'reverse-everything' && health?.version === PRODUCT_VERSION && token.trim()) { healthy = true; break; }
      } catch { /* wait for this instance */ }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!healthy) throw new Error(`API/token readiness timeout: ${JSON.stringify(diagnostics)}`);
    const startupMs = Date.now() - started;
    async function api(route, init = {}) {
      const response = await fetch(`${base}/api${route}`, { ...init, headers: { authorization: `Bearer ${token.trim()}`, ...(init.body && typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}), ...init.headers } });
      const text = await response.text();
      if (!response.ok) throw new Error(`${response.status}: ${text}`);
      return text ? JSON.parse(text) : {};
    }
    const idleResources = await api('/resources');
    const demoDeadline = Date.now() + 10000;
    let demoReady = false;
    while (Date.now() < demoDeadline) {
      try { if ((await fetch(`${demoBase}/`, { signal: AbortSignal.timeout(500) })).ok) { demoReady = true; break; } } catch { /* wait for demo readiness */ }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!demoReady) throw new Error(`Demo website readiness timeout: ${JSON.stringify(diagnostics)}`);
    async function run(name, kind, adapter, file, target = '', options = {}) {
      const project = await api('/projects', { method: 'POST', body: JSON.stringify({ name, kind, target, authorizationConfirmed: true }) });
      if (file) { const form = new FormData(); form.append('file', new Blob([file]), name.includes('游戏') ? 'trace.json' : 'sample.json'); await api(`/projects/${project.id}/uploads`, { method: 'POST', body: form }); }
      const task = await api(`/projects/${project.id}/tasks`, { method: 'POST', body: JSON.stringify({ adapter, options }) });
      const taskStart = Date.now();
      let peakApi = Number(idleResources.api?.treeRssMB ?? 0);
      const taskDeadline = Date.now() + 90000;
      while (Date.now() < taskDeadline) {
        const resources = await api('/resources');
        peakApi = Math.max(peakApi, Number(resources.api?.treeRssMB ?? 0));
        const detail = await api(`/tasks/${task.id}`);
        if (['COMPLETED', 'FAILED', 'BLOCKED', 'CANCELLED'].includes(detail.status)) {
          if (detail.status !== 'COMPLETED') throw new Error(`${name}: ${detail.error}`);
          return { taskId: task.id, durationMs: Date.now() - taskStart, peakApiSnapshotRssMB: peakApi, evidence: detail.evidence.length, artifacts: detail.artifacts.length, workerResource: resources.worker };
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error(`${name} timeout`);
    }
    const results = {
      file: await run('基准文件分析', 'software', 'file', JSON.stringify({ name: 'benchmark', dependencies: { demo: '1.0.0' } })),
      website: await run('基准网页采集', 'website', 'website', null, demoBase, { allowLocal: true, confirmLocal: true, settleMs: 100 }),
      game: await run('基准游戏复活', 'game', 'game', await readFile(path.join(ROOT, 'examples/demo-game/captured-trace.json'))),
    };
    const report = { schemaVersion: 1, product: 'reverse-everything', productVersion: PRODUCT_VERSION, measuredAt: new Date().toISOString(), platform: process.platform, node: process.version, startupMs, ports: { api: apiPort, demo: demoPort }, idleApi: idleResources.api, results, passed: true, notes: ['Process-tree RSS includes active Chromium/analyzer children and excludes the sampler process itself.', 'peakApiSnapshotRssMB is the maximum persisted API resource snapshot observed during polling, not a true high-frequency process peak.', 'Budgets are observations, not guarantees.', 'Single Worker, sequential tasks.'] };
    await writeFile(path.resolve(ROOT, output), JSON.stringify(report, null, 2));
    return report;
  } finally {
    for (const child of children) {
      if (child.exitCode !== null) continue;
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      else { try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill(); } }
    }
    await Promise.all(children.map(child => child.exitCode === null ? once(child, 'exit').catch(() => undefined) : Promise.resolve()));
  }
}

function parseArgs(args) {
  const config = {
    mode: 'engine',
    output: undefined,
    samples: positiveInteger(process.env.RE_BENCH_SAMPLES, DEFAULT_SAMPLES, 'RE_BENCH_SAMPLES', 3),
    warmup: positiveInteger(process.env.RE_BENCH_WARMUP, DEFAULT_WARMUP, 'RE_BENCH_WARMUP'),
    keepData: process.env.RE_BENCH_KEEP_DATA === '1',
    dataDir: process.env.RE_BENCH_DATA_DIR,
    thresholds: {
      maxTaskP95Ms: nonNegativeNumber(process.env.RE_BENCH_MAX_TASK_P95_MS, 2500, 'RE_BENCH_MAX_TASK_P95_MS'),
      maxStageP95Ms: nonNegativeNumber(process.env.RE_BENCH_MAX_STAGE_P95_MS, 1500, 'RE_BENCH_MAX_STAGE_P95_MS'),
      minTasksPerSecond: nonNegativeNumber(process.env.RE_BENCH_MIN_TASKS_PER_SECOND, 0.2, 'RE_BENCH_MIN_TASKS_PER_SECOND'),
      maxColdCacheHitRate: ratio(process.env.RE_BENCH_MAX_COLD_CACHE_HIT_RATE, 0.05, 'RE_BENCH_MAX_COLD_CACHE_HIT_RATE'),
      minHotCacheHitRate: ratio(process.env.RE_BENCH_MIN_HOT_CACHE_HIT_RATE, 0.95, 'RE_BENCH_MIN_HOT_CACHE_HIT_RATE'),
      maxPeakRssMB: nonNegativeNumber(process.env.RE_BENCH_MAX_PEAK_RSS_MB, 768, 'RE_BENCH_MAX_PEAK_RSS_MB'),
      maxPeakHeapMB: nonNegativeNumber(process.env.RE_BENCH_MAX_PEAK_HEAP_MB, 512, 'RE_BENCH_MAX_PEAK_HEAP_MB'),
      maxGcPauseP95Ms: nonNegativeNumber(process.env.RE_BENCH_MAX_GC_PAUSE_P95_MS, 500, 'RE_BENCH_MAX_GC_PAUSE_P95_MS'),
      minArtifactsPerTask: positiveInteger(process.env.RE_BENCH_MIN_ARTIFACTS_PER_TASK, 1, 'RE_BENCH_MIN_ARTIFACTS_PER_TASK', 0),
    },
  };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--e2e') config.mode = 'e2e';
    else if (arg === '--engine') config.mode = 'engine';
    else if (arg === '--output') config.output = args[++index];
    else if (arg === '--samples') config.samples = positiveInteger(args[++index], DEFAULT_SAMPLES, '--samples', 3);
    else if (arg === '--warmup') config.warmup = positiveInteger(args[++index], DEFAULT_WARMUP, '--warmup');
    else if (arg === '--keep-data') config.keepData = true;
    else if (!arg.startsWith('-') && config.mode === 'e2e') config.output = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return config;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log(JSON.stringify({ usage: 'node scripts/benchmark.mjs [--engine] [--samples N] [--warmup N] [--output file.json] | --e2e [output.json]', defaultMode: 'engine', defaults: { samples: DEFAULT_SAMPLES, warmup: DEFAULT_WARMUP, concurrency: 1 }, note: 'Build first with npm run build. Engine mode prints JSON to stdout and does not write a report unless --output is supplied.' }, null, 2));
    return;
  }
  const config = parseArgs(args);
  const report = config.mode === 'e2e' ? await runE2EBenchmark(config.output ?? 'docs/development/PERFORMANCE.json') : await runEngineBenchmark(config);
  if (config.mode === 'engine' && config.output) await writeFile(path.resolve(ROOT, config.output), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(JSON.stringify({ schemaVersion: 1, product: 'reverse-everything', passed: false, fatalError: error instanceof Error ? error.message : String(error) }, null, 2));
    process.exitCode = 1;
  });
}

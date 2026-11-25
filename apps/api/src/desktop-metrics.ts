import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError, type ResourceSnapshot } from '@reverse/contracts';
import type { Database, RetentionService } from '@reverse/workflow';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const MAX_PROCESSES = 256;
const MAX_LIMITATIONS = 32;
function finite(value: unknown, maximum = 1_000_000): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= maximum; }
function requireLocal(request: FastifyRequest): void {
  if (process.env.RE_ALLOW_REMOTE === 'true' || !LOOPBACK.has(request.ip)) throw new AppError('FORBIDDEN', 'Desktop metrics are accepted only from the local loopback desktop', 403);
}
function parseSnapshot(body: unknown): ResourceSnapshot {
  if (!body || typeof body !== 'object') throw new AppError('BAD_REQUEST', 'Desktop metrics body must be an object', 400);
  const input = body as Record<string, unknown>;
  const sampledAt = typeof input.sampledAt === 'string' ? input.sampledAt : '';
  const sampledTime = Date.parse(sampledAt);
  if (!Number.isFinite(sampledTime) || Math.abs(Date.now() - sampledTime) > 300_000) throw new AppError('BAD_REQUEST', 'Desktop sampledAt must be a recent valid timestamp', 400);
  if (!Array.isArray(input.processes) || input.processes.length > MAX_PROCESSES) throw new AppError('BAD_REQUEST', `Desktop processes must contain at most ${MAX_PROCESSES} entries`, 400);
  const processes = input.processes.map((value, index) => {
    if (!value || typeof value !== 'object') throw new AppError('BAD_REQUEST', `Desktop process ${index} is invalid`, 400);
    const item = value as Record<string, unknown>;
    if (!Number.isSafeInteger(item.pid) || Number(item.pid) <= 0 || !finite(item.rssMB)) throw new AppError('BAD_REQUEST', `Desktop process ${index} has invalid identity or RSS`, 400);
    if (item.cpuSeconds !== undefined && !finite(item.cpuSeconds)) throw new AppError('BAD_REQUEST', `Desktop process ${index} has invalid CPU time`, 400);
    if (item.cpuPercent !== undefined && !finite(item.cpuPercent)) throw new AppError('BAD_REQUEST', `Desktop process ${index} has invalid CPU percent`, 400);
    const roles=new Set(['main','renderer','gpu','utility','other','api','worker','sidecar-child']);const sources=new Set(['electron-app-metrics','node-self','api-resource-snapshot','worker-resource-snapshot']);
    if(item.role!==undefined&&(typeof item.role!=='string'||!roles.has(item.role)))throw new AppError('BAD_REQUEST', `Desktop process ${index} has invalid role`, 400);
    if(item.source!==undefined&&(typeof item.source!=='string'||!sources.has(item.source)))throw new AppError('BAD_REQUEST', `Desktop process ${index} has invalid source`, 400);
    if(item.observedAt!==undefined&&(typeof item.observedAt!=='string'||!Number.isFinite(Date.parse(item.observedAt))))throw new AppError('BAD_REQUEST', `Desktop process ${index} has invalid observedAt`, 400);
    return { pid: Number(item.pid), ppid: Number.isSafeInteger(item.ppid) && Number(item.ppid) > 0 ? Number(item.ppid) : 0, rssMB: Number(item.rssMB), cpuSeconds: finite(item.cpuSeconds) ? Number(item.cpuSeconds) : 0, ...(typeof item.name === 'string' ? { name: item.name.slice(0, 120) } : {}), ...(item.role!==undefined?{role:item.role as NonNullable<ResourceSnapshot['processes'][number]['role']>}:{}), ...(item.cpuPercent!==undefined?{cpuPercent:Number(item.cpuPercent)}:{}), ...(item.observedAt!==undefined?{observedAt:String(item.observedAt)}:{}), ...(item.source!==undefined?{source:item.source as NonNullable<ResourceSnapshot['processes'][number]['source']>}:{}) };
  });
  for (const key of ['treeRssMB', 'selfRssMB', 'childRssMB', 'heapUsedMB', 'cpuPercent', 'handles'] as const) if (!finite(input[key])) throw new AppError('BAD_REQUEST', `Desktop ${key} must be a finite non-negative number`, 400);
  const treeRssMB = Number(input.treeRssMB),processRss=processes.reduce((total,item)=>total+item.rssMB,0);
  if(input.sampledProcessCount!==undefined&&(!Number.isSafeInteger(input.sampledProcessCount)||Number(input.sampledProcessCount)<processes.length||Number(input.sampledProcessCount)>100_000))throw new AppError('BAD_REQUEST','Desktop sampledProcessCount is invalid',400);
  if(input.processesTruncated!==undefined&&typeof input.processesTruncated!=='boolean')throw new AppError('BAD_REQUEST','Desktop processesTruncated is invalid',400);
  const sampledProcessCount=Number(input.sampledProcessCount??processes.length),processesTruncated=input.processesTruncated===true;
  if(processesTruncated&&sampledProcessCount<=processes.length)throw new AppError('BAD_REQUEST','Truncated desktop metrics must report more sampled processes than retained',400);
  if(processesTruncated?treeRssMB+0.01<processRss:Math.abs(treeRssMB-processRss)>Math.max(1,treeRssMB*0.02))throw new AppError('BAD_REQUEST','Desktop tree RSS does not match the supplied process metrics',400);
  const limitations = Array.isArray(input.limitations) ? input.limitations.filter((item): item is string => typeof item === 'string').slice(0, MAX_LIMITATIONS).map(item => item.slice(0, 512)) : [];
  const pressure = input.pressure === 'pressure' || input.pressure === 'danger' ? input.pressure : 'normal';
  const triggers=new Set(['startup','periodic','task-running','before-quit']);if(input.trigger!==undefined&&(typeof input.trigger!=='string'||!triggers.has(input.trigger)))throw new AppError('BAD_REQUEST','Desktop trigger is invalid',400);
  return { sampledAt, source: 'desktop', ...(input.trigger!==undefined?{trigger:input.trigger as NonNullable<ResourceSnapshot['trigger']>}:{}), sampledProcessCount, processesTruncated, treeRssMB, selfRssMB: Number(input.selfRssMB), childRssMB: Number(input.childRssMB), heapUsedMB: Number(input.heapUsedMB), cpuPercent: Number(input.cpuPercent), handles: Number(input.handles), processes, systemFreeMemoryMB: finite(input.systemFreeMemoryMB) ? Number(input.systemFreeMemoryMB) : 0, systemTotalMemoryMB: finite(input.systemTotalMemoryMB) ? Number(input.systemTotalMemoryMB) : 0, dataDirBytes: finite(input.dataDirBytes, Number.MAX_SAFE_INTEGER) ? Number(input.dataDirBytes) : 0, diskAvailableBytes: finite(input.diskAvailableBytes, Number.MAX_SAFE_INTEGER) ? Number(input.diskAvailableBytes) : 0, queuedTasks: finite(input.queuedTasks, 1_000_000) ? Math.floor(Number(input.queuedTasks)) : 0, runningTasks: finite(input.runningTasks, 1_000_000) ? Math.floor(Number(input.runningTasks)) : 0, peakTreeRssMB: finite(input.peakTreeRssMB) ? Math.max(treeRssMB, Number(input.peakTreeRssMB)) : treeRssMB, pressure, limitations };
}

export function registerDesktopMetricsRoutes(app: FastifyInstance, db: Database, retention: RetentionService): void {
  app.post('/api/resources/desktop', async request => {
    requireLocal(request);
    const snapshot = parseSnapshot(request.body);
    const policy = retention.policy();
    db.raw.exec('BEGIN IMMEDIATE');
    try {
      const previous = db.raw.prepare("SELECT value FROM settings WHERE key='resource_peak'").get() as { value: string } | undefined;
      const peak = previous ? JSON.parse(previous.value) as { treeRssMB?: number; cpuPercent?: number; dataDirBytes?: number } : {};
      db.raw.prepare('INSERT INTO resource_samples (source,snapshot_json,created_at) VALUES (?,?,?)').run('desktop', JSON.stringify(snapshot), snapshot.sampledAt);
      db.setSetting('resource_snapshot_desktop', JSON.stringify(snapshot));
      db.setSetting('resource_peak', JSON.stringify({ treeRssMB: Math.max(Number(peak.treeRssMB) || 0, snapshot.peakTreeRssMB), cpuPercent: Math.max(Number(peak.cpuPercent) || 0, snapshot.cpuPercent), dataDirBytes: Math.max(Number(peak.dataDirBytes) || 0, snapshot.dataDirBytes) }));
      const cutoff = new Date(Date.now() - policy.resourceDays * 86400000).toISOString();
      db.raw.prepare('DELETE FROM resource_samples WHERE created_at<? AND id NOT IN (SELECT MAX(id) FROM resource_samples GROUP BY source)').run(cutoff);
      db.raw.prepare('DELETE FROM resource_samples WHERE id NOT IN (SELECT id FROM resource_samples ORDER BY id DESC LIMIT ?)').run(policy.resourceMaxRows);
      db.raw.exec('COMMIT');
    } catch (error) {
      try { db.raw.exec('ROLLBACK'); } catch { /* preserve original error */ }
      throw error;
    }
    return { recorded: true, sampledAt: snapshot.sampledAt, treeRssMB: snapshot.treeRssMB, processes: snapshot.processes.length };
  });
}

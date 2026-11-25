export type DesktopMetricTrigger = 'startup' | 'periodic' | 'task-running' | 'before-quit';
export type DesktopMetricRole = 'main' | 'renderer' | 'gpu' | 'utility' | 'other' | 'api' | 'worker' | 'sidecar-child';

export interface ElectronProcessMetric {
  pid: number;
  type: 'Browser' | 'Tab' | 'Utility' | 'Zygote' | 'Sandbox helper' | 'GPU' | 'Pepper Plugin' | 'Pepper Plugin Broker' | 'Unknown';
  creationTime?: number;
  name?: string;
  serviceName?: string;
  memory: { workingSetSize: number; peakWorkingSetSize: number };
  cpu: { cumulativeCPUUsage?: number; percentCPUUsage: number; idleWakeupsPerSecond: number };
}

export interface DesktopResourceProcess {
  pid: number;
  ppid?: number;
  rssMB: number;
  cpuSeconds?: number;
  name?: string;
}

export interface DesktopSidecarSnapshot {
  sampledAt?: string;
  selfRssMB?: number;
  processes?: DesktopResourceProcess[];
  cpuPercent?: number;
  dataDirBytes?: number;
  diskAvailableBytes?: number;
  systemFreeMemoryMB?: number;
  systemTotalMemoryMB?: number;
  queuedTasks?: number;
  runningTasks?: number;
  limitations?: string[];
}

export interface DesktopSidecarResource {
  kind: 'api' | 'worker';
  pid?: number;
  snapshot?: DesktopSidecarSnapshot;
}

export interface DesktopProcessMetric {
  pid: number;
  ppid?: number;
  role: DesktopMetricRole;
  name?: string;
  rssMB: number;
  cpuPercent?: number;
  cpuSeconds?: number;
  observedAt?: string;
  source: 'electron-app-metrics' | 'node-self' | 'api-resource-snapshot' | 'worker-resource-snapshot';
}

export interface DesktopMetricsSnapshot {
  source: 'desktop';
  sampledAt: string;
  trigger: DesktopMetricTrigger;
  sampledProcessCount: number;
  processesTruncated: boolean;
  processes: DesktopProcessMetric[];
  treeRssMB: number;
  selfRssMB: number;
  childRssMB: number;
  heapUsedMB: number;
  cpuPercent: number;
  handles: number;
  peakTreeRssMB: number;
  dataDirBytes?: number;
  diskAvailableBytes?: number;
  systemFreeMemoryMB?: number;
  systemTotalMemoryMB?: number;
  queuedTasks?: number;
  runningTasks?: number;
  pressure?: 'normal' | 'pressure' | 'danger';
  limitations: string[];
}

export interface DesktopMetricsCollectorOptions {
  mainPid: number;
  getAppMetrics: () => ElectronProcessMetric[];
  getMemoryUsage: () => { rss: number; heapUsed: number };
  getCpuUsage: () => { user: number; system: number };
  getActiveResourceCount: () => number;
  cpuCount: () => number;
  now?: () => number;
  maxProcesses?: number;
  maxLimitations?: number;
}

interface PreviousCpu { at: number; cpuSeconds: number }

const MAX_ELECTRON_PROCESSES = 128;
const MAX_SIDECAR_INPUT_PROCESSES = 256;
const MAX_SIDECAR_TREE_PROCESSES = 128;
const MAX_SNAPSHOT_BYTES = 128 * 1024;
const MAX_SIDECAR_SNAPSHOT_AGE_MS = 30_000;
const PROCESS_SAMPLING_LIMITATION = 'Process-tree sampling unavailable; reporting Node self RSS only';

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function roleFor(type: ElectronProcessMetric['type']): DesktopMetricRole {
  if (type === 'Tab') return 'renderer';
  if (type === 'GPU') return 'gpu';
  if (type === 'Utility') return 'utility';
  return 'other';
}

function descendants(processes: DesktopResourceProcess[], rootPid: number): DesktopResourceProcess[] {
  const byParent = new Map<number, DesktopResourceProcess[]>();
  for (const process of processes) {
    if (process.ppid === undefined) continue;
    const children = byParent.get(process.ppid) ?? [];
    children.push(process);
    byParent.set(process.ppid, children);
  }
  const result: DesktopResourceProcess[] = [];
  const queue = [rootPid];
  const seen = new Set<number>([rootPid]);
  for (let index = 0; index < queue.length && result.length < MAX_SIDECAR_TREE_PROCESSES; index++) {
    for (const child of byParent.get(queue[index]!) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      result.push(child);
      queue.push(child.pid);
    }
  }
  return result;
}

export function createDesktopMetricsCollector(options: DesktopMetricsCollectorOptions) {
  const maxProcesses = Math.max(1, Math.min(256, Math.floor(options.maxProcesses ?? 64)));
  const maxLimitations = Math.max(1, Math.min(32, Math.floor(options.maxLimitations ?? 12)));
  const previousCpu = new Map<string, PreviousCpu>();
  let previousNodeCpu: PreviousCpu | undefined;
  let peakTreeRssMB = 0;

  return {
    collect(trigger: DesktopMetricTrigger, sidecars: DesktopSidecarResource[] = []): DesktopMetricsSnapshot {
      const now = options.now?.() ?? Date.now();
      const limitations: string[] = [];
      const addLimitation = (message: string) => {
        if (limitations.length < maxLimitations) limitations.push(message.slice(0, 512));
      };
      let metrics: ElectronProcessMetric[] = [];
      try {
        metrics = options.getAppMetrics();
      } catch {
        addLimitation('Electron app.getAppMetrics() failed; using Node self metrics only');
      }
      if (metrics.length > MAX_ELECTRON_PROCESSES) addLimitation(`Electron process metrics truncated to ${MAX_ELECTRON_PROCESSES} entries; RSS totals cover included processes only`);
      const sampledElectron = metrics.slice(0, MAX_ELECTRON_PROCESSES);
      const browser = sampledElectron.find(metric => metric.pid === options.mainPid && metric.type === 'Browser') ?? sampledElectron.find(metric => metric.type === 'Browser');
      const seenCpuKeys = new Set<string>();
      const electronProcesses: DesktopProcessMetric[] = [];
      let electronCpuPercent = 0;
      let disclosedMissingCpu = false;

      for (const metric of sampledElectron) {
        if (!Number.isSafeInteger(metric.pid) || metric.pid <= 0 || !finiteNonNegative(metric.memory?.workingSetSize)) {
          addLimitation('Electron returned an invalid process metric; entry omitted');
          continue;
        }
        const identity = `${metric.pid}:${metric.creationTime ?? 'unknown'}`;
        seenCpuKeys.add(identity);
        const previous = previousCpu.get(identity);
        const cumulative = metric.cpu?.cumulativeCPUUsage;
        let cpuPercent: number | undefined;
        if (finiteNonNegative(cumulative)) {
          if (previous && now > previous.at) {
            cpuPercent = Math.max(0, cumulative - previous.cpuSeconds) / ((now - previous.at) / 1000) / Math.max(1, options.cpuCount()) * 100;
          } else if (finiteNonNegative(metric.cpu?.percentCPUUsage)) {
            cpuPercent = metric.cpu.percentCPUUsage;
          }
          previousCpu.set(identity, { at: now, cpuSeconds: cumulative });
        } else if (finiteNonNegative(metric.cpu?.percentCPUUsage)) {
          cpuPercent = metric.cpu.percentCPUUsage;
        }
        if (cpuPercent === undefined && !disclosedMissingCpu) {
          addLimitation('CPU usage unavailable for one or more Electron processes on the first sample');
          disclosedMissingCpu = true;
        }
        if (cpuPercent !== undefined) electronCpuPercent += cpuPercent;
        electronProcesses.push({
          pid: metric.pid,
          ...(metric.pid === browser?.pid ? {} : { ppid: options.mainPid }),
          role: metric.pid === browser?.pid ? 'main' : roleFor(metric.type),
          ...(metric.name || metric.serviceName ? { name: metric.name ?? metric.serviceName } : {}),
          rssMB: round(metric.memory.workingSetSize / 1024),
          ...(cpuPercent !== undefined ? { cpuPercent: round(cpuPercent, 2) } : {}),
          ...(finiteNonNegative(cumulative) ? { cpuSeconds: round(cumulative) } : {}),
          source: 'electron-app-metrics',
        });
      }
      for (const key of previousCpu.keys()) if (!seenCpuKeys.has(key)) previousCpu.delete(key);
      for (const role of ['renderer', 'gpu', 'utility'] as const) {
        if (!electronProcesses.some(process => process.role === role)) addLimitation(`${role} process metric unavailable from Electron app.getAppMetrics()`);
      }

      let selfRssMB = electronProcesses.find(process => process.role === 'main')?.rssMB ?? 0;
      if (!browser) {
        addLimitation('Browser metric unavailable; using Node process.memoryUsage()/cpuUsage() for the main process');
        const usage = options.getMemoryUsage();
        const cpu = options.getCpuUsage();
        const cpuSeconds = (usageCpu(cpu.user) + usageCpu(cpu.system)) / 1_000_000;
        let cpuPercent: number | undefined;
        if (previousNodeCpu && now > previousNodeCpu.at) {
          cpuPercent = Math.max(0, cpuSeconds - previousNodeCpu.cpuSeconds) / ((now - previousNodeCpu.at) / 1000) / Math.max(1, options.cpuCount()) * 100;
        } else {
          cpuPercent = 0;
        }
        previousNodeCpu = { at: now, cpuSeconds };
        selfRssMB = round(usage.rss / 1024 / 1024);
        electronCpuPercent += cpuPercent;
        electronProcesses.push({ pid: options.mainPid, role: 'main', rssMB: selfRssMB, cpuPercent: round(cpuPercent, 2), source: 'node-self' });
      }

      const sidecarProcesses: DesktopProcessMetric[] = [];
      const missingSidecars = new Set<'api' | 'worker'>();
      for (const sidecar of sidecars) {
        if (!Number.isSafeInteger(sidecar.pid) || (sidecar.pid ?? 0) <= 0 || !sidecar.snapshot) {
          missingSidecars.add(sidecar.kind);
          continue;
        }
        const snapshot = sidecar.snapshot;
        const observedAt = typeof snapshot.sampledAt === 'string' && Number.isFinite(Date.parse(snapshot.sampledAt)) ? snapshot.sampledAt : undefined;
        if (!observedAt) addLimitation(`${sidecar.kind} sidecar RSS snapshot timestamp unavailable; freshness unverified`);
        else if (now - Date.parse(observedAt) > MAX_SIDECAR_SNAPSHOT_AGE_MS) addLimitation(`${sidecar.kind} sidecar RSS snapshot is older than 30 seconds; reported RSS is the last real observation`);
        const input = Array.isArray(snapshot.processes) ? snapshot.processes : [];
        if (!Array.isArray(snapshot.processes)) addLimitation(`${sidecar.kind} sidecar process tree unavailable; reporting real self RSS only`);
        if (input.length > MAX_SIDECAR_INPUT_PROCESSES) addLimitation(`${sidecar.kind} sidecar process input truncated to ${MAX_SIDECAR_INPUT_PROCESSES} entries; RSS totals may be incomplete`);
        const byPid = new Map<number, DesktopResourceProcess>();
        let invalidRows = 0;
        for (const process of input.slice(0, MAX_SIDECAR_INPUT_PROCESSES)) {
          if (!process || !Number.isSafeInteger(process.pid) || process.pid <= 0 || !finiteNonNegative(process.rssMB)) {
            invalidRows++;
            continue;
          }
          byPid.set(process.pid, process);
        }
        if (invalidRows) addLimitation(`${sidecar.kind} sidecar returned ${invalidRows} invalid process entries; entries omitted`);
        const rootPid = sidecar.pid!;
        if (!byPid.has(rootPid) && finiteNonNegative(snapshot.selfRssMB)) {
          byPid.set(rootPid, { pid: rootPid, rssMB: snapshot.selfRssMB });
          addLimitation(`${sidecar.kind} sidecar root process row unavailable; using real self RSS from its resource snapshot`);
        }
        if (!byPid.has(rootPid)) {
          missingSidecars.add(sidecar.kind);
          continue;
        }
        const tree = [byPid.get(rootPid)!, ...descendants([...byPid.values()], rootPid)];
        if (tree.length > MAX_SIDECAR_TREE_PROCESSES) addLimitation(`${sidecar.kind} sidecar process tree truncated to ${MAX_SIDECAR_TREE_PROCESSES} entries; RSS totals may be incomplete`);
        const processSamplingUnavailable = snapshot.limitations?.includes(PROCESS_SAMPLING_LIMITATION) === true;
        for (const [index, process] of tree.slice(0, MAX_SIDECAR_TREE_PROCESSES).entries()) {
          sidecarProcesses.push({
            pid: process.pid,
            ...(process.ppid !== undefined ? { ppid: process.ppid } : {}),
            role: index === 0 ? sidecar.kind : 'sidecar-child',
            ...(process.name ? { name: process.name.slice(0, 120) } : {}),
            rssMB: round(process.rssMB),
            ...(!processSamplingUnavailable && finiteNonNegative(process.cpuSeconds) ? { cpuSeconds: round(process.cpuSeconds) } : {}),
            ...(observedAt ? { observedAt } : {}),
            source: `${sidecar.kind}-resource-snapshot`,
          });
        }
      }
      for (const kind of missingSidecars) addLimitation(`${kind} sidecar RSS unavailable from local resource snapshots; no value fabricated`);

      const rolePriority: Record<DesktopMetricRole, number> = { main: 0, api: 1, worker: 1, renderer: 2, gpu: 3, utility: 4, other: 5, 'sidecar-child': 6 };
      const byPid = new Map<number, DesktopProcessMetric>();
      for (const process of [...electronProcesses, ...sidecarProcesses]) {
        const existing = byPid.get(process.pid);
        if (!existing || rolePriority[process.role] < rolePriority[existing.role]) byPid.set(process.pid, process);
      }
      const allProcesses = [...byPid.values()].sort((left, right) => rolePriority[left.role] - rolePriority[right.role] || right.rssMB - left.rssMB || left.pid - right.pid);
      const treeRssMB = round(allProcesses.reduce((total, process) => total + process.rssMB, 0));
      peakTreeRssMB = Math.max(peakTreeRssMB, treeRssMB);
      if (allProcesses.length > maxProcesses) addLimitation(`Process list truncated to ${maxProcesses} entries; RSS totals cover ${allProcesses.length} sampled processes`);

      let memory: { heapUsed: number };
      try {
        memory = options.getMemoryUsage();
      } catch {
        memory = { heapUsed: 0 };
        addLimitation('Node heap usage unavailable');
      }
      let handles = 0;
      try {
        handles = options.getActiveResourceCount();
      } catch {
        addLimitation('Node active resource count unavailable');
      }
      const api = sidecars.find(sidecar => sidecar.kind === 'api')?.snapshot;
      const worker = sidecars.find(sidecar => sidecar.kind === 'worker')?.snapshot;
      const runningTasks = api?.runningTasks ?? worker?.runningTasks;
      const pressure = treeRssMB >= 950 || electronCpuPercent >= 99 ? 'danger' : treeRssMB >= 700 || electronCpuPercent >= 90 ? 'pressure' : 'normal';

      return {
        source: 'desktop',
        sampledAt: new Date(now).toISOString(),
        trigger,
        sampledProcessCount: allProcesses.length,
        processesTruncated: allProcesses.length > maxProcesses,
        processes: allProcesses.slice(0, maxProcesses),
        treeRssMB,
        selfRssMB: round(selfRssMB),
        childRssMB: round(Math.max(0, treeRssMB - selfRssMB)),
        heapUsedMB: finiteNonNegative(memory.heapUsed) ? round(memory.heapUsed / 1024 / 1024) : 0,
        cpuPercent: round(electronCpuPercent, 2),
        handles: Number.isSafeInteger(handles) && handles >= 0 ? handles : 0,
        peakTreeRssMB: round(peakTreeRssMB),
        ...(finiteNonNegative(api?.dataDirBytes) ? { dataDirBytes: api.dataDirBytes } : {}),
        ...(finiteNonNegative(api?.diskAvailableBytes) ? { diskAvailableBytes: api.diskAvailableBytes } : {}),
        ...(finiteNonNegative(api?.systemFreeMemoryMB) ? { systemFreeMemoryMB: api.systemFreeMemoryMB } : {}),
        ...(finiteNonNegative(api?.systemTotalMemoryMB) ? { systemTotalMemoryMB: api.systemTotalMemoryMB } : {}),
        ...(finiteNonNegative(api?.queuedTasks) ? { queuedTasks: api.queuedTasks } : {}),
        ...(runningTasks !== undefined && finiteNonNegative(runningTasks) ? { runningTasks } : {}),
        pressure,
        limitations,
      };
    },
  };
}

function usageCpu(microseconds: number): number {
  return finiteNonNegative(microseconds) ? microseconds : 0;
}

export function isUsableDesktopSnapshot(value: unknown): value is DesktopMetricsSnapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as Partial<DesktopMetricsSnapshot>;
  return snapshot.source === 'desktop'
    && typeof snapshot.sampledAt === 'string'
    && Number.isFinite(Date.parse(snapshot.sampledAt))
    && Array.isArray(snapshot.processes)
    && snapshot.processes.length > 0
    && Number.isSafeInteger(snapshot.sampledProcessCount)
    && snapshot.sampledProcessCount! >= snapshot.processes.length
    && typeof snapshot.processesTruncated === 'boolean'
    && snapshot.processesTruncated === (snapshot.sampledProcessCount! > snapshot.processes.length)
    && snapshot.processes.some(process => process?.role === 'main' && finiteNonNegative(process.rssMB))
    && [snapshot.treeRssMB, snapshot.selfRssMB, snapshot.childRssMB, snapshot.heapUsedMB, snapshot.cpuPercent, snapshot.handles, snapshot.peakTreeRssMB].every(finiteNonNegative)
    && Array.isArray(snapshot.limitations)
    && snapshot.limitations.every(item => typeof item === 'string');
}

export interface DesktopMetricsReport {
  ok: boolean;
  status?: number;
  attempts: number;
  error?: string;
}

export interface DesktopMetricsReportOptions {
  baseUrl: string;
  token: string;
  snapshot: DesktopMetricsSnapshot;
  fetchImpl?: typeof fetch;
  attempts?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
}

export async function reportDesktopMetrics(options: DesktopMetricsReportOptions): Promise<DesktopMetricsReport> {
  const body = JSON.stringify(options.snapshot);
  if (Buffer.byteLength(body) > MAX_SNAPSHOT_BYTES) return { ok: false, attempts: 0, error: `Desktop metrics snapshot exceeds ${MAX_SNAPSHOT_BYTES} bytes` };
  const fetchImpl = options.fetchImpl ?? fetch;
  const attempts = Math.max(1, Math.min(3, Math.floor(options.attempts ?? 2)));
  let lastError = 'Network request failed';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetchImpl(`${options.baseUrl.replace(/\/$/, '')}/api/resources/desktop`, {
        method: 'POST',
        headers: { authorization: `Bearer ${options.token}`, 'content-type': 'application/json' },
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(options.timeoutMs ?? 1500),
      });
      if (response.ok) return { ok: true, status: response.status, attempts: attempt };
      lastError = `HTTP ${response.status}`;
      if (response.status !== 408 && response.status !== 429 && response.status < 500) return { ok: false, status: response.status, attempts: attempt, error: lastError };
    } catch {
      lastError = 'Network request failed';
    }
    if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, Math.max(0, options.retryDelayMs ?? 250)));
  }
  return { ok: false, attempts, error: lastError };
}

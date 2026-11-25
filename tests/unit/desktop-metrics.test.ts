import { describe, expect, it, vi } from 'vitest';
import {
  createDesktopMetricsCollector,
  isUsableDesktopSnapshot,
  reportDesktopMetrics,
  type DesktopSidecarResource,
  type ElectronProcessMetric,
} from '../../apps/desktop/src/metrics.js';

const MB = 1024 * 1024;

function electronMetric(pid: number, type: ElectronProcessMetric['type'], workingSetKB: number, cumulativeCPUUsage: number): ElectronProcessMetric {
  return {
    pid,
    type,
    creationTime: 1_700_000_000_000,
    memory: { workingSetSize: workingSetKB, peakWorkingSetSize: workingSetKB },
    cpu: { cumulativeCPUUsage, percentCPUUsage: 0, idleWakeupsPerSecond: 0 },
  };
}

function collector(overrides: Partial<Parameters<typeof createDesktopMetricsCollector>[0]> = {}) {
  return createDesktopMetricsCollector({
    mainPid: 100,
    getAppMetrics: () => [
      electronMetric(100, 'Browser', 100 * 1024, 1),
      electronMetric(101, 'Tab', 200 * 1024, 2),
      electronMetric(102, 'GPU', 50 * 1024, 0.5),
      electronMetric(103, 'Utility', 25 * 1024, 0.25),
    ],
    getMemoryUsage: () => ({ rss: 100 * MB, heapUsed: 30 * MB }),
    getCpuUsage: () => ({ user: 1_000_000, system: 0 }),
    getActiveResourceCount: () => 7,
    cpuCount: () => 2,
    now: () => 1_700_000_000_000,
    ...overrides,
  });
}

function sidecars(): DesktopSidecarResource[] {
  return [
    {
      kind: 'api',
      pid: 200,
      snapshot: {
        selfRssMB: 40,
        processes: [
          { pid: 200, ppid: 100, rssMB: 40, cpuSeconds: 4, name: 'api' },
          { pid: 201, ppid: 200, rssMB: 10, cpuSeconds: 1, name: 'api-child' },
        ],
      },
    },
    {
      kind: 'worker',
      pid: 300,
      snapshot: {
        selfRssMB: 60,
        processes: [{ pid: 300, ppid: 100, rssMB: 60, cpuSeconds: 3, name: 'worker' }],
      },
    },
  ];
}

describe('desktop real process metrics', () => {
  it('assembles Electron CPU/RSS and owned sidecar process trees without double counting', () => {
    let at = 1_700_000_000_000;
    let cpuTick = 0;
    const metrics = collector({
      now: () => at,
      getAppMetrics: () => [
        electronMetric(100, 'Browser', 100 * 1024, 1 + cpuTick),
        electronMetric(101, 'Tab', 200 * 1024, 2 + cpuTick * 3),
        electronMetric(102, 'GPU', 50 * 1024, 0.5 + cpuTick * 2),
        electronMetric(103, 'Utility', 25 * 1024, 0.25 + cpuTick * 1.5),
      ],
    });
    metrics.collect('startup', sidecars());
    at += 5_000;
    cpuTick = 1;
    const snapshot = metrics.collect('periodic', sidecars());

    expect(snapshot.source).toBe('desktop');
    expect(snapshot.sampledAt).toBe(new Date(at).toISOString());
    expect(snapshot.trigger).toBe('periodic');
    expect(snapshot.processes.map(process => process.role)).toEqual(expect.arrayContaining(['main', 'renderer', 'gpu', 'utility', 'api', 'worker', 'sidecar-child']));
    expect(snapshot.selfRssMB).toBe(100);
    expect(snapshot.treeRssMB).toBe(485);
    expect(snapshot.childRssMB).toBe(385);
    expect(snapshot.heapUsedMB).toBe(30);
    expect(snapshot.cpuPercent).toBe(75);
    expect(snapshot.handles).toBe(7);
    expect(snapshot.peakTreeRssMB).toBe(485);
    expect(snapshot.processes.find(process => process.pid === 201)).toMatchObject({ rssMB: 10, cpuSeconds: 1, source: 'api-resource-snapshot' });
  });

  it('uses real Node self metrics when the Browser metric is missing and discloses unavailable sidecars', () => {
    const cpuUsage = vi.fn()
      .mockReturnValueOnce({ user: 1_000_000, system: 0 })
      .mockReturnValueOnce({ user: 2_000_000, system: 0 });
    let at = 1_000;
    const metrics = collector({
      getAppMetrics: () => [],
      getCpuUsage: cpuUsage,
      cpuCount: () => 2,
      now: () => at,
    });
    metrics.collect('startup');
    at += 2_000;
    const snapshot = metrics.collect('periodic', [{ kind: 'api', pid: 200 }, { kind: 'worker', pid: 300 }]);

    expect(snapshot.selfRssMB).toBe(100);
    expect(snapshot.cpuPercent).toBe(25);
    expect(snapshot.processes).toHaveLength(1);
    expect(snapshot.limitations.join(' ')).toContain('Browser metric unavailable');
    expect(snapshot.limitations.join(' ')).toContain('api sidecar RSS unavailable');
    expect(snapshot.limitations.join(' ')).toContain('worker sidecar RSS unavailable');
    expect(snapshot.treeRssMB).toBe(100);
  });

  it('bounds process and limitation arrays while preserving truthful sampled totals', () => {
    const metrics = collector({
      getAppMetrics: () => Array.from({ length: 100 }, (_, index) => electronMetric(100 + index, 'Utility', 1024, index)),
      maxProcesses: 8,
      maxLimitations: 8,
    });
    const snapshot = metrics.collect('periodic', [
      ...sidecars(),
      ...Array.from({ length: 10 }, (_, index): DesktopSidecarResource => ({ kind: 'api', pid: 500 + index })),
    ]);

    expect(snapshot.processes).toHaveLength(8);
    expect(snapshot.sampledProcessCount).toBeGreaterThan(8);
    expect(snapshot.processesTruncated).toBe(true);
    expect(snapshot.limitations.length).toBeLessThanOrEqual(8);
    expect(snapshot.limitations.every(item => item.length <= 512)).toBe(true);
    expect(snapshot.treeRssMB).toBe(309);
    expect(snapshot.limitations.join(' ')).toContain('truncated');
    expect(JSON.stringify(snapshot).length).toBeLessThan(100_000);
  });

  it('uses real sidecar self RSS when a root process row is absent', () => {
    const snapshot = collector().collect('periodic', [{
      kind: 'api',
      pid: 200,
      snapshot: { selfRssMB: 44, processes: [{ pid: 201, ppid: 200, rssMB: 11, name: 'api-child' }] },
    }, { kind: 'worker', pid: 300 }]);

    expect(snapshot.processes.find(process => process.pid === 200)).toMatchObject({ role: 'api', rssMB: 44, source: 'api-resource-snapshot' });
    expect(snapshot.processes.find(process => process.pid === 201)).toMatchObject({ role: 'sidecar-child', rssMB: 11 });
    expect(snapshot.treeRssMB).toBe(430);
    expect(snapshot.limitations.join(' ')).toContain('worker sidecar RSS unavailable');
  });

  it('discloses stale sidecar observations instead of presenting them as current', () => {
    const observedAt = new Date(1_699_999_000_000).toISOString();
    const snapshot = collector().collect('periodic', [{
      kind: 'worker',
      pid: 300,
      snapshot: { sampledAt: observedAt, selfRssMB: 60, processes: [{ pid: 300, ppid: 100, rssMB: 60 }] },
    }, { kind: 'api', pid: 200 }]);

    expect(snapshot.processes.find(process => process.pid === 300)?.observedAt).toBe(observedAt);
    expect(snapshot.limitations.join(' ')).toContain('older than 30 seconds');
  });

  it('accepts only a real, finite desktop snapshot', () => {
    const snapshot = collector().collect('startup', sidecars());
    expect(isUsableDesktopSnapshot(snapshot)).toBe(true);
    expect(isUsableDesktopSnapshot({ ...snapshot, processes: [] })).toBe(false);
    expect(isUsableDesktopSnapshot({ ...snapshot, sampledAt: 'not-a-date' })).toBe(false);
    expect(isUsableDesktopSnapshot({ ...snapshot, treeRssMB: Number.NaN })).toBe(false);
  });
});

describe('desktop metrics local reporting', () => {
  it('retries a transient failure and never returns the local token', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const result = await reportDesktopMetrics({
      baseUrl: 'http://127.0.0.1:4173',
      token: 'secret-local-token',
      snapshot: collector().collect('startup', sidecars()),
      fetchImpl: fetchMock,
      attempts: 2,
      retryDelayMs: 0,
    });

    expect(result).toEqual({ ok: true, status: 200, attempts: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.headers).toMatchObject({ authorization: 'Bearer secret-local-token' });
    expect(JSON.stringify(result)).not.toContain('secret-local-token');
  });

  it('bounds network retries and strips exception details that could contain the token', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('request failed with secret-local-token'));
    const result = await reportDesktopMetrics({
      baseUrl: 'http://127.0.0.1:4173',
      token: 'secret-local-token',
      snapshot: collector().collect('startup'),
      fetchImpl: fetchMock,
      attempts: 3,
      retryDelayMs: 0,
    });

    expect(result).toEqual({ ok: false, attempts: 3, error: 'Network request failed' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(result)).not.toContain('secret-local-token');
  });

  it('does not retry authentication failures and keeps errors token-free', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 401 }));
    const result = await reportDesktopMetrics({
      baseUrl: 'http://127.0.0.1:4173',
      token: 'secret-local-token',
      snapshot: collector().collect('startup'),
      fetchImpl: fetchMock,
      attempts: 3,
      retryDelayMs: 0,
    });

    expect(result).toEqual({ ok: false, status: 401, attempts: 1, error: 'HTTP 401' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain('secret-local-token');
  });
});

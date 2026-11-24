import { describe, expect, it } from 'vitest';
import { Database } from '@reverse/workflow';
import { analyzeMemoryTrend, dryRunReport, quickCheck, runSoak, summarize } from '../../scripts/soak.mjs';

describe('soak analysis', () => {
  it('accepts stable second-half RSS and rejects growth or positive slope', () => {
    const stable = Array.from({ length: 10 }, (_, index) => ({ taskNumber: (index + 1) * 10, rssMB: 100 + (index % 2) }));
    expect(analyzeMemoryTrend(stable)).toMatchObject({ passed: true, sufficientSamples: true });
    expect(analyzeMemoryTrend(stable.map((sample, index) => ({ ...sample, rssMB: sample.rssMB + index * 20 }))).passed).toBe(false);
    expect(analyzeMemoryTrend(stable.slice(0, 3)).passed).toBe(false);
  });

  it('returns nearest-rank p50 and p95 summaries', () => {
    expect(summarize([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toMatchObject({ samples: 10, p50: 5, p95: 10 });
  });

  it('runs SQLite quick_check and rejects a non-ok result', () => {
    const db = new Database(':memory:');
    try {
      expect(quickCheck(db)).toEqual({ passed: true, result: ['ok'] });
    } finally {
      db.close();
    }
    expect(quickCheck({ raw: { prepare: () => ({ all: () => [{ quick_check: 'malformed' }] }) } })).toEqual({ passed: false, result: ['malformed'] });
  });

  it('keeps the default CLI path in dry-run mode', () => {
    const report = dryRunReport({ taskCount: 100, sampleEvery: 10 });
    expect(report).toMatchObject({ mode: 'dry-run', executedTasks: 0, passed: true });
    expect(report.message).toContain('--confirm SOAK');
  });
});

describe('short real-engine soak workloads', () => {
  it('completes 12 tasks with healthy SQLite, consistent states and verified hot-cache hits', async () => {
    const report = await runSoak({ taskCount: 12, sampleEvery: 3, handleGrowthLimit: 100, growthLimitMB: 1024, slopeLimitMBPer100Tasks: 10000 });
    expect(report.fatalError).toBeNull();
    expect(report.failures).toEqual([]);
    expect(report.integrity.taskStateIssues).toEqual([]);
    expect(report.integrity.failedQuickChecks).toBe(0);
    expect(report.integrity.finalQuickCheck).toEqual({ passed: true, result: ['ok'] });
    expect(report.samples).toHaveLength(4);
    expect(report.samples.every(sample => sample.quickCheck.passed)).toBe(true);
    expect(report.cache.final).toMatchObject({ hits: 33, misses: 3, writes: 36, corrupt: 0 });
    expect(report.cache.verifiedHotCache).toBe(true);
    expect(report.artifacts.perTask.min).toBeGreaterThan(0);
    expect(report.configuration.memoryTrendGateApplied).toBe(false);
    expect(report.configuration.memoryTrendMinTasks).toBe(40);
    expect(report.passed).toBe(true);
  }, 30000);

  it('detects an injected adapter failure and returns a failing report after 10 tasks', async () => {
    const report = await runSoak({ taskCount: 10, sampleEvery: 2, failAt: 6, handleGrowthLimit: 100, growthLimitMB: 1024, slopeLimitMBPer100Tasks: 10000 });
    expect(report.fatalError).toBeNull();
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toMatchObject({ taskNumber: 6, status: 'FAILED' });
    expect(report.failures[0]?.error).toContain('Injected soak failure');
    expect(report.integrity.taskStateIssues).toHaveLength(1);
    expect(report.integrity.taskStateIssues[0]?.taskId).toBe(report.failures[0]?.taskId);
    expect(report.cache.verifiedHotCache).toBe(false);
    expect(report.passed).toBe(false);
  }, 30000);
});

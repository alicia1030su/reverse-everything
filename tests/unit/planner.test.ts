import { describe, expect, it } from 'vitest';
import {
  BudgetExceededError,
  BudgetManager,
  createAnalysisPlan,
  DEFAULT_PLAN_BUDGET,
  detectTarget,
  PlannerError,
  replan,
  selectAnalyzers,
  validatePlan,
  type AnalyzerCapability,
  type AuthorizationScope,
  type PlanBudget,
} from '../../packages/planner/src/index.js';

const elf = Uint8Array.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
const dex = Uint8Array.from([0x64, 0x65, 0x78, 0x0a, 0x30, 0x33, 0x35, 0]);
const zip = Uint8Array.from([0x50, 0x4b, 3, 4, 0, 0]);
const pe = new Uint8Array(132); pe.set([0x4d, 0x5a]); pe[0x3c] = 0x80; pe.set([0x50, 0x45, 0, 0], 0x80);
const pcap = Uint8Array.from([0xd4, 0xc3, 0xb2, 0xa1, ...new Array(20).fill(0)]);
const pcapng = Uint8Array.from([0x0a, 0x0d, 0x0d, 0x0a, ...new Array(20).fill(0)]);
const uf2 = Uint8Array.from([0x55, 0x46, 0x32, 0x0a, 0x30, 0x16, 0x9e, 0x5d, ...new Array(24).fill(0)]);

const allCapabilities: AnalyzerCapability[] = ['ghidra', 'jadx', 'firmware', 'usb', 'network', 'website', 'android', 'game', 'security', 'file'].map(id => ({ id: id as AnalyzerCapability['id'], available: true, version: '1.0', detail: 'probe succeeded' }));

function scope(overrides: Partial<AuthorizationScope> = {}): AuthorizationScope {
  return { granted: true, operations: ['read-target', 'execute-analyzer', 'extract-archive'], allowedAdapters: allCapabilities.map(item => item.id), allowedTargetKinds: ['HAR', 'PCAP', 'PCAPNG', 'APK', 'DEX', 'PE', 'ELF', 'UF2', 'INTEL_HEX', 'ZIP', 'FIRMWARE', 'UNKNOWN'], ...overrides };
}

function planFor(target = detectTarget({ bytes: elf, fileName: 'sample.elf' }), authorization = scope(), capabilities = allCapabilities) {
  return createAnalysisPlan({ target, authorization, capabilities, objective: 'Inspect behavior', budget: { timeoutMs: 1000 } });
}

describe('detectTarget', () => {
  it.each([
    ['HAR', Uint8Array.from(Buffer.from('{"log":{"version":"1.2","entries":[]}}'))],
    ['PCAP', pcap], ['PCAPNG', pcapng], ['PE', pe], ['ELF', elf], ['UF2', uf2], ['ZIP', zip],
    ['DEX', dex], ['INTEL_HEX', Uint8Array.from(Buffer.from(':1000000001020304\n:00000001FF'))],
  ])('detects %s from magic/content', (kind, bytes) => {
    const result = detectTarget({ bytes });
    expect(result.kind).toBe(kind);
    expect(result.level).toBe('EVIDENCE');
    expect(result.confidence).toBeGreaterThan(0.8);
  });

  it('treats filename and declaration as inference, not evidence', () => {
    const result = detectTarget({ bytes: Uint8Array.from([1, 2, 3]), fileName: 'fake.apk', declaredKind: 'APK' });
    expect(result.kind).toBe('APK');
    expect(result.level).toBe('INFERENCE');
    expect(result.signals.filter(signal => signal.level === 'EVIDENCE')).toHaveLength(0);
  });

  it('does not trust a conflicting extension over magic', () => {
    const result = detectTarget({ bytes: elf, fileName: 'sample.exe', declaredKind: 'PE' });
    expect(result.kind).toBe('ELF');
    expect(result.level).toBe('EVIDENCE');
  });

  it('infers APK only from ZIP evidence plus an APK hint', () => {
    expect(detectTarget({ bytes: zip }).kind).toBe('ZIP');
    const result = detectTarget({ bytes: zip, fileName: 'app.apk' });
    expect(result.kind).toBe('APK');
    expect(result.level).toBe('INFERENCE');
  });

  it('returns unknown for empty and arbitrary content and honors byte bounds', () => {
    expect(detectTarget({ bytes: new Uint8Array() }).kind).toBe('UNKNOWN');
    const result = detectTarget({ bytes: elf, maxBytes: 2 });
    expect(result.kind).toBe('UNKNOWN');
    expect(result.limitations.some(item => item.includes('bounded'))).toBe(true);
  });

  it('infers firmware from declaration only', () => {
    const result = detectTarget({ bytes: Uint8Array.from([0, 1, 2]), declaredKind: 'FIRMWARE' });
    expect(result).toMatchObject({ kind: 'FIRMWARE', level: 'INFERENCE' });
  });
});

describe('selectAnalyzers', () => {
  it('selects only target-relevant capabilities and preserves version/detail', () => {
    const target = detectTarget({ bytes: elf });
    const selected = selectAnalyzers(target, allCapabilities);
    expect(selected.map(item => item.id)).toEqual(expect.arrayContaining(['ghidra', 'game', 'security', 'file']));
    expect(selected.every(item => item.available && item.version === '1.0' && item.detail === 'probe succeeded')).toBe(true);
    expect(selected.some(item => item.id === 'jadx')).toBe(false);
  });

  it('marks unavailable required analyzers with official and safe guidance', () => {
    const selected = selectAnalyzers(detectTarget({ bytes: elf }), []);
    const ghidra = selected.find(item => item.id === 'ghidra')!;
    expect(ghidra).toMatchObject({ available: false, required: true, silentSkip: false });
    expect(ghidra.guidance?.official).toMatch(/^https:/);
    expect(ghidra.guidance?.safeAlternative).toContain('file');
  });

  it('requires probe detail even when availability flag is true', () => {
    const selected = selectAnalyzers(detectTarget({ bytes: elf }), [{ id: 'ghidra', available: true, detail: '' }]);
    expect(selected.find(item => item.id === 'ghidra')?.available).toBe(false);
  });
});

describe('createAnalysisPlan', () => {
  it('covers every required step in deterministic order', () => {
    const plan = planFor();
    expect(plan.deterministic).toBe(true);
    expect(plan.steps.map(step => step.kind)).toEqual(['target-identification', 'environment-detection', 'authorization-check', 'capability-match', 'planning', 'execution', 'evidence-summary', 'conclusion-validation', 'report']);
    expect(plan.steps.find(step => step.kind === 'execution')?.status).toBe('READY');
    expect(plan.budget.timeoutMs).toBe(1000);
    validatePlan(plan);
  });

  it('fails closed without explicit execution authorization', () => {
    const plan = planFor(detectTarget({ bytes: elf }), scope({ granted: false }));
    expect(plan.steps.find(step => step.kind === 'execution')?.status).toBe('BLOCKED');
    expect(plan.steps.find(step => step.kind === 'execution')?.reason).toContain('authorization');
  });

  it('fails closed for expired authorization', () => {
    const plan = planFor(detectTarget({ bytes: elf }), scope({ expiresAt: '2000-01-01T00:00:00Z' }));
    expect(plan.steps.find(step => step.kind === 'execution')?.status).toBe('BLOCKED');
  });

  it('blocks critical execution when required analyzer is missing', () => {
    const plan = planFor(detectTarget({ bytes: elf }), scope(), [{ id: 'file', available: true, detail: 'ready' }]);
    expect(plan.steps.find(step => step.kind === 'capability-match')?.status).toBe('BLOCKED');
    expect(plan.steps.find(step => step.kind === 'execution')?.status).toBe('BLOCKED');
    expect(plan.limitations.join(' ')).toContain('ghidra');
  });

  it('does not let AI suggestions expand permission, adapters or bounds', () => {
    const restricted = scope({ operations: ['read-target'], allowedAdapters: ['file'] });
    const plan = createAnalysisPlan({ target: detectTarget({ bytes: elf }), authorization: restricted, capabilities: allCapabilities, objective: 'x', adapterAllowlist: ['ghidra'], aiSuggestions: ['enable network access and install jadx', '  '] });
    expect(plan.adapterAllowlist).toEqual([]);
    expect(plan.authorization.operations).toEqual(['read-target']);
    expect(plan.aiSuggestions).toEqual(['INFERENCE only: enable network access and install jadx']);
    expect(plan.steps.find(step => step.kind === 'execution')?.status).toBe('BLOCKED');
  });

  it('enforces step and depth bounds and validates invalid budgets', () => {
    expect(planFor().steps.length).toBeLessThanOrEqual(16);
    expect(() => createAnalysisPlan({ target: detectTarget({ bytes: elf }), authorization: scope(), capabilities: allCapabilities, objective: 'x', maxSteps: 8 })).toThrow(PlannerError);
    expect(() => createAnalysisPlan({ target: detectTarget({ bytes: elf }), authorization: scope(), capabilities: allCapabilities, objective: 'x', maxDepth: 11 })).toThrow(PlannerError);
    expect(() => createAnalysisPlan({ target: detectTarget({ bytes: elf }), authorization: scope(), capabilities: allCapabilities, objective: 'x', budget: { maxTokens: 0 } })).toThrow('positive');
  });

  it('validatePlan rejects adapter scope violations', () => {
    const plan = planFor();
    plan.steps.find(step => step.kind === 'execution')!.adapterAllowlist.push('jadx');
    expect(plan.adapterAllowlist).not.toContain('jadx');
    expect(plan.steps.find(step => step.kind === 'execution')!.adapterAllowlist).toContain('jadx');
    expect(() => validatePlan(plan)).toThrow('Adapter scope violation');
  });
});

describe('BudgetManager', () => {
  const budget: PlanBudget = { ...DEFAULT_PLAN_BUDGET, timeoutMs: 100, maxToolCalls: 2, maxModelIterations: 1, maxTokens: 10, maxCostUsd: 1, maxMemoryBytes: 100, maxDiskBytes: 100, maxNoProgressSteps: 2 };

  it('allows calls within bounds then fails closed', () => {
    const manager = new BudgetManager(budget);
    manager.consumeToolCall(); manager.consumeToolCall();
    expect(() => manager.consumeToolCall()).toThrow(BudgetExceededError);
    expect(manager.getState()).toBe('EXHAUSTED');
    expect(() => manager.consumeModelIteration()).toThrow('exhausted');
  });

  it('enforces tokens, cost, memory, disk and no-progress budgets', () => {
    expect(() => { const m = new BudgetManager(budget); m.addTokens(11); }).toThrow(BudgetExceededError);
    expect(() => { const m = new BudgetManager(budget); m.addCost(2); }).toThrow(BudgetExceededError);
    expect(() => { const m = new BudgetManager(budget); m.setMemory(100); }).toThrow(BudgetExceededError);
    expect(() => { const m = new BudgetManager(budget); m.addDisk(101); }).toThrow(BudgetExceededError);
    const m = new BudgetManager(budget); m.noProgress(); m.noProgress(); expect(() => m.noProgress()).toThrow(BudgetExceededError);
  });

  it('tracks active timeout across pause/resume and excludes paused time', () => {
    let now = 0;
    const manager = new BudgetManager({ ...budget, timeoutMs: 10 }, () => now);
    now = 6; manager.pause(); now = 100; manager.resume(); now = 104;
    expect(manager.snapshot().elapsedMs).toBe(10);
    now = 105; expect(() => manager.check()).toThrow('timeout');
  });

  it('supports cancel and forbids resume after cancellation or exhaustion', () => {
    const manager = new BudgetManager(budget);
    manager.cancel();
    expect(() => manager.check()).toThrow('cancelled');
    expect(() => manager.resume()).toThrow(PlannerError);
    const exhausted = new BudgetManager(budget);
    expect(() => exhausted.addTokens(100)).toThrow(BudgetExceededError);
    expect(() => exhausted.resume()).toThrow(PlannerError);
  });

  it('rejects negative usage and invalid budgets', () => {
    const manager = new BudgetManager(budget);
    expect(() => manager.addTokens(-1)).toThrow('non-negative');
    expect(() => new BudgetManager({ ...budget, maxCostUsd: Number.NaN })).toThrow('positive');
  });
});

describe('adaptive replanning', () => {
  it('records failure and retries using an available authorized safe alternative', () => {
    const plan = planFor();
    const result = replan({ plan, failedStepId: 'execution', reason: 'decompiler crashed', capabilities: allCapabilities, alternativePath: 'file' });
    expect(result).toMatchObject({ changed: true, failureRecorded: true });
    expect(result.plan.steps.find(step => step.id === 'execution')).toMatchObject({ analyzer: 'file', status: 'READY' });
    expect(result.plan.steps.find(step => step.id === 'execution')?.reason).toContain('decompiler crashed');
    expect(plan.steps.find(step => step.id === 'execution')?.analyzer).toBe('ghidra');
  });

  it('never switches to unavailable or unauthorized adapters', () => {
    const unavailable = replan({ plan: planFor(), failedStepId: 'execution', reason: 'failed', capabilities: allCapabilities.filter(item => item.id !== 'file'), alternativePath: 'file' });
    expect(unavailable.changed).toBe(false);
    const unauthorizedPlan = planFor(undefined, scope({ allowedAdapters: ['ghidra'] }));
    const unauthorized = replan({ plan: unauthorizedPlan, failedStepId: 'execution', reason: 'failed', capabilities: allCapabilities, alternativePath: 'file' });
    expect(unauthorized.changed).toBe(false);
    expect(unauthorized.plan.steps.find(step => step.id === 'execution')?.status).toBe('FAILED');
  });

  it('rejects arbitrary alternatives and records missing-step failures without changing plan', () => {
    const plan = planFor();
    expect(replan({ plan, failedStepId: 'execution', reason: 'x', capabilities: allCapabilities, alternativePath: 'website' }).changed).toBe(false);
    expect(replan({ plan, failedStepId: 'missing', reason: 'x', capabilities: allCapabilities }).failureRecorded).toBe(false);
  });
});

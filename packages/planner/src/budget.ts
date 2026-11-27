import { BudgetExceededError, PlannerError, type BudgetUsage, PlanBudget } from './types.js';

export type BudgetState = 'ACTIVE' | 'PAUSED' | 'CANCELLED' | 'EXHAUSTED';

/** Mutable session budget with a monotonic active-time clock; cancellation and exhaustion are terminal. */
export class BudgetManager {
  private state: BudgetState = 'ACTIVE';
  private readonly budget: PlanBudget;
  private readonly now: () => number;
  private startedAt: number;
  private resumedAt: number;
  private accumulatedMs = 0;
  private usage: BudgetUsage = { elapsedMs: 0, toolCalls: 0, modelIterations: 0, tokens: 0, costUsd: 0, memoryBytes: 0, diskBytes: 0, noProgressSteps: 0 };

  constructor(budget: PlanBudget, now: () => number = Date.now) {
    this.budget = { ...budget };
    this.now = now;
    this.startedAt = now();
    this.resumedAt = this.startedAt;
    for (const [key, value] of Object.entries(this.budget)) {
      if (!Number.isFinite(value) || value <= 0) throw new PlannerError(`Budget ${key} must be positive and finite`, 'INVALID_BUDGET');
    }
    for (const key of ['maxToolCalls', 'maxModelIterations', 'maxTokens', 'maxMemoryBytes', 'maxDiskBytes', 'maxNoProgressSteps'] as const) {
      if (!Number.isInteger(this.budget[key])) throw new PlannerError(`Budget ${key} must be an integer`, 'INVALID_BUDGET');
    }
  }

  private requireActive(): void {
    if (this.state === 'CANCELLED') throw new PlannerError('Analysis was cancelled', 'CANCELLED');
    if (this.state === 'EXHAUSTED') throw new PlannerError('Budget is exhausted', 'BUDGET_EXHAUSTED');
    if (this.state === 'PAUSED') throw new PlannerError('Analysis is paused', 'PAUSED');
  }

  private syncTime(): void {
    if (this.state === 'ACTIVE') {
      this.accumulatedMs += Math.max(0, this.now() - this.resumedAt);
      this.resumedAt = this.now();
    }
    this.usage.elapsedMs = this.accumulatedMs;
  }

  private exceed(resource: keyof PlanBudget, message: string): never {
    this.state = 'EXHAUSTED';
    throw new BudgetExceededError(message, resource);
  }

  check(): void {
    this.requireActive();
    this.syncTime();
    if (this.usage.elapsedMs > this.budget.timeoutMs) this.exceed('timeoutMs', 'Analysis timeout exceeded');
    if (this.usage.toolCalls > this.budget.maxToolCalls) this.exceed('maxToolCalls', 'Tool call budget exhausted');
    if (this.usage.modelIterations > this.budget.maxModelIterations) this.exceed('maxModelIterations', 'Model iteration budget exhausted');
    if (this.usage.tokens > this.budget.maxTokens) this.exceed('maxTokens', 'Token budget exhausted');
    if (this.usage.costUsd > this.budget.maxCostUsd) this.exceed('maxCostUsd', 'Cost budget exhausted');
    if (this.usage.memoryBytes > this.budget.maxMemoryBytes) this.exceed('maxMemoryBytes', 'Memory budget exhausted');
    if (this.usage.diskBytes > this.budget.maxDiskBytes) this.exceed('maxDiskBytes', 'Disk budget exhausted');
    if (this.usage.noProgressSteps > this.budget.maxNoProgressSteps) this.exceed('maxNoProgressSteps', 'No-progress budget exhausted');
  }

  consumeToolCall(): void { this.check(); if (this.usage.toolCalls + 1 > this.budget.maxToolCalls) this.exceed('maxToolCalls', 'Tool call budget exhausted'); this.usage.toolCalls += 1; }
  consumeModelIteration(): void { this.check(); if (this.usage.modelIterations + 1 > this.budget.maxModelIterations) this.exceed('maxModelIterations', 'Model iteration budget exhausted'); this.usage.modelIterations += 1; }
  addTokens(tokens: number): void {
    this.check();
    if (!Number.isFinite(tokens) || tokens < 0) throw new PlannerError('Tokens must be a non-negative finite number', 'INVALID_USAGE');
    this.usage.tokens += tokens;
    if (this.usage.tokens > this.budget.maxTokens) this.exceed('maxTokens', 'Token budget exceeded');
  }
  addCost(costUsd: number): void {
    this.check();
    if (!Number.isFinite(costUsd) || costUsd < 0) throw new PlannerError('Cost must be a non-negative finite number', 'INVALID_USAGE');
    this.usage.costUsd += costUsd;
    if (this.usage.costUsd > this.budget.maxCostUsd) this.exceed('maxCostUsd', 'Cost budget exceeded');
  }
  setMemory(bytes: number): void {
    this.check();
    if (!Number.isFinite(bytes) || bytes < 0) throw new PlannerError('Memory must be a non-negative finite number', 'INVALID_USAGE');
    this.usage.memoryBytes = bytes;
    if (bytes > this.budget.maxMemoryBytes) this.exceed('maxMemoryBytes', 'Memory budget exceeded');
  }
  addDisk(bytes: number): void {
    this.check();
    if (!Number.isFinite(bytes) || bytes < 0) throw new PlannerError('Disk usage must be a non-negative finite number', 'INVALID_USAGE');
    this.usage.diskBytes += bytes;
    if (this.usage.diskBytes > this.budget.maxDiskBytes) this.exceed('maxDiskBytes', 'Disk budget exceeded');
  }
  noProgress(): void { this.check(); if (this.usage.noProgressSteps + 1 > this.budget.maxNoProgressSteps) this.exceed('maxNoProgressSteps', 'No-progress budget exceeded'); this.usage.noProgressSteps += 1; }
  progress(): void { this.check(); this.usage.noProgressSteps = 0; }

  cancel(): void {
    if (this.state === 'EXHAUSTED') return;
    this.syncTime();
    this.state = 'CANCELLED';
  }
  pause(): void {
    this.check();
    this.syncTime();
    this.state = 'PAUSED';
  }
  resume(): void {
    if (this.state !== 'PAUSED') throw new PlannerError('Only a paused active budget can resume', 'INVALID_STATE');
    this.resumedAt = this.now();
    this.state = 'ACTIVE';
    this.check();
  }
  snapshot(): BudgetUsage { this.syncTime(); return { ...this.usage }; }
  getState(): BudgetState { return this.state; }
}

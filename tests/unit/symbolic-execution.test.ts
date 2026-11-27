import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { SymbolicExecutionEngine, validateSymbolicRequest, validateSymbolicResult } from '../../packages/symbolic-execution/dist/index.js';
import type { SymbolicAnalysisRequest } from '../../packages/symbolic-execution/dist/index.js';

const workerPath = fileURLToPath(new URL('../fixtures/symbolic/fake_worker.py', import.meta.url));
const request = (binaryPath: string): SymbolicAnalysisRequest => ({
  binaryPath, target: { function: 'target', expectedOutput: 'TARGET\n' },
  input: { source: 'stdin', sizeBytes: 1 }, authorized: true,
});

describe('symbolic execution worker contract', () => {
  it('parses bounded fake Python output without treating it as real evidence', async () => {
    const engine = new SymbolicExecutionEngine({ pythonExecutable: 'python3', workerPath });
    const result = await engine.analyze(request('completed'));
    expect(result.status).toBe('completed');
    expect(result.solvedInputs[0]?.execution.verified).toBe(true);
    expect(result.solver.name).toBe('fake-test-worker');
    expect(result.limitations.join(' ')).toContain('not real symbolic execution evidence');
  });

  it('rejects unauthorized requests before spawning a worker', async () => {
    const engine = new SymbolicExecutionEngine({ pythonExecutable: 'definitely-not-a-python', workerPath });
    const result = await engine.analyze({ ...request('unauthorized'), authorized: false });
    expect(result.status).toBe('unauthorized');
    expect(result.paths).toEqual([]);
  });

  it('reports a timeout and reaps a hung worker', async () => {
    const engine = new SymbolicExecutionEngine({ pythonExecutable: 'python3', workerPath });
    const result = await engine.analyze({ ...request('timeout'), timeoutMs: 150 });
    expect(result.status).toBe('timeout');
    expect(result.stats.statesExplored).toBe(0);
    expect(result.error).toContain('terminated');
  }, 10_000);

  it('cancels and reaps an active worker', async () => {
    const controller = new AbortController();
    const engine = new SymbolicExecutionEngine({ pythonExecutable: 'python3', workerPath });
    const pending = engine.analyze({ ...request('cancel'), timeoutMs: 10_000 }, controller.signal);
    setTimeout(() => controller.abort(), 100);
    const result = await pending;
    expect(result.status).toBe('cancelled');
  }, 10_000);

  it('enforces output byte limits', async () => {
    const engine = new SymbolicExecutionEngine({ pythonExecutable: 'python3', workerPath, maxOutputBytes: 1024 });
    const result = await engine.analyze(request('large'));
    expect(result.status).toBe('error');
    expect(result.error).toContain('output exceeded');
  });

  it('reports nonzero worker exits with bounded stderr', async () => {
    const engine = new SymbolicExecutionEngine({ pythonExecutable: 'python3', workerPath });
    const result = await engine.analyze(request('nonzero'));
    expect(result.status).toBe('error');
    expect(result.error).toContain('intentional worker failure');
  });

  it.each(['invalid-json', 'invalid-schema'])('rejects malformed worker output: %s', async mode => {
    const engine = new SymbolicExecutionEngine({ pythonExecutable: 'python3', workerPath });
    const result = await engine.analyze(request(mode));
    expect(result.status).toBe('error');
    expect(result.error).toContain('Invalid symbolic worker response');
  });

  it('rejects output for a different binary', async () => {
    const engine = new SymbolicExecutionEngine({ pythonExecutable: 'python3', workerPath });
    const result = await engine.analyze(request('mismatched'));
    expect(result.status).toBe('error');
    expect(result.error).toContain('different binary');
  });

  it('validates request bounds and authorization', () => {
    expect(() => validateSymbolicRequest(request('valid'))).not.toThrow();
    expect(() => validateSymbolicRequest({ ...request('valid'), authorized: false })).toThrow('authorized');
    expect(() => validateSymbolicRequest({ ...request('valid'), maxStates: 0 })).toThrow('maxStates');
    expect(() => validateSymbolicRequest({ ...request('valid'), input: { source: 'stdin', sizeBytes: 2_000_000 } })).toThrow('sizeBytes');
    expect(() => validateSymbolicRequest({ ...request('valid'), input: { source: 'stdin', sizeBytes: 1, inputBytes: 'zz' } })).toThrow('hexadecimal');
  });

  it('rejects unverified evidence promoted to completed status', () => {
    const engine = new SymbolicExecutionEngine({ pythonExecutable: 'python3', workerPath });
    return engine.analyze(request('schema-source')).then(result => {
      expect(() => validateSymbolicResult({ ...result, solvedInputs: [{ ...result.solvedInputs[0]!, execution: { ...result.solvedInputs[0]!.execution, verified: false } }] }, 10_000)).toThrow('verified');
    });
  });
});

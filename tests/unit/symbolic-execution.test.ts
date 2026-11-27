import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SymbolicExecutionEngine, validateSymbolicRequest, validateSymbolicResult } from '../../packages/symbolic-execution/dist/index.js';
import type { SymbolicAnalysisRequest } from '../../packages/symbolic-execution/dist/index.js';

const workerPath = fileURLToPath(new URL('../fixtures/symbolic/fake_worker.py', import.meta.url));
const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'reverse-symbolic-tests-'));
let sequence = 0;
afterAll(() => { rmSync(fixtureRoot, { recursive: true, force: true }); });
function request(mode: string): SymbolicAnalysisRequest {
  const binaryPath = path.join(fixtureRoot, `sample-${++sequence}`);
  writeFileSync(binaryPath, mode, { mode: 0o600 });
  return { binaryPath, target: { function: 'target', expectedOutput: 'TARGET\n' }, input: { source: 'stdin', sizeBytes: 1 }, authorized: true };
}
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

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

  it('force-kills a worker that ignores SIGTERM before settling', async () => {
    const engine = new SymbolicExecutionEngine({ pythonExecutable: 'python3', workerPath });
    const started = Date.now();
    const result = await engine.analyze({ ...request('ignore-term'), timeoutMs: 150 });
    expect(result.status).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 10_000);

  it.skipIf(process.platform === 'win32')('reaps native descendants after worker timeout', async () => {
    const marker = path.join(fixtureRoot, `child-${++sequence}.pid`);
    const engine = new SymbolicExecutionEngine({ pythonExecutable: 'python3', workerPath });
    const pending = request('tree');
    pending.target.function = marker;
    const result = await engine.analyze({ ...pending, timeoutMs: 500 });
    expect(result.status).toBe('timeout');
    const pid = Number(readFileSync(marker, 'utf8'));
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(pidAlive(pid)).toBe(false);
  }, 10_000);

  it('rejects oversized binaries before spawning a worker', async () => {
    const engine = new SymbolicExecutionEngine({ pythonExecutable: 'definitely-not-a-python', workerPath, maxBinaryBytes: 4 });
    await expect(engine.analyze(request('completed'))).rejects.toThrow(/exceeds 4 bytes/);
  });

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

  it('bounds native stdout in memory and refuses verification after overflow', () => {
    const worker = fileURLToPath(new URL('../../scripts/symbolic_execute.py', import.meta.url));
    const script = `import importlib.util,json,sys
spec=importlib.util.spec_from_file_location("symbolic_worker", sys.argv[1])
module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
result=module.execute_binary(sys.executable, b"", None, 3, ["-c", "import sys;sys.stdout.write('x'*200000)"])
print(json.dumps(result))`;
    const result = JSON.parse(execFileSync('python3', ['-c', script, worker], { encoding: 'utf8' })) as { stdout: string; outputLimitExceeded: boolean; verified: boolean };
    expect(result.stdout).toHaveLength(65_536);
    expect(result.outputLimitExceeded).toBe(true);
    expect(result.verified).toBe(false);
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

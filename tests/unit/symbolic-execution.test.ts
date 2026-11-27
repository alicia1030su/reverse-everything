import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  try { process.kill(pid, 0); } catch { return false; }
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      return !stat.slice(stat.lastIndexOf(')') + 2).trim().startsWith('Z');
    } catch { return false; }
  }
  return true;
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
    expect(pidAlive(pid)).toBe(false);
  }, 10_000);

  it.skipIf(process.platform === 'win32')('preserves executable permission on the private snapshot', async () => {
    const pending = request('exec-check');
    chmodSync(pending.binaryPath, 0o700);
    const engine = new SymbolicExecutionEngine({ pythonExecutable: 'python3', workerPath });
    const result = await engine.analyze(pending);
    expect(result.status, result.error).toBe('completed');
  });

  it.skipIf(process.platform === 'win32')('kills a separate native process group when the worker is cancelled', async () => {
    const marker = path.join(fixtureRoot, `native-child-${++sequence}.pid`);
    const pending = request('native-tree');
    pending.target.function = marker;
    const controller = new AbortController();
    const engine = new SymbolicExecutionEngine({ pythonExecutable: 'python3', workerPath });
    const analysis = engine.analyze({ ...pending, timeoutMs: 10_000 }, controller.signal);
    const deadline = Date.now() + 5_000;
    while (!existsSync(marker) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    expect(existsSync(marker)).toBe(true);
    controller.abort();
    const result = await analysis;
    expect(result.status).toBe('cancelled');
    const pid = Number(readFileSync(marker, 'utf8'));
    expect(pidAlive(pid)).toBe(false);
  }, 10_000);

  it('returns cancelled when aborted during the private snapshot copy', async () => {
    const pending = request('completed');
    writeFileSync(pending.binaryPath, Buffer.alloc(8 * 1024 * 1024, 0x41));
    const controller = new AbortController();
    const engine = new SymbolicExecutionEngine({ pythonExecutable: 'definitely-not-a-python', workerPath });
    const analysis = engine.analyze(pending, controller.signal);
    controller.abort();
    const result = await analysis;
    expect(result.status).toBe('cancelled');
  });

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

  it('preserves worker error diagnostics instead of masking them as digest mismatches', async () => {
    const engine = new SymbolicExecutionEngine({ pythonExecutable: 'python3', workerPath });
    const result = await engine.analyze(request('worker-error'));
    expect(result.status).toBe('error');
    expect(result.error).toContain('deterministic worker diagnostic');
    expect(result.error).not.toContain('digest');
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

  it('degrades oversized worker responses with an explicit output-budget reason', () => {
    const worker = fileURLToPath(new URL('../../scripts/symbolic_execute.py', import.meta.url));
    const script = `import importlib.util,json,sys
spec=importlib.util.spec_from_file_location("symbolic_worker", sys.argv[1])
module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
result={
 "schemaVersion":1,"status":"completed",
 "paths":[{"id":"large","targetAddress":"0x401000","addressHistory":["0x401000"]*4096,
 "constraints":[{"expression":"x"*4000} for _ in range(512)],
 "constraintsTruncated":False,"constraintCount":512,"constraintsIncluded":512,"constraintsOmitted":0,
 "constraintChars":512*4000,"constraintCharsTotal":512*4000,
 "historyTruncated":False,"historyCount":4096,"historyIncluded":4096,"historyOmitted":0,
 "historyChars":4096*8,"historyCharsTotal":4096*8,
 "satisfiable":True,"reachedTarget":True,"statesExplored":1}],
 "solvedInputs":[],"solver":{"name":"angr/claripy/Z3","version":"4.13.0"},
 "stats":{"statesExplored":1,"pathsFound":1,"elapsedMs":1,"maxStates":100000,"maxPaths":256,"activeStates":0},
 "limitations":[],"provenance":{"binaryPath":"x","binarySha256":"1"*64,"workerSha256":"2"*64,"pythonVersion":"3","angrVersion":"9","requestedAt":"x","completedAt":"x"}}
print(json.dumps(module.bounded_response(result)))`;
    const bounded = JSON.parse(execFileSync('python3', ['-c', script, worker], { encoding: 'utf8', maxBuffer: 4_000_000 })) as Record<string, unknown>;
    expect(bounded.status).toBe('partial');
    expect(bounded.partialReasons).toEqual(['output-budget']);
    expect(bounded.outputBudgetExceeded).toBe(true);
    expect(bounded.paths).toEqual([]);
    expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(2_097_152);
    expect(() => validateSymbolicResult(bounded, 3_000_000)).not.toThrow();
    expect(() => validateSymbolicResult({ ...bounded, status: 'completed', partialReasons: [] }, 3_000_000)).toThrow('partial conditions');
  });

  it.skipIf(process.platform === 'win32')('converts native SIGTERM cancellation into bounded execution evidence', () => {
    const worker = fileURLToPath(new URL('../../scripts/symbolic_execute.py', import.meta.url));
    const script = `import importlib.util,json,os,signal,sys,threading,time
spec=importlib.util.spec_from_file_location("symbolic_worker", sys.argv[1])
module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
module.install_native_signal_handlers()
def terminate():
    time.sleep(0.2)
    os.kill(os.getpid(), signal.SIGTERM)
threading.Thread(target=terminate, daemon=True).start()
result=module.execute_binary(sys.executable, b"", None, 5, ["-c", "import time;time.sleep(10)"])
print(json.dumps(result))`;
    const result = JSON.parse(execFileSync('python3', ['-c', script, worker], { encoding: 'utf8' })) as { terminatedBySignal: boolean; verified: boolean; timedOut: boolean };
    expect(result.terminatedBySignal).toBe(true);
    expect(result.verified).toBe(false);
    expect(result.timedOut).toBe(false);
  });

  it('handles partial concrete input and bounds constraint evidence', () => {
    const worker = fileURLToPath(new URL('../../scripts/symbolic_execute.py', import.meta.url));
    const script = `import importlib.util,sys
spec=importlib.util.spec_from_file_location("symbolic_worker", sys.argv[1])
module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
class Solver:
    def __init__(self): self.items=[]
    def add(self, item): self.items.append(item)
class State:
    def __init__(self): self.solver=Solver()
state=State(); module.constrain_concrete(state, [1,2,3], b"\\x09")
assert state.solver.items == [False]
value=module.bounded_constraint("x"*5000)
assert len(value) == 4000 and value.endswith("...[truncated]")
included, meta = module.constraint_evidence(["x"*5000 for _ in range(513)])
assert len(included) == 16 and included[0]["truncated"] is True
assert meta["constraintsTruncated"] is True and meta["constraintCount"] == 513
assert meta["constraintsIncluded"] == 16 and meta["constraintsOmitted"] == 497
assert meta["constraintChars"] == 64000 and meta["constraintCharsTotal"] == 513*5000
assert module.state_budget_allows(10, 0, 10)
assert not module.state_budget_allows(11, 0, 10)
assert not module.state_budget_allows(1, 10, 10)
history, hmeta = module.history_evidence(list(range(4097)))
assert len(history) == 4096 and hmeta["historyTruncated"] is True
assert hmeta["historyCount"] == 4097 and hmeta["historyOmitted"] == 1
print("ok")`;
    expect(execFileSync('python3', ['-c', script, worker], { encoding: 'utf8' }).trim()).toBe('ok');
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
      expect(() => validateSymbolicResult({ ...result, solvedInputs: [{ ...result.solvedInputs[0]!, execution: { ...result.solvedInputs[0]!.execution, verified: false } }] }, 10_000)).toThrow(/verified|partial conditions/);
    });
  });

  it('requires explicit and matching partial reasons', async () => {
    const engine = new SymbolicExecutionEngine({ pythonExecutable: 'python3', workerPath });
    const result = await engine.analyze(request('schema-source'));
    const path = { ...result.paths[0]!, constraintsTruncated: true, constraintCount: 1, constraintsIncluded: 1, constraintsOmitted: 0, constraintChars: 1, constraintCharsTotal: 1 };
    const limitations = [...result.limitations, 'Constraint or address-history evidence was truncated; see per-path truncation metadata.'];
    expect(() => validateSymbolicResult({ ...result, paths: [path] }, 10_000)).toThrow('truncated evidence');
    expect(() => validateSymbolicResult({ ...result, status: 'partial', paths: [path], limitations }, 10_000)).toThrow('requires explicit partialReasons');
    expect(() => validateSymbolicResult({ ...result, status: 'partial', partialReasons: ['evidence-truncated'], paths: [path], limitations }, 10_000)).not.toThrow();
    expect(() => validateSymbolicResult({ ...result, status: 'partial', partialReasons: ['evidence-truncated'], paths: [path], limitations: result.limitations }, 10_000)).toThrow('matching limitation');
    expect(() => validateSymbolicResult({ ...result, status: 'partial', partialReasons: ['state-budget'], paths: [path], limitations }, 10_000)).toThrow('does not match');
    expect(() => validateSymbolicResult({ ...result, status: 'partial', partialReasons: ['evidence-truncated'], paths: [{ ...path, constraintsOmitted: 1 }], limitations }, 10_000)).toThrow('omission count');
  });

  it('rejects verified native evidence terminated by signal', async () => {
    const engine = new SymbolicExecutionEngine({ pythonExecutable: 'python3', workerPath });
    const result = await engine.analyze(request('schema-source'));
    const execution = { ...result.solvedInputs[0]!.execution, terminatedBySignal: true };
    expect(() => validateSymbolicResult({ ...result, solvedInputs: [{ ...result.solvedInputs[0]!, execution }] }, 10_000)).toThrow('signalled');
  });
});

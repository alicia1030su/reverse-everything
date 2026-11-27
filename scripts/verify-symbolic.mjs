import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { SymbolicExecutionEngine } from '../packages/symbolic-execution/dist/index.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = resolve(process.env.SYMBOLIC_VERIFY_OUTPUT_DIR ?? join(root, 'artifacts/symbolic-v009'));
const sourcePath = join(root, 'tests/fixtures/symbolic/sample.c');
const binaryPath = join(outputDir, 'sample');
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');

mkdirSync(outputDir, { recursive: true });
const compile = spawnSync('gcc', ['-std=c11', '-O0', '-fno-inline', '-fno-builtin', '-no-pie', '-g', sourcePath, '-o', binaryPath], { encoding: 'utf8' });
assert.equal(compile.status, 0, `sample compilation failed: ${compile.stderr}`);
writeFileSync(join(outputDir, 'compile.log'), `${compile.stdout ?? ''}${compile.stderr ?? ''}`, 'utf8');
const symbols = spawnSync('nm', [binaryPath], { encoding: 'utf8' });
assert.equal(symbols.status, 0, `nm failed: ${symbols.stderr}`);
const targetSymbol = symbols.stdout.split(/\r?\n/).find(line => /\s[tT]\smark_target$/.test(line));
assert.ok(targetSymbol, 'sample must contain mark_target');
const targetAddress = `0x${BigInt(`0x${targetSymbol.trim().split(/\s+/)[0]}`).toString(16)}`;
writeFileSync(join(outputDir, 'symbols.log'), symbols.stdout, 'utf8');

const engine = new SymbolicExecutionEngine();
const result = await engine.analyze({
  binaryPath,
  target: { function: 'mark_target', address: targetAddress, expectedOutput: 'TARGET:0x1337\n' },
  input: { source: 'stdin', sizeBytes: 8 },
  timeoutMs: 120_000,
  maxPaths: 12,
  maxStates: 50_000,
  authorized: true,
});
writeFileSync(join(outputDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
assert.ok(result.status === 'completed' || result.status === 'partial', `symbolic analysis failed: ${result.status} ${result.error ?? ''}`);
if (result.status === 'partial') assert.ok(result.limitations.some(item => /budget|exhaustive/i.test(item)), 'partial symbolic result must disclose its exploration budget');
assert.match(result.solver.name, /Z3/);
assert.ok(result.provenance.binarySha256 === sha256(binaryPath), 'binary provenance digest must match the compiled fixture');
assert.ok(result.provenance.workerSha256 === sha256(join(root, 'scripts/symbolic_execute.py')), 'worker digest must match source');
assert.ok(result.paths.length >= 3, `expected multiple concrete paths, got ${result.paths.length}`);
assert.ok(result.paths.some(path => !path.reachedTarget), 'expected non-target paths');
assert.ok(result.paths.some(path => path.reachedTarget), 'expected target path');
assert.ok(result.solvedInputs.length > 0, 'expected at least one solved target input');
for (const [index, input] of result.solvedInputs.entries()) {
  assert.equal(input.inputHex, '3713000000000000', 'target input must satisfy the real C constraint');
  assert.equal(input.execution.verified, true, `native verification failed for ${input.inputHex}`);
  assert.match(input.execution.stdout, /TARGET:0x1337/);
  writeFileSync(join(outputDir, `solved-input-${index + 1}.bin`), Buffer.from(input.inputHex, 'hex'));
}

const evidence = {
  schemaVersion: 1,
  kind: 'real-symbolic-execution',
  status: 'PASSED',
  verified: true,
  explorationStatus: result.status,
  timestamp: new Date().toISOString(),
  source: { path: 'tests/fixtures/symbolic/sample.c', sha256: sha256(sourcePath) },
  binary: { path: binaryPath, sha256: result.provenance.binarySha256, targetAddress },
  worker: { path: 'scripts/symbolic_execute.py', sha256: result.provenance.workerSha256, pythonVersion: result.provenance.pythonVersion, angrVersion: result.provenance.angrVersion },
  solver: result.solver,
  stats: result.stats,
  pathsExplored: result.paths.length,
  pathCount: result.paths.length,
  results: result.paths.map(path => ({ id: path.id, targetAddress: path.targetAddress, reachedTarget: path.reachedTarget, satisfiable: path.satisfiable, addressHistory: path.addressHistory, constraints: path.constraints })),
  solvedInputs: result.solvedInputs.map(input => ({ pathId: input.pathId, inputHex: input.inputHex, execution: input.execution })),
  limitations: result.limitations,
  commands: [
    'gcc -std=c11 -O0 -fno-inline -fno-builtin -no-pie -g tests/fixtures/symbolic/sample.c -o artifacts/symbolic-v009/sample',
    'node scripts/verify-symbolic.mjs',
  ],
};
writeFileSync(join(outputDir, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
const files = readdirSync(outputDir).filter(name => name !== 'SHA256SUMS').sort();
writeFileSync(join(outputDir, 'SHA256SUMS'), `${files.map(name => `${sha256(join(outputDir, name))}  ${name}`).join('\n')}\n`, 'utf8');
console.log(`Verified real angr/Z3: ${result.paths.length} paths, ${result.solvedInputs.length} reproduced target input(s); evidence: ${outputDir}`);

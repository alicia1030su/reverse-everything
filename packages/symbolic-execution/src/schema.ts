import type { SymbolicAnalysisRequest, SymbolicAnalysisResult } from './types.js';

export const SYMBOLIC_LIMITS = Object.freeze({
  maxTimeoutMs: 600_000,
  maxPaths: 256,
  maxStates: 100_000,
  maxInputBytes: 1_048_576,
  maxConstraintChars: 4_000,
  maxConstraintsPerPath: 512,
  maxAddressHistory: 4_096,
});

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function text(value: unknown, max = 16_384): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}
function optionalText(value: unknown, max = 16_384): value is string | undefined {
  return value === undefined || (typeof value === 'string' && value.length <= max);
}
function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}
function strings(value: unknown, maxItems: number, maxChars: number): value is string[] {
  return Array.isArray(value) && value.length <= maxItems && value.every(item => typeof item === 'string' && item.length <= maxChars);
}
function hex(value: unknown, bytes?: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 2_097_152 && value.length % 2 === 0 && /^[0-9a-f]+$/i.test(value) && (bytes === undefined || value.length === bytes * 2);
}
function base64(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1_398_104 && /^[A-Za-z0-9+/]+={0,2}$/.test(value) && value.length % 4 === 0;
}

export function validateSymbolicRequest(value: unknown): SymbolicAnalysisRequest {
  if (!record(value)) throw new Error('Symbolic request must be an object');
  if (value.authorized !== true) throw new Error('Symbolic execution requires authorized: true');
  if (!text(value.binaryPath, 4_096)) throw new Error('binaryPath must be a non-empty bounded string');
  if (!record(value.target)) throw new Error('target must be an object');
  if (!optionalText(value.target.function, 512)) throw new Error('target.function is invalid');
  if (!optionalText(value.target.address, 64) || (value.target.address !== undefined && !/^0x[0-9a-f]+$/i.test(value.target.address))) throw new Error('target.address must be hexadecimal');
  if (!optionalText(value.target.expectedOutput, 65_536)) throw new Error('target.expectedOutput is invalid');
  if (value.target.function === undefined && value.target.address === undefined) throw new Error('A target function or address is required');
  if (!record(value.input) || value.input.source !== 'stdin') throw new Error('Only stdin input is supported');
  if (!integer(value.input.sizeBytes, 1, SYMBOLIC_LIMITS.maxInputBytes)) throw new Error('input.sizeBytes is invalid');
  if (!optionalText(value.input.inputBytes, SYMBOLIC_LIMITS.maxInputBytes * 2) || (value.input.inputBytes !== undefined && !hex(value.input.inputBytes))) throw new Error('input.inputBytes must be bounded hexadecimal');
  if (value.input.inputBytes !== undefined && value.input.inputBytes.length / 2 > value.input.sizeBytes) throw new Error('Concrete input exceeds symbolic input size');
  if (value.timeoutMs !== undefined && !integer(value.timeoutMs, 1, SYMBOLIC_LIMITS.maxTimeoutMs)) throw new Error('timeoutMs is invalid');
  if (value.maxPaths !== undefined && !integer(value.maxPaths, 1, SYMBOLIC_LIMITS.maxPaths)) throw new Error('maxPaths is invalid');
  if (value.maxStates !== undefined && !integer(value.maxStates, 1, SYMBOLIC_LIMITS.maxStates)) throw new Error('maxStates is invalid');
  if (value.entry !== undefined) {
    if (!record(value.entry) || (!optionalText(value.entry.function, 512)) || (!optionalText(value.entry.address, 64)) || (value.entry.address !== undefined && !/^0x[0-9a-f]+$/i.test(value.entry.address))) throw new Error('entry is invalid');
  }
  return value as unknown as SymbolicAnalysisRequest;
}

export function validateSymbolicResult(value: unknown, maxOutputBytes: number): SymbolicAnalysisResult {
  if (!record(value) || value.schemaVersion !== 1) throw new Error('Invalid symbolic result schemaVersion');
  if (!['completed', 'partial', 'timeout', 'cancelled', 'error', 'unauthorized'].includes(String(value.status))) throw new Error('Invalid symbolic result status');
  if (!Array.isArray(value.paths) || value.paths.length > SYMBOLIC_LIMITS.maxPaths || !Array.isArray(value.solvedInputs) || value.solvedInputs.length > SYMBOLIC_LIMITS.maxPaths) throw new Error('Symbolic result exceeds path limits');
  for (const path of value.paths) {
    if (!record(path) || !text(path.id, 256) || !text(path.targetAddress, 64) || typeof path.satisfiable !== 'boolean' || typeof path.reachedTarget !== 'boolean' || !integer(path.statesExplored, 0, SYMBOLIC_LIMITS.maxStates)) throw new Error('Invalid symbolic path');
    if (!strings(path.addressHistory, SYMBOLIC_LIMITS.maxAddressHistory, 64)) throw new Error('Invalid path address history');
    if (!Array.isArray(path.constraints) || path.constraints.length > SYMBOLIC_LIMITS.maxConstraintsPerPath) throw new Error('Invalid path constraints');
    for (const constraint of path.constraints) if (!record(constraint) || !text(constraint.expression, SYMBOLIC_LIMITS.maxConstraintChars) || !optionalText(constraint.address, 64)) throw new Error('Invalid symbolic constraint');
  }
  const pathIds = new Set<string>();
  for (const path of value.paths) {
    if (!record(path) || typeof path.id !== 'string') continue;
    if (pathIds.has(path.id)) throw new Error('Duplicate symbolic path id');
    pathIds.add(path.id);
  }
  for (const input of value.solvedInputs) {
    if (!record(input) || !text(input.pathId, 256) || !pathIds.has(input.pathId) || !value.paths.some(path => record(path) && path.id === input.pathId && path.reachedTarget === true) || !hex(input.inputHex) || !base64(input.inputBase64)) throw new Error('Invalid solved symbolic input');
    if (input.inputHex.length % 2 !== 0 || Buffer.from(input.inputHex, 'hex').toString('base64') !== input.inputBase64) throw new Error('Solved input encodings disagree');
    if (!record(input.execution) || !(input.execution.exitCode === null || integer(input.execution.exitCode, 0, 255)) || typeof input.execution.verified !== 'boolean' || typeof input.execution.timedOut !== 'boolean' || !optionalText(input.execution.stdout, 65_536) || !optionalText(input.execution.stderr, 65_536)) throw new Error('Invalid execution evidence');
  }
  if (!record(value.solver) || !text(value.solver.name, 128) || !text(value.solver.version, 128)) throw new Error('Invalid solver provenance');
  if (!record(value.stats) || !integer(value.stats.statesExplored, 0, SYMBOLIC_LIMITS.maxStates) || !integer(value.stats.pathsFound, 0, SYMBOLIC_LIMITS.maxPaths) || !integer(value.stats.elapsedMs, 0, SYMBOLIC_LIMITS.maxTimeoutMs)) throw new Error('Invalid symbolic statistics');
  if (value.stats.pathsFound !== value.paths.length) throw new Error('Path count is inconsistent');
  if (!strings(value.limitations, 256, 8_192)) throw new Error('Invalid limitations');
  if (!record(value.provenance)) throw new Error('Missing provenance');
  for (const field of ['binaryPath', 'binarySha256', 'workerSha256', 'pythonVersion', 'angrVersion', 'requestedAt', 'completedAt']) {
    if (!text(value.provenance[field], field === 'binaryPath' ? 4_096 : 512)) throw new Error(`Missing provenance.${field}`);
  }
  if (typeof value.provenance.binarySha256 !== 'string' || typeof value.provenance.workerSha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(value.provenance.binarySha256) || !/^[0-9a-f]{64}$/i.test(value.provenance.workerSha256)) throw new Error('Invalid provenance digest');
  if (optionalText(value.error, 16_384) === undefined) throw new Error('Invalid error field');
  if (JSON.stringify(value).length > maxOutputBytes) throw new Error('Symbolic result exceeds output budget');
  if (value.status === 'completed' && value.solvedInputs.some(input => !record(input.execution) || input.execution.verified !== true)) throw new Error('Completed analysis requires verified solved inputs');
  return value as unknown as SymbolicAnalysisResult;
}

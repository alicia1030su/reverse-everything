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

const PARTIAL_REASONS = new Set(['state-budget', 'path-budget', 'evidence-truncated', 'native-verification', 'output-budget']);
const PARTIAL_LIMITATION: Record<string, RegExp> = {
  'state-budget': /path\/state budget|exploration is not exhaustive/i,
  'path-budget': /path\/state budget|exploration is not exhaustive/i,
  'evidence-truncated': /constraint or address-history evidence was truncated/i,
  'native-verification': /one or more solved inputs did not reproduce/i,
  'output-budget': /response exceeded its budget|path records were omitted/i,
};

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
function optionalCount(value: unknown): value is number | undefined {
  return value === undefined || integer(value, 0, Number.MAX_SAFE_INTEGER);
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
    for (const constraint of path.constraints) if (!record(constraint) || !text(constraint.expression, SYMBOLIC_LIMITS.maxConstraintChars) || !optionalText(constraint.address, 64) || (constraint.truncated !== undefined && typeof constraint.truncated !== 'boolean')) throw new Error('Invalid symbolic constraint');
    for (const flag of ['constraintsTruncated', 'historyTruncated']) if (path[flag] !== undefined && typeof path[flag] !== 'boolean') throw new Error('Invalid symbolic truncation flag');
    for (const key of ['constraintCount', 'constraintsIncluded', 'constraintsOmitted', 'constraintChars', 'constraintCharsTotal', 'historyCount', 'historyIncluded', 'historyOmitted', 'historyChars', 'historyCharsTotal']) if (!optionalCount(path[key])) throw new Error(`Invalid symbolic truncation count: ${key}`);
    if (path.constraintsIncluded !== undefined && path.constraintsIncluded !== path.constraints.length) throw new Error('Included constraint count is inconsistent');
    if (path.historyIncluded !== undefined && path.historyIncluded !== path.addressHistory.length) throw new Error('Included history count is inconsistent');
    if (typeof path.constraintCount === 'number' && typeof path.constraintsIncluded === 'number' && typeof path.constraintsOmitted === 'number' && path.constraintCount !== path.constraintsIncluded + path.constraintsOmitted) throw new Error('Constraint omission count is inconsistent');
    if (typeof path.historyCount === 'number' && typeof path.historyIncluded === 'number' && typeof path.historyOmitted === 'number' && path.historyCount !== path.historyIncluded + path.historyOmitted) throw new Error('History omission count is inconsistent');
    if (value.status === 'completed' && (path.constraintsTruncated === true || path.historyTruncated === true || path.constraints.some(constraint => record(constraint) && constraint.truncated === true))) throw new Error('Completed analysis cannot contain truncated evidence');
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
    if (!record(input.execution) || !(input.execution.exitCode === null || integer(input.execution.exitCode, -255, 255)) || typeof input.execution.verified !== 'boolean' || typeof input.execution.timedOut !== 'boolean' || !optionalText(input.execution.stdout, 65_536) || !optionalText(input.execution.stderr, 65_536)) throw new Error('Invalid execution evidence');
    for (const flag of ['stdoutTruncated', 'stderrTruncated', 'outputLimitExceeded', 'terminatedBySignal']) if (input.execution[flag] !== undefined && typeof input.execution[flag] !== 'boolean') throw new Error('Invalid execution output limit evidence');
    if (typeof input.execution.exitCode === 'number' && input.execution.exitCode < 0 && input.execution.terminatedBySignal !== true) throw new Error('Negative native exit codes require terminatedBySignal evidence');
    if (input.execution.terminatedBySignal === true && input.execution.exitCode !== null && (typeof input.execution.exitCode !== 'number' || input.execution.exitCode >= 0)) throw new Error('Signalled native execution requires a null or negative exit code');
    if (input.execution.verified === true && (input.execution.timedOut === true || input.execution.outputLimitExceeded === true || input.execution.stdoutTruncated === true || input.execution.terminatedBySignal === true)) throw new Error('Truncated, signalled or timed-out execution cannot be verified');
  }
  if (!record(value.solver) || !text(value.solver.name, 128) || !text(value.solver.version, 128)) throw new Error('Invalid solver provenance');
  if (!record(value.stats) || !integer(value.stats.statesExplored, 0, SYMBOLIC_LIMITS.maxStates) || !integer(value.stats.pathsFound, 0, SYMBOLIC_LIMITS.maxPaths) || !integer(value.stats.elapsedMs, 0, SYMBOLIC_LIMITS.maxTimeoutMs)) throw new Error('Invalid symbolic statistics');
  if (value.stats.pathsFound !== value.paths.length) throw new Error('Path count is inconsistent');
  if (value.stats.maxStates !== undefined && !integer(value.stats.maxStates, 1, SYMBOLIC_LIMITS.maxStates)) throw new Error('Invalid symbolic maxStates');
  if (value.stats.maxPaths !== undefined && !integer(value.stats.maxPaths, 1, SYMBOLIC_LIMITS.maxPaths)) throw new Error('Invalid symbolic maxPaths');
  if (!optionalCount(value.stats.activeStates)) throw new Error('Invalid symbolic activeStates');
  if (!strings(value.limitations, 256, 8_192)) throw new Error('Invalid limitations');
  const partialReasons = value.partialReasons;
  if (value.outputBudgetExceeded !== undefined && typeof value.outputBudgetExceeded !== 'boolean') throw new Error('Invalid symbolic outputBudgetExceeded');
  if (partialReasons !== undefined && (!Array.isArray(partialReasons) || partialReasons.length > PARTIAL_REASONS.size || partialReasons.some(reason => typeof reason !== 'string' || !PARTIAL_REASONS.has(reason)) || new Set(partialReasons).size !== partialReasons.length)) throw new Error('Invalid symbolic partialReasons');
  if (value.status === 'partial' && (!Array.isArray(partialReasons) || partialReasons.length === 0)) throw new Error('Partial symbolic result requires explicit partialReasons');
  if (value.status !== 'partial' && Array.isArray(partialReasons) && partialReasons.length > 0) throw new Error('Only partial symbolic results may include partialReasons');
  const evidenceTruncated = value.paths.some(path => record(path) && (path.constraintsTruncated === true || path.historyTruncated === true || (Array.isArray(path.constraints) && path.constraints.some(constraint => record(constraint) && constraint.truncated === true))));
  const nativeUnverified = value.solvedInputs.some(input => record(input.execution) && input.execution.verified !== true);
  const stateBudget = typeof value.stats.maxStates === 'number' && typeof value.stats.activeStates === 'number' && value.stats.activeStates > 0 && (value.stats.statesExplored >= value.stats.maxStates || value.stats.activeStates > value.stats.maxStates - value.stats.statesExplored);
  const pathBudget = typeof value.stats.maxPaths === 'number' && value.paths.length >= value.stats.maxPaths;
  const outputBudget = value.outputBudgetExceeded === true;
  if (value.status === 'completed' && (evidenceTruncated || nativeUnverified || stateBudget || pathBudget || outputBudget)) throw new Error('Completed analysis cannot contain partial conditions');
  if (Array.isArray(partialReasons)) for (const reason of partialReasons) {
    const actual = reason === 'state-budget' ? stateBudget : reason === 'path-budget' ? pathBudget : reason === 'evidence-truncated' ? evidenceTruncated : reason === 'output-budget' ? outputBudget : nativeUnverified;
    if (!actual) throw new Error(`Symbolic partial reason does not match result evidence: ${reason}`);
    if (!value.limitations.some(item => typeof item === 'string' && PARTIAL_LIMITATION[reason]!.test(item))) throw new Error(`Symbolic partial reason lacks a matching limitation: ${reason}`);
  }
  if (!record(value.provenance)) throw new Error('Missing provenance');
  for (const field of ['binaryPath', 'binarySha256', 'workerSha256', 'pythonVersion', 'angrVersion', 'requestedAt', 'completedAt']) {
    if (!text(value.provenance[field], field === 'binaryPath' ? 4_096 : 512)) throw new Error(`Missing provenance.${field}`);
  }
  if (typeof value.provenance.binarySha256 !== 'string' || typeof value.provenance.workerSha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(value.provenance.binarySha256) || !/^[0-9a-f]{64}$/i.test(value.provenance.workerSha256)) throw new Error('Invalid provenance digest');
  if (!optionalText(value.provenance.binarySnapshotPath, 4_096)) throw new Error('Invalid binary snapshot provenance');
  if (optionalText(value.error, 16_384) === undefined) throw new Error('Invalid error field');
  if (JSON.stringify(value).length > maxOutputBytes) throw new Error('Symbolic result exceeds output budget');
  if (value.status === 'completed' && value.solvedInputs.some(input => !record(input.execution) || input.execution.verified !== true)) throw new Error('Completed analysis requires verified solved inputs');
  return value as unknown as SymbolicAnalysisResult;
}

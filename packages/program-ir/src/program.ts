import type { BasicBlockIr, EvidenceRef, FunctionIr, ProgramIr, ProgramStats } from './types.js';

export class ProgramIrError extends Error {
  constructor(message: string) { super(message); this.name = 'ProgramIrError'; }
}

export function requireRef<T extends { id: string }>(items: T[], id: string, label: string): T {
  const item = items.find(candidate => candidate.id === id);
  if (!item) throw new ProgramIrError(`Unknown ${label}: ${id}`);
  return item;
}

export function assertProgramIr(program: ProgramIr): void {
  if (program.schemaVersion !== 1) throw new ProgramIrError('Unsupported Program IR schema');
  const ids = new Map<string, number>();
  for (const collection of [program.functions, program.blocks, program.instructions, program.variables, program.calls, program.data, program.xrefs, program.evidence, program.hypotheses]) {
    for (const item of collection) {
      ids.set(item.id, (ids.get(item.id) ?? 0) + 1);
    }
  }
  for (const [id, count] of ids) if (count !== 1) throw new ProgramIrError(`Duplicate IR id: ${id}`);
  for (const fn of program.functions) {
    for (const id of fn.parameterIds) requireRef(program.variables, id, 'parameter');
    for (const id of fn.localIds) requireRef(program.variables, id, 'local variable');
    for (const id of fn.blockIds) requireRef(program.blocks, id, 'function block');
    for (const id of fn.calleeIds) requireRef(program.functions, id, 'callee');
    for (const id of fn.callerIds) requireRef(program.functions, id, 'caller');
    for (const id of fn.evidenceIds) requireRef(program.evidence, id, 'function evidence');
  }
  for (const block of program.blocks) {
    const fn = requireRef(program.functions, block.functionId, 'block function');
    if (!fn.blockIds.includes(block.id)) throw new ProgramIrError(`Block ${block.id} is not owned by function ${fn.id}`);
    for (const id of block.instructionIds) {
      const instruction = requireRef(program.instructions, id, 'block instruction');
      if (instruction.blockId !== block.id || instruction.functionId !== block.functionId) throw new ProgramIrError(`Instruction ${id} has inconsistent block ownership`);
    }
    for (const id of [...block.successorIds, ...block.predecessorIds]) {
      const target = requireRef(program.blocks, id, 'block edge');
      if (target.functionId !== block.functionId) throw new ProgramIrError(`Cross-function CFG edge: ${block.id} -> ${id}`);
    }
  }
  for (const instruction of program.instructions) {
    requireRef(program.functions, instruction.functionId, 'instruction function');
    const block = requireRef(program.blocks, instruction.blockId, 'instruction block');
    if (!block.instructionIds.includes(instruction.id)) throw new ProgramIrError(`Instruction ${instruction.id} is missing from its block`);
  }
  for (const call of program.calls) {
    const caller = requireRef(program.functions, call.callerId, 'caller');
    const callee = requireRef(program.functions, call.calleeId, 'callee');
    if (!caller.calleeIds.includes(callee.id) || !callee.callerIds.includes(caller.id)) throw new ProgramIrError(`Call ${call.id} has asymmetric graph edges`);
    if (call.instructionId !== undefined) {
      const instruction = requireRef(program.instructions, call.instructionId, 'call instruction');
      if (instruction.functionId !== caller.id) throw new ProgramIrError(`Call ${call.id} instruction belongs to another function`);
    }
  }
  for (const hypothesis of program.hypotheses) {
    requireRef(program.functions, hypothesis.functionId, 'hypothesis function');
    if (hypothesis.confidence < 0 || hypothesis.confidence > 1) throw new ProgramIrError(`Invalid confidence for ${hypothesis.id}`);
    for (const id of hypothesis.evidenceIds) requireRef(program.evidence, id, 'hypothesis evidence');
  }
}

export function programStats(program: ProgramIr): ProgramStats {
  return {
    functions: program.functions.length,
    internalFunctions: program.functions.filter(fn => !fn.external).length,
    externalFunctions: program.functions.filter(fn => fn.external).length,
    blocks: program.blocks.length,
    instructions: program.instructions.length,
    variables: program.variables.length,
    calls: program.calls.length,
    dataItems: program.data.length,
    xrefs: program.xrefs.length,
    hypotheses: program.hypotheses.length,
    decompiledFunctions: program.functions.filter(fn => fn.pseudocode !== undefined).length,
  };
}

export function functionById(program: ProgramIr, id: string): FunctionIr {
  return requireRef(program.functions, id, 'function');
}

export function blockById(program: ProgramIr, id: string): BasicBlockIr {
  return requireRef(program.blocks, id, 'basic block');
}

export function evidenceById(program: ProgramIr, ids: string[]): EvidenceRef[] {
  return ids.map(id => requireRef(program.evidence, id, 'evidence'));
}

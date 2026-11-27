import type { BasicBlockIr, EvidenceKind, EvidenceRef, FunctionIr, ProgramIr, ProgramStats } from './types.js';

export class ProgramIrError extends Error {
  constructor(message: string) { super(message); this.name = 'ProgramIrError'; }
}

export function requireRef<T extends { id: string }>(items: T[], id: string, label: string): T {
  const item = items.find(candidate => candidate.id === id);
  if (!item) throw new ProgramIrError(`Unknown ${label}: ${id}`);
  return item;
}

const evidenceKinds = new Set<EvidenceKind>(['EVIDENCE', 'INFERENCE', 'UNKNOWN', 'VERIFIED']);

export function assertProgramIr(program: ProgramIr, options: { allowPartial?: boolean } = {}): void {
  if (program.schemaVersion !== 1) throw new ProgramIrError('Unsupported Program IR schema');
  const partial = options.allowPartial === true;
  if (!program.id) throw new ProgramIrError('Program id is required');
  if (!partial && !program.provenance) throw new ProgramIrError('Program provenance is required');
  if (program.provenance) {
    const provenance = program.provenance;
    if (!/^[a-f0-9]{64}$/i.test(provenance.inputSha256 ?? '')) throw new ProgramIrError('Program inputSha256 is invalid');
    if (!provenance.analyzer || !provenance.analyzerVersion || !provenance.environment) throw new ProgramIrError('Program analyzer provenance is incomplete');
    if (!provenance.generatedAt || !Number.isFinite(Date.parse(provenance.generatedAt))) throw new ProgramIrError('Program generatedAt is invalid');
    if (provenance.commit !== undefined && !/^[a-f0-9]{40}$/i.test(provenance.commit)) throw new ProgramIrError('Program commit is invalid');
  }
  const ids = new Map<string, number>();
  for (const collection of [program.functions, program.blocks, program.instructions, program.variables, program.calls, program.data, program.xrefs, program.evidence, program.hypotheses]) {
    for (const item of collection) ids.set(item.id, (ids.get(item.id) ?? 0) + 1);
  }
  for (const [id, count] of ids) if (count !== 1) throw new ProgramIrError(`Duplicate IR id: ${id}`);
  if (!program.modules.length) throw new ProgramIrError('At least one module is required');
  for (const module of program.modules) for (const id of module.evidenceIds) requireRef(program.evidence, id, 'module evidence');
  for (const evidence of program.evidence) if (!evidenceKinds.has(evidence.kind) || !evidence.source || !evidence.locator || !evidence.summary) throw new ProgramIrError(`Invalid evidence record: ${evidence.id}`);
  for (const fn of program.functions) {
    if (!fn.id || !fn.name || !fn.entry || !fn.bodyStart) throw new ProgramIrError('Function identity fields are incomplete');
    if (!partial && !fn.external && fn.blockIds.length === 0) throw new ProgramIrError(`Internal function ${fn.id} has no control-flow blocks`);
    for (const id of fn.parameterIds) { const variable = requireRef(program.variables, id, 'parameter'); if (variable.functionId !== fn.id || variable.kind !== 'parameter') throw new ProgramIrError(`Parameter ${id} has inconsistent ownership`); }
    for (const id of fn.localIds) { const variable = requireRef(program.variables, id, 'local variable'); if (variable.functionId !== fn.id || variable.kind !== 'local') throw new ProgramIrError(`Local variable ${id} has inconsistent ownership`); }
    for (const id of fn.blockIds) { const block = requireRef(program.blocks, id, 'function block'); if (block.functionId !== fn.id) throw new ProgramIrError(`Block ${id} has inconsistent function ownership`); }
    for (const id of fn.calleeIds) requireRef(program.functions, id, 'callee');
    for (const id of fn.callerIds) requireRef(program.functions, id, 'caller');
    for (const id of fn.evidenceIds) requireRef(program.evidence, id, 'function evidence');
  }
  for (const variable of program.variables) {
    if (variable.functionId !== null) requireRef(program.functions, variable.functionId, 'variable function');
    if (variable.kind === 'global' && variable.functionId !== null) throw new ProgramIrError(`Global variable ${variable.id} cannot belong to a function`);
    for (const id of variable.evidenceIds) requireRef(program.evidence, id, 'variable evidence');
  }
  for (const block of program.blocks) {
    const fn = requireRef(program.functions, block.functionId, 'block function');
    if (!fn.blockIds.includes(block.id)) throw new ProgramIrError(`Block ${block.id} is not owned by function ${fn.id}`);
    if (!partial && block.instructionIds.length === 0) throw new ProgramIrError(`Block ${block.id} has no instructions`);
    for (const id of block.evidenceIds) requireRef(program.evidence, id, 'block evidence');
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
    if (!partial && instruction.pcodeStatus === 'available' && (!instruction.pcode || instruction.pcode.length === 0)) throw new ProgramIrError(`Instruction ${instruction.id} has no P-Code evidence`);
    if (!partial && instruction.pcodeStatus === 'unavailable') {
      if (!program.limitations.some(item => item.includes('P-Code was unavailable'))) throw new ProgramIrError(`Instruction ${instruction.id} has undisclosed unavailable P-Code`);
      if (!instruction.evidenceIds.some(id => program.evidence.find(item => item.id === id)?.kind === 'UNKNOWN')) throw new ProgramIrError(`Instruction ${instruction.id} lacks UNKNOWN P-Code evidence`);
    }
    for (const id of instruction.evidenceIds) requireRef(program.evidence, id, 'instruction evidence');
  }
  for (const call of program.calls) {
    const caller = requireRef(program.functions, call.callerId, 'caller');
    const callee = requireRef(program.functions, call.calleeId, 'callee');
    if (!caller.calleeIds.includes(callee.id) || !callee.callerIds.includes(caller.id)) throw new ProgramIrError(`Call ${call.id} has asymmetric graph edges`);
    for (const id of call.evidenceIds) requireRef(program.evidence, id, 'call evidence');
    if (call.instructionId !== undefined) {
      const instruction = requireRef(program.instructions, call.instructionId, 'call instruction');
      if (instruction.functionId !== caller.id) throw new ProgramIrError(`Call ${call.id} instruction belongs to another function`);
      if (call.address !== undefined && call.address !== instruction.address) throw new ProgramIrError(`Call ${call.id} address does not match its instruction`);
    } else if (!partial && call.address !== undefined) throw new ProgramIrError(`Call ${call.id} has an address but no instruction anchor`);
  }
  for (const item of program.data) for (const id of item.evidenceIds) requireRef(program.evidence, id, 'data evidence');
  for (const xref of program.xrefs) {
    if (xref.functionId !== null) requireRef(program.functions, xref.functionId, 'xref function');
    for (const id of xref.evidenceIds) requireRef(program.evidence, id, 'xref evidence');
  }
  for (const hypothesis of program.hypotheses) {
    requireRef(program.functions, hypothesis.functionId, 'hypothesis function');
    if (hypothesis.confidence < 0 || hypothesis.confidence > 1) throw new ProgramIrError(`Invalid confidence for ${hypothesis.id}`);
    if (hypothesis.kindEvidence !== 'INFERENCE' && hypothesis.kindEvidence !== 'UNKNOWN') throw new ProgramIrError(`Hypothesis ${hypothesis.id} cannot be promoted to fact`);
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

export function functionById(program: ProgramIr, id: string): FunctionIr { return requireRef(program.functions, id, 'function'); }
export function blockById(program: ProgramIr, id: string): BasicBlockIr { return requireRef(program.blocks, id, 'basic block'); }
export function evidenceById(program: ProgramIr, ids: string[]): EvidenceRef[] { return ids.map(id => requireRef(program.evidence, id, 'evidence')); }

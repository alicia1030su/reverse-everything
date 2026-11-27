import { createHash } from 'node:crypto';
import type { BasicBlockIr, CallSiteIr, DataItemIr, EvidenceRef, FunctionIr, InstructionIr, ProgramIr, ProgramProvenance, VariableIr, XrefIr } from './types.js';

export interface GhidraInstructionInput { address: string; mnemonic: string; bytes?: string; pcode?: string[] }
export interface GhidraBlockInput { start: string; end: string; successors: string[]; predecessors?: string[]; instructions?: GhidraInstructionInput[] }
export interface GhidraVariableInput { name: string; dataType: string; kind: 'parameter' | 'local' | 'global'; storage?: string; parameterIndex?: number }
export interface GhidraFunctionInput {
  name: string; entry: string; body: string; thunk: boolean; external: boolean;
  signature?: string; callingConvention?: string; returnType?: string;
  parameters?: GhidraVariableInput[]; locals?: GhidraVariableInput[]; blocks?: GhidraBlockInput[];
}
export interface GhidraCallInput { caller: string; callee: string; callerEntry?: string; calleeEntry?: string; address?: string; instructionAddress?: string }
export interface GhidraStringReferenceInput { address: string; function: string | null; functionEntry?: string; value: string }
export interface GhidraProgramInput {
  format: string; architecture: string; compilerSpec: string; imageBase: string;
  functions: GhidraFunctionInput[]; decompiledFunctions: Array<{ name: string; entry: string; pseudocode: string }>;
  calls: GhidraCallInput[]; strings: string[]; stringReferences: GhidraStringReferenceInput[];
  globals?: GhidraVariableInput[]; xrefs?: Array<{ from: string; to: string; type: string; function?: string; functionEntry?: string }>;
  truncated?: boolean; limitations?: string[]; provenance?: ProgramProvenance;
}

function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }
/** Normalizes hexadecimal addresses without merging named/external address spaces. */
function address(value: string): string {
  const trimmed = value.trim();
  return /^0x[0-9a-f]+$/i.test(trimmed) ? `0x${trimmed.slice(2).toLowerCase().replace(/^0+(?=\d)/, '')}` : trimmed;
}
function fnId(scope: string, entry: string): string { return `fn:${scope}:${entry}`; }
function blockId(functionId: string, start: string): string { return `block:${functionId.slice(3)}:${start}`; }
function instructionId(functionId: string, at: string): string { return `ins:${functionId.slice(3)}:${at}`; }
function evidenceId(scope: string): string { return `ev:${digest(scope).slice(0, 24)}`; }

/** Converts bounded Ghidra observations into a queryable IR. Missing structure stays missing. */
export function ghidraMetadataToProgram(metadata: GhidraProgramInput, id = `ghidra:${digest(JSON.stringify(metadata)).slice(0, 24)}`): ProgramIr {
  const scope = digest(id).slice(0, 16);
  const functions: FunctionIr[] = [];
  const variables: VariableIr[] = [];
  const blocks: BasicBlockIr[] = [];
  const instructions: InstructionIr[] = [];
  const data: DataItemIr[] = [];
  const xrefs: XrefIr[] = [];
  const evidence: EvidenceRef[] = [];
  const limitations = new Set(metadata.limitations ?? []);
  const byEntry = new Map<string, FunctionIr>();
  const byName = new Map<string, FunctionIr[]>();
  const pseudocode = new Map(metadata.decompiledFunctions.map(item => [address(item.entry), item.pseudocode]));
  const moduleId = `module:${scope}:native`;
  const variableIds = new Set<string>();
  const blockIds = new Set<string>();
  const instructionIds = new Set<string>();
  const dataIds = new Set<string>();
  const xrefIds = new Set<string>();
  const evidenceIds = new Set<string>();
  const addEvidence = (item: EvidenceRef): void => {
    if (evidenceIds.has(item.id)) throw new Error(`Duplicate evidence id: ${item.id}`);
    evidenceIds.add(item.id); evidence.push(item);
  };

  for (const raw of metadata.functions) {
    const entry = address(raw.entry);
    if (byEntry.has(entry)) throw new Error(`Duplicate Ghidra function entry: ${entry}`);
    const functionEvidenceId = evidenceId(`${id}:function:${entry}`);
    const bodyless = raw.blocks !== undefined && raw.blocks.length === 0 && !raw.external;
    if (bodyless) limitations.add(`Ghidra function ${raw.name} at ${entry} has no analyzable control-flow blocks and was classified as external/unanalyzed`);
    const fn: FunctionIr = {
      id: fnId(scope, entry), name: raw.name, entry, bodyStart: address(raw.body), thunk: raw.thunk, external: raw.external || bodyless,
      parameterIds: [], localIds: [], blockIds: [], calleeIds: [], callerIds: [], evidenceIds: [functionEvidenceId],
      ...(raw.signature !== undefined ? { signature: raw.signature } : {}),
      ...(raw.callingConvention !== undefined ? { callingConvention: raw.callingConvention } : {}),
      ...(raw.returnType !== undefined ? { returnType: raw.returnType } : {}),
      ...(pseudocode.has(entry) ? { pseudocode: pseudocode.get(entry)! } : {}),
    };
    functions.push(fn); byEntry.set(entry, fn); byName.set(raw.name, [...(byName.get(raw.name) ?? []), fn]);
    addEvidence({ id: functionEvidenceId, kind: 'EVIDENCE', source: 'ghidra', locator: `function:${entry}`, summary: `Ghidra identified function ${raw.name} at ${entry}` });
    const functionVariables = [
      ...(raw.parameters ?? []).map((item, position) => ({ item, position })),
      ...(raw.locals ?? []).map(item => ({ item, position: undefined as number | undefined })),
    ];
    for (const [index, variable] of functionVariables.slice(0, 4096).entries()) {
      const variableId = `var:${digest(`${fn.id}:${variable.item.kind}:${variable.item.name}:${variable.position ?? index}`).slice(0, 24)}`;
      if (variableIds.has(variableId)) throw new Error(`Duplicate variable identity in ${fn.id}: ${variable.item.name}`);
      variableIds.add(variableId);
      const variableEvidenceId = evidenceId(`${id}:variable:${variableId}`);
      variables.push({ id: variableId, functionId: fn.id, name: variable.item.name, kind: variable.item.kind, dataType: variable.item.dataType, evidenceIds: [variableEvidenceId], ...(variable.item.storage !== undefined ? { storage: variable.item.storage } : {}), ...(variable.position !== undefined ? { parameterIndex: variable.position } : {}) });
      addEvidence({ id: variableEvidenceId, kind: 'EVIDENCE', source: 'ghidra', locator: `variable:${fn.id}:${variable.item.name}`, summary: `Ghidra identified ${variable.item.kind} ${variable.item.name} in ${fn.name}` });
      (variable.item.kind === 'parameter' ? fn.parameterIds : fn.localIds).push(variableId);
    }
    for (const rawBlock of raw.blocks ?? []) {
      const start = address(rawBlock.start); const bId = blockId(fn.id, start);
      if (blockIds.has(bId)) throw new Error(`Duplicate basic block identity: ${bId}`);
      blockIds.add(bId);
      const blockEvidenceId = evidenceId(`${id}:block:${bId}`);
      const block: BasicBlockIr = { id: bId, functionId: fn.id, start, end: address(rawBlock.end), instructionIds: [], successorIds: [], predecessorIds: [], evidenceIds: [blockEvidenceId] };
      addEvidence({ id: blockEvidenceId, kind: 'EVIDENCE', source: 'ghidra', locator: `block:${bId}`, summary: `Ghidra identified basic block ${start}-${address(rawBlock.end)} in ${fn.name}` });
      for (const rawInstruction of rawBlock.instructions ?? []) {
        const at = address(rawInstruction.address); const iId = instructionId(fn.id, at);
        if (instructionIds.has(iId)) throw new Error(`Duplicate instruction identity: ${iId}`);
        instructionIds.add(iId);
        const instructionEvidenceId = evidenceId(`${id}:instruction:${iId}`);
        instructions.push({ id: iId, functionId: fn.id, blockId: bId, address: at, mnemonic: rawInstruction.mnemonic, evidenceIds: [instructionEvidenceId], ...(rawInstruction.bytes !== undefined ? { bytes: rawInstruction.bytes } : {}), ...(rawInstruction.pcode !== undefined ? { pcode: rawInstruction.pcode.slice(0, 256) } : {}) });
        addEvidence({ id: instructionEvidenceId, kind: 'EVIDENCE', source: 'ghidra', locator: `instruction:${iId}`, summary: `Ghidra decoded ${rawInstruction.mnemonic} at ${at} in ${fn.name}` });
        block.instructionIds.push(iId);
      }
      blocks.push(block); fn.blockIds.push(bId);
    }
  }
  const blockLookup = new Map(blocks.map(block => [block.id, block]));
  for (const raw of metadata.functions) for (const rawBlock of raw.blocks ?? []) {
    const fn = byEntry.get(address(raw.entry))!; const block = blockLookup.get(blockId(fn.id, address(rawBlock.start)))!;
    const resolveBlock = (value: string): string | null => {
      const at = address(value);
      const exactStart = fn.blockIds.find(candidate => blockLookup.get(candidate)?.start === at);
      if (exactStart) return exactStart;
      if (at === block.end) return block.id;
      limitations.add(`CFG target ${value} in ${fn.name} did not resolve to a block in the same function`);
      return null;
    };
    block.successorIds = rawBlock.successors.map(resolveBlock).filter((value): value is string => value !== null);
    block.predecessorIds = (rawBlock.predecessors ?? []).map(resolveBlock).filter((value): value is string => value !== null);
  }
  for (const block of blocks) for (const successor of block.successorIds) {
    const target = blockLookup.get(successor);
    if (target?.functionId !== block.functionId) throw new Error(`Cross-function CFG edge is not representable: ${block.id} -> ${successor}`);
    if (target && !target.predecessorIds.includes(block.id)) target.predecessorIds.push(block.id);
  }

  const unresolvedFunctions = new Map<string, FunctionIr>();
  const unresolved = (name: string, role: 'caller' | 'callee'): FunctionIr => {
    const key = `${role}:${name}`; const existing = unresolvedFunctions.get(key); if (existing) return existing;
    const entry = `unresolved:${role}:${name}`; const eId = evidenceId(`${id}:unresolved:${key}`);
    const fn: FunctionIr = { id: fnId(scope, entry), name, entry, bodyStart: entry, thunk: false, external: true, parameterIds: [], localIds: [], blockIds: [], calleeIds: [], callerIds: [], evidenceIds: [eId] };
    functions.push(fn); unresolvedFunctions.set(key, fn);
    addEvidence({ id: eId, kind: 'UNKNOWN', source: 'ghidra', locator: `unresolved:${key}`, summary: `Ghidra reported ${role} name ${name} without an unambiguous function address` });
    limitations.add(`Call ${role} ${name} had no address and was not bound to an internal function`);
    return fn;
  };
  const resolveFunction = (name: string, entry?: string, role: 'caller' | 'callee' = 'callee'): FunctionIr => {
    if (entry !== undefined) {
      const exact = byEntry.get(address(entry));
      if (!exact) throw new Error(`Ghidra call references unknown ${role} entry: ${entry}`);
      return exact;
    }
    const matches = byName.get(name) ?? [];
    if (matches.length === 1 && matches[0]!.external) return matches[0]!;
    return unresolved(name, role);
  };
  const calls: CallSiteIr[] = [];
  for (const [index, raw] of metadata.calls.slice(0, 10_000).entries()) {
    const caller = resolveFunction(raw.caller, raw.callerEntry, 'caller'); const callee = resolveFunction(raw.callee, raw.calleeEntry, 'callee');
    if (!caller.calleeIds.includes(callee.id)) caller.calleeIds.push(callee.id);
    if (!callee.callerIds.includes(caller.id)) callee.callerIds.push(caller.id);
    const callAddress = raw.address === undefined ? undefined : address(raw.address);
    const instructionAddress = raw.instructionAddress === undefined ? callAddress : address(raw.instructionAddress);
    const cId = `call:${digest(`${caller.id}->${callee.id}:${callAddress ?? instructionAddress ?? `site:${index}`}`).slice(0, 24)}`;
    const eId = evidenceId(`${id}:call:${cId}`);
    const linkedInstruction = instructionAddress === undefined ? undefined : instructions.find(item => item.functionId === caller.id && item.address === instructionAddress);
    calls.push({ id: cId, callerId: caller.id, calleeId: callee.id, evidenceIds: [eId], ...(callAddress !== undefined ? { address: callAddress } : {}), ...(linkedInstruction ? { instructionId: linkedInstruction.id } : {}) });
    if (callAddress === undefined && instructionAddress === undefined) limitations.add('One or more Ghidra call sites had no address; stable record order was used for identity');
    addEvidence({ id: eId, kind: 'EVIDENCE', source: 'ghidra', locator: `call:${callAddress ?? instructionAddress ?? `site:${index}`}`, summary: `Call edge ${raw.caller} -> ${raw.callee}` });
  }
  for (const raw of metadata.globals ?? []) {
    const variableId = `var:${digest(`global:${raw.name}:${raw.storage ?? ''}`).slice(0, 24)}`; const eId = evidenceId(`${id}:global:${variableId}`);
    if (variableIds.has(variableId)) throw new Error(`Duplicate global variable identity: ${raw.name}`);
    variableIds.add(variableId);
    variables.push({ id: variableId, functionId: null, name: raw.name, kind: 'global', dataType: raw.dataType, evidenceIds: [eId], ...(raw.storage !== undefined ? { storage: raw.storage } : {}) });
    addEvidence({ id: eId, kind: 'EVIDENCE', source: 'ghidra', locator: `global:${raw.storage ?? raw.name}`, summary: `Ghidra identified global ${raw.name}` });
  }
  for (const raw of metadata.stringReferences.slice(0, 5000)) {
    const at = address(raw.address); const dId = `data:${at}`; const eId = evidenceId(`${id}:string:${at}:${raw.function ?? ''}:${digest(raw.value).slice(0, 12)}`);
    const existing = data.find(item => item.id === dId);
    if (!existing) { data.push({ id: dId, address: at, kind: 'string', value: raw.value, evidenceIds: [eId] }); dataIds.add(dId); }
    else if (!existing.evidenceIds.includes(eId)) existing.evidenceIds.push(eId);
    if (existing && existing.value !== raw.value) limitations.add(`Conflicting string values were reported at ${at}; the first value was retained`);
    if (!evidenceIds.has(eId)) addEvidence({ id: eId, kind: 'EVIDENCE', source: 'ghidra', locator: `xref:${at}:${raw.function ?? 'unknown'}`, summary: `String ${JSON.stringify(raw.value.slice(0, 120))} referenced by ${raw.function ?? 'unknown function'}` });
    if (raw.function !== null) {
      const fn = raw.functionEntry === undefined ? undefined : byEntry.get(address(raw.functionEntry));
      if (!fn) { limitations.add(`String reference at ${at} had no exact function entry and was not bound`); continue; }
      const xId = `xref:${digest(`${fn.id}:${at}:string-reference`).slice(0, 24)}`;
      if (!xrefIds.has(xId)) { xrefIds.add(xId); xrefs.push({ id: xId, from: fn.entry, to: at, type: 'string-reference', functionId: fn.id, evidenceIds: [eId] }); }
    }
  }
  for (const raw of metadata.xrefs ?? []) {
    const from = address(raw.from); const to = address(raw.to); const fn = raw.functionEntry === undefined ? undefined : byEntry.get(address(raw.functionEntry));
    if (raw.function && !fn) limitations.add(`Cross-reference ${from}->${to} had no exact function entry and was not bound`);
    const eId = evidenceId(`${id}:xref:${from}:${to}:${raw.type}:${fn?.id ?? ''}`);
    const xId = `xref:${digest(`${from}:${to}:${raw.type}:${fn?.id ?? ''}`).slice(0, 24)}`;
    if (!xrefIds.has(xId)) { xrefIds.add(xId); xrefs.push({ id: xId, from, to, type: raw.type, functionId: fn?.id ?? null, evidenceIds: [eId] }); }
    if (!evidenceIds.has(eId)) addEvidence({ id: eId, kind: 'EVIDENCE', source: 'ghidra', locator: `xref:${from}->${to}`, summary: `${raw.type} cross-reference` });
  }
  if (!blocks.length) limitations.add('Ghidra export did not contain control-flow blocks');
  if (!instructions.length) limitations.add('Ghidra export did not contain instruction or P-Code records');
  if (!variables.length) limitations.add('Ghidra export did not contain parameter, local or global variables');
  if (metadata.truncated) limitations.add('Source Ghidra metadata was truncated');
  return { schemaVersion: 1, id, ...(metadata.provenance ? { provenance: metadata.provenance } : {}), format: metadata.format, architecture: metadata.architecture, compilerSpec: metadata.compilerSpec, imageBase: address(metadata.imageBase), modules: [{ id: moduleId, name: id, evidenceIds: [] }], functions, blocks, instructions, variables, calls, data, xrefs, evidence, hypotheses: [], limitations: [...limitations] };
}

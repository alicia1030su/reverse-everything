import { createHash } from 'node:crypto';
import { assertProgramIr, type BasicBlockIr, type FunctionIr, type InstructionIr, type ProgramIr } from '@reverse/program-ir';
import type {
  BinaryDiffEvidence,
  BinaryDiffOptions,
  BinaryDiffStatus,
  BinaryIdentity,
  FunctionChange,
  FunctionFingerprint,
  FunctionMatch,
  FunctionMatchMethod,
  ProgramBinaryDiffReport,
} from './types.js';

const DEFAULT_MAX_FUNCTIONS = 5000;
const DEFAULT_MIN_SIMILARITY = 0.55;
const DEFAULT_MAX_CHANGES = 200;
const TOP_CANDIDATES = 4;

interface ProgramIndex {
  program: ProgramIr;
  functions: Map<string, FunctionIr>;
  blocks: Map<string, BasicBlockIr>;
  instructions: Map<string, InstructionIr>;
}

interface Features {
  fn: FunctionIr;
  fingerprint: FunctionFingerprint;
  mnemonicTokens: string[];
  byteTokens: string[];
  pcodeTokens: string[];
  callNames: string[];
  callSequence: string[];
  dataValues: string[];
  signatureTokens: string[];
  cfgEdges: string[];
  variableTokens: string[];
}

interface Candidate {
  before: Features;
  after: Features;
  score: number;
  method: FunctionMatchMethod;
}

function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeCode(value: string, addresses: ReadonlySet<string> = new Set()): string {
  return value
    .replace(/0x[0-9a-f]+/gi, token => addresses.has(token.toLowerCase()) ? '0xADDR' : token)
    .replace(/\b(?:fn|block|insn|var):[^\s,;]+/gi, 'ID')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(values: string[], addresses: ReadonlySet<string> = new Set()): string[] {
  return values.flatMap(value => normalizeCode(value, addresses).toLowerCase().split(/[^a-z0-9_@]+/).filter(Boolean));
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function dice(left: string[], right: string[]): number {
  if (!left.length && !right.length) return 1;
  if (!left.length || !right.length) return 0;
  const counts = new Map<string, number>();
  for (const value of left) counts.set(value, (counts.get(value) ?? 0) + 1);
  let intersection = 0;
  for (const value of right) {
    const count = counts.get(value) ?? 0;
    if (count > 0) { intersection++; counts.set(value, count - 1); }
  }
  return (2 * intersection) / (left.length + right.length);
}

function jaccard(left: string[], right: string[]): number {
  const a = new Set(left); const b = new Set(right);
  if (!a.size && !b.size) return 1;
  let intersection = 0;
  for (const value of a) if (b.has(value)) intersection++;
  const union = a.size + b.size - intersection;
  return union ? intersection / union : 1;
}

function indexProgram(program: ProgramIr): ProgramIndex {
  return {
    program,
    functions: new Map(program.functions.map(fn => [fn.id, fn])),
    blocks: new Map(program.blocks.map(block => [block.id, block])),
    instructions: new Map(program.instructions.map(instruction => [instruction.id, instruction])),
  };
}

function orderedInstructions(index: ProgramIndex, fn: FunctionIr): InstructionIr[] {
  const seen = new Set<string>();
  const result: InstructionIr[] = [];
  for (const blockId of fn.blockIds) {
    const block = index.blocks.get(blockId);
    for (const instructionId of block?.instructionIds ?? []) {
      if (seen.has(instructionId)) continue;
      seen.add(instructionId);
      const instruction = index.instructions.get(instructionId);
      if (instruction) result.push(instruction);
    }
  }
  return result;
}

function functionDataValues(index: ProgramIndex, fn: FunctionIr): string[] {
  const addresses = new Set(index.program.xrefs.filter(xref => xref.functionId === fn.id).map(xref => xref.to));
  return index.program.data.filter(item => addresses.has(item.address)).map(item => item.value ?? `${item.kind}:${item.size ?? 0}`).sort();
}

function buildFeatures(index: ProgramIndex, fn: FunctionIr): Features {
  const instructions = orderedInstructions(index, fn);
  const blocks = fn.blockIds.map(id => index.blocks.get(id)).filter((block): block is BasicBlockIr => block !== undefined);
  const blockOrder = new Map(blocks.map((block, position) => [block.id, position]));
  const cfgEdges = uniqueSorted(blocks.flatMap(block => block.successorIds.flatMap(target => {
    const source = blockOrder.get(block.id); const destination = blockOrder.get(target);
    return source === undefined || destination === undefined ? [] : [`${source}->${destination}`];
  })));
  const mnemonicTokens = instructions.map(instruction => instruction.mnemonic.toLowerCase());
  const byteTokens = instructions.map(instruction => (instruction.bytes ?? '').replace(/[^a-f0-9]/gi, '').toLowerCase()).filter(Boolean);
  const addresses = new Set<string>([
    ...index.program.functions.flatMap(item => [item.entry, item.bodyStart]),
    ...index.program.blocks.flatMap(item => [item.start, item.end]),
    ...index.program.instructions.map(item => item.address),
    ...index.program.data.map(item => item.address),
  ].map(value => value.toLowerCase()));
  const pcodeTokens = tokens(instructions.flatMap(instruction => instruction.pcode ?? []), addresses);
  const callNames = uniqueSorted(fn.calleeIds.map(id => index.functions.get(id)?.name ?? id).map(value => normalizeCode(value)));
  const addressValue = (value: string | undefined): bigint => { try { return BigInt(value ?? '0x0'); } catch { return 0n; } };
  const callSequence = index.program.calls.filter(call => call.callerId === fn.id).sort((left, right) => {
    const a = addressValue(left.address); const b = addressValue(right.address);
    return a < b ? -1 : a > b ? 1 : left.id.localeCompare(right.id);
  }).map(call => normalizeCode(index.functions.get(call.calleeId)?.name ?? call.calleeId));
  const dataValues = uniqueSorted(functionDataValues(index, fn));
  const signatureTokens = tokens([fn.signature ?? '', fn.callingConvention ?? '', fn.returnType ?? ''].filter(Boolean));
  const variableTokens = uniqueSorted([...fn.parameterIds, ...fn.localIds].flatMap(id => {
    const variable = index.program.variables.find(item => item.id === id);
    return variable ? [`${variable.name}:${variable.dataType}`] : [];
  }));
  const fingerprint: FunctionFingerprint = {
    mnemonicSha256: sha(mnemonicTokens.join('\n')),
    bytesSha256: sha(byteTokens.join('\n')),
    pcodeSha256: instructions.some(instruction => instruction.pcode !== undefined) ? sha(pcodeTokens.join('\n')) : null,
    cfgSha256: sha(cfgEdges.join('\n')),
    callsSha256: sha(callNames.join('\n')),
    callSequenceSha256: sha(callSequence.join('\n')),
    dataSha256: sha(dataValues.join('\n')),
    signatureSha256: fn.signature ? sha(normalizeCode(fn.signature)) : null,
    combinedSha256: sha([mnemonicTokens.join('\n'), byteTokens.join('\n'), pcodeTokens.join('\n'), cfgEdges.join('\n'), callNames.join('\n'), callSequence.join('\n'), dataValues.join('\n')].join('\n---\n')),
    instructionCount: instructions.length,
    blockCount: blocks.length,
    edgeCount: cfgEdges.length,
    completeInstructionDetail: instructions.length === 0 || instructions.every(instruction => Boolean(instruction.bytes?.replace(/[^a-f0-9]/gi, '')) || Boolean(instruction.pcode?.length)),
  };
  return { fn, fingerprint, mnemonicTokens, byteTokens, pcodeTokens, callNames, callSequence, dataValues, signatureTokens, cfgEdges, variableTokens };
}

function similarity(before: Features, after: Features): number {
  const mnemonic = dice(before.mnemonicTokens, after.mnemonicTokens);
  const bytes = dice(before.byteTokens, after.byteTokens);
  const pcode = dice(before.pcodeTokens, after.pcodeTokens);
  const cfg = 0.45 * jaccard(before.cfgEdges, after.cfgEdges) + 0.25 * dice(before.cfgEdges, after.cfgEdges) + 0.2 * jaccard([String(before.fingerprint.blockCount)], [String(after.fingerprint.blockCount)]) + 0.1 * jaccard([String(before.fingerprint.edgeCount)], [String(after.fingerprint.edgeCount)]);
  const calls = 0.5 * jaccard(before.callNames, after.callNames) + 0.5 * dice(before.callSequence, after.callSequence);
  const data = jaccard(before.dataValues, after.dataValues);
  const signature = dice(before.signatureTokens, after.signatureTokens);
  return Math.max(0, Math.min(1, 0.27 * mnemonic + 0.18 * bytes + 0.2 * pcode + 0.2 * cfg + 0.08 * calls + 0.04 * data + 0.03 * signature));
}

function identity(program: ProgramIr): BinaryIdentity {
  return {
    id: program.id,
    format: program.format,
    architecture: program.architecture,
    inputSha256: program.provenance?.inputSha256 ?? null,
    analyzer: program.provenance?.analyzer ?? null,
    analyzerVersion: program.provenance?.analyzerVersion ?? null,
  };
}

function setDiff(before: string[], after: string[]): { removed: string[]; added: string[] } {
  const a = new Set(before); const b = new Set(after);
  return { removed: [...a].filter(value => !b.has(value)).sort(), added: [...b].filter(value => !a.has(value)).sort() };
}

function changesFor(before: Features, after: Features, maxChanges: number): FunctionChange[] {
  const changes: FunctionChange[] = [];
  const add = (kind: FunctionChange['kind'], left: unknown, right: unknown) => {
    if (JSON.stringify(left) === JSON.stringify(right)) return;
    if (changes.length < maxChanges) changes.push({ kind, before: left, after: right });
  };
  add('name', before.fn.name, after.fn.name);
  add('entry', before.fn.entry, after.fn.entry);
  add('signature', before.fn.signature ?? null, after.fn.signature ?? null);
  add('calling-convention', before.fn.callingConvention ?? null, after.fn.callingConvention ?? null);
  add('return-type', before.fn.returnType ?? null, after.fn.returnType ?? null);
  add('blocks', before.fingerprint.blockCount, after.fingerprint.blockCount);
  add('instructions', { count: before.fingerprint.instructionCount, mnemonicSha256: before.fingerprint.mnemonicSha256, bytesSha256: before.fingerprint.bytesSha256 }, { count: after.fingerprint.instructionCount, mnemonicSha256: after.fingerprint.mnemonicSha256, bytesSha256: after.fingerprint.bytesSha256 });
  const calls = setDiff(before.callNames, after.callNames);
  if (calls.removed.length || calls.added.length || JSON.stringify(before.callSequence) !== JSON.stringify(after.callSequence)) add('calls', { removed: calls.removed, added: calls.added, sequenceBefore: before.callSequence, sequenceAfter: after.callSequence }, { removed: calls.added, added: calls.removed, sequenceBefore: after.callSequence, sequenceAfter: before.callSequence });
  const data = setDiff(before.dataValues, after.dataValues);
  if (data.removed.length || data.added.length) add('data', data.removed, data.added);
  const cfg = setDiff(before.cfgEdges, after.cfgEdges);
  if (cfg.removed.length || cfg.added.length) add('cfg', cfg.removed, cfg.added);
  add('pcode', before.fingerprint.pcodeSha256, after.fingerprint.pcodeSha256);
  const variables = setDiff(before.variableTokens, after.variableTokens);
  if (variables.removed.length || variables.added.length) add('variables', variables.removed, variables.added);
  return changes;
}

function toMatch(candidate: Candidate, maxChanges: number): FunctionMatch {
  return {
    beforeId: candidate.before.fn.id,
    afterId: candidate.after.fn.id,
    beforeName: candidate.before.fn.name,
    afterName: candidate.after.fn.name,
    beforeEntry: candidate.before.fn.entry,
    afterEntry: candidate.after.fn.entry,
    similarity: Number(candidate.score.toFixed(6)),
    method: candidate.method,
    changes: changesFor(candidate.before, candidate.after, maxChanges),
    beforeEvidenceIds: [...candidate.before.fn.evidenceIds],
    afterEvidenceIds: [...candidate.after.fn.evidenceIds],
  };
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  return value;
}

/** Produces a deterministic, evidence-bound function diff between two Program IR artifacts. */
export function diffPrograms(input: { before: ProgramIr; after: ProgramIr; options?: BinaryDiffOptions }): ProgramBinaryDiffReport {
  const options = input.options ?? {};
  const maxFunctions = boundedInteger(options.maxFunctions, DEFAULT_MAX_FUNCTIONS, 1, 20_000, 'maxFunctions');
  const minSimilarity = options.minSimilarity ?? DEFAULT_MIN_SIMILARITY;
  if (!Number.isFinite(minSimilarity) || minSimilarity < 0 || minSimilarity > 1) throw new Error('minSimilarity must be between 0 and 1');
  const maxChanges = boundedInteger(options.maxChanges, DEFAULT_MAX_CHANGES, 1, 1000, 'maxChanges');
  assertProgramIr(input.before, { allowPartial: true });
  assertProgramIr(input.after, { allowPartial: true });

  const limitations: string[] = [];
  let status: BinaryDiffStatus = 'PASSED';
  for (const [label, program] of [['before', input.before], ['after', input.after]] as const) {
    if (!program.provenance) { limitations.push(`${label} Program IR has no provenance; matches remain INFERENCE`); status = 'PARTIAL'; }
    if (program.limitations.length) limitations.push(`${label} Program IR limitations: ${program.limitations.join('; ')}`);
  }

  const beforeIndex = indexProgram(input.before);
  const afterIndex = indexProgram(input.after);
  const beforeFunctions = input.before.functions.slice(0, maxFunctions);
  const afterFunctions = input.after.functions.slice(0, maxFunctions);
  if (input.before.functions.length > maxFunctions || input.after.functions.length > maxFunctions) {
    limitations.push(`Function comparison was truncated at ${maxFunctions} functions per binary`);
    status = 'PARTIAL';
  }
  const beforeFeatures = beforeFunctions.map(fn => buildFeatures(beforeIndex, fn));
  const afterFeatures = afterFunctions.map(fn => buildFeatures(afterIndex, fn));
  const unmatchedBefore = new Map(beforeFeatures.map(feature => [feature.fn.id, feature]));
  const unmatchedAfter = new Map(afterFeatures.map(feature => [feature.fn.id, feature]));
  const matches: FunctionMatch[] = [];

  const accept = (candidate: Candidate) => {
    if (!unmatchedBefore.has(candidate.before.fn.id) || !unmatchedAfter.has(candidate.after.fn.id)) return false;
    unmatchedBefore.delete(candidate.before.fn.id); unmatchedAfter.delete(candidate.after.fn.id);
    matches.push(toMatch(candidate, maxChanges));
    return true;
  };

  const beforeExact = new Map<string, Features[]>();
  const afterExact = new Map<string, Features[]>();
  for (const feature of beforeFeatures) { const list = beforeExact.get(feature.fingerprint.combinedSha256) ?? []; list.push(feature); beforeExact.set(feature.fingerprint.combinedSha256, list); }
  for (const feature of afterFeatures) { const list = afterExact.get(feature.fingerprint.combinedSha256) ?? []; list.push(feature); afterExact.set(feature.fingerprint.combinedSha256, list); }
  for (const [hash, left] of beforeExact) {
    const right = afterExact.get(hash);
    if (!right) continue;
    left.sort((a, b) => a.fn.id.localeCompare(b.fn.id)); right.sort((a, b) => a.fn.id.localeCompare(b.fn.id));
    for (let index = 0; index < Math.min(left.length, right.length); index++) {
      const before = left[index]!; const after = right[index]!;
      if (before.fingerprint.instructionCount === 0 && before.fingerprint.blockCount === 0 && after.fingerprint.instructionCount === 0 && after.fingerprint.blockCount === 0) continue;
      if (!before.fingerprint.completeInstructionDetail || !after.fingerprint.completeInstructionDetail) continue;
      accept({ before, after, score: 1, method: 'exact-fingerprint' });
    }
  }

  const beforeNames = new Map<string, Features[]>();
  const afterNames = new Map<string, Features[]>();
  for (const feature of unmatchedBefore.values()) { const key = normalizeCode(feature.fn.name).toLowerCase(); const list = beforeNames.get(key) ?? []; list.push(feature); beforeNames.set(key, list); }
  for (const feature of unmatchedAfter.values()) { const key = normalizeCode(feature.fn.name).toLowerCase(); const list = afterNames.get(key) ?? []; list.push(feature); afterNames.set(key, list); }
  for (const [name, left] of beforeNames) {
    const right = afterNames.get(name);
    if (!right || left.length !== 1 || right.length !== 1) continue;
    accept({ before: left[0]!, after: right[0]!, score: similarity(left[0]!, right[0]!), method: 'unique-name' });
  }

  const candidates: Candidate[] = [];
  for (const before of unmatchedBefore.values()) {
    const top: Candidate[] = [];
    for (const after of unmatchedAfter.values()) {
      const score = similarity(before, after);
      if (score < minSimilarity) continue;
      const candidate: Candidate = { before, after, score, method: 'similarity' };
      top.push(candidate);
      top.sort((a, b) => b.score - a.score || a.after.fn.id.localeCompare(b.after.fn.id));
      if (top.length > TOP_CANDIDATES) top.pop();
    }
    candidates.push(...top);
  }
  candidates.sort((a, b) => b.score - a.score || a.before.fn.id.localeCompare(b.before.fn.id) || a.after.fn.id.localeCompare(b.after.fn.id));
  for (const candidate of candidates) accept(candidate);

  matches.sort((a, b) => a.beforeName.localeCompare(b.beforeName) || a.beforeId.localeCompare(b.beforeId));
  const unboundMatches = matches.filter(match => match.beforeEvidenceIds.length === 0 || match.afterEvidenceIds.length === 0);
  if (unboundMatches.length) {
    status = 'PARTIAL';
    limitations.push(`${unboundMatches.length} matched function pair(s) lack function-level evidence IDs; matches remain unbound INFERENCE`);
  }
  const beforeFeatureMap = new Map(beforeFeatures.map(feature => [feature.fn.id, feature]));
  const afterFeatureMap = new Map(afterFeatures.map(feature => [feature.fn.id, feature]));
  const incompleteMatches = matches.filter(match => !beforeFeatureMap.get(match.beforeId)?.fingerprint.completeInstructionDetail || !afterFeatureMap.get(match.afterId)?.fingerprint.completeInstructionDetail);
  if (incompleteMatches.length) {
    status = 'PARTIAL';
    limitations.push(`${incompleteMatches.length} matched function pair(s) lack complete instruction bytes or P-Code; exact fingerprint claims are disabled`);
  }
  const addedFunctions = [...unmatchedAfter.values()].map(feature => ({ id: feature.fn.id, name: feature.fn.name, entry: feature.fn.entry, evidenceIds: [...feature.fn.evidenceIds] })).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const removedFunctions = [...unmatchedBefore.values()].map(feature => ({ id: feature.fn.id, name: feature.fn.name, entry: feature.fn.entry, evidenceIds: [...feature.fn.evidenceIds] })).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const modifiedFunctions = matches.filter(match => match.changes.length > 0).length;
  const evidence: BinaryDiffEvidence[] = [
    { kind: 'EVIDENCE', source: input.before.provenance?.analyzer ?? 'Program IR', locator: input.before.provenance?.inputSha256 ?? input.before.id, summary: `Before program contains ${input.before.functions.length} functions` },
    { kind: 'EVIDENCE', source: input.after.provenance?.analyzer ?? 'Program IR', locator: input.after.provenance?.inputSha256 ?? input.after.id, summary: `After program contains ${input.after.functions.length} functions` },
    { kind: 'INFERENCE', source: '@reverse/binary-diff', locator: matches.map(match => `${match.beforeId}->${match.afterId}`).join(','), summary: `Matched ${matches.length} function pairs using normalized fingerprints and structural similarity` },
  ];
  if (matches.some(match => match.changes.length >= maxChanges)) limitations.push(`At least one function reached the ${maxChanges}-change detail limit`);
  return {
    schemaVersion: 1,
    status,
    generatedAt: new Date().toISOString(),
    comparedBinaries: 2,
    matchedFunctions: matches.length,
    before: identity(input.before),
    after: identity(input.after),
    summary: {
      beforeFunctions: input.before.functions.length,
      afterFunctions: input.after.functions.length,
      matchedFunctions: matches.length,
      addedFunctions: addedFunctions.length,
      removedFunctions: removedFunctions.length,
      modifiedFunctions,
      unchangedFunctions: matches.length - modifiedFunctions,
    },
    matches,
    addedFunctions,
    removedFunctions,
    evidence,
    limitations,
  };
}

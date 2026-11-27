import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { assertProgramIr, ghidraMetadataToProgram, inferSemanticHypotheses, ProgramQuery, programStats, type GhidraProgramInput } from '@reverse/program-ir';

async function fixture(): Promise<GhidraProgramInput> {
  return JSON.parse(await readFile('tests/fixtures/program-ir/ghidra-metadata.json', 'utf8')) as GhidraProgramInput;
}

describe('Program IR', () => {
  it('converts structured Ghidra output without inventing missing facts', async () => {
    const program = ghidraMetadataToProgram(await fixture(), 'fixture');
    assertProgramIr(program);
    expect(program.functions).toHaveLength(3);
    expect(program.blocks).toHaveLength(5);
    expect(program.instructions).toHaveLength(7);
    expect(program.variables).toHaveLength(4);
    expect(programStats(program)).toMatchObject({ functions: 3, internalFunctions: 2, externalFunctions: 1, calls: 1, xrefs: 2 });
    expect(program.functions.find(fn => fn.name === 'sum_bytes')).toMatchObject({ signature: 'uint8_t sum_bytes(uint8_t *data, uint32_t length)', callingConvention: '__stdcall', returnType: 'uint8_t' });
    expect(program.instructions[0]?.pcode).toContain('INT_EQUAL length,0');
  });

  it('queries function context, call path, data references and CFG loops', async () => {
    const program = ghidraMetadataToProgram(await fixture(), 'fixture');
    const query = new ProgramQuery(program);
    const context = query.context('sum_bytes');
    expect(context.fn.id).toMatch(/^fn:[a-f0-9]{16}:0x101000$/);
    expect(context.variables.map(variable => variable.name)).toEqual(['data', 'length', 'sum']);
    expect(context.callees).toHaveLength(0);
    expect(context.callers.map(fn => fn.name)).toEqual(['main']);
    expect(query.context('main').data.map(item => item.value)).toContain('abc');
    expect(query.callPath('main', 'sum_bytes')?.map(fn => fn.name)).toEqual(['main', 'sum_bytes']);
    expect(query.reachableBlocks('sum_bytes')).toHaveLength(4);
    expect(query.backEdges()).toHaveLength(1);
    expect(query.instructionPcode('sum_bytes', 2)).toHaveLength(2);
    expect(query.searchData('ABC')[0]?.address).toBe('0x103000');
  });

  it('finds every cycle edge across strongly connected components without crossing components', async () => {
    const base = ghidraMetadataToProgram(await fixture(), 'scc-fixture');
    const block = (id: string, successorIds: string[]) => ({ id, functionId: 'fn', start: id, end: id, instructionIds: [], successorIds, predecessorIds: [], evidenceIds: [] });
    const blocks = [block('a', ['b']), block('b', ['c']), block('c', ['a', 'd']), block('d', ['e']), block('e', ['d']), block('f', ['f']), block('g', [])];
    const edges = new ProgramQuery({ ...base, blocks }).backEdges().map(edge => `${edge.source.id}->${edge.target.id}`).sort();
    expect(edges).toEqual(['a->b', 'b->c', 'c->a', 'd->e', 'e->d', 'f->f']);
  });

  it('marks rule-based semantics as inference and supplies a falsification test', async () => {
    const base = ghidraMetadataToProgram(await fixture(), 'fixture');
    const program = { ...base, hypotheses: inferSemanticHypotheses(base) };
    assertProgramIr(program);
    expect(program.hypotheses.map(item => item.kind)).toContain('iteration');
    expect(program.hypotheses.every(item => item.kindEvidence === 'INFERENCE' && item.falsification.length > 10)).toBe(true);
  });

  it('keeps legacy flat metadata compatible and reports absent structure', async () => {
    const metadata = await fixture();
    const program = ghidraMetadataToProgram({ ...metadata, functions: metadata.functions.map(({ blocks: _blocks, parameters: _parameters, locals: _locals, ...fn }) => fn), globals: [], xrefs: [] }, 'legacy');
    assertProgramIr(program, { allowPartial: true });
    expect(program.blocks).toHaveLength(0);
    expect(program.instructions).toHaveLength(0);
    expect(program.limitations).toContain('Ghidra export did not contain control-flow blocks');
    expect(program.limitations).toContain('Ghidra export did not contain instruction or P-Code records');
  });

  it('binds program and function identity to the analyzed content', async () => {
    const metadata = await fixture();
    const changed = structuredClone(metadata);
    changed.functions[0]!.blocks![0]!.instructions![0]!.bytes = 'ffffff';
    const first = ghidraMetadataToProgram(metadata);
    const second = ghidraMetadataToProgram(changed);
    expect(first.id).not.toBe(second.id);
    expect(first.functions[0]!.id).not.toBe(second.functions[0]!.id);
    expect(first.evidence[0]!.id).not.toBe(second.evidence[0]!.id);
  });

  it('requires complete provenance and rejects dangling evidence references', async () => {
    const program = ghidraMetadataToProgram(await fixture(), 'fixture');
    const noProvenance = structuredClone(program); delete noProvenance.provenance;
    expect(() => assertProgramIr(noProvenance)).toThrow(/provenance/);
    const badEvidence = structuredClone(program); badEvidence.variables[0]!.evidenceIds = ['ev:missing'];
    expect(() => assertProgramIr(badEvidence)).toThrow(/Unknown variable evidence/);
    const badFunction = structuredClone(program); badFunction.variables[0]!.functionId = 'fn:missing';
    expect(() => assertProgramIr(badFunction)).toThrow(/inconsistent ownership/);
  });

  it('records unavailable P-Code as UNKNOWN instead of inventing semantics', async () => {
    const metadata = await fixture();
    metadata.functions[0]!.blocks![0]!.instructions![0]!.pcode = [];
    metadata.functions[0]!.blocks![0]!.instructions![0]!.pcodeStatus = 'unavailable';
    const program = ghidraMetadataToProgram(metadata, 'fixture');
    assertProgramIr(program);
    const instruction = program.instructions[0]!;
    expect(instruction.pcodeStatus).toBe('unavailable');
    expect(program.evidence.find(item => item.id === instruction.evidenceIds[1])?.kind).toBe('UNKNOWN');
    expect(program.limitations.join(' ')).toContain('P-Code was unavailable');
  });

  it('classifies bodyless Ghidra functions as unanalyzed instead of inventing CFG', async () => {
    const metadata = await fixture();
    metadata.functions.push({ name: 'external_stub', entry: '0x00105000', body: '0x00105000', thunk: false, external: false, blocks: [] });
    const program = ghidraMetadataToProgram(metadata, 'fixture');
    assertProgramIr(program);
    expect(program.functions.find(fn => fn.name === 'external_stub')).toMatchObject({ external: true, blockIds: [] });
    expect(program.limitations.join(' ')).toContain('no analyzable control-flow blocks');
  });

  it('binds string references only by exact function entry', async () => {
    const metadata = await fixture();
    metadata.stringReferences[0]!.functionEntry = undefined;
    const program = ghidraMetadataToProgram(metadata, 'fixture');
    expect(program.xrefs.some(item => item.type === 'string-reference')).toBe(false);
    expect(program.limitations.join(' ')).toContain('no exact function entry');
  });

  it('rejects ambiguous names rather than attaching evidence to the wrong function', async () => {
    const metadata = await fixture();
    const program = ghidraMetadataToProgram({ ...metadata, functions: [...metadata.functions, { name: 'sum_bytes', entry: '0x00999999', body: '0x00999999', thunk: false, external: false }] });
    const query = new ProgramQuery(program);
    expect(() => query.context('sum_bytes')).toThrow(/Ambiguous function name/);
    expect(query.context(program.functions.find(fn => fn.entry === '0x999999')!.id).fn.entry).toBe('0x999999');
  });
});

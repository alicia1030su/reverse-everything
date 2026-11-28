import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { diffBinaryBytes, diffPrograms } from '@reverse/binary-diff';
import { ghidraMetadataToProgram, type GhidraProgramInput, type ProgramIr } from '@reverse/program-ir';

async function fixture(): Promise<GhidraProgramInput> {
  return JSON.parse(await readFile('tests/fixtures/program-ir/ghidra-metadata.json', 'utf8')) as GhidraProgramInput;
}

function external(program: ProgramIr, id: string, name: string, entry: string) {
  return { ...program, functions: [...program.functions, { id, name, entry, bodyStart: entry, thunk: false, external: true, parameterIds: [], localIds: [], blockIds: [], calleeIds: [], callerIds: [], evidenceIds: [] }] };
}

describe('Binary Diff', () => {
  it('compares bounded bytes with exact ranges and digests', () => {
    const before = Buffer.from('AAA-111-BBB');
    const after = Buffer.from('AAA-222-BBB');
    const report = diffBinaryBytes(before, after);
    expect(report).toMatchObject({ status: 'PASSED', identical: false, commonPrefixBytes: 4, commonSuffixBytes: 4, changedBytes: 3, changedRanges: [{ offset: 4, length: 3, beforeHex: '313131', afterHex: '323232' }] });
    expect(report.beforeSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(report.afterSha256).not.toBe(report.beforeSha256);
    expect(diffBinaryBytes(before, before).identical).toBe(true);
    expect(() => diffBinaryBytes(Buffer.alloc(0), Buffer.alloc(64 * 1024 * 1024 + 1))).toThrow(/must not exceed/);
  });

  it('matches identical Program IR functions without inventing changes', async () => {
    const program = ghidraMetadataToProgram(await fixture(), 'same');
    const report = diffPrograms({ before: program, after: structuredClone(program) });
    expect(report.status).toBe('PASSED');
    expect(report.summary).toMatchObject({ matchedFunctions: 3, addedFunctions: 0, removedFunctions: 0, modifiedFunctions: 0, unchangedFunctions: 3 });
    expect(report.matches.every(match => match.method === (match.beforeName === 'memcpy' ? 'unique-name' : 'exact-fingerprint'))).toBe(true);
  });

  it('matches renamed functions by normalized code and reports the name change', async () => {
    const metadata = await fixture();
    const before = ghidraMetadataToProgram(metadata, 'before');
    const changed = structuredClone(metadata);
    changed.functions[0]!.name = 'sum_bytes_renamed';
    const after = ghidraMetadataToProgram(changed, 'after');
    const report = diffPrograms({ before, after });
    const match = report.matches.find(item => item.beforeName === 'sum_bytes');
    expect(match).toMatchObject({ afterName: 'sum_bytes_renamed', method: 'exact-fingerprint', similarity: 1 });
    expect(match?.changes).toContainEqual({ kind: 'name', before: 'sum_bytes', after: 'sum_bytes_renamed' });
  });

  it('detects modified functions and added or removed symbols', async () => {
    const metadata = await fixture();
    const before = ghidraMetadataToProgram(metadata, 'before');
    const changed = structuredClone(metadata);
    changed.functions[0]!.blocks![0]!.instructions![0]!.mnemonic = 'JZ';
    const after = external(ghidraMetadataToProgram(changed, 'after'), 'fn:external:added', 'added_helper', '0x00999999');
    const report = diffPrograms({ before, after });
    expect(report.summary.matchedFunctions).toBe(3);
    expect(report.summary.addedFunctions).toBe(1);
    expect(report.summary.modifiedFunctions).toBe(1);
    expect(report.matches.find(item => item.beforeName === 'sum_bytes')?.changes).toContainEqual(expect.objectContaining({ kind: 'instructions' }));
    expect(report.addedFunctions[0]?.name).toBe('added_helper');
  });

  it('preserves partial Program IR limitations without inventing structure', async () => {
    const metadata = await fixture();
    const partialMetadata = { ...metadata, functions: metadata.functions.map(({ blocks: _blocks, parameters: _parameters, locals: _locals, ...fn }) => fn), globals: [], xrefs: [] };
    const before = ghidraMetadataToProgram(partialMetadata, 'partial');
    const report = diffPrograms({ before, after: structuredClone(before) });
    expect(report.status).toBe('PASSED');
    expect(report.limitations.join(' ')).toMatch(/limitations|control-flow|instruction/i);
    const noProvenance = structuredClone(before); delete noProvenance.provenance;
    expect(diffPrograms({ before: noProvenance, after: noProvenance }).status).toBe('PARTIAL');
  });

  it('detects immediate byte and P-Code constant changes in partial exports', async () => {
    const metadata = await fixture();
    const before = ghidraMetadataToProgram(metadata, 'before');
    const changed = structuredClone(metadata);
    changed.functions[0]!.blocks![0]!.instructions![0]!.bytes = 'ffffff';
    changed.functions[0]!.blocks![0]!.instructions![0]!.pcode = ['INT_EQUAL length,0x1'];
    const after = ghidraMetadataToProgram(changed, 'after');
    const report = diffPrograms({ before, after });
    const match = report.matches.find(item => item.beforeName === 'sum_bytes')!;
    expect(match.changes).toContainEqual(expect.objectContaining({ kind: 'instructions' }));
    expect(match.changes).toContainEqual(expect.objectContaining({ kind: 'pcode' }));
  });

  it('does not claim exact partial-IR matches when call order changes', async () => {
    const base = ghidraMetadataToProgram(await fixture(), 'call-order');
    const main = base.functions.find(fn => fn.name === 'main')!;
    const memcpy = base.functions.find(fn => fn.name === 'memcpy')!;
    const firstCall = base.calls[0]!; firstCall.instructionId = undefined;
    const secondCall = { id: 'call:memcpy', callerId: main.id, calleeId: memcpy.id, address: '0x00102004', evidenceIds: [] };
    base.calls.push(secondCall); main.calleeIds.push(memcpy.id); memcpy.callerIds.push(main.id);
    for (const instruction of base.instructions) { instruction.bytes = undefined; instruction.pcode = undefined; instruction.pcodeStatus = 'unavailable'; }
    const before = structuredClone(base);
    const after = structuredClone(base);
    const beforeCalls = after.calls;
    beforeCalls[0]!.address = '0x00102004'; beforeCalls[1]!.address = '0x00102000';
    const report = diffPrograms({ before, after });
    const match = report.matches.find(item => item.beforeName === 'main')!;
    expect(report.status).toBe('PARTIAL');
    expect(match.method).not.toBe('exact-fingerprint');
    expect(match.changes).toContainEqual(expect.objectContaining({ kind: 'calls' }));
  });

  it('marks matches without function evidence as partial instead of verified', async () => {
    const program = ghidraMetadataToProgram(await fixture(), 'unbound');
    for (const fn of program.functions) fn.evidenceIds = [];
    const report = diffPrograms({ before: program, after: structuredClone(program) });
    expect(report.status).toBe('PARTIAL');
    expect(report.limitations.join(' ')).toMatch(/evidence IDs/);
  });

  it('rejects invalid bounds instead of producing unbounded comparisons', async () => {
    const program = ghidraMetadataToProgram(await fixture(), 'bounds');
    expect(() => diffPrograms({ before: program, after: program, options: { maxFunctions: 0 } })).toThrow(/maxFunctions/);
    expect(() => diffPrograms({ before: program, after: program, options: { minSimilarity: 2 } })).toThrow(/minSimilarity/);
  });
});

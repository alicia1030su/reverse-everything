import { evidenceById, requireRef } from './program.js';
import type { BasicBlockIr, DataItemIr, FunctionContext, FunctionIr, ProgramIr } from './types.js';

export class ProgramQuery {
  readonly program: ProgramIr;
  private readonly functions: Map<string, FunctionIr>;
  private readonly blocks: Map<string, BasicBlockIr>;
  constructor(program: ProgramIr) {
    this.program = program;
    this.functions = new Map(program.functions.map(fn => [fn.id, fn]));
    this.blocks = new Map(program.blocks.map(block => [block.id, block]));
  }
  function(idOrNameOrEntry: string): FunctionIr {
    const direct = this.functions.get(idOrNameOrEntry);
    if (direct) return direct;
    const matches = this.program.functions.filter(fn => fn.name === idOrNameOrEntry || fn.entry === idOrNameOrEntry);
    if (matches.length > 1) throw new Error(`Ambiguous function name ${idOrNameOrEntry}; use its address-qualified id`);
    if (!matches[0]) throw new Error(`Unknown function: ${idOrNameOrEntry}`);
    return matches[0];
  }
  searchFunctions(pattern: string | RegExp, limit = 100): FunctionIr[] {
    const regex = typeof pattern === 'string' ? new RegExp(pattern, 'i') : pattern;
    if (!Number.isInteger(limit) || limit < 1) throw new Error('Function search limit must be a positive integer');
    return this.program.functions.filter(fn => regex.test(fn.name) || regex.test(fn.signature ?? '')).slice(0, Math.min(limit, 500));
  }
  context(idOrNameOrEntry: string): FunctionContext {
    const fn = this.function(idOrNameOrEntry);
    return {
      fn,
      blocks: fn.blockIds.map(id => requireRef(this.program.blocks, id, 'block')),
      variables: [...fn.parameterIds, ...fn.localIds].map(id => requireRef(this.program.variables, id, 'variable')),
      callees: fn.calleeIds.map(id => this.functions.get(id)).filter((item): item is FunctionIr => item !== undefined),
      callers: fn.callerIds.map(id => this.functions.get(id)).filter((item): item is FunctionIr => item !== undefined),
      data: this.program.data.filter(item => this.program.xrefs.some(xref => xref.functionId === fn.id && xref.to === item.address)),
      hypotheses: this.program.hypotheses.filter(item => item.functionId === fn.id),
      evidence: evidenceById(this.program, fn.evidenceIds),
    };
  }
  xrefsTo(address: string) { return this.program.xrefs.filter(xref => xref.to === address); }
  dataAt(address: string): DataItemIr | undefined { return this.program.data.find(item => item.address === address); }
  searchData(pattern: string | RegExp, limit = 100): DataItemIr[] {
    const regex = typeof pattern === 'string' ? new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : pattern;
    return this.program.data.filter(item => regex.test(item.value ?? '')).slice(0, Math.min(limit, 500));
  }
  callPath(from: string, to: string): FunctionIr[] | null {
    const start = this.function(from).id; const goal = this.function(to).id;
    const queue = [start]; const previous = new Map<string, string | null>([[start, null]]);
    for (let index = 0; index < queue.length; index++) {
      const current = queue[index]!;
      if (current === goal) {
        const path: FunctionIr[] = []; let cursor: string | null = current;
        while (cursor) { path.push(this.functions.get(cursor)!); cursor = previous.get(cursor) ?? null; }
        return path.reverse();
      }
      for (const next of this.functions.get(current)?.calleeIds ?? []) if (!previous.has(next)) { previous.set(next, current); queue.push(next); }
    }
    return null;
  }
  reachableBlocks(idOrNameOrEntry: string): BasicBlockIr[] {
    const fn = this.function(idOrNameOrEntry); if (!fn.blockIds[0]) return [];
    const seen = new Set<string>(); const queue = [fn.blockIds[0]];
    for (let index = 0; index < queue.length; index++) {
      const id = queue[index]!; if (seen.has(id)) continue; seen.add(id);
      for (const next of this.blocks.get(id)?.successorIds ?? []) if (!seen.has(next)) queue.push(next);
    }
    return fn.blockIds.filter(id => seen.has(id)).map(id => this.blocks.get(id)!);
  }
  backEdges(): Array<{ source: BasicBlockIr; target: BasicBlockIr }> {
    // An edge is on a cycle exactly when both endpoints share a strongly
    // connected component. Iterative Kosaraju keeps this O(V+E) and avoids
    // recursion limits on large functions.
    const nodes = this.program.blocks;
    const index = new Map(nodes.map((block, position) => [block.id, position]));
    const adjacency = nodes.map(block => block.successorIds.flatMap(id => {
      const target = index.get(id); return target === undefined ? [] : [target];
    }));
    const reverse: number[][] = nodes.map(() => []);
    for (let source = 0; source < adjacency.length; source++) for (const target of adjacency[source]!) reverse[target]!.push(source);
    const visited = new Uint8Array(nodes.length); const finish: number[] = [];
    for (let start = 0; start < nodes.length; start++) {
      if (visited[start]) continue;
      visited[start] = 1;
      const stack: Array<{ node: number; next: number }> = [{ node: start, next: 0 }];
      while (stack.length) {
        const frame = stack[stack.length - 1]!;
        const next = adjacency[frame.node]![frame.next++];
        if (next === undefined) { finish.push(frame.node); stack.pop(); continue; }
        if (visited[next]) continue;
        visited[next] = 1; stack.push({ node: next, next: 0 });
      }
    }
    const component = new Int32Array(nodes.length).fill(-1); let componentId = 0;
    for (let position = finish.length - 1; position >= 0; position--) {
      const start = finish[position]!;
      if (component[start] !== -1) continue;
      component[start] = componentId;
      const stack = [start];
      while (stack.length) {
        const current = stack.pop()!;
        for (const previous of reverse[current]!) if (component[previous] === -1) { component[previous] = componentId; stack.push(previous); }
      }
      componentId++;
    }
    const result: Array<{ source: BasicBlockIr; target: BasicBlockIr }> = [];
    for (const source of nodes) for (const targetId of source.successorIds) {
      const target = this.blocks.get(targetId);
      if (target && component[index.get(source.id)!] === component[index.get(target.id)!]) result.push({ source, target });
    }
    return result;
  }
  instructionPcode(idOrNameOrEntry: string, limit = 256) {
    const fn = this.function(idOrNameOrEntry); const blockIds = new Set(fn.blockIds);
    return this.program.instructions.filter(instruction => blockIds.has(instruction.blockId) && instruction.pcode !== undefined).slice(0, Math.min(limit, 5000));
  }
}

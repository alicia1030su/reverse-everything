import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { JsonObject } from '@reverse/contracts';
import { assertProgramIr, ProgramQuery, programStats, type ProgramIr } from '@reverse/program-ir';
import { AutopilotError, type ToolDefinition } from './types.js';
import { relativeParts, runSecureFs } from './secure-fs.js';
import type { ToolRegistry } from './tools.js';

const MAX_PROGRAM_IR_BYTES = 32 * 1024 * 1024;
const MAX_QUERY_REPORT_BYTES = 8 * 1024 * 1024;
const OPERATIONS = ['stats', 'function-context', 'search-functions', 'call-path', 'search-data', 'reachable-blocks', 'back-edges', 'instruction-pcode', 'hypotheses', 'evidence'] as const;
type Operation = typeof OPERATIONS[number];

function objectSchema(properties: JsonObject, required: string[]): JsonObject {
  return { type: 'object', properties, required, additionalProperties: false };
}

async function loadProgramIr(cwd: string, workspaceRoot: string, inputPath: string, signal?: AbortSignal): Promise<{ program: ProgramIr; sha256: string; relativePath: string }> {
  if (typeof inputPath !== 'string' || !inputPath.trim() || inputPath.includes('\0')) throw new AutopilotError('programIrPath 必须是非空路径', 'TOOL_INPUT_INVALID', 400);
  const directoryParts = relativeParts(workspaceRoot, cwd);
  const candidate = path.resolve(cwd, inputPath);
  const fileParts = relativeParts(cwd, candidate);
  const loaded = await runSecureFs({ operation: 'read', root: workspaceRoot, directoryParts, fileParts, maxBytes: MAX_PROGRAM_IR_BYTES }, { signal });
  if (loaded.operation !== 'read') throw new AutopilotError('安全文件读取响应类型无效', 'TOOL_PROTOCOL', 502);
  const bytes = Buffer.from(loaded.contentBase64, 'base64');
  if (bytes.length > MAX_PROGRAM_IR_BYTES) throw new AutopilotError('Program IR 读取超过限额', 'TOOL_INPUT_TOO_LARGE', 413);
  let program: ProgramIr;
  try {
    program = JSON.parse(bytes.toString('utf8')) as ProgramIr;
    assertProgramIr(program, { allowPartial: true });
    if (!program.provenance) throw new Error('Program provenance is required for Autopilot queries');
  } catch (error) { throw new AutopilotError(`Program IR 校验失败: ${error instanceof Error ? error.message : String(error)}`, 'TOOL_INPUT_INVALID', 422); }
  return { program, sha256: loaded.sha256, relativePath: fileParts.join('/') };
}

async function writeReport(cwd: string, workspaceRoot: string, serialized: string, signal?: AbortSignal): Promise<string> {
  const directoryParts = relativeParts(workspaceRoot, cwd);
  const result = await runSecureFs({
    operation: 'write', root: workspaceRoot, directoryParts, subdirectory: 'reports',
    fileName: `program-ir-query-${randomUUID()}.json`, contentBase64: Buffer.from(serialized, 'utf8').toString('base64'), maxBytes: MAX_QUERY_REPORT_BYTES,
  }, { signal });
  if (result.operation !== 'write') throw new AutopilotError('安全文件写入响应类型无效', 'TOOL_PROTOCOL', 502);
  return result.path;
}

function requiredString(input: JsonObject, key: string): string {
  const value = input[key];
  if (typeof value !== 'string' || !value.trim()) throw new AutopilotError(`${key} 必填`, 'TOOL_INPUT_INVALID', 400);
  return value;
}

function literalPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function query(program: ProgramIr, operation: Operation, input: JsonObject): JsonObject {
  const query = new ProgramQuery(program);
  const limit = typeof input.limit === 'number' ? input.limit : 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new AutopilotError('limit 必须在 1..500 之间', 'TOOL_INPUT_INVALID', 400);
  switch (operation) {
    case 'stats': return { ...programStats(program) };
    case 'function-context': return { ...query.context(requiredString(input, 'functionId')) };
    case 'search-functions': return { items: query.searchFunctions(literalPattern(requiredString(input, 'pattern')), limit) };
    case 'call-path': {
      const functions = query.callPath(requiredString(input, 'from'), requiredString(input, 'to'));
      return { found: functions !== null, functions: functions ?? [] };
    }
    case 'search-data': return { items: query.searchData(requiredString(input, 'pattern'), limit) };
    case 'reachable-blocks': return { items: query.reachableBlocks(requiredString(input, 'functionId')) };
    case 'back-edges': return { items: query.backEdges() };
    case 'instruction-pcode': return { items: query.instructionPcode(requiredString(input, 'functionId'), limit) };
    case 'hypotheses': return { items: program.hypotheses };
    case 'evidence': {
      const id = input.evidenceId;
      if (id !== undefined && (typeof id !== 'string' || !id)) throw new AutopilotError('evidenceId 必须是非空字符串', 'TOOL_INPUT_INVALID', 400);
      const items = id === undefined ? program.evidence.slice(0, limit) : program.evidence.filter(item => item.id === id);
      return { items };
    }
  }
}

export function registerProgramIrQueryTool(registry: ToolRegistry): void {
  const definition: ToolDefinition = {
    name: 'program-ir:query',
    description: 'Query validated Program IR with evidence-preserving function, call graph, CFG, data, P-Code, hypothesis and evidence operations',
    inputSchema: objectSchema({
      programIrPath: { type: 'string', minLength: 1, maxLength: 4096 },
      operation: { type: 'string', enum: [...OPERATIONS] },
      functionId: { type: 'string', minLength: 1, maxLength: 512 },
      pattern: { type: 'string', minLength: 1, maxLength: 512 },
      from: { type: 'string', minLength: 1, maxLength: 512 },
      to: { type: 'string', minLength: 1, maxLength: 512 },
      evidenceId: { type: 'string', minLength: 1, maxLength: 512 },
      expectedSha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
      limit: { type: 'number', minimum: 1, maximum: 500 },
    }, ['programIrPath', 'operation']),
    outputSchema: objectSchema({
      programId: { type: 'string' }, operation: { type: 'string' }, result: { type: 'object', additionalProperties: true },
      reportPath: { type: 'string' }, outputRefs: { type: 'array', items: { type: 'string' } },
      limitations: { type: 'array', items: { type: 'string' } },
    }, ['programId', 'operation', 'result', 'reportPath', 'outputRefs', 'limitations']),
    platforms: ['Web', 'Windows', 'macOS', 'Linux'], formats: ['JSON'], permissions: ['read-task-artifacts'],
    environment: 'isolated-local', budget: { timeoutMs: 30_000, maxDiskMB: 64 }, version: '1.0.0',
    available: true, verification: 'VERIFIED', source: '@reverse/autopilot/program-ir',
  };
  registry.register(definition, async (input, context) => {
    const operation = input.operation as Operation;
    if (!OPERATIONS.includes(operation)) throw new AutopilotError('不支持的 Program IR 查询操作', 'TOOL_INPUT_INVALID', 400);
    const loaded = await loadProgramIr(context.cwd, context.workspaceRoot, String(input.programIrPath), context.signal);
    if (typeof input.expectedSha256 === 'string' && input.expectedSha256 !== loaded.sha256) throw new AutopilotError('Program IR SHA-256 与上游工件不匹配', 'TOOL_ARTIFACT_MISMATCH', 422);
    const result = query(loaded.program, operation, input);
    const report = {
      schemaVersion: 1, taskId: context.taskId, projectId: context.projectId, programId: loaded.program.id,
      operation, input: { ...input, programIrPath: loaded.relativePath }, programIrSha256: loaded.sha256,
      result, limitations: loaded.program.limitations, generatedAt: new Date().toISOString(),
    };
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    if (Buffer.byteLength(serialized) > MAX_QUERY_REPORT_BYTES) throw new AutopilotError(`Program IR 查询报告超过 ${MAX_QUERY_REPORT_BYTES} 字节限额`, 'TOOL_OUTPUT_TOO_LARGE', 413);
    const reportPath = await writeReport(context.cwd, context.workspaceRoot, serialized, context.signal);
    return { programId: loaded.program.id, operation, result, reportPath, outputRefs: [reportPath], limitations: loaded.program.limitations };
  });
}

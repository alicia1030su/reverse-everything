import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { JsonObject } from '@reverse/contracts';
import { AutopilotError, type ToolDefinition } from './types.js';

export interface ToolBudget { timeoutMs: number; maxDiskMB: number }
export interface ToolInvokeContext {
  permissions: string[]; budget: ToolBudget; cwd: string; workspaceRoot: string; taskId: string; projectId: string;
  signal?: AbortSignal; env?: NodeJS.ProcessEnv;
}
export type ToolHandler = (input: JsonObject, context: ToolInvokeContext) => Promise<JsonObject> | JsonObject;
interface RegisteredTool { definition: ToolDefinition; handler?: ToolHandler }

export function validateToolJsonSchema(value: unknown, schema: JsonObject | boolean, location = '$'): void {
  if (schema === true) return;
  if (schema === false) throw new AutopilotError(`${location} 不被允许`, 'TOOL_INPUT_INVALID', 400);
  if (value === null) {
    if (schema.type === 'null') return;
    throw new AutopilotError(`${location} 不能为 null`, 'TOOL_INPUT_INVALID', 400);
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = Array.isArray(value) ? 'array' : typeof value;
    if (!types.includes(actual)) throw new AutopilotError(`${location} 类型应为 ${types.join('|')}`, 'TOOL_INPUT_INVALID', 400);
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) throw new AutopilotError(`${location} 不在允许枚举内`, 'TOOL_INPUT_INVALID', 400);
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) throw new AutopilotError(`${location} 小于最小值`, 'TOOL_INPUT_INVALID', 400);
    if (typeof schema.maximum === 'number' && value > schema.maximum) throw new AutopilotError(`${location} 大于最大值`, 'TOOL_INPUT_INVALID', 400);
  }
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) throw new AutopilotError(`${location} 过短`, 'TOOL_INPUT_INVALID', 400);
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) throw new AutopilotError(`${location} 过长`, 'TOOL_INPUT_INVALID', 400);
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) throw new AutopilotError(`${location} 格式无效`, 'TOOL_INPUT_INVALID', 400);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) throw new AutopilotError(`${location} 项目过少`, 'TOOL_INPUT_INVALID', 400);
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) throw new AutopilotError(`${location} 项目过多`, 'TOOL_INPUT_INVALID', 400);
    if (schema.items && typeof schema.items === 'object') for (let index = 0; index < value.length; index++) validateToolJsonSchema(value[index], schema.items as JsonObject, `${location}[${index}]`);
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const object = value as JsonObject;
    if (Array.isArray(schema.required)) for (const key of schema.required) if (typeof key === 'string' && !(key in object)) throw new AutopilotError(`${location} 缺少必填字段 ${key}`, 'TOOL_INPUT_INVALID', 400);
    const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties as JsonObject : {};
    for (const [key, item] of Object.entries(object)) {
      if (properties[key]) validateToolJsonSchema(item, properties[key] as JsonObject, `${location}.${key}`);
      else if (schema.additionalProperties === false) throw new AutopilotError(`${location} 包含未允许字段 ${key}`, 'TOOL_INPUT_INVALID', 400);
    }
  }
}

export function assertIsolatedCwd(cwd: string, workspaceRoot: string): string {
  const root = path.resolve(workspaceRoot); const resolved = path.resolve(cwd);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new AutopilotError('工具 cwd 必须位于任务隔离工作区内', 'TOOL_CWD_FORBIDDEN', 403);
  return resolved;
}

const ALLOWED_NPM_SCRIPTS = new Set(['build', 'test', 'package']);
export interface AllowlistedCommandResult { command: string; args: string[]; cwd: string; stdout: string; stderr: string; exitCode: number }

export async function runAllowlistedCommand(script: 'build' | 'test' | 'package', cwd: string, workspaceRoot: string, budget: ToolBudget, signal?: AbortSignal): Promise<AllowlistedCommandResult> {
  if (!ALLOWED_NPM_SCRIPTS.has(script)) throw new AutopilotError('仅允许 npm run build/test/package', 'TOOL_COMMAND_FORBIDDEN', 403);
  const isolated = assertIsolatedCwd(cwd, workspaceRoot);
  const home = path.join(isolated, '.autopilot-home'); const tmp = path.join(isolated, '.autopilot-tmp');
  await mkdir(home, { recursive: true }); await mkdir(tmp, { recursive: true });
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, COMSPEC: process.env.COMSPEC, HOME: home, USERPROFILE: home, TMPDIR: tmp, TEMP: tmp, TMP: tmp, XDG_CACHE_HOME: path.join(home, '.cache'), XDG_CONFIG_HOME: path.join(home, '.config'), CI: '1', NO_COLOR: '1' };
  return new Promise((resolve, reject) => {
    const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', script, '--if-present'], { cwd: isolated, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let settled = false;
    const finish = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); if (error) reject(error); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new AutopilotError(`命令超出 ${budget.timeoutMs}ms 预算`, 'TOOL_TIMEOUT', 408)); }, budget.timeoutMs);
    const onAbort = () => { child.kill('SIGKILL'); finish(new AutopilotError('命令已取消', 'TOOL_CANCELLED', 409)); };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', chunk => { stdout = (stdout + String(chunk)).slice(-256_000); });
    child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-256_000); });
    child.on('error', error => finish(error));
    child.on('close', code => {
      if (settled) return;
      if (code !== 0) { finish(new AutopilotError(`npm run ${script} 失败 (${code ?? 'signal'}): ${stderr.slice(-2000)}`, 'TOOL_EXECUTION_FAILED', 422)); return; }
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
      resolve({ command: 'npm', args: ['run', script, '--if-present'], cwd: isolated, stdout, stderr, exitCode: code ?? 0 });
    });
  });
}

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();
  register(definition: ToolDefinition, handler?: ToolHandler): this {
    if (!definition.name || this.tools.has(definition.name)) throw new AutopilotError(`工具已存在或名称无效: ${definition.name}`, 'TOOL_DUPLICATE', 409);
    validateToolJsonSchema(definition.inputSchema, { type: 'object' });
    this.tools.set(definition.name, { definition, ...(handler ? { handler } : {}) });
    return this;
  }
  get(name: string): ToolDefinition | undefined { return this.tools.get(name)?.definition; }
  list(): ToolDefinition[] { return [...this.tools.values()].map(item => item.definition); }
  has(name: string): boolean { return this.tools.has(name); }
  async invoke(name: string, input: JsonObject, context: ToolInvokeContext): Promise<JsonObject> {
    const registered = this.tools.get(name);
    if (!registered) throw new AutopilotError(`工具未注册: ${name}`, 'TOOL_UNAVAILABLE', 404);
    const definition = registered.definition;
    if (!definition.available || definition.verification === 'UNAVAILABLE') throw new AutopilotError(`工具不可用: ${name}`, 'TOOL_UNAVAILABLE', 503);
    validateToolJsonSchema(input, definition.inputSchema);
    for (const permission of definition.permissions) if (!context.permissions.includes(permission)) throw new AutopilotError(`工具 ${name} 需要权限 ${permission}`, 'TOOL_FORBIDDEN', 403);
    if (!Number.isFinite(context.budget.timeoutMs) || context.budget.timeoutMs <= 0 || !Number.isFinite(context.budget.maxDiskMB) || context.budget.maxDiskMB <= 0) throw new AutopilotError('工具预算无效', 'TOOL_BUDGET_INVALID', 400);
    assertIsolatedCwd(context.cwd, context.workspaceRoot);
    if (!registered.handler) throw new AutopilotError(`工具 ${name} 仅声明能力，必须由工作流执行器处理`, 'TOOL_UNAVAILABLE', 503);
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => registered.handler!(input, context)),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new AutopilotError(`工具 ${name} 超出预算`, 'TOOL_TIMEOUT', 408)), context.budget.timeoutMs); }),
      ]);
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new AutopilotError(`工具 ${name} 输出必须是对象`, 'TOOL_OUTPUT_INVALID', 502);
      validateToolJsonSchema(result, definition.outputSchema);
      return result;
    } finally { if (timer) clearTimeout(timer); }
  }
}

const objectSchema = (properties: JsonObject, required: string[] = [], additionalProperties = false): JsonObject => ({ type: 'object', properties, required, additionalProperties });
const refsSchema = { type: 'array', items: { type: 'string' } };

function definition(name: string, description: string, inputSchema: JsonObject, outputSchema: JsonObject, permissions: string[], formats: string[], budget: ToolBudget, verification: ToolDefinition['verification'] = 'VERIFIED'): ToolDefinition {
  return { name, description, inputSchema, outputSchema, platforms: ['Web', 'Windows', 'macOS', 'Linux'], formats, permissions, environment: 'isolated-local', budget, version: '1.0.0', available: true, verification, source: '@reverse/autopilot' };
}

function html(value: string): string { return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!); }

async function writeOutputs(cwd: string, files: Record<string, string>): Promise<string[]> {
  const refs: string[] = [];
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(cwd, relative); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, content, 'utf8'); refs.push(target);
  }
  return refs;
}

async function checksumFiles(files: string[]): Promise<string> {
  const lines: string[] = [];
  for (const file of [...files].sort()) lines.push(`${createHash('sha256').update(await readFile(file)).digest('hex')}  ${path.basename(file)}`);
  return `${lines.join('\n')}\n`;
}

export function createDefaultToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  const analyzers: [string, string, string[]][] = [
    ['website', 'Bounded same-origin website capture and static compatibility analysis', ['URL', 'HTML']],
    ['file', 'Read-only static file identification and bounded content analysis', ['PE', 'ELF', 'Mach-O', 'ZIP', 'UNKNOWN']],
    ['security', 'Passive defensive HTTP header, cookie and dependency checks', ['URL', 'HTTP']],
    ['game', 'Authorized trace/protocol evidence analysis and compatibility reconstruction', ['HAR', 'JSON', 'PCAP']],
    ['legacy', 'Read-only legacy software and data recovery analysis; never executes the original', ['PE', 'ELF', 'ZIP', 'DISK', 'UNKNOWN']],
    ['firmware', 'Streaming firmware identity, entropy and static metadata analysis; never flashes', ['FIRMWARE', 'UF2', 'HEX', 'ELF']],
    ['apk', 'Bounded static APK/ZIP inspection with optional pinned decompilation', ['APK', 'DEX', 'ZIP']],
    ['ghidra', 'Authorized static Ghidra import in an isolated temporary project', ['ELF', 'PE', 'Mach-O']],
    ['hardware', 'Read-only offline USB/PCAP/HID descriptor analysis', ['PCAP', 'PCAPNG', 'USB']],
    ['network', 'Bounded offline network trace analysis', ['PCAP', 'PCAPNG', 'HAR']],
    ['console', 'Read-only console profile and retained material analysis', ['ROM', 'FIRMWARE', 'UNKNOWN']],
  ];
  for (const [name, description, formats] of analyzers) registry.register(definition(`analyzer:${name}`, description, objectSchema({ target: { type: 'string' }, uploadId: { type: 'string' }, path: { type: 'string' } }), objectSchema({ status: { type: 'string' }, taskId: { type: 'string' }, outputRefs: refsSchema }), ['read-target', 'execute-analyzer'], formats, { timeoutMs: 300_000, maxDiskMB: 1024 }, 'IMPLEMENTED'));
  registry.register(definition('reconstruct:static-site', 'Generate a real independent static website from the stated goal', objectSchema({ goal: { type: 'string', minLength: 1, maxLength: 4000 }, title: { type: 'string', maxLength: 120 } }, ['goal']), objectSchema({ outputRefs: refsSchema, title: { type: 'string' }, generated: { type: 'boolean' } }, ['outputRefs']), ['write-task-artifacts'], ['HTML', 'CSS', 'JS'], { timeoutMs: 30_000, maxDiskMB: 64 }), async (input, context) => {
    const cwd = context.cwd;
    const title = typeof input.title === 'string' && input.title.trim() ? input.title.trim() : '独立重建站点';
    const goal = String(input.goal);
    const refs = await writeOutputs(cwd, {
      'site/index.html': `<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${html(title)}</title><link rel="stylesheet" href="styles.css"></head><body><main><p class="eyebrow">Independent reconstruction</p><h1>${html(title)}</h1><p>${html(goal)}</p><section><h2>交付说明</h2><p>本页面由真实工作流工件生成，可离线打开。所有分析结论以随包报告为准。</p></section><button id="action" type="button">验证交互</button><p id="status" role="status"></p></main><script src="app.js"></script></body></html>\n`,
      'site/styles.css': ':root{font-family:system-ui,sans-serif;color:#172033;background:#f5f7fb}body{margin:0}main{max-width:760px;margin:8vh auto;padding:32px;background:white;border-radius:18px;box-shadow:0 12px 40px #17203318}h1{font-size:clamp(32px,6vw,64px);line-height:1.05}.eyebrow{color:#5264d9;font-weight:700}section{border-top:1px solid #dde3ef;margin-top:32px;padding-top:16px}button{padding:10px 16px;border:0;border-radius:8px;background:#5264d9;color:white;cursor:pointer}\n',
      'site/app.js': "document.getElementById('action')?.addEventListener('click',()=>{const node=document.getElementById('status');if(node)node.textContent='交互验证通过';});\n",
    });
    return { outputRefs: refs, title, generated: true };
  });
  registry.register(definition('build:static-site', 'Build the generated static site into dist', objectSchema({ sourceDir: { type: 'string' } }, ['sourceDir']), objectSchema({ outputRefs: refsSchema, build: { type: 'boolean' } }, ['outputRefs', 'build']), ['write-task-artifacts'], ['HTML'], { timeoutMs: 30_000, maxDiskMB: 64 }), async input => {
    const source = path.resolve(String(input.sourceDir)); const dist = path.join(path.dirname(source), 'dist'); await mkdir(dist, { recursive: true }); await cp(source, dist, { recursive: true });
    const entries = (await readdir(dist, { recursive: true })).map(item => path.join(dist, item)); const refs: string[] = [];
    for (const file of entries) if ((await stat(file)).isFile()) refs.push(file);
    return { outputRefs: refs, build: true };
  });
  registry.register(definition('test:static-site', 'Run deterministic static-site acceptance checks', objectSchema({ files: refsSchema }, ['files']), objectSchema({ passed: { type: 'boolean' }, checks: { type: 'array' }, outputRefs: refsSchema }, ['passed', 'checks', 'outputRefs']), ['read-task-artifacts'], ['HTML', 'CSS', 'JS'], { timeoutMs: 30_000, maxDiskMB: 64 }), async (input, context) => {
    const files = (input.files as string[]).map(file => path.resolve(file)); const index = files.find(file => path.basename(file) === 'index.html');
    const checks: JsonObject[] = [{ name: 'index.html exists', passed: Boolean(index) }];
    let content = ''; if (index) { content = await readFile(index, 'utf8'); checks.push({ name: 'document structure', passed: /<!doctype html>/i.test(content) && /<html[\s>]/i.test(content) && /<\/html>/i.test(content) }); checks.push({ name: 'local assets only', passed: !/(?:src|href)=["']https?:\/\//i.test(content) }); }
    const passed = checks.every(check => check.passed === true); const outputRefs = await writeOutputs(context.cwd, { 'test-results.json': `${JSON.stringify({ passed, checks, executedAt: new Date().toISOString() }, null, 2)}\n` });
    if (!passed) throw new AutopilotError('静态站点规则测试失败', 'TOOL_TEST_FAILED', 422);
    return { passed, checks, outputRefs };
  });
  registry.register(definition('package:static-site', 'Create deployment manifest and SHA256SUMS from real dist files', objectSchema({ files: refsSchema }, ['files']), objectSchema({ outputRefs: refsSchema, fileCount: { type: 'number' } }, ['outputRefs', 'fileCount']), ['write-task-artifacts'], ['HTML', 'JSON', 'TEXT'], { timeoutMs: 30_000, maxDiskMB: 64 }), async (input, context) => {
    const files = (input.files as string[]).filter(file => path.basename(file) !== 'SHA256SUMS.txt'); const sums = await checksumFiles(files); const outputRefs = await writeOutputs(context.cwd, { 'package/SHA256SUMS.txt': sums, 'package/PACKAGE.json': `${JSON.stringify({ name: 'independent-static-site', version: '1.0.0', fileCount: files.length, generatedAt: new Date().toISOString() }, null, 2)}\n` });
    return { outputRefs, fileCount: files.length };
  });
  registry.register(definition('document:delivery', 'Write delivery notes from real task context', objectSchema({ goal: { type: 'string' }, completed: refsSchema, incomplete: refsSchema }, ['goal', 'completed', 'incomplete']), objectSchema({ outputRefs: refsSchema }, ['outputRefs']), ['write-task-artifacts'], ['MARKDOWN'], { timeoutMs: 30_000, maxDiskMB: 64 }), async (input, context) => ({ outputRefs: await writeOutputs(context.cwd, { 'docs/DELIVERY-NOTES.md': `# 交付说明\n\n## 目标\n${String(input.goal)}\n\n## 已完成\n${(input.completed as string[]).map(item => `- ${item}`).join('\n') || '- 无'}\n\n## 未完成 / 限制\n${(input.incomplete as string[]).map(item => `- ${item}`).join('\n') || '- 无'}\n` }) }));
  registry.register(definition('verify:delivery', 'Independently verify referenced files and recorded checks', objectSchema({ files: refsSchema, checks: { type: 'array' } }, ['files', 'checks']), objectSchema({ passed: { type: 'boolean' }, checks: { type: 'array' }, outputRefs: refsSchema }, ['passed', 'checks', 'outputRefs']), ['read-task-artifacts'], ['ANY'], { timeoutMs: 30_000, maxDiskMB: 64 }), async (input, context) => {
    const checks: JsonObject[] = []; for (const file of input.files as string[]) { try { const info = await stat(file); checks.push({ name: `artifact:${path.basename(file)}`, passed: info.isFile() && info.size > 0, evidence: file }); } catch { checks.push({ name: `artifact:${path.basename(file)}`, passed: false, evidence: file }); } }
    for (const check of input.checks as JsonObject[]) checks.push({ name: String(check.name ?? 'recorded-check'), passed: check.passed === true, evidence: String(check.evidence ?? 'recorded tool result') });
    const passed = checks.length > 0 && checks.every(check => check.passed === true); const outputRefs = await writeOutputs(context.cwd, { 'reports/VERIFY.json': `${JSON.stringify({ passed, checks, reviewer: 'independent-rules', verifiedAt: new Date().toISOString() }, null, 2)}\n` });
    if (!passed) throw new AutopilotError('独立规则验收失败', 'TOOL_VERIFICATION_FAILED', 422);
    return { passed, checks, outputRefs };
  });
  registry.register(definition('reconstruct:workspace', 'Create a minimal, honest workspace handoff without executing unknown code', objectSchema({ goal: { type: 'string' } }, ['goal']), objectSchema({ outputRefs: refsSchema }, ['outputRefs']), ['write-task-artifacts'], ['MARKDOWN', 'JSON'], { timeoutMs: 30_000, maxDiskMB: 64 }), async (input, context) => ({ outputRefs: await writeOutputs(context.cwd, { 'workspace/BUILD-PLAN.md': `# 构建计划\n\n${String(input.goal)}\n\n仅允许在隔离工作区执行 npm run build/test/package。未提供可信工程时不会伪造构建成功。\n` }) }));
  for (const [name, script] of [['build:allowlisted', 'build'], ['test:allowlisted', 'test'], ['package:allowlisted', 'package']] as const) registry.register(definition(name, `Run only npm run ${script} in an isolated task cwd`, objectSchema({ cwd: { type: 'string' } }, ['cwd']), objectSchema({ exitCode: { type: 'number' }, stdout: { type: 'string' }, stderr: { type: 'string' }, outputRefs: refsSchema }, ['exitCode', 'stdout', 'stderr', 'outputRefs']), ['execute-allowlisted-build'], ['NODE'], { timeoutMs: 300_000, maxDiskMB: 1024 }), async (input, context) => {
    const result = await runAllowlistedCommand(script, String(input.cwd), context.workspaceRoot, context.budget, context.signal); return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, outputRefs: [] };
  });
  return registry;
}

export const createToolRegistry = createDefaultToolRegistry;

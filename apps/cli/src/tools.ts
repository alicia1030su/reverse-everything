import { lstat, open, readFile, realpath, stat, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/server';
import { VERSION } from './version.js';
import { z } from 'zod';
import { api, apiBytes } from './client.js';

const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] });
const defaultMaxUploadBytes = 100 * 1024 * 1024;
const maxBase64Length = Math.ceil(defaultMaxUploadBytes / 3) * 4;

function uploadLimit(): number {
  const configured = Number(process.env.RE_MAX_UPLOAD_MB ?? 100);
  if (!Number.isFinite(configured) || configured <= 0) throw new Error('RE_MAX_UPLOAD_MB must be a positive number');
  return Math.floor(configured * 1024 * 1024);
}

function decodeBase64(value: string): Uint8Array {
  const limit = uploadLimit();
  if (value.length > Math.ceil(limit / 3) * 4) throw new Error('Upload exceeds configured size limit');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error('contentBase64 is not valid base64');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > limit) throw new Error('Upload exceeds configured size limit');
  return new Uint8Array(bytes);
}

const maxMcpDownloadBytes = 100 * 1024 * 1024;
const defaultMcpDownloadBytes = 5 * 1024 * 1024;

function mcpDownloadLimit(): number {
  const configured = Number(process.env.RE_MCP_DOWNLOAD_MAX_MB ?? defaultMcpDownloadBytes / (1024 * 1024));
  if (!Number.isInteger(configured) || configured <= 0 || configured * 1024 * 1024 > maxMcpDownloadBytes) {
    throw new Error('RE_MCP_DOWNLOAD_MAX_MB must be an integer from 1 to 100');
  }
  return configured * 1024 * 1024;
}

async function readBoundedDownload(response: Response): Promise<Buffer> {
  const limit = mcpDownloadLimit();
  const contentLength = Number(response.headers.get('content-length'));
  if (response.headers.has('content-length') && (!Number.isSafeInteger(contentLength) || contentLength < 0 || contentLength > limit)) {
    throw new Error('Artifact exceeds the configured MCP download size limit');
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error('Artifact exceeds the configured MCP download size limit');
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

async function saveDownload(destination: string, bytes: Buffer): Promise<string> {
  if (!process.env.RE_MCP_DOWNLOAD_ROOTS?.split(path.delimiter).some(root => root.trim())) {
    throw new Error('RE_MCP_DOWNLOAD_ROOTS is not configured');
  }
  const roots = process.env.RE_MCP_DOWNLOAD_ROOTS.split(path.delimiter).map(root => root.trim()).filter(Boolean).map(root => path.resolve(root));
  const resolvedRoots = await Promise.all(roots.map(async root => {
    try {
      return await realpath(root);
    } catch {
      throw new Error('RE_MCP_DOWNLOAD_ROOTS contains an inaccessible path');
    }
  }));
  const requested = path.resolve(destination);
  const parent = await realpath(path.dirname(requested));
  if (!resolvedRoots.some(root => parent === root || parent.startsWith(root + path.sep))) {
    throw new Error('Download destination is outside allowed roots');
  }
  const target = path.join(parent, path.basename(requested));
  if (target === parent || resolvedRoots.includes(target)) throw new Error('Download destination must name a new file');
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink()) throw new Error('Download destination must not be a symbolic link');
    throw new Error('Download destination already exists');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const file = await open(target, 'wx', 0o600);
  try {
    await file.writeFile(bytes);
  } catch (error) {
    await unlink(target).catch(() => undefined);
    throw error;
  } finally {
    await file.close();
  }
  return target;
}

async function readAllowedFile(filePath: string): Promise<Uint8Array> {
  const roots = (process.env.RE_MCP_ALLOWED_ROOTS ?? '').split(path.delimiter).filter(Boolean).map(root => path.resolve(root));
  if (!roots.length) throw new Error('RE_MCP_ALLOWED_ROOTS is not configured');
  const resolvedRoots = await Promise.all(roots.map(async root => {
    try {
      return await realpath(root);
    } catch {
      throw new Error('RE_MCP_ALLOWED_ROOTS contains an inaccessible path');
    }
  }));
  const target = await realpath(path.resolve(filePath));
  if (!resolvedRoots.some(root => target === root || target.startsWith(root + path.sep))) throw new Error('File path is outside allowed roots');
  const info = await stat(target);
  if (!info.isFile()) throw new Error('Upload path must be a regular file');
  if (info.size > uploadLimit()) throw new Error('Upload exceeds configured size limit');
  return new Uint8Array(await readFile(target));
}

export function createMcpServer(localFileRead = false): McpServer {
  const server = new McpServer({ name: 'reverse-everything', version: VERSION }, {
    instructions: 'Analyze only targets the user is authorized to inspect. Tool evidence is authoritative; model output is inference. Never bypass access controls.',
  });
  const register = (name: string, description: string, shape: Record<string, z.ZodTypeAny>, handler: (args: Record<string, unknown>) => Promise<unknown>) =>
    server.registerTool(name, { description, inputSchema: shape }, async args => text(await handler(args as Record<string, unknown>)));
  register('autopilot_create', 'Create an evidence-first Autopilot task from a natural-language goal. Returns discovery questions and contract/plan approval state; never assume permission.', {
    projectId: z.string(), prompt: z.string().max(16000), idempotencyKey: z.string().max(128).optional(),
    uploadIds: z.array(z.string()).max(64).optional(), paths: z.array(z.string()).max(64).optional(), urls: z.array(z.string()).max(64).optional(),
  }, args => api('/api/autopilot/tasks', { method: 'POST', body: JSON.stringify({ projectId: args.projectId, prompt: args.prompt, idempotencyKey: args.idempotencyKey, uploadIds: args.uploadIds, paths: args.paths, urls: args.urls }) }));
  register('autopilot_list', 'List Autopilot tasks for one project', { projectId: z.string(), limit: z.number().int().min(1).max(500).optional(), offset: z.number().int().min(0).optional() }, args => api(`/api/autopilot/tasks?projectId=${encodeURIComponent(String(args.projectId))}&limit=${Number(args.limit ?? 100)}&offset=${Number(args.offset ?? 0)}`));
  register('autopilot_get', 'Get Autopilot intent questions contract plan status and progress', { taskId: z.string() }, args => api(`/api/autopilot/tasks/${encodeURIComponent(String(args.taskId))}`));
  register('autopilot_answer', 'Answer discovery questions; explicit approval flags are required to accept the goal contract or execution plan', { taskId: z.string(), answers: z.record(z.string(), z.unknown()), approveContract: z.boolean().optional(), approvePlan: z.boolean().optional() }, args => api(`/api/autopilot/tasks/${encodeURIComponent(String(args.taskId))}/answers`, { method: 'POST', body: JSON.stringify({ answers: args.answers, approveContract: args.approveContract, approvePlan: args.approvePlan }) }));
  register('autopilot_confirm', 'Explicitly confirm the current goal contract or execution plan', { taskId: z.string(), kind: z.enum(['contract', 'plan']) }, args => api(`/api/autopilot/tasks/${encodeURIComponent(String(args.taskId))}/answers`, { method: 'POST', body: JSON.stringify({ answers: {}, ...(args.kind === 'contract' ? { approveContract: true } : { approveContract: true, approvePlan: true }) }) }));
  register('autopilot_action', 'Pause resume or cancel an Autopilot task at a safe checkpoint', { taskId: z.string(), action: z.enum(['pause', 'resume', 'cancel']) }, args => api(`/api/autopilot/tasks/${encodeURIComponent(String(args.taskId))}/${String(args.action)}`, { method: 'POST' }));
  register('autopilot_messages', 'Read persisted user assistant and system messages for an Autopilot task', { taskId: z.string() }, args => api(`/api/autopilot/tasks/${encodeURIComponent(String(args.taskId))}/messages`));
  register('autopilot_artifacts', 'List verified Autopilot delivery artifacts with size and SHA-256', { taskId: z.string() }, args => api(`/api/autopilot/tasks/${encodeURIComponent(String(args.taskId))}/artifacts`));
  register('autopilot_tutorial', 'Read the verified Autopilot tutorial artifact as UTF-8 text', { taskId: z.string() }, async args => {
    const artifacts = await api<Array<{ name: string }>>(`/api/autopilot/tasks/${encodeURIComponent(String(args.taskId))}/artifacts`);
    const tutorial = artifacts.find(item => /^(tutorial|getting-started|使用教程)\.md$/i.test(item.name)) ?? artifacts.find(item => item.name === '____.md') ?? artifacts.find(item => /tutorial/i.test(item.name));
    if (!tutorial) throw new Error('Tutorial artifact is not ready');
    const response = await apiBytes(`/api/autopilot/tasks/${encodeURIComponent(String(args.taskId))}/artifacts/${encodeURIComponent(tutorial.name)}`);
    return { name: tutorial.name, sha256: response.headers.get('x-artifact-sha256'), content: await response.text() };
  });
  register('autopilot_download', 'Download a verified Autopilot artifact. Returns bounded base64 without writing files by default. Saving requires an explicit destination in stdio mode and RE_MCP_DOWNLOAD_ROOTS; the parent must resolve inside an allowed root and the target must be a new non-symlink file. Size is bounded by RE_MCP_DOWNLOAD_MAX_MB (1-100, default 5).', {
    taskId: z.string(), name: z.string(), destination: z.string().optional(),
  }, async args => {
    const response = await apiBytes(`/api/autopilot/tasks/${encodeURIComponent(String(args.taskId))}/artifacts/${encodeURIComponent(String(args.name))}`);
    const bytes = await readBoundedDownload(response);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (args.destination !== undefined) {
      if (!localFileRead) throw new Error('Saving downloads is disabled for HTTP MCP');
      return { saved: await saveDownload(String(args.destination), bytes), sha256 };
    }
    return { name: args.name, sha256, contentBase64: bytes.toString('base64') };
  });
  register('list_projects', 'List local projects', {}, () => api('/api/projects'));
  register('create_project', 'Create an authorized project', {
    name: z.string(),
    kind: z.enum(['website', 'software', 'game', 'security', 'protocol', 'hardware', 'firmware', 'console']),
    target: z.string().optional(),
    authorized: z.literal(true),
  }, args => api('/api/projects', { method: 'POST', body: JSON.stringify({ name: args.name, kind: args.kind, target: args.target ?? '', authorizationConfirmed: true }) }));
  register('upload_file', 'Upload base64 content, or a local path only when stdio allowed roots permit it', {
    projectId: z.string(),
    filePath: z.string().optional(),
    fileName: z.string().optional(),
    contentBase64: z.string().max(maxBase64Length).optional(),
  }, async args => {
    let bytes: Uint8Array;
    let fileName = String(args.fileName ?? 'upload.bin');
    if (args.contentBase64 !== undefined) {
      bytes = decodeBase64(String(args.contentBase64));
    } else {
      if (!localFileRead || !args.filePath) throw new Error('HTTP MCP requires contentBase64; local paths are disabled');
      bytes = await readAllowedFile(String(args.filePath));
      fileName = path.basename(String(args.filePath));
    }
    const uploadBytes = new Uint8Array(bytes);
    const form = new FormData();
    form.append('file', new Blob([uploadBytes.buffer]), fileName);
    return api(`/api/projects/${String(args.projectId)}/uploads`, { method: 'POST', body: form });
  });
  register('create_task', 'Create a task through the shared engine', {
    projectId: z.string(),
    adapter: z.enum(['website', 'file', 'security', 'game', 'network', 'apk', 'ghidra', 'hardware', 'firmware', 'console', 'legacy']),
    options: z.record(z.string(), z.unknown()).optional(),
    confirmLocal: z.literal(true).optional(),
  }, args => {
    const options = { ...(args.options ?? {}) } as Record<string, unknown>;
    if ('confirmLocal' in options) throw new Error('Use the top-level confirmLocal=true argument');
    if (options.allowLocal === true) {
      if (args.confirmLocal !== true) throw new Error('Local target requires explicit confirmLocal=true');
      options.confirmLocal = true;
    }
    return api(`/api/projects/${String(args.projectId)}/tasks`, { method: 'POST', body: JSON.stringify({ adapter: args.adapter, options }) });
  });
  register('list_tasks', 'List tasks', {}, () => api('/api/tasks'));
  register('get_task', 'Get stages evidence findings logs and artifacts', { taskId: z.string() }, args => api(`/api/tasks/${String(args.taskId)}`));
  register('task_action', 'Pause resume cancel or retry', { taskId: z.string(), action: z.enum(['pause', 'resume', 'cancel', 'retry']) }, args => api(`/api/tasks/${String(args.taskId)}/${String(args.action)}`, { method: 'POST' }));
  register('get_report', 'Get task detail including generated Markdown report', { taskId: z.string() }, args => api(`/api/tasks/${String(args.taskId)}`));
  register('list_capabilities', 'List product version adapters and entrypoints', {}, () => api('/api/capabilities'));
  register('get_system_health', 'Get API worker and browser status', {}, () => api('/api/system/status'));
  register('get_resource_metrics', 'Get real API worker and desktop metrics', {}, () => api('/api/resources'));
  register('list_hardware_capabilities', 'Get read-only hardware platform capabilities; no device handles are opened', {}, () => api('/api/hardware/capabilities'));
  register('list_hardware_devices', 'List OS-visible USB identities from the local loopback API only; remote API mode is forbidden', {}, () => api('/api/hardware/devices'));
  register('list_serial_ports', 'List serial ports without opening them or changing DTR/RTS; local loopback only', {}, () => api('/api/hardware/serial'));
  register('get_hardware_report', 'Get an offline hardware analysis task and its evidence/artifacts', { taskId: z.string() }, args => api(`/api/tasks/${String(args.taskId)}`));
  register('list_evidence', 'List paginated evidence for a task', { taskId: z.string(), limit: z.number().optional(), offset: z.number().optional() }, args => api(`/api/tasks/${String(args.taskId)}/evidence?limit=${Number(args.limit ?? 100)}&offset=${Number(args.offset ?? 0)}`));
  register('get_evidence', 'Get evidence by ID', { evidenceId: z.string() }, args => api(`/api/evidence/${String(args.evidenceId)}`));
  register('get_task_events', 'Get persisted task event history', { taskId: z.string(), after: z.number().optional() }, args => api(`/api/tasks/${String(args.taskId)}/events/history?after=${Number(args.after ?? 0)}`));
  register('get_artifact_manifest', 'Get artifact names hashes and download paths', { taskId: z.string() }, args => api(`/api/tasks/${String(args.taskId)}/artifact-manifest`));
  register('list_cache_entries', 'List cache entries; destructive cleanup is not exposed', { projectId: z.string().optional(), limit: z.number().optional(), offset: z.number().optional() }, args => api(`/api/cache?projectId=${encodeURIComponent(String(args.projectId ?? ''))}&limit=${Number(args.limit ?? 100)}&offset=${Number(args.offset ?? 0)}`));
  register('get_cache_statistics', 'Get cache hit rate size and integrity counters', {}, () => api('/api/cache/stats'));
  register('list_console_devices', 'List supported console research device categories and evidence boundaries', {}, () => api('/api/console/devices'));
  register('get_console_device', 'Get one console device category and its research support matrix', { deviceId: z.string() }, args => api(`/api/console/devices/${encodeURIComponent(String(args.deviceId))}`));
  register('diagnose_console_usb', 'Diagnose a read-only USB enumeration summary without opening a device', { summary: z.record(z.string(), z.unknown()) }, args => api('/api/console/diagnose-usb', { method: 'POST', body: JSON.stringify(args.summary) }));
  register('save_console_profile', 'Create or update an evidence-graded console research profile', { projectId: z.string(), profile: z.record(z.string(), z.unknown()) }, args => api(`/api/projects/${String(args.projectId)}/console-profile`, { method: 'PUT', body: JSON.stringify(args.profile) }));
  register('get_console_profile', 'Get a console research profile', { projectId: z.string() }, args => api(`/api/projects/${String(args.projectId)}/console-profile`));
  register('create_authorization_scope', 'Create an explicit authorization scope for a project', { projectId: z.string(), target: z.string(), scope: z.array(z.string()), allowedInterfaces: z.array(z.string()), allowedOperations: z.array(z.string()), dataAccess: z.array(z.string()), remoteAiAllowed: z.boolean().optional(), expiresAt: z.string().optional() }, args => api(`/api/projects/${String(args.projectId)}/authorizations`, { method: 'POST', body: JSON.stringify({ target: args.target, scope: args.scope, allowedInterfaces: args.allowedInterfaces, allowedOperations: args.allowedOperations, dataAccess: args.dataAccess, remoteAiAllowed: args.remoteAiAllowed, expiresAt: args.expiresAt }) }));
  register('list_authorization_scopes', 'List authorization scopes for a project', { projectId: z.string() }, args => api(`/api/projects/${String(args.projectId)}/authorizations`));
  register('revoke_authorization_scope', 'Revoke an authorization scope', { authorizationId: z.string() }, args => api(`/api/authorizations/${String(args.authorizationId)}/revoke`, { method: 'POST' }));
  register('create_analysis_plan', 'Create a deterministic bounded analysis plan', { projectId: z.string(), mode: z.enum(['beginner','professional','agent']), objective: z.string(), uploadId: z.string().optional(), fileName: z.string().optional(), size: z.number().optional(), headHex: z.string().optional(), declaredKind: z.string().optional(), authorizationId: z.string().optional(), authorization: z.record(z.string(), z.unknown()).optional(), budget: z.record(z.string(), z.unknown()).optional(), maxSteps: z.number().optional(), maxDepth: z.number().optional(), adapterAllowlist: z.array(z.string()).optional() }, args => api(`/api/projects/${String(args.projectId)}/plans`, { method: 'POST', body: JSON.stringify({ mode: args.mode, objective: args.objective, uploadId: args.uploadId, fileName: args.fileName, size: args.size, headHex: args.headHex, declaredKind: args.declaredKind, authorizationId: args.authorizationId, authorization: args.authorization, budget: args.budget, maxSteps: args.maxSteps, maxDepth: args.maxDepth, adapterAllowlist: args.adapterAllowlist }) }));
  register('list_analysis_plans', 'List analysis plans for a project', { projectId: z.string() }, args => api(`/api/projects/${String(args.projectId)}/plans`));
  register('get_analysis_plan', 'Get an analysis plan', { planId: z.string() }, args => api(`/api/plans/${String(args.planId)}`));
  register('execute_analysis_plan', 'Execute a verified analysis plan through the shared task engine', { planId: z.string() }, args => api(`/api/plans/${String(args.planId)}/execute`, { method: 'POST' }));
  register('list_analysis_tools', 'List analyzer capabilities and installation boundaries', {}, () => api('/api/tools'));
  register('list_demos', 'List built-in automated acceptance demos', {}, () => api('/api/demos'));
  register('run_demo', 'Run a built-in demo through the shared task engine', { name: z.string() }, args => api(`/api/demos/${encodeURIComponent(String(args.name))}/run`, { method: 'POST' }));
  register('get_plain_report', 'Get a plain-language report derived from task evidence', { taskId: z.string(), format: z.enum(['markdown','json','html']).optional() }, args => api(`/api/tasks/${String(args.taskId)}/report/plain?format=${encodeURIComponent(String(args.format ?? 'markdown'))}`));
  register('list_game_profiles', 'List game revival research profiles and evidence levels', {}, () => api('/api/game/profiles'));
  register('save_game_profile', 'Create or update an authorized game revival profile', { projectId: z.string(), profile: z.record(z.string(), z.unknown()) }, args => api(`/api/projects/${String(args.projectId)}/game-profile`, { method: 'PUT', body: JSON.stringify(args.profile) }));
  register('scan_game_directory', 'Incrementally scan an authorized local game directory without uploading its files', { projectId: z.string(), rootPath: z.string(), authorized: z.literal(true) }, args => { if(args.authorized!==true)throw new Error('Explicit authorization is required'); return api(`/api/projects/${String(args.projectId)}/game-scan`, { method: 'POST', body: JSON.stringify({ rootPath: args.rootPath }) }); });
  register('create_game_server_spec', 'Create an evidence-bounded independent game server specification', { projectId: z.string() }, args => api(`/api/projects/${String(args.projectId)}/game-spec`, { method: 'POST', body: '{}' }));
  register('list_game_rebuilds', 'List generated multiplayer server rebuild and validation reports', {}, () => api('/api/game/rebuilds'));
  register('create_game_rebuild', 'Generate, build and validate an independent multiplayer game server', { specId: z.string() }, args => api('/api/game/rebuilds', { method: 'POST', body: JSON.stringify({ specId: args.specId }) }));
  register('get_game_rebuild', 'Get multiplayer server validation evidence and deployment readiness', { rebuildId: z.string() }, args => api(`/api/game/rebuilds/${encodeURIComponent(String(args.rebuildId))}`));
  return server;
}

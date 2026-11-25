import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/server';
import { VERSION } from './version.js';
import { z } from 'zod';
import { api } from './client.js';

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
  register('list_projects', 'List local projects', {}, () => api('/api/projects'));
  register('create_project', 'Create an authorized project', {
    name: z.string(),
    kind: z.enum(['website', 'software', 'game', 'security', 'protocol', 'hardware', 'firmware']),
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
    adapter: z.enum(['website', 'file', 'security', 'game', 'network', 'apk', 'ghidra', 'hardware', 'firmware']),
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
  return server;
}

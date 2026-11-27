import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const mocks = vi.hoisted(() => ({
  tools: new Map<string, { description: string; handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> }>(),
  apiBytes: vi.fn(),
}));

vi.mock('@modelcontextprotocol/server', () => ({
  McpServer: class {
    registerTool(name: string, definition: { description: string }, handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>) {
      mocks.tools.set(name, { description: definition.description, handler });
    }
  },
}));
vi.mock('../../apps/cli/src/client.js', () => ({ api: vi.fn(), apiBytes: mocks.apiBytes }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    lstat: vi.fn(async (target: Parameters<typeof actual.lstat>[0], options?: Parameters<typeof actual.lstat>[1]) => {
      if (String(target).endsWith('symbolic-link.bin')) return { isSymbolicLink: () => true } as Awaited<ReturnType<typeof actual.lstat>>;
      return actual.lstat(target, options);
    }),
  };
});

import { createMcpServer } from '../../apps/cli/src/tools.js';

const originalRoots = process.env.RE_MCP_DOWNLOAD_ROOTS;
const originalLimit = process.env.RE_MCP_DOWNLOAD_MAX_MB;
const originalToken = process.env.RE_API_TOKEN;
let sandbox: string;
let allowed: string;
let outside: string;

async function invoke(destination?: string, localFileRead = true) {
  createMcpServer(localFileRead);
  const tool = mocks.tools.get('autopilot_download')!;
  const result = await tool.handler({ taskId: 'task', name: 'artifact.bin', ...(destination === undefined ? {} : { destination }) });
  return { tool, value: JSON.parse(result.content[0].text) as Record<string, unknown> };
}

beforeEach(async () => {
  delete process.env.RE_MCP_DOWNLOAD_ROOTS;
  delete process.env.RE_MCP_DOWNLOAD_MAX_MB;
  process.env.RE_API_TOKEN = 'test-token';
  mocks.tools.clear();
  mocks.apiBytes.mockReset();
  sandbox = await mkdtemp(path.join(os.tmpdir(), 're-mcp-download-'));
  allowed = path.join(sandbox, 'allowed');
  outside = path.join(sandbox, 'outside');
  await mkdir(allowed);
  await mkdir(outside);
});
afterEach(async () => {
  vi.clearAllMocks();
  if (originalRoots === undefined) delete process.env.RE_MCP_DOWNLOAD_ROOTS; else process.env.RE_MCP_DOWNLOAD_ROOTS = originalRoots;
  if (originalLimit === undefined) delete process.env.RE_MCP_DOWNLOAD_MAX_MB; else process.env.RE_MCP_DOWNLOAD_MAX_MB = originalLimit;
  if (originalToken === undefined) delete process.env.RE_API_TOKEN; else process.env.RE_API_TOKEN = originalToken;
  await rm(sandbox, { recursive: true, force: true });
});

describe('MCP download filesystem safety', () => {
  it('returns bounded base64 by default without creating a file', async () => {
    const bytes = Buffer.from('verified artifact');
    mocks.apiBytes.mockResolvedValue(new Response(bytes, { headers: { 'x-artifact-sha256': 'wrong-header' } }));
    const destination = path.join(allowed, 'artifact.bin');
    const { value } = await invoke();
    expect(value.contentBase64).toBe(bytes.toString('base64'));
    expect(value.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    await expect(lstat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(mocks.tools.get('autopilot_download')!.description).toContain('RE_MCP_DOWNLOAD_ROOTS');
  });

  it('rejects a destination when download roots are not configured', async () => {
    mocks.apiBytes.mockResolvedValue(new Response('artifact'));
    await expect(invoke(path.join(allowed, 'artifact.bin'))).rejects.toThrow(/RE_MCP_DOWNLOAD_ROOTS/);
    await expect(lstat(path.join(allowed, 'artifact.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects destinations outside allowed roots and traversal outside the root', async () => {
    process.env.RE_MCP_DOWNLOAD_ROOTS = allowed;
    mocks.apiBytes.mockResolvedValue(new Response('artifact'));
    await expect(invoke(path.join(outside, 'artifact.bin'))).rejects.toThrow(/outside allowed roots/);
    await expect(invoke(path.join(allowed, '..', 'outside', 'artifact.bin'))).rejects.toThrow(/outside allowed roots/);
  });

  it('rejects existing files without overwriting them', async () => {
    process.env.RE_MCP_DOWNLOAD_ROOTS = allowed;
    mocks.apiBytes.mockResolvedValue(new Response('new'));
    const destination = path.join(allowed, 'existing.bin');
    await writeFile(destination, 'original');
    await expect(invoke(destination)).rejects.toThrow(/already exists/);
    expect(await readFile(destination, 'utf8')).toBe('original');
  });

  it('rejects symbolic-link targets', async () => {
    process.env.RE_MCP_DOWNLOAD_ROOTS = allowed;
    mocks.apiBytes.mockResolvedValue(new Response('artifact'));
    const destination = path.join(allowed, 'symbolic-link.bin');
    await expect(invoke(destination)).rejects.toThrow(/symbolic link/);
    await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a real symbolic link when supported by the host', async () => {
    process.env.RE_MCP_DOWNLOAD_ROOTS = allowed;
    mocks.apiBytes.mockResolvedValue(new Response('artifact'));
    const target = path.join(outside, 'target.bin');
    const destination = path.join(allowed, 'real-link.bin');
    await writeFile(target, 'original');
    try {
      await symlink(target, destination, 'file');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
      throw error;
    }
    await expect(invoke(destination)).rejects.toThrow(/symbolic link/);
    expect(await readFile(target, 'utf8')).toBe('original');
  });

  it('saves exclusively inside an allowed root with mode 0600 and correct hash', async () => {
    process.env.RE_MCP_DOWNLOAD_ROOTS = allowed;
    const bytes = Buffer.from([0, 1, 2, 255, 42]);
    mocks.apiBytes.mockResolvedValue(new Response(bytes));
    const destination = path.join(allowed, 'nested', 'artifact.bin');
    await mkdir(path.dirname(destination));
    const { value } = await invoke(destination);
    expect(await realpath(String(value.saved))).toBe(await realpath(destination));
    expect(value.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(await readFile(destination)).toEqual(bytes);
    expect((await lstat(destination)).mode & 0o777).toBe(process.platform === 'win32' ? 0o666 : 0o600);
  });

  it('rejects HTTP MCP saving and oversized content before writing', async () => {
    process.env.RE_MCP_DOWNLOAD_ROOTS = allowed;
    process.env.RE_MCP_DOWNLOAD_MAX_MB = '1';
    mocks.apiBytes.mockResolvedValue(new Response('artifact'));
    const destination = path.join(allowed, 'artifact.bin');
    await expect(invoke(destination, false)).rejects.toThrow(/disabled for HTTP MCP/);
    mocks.apiBytes.mockResolvedValue(new Response(new Uint8Array(1024 * 1024 + 1)));
    await expect(invoke(destination)).rejects.toThrow(/size limit/);
    await expect(lstat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

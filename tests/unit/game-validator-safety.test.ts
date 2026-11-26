import { once } from 'node:events';
import { createServer } from 'node:http';
import { access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { cleanupDockerProject, connectValidationClient, fetchWithTimeout, minimalProcessEnv, runValidationCommand } from '../../packages/game-revival/src/validator.js';

async function socketServer(onConnection: (socket: WebSocket) => void): Promise<{ url: string; close: () => Promise<void> }> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  server.on('connection', onConnection);
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('无监听地址');
  return {
    url: `ws://127.0.0.1:${address.port}`,
    close: () => new Promise(resolve => { for (const socket of server.clients) socket.terminate(); server.close(() => resolve()); }),
  };
}

describe('验证器安全边界', () => {
  it('保留 Electron Node shim 标记以启动打包环境生成服务', () => {
    const previous = process.env.ELECTRON_RUN_AS_NODE;
    process.env.ELECTRON_RUN_AS_NODE = '1';
    try { expect(minimalProcessEnv().ELECTRON_RUN_AS_NODE).toBe('1'); } finally { if (previous === undefined) delete process.env.ELECTRON_RUN_AS_NODE; else process.env.ELECTRON_RUN_AS_NODE = previous; }
  });

  it('非法 JSON 拒绝 waiter 并关闭 socket，不产生未捕获异常', async () => {
    let client: WebSocket | undefined;
    const server = await socketServer(socket => {
      client = socket;
      socket.on('message', () => socket.send('{not-json'));
    });
    try {
      await expect(connectValidationClient(server.url, 'u', 'p', 'register', { handshakeTimeoutMs: 500 })).rejects.toThrow(/JSON/);
      if (client && client.readyState !== WebSocket.CLOSED) await once(client, 'close');
      expect(client?.readyState).toBe(WebSocket.CLOSED);
    } finally { await server.close(); }
  });

  it('WS 握手总超时覆盖连接与认证等待', async () => {
    const server = await socketServer(() => undefined);
    try {
      await expect(connectValidationClient(server.url, 'u', 'p', 'register', { handshakeTimeoutMs: 30 })).rejects.toThrow(/握手.*超时/);
    } finally { await server.close(); }
  });

  it('fetch 使用有界超时', async () => {
    const server = createServer((_request, response) => {
      const timer = setTimeout(() => response.end('late'), 500);
      response.on('close', () => clearTimeout(timer));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('无监听地址');
    try {
      await expect(fetchWithTimeout(`http://127.0.0.1:${address.port}`, {}, 20)).rejects.toThrow();
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it.each(['timeout', 'abort'] as const)('命令 %s 会等待关闭并终止整个子进程树', async mode => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 're-validator-tree-'));
    const marker = path.join(directory, 'descendant-survived');
    const controller = new AbortController();
    const descendant = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'alive'), 400)`;
    const script = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'ignore' }); setInterval(() => {}, 1000)`;
    try {
      const pending = runValidationCommand(process.execPath, ['-e', script], directory, {
        timeoutMs: mode === 'timeout' ? 50 : 5_000, signal: controller.signal,
      });
      if (mode === 'abort') setTimeout(() => controller.abort(), 50);
      await expect(pending).rejects.toThrow(/超时|取消/);
      await new Promise(resolve => setTimeout(resolve, 600));
      await expect(access(marker)).rejects.toThrow();
    } finally {
      controller.abort();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('Compose 清理失败后删除项目容器、卷与网络，全部核验通过才成功', async () => {
    const calls: string[][] = [];
    let containerQueries = 0;
    let volumeQueries = 0;
    let networkQueries = 0;
    const run = async (_command: string, args: string[]): Promise<string> => {
      calls.push(args);
      if (args.includes('down')) throw new Error('compose down failed');
      if (args[0] === 'ps') return ++containerQueries === 1 ? 'container-from-label\n' : '';
      if (args[0] === 'volume' && args[1] === 'ls') return ++volumeQueries === 1 ? 'project-volume\n' : '';
      if (args[0] === 'network' && args[1] === 'ls') return ++networkQueries === 1 ? 'project-network\n' : '';
      return '';
    };
    await expect(cleanupDockerProject({
      project: 'revival-test', root: process.cwd(), containerIds: ['known-container'], timeoutMs: 100,
      runCommand: run,
    })).resolves.toContain('project-volume');
    expect(calls.filter(args => args.includes('down'))).toHaveLength(2);
    expect(calls.find(args => args[0] === 'rm')).toEqual(expect.arrayContaining(['known-container', 'container-from-label']));
    expect(calls.find(args => args[0] === 'volume' && args[1] === 'rm')).toContain('project-volume');
    expect(calls.find(args => args[0] === 'network' && args[1] === 'rm')).toContain('project-network');
    expect(containerQueries).toBe(3);
    expect(volumeQueries).toBe(2);
    expect(networkQueries).toBe(2);
  });

  it('仅删除容器但卷或网络残留时仍报告清理失败', async () => {
    let containerQueries = 0;
    const run = async (_command: string, args: string[]): Promise<string> => {
      if (args.includes('down')) throw new Error('compose down failed');
      if (args[0] === 'ps') return ++containerQueries === 1 ? 'residual-container\n' : '';
      if (args[0] === 'volume' || args[0] === 'network') return args.includes('ls') ? 'residual-resource\n' : '';
      return '';
    };
    await expect(cleanupDockerProject({ project: 'revival-test', root: process.cwd(), timeoutMs: 100, runCommand: run })).rejects.toThrow(/资源仍残留: 卷、网络/);
  });

  it('所有清理路径失败时明确报告而不是静默成功', async () => {
    const run = async (_command: string, args: string[]): Promise<string> => {
      if (args.includes('ps')) return '';
      throw new Error(`failed ${args[0]}`);
    };
    await expect(cleanupDockerProject({ project: 'revival-test', root: process.cwd(), containerIds: [], timeoutMs: 100, runCommand: run })).rejects.toThrow(/清理失败/);
  });
});

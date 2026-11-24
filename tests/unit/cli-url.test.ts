import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, apiUrl, mcpUrl, redactToken, validateServiceUrl } from '../../apps/cli/src/client.js';

const original = { api: process.env.RE_API_URL, mcp: process.env.RE_MCP_URL, insecure: process.env.RE_ALLOW_INSECURE_REMOTE, token: process.env.RE_API_TOKEN };
beforeEach(() => {
  delete process.env.RE_API_URL;
  delete process.env.RE_MCP_URL;
  delete process.env.RE_ALLOW_INSECURE_REMOTE;
  delete process.env.RE_API_TOKEN;
});
afterEach(() => {
  vi.unstubAllGlobals();
  if (original.api === undefined) delete process.env.RE_API_URL; else process.env.RE_API_URL = original.api;
  if (original.mcp === undefined) delete process.env.RE_MCP_URL; else process.env.RE_MCP_URL = original.mcp;
  if (original.insecure === undefined) delete process.env.RE_ALLOW_INSECURE_REMOTE; else process.env.RE_ALLOW_INSECURE_REMOTE = original.insecure;
  if (original.token === undefined) delete process.env.RE_API_TOKEN; else process.env.RE_API_TOKEN = original.token;
});

describe('CLI and MCP URL policy', () => {
  it('allows only HTTP and HTTPS and rejects embedded credentials', () => {
    for (const raw of ['file:///tmp/socket', 'ftp://example.test/file', 'javascript:alert(1)']) {
      expect(() => validateServiceUrl(raw, 'api')).toThrow(/http or https/);
      expect(() => validateServiceUrl(raw, 'mcp')).toThrow(/http or https/);
    }
    expect(() => apiUrlWith('https://user:password@example.test')).toThrow(/credentials/);
    expect(() => validateServiceUrl('https://user:password@example.test/mcp', 'mcp')).toThrow(/credentials/);
  });

  it('requires HTTPS for remote API and MCP unless insecure remote access is explicit', () => {
    for (const kind of ['api', 'mcp'] as const) {
      delete process.env.RE_ALLOW_INSECURE_REMOTE;
      const remoteHttp = kind === 'api' ? 'http://api.example.test:4173' : 'http://mcp.example.test/mcp';
      const remoteHttps = kind === 'api' ? 'https://api.example.test:4173' : 'https://mcp.example.test/mcp';
      const readUrl = kind === 'api' ? apiUrl : mcpUrl;
      if (kind === 'api') process.env.RE_API_URL = remoteHttp;
      else process.env.RE_MCP_URL = remoteHttp;

      expect(readUrl).toThrow(/requires HTTPS/);
      process.env.RE_ALLOW_INSECURE_REMOTE = 'TRUE';
      expect(readUrl).toThrow(/requires HTTPS/);
      process.env.RE_ALLOW_INSECURE_REMOTE = 'true';
      expect(readUrl()).toBe(remoteHttp);
      delete process.env.RE_ALLOW_INSECURE_REMOTE;
      if (kind === 'api') process.env.RE_API_URL = remoteHttps;
      else process.env.RE_MCP_URL = remoteHttps;
      expect(readUrl()).toBe(remoteHttps);
    }
  });

  it('allows loopback API and MCP HTTP', () => {
    for (const host of ['127.0.0.1', '127.0.0.2', 'localhost', 'dev.localhost', '[::1]']) {
      process.env.RE_API_URL = 'http://' + host + ':4173';
      process.env.RE_MCP_URL = 'http://' + host + ':4174/mcp';
      expect(apiUrl()).toBe('http://' + host + ':4173');
      expect(mcpUrl()).toBe('http://' + host + ':4174/mcp');
    }
  });

  it('does not send the bearer token when remote API HTTP is rejected', async () => {
    process.env.RE_API_URL = 'http://api.example.test:4173';
    process.env.RE_API_TOKEN = 'cli-url-test-secret';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(api('/api/test')).rejects.toThrow(/requires HTTPS/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('redacts bearer and exact token values from errors', () => {
    expect(redactToken('Authorization: Bearer abc.def.ghi', 'abc.def.ghi')).not.toContain('abc.def.ghi');
    expect(redactToken('token=super-secret', 'super-secret')).toBe('token=[REDACTED]');

    const secret = 'cli-url-network-secret';
    process.env.RE_API_URL = 'http://127.0.0.1:4173';
    process.env.RE_API_TOKEN = secret;
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error(`Authorization: Bearer ${secret}`)));
    return api('/api/test').then(
      () => { throw new Error('Expected API request to fail'); },
      (error: unknown) => {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).not.toContain(secret);
        expect((error as Error).message).toContain('Bearer [REDACTED]');
      },
    );
  });
});

function apiUrlWith(value: string) {
  process.env.RE_API_URL = value;
  return apiUrl();
}

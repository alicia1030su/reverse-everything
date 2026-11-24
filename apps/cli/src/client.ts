import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isIP } from 'node:net';

export class CliError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'CliError';
  }
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (normalized === 'localhost' || normalized.endsWith('.localhost') || normalized === '::1') return true;
  if (isIP(normalized) !== 4) return false;
  return normalized.split('.').map(Number)[0] === 127;
}

export function validateServiceUrl(raw: string, kind: 'api' | 'mcp' = 'api'): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CliError(1, `Invalid ${kind.toUpperCase()} URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new CliError(1, `${kind.toUpperCase()} URL must use http or https`);
  }
  if (url.username || url.password) {
    throw new CliError(1, `${kind.toUpperCase()} URL must not contain credentials`);
  }
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname) && process.env.RE_ALLOW_INSECURE_REMOTE !== 'true') {
    throw new CliError(1, `Remote ${kind.toUpperCase()} HTTP requires HTTPS; set RE_ALLOW_INSECURE_REMOTE=true only for trusted networks`);
  }
  return url.toString().replace(/\/+$/, '');
}

export function apiUrl(): string {
  return validateServiceUrl(process.env.RE_API_URL ?? 'http://127.0.0.1:4173', 'api');
}

export function mcpUrl(): string {
  return validateServiceUrl(process.env.RE_MCP_URL ?? 'http://127.0.0.1:4174/mcp', 'mcp');
}

export async function token(): Promise<string> {
  const environmentToken = process.env.RE_API_TOKEN?.trim();
  if (environmentToken) return environmentToken;
  const file = path.resolve(process.env.RE_DATA_DIR ?? 'data', 'local-token');
  try {
    const value = (await readFile(file, 'utf8')).trim();
    if (value) return value;
  } catch {
    // Fall through to the stable, credential-free error.
  }
  throw new CliError(2, 'Local API token not found. Start Reverse Everything or set RE_API_TOKEN.');
}

export function redactToken(value: unknown, secret = ''): string {
  let text = String(value).replace(/Bearer\s+[^\s"'\x60,;]+/gi, 'Bearer [REDACTED]');
  if (secret) text = text.split(secret).join('[REDACTED]');
  return text;
}

export async function api<T>(route: string, init: RequestInit = {}): Promise<T> {
  const base = apiUrl();
  const authToken = await token();
  const timeout = Number(process.env.RE_CLI_TIMEOUT_MS ?? 120000);
  if (!Number.isFinite(timeout) || timeout <= 0) throw new CliError(1, 'RE_CLI_TIMEOUT_MS must be a positive number');
  let response: Response;
  try {
    response = await fetch(`${base}${route}`, {
      ...init,
      headers: {
        ...(init.body && typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}),
        ...init.headers,
        authorization: `Bearer ${authToken}`,
      },
      signal: init.signal ?? AbortSignal.timeout(timeout),
    });
  } catch (error) {
    throw new CliError(1, redactToken(`Cannot reach ${base}: ${error instanceof Error ? error.message : String(error)}`, authToken));
  }
  const text = await response.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new CliError(1, `Invalid JSON response from ${base}`);
  }
  if (!response.ok) {
    const envelope = data as { error?: { code?: string; message?: string } };
    const message = envelope.error ? `${envelope.error.code ?? 'ERROR'}: ${envelope.error.message ?? text}` : `HTTP ${response.status}: ${text.slice(0, 1000)}`;
    throw new CliError(response.status, redactToken(message, authToken));
  }
  return data as T;
}

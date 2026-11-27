export type MiValue = string | MiValue[] | { [key: string]: MiValue };
export type MiRecord =
  | { kind: 'result'; token?: number; status: string; value?: MiValue }
  | { kind: 'notify'; status: string; value?: MiValue }
  | { kind: 'stream'; channel: 'console' | 'log' | 'target'; value: string }
  | { kind: 'raw'; value: string };

export class MiProtocolError extends Error {
  constructor(message: string) { super(message); this.name = 'MiProtocolError'; }
}

class Cursor {
  position = 0;
  constructor(readonly input: string) {}
  get done(): boolean { return this.position >= this.input.length; }
  peek(): string { return this.input[this.position] ?? ''; }
  take(): string { const char = this.input[this.position++]; if (char === undefined) throw new MiProtocolError('MI 输入意外结束'); return char; }
  expect(char: string): void { if (this.take() !== char) throw new MiProtocolError(`MI 输入期望 ${char}`); }
}

function parseString(cursor: Cursor): string {
  cursor.expect('"');
  let result = '';
  const utf8Bytes: number[] = [];
  const flushBytes = (): void => { if (utf8Bytes.length) { result += new TextDecoder().decode(Uint8Array.from(utf8Bytes)); utf8Bytes.length = 0; } };
  while (!cursor.done) {
    const char = cursor.take();
    if (char === '"') { flushBytes(); return result; }
    if (char !== '\\') { flushBytes(); result += char; continue; }
    const escaped = cursor.take();
    const simple: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', '"': '"' };
    const replacement = simple[escaped];
    if (replacement !== undefined) { flushBytes(); result += replacement; continue; }
    if (/[0-7]/.test(escaped)) {
      let octal = escaped;
      while (octal.length < 3 && /[0-7]/.test(cursor.peek())) octal += cursor.take();
      const code = Number.parseInt(octal, 8);
      if (code > 255) throw new MiProtocolError('MI 八进制转义超出字节范围');
      utf8Bytes.push(code);
      continue;
    }
    // Unknown escapes are preserved instead of being interpreted.
    flushBytes(); result += `\\${escaped}`;
  }
  throw new MiProtocolError('MI 字符串缺少结束引号');
}

function parseKey(cursor: Cursor): string {
  let key = '';
  while (!cursor.done && cursor.peek() !== '=') key += cursor.take();
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)) throw new MiProtocolError('MI 键名无效');
  return key;
}

function parseValue(cursor: Cursor): MiValue {
  if (cursor.peek() === '"') return parseString(cursor);
  if (cursor.peek() === '{') {
    cursor.take();
    const result: MiValue = {};
    while (!cursor.done && cursor.peek() !== '}') {
      const key = parseKey(cursor);
      cursor.expect('=');
      result[key] = parseValue(cursor);
      if (cursor.peek() === ',') cursor.take();
      else if (cursor.peek() !== '}') throw new MiProtocolError('MI 键值对缺少分隔符');
    }
    cursor.expect('}');
    return result;
  }
  if (cursor.peek() === '[') {
    cursor.take();
    const result: MiValue[] = [];
    while (!cursor.done && cursor.peek() !== ']') {
      if (/[A-Za-z_]/.test(cursor.peek())) {
        const key = parseKey(cursor);
        if (cursor.peek() === '=') { cursor.take(); const item: { [key: string]: MiValue } = {}; item[key] = parseValue(cursor); result.push(item); }
        else result.push(key);
      } else result.push(parseValue(cursor));
      if (cursor.peek() === ',') cursor.take();
      else if (cursor.peek() !== ']') throw new MiProtocolError('MI 列表缺少分隔符');
    }
    cursor.expect(']');
    return result;
  }
  let atom = '';
  while (!cursor.done && !/[,\]}]/.test(cursor.peek())) atom += cursor.take();
  if (!atom) throw new MiProtocolError('MI 空值');
  return atom;
}

/** Parses one complete physical MI line. Malformed records fail closed. */
export function parseMiLine(line: string): MiRecord {
  if (!line || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(line)) throw new MiProtocolError('MI 记录包含非法控制字符');
  let cursor: Cursor;
  if (line.startsWith('"') || line.startsWith('{') || line.startsWith('[')) {
    cursor = new Cursor(line);
    parseValue(cursor);
    if (!cursor.done) throw new MiProtocolError('MI 裸值后存在多余内容');
    return { kind: 'raw', value: line };
  }
  if (/^[~@&]/.test(line)) {
    const prefix = line[0]!;
    const cursor = new Cursor(line.slice(1));
    const value = parseString(cursor);
    if (!cursor.done) throw new MiProtocolError('MI stream 记录存在多余内容');
    return { kind: 'stream', channel: prefix === '~' ? 'console' : prefix === '@' ? 'target' : 'log', value };
  }
  const match = /^(\d*)([\^*=])([^,\s]+)(.*)$/.exec(line);
  // GDB may forward inferior stdout/stderr as plain physical lines. Preserve
  // bounded printable output as raw evidence; malformed MI-looking records
  // still fail closed below.
  if (!match && !/^[~@&"\d*^=]/.test(line)) return { kind: 'raw', value: line };
  if (!match) throw new MiProtocolError('无法识别的 MI 记录');
  const [, tokenText, prefix, status, rest] = match;
  if (prefix === undefined || status === undefined || rest === undefined) throw new MiProtocolError('MI 记录缺少前缀或状态');
  if (tokenText && tokenText.length > 12) throw new MiProtocolError('MI token 过长');
  const token = tokenText ? Number(tokenText) : undefined;
  if (tokenText && (!Number.isSafeInteger(token) || String(token) !== tokenText)) throw new MiProtocolError('MI token 无效');
  const kind = prefix === '^' ? 'result' : 'notify';
  let payload = rest.trimStart().replace(/^,+/, '');
  if (payload.startsWith('class=')) { const comma = payload.indexOf(','); payload = comma < 0 ? '' : payload.slice(comma + 1); }
  if (!payload) return { kind, ...(token === undefined ? {} : { token }), status };
  cursor = new Cursor(payload);
  let value: MiValue;
  if (cursor.peek() === '{' || cursor.peek() === '[' || cursor.peek() === '"') value = parseValue(cursor);
  else {
    const tuple: { [key: string]: MiValue } = {};
    while (!cursor.done) {
      const key = parseKey(cursor);
      cursor.expect('=');
      tuple[key] = parseValue(cursor);
      if (cursor.peek() === ',') cursor.take();
      else if (!cursor.done) throw new MiProtocolError('MI 键值对缺少分隔符');
    }
    value = tuple;
  }
  if (!cursor.done) throw new MiProtocolError('MI 记录存在多余内容');
  return { kind, ...(token === undefined ? {} : { token }), status, value };
}

function parsePhysicalLine(line: string): MiRecord {
  try { return parseMiLine(line); }
  catch (error) {
    if (error instanceof MiProtocolError) {
      const excerpt = line.length > 512 ? `${line.slice(0, 512)}...[truncated]` : line;
      throw new MiProtocolError(`${error.message}; record=${JSON.stringify(excerpt)}`);
    }
    throw error;
  }
}

/** Incremental UTF-8-safe line decoder with an explicit maximum buffered line. */
export class MiLineDecoder {
  private readonly decoder = new TextDecoder('utf-8', { fatal: false });
  private buffer = '';
  private bytes = 0;
  constructor(private readonly maxLineBytes = 1_048_576) {}
  push(chunk: string | Uint8Array): MiRecord[] {
    const text = typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
    this.bytes += Buffer.byteLength(text);
    if (this.bytes > this.maxLineBytes) { this.reset(); throw new MiProtocolError('MI 单行输出超过限额'); }
    this.buffer += text;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? '';
    this.resetBytes();
    return lines.filter((line) => line.length > 0).map((line) => parsePhysicalLine(line));
  }
  end(): MiRecord[] { const records = this.buffer ? [parsePhysicalLine(this.buffer)] : []; this.buffer = ''; this.reset(); return records; }
  private resetBytes(): void { this.bytes = Buffer.byteLength(this.buffer); }
  private reset(): void { this.buffer = ''; this.bytes = 0; }
}

export function asRecord(value: unknown): { [key: string]: MiValue } | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as { [key: string]: MiValue } : undefined;
}
export function asList(value: MiValue | undefined): MiValue[] { return Array.isArray(value) ? value : []; }
export function asString(value: MiValue | undefined): string | undefined { return typeof value === 'string' ? value : undefined; }
export function parseCString(line: string): string | undefined {
  if (!line.startsWith('"')) return undefined;
  const cursor = new Cursor(line);
  return parseString(cursor);
}
export function isHexAddress(value: string): boolean { return /^0x[0-9a-f]+$/i.test(value); }

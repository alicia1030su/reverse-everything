import { createReadStream } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

export interface HarStreamItem {
  index: number;
  entry?: unknown;
  skipped: boolean;
  bytes: number;
  readBytes: number;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted', 'AbortError');
}

async function* decodedChunks(file: string, start: number, signal?: AbortSignal): AsyncGenerator<{ text: string; bytes: number }> {
  const decoder = new StringDecoder('utf8');
  const stream = createReadStream(file, { start, highWaterMark: 65_536 });
  try {
    for await (const chunk of stream) {
      throwIfAborted(signal);
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const text = decoder.write(buffer);
      if (text) yield { text, bytes: Buffer.byteLength(text) };
    }
    const tail = decoder.end();
    if (tail) yield { text: tail, bytes: Buffer.byteLength(tail) };
  } finally {
    stream.destroy();
  }
}

interface Frame {
  type: 'object' | 'array';
  key?: string;
  expectKey?: boolean;
}

/** Locates the byte offset of the HAR log.entries array without materializing the document. */
export async function findHarEntriesStart(file: string, signal?: AbortSignal): Promise<number> {
  const frames: Frame[] = [];
  let inString = false;
  let escape = false;
  let stringRaw = '';
  let stringTooLong = false;
  let stringIsKey = false;
  let baseBytes = 0;

  for await (const { text } of decodedChunks(file, 0, signal)) {
    for (let index = 0; index < text.length; index++) {
      const char = text[index]!;
      if (inString) {
        if (escape) {
          if (!stringTooLong) {
            if (stringRaw.length < 256) stringRaw += char;
            else stringTooLong = true;
          }
          escape = false;
          continue;
        }
        if (char === '\\') {
          if (!stringTooLong) {
            if (stringRaw.length < 256) stringRaw += char;
            else stringTooLong = true;
          }
          escape = true;
          continue;
        }
        if (char === '"') {
          const value = stringTooLong ? '' : JSON.parse('"' + stringRaw + '"') as string;
          if (stringIsKey) {
            const frame = frames.at(-1);
            if (frame?.type === 'object') { frame.key = value; frame.expectKey = false; }
          } else {
            const frame = frames.at(-1);
            if (frame?.type === 'object') frame.expectKey = false;
          }
          inString = false;
          stringRaw = '';
          stringTooLong = false;
          stringIsKey = false;
          continue;
        }
        if (!stringTooLong) {
          if (stringRaw.length < 256) stringRaw += char;
          else stringTooLong = true;
        }
        continue;
      }

      if (/\s/.test(char)) continue;
      if (char === '"') {
        inString = true;
        escape = false;
        stringRaw = '';
        stringTooLong = false;
        stringIsKey = frames.at(-1)?.type === 'object' && frames.at(-1)?.expectKey === true;
        continue;
      }
      if (char === '{') {
        const parent = frames.at(-1);
        if (parent?.type === 'object') parent.expectKey = false;
        frames.push({ type: 'object', expectKey: true });
        continue;
      }
      if (char === '[') {
        const parent = frames.at(-1);
        if (frames.length === 2 && frames[0]?.type === 'object' && frames[0].key === 'log' && parent?.type === 'object' && parent.key === 'entries') {
          return baseBytes + Buffer.byteLength(text.slice(0, index));
        }
        if (parent?.type === 'object') parent.expectKey = false;
        frames.push({ type: 'array' });
        continue;
      }
      if (char === '}' || char === ']') {
        frames.pop();
        continue;
      }
      if (char === ',') {
        const frame = frames.at(-1);
        if (frame?.type === 'object') frame.expectKey = true;
        continue;
      }
      if (char === ':') continue;
      const parent = frames.at(-1);
      if (parent?.type === 'object') parent.expectKey = false;
    }
    baseBytes += Buffer.byteLength(text);
  }
  throw new Error('Malformed HAR: log.entries array was not found');
}

/** Iterates bounded HAR entries from the log.entries array. */
export async function* iterateHarEntries(file: string, arrayStart: number, maxEntryBytes: number, signal?: AbortSignal): AsyncGenerator<HarStreamItem> {
  let index = 0;
  let readBytes = 0;
  let started = false;
  let depth = 0;
  let inString = false;
  let escape = false;
  let parts: string[] = [];
  let bytes = 0;
  let skipped = false;

  const reset = () => {
    started = false;
    depth = 0;
    inString = false;
    escape = false;
    parts = [];
    bytes = 0;
    skipped = false;
  };
  const finish = (): HarStreamItem => {
    const item: HarStreamItem = { index, skipped, bytes, readBytes };
    if (!skipped) {
      try { item.entry = JSON.parse(parts.join('')); }
      catch { throw new Error(`Malformed HAR: entry ${index} is not valid JSON`); }
    }
    index++;
    reset();
    return item;
  };

  for await (const { text, bytes: chunkBytes } of decodedChunks(file, arrayStart + 1, signal)) {
    readBytes += chunkBytes;
    for (const char of text) {
      if (!started) {
        if (/\s/.test(char) || char === ',') continue;
        if (char === ']') return;
        started = true;
      }

      if (!inString && depth === 0 && char === ']') {
        yield finish();
        return;
      }
      if (!inString && depth === 0 && char === ',') {
        yield finish();
        continue;
      }

      const wasInString = inString;
      if (!wasInString) {
        if (char === '"') inString = true;
        else if (char === '{' || char === '[') depth++;
        else if (char === '}' || char === ']') {
          depth--;
          if (depth < 0) throw new Error(`Malformed HAR: entry ${index} has an unmatched closing delimiter`);
        }
      } else if (escape) escape = false;
      else if (char === '\\') escape = true;
      else if (char === '"') inString = false;

      bytes += Buffer.byteLength(char);
      if (!skipped) {
        if (bytes > maxEntryBytes) { skipped = true; parts = []; }
        else parts.push(char);
      }
    }
  }
  if (started) throw new Error('Malformed HAR: entries array is not terminated');
}

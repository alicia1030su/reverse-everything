import { createHash } from 'node:crypto';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

const table = (() => {
  const values = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    values[n] = c >>> 0;
  }
  return values;
})();
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (table[(crc ^ byte) & 0xff]!) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ArchiveLimits {
  maxEntries?: number;
  maxEntryBytes?: number;
  maxTotalBytes?: number;
}

const DEFAULT_LIMITS = { maxEntries: 2_000, maxEntryBytes: 16 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024 };
const EXCLUDED = new Set(['node_modules', 'dist', 'data', '.git']);

/** 归档名必须是 POSIX 相对路径，不能依赖宿主 OS 的路径解释。 */
export function validateArchiveEntryName(name: string): void {
  const segments = name.split('/');
  if (!name || name.includes('\\') || /^[a-z]:/i.test(name) || path.posix.isAbsolute(name)
    || /[\x00-\x1f\x7f]/.test(name) || segments.some(segment => !segment || segment === '.' || segment === '..')) {
    throw new Error(`归档条目名不是安全的 POSIX 相对路径: ${JSON.stringify(name)}`);
  }
}

/**
 * 生成有界 ZIP Buffer，供现有 API 直接发送。
 * 单次调用最多保留 maxTotalBytes 数据；API 仍须限制下载端点并发，避免并发请求累积内存。
 */
export async function zipDirectory(root: string, limits: ArchiveLimits = {}): Promise<Buffer> {
  const maxEntries = limits.maxEntries ?? DEFAULT_LIMITS.maxEntries;
  const maxEntryBytes = limits.maxEntryBytes ?? DEFAULT_LIMITS.maxEntryBytes;
  const maxTotalBytes = limits.maxTotalBytes ?? DEFAULT_LIMITS.maxTotalBytes;
  if (![maxEntries, maxEntryBytes, maxTotalBytes].every(value => Number.isSafeInteger(value) && value > 0)) {
    throw new Error('归档上限必须是正整数');
  }
  const resolved = path.resolve(root);
  const canonical = await realpath(resolved);
  const [rootInfo, canonicalInfo] = await Promise.all([lstat(resolved), lstat(canonical)]);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || !canonicalInfo.isDirectory() || canonicalInfo.isSymbolicLink()) {
    throw new Error('归档根路径必须是普通目录，不能是符号链接');
  }
  const parts: Buffer[] = [];
  const records: Array<{ name: string; crc: number; size: number; offset: number }> = [];
  let offset = 0;
  let totalBytes = 0;
  const reserve = (bytes: number): void => {
    totalBytes += bytes;
    if (totalBytes > maxTotalBytes) throw new Error(`归档总字节超过上限 ${maxTotalBytes}`);
  };
  const walk = async (directory: string, prefix = ''): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      validateArchiveEntryName(name);
      if (prefix === '' && (EXCLUDED.has(entry.name) || entry.name === '.env' || entry.name.startsWith('.env.'))) continue;
      if (prefix && EXCLUDED.has(entry.name)) continue;
      const file = path.join(directory, entry.name);
      const info = await lstat(file);
      if (info.isSymbolicLink()) throw new Error('Generated server contains a symbolic link');
      if (info.isDirectory()) { await walk(file, name); continue; }
      if (!info.isFile()) throw new Error('Generated server contains an unsafe file');
      if (info.size > maxEntryBytes) throw new Error(`归档文件超过 ${maxEntryBytes} 字节: ${name}`);
      if (records.length >= maxEntries) throw new Error(`归档条目数超过上限 ${maxEntries}`);
      const nameBytes = Buffer.from(name);
      const handle = await open(file, 'r');
      const bytes = Buffer.alloc(maxEntryBytes + 1);
      let length = 0;
      try {
        while (length < bytes.length) {
          const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
          if (bytesRead === 0) break;
          length += bytesRead;
        }
      } finally { await handle.close(); }
      const content = bytes.subarray(0, length);
      if (length > maxEntryBytes) throw new Error(`归档文件超过 ${maxEntryBytes} 字节: ${name}`);
      if (length !== info.size) throw new Error(`归档文件读取后大小不一致: ${name}`);
      reserve(30 + nameBytes.length + length + 46 + nameBytes.length + 22);
      const checksum = crc32(content);
      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(0x800, 6);
      header.writeUInt32LE(checksum, 14);
      header.writeUInt32LE(content.length, 18);
      header.writeUInt32LE(content.length, 22);
      header.writeUInt16LE(nameBytes.length, 26);
      records.push({ name, crc: checksum, size: content.length, offset });
      parts.push(header, nameBytes, content);
      offset += 30 + nameBytes.length + content.length;
    }
  };
  await walk(canonical);
  const centralOffset = offset;
  const central: Buffer[] = [];
  for (const record of records) {
    const nameBytes = Buffer.from(record.name);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x800, 8);
    entry.writeUInt32LE(record.crc, 16);
    entry.writeUInt32LE(record.size, 20);
    entry.writeUInt32LE(record.size, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(record.offset, 42);
    central.push(entry, nameBytes);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(records.length, 8);
  end.writeUInt16LE(records.length, 10);
  end.writeUInt32LE(offset - centralOffset + central.reduce((sum, part) => sum + part.length, 0), 12);
  end.writeUInt32LE(centralOffset, 16);
  parts.push(...central, end);
  return Buffer.concat(parts, offset + central.reduce((sum, part) => sum + part.length, 0) + end.length);
}

export function archiveDigest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

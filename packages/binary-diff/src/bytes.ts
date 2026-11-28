import { createHash } from 'node:crypto';
import type { BinaryByteDiffReport, BinaryDiffStatus, ByteRangeDiff } from './types.js';

export const MAX_BINARY_DIFF_BYTES = 64 * 1024 * 1024;
const MAX_CHANGED_RANGES = 4096;

function entropy(bytes: Uint8Array): number {
  if (!bytes.length) return 0;
  const counts = new Uint32Array(256);
  for (const byte of bytes) counts[byte] = counts[byte]! + 1;
  let value = 0;
  for (const count of counts) {
    if (!count) continue;
    const probability = count / bytes.length;
    value -= probability * Math.log2(probability);
  }
  return value;
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

/** Compares two bounded byte arrays without executing or interpreting them. */
export function diffBinaryBytes(beforeInput: Uint8Array, afterInput: Uint8Array): BinaryByteDiffReport {
  if (beforeInput.byteLength > MAX_BINARY_DIFF_BYTES || afterInput.byteLength > MAX_BINARY_DIFF_BYTES) {
    throw new Error(`Binary diff inputs must not exceed ${MAX_BINARY_DIFF_BYTES} bytes`);
  }
  const before = Buffer.from(beforeInput);
  const after = Buffer.from(afterInput);
  const shared = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < shared && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (suffix < shared - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;

  const ranges: ByteRangeDiff[] = [];
  let changedBytes = 0;
  let truncated = false;
  let offset = prefix;
  while (offset < shared - suffix) {
    while (offset < shared - suffix && before[offset] === after[offset]) offset++;
    if (offset >= shared - suffix) break;
    const start = offset;
    while (offset < shared - suffix && before[offset] !== after[offset]) offset++;
    const length = offset - start;
    changedBytes += length;
    if (ranges.length < MAX_CHANGED_RANGES) ranges.push({ offset: start, length, beforeHex: hex(before.subarray(start, offset)), afterHex: hex(after.subarray(start, offset)) });
    else truncated = true;
  }
  if (before.length > after.length) changedBytes += before.length - after.length;
  if (after.length > before.length) changedBytes += after.length - before.length;

  const limitations: string[] = [];
  if (truncated) limitations.push(`Changed-range detail was truncated after ${MAX_CHANGED_RANGES} ranges`);
  const identical = before.length === after.length && prefix === before.length;
  const status: BinaryDiffStatus = identical ? 'PASSED' : truncated ? 'PARTIAL' : 'PASSED';
  return {
    schemaVersion: 1,
    status,
    beforeSize: before.length,
    afterSize: after.length,
    beforeSha256: createHash('sha256').update(before).digest('hex'),
    afterSha256: createHash('sha256').update(after).digest('hex'),
    identical,
    commonPrefixBytes: prefix,
    commonSuffixBytes: suffix,
    changedBytes,
    changedRanges: ranges,
    entropyBefore: entropy(before),
    entropyAfter: entropy(after),
    truncated,
    limitations,
  };
}

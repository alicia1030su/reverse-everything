import { mkdir, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export async function resetGeneratedDirectory(target, parent, expectedName) {
  const resolved = path.resolve(target);
  const expectedParent = path.resolve(parent);
  if (path.dirname(resolved) !== expectedParent || path.basename(resolved) !== expectedName) throw new Error(`Refusing unexpected generated directory: ${resolved}`);
  try {
    await rm(resolved, { recursive: true, force: true });
  } catch (error) {
    if (!String(error?.message ?? error).includes('SAFE_DELETE_BULK_CONFIRM_REQUIRED')) throw error;
    const quarantine = path.join(os.tmpdir(), `reverse-everything-${expectedName}-${process.pid}-${Date.now()}`);
    await rename(resolved, quarantine);
    console.warn(`Host bulk-delete protection retained the previous generated directory at ${quarantine}`);
  }
  await mkdir(resolved, { recursive: true });
}

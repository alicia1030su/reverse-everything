import { lstat, readdir, rm, rmdir } from 'node:fs/promises';
import path from 'node:path';

const CLEANUP_BATCH_SIZE = 25;

async function assertMissing(target: string): Promise<void> {
  try { await lstat(target); }
  catch (error) { if ((error as { code?: string }).code === 'ENOENT') return; throw error; }
  throw new Error(`Temporary cleanup did not remove ${target}`);
}

export async function cleanupKnownTempRoot(root: string, parent: string, prefix = 'integration-'): Promise<void> {
  const target = path.resolve(root); const expectedParent = path.resolve(parent);
  const relative = path.relative(expectedParent, target);
  if (!prefix || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || relative.includes(path.sep) || !path.basename(target).startsWith(prefix) || path.basename(target).length === prefix.length) {
    throw new Error('Refusing to clean a path outside the known temporary-root parent or prefix');
  }
  let rootInfo;
  try { rootInfo = await lstat(target); }
  catch (error) { if ((error as { code?: string }).code === 'ENOENT') return; throw error; }
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error('Known temporary root must be a real directory');

  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (let offset = 0; offset < entries.length; offset += CLEANUP_BATCH_SIZE) {
      for (const entry of entries.slice(offset, offset + CLEANUP_BATCH_SIZE)) {
        const child = path.join(directory, entry.name); const info = await lstat(child);
        if (info.isSymbolicLink() || !info.isDirectory()) await rm(child, { force: true });
        else await walk(child);
        await assertMissing(child);
      }
    }
    await rmdir(directory);
    await assertMissing(directory);
  };

  await walk(target);
}

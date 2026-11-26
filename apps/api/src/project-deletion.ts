import { lstat, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Database } from '@reverse/workflow';

export interface DeletionIntent {
  id: string;
  projectId: string;
  taskIds: string[];
  paths: string[];
  status: 'pending' | 'complete';
  createdAt: string;
  updatedAt: string;
}

function safeManagedPath(dataDir: string, relative: string): string {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || /^[A-Za-z]:/.test(relative)) throw new Error('Unsafe project deletion path');
  const root = path.resolve(dataDir);
  const target = path.resolve(root, relative);
  const rel = path.relative(root, target);
  if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new Error('Project deletion path escapes the data directory');
  return target;
}

async function assertNoLinks(root: string, target: string): Promise<void> {
  const relative = path.relative(root, target);
  let current = root;
  for (const component of ['', ...relative.split(path.sep)]) {
    if (component) current = path.join(current, component);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error('Project deletion path contains a symbolic link');
    const canonical = await realpath(current);
    const relativeToRoot = path.relative(await realpath(root), canonical);
    if (relativeToRoot === '..' || relativeToRoot.startsWith('..' + path.sep) || path.isAbsolute(relativeToRoot)) throw new Error('Project deletion path escapes the data directory');
  }
}

export async function removeManagedPaths(dataDir: string, paths: string[]): Promise<void> {
  for (const relative of paths) {
    const target = safeManagedPath(dataDir, relative);
    const root = path.resolve(dataDir);
    try {
      await assertNoLinks(root, target);
      const info = await lstat(target);
      // Check the resolved parent immediately before relative deletion as well as every path component.
      if (info.isSymbolicLink()) throw new Error('Project deletion path is a symbolic link');
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') throw error;
    }
    await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    await assertNoLinks(root, root);
  }
}

export async function recoverProjectDeletions(db: Database, dataDir: string): Promise<number> {
  const rows = db.raw.prepare("SELECT * FROM project_deletion_intents WHERE status='pending' ORDER BY created_at").all() as Record<string, unknown>[];
  for (const row of rows) {
    const paths = JSON.parse(String(row.paths_json)) as string[];
    await removeManagedPaths(dataDir, paths);
    db.raw.prepare("UPDATE project_deletion_intents SET status='complete',updated_at=? WHERE id=?").run(new Date().toISOString(), String(row.id));
  }
  return rows.length;
}

export function deletionIntent(row: Record<string, unknown>): DeletionIntent {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    taskIds: JSON.parse(String(row.task_ids_json)) as string[],
    paths: JSON.parse(String(row.paths_json)) as string[],
    status: String(row.status) as DeletionIntent['status'],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const scanner = path.resolve('scripts/check-secrets.mjs');

describe('streaming secret scan', () => {
  it('scans across chunk boundaries without loading large files into one string', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 're-secret-scan-'));
    try {
      const file = path.join(dir, 'large.bin');
      await writeFile(file, Buffer.concat([Buffer.alloc(1024 * 1024 - 10, 0x61), Buffer.from(`sk-${'b'.repeat(32)}`), Buffer.alloc(1024 * 1024, 0x63)]));
      const blocked = spawnSync(process.execPath, [scanner], { cwd: dir, encoding: 'utf8' });
      expect(blocked.status).toBe(1);
      expect(blocked.stderr).toContain('large.bin');
      await writeFile(file, Buffer.alloc(2 * 1024 * 1024, 0x61));
      const clean = spawnSync(process.execPath, [scanner], { cwd: dir, encoding: 'utf8' });
      expect(clean.status, clean.stderr).toBe(0);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

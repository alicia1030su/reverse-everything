import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

describe('defect register release gate', () => {
  it('passes the real register only when no P0/P1 remains open', async () => {
    const root = path.resolve(process.cwd());
    const script = path.join(root, 'scripts/check-defect-register.mjs');
    const real = await readFile(path.join(root, 'docs/development/V007-DEFECT-REGISTER.md'), 'utf8');
    expect(real).toContain('| V007-019 | P1 |');
    const result = await run(process.execPath, [script], { cwd: root });
    expect(result.stdout).toContain('no OPEN/IN_PROGRESS P0/P1');
  });

  it('rejects an in-progress P1 and accepts it after the status is fixed', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'defect-register-'));
    dirs.push(root);
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module' }));
    await mkdir(path.join(root, 'scripts'), { recursive: true });
    const script = path.join(root, 'scripts/check-defect-register.mjs');
    await writeFile(script, await readFile(path.resolve('scripts/check-defect-register.mjs'), 'utf8'));
    await mkdir(path.join(root, 'docs/development'), { recursive: true });
    const register = path.join(root, 'docs/development/V007-DEFECT-REGISTER.md');
    await writeFile(register, '| V007-999 | P1 | blocker | evidence | fix | IN_PROGRESS |\n');
    await expect(run(process.execPath, [script], { cwd: root })).rejects.toThrow(/Uncleared P0\/P1/);
    await writeFile(register, '| V007-999 | P1 | blocker | evidence | fix | FIXED |\n');
    await expect(run(process.execPath, [script], { cwd: root })).resolves.toMatchObject({ stdout: expect.stringContaining('gate passed') });
  });
});

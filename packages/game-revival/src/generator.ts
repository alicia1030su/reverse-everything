import { createHash } from 'node:crypto';
import { chmod, mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { GameServerSpec } from './types.js';
import { projectFiles } from './templates.js';

function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/** 生成可独立 npm ci/build/start 的工程；拒绝覆盖已有非空目录。 */
export async function generateGameServer(spec: GameServerSpec, outputDir: string): Promise<{ files: string[]; sha256: string }> {
  const root = path.resolve(outputDir);
  await mkdir(root, { recursive: true });
  const existing = await readdir(root);
  if (existing.length) throw new Error('输出目录必须为空，避免覆盖用户文件');
  const files = projectFiles(spec);
  const specSha256 = sha256(JSON.stringify({ id: spec.id, name: spec.name, genre: spec.genre, level: spec.level, behaviorEvidence: spec.behaviorEvidence ?? null, provenance: spec.provenance }));
  const behaviorSha256 = spec.behaviorEvidence ? sha256(JSON.stringify(spec.behaviorEvidence.behavior)) : null;
  const fileHashes = Object.fromEntries([...files].filter(([name]) => name !== 'BUILD-INFO.json' && name !== 'SHA256SUMS.txt').map(([name, content]) => [name, sha256(content)]));
  const buildInfo = JSON.parse(files.get('BUILD-INFO.json')!) as Record<string, unknown>;
  files.set('BUILD-INFO.json', JSON.stringify({ ...buildInfo, schemaVersion: 1, specSha256, behaviorSha256, files: fileHashes }, null, 2) + '\n');
  const sums: string[] = [];
  for (const [relative, content] of files) {
    const destination = path.resolve(root, relative);
    const within = path.relative(root, destination);
    if (within.startsWith(`..${path.sep}`) || within === '..' || path.isAbsolute(within)) throw new Error(`生成路径越界：${relative}`);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, content, { mode: 0o600 });
    if (relative.endsWith('.sh')) await chmod(destination, 0o755);
    sums.push(`${sha256(content)}  ${relative.split(path.sep).join('/')}`);
  }
  const checksumFile = sums.sort().join('\n') + '\n';
  await writeFile(path.join(root, 'SHA256SUMS.txt'), checksumFile, { mode: 0o600 });
  return { files: [...files.keys(), 'SHA256SUMS.txt'].sort(), sha256: sha256(checksumFile) };
}

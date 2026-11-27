import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { hashFile } from '@reverse/evidence';
import { AutopilotError, type DeliveryAcceptance, type DeliveryManifest } from './types.js';

export interface DeliveryArtifactSource {
  name: string; path: string; sourceTask: string; version?: string; status?: string; platforms?: string[]; conditions?: string[]; size?: number; sha256?: string;
}
export interface DeliveryCheckSource { name: string; passed: boolean; evidence: string }
export interface DeliveryPackageSource {
  taskId: string; originalGoal: string; completed: string[]; incomplete: string[]; artifacts: DeliveryArtifactSource[];
  checks?: DeliveryCheckSource[]; limitations?: string[]; risks?: string[]; tutorial?: string; deployment?: string; version?: string;
}

function safeRelativeName(name: string): string {
  const normalized = name.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/^\/+/, '');
  const parts = normalized.split('/').filter(part => part && part !== '.' && part !== '..');
  const clean = parts.map(part => part.replace(/[^a-zA-Z0-9._\-\u4e00-\u9fff]/g, '_').replace(/[. ]+$/g, '')).filter(Boolean);
  if (!clean.length || clean.some(part => part === '.' || part === '..')) throw new AutopilotError(`交付工件名称无效: ${name}`, 'DELIVERY_NAME_INVALID', 400);
  return clean.join('/');
}

async function assertRegularFile(file: string): Promise<void> {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new AutopilotError(`交付源不是普通文件: ${file}`, 'DELIVERY_ARTIFACT_INVALID', 400);
}

async function walkFiles(root: string): Promise<string[]> {
  const info = await lstat(root);
  if (info.isSymbolicLink()) throw new AutopilotError('交付源不能是符号链接', 'DELIVERY_ARTIFACT_INVALID', 400);
  if (info.isFile()) return [root];
  if (!info.isDirectory()) throw new AutopilotError('交付源必须是文件或目录', 'DELIVERY_ARTIFACT_INVALID', 400);
  const result: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new AutopilotError('交付目录不能包含符号链接', 'DELIVERY_ARTIFACT_INVALID', 400);
    const child = path.join(root, entry.name); if (entry.isDirectory()) result.push(...await walkFiles(child)); else if (entry.isFile()) result.push(child);
  }
  return result;
}

function defaultTutorial(manifest: DeliveryManifest): string {
  return `# 使用教程\n\n## 1. 检查交付包\n\n先阅读 \`START-HERE.md\` 和 \`reports/ACCEPTANCE.json\`。验收状态为 \`${manifest.acceptance.status}\` 时才按对应范围使用。\n\n## 2. 校验完整性\n\n在交付包根目录运行：\n\n\`\`\`sh\nsha256sum -c SHA256SUMS.txt\n\`\`\`\n\nWindows PowerShell 可使用 \`Get-FileHash\` 逐个核对 \`ARTIFACT-MANIFEST.json\` 中的 SHA256。\n\n## 3. 使用产物\n\n${manifest.artifacts.length ? manifest.artifacts.map(item => `- \`${item.path}\`（${item.status}）`).join('\n') : '- 当前包仅含报告，没有可执行产物。'}\n\n## 4. 部署\n\n${manifest.deployment}\n\n## 5. 边界\n\n${manifest.risks.length ? manifest.risks.map(item => `- ${item}`).join('\n') : '- 无额外风险。'}\n\n未完成项：${manifest.incomplete.length ? manifest.incomplete.join('；') : '无'}。\n`;
}

export async function createDeliveryPackage(outputDir: string, source: DeliveryPackageSource): Promise<DeliveryManifest> {
  if (!source.taskId || !source.originalGoal) throw new AutopilotError('交付任务 ID 与原始目标必填', 'DELIVERY_INPUT_INVALID', 400);
  const root = path.resolve(outputDir); await mkdir(path.join(root, 'artifacts'), { recursive: true }); await mkdir(path.join(root, 'reports'), { recursive: true });
  const artifacts: DeliveryManifest['artifacts'] = [];
  for (const artifact of source.artifacts) {
    const sourcePath = path.resolve(artifact.path);
    for (const file of await walkFiles(sourcePath)) {
      await assertRegularFile(file); const size = (await lstat(file)).size; const sha256 = await hashFile(file);
      if (artifact.size !== undefined && artifact.size !== size) throw new AutopilotError(`工件大小不匹配: ${artifact.name}`, 'DELIVERY_HASH_MISMATCH', 422);
      if (artifact.sha256 && artifact.sha256 !== sha256) throw new AutopilotError(`工件哈希不匹配: ${artifact.name}`, 'DELIVERY_HASH_MISMATCH', 422);
      const relative = path.relative(sourcePath, file); const name = safeRelativeName(relative ? path.join(artifact.name, relative) : artifact.name);
      const destination = path.join(root, 'artifacts', name); await mkdir(path.dirname(destination), { recursive: true }); await copyFile(file, destination);
      artifacts.push({ name, path: `artifacts/${name}`, size, sha256, sourceTask: artifact.sourceTask, version: artifact.version ?? source.version ?? '1.0.0', status: artifact.status ?? 'generated', platforms: artifact.platforms ?? [], conditions: artifact.conditions ?? [] });
    }
  }
  const recorded = source.checks ?? [];
  const checks: DeliveryAcceptance['checks'] = [
    { name: 'real-artifacts-present', passed: artifacts.length > 0, evidence: `${artifacts.length} 个真实任务工件` },
    { name: 'artifact-hashes-verified', passed: artifacts.length > 0 && artifacts.every(item => item.size >= 0 && /^[a-f0-9]{64}$/.test(item.sha256)), evidence: '复制前逐文件计算 SHA256 并核对声明值' },
    ...recorded.map(check => ({ name: check.name, passed: check.passed === true, evidence: check.evidence })),
  ];
  const buildFailed = recorded.some(check => /build/i.test(check.name) && !check.passed);
  const testFailed = recorded.some(check => /test/i.test(check.name) && !check.passed);
  const allPassed = checks.every(check => check.passed);
  const status: DeliveryAcceptance['status'] = buildFailed ? 'BUILD_FAILED' : testFailed ? 'TEST_FAILED' : artifacts.length === 0 ? 'REPORT_ONLY' : allPassed && source.completed.length > 0 ? 'DELIVERABLE_VERIFIED' : 'DELIVERABLE_PARTIAL';
  const manifest: DeliveryManifest = {
    taskId: source.taskId, version: source.version ?? '1.0.0', summary: source.completed[0] ?? source.originalGoal, originalGoal: source.originalGoal,
    completed: source.completed, incomplete: source.incomplete, artifacts,
    acceptance: { status, checks, reviewer: 'independent-rules', limitations: [...(source.limitations ?? []), ...(allPassed ? [] : ['部分独立规则检查未通过，不能声称完整交付'])] },
    tutorial: '使用教程.md', deployment: source.deployment ?? '静态网站可直接打开 artifacts 下的 index.html；其他产物按来源任务说明部署。', risks: source.risks ?? [],
  };
  const startHere = `# START HERE\n\n- 任务：${manifest.taskId}\n- 原始目标：${manifest.originalGoal}\n- 验收状态：${manifest.acceptance.status}\n- 验收者：independent-rules（非模型自评）\n\n## 已完成\n${manifest.completed.map(item => `- ${item}`).join('\n') || '- 无'}\n\n## 未完成\n${manifest.incomplete.map(item => `- ${item}`).join('\n') || '- 无'}\n\n## 快速开始\n1. 阅读 \`使用教程.md\`。\n2. 查看 \`reports/ACCEPTANCE.json\`。\n3. 运行 \`sha256sum -c SHA256SUMS.txt\` 校验工件。\n`;
  await writeFile(path.join(root, 'START-HERE.md'), startHere, 'utf8');
  await writeFile(path.join(root, '使用教程.md'), source.tutorial ?? defaultTutorial(manifest), 'utf8');
  await writeFile(path.join(root, 'reports', 'ACCEPTANCE.json'), `${JSON.stringify(manifest.acceptance, null, 2)}\n`, 'utf8');
  await writeFile(path.join(root, 'ARTIFACT-MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const sumFiles: string[] = [];
  for (const relative of ['START-HERE.md', '使用教程.md', 'reports/ACCEPTANCE.json', 'ARTIFACT-MANIFEST.json', ...artifacts.map(item => item.path)]) sumFiles.push(relative);
  const sumLines: string[] = [];
  for (const relative of sumFiles.sort()) sumLines.push(`${createHash('sha256').update(await readFile(path.join(root, relative))).digest('hex')}  ${relative}`);
  const sums = sumLines.join('\n');
  await writeFile(path.join(root, 'SHA256SUMS.txt'), `${sums}\n`, 'utf8');
  return manifest;
}

export const packageDelivery = createDeliveryPackage;
export const buildDeliveryPackage = createDeliveryPackage;

export async function verifyDelivery(outputDir: string): Promise<{ passed: boolean; checks: { name: string; passed: boolean; evidence: string }[] }> {
  const root = path.resolve(outputDir); const checks: { name: string; passed: boolean; evidence: string }[] = [];
  try {
    const manifest = JSON.parse(await readFile(path.join(root, 'ARTIFACT-MANIFEST.json'), 'utf8')) as DeliveryManifest;
    checks.push({ name: 'independent-reviewer', passed: manifest.acceptance.reviewer === 'independent-rules', evidence: String(manifest.acceptance.reviewer) });
    for (const artifact of manifest.artifacts) {
      try { const file = path.join(root, artifact.path); await assertRegularFile(file); const digest = await hashFile(file); checks.push({ name: `sha256:${artifact.name}`, passed: digest === artifact.sha256 && (await lstat(file)).size === artifact.size, evidence: artifact.path }); }
      catch (error) { checks.push({ name: `sha256:${artifact.name}`, passed: false, evidence: error instanceof Error ? error.message : String(error) }); }
    }
    for (const required of ['START-HERE.md', '使用教程.md', 'reports/ACCEPTANCE.json', 'SHA256SUMS.txt']) checks.push({ name: `required:${required}`, passed: (await lstat(path.join(root, required)).then(info => info.isFile()).catch(() => false)), evidence: required });
    const acceptance = JSON.parse(await readFile(path.join(root, 'reports', 'ACCEPTANCE.json'), 'utf8')) as DeliveryAcceptance;
    checks.push({ name: 'acceptance-consistent', passed: JSON.stringify(acceptance) === JSON.stringify(manifest.acceptance), evidence: 'reports/ACCEPTANCE.json 与 manifest 一致' });
    return { passed: checks.every(check => check.passed), checks };
  } catch (error) { return { passed: false, checks: [{ name: 'delivery-readable', passed: false, evidence: error instanceof Error ? error.message : String(error) }] }; }
}

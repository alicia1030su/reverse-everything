import type { JsonObject } from '@reverse/contracts';
import type { AutopilotIntent, DiscoveryQuestion } from './types.js';

const TARGET_FIELDS = ['target', 'targetUrl', 'url'];
const MATERIAL_FIELDS = ['materials', 'uploadIds', 'paths', 'logs', 'files'];
const PLATFORM_FIELDS = ['platform', 'targetPlatform'];
const PERMISSION_FIELDS = ['authorization', 'authorized', 'permission', 'authorizationConfirmed'];

function hasValue(answers: JsonObject, fields: string[]): boolean {
  return fields.some(field => {
    const value = answers[field];
    if (value === false) return fields.some(field => PERMISSION_FIELDS.includes(field));
    return value !== undefined && value !== null && value !== '' && (!Array.isArray(value) || value.length > 0);
  });
}

export function isQuestionAnswered(question: DiscoveryQuestion, answers: JsonObject): boolean {
  if (Object.prototype.hasOwnProperty.call(answers, question.id)) {
    const direct = answers[question.id];
    if (direct !== undefined && direct !== null && direct !== '' && (!Array.isArray(direct) || direct.length > 0)) return true;
  }
  return hasValue(answers, [question.field, ...(question.id.startsWith('target') ? TARGET_FIELDS : []), ...(question.id.startsWith('materials') ? MATERIAL_FIELDS : []), ...(question.id.startsWith('platform') ? PLATFORM_FIELDS : []), ...(question.id.startsWith('permission') ? PERMISSION_FIELDS : [])]);
}

export function discoveryQuestions(intent: AutopilotIntent, answers: JsonObject = {}): DiscoveryQuestion[] {
  const questions: DiscoveryQuestion[] = [];
  if (!intent.objectives.length && !hasValue(answers, ['objectives', 'goal'])) {
    questions.push({ id: 'objectives', kind: 'text', prompt: '你希望最终得到什么？可写多个目标，用分号分隔。', help: '自由文本即可，例如：恢复存档；导出说明文档；生成可部署静态网站。', required: true, field: 'objectives' });
  }
  const hasIntentTarget = intent.inputs.urls.length + intent.inputs.paths.length > 0;
  const hasIntentMaterial = intent.inputs.uploadIds.length + intent.inputs.paths.length + intent.inputs.logIds.length + intent.inputs.imageIds.length > 0;
  const needsTarget = (intent.missing.some(item => /URL|目标/.test(item)) || intent.kind === 'unknown') && !hasIntentTarget;
  const needsMaterial = (intent.missing.some(item => /材料|上传文件|日志/.test(item)) || ['game-revival', 'legacy-revival', 'data-recovery', 'firmware-analysis', 'software-rebuild', 'resume-project'].includes(intent.kind)) && !hasIntentMaterial;
  if (needsTarget && !hasValue(answers, TARGET_FIELDS)) {
    questions.push({ id: 'target', kind: intent.kind === 'website-rebuild' || intent.kind === 'defensive-security' ? 'text' : 'directory', prompt: '请提供分析目标或目标 URL。', help: 'URL 仅允许 http/https；本地材料必须是绝对路径或已上传文件。未知代码不会被执行。', required: true, field: 'target' });
  }
  if (needsMaterial && !hasValue(answers, MATERIAL_FIELDS)) {
    questions.push({ id: 'materials', kind: 'multi', prompt: '请提供可用的材料。', help: '可填写上传文件 ID、日志 ID 或本地绝对路径；多个目标用逗号分隔。数据恢复不会强制反编译。', required: true, field: 'materials', options: [
      { value: 'upload', label: '已上传文件', description: '使用项目上传区的文件' }, { value: 'path', label: '本地绝对路径', description: '只读分析，并创建任务私有快照' }, { value: 'logs', label: '日志 / 截图', description: '适合恢复与兼容性分析' },
    ] });
  }
  if (!intent.targetPlatform && !hasValue(answers, PLATFORM_FIELDS)) {
    questions.push({ id: 'platform', kind: 'platform', prompt: '目标平台是什么？', help: '不同平台的构建、支付、审核与系统能力不同，不能假定一套产物全端通用。', required: true, field: 'targetPlatform', options: [
      { value: 'Web', label: 'Web / 静态网站' }, { value: 'Windows', label: 'Windows' }, { value: 'macOS', label: 'macOS' }, { value: 'Linux', label: 'Linux' }, { value: 'Android', label: 'Android' }, { value: 'iOS', label: 'iOS' }, { value: 'HarmonyOS', label: 'HarmonyOS / ArkTS' }, { value: 'WeChat Mini Program', label: '微信小程序' },
    ] });
  }
  if (!hasValue(answers, PERMISSION_FIELDS)) {
    questions.push({ id: 'permission.authorization', kind: 'permission', prompt: '是否授权对上述目标执行只读分析，并写入任务私有工件？', help: '默认 local-only。不会执行未知程序、不会任意 shell、不会访问个人目录；部署或远程数据共享需要额外明确授权。', required: true, field: 'authorizationConfirmed', options: [
      { value: 'true', label: '授权', description: '仅限目标只读分析与任务工件写入' }, { value: 'false', label: '不授权', description: '仅生成需求与计划，不执行分析' },
    ] });
  }
  if (/remote|云端|远程模型|external ai|分享.*数据|上传.*服务器/i.test(intent.finalPurpose) && !hasValue(answers, ['dataSharing', 'sharing'])) {
    questions.push({ id: 'sharing', kind: 'sharing', prompt: '是否允许把必要材料发送到远程服务？', help: '默认拒绝。选择远程处理前应确认数据脱敏、服务商与费用。', required: true, field: 'dataSharing', options: [{ value: 'local-only', label: '仅本地', description: '推荐；模型与工具均不得外发数据' }, { value: 'remote-approved', label: '明确允许远程处理', description: '仍需记录服务商、数据范围和撤销方式' }] });
  }
  if (/depth|深度|详细|完整|quick|快速/i.test(intent.finalPurpose) && !hasValue(answers, ['depth'])) {
    questions.push({ id: 'depth', kind: 'depth', prompt: '希望分析深度如何？', help: '深度只影响预算内步骤，不会扩大权限。', required: false, field: 'depth', options: [{ value: 'quick', label: '快速' }, { value: 'standard', label: '标准' }, { value: 'deep', label: '深入' }] });
  }
  return questions;
}

export const generateQuestions = discoveryQuestions;
export const buildQuestions = discoveryQuestions;

export function nextUnansweredQuestion(questions: DiscoveryQuestion[], answers: JsonObject): DiscoveryQuestion | undefined {
  return questions.find(question => question.required && !isQuestionAnswered(question, answers)) ?? questions.find(question => !isQuestionAnswered(question, answers));
}

export function mergeAnswers(current: JsonObject, incoming: JsonObject, questions: DiscoveryQuestion[] = []): JsonObject {
  const merged: JsonObject = { ...current };
  for (const [key, value] of Object.entries(incoming)) {
    if (key === 'freeText' && typeof value === 'string' && value.trim()) { merged.freeText = value.trim(); continue; }
    if (questions.length && !questions.some(question => question.id === key || question.field === key) && key !== 'freeText') continue;
    if (value === undefined || value === null || value === '') continue;
    merged[key] = value;
  }
  const freeText = typeof merged.freeText === 'string' ? merged.freeText : '';
  if (freeText && !hasValue(merged, TARGET_FIELDS) && /https?:\/\//i.test(freeText)) merged.target = freeText.match(/https?:\/\/[^\s,，;；]+/i)?.[0] ?? freeText;
  if (typeof merged.authorizationConfirmed === 'string') merged.authorizationConfirmed = /^(?:true|yes|是|同意|授权)$/i.test(merged.authorizationConfirmed);
  if (typeof merged.authorized === 'string') merged.authorized = /^(?:true|yes|是|同意|授权)$/i.test(merged.authorized);
  if (typeof merged.targetPlatform === 'string') merged.platform = merged.targetPlatform;
  return merged;
}

export function unansweredRequired(questions: DiscoveryQuestion[], answers: JsonObject): DiscoveryQuestion[] {
  return questions.filter(question => question.required && !isQuestionAnswered(question, answers));
}

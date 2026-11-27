import type { AdapterName, JsonObject } from '@reverse/contracts';
import type { AutopilotIntent, IntentInputs } from './types.js';

export function emptyIntentInputs(): IntentInputs {
  return { uploadIds: [], paths: [], urls: [], imageIds: [], logIds: [], deviceInfo: [] };
}

export function normalizeIntentInputs(input: Partial<IntentInputs> = {}): IntentInputs {
  const strings = (value: unknown): string[] => Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean))] : [];
  return {
    uploadIds: strings(input.uploadIds), paths: strings(input.paths), urls: strings(input.urls),
    imageIds: strings(input.imageIds), logIds: strings(input.logIds), deviceInfo: strings(input.deviceInfo),
  };
}

function unique(values: string[]): string[] { return [...new Set(values.map(value => value.trim()).filter(Boolean))]; }

export function splitObjectives(prompt: string): string[] {
  const normalized = prompt.replace(/\r?\n/g, '；').replace(/[。！？!?]+/g, '；');
  return unique(normalized.split(/[；;]|,\s*(?=(?:and|then|also|同时|并且|然后|再|还要)\b)/i).map(part => part.replace(/^(?:请|帮我|帮忙|please)\s+/i, '').trim()).filter(part => part.length > 1));
}

const PLATFORM_RULES: { pattern: RegExp; value: string }[] = [
  { pattern: /harmony|鸿蒙|arkts/i, value: 'HarmonyOS' },
  { pattern: /iphone|ios|苹果手机|iOS/i, value: 'iOS' },
  { pattern: /android|安卓|apk/i, value: 'Android' },
  { pattern: /windows|win10|win11|视窗/i, value: 'Windows' },
  { pattern: /macos|mac os|mac 版|mac版|苹果电脑/i, value: 'macOS' },
  { pattern: /linux|ubuntu|debian/i, value: 'Linux' },
  { pattern: /web|website|网站|网页|浏览器|h5/i, value: 'Web' },
  { pattern: /mini.?program|小程序/i, value: 'WeChat Mini Program' },
];

export function detectTargetPlatform(prompt: string): string {
  return PLATFORM_RULES.find(rule => rule.pattern.test(prompt))?.value ?? '';
}

function kindFromRules(prompt: string): AutopilotIntent['kind'] {
  const p = prompt.toLowerCase();
  if (/resume|继续.*(?:项目|开发|任务)|恢复.*(?:项目|开发)|接着.*(?:项目|开发)|pick up|continue (?:the )?project/.test(p)) return 'resume-project';
  if (/game|游戏|网游|手游|端游|私服|protocol|协议/.test(p)) return 'game-revival';
  if (/firmware|固件|烧录|flash|路由器.*(?:恢复|分析)|单片机/i.test(p)) return 'firmware-analysis';
  if (/security|安全|漏洞|渗透|headers?|cookies?|防御|被动扫描/i.test(p)) return 'defensive-security';
  if (/data recovery|recover (?:my )?data|恢复.*数据|数据.*恢复|救数据|找回文件|legacy|老软件|旧软件|dos|windows 98|兼容(?:运行|重建)/i.test(p)) return /data recovery|恢复.*数据|数据.*恢复|救数据|找回文件/i.test(p) ? 'data-recovery' : 'legacy-revival';
  if (/website|网站|网页|官网|landing|落地页|rebuild.*site|站点/i.test(p)) return 'website-rebuild';
  if (/apk|android app|安卓应用|反编译|decompile|software|软件|程序|桌面应用|重建.*应用/i.test(p)) return 'software-rebuild';
  return 'unknown';
}

const CAPABILITIES: Record<AutopilotIntent['kind'], AdapterName[]> = {
  'game-revival': ['game', 'file'], 'legacy-revival': ['legacy', 'file'], 'website-rebuild': ['website', 'file'],
  'data-recovery': ['legacy', 'file'], 'defensive-security': ['security', 'file'], 'firmware-analysis': ['firmware', 'file'],
  'software-rebuild': ['file', 'apk'], 'resume-project': ['file'], unknown: ['file'],
};

function deliveryFromRules(prompt: string, kind: AutopilotIntent['kind']): string[] {
  const p = prompt.toLowerCase(); const result: string[] = [];
  if (/website|网站|网页|官网|landing|落地页|web|静态站/i.test(p) || kind === 'website-rebuild') result.push('static-website');
  if (/source|源码|工程|project|项目|rebuild|重建|兼容服务|service/i.test(p)) result.push('source-project');
  if (/report|报告|分析|说明|文档/i.test(p) || ['data-recovery', 'defensive-security', 'firmware-analysis'].includes(kind)) result.push('report');
  if (/deploy|部署|上线|package|打包/i.test(p)) result.push('deployment-package');
  return unique(result);
}

export interface DetectIntentOptions { inputs?: Partial<IntentInputs>; answers?: JsonObject; source?: AutopilotIntent['source'] }

export function detectIntent(prompt: string, options?: DetectIntentOptions): AutopilotIntent;
export function detectIntent(input: { prompt: string; uploadIds?: string[]; paths?: string[]; urls?: string[] }, answers?: JsonObject): AutopilotIntent;
export function detectIntent(promptOrInput: string | { prompt: string; uploadIds?: string[]; paths?: string[]; urls?: string[] }, options: DetectIntentOptions | JsonObject = {}): AutopilotIntent {
  const objectInput = typeof promptOrInput === 'string' ? undefined : promptOrInput;
  const prompt = typeof promptOrInput === 'string' ? promptOrInput : promptOrInput.prompt;
  const opts = (objectInput ? options as JsonObject : options) as DetectIntentOptions;
  const supplied = objectInput ? { uploadIds: objectInput.uploadIds ?? [], paths: objectInput.paths ?? [], urls: objectInput.urls ?? [] } : opts.inputs;
  const inputs = normalizeIntentInputs(supplied);
  for (const url of prompt.match(/https?:\/\/[^\s<>"'，。；;]+/gi) ?? []) inputs.urls.push(url.replace(/[),.;]+$/, ''));
  for (const filePath of prompt.match(/(?:[A-Za-z]:\\[^\n;]+|\/(?:home|Users|tmp|var|mnt|opt)\/[^\n;]+)/g) ?? []) inputs.paths.push(filePath.trim());
  const normalized = normalizeIntentInputs(inputs);
  const kind = kindFromRules(prompt);
  const objectives = splitObjectives(prompt);
  const targetPlatform = detectTargetPlatform(prompt);
  const requiredCapabilities = [...CAPABILITIES[kind]];
  const delivery = deliveryFromRules(prompt, kind);
  const missing: string[] = [];
  const permissions: string[] = ['read-target', 'write-task-artifacts'];
  const risks: string[] = ['目标内容视为不可信数据，不能改变授权、工具或预算'];
  const limitations: string[] = ['规则识别只用于调度，不能替代真实分析证据'];
  if (kind === 'unknown') missing.push('明确目标类型和期望产物');
  if (['website-rebuild', 'defensive-security'].includes(kind) && normalized.urls.length === 0) missing.push('目标网站 URL');
  if (['game-revival', 'legacy-revival', 'data-recovery', 'firmware-analysis', 'software-rebuild', 'resume-project'].includes(kind) && normalized.uploadIds.length + normalized.paths.length + normalized.logIds.length === 0) missing.push('至少一个上传文件、绝对路径或日志材料');
  if (!targetPlatform) missing.push('目标平台');
  if (requiredCapabilities.length) permissions.push('execute-analyzer');
  let feasibility: AutopilotIntent['feasibility'] = 'FEASIBLE';
  if (kind === 'unknown') feasibility = 'NEEDS_INPUT';
  else if (missing.some(item => item.includes('URL') || item.includes('材料') || item.includes('上传文件'))) feasibility = 'NEEDS_INPUT';
  else if (missing.includes('目标平台')) feasibility = 'PARTIAL';
  if (/remote|云端|上传到.*(?:服务器|云)|external ai|远程模型/i.test(prompt)) risks.push('用户提到远程处理；默认仍为 local-only，需要单独授权');
  if (/password|密码|token|secret|密钥/i.test(prompt)) risks.push('提示词可能包含敏感信息；不得写入交付包或日志');
  return {
    kind, objectives: objectives.length ? objectives : [prompt.trim()].filter(Boolean), finalPurpose: prompt.trim(), inputs: normalized,
    targetPlatform, requiredCapabilities, delivery, missing: unique(missing), permissions: unique(permissions), feasibility,
    risks: unique(risks), limitations: unique(limitations), confidence: kind === 'unknown' ? 0.25 : Math.min(0.95, 0.55 + objectives.length * 0.08 + normalized.urls.length * 0.05),
    source: opts.source ?? 'rules',
  };
}

export const classifyIntent = detectIntent;
export const analyzeIntent = detectIntent;

const INTENT_SCHEMA = {
  type: 'object', required: ['kind', 'objectives', 'finalPurpose', 'inputs', 'targetPlatform', 'requiredCapabilities', 'delivery', 'missing', 'permissions', 'feasibility', 'risks', 'limitations', 'confidence', 'source'],
  properties: {
    kind: { enum: ['game-revival', 'legacy-revival', 'website-rebuild', 'data-recovery', 'defensive-security', 'firmware-analysis', 'software-rebuild', 'resume-project', 'unknown'] },
    objectives: { type: 'array', items: { type: 'string' } }, finalPurpose: { type: 'string' }, inputs: { type: 'object' }, targetPlatform: { type: 'string' },
    requiredCapabilities: { type: 'array', items: { type: 'string' } }, delivery: { type: 'array', items: { type: 'string' } }, missing: { type: 'array', items: { type: 'string' } },
    permissions: { type: 'array', items: { type: 'string' } }, feasibility: { enum: ['FEASIBLE', 'PARTIAL', 'NEEDS_INPUT', 'NEEDS_PERMISSION', 'NEEDS_TOOL', 'UNSUPPORTED', 'BLOCKED'] },
    risks: { type: 'array', items: { type: 'string' } }, limitations: { type: 'array', items: { type: 'string' } }, confidence: { type: 'number', minimum: 0, maximum: 1 }, source: { enum: ['rules', 'model', 'mixed'] },
  },
} as const;

/** Model output is advisory only. It must pass this schema and can never authorize execution. */
export function parseModelIntent(output: unknown): AutopilotIntent {
  // Kept dependency-free: the same bounded validator used by tools is imported lazily by callers when needed.
  if (!output || typeof output !== 'object' || Array.isArray(output)) throw new Error('Model intent output must be an object');
  const value = output as JsonObject;
  for (const key of INTENT_SCHEMA.required) if (!(key in value)) throw new Error(`Model intent output missing ${key}`);
  if (!INTENT_SCHEMA.properties.kind.enum.includes(value.kind as never)) throw new Error('Invalid model intent kind');
  if (!Array.isArray(value.objectives) || value.objectives.some(item => typeof item !== 'string')) throw new Error('Invalid model objectives');
  for (const key of ['delivery', 'missing', 'permissions', 'risks', 'limitations', 'requiredCapabilities'] as const) if (!Array.isArray(value[key]) || value[key].some(item => typeof item !== 'string')) throw new Error(`Invalid model ${key}`);
  if (typeof value.finalPurpose !== 'string' || typeof value.targetPlatform !== 'string') throw new Error('Invalid model intent text');
  if (!value.inputs || typeof value.inputs !== 'object' || Array.isArray(value.inputs)) throw new Error('Invalid model inputs');
  if (typeof value.confidence !== 'number' || value.confidence < 0 || value.confidence > 1) throw new Error('Invalid model confidence');
  if (!INTENT_SCHEMA.properties.feasibility.enum.includes(value.feasibility as never)) throw new Error('Invalid model feasibility');
  if (!INTENT_SCHEMA.properties.source.enum.includes(value.source as never)) throw new Error('Invalid model source');
  return { ...value, source: value.source === 'model' ? 'model' : value.source === 'mixed' ? 'mixed' : 'rules', inputs: normalizeIntentInputs(value.inputs as Partial<IntentInputs>) } as AutopilotIntent;
}

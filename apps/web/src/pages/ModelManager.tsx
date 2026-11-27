import { type FormEvent, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft, CheckCircle2, Cpu, Eye, EyeOff, KeyRound, Plus, Save,
  ServerCog, ShieldCheck, Sparkles, Wrench, XCircle,
} from 'lucide-react';
import {
  api, errorMessage, type ModelRole, type ProviderCapabilities, type ProviderKind,
  type ProviderLimits, type ProviderPublicView, type ProviderSaveInput,
} from '../api';
import { Badge, Button, Card, Empty, ErrorNotice, Field, Notice, Spinner, inputClass } from '../components/ui';

const roleLabels: Record<ModelRole, string> = { main: '主控', light: '轻量任务', code: '代码生成', multimodal: '多模态', reviewer: '独立复审', fallback: '故障切换' };
const providerKindLabels: Record<ProviderKind, string> = { 'openai-compatible': 'OpenAI 兼容', ollama: 'Ollama', custom: '自定义' };
const capabilityLabels: Array<[Exclude<keyof ProviderCapabilities, 'maxContextTokens'>, string]> = [['chat', 'Chat'], ['stream', 'Streaming'], ['tools', 'Tools'], ['structuredOutput', '结构化输出'], ['vision', 'Vision']];
const defaultLimits: ProviderLimits = { timeoutMs: 60_000, retries: 1, rateLimitPerMinute: 60, maxTokensPerRequest: 4096, maxTokensPerTask: 100_000, maxCostUsdPerTask: 5 };
const emptyCapabilities: ProviderCapabilities = { chat: true, stream: false, tools: false, structuredOutput: false, vision: false };

interface ProviderDraft {
  id: string; name: string; kind: ProviderKind; baseUrl: string; model: string; apiKey: string;
  enabled: boolean; priority: number; roles: ModelRole[]; capabilities: ProviderCapabilities; limits: ProviderLimits;
  createdAt?: string; updatedAt?: string; hasApiKey?: boolean; apiKeyRef?: string;
}
function draftFromProvider(provider: ProviderPublicView): ProviderDraft {
  return { ...provider, capabilities: { ...provider.capabilities }, limits: { ...provider.limits }, apiKey: '' };
}
function newDraft(): ProviderDraft {
  return { id: `provider-${crypto.randomUUID()}`, name: '', kind: 'openai-compatible', baseUrl: '', model: '', apiKey: '', enabled: true, priority: 100, roles: ['main'], capabilities: { ...emptyCapabilities }, limits: { ...defaultLimits } };
}
function toProvider(draft: ProviderDraft): ProviderPublicView {
  return {
    id: draft.id, name: draft.name, kind: draft.kind, baseUrl: draft.baseUrl, model: draft.model,
    ...(draft.apiKeyRef ? { apiKeyRef: draft.apiKeyRef } : {}), hasApiKey: Boolean(draft.hasApiKey || draft.apiKey),
    enabled: draft.enabled, priority: draft.priority, roles: draft.roles, capabilities: draft.capabilities, limits: draft.limits,
    createdAt: draft.createdAt ?? new Date().toISOString(), updatedAt: draft.updatedAt ?? new Date().toISOString(),
  };
}

function LegacyModelSettings() {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const [form, setForm] = useState({ enabled: false, baseUrl: 'http://127.0.0.1:11434/v1', model: '', apiKey: '', allowRemoteData: false });
  const [showKey, setShowKey] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    if (settings.data) setForm({ enabled: settings.data.enabled, baseUrl: settings.data.baseUrl, model: settings.data.model, apiKey: '', allowRemoteData: settings.data.allowRemoteData });
  }, [settings.data]);
  const save = useMutation({
    mutationFn: () => api.saveSettings(form),
    onSuccess: () => { setMessage('设置已保存；API Key 不会返回前端。'); setForm(current => ({ ...current, apiKey: '' })); void qc.invalidateQueries({ queryKey: ['settings'] }); },
    onError: error => setMessage(errorMessage(error)),
  });
  const test = useMutation({
    mutationFn: api.testSettings,
    onSuccess: result => setMessage(result.ok ? `连接成功（HTTP ${result.status}）` : result.error ?? '连接失败'),
    onError: error => setMessage(errorMessage(error)),
  });
  if (settings.isLoading) return <div className="flex items-center justify-center gap-2 p-12 text-sm text-muted"><Spinner/>读取模型设置…</div>;
  if (settings.isError) return <ErrorNotice error={settings.error} component="读取模型设置" onRetry={() => settings.refetch()}/>;
  return <div className="grid gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(300px,.8fr)]">
    <Card className="p-5 sm:p-6"><div className="flex items-center gap-2"><KeyRound className="h-4 w-4 text-accent"/><h2 className="text-sm font-semibold text-white">现有模型设置</h2><Badge tone={form.enabled ? 'success' : 'neutral'}>{form.enabled ? 'ENABLED' : 'DISABLED'}</Badge></div><p className="mt-3 text-xs leading-5 text-muted">当前服务端只暴露单模型设置。多角色 Provider API 可用后，此页会自动切换为角色路由、能力检测与故障切换管理。</p><div className="mt-5 space-y-4"><Field label="Base URL"><input className={inputClass} value={form.baseUrl} onChange={event => setForm({ ...form, baseUrl: event.target.value })}/></Field><Field label="模型名称"><input className={inputClass} value={form.model} onChange={event => setForm({ ...form, model: event.target.value })}/></Field><Field label="API Key" hint={settings.data?.hasApiKey ? '已保存加密密钥；留空保持不变。' : '仅保存在本机，使用 AES-256-GCM 加密。'}><div className="relative"><input type={showKey ? 'text' : 'password'} className={`${inputClass} pr-10`} value={form.apiKey} onChange={event => setForm({ ...form, apiKey: event.target.value })} placeholder={settings.data?.hasApiKey ? '••••••••（已配置）' : '可选；本地模型通常不需要'}/><button type="button" aria-label={showKey ? '隐藏 API Key' : '显示 API Key'} onClick={() => setShowKey(value => !value)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-accent">{showKey ? <EyeOff className="h-4 w-4"/> : <Eye className="h-4 w-4"/>}</button></div></Field><label className="flex items-center gap-3 rounded-lg border border-line bg-panel2/40 p-3 text-xs text-slate-300"><input type="checkbox" checked={form.enabled} onChange={event => setForm({ ...form, enabled: event.target.checked })} className="accent-[rgb(var(--accent))]"/>启用 AI 辅助分析</label><label className="flex items-start gap-3 rounded-lg border border-amber-400/20 p-3 text-xs leading-5 text-slate-300"><input type="checkbox" checked={form.allowRemoteData} onChange={event => setForm({ ...form, allowRemoteData: event.target.checked })} className="mt-1 accent-[rgb(var(--accent))]"/>允许将经过边界处理的分析摘要发送到非本地模型端点</label>{message && <div role="status" className="rounded-lg border border-line bg-panel2 p-3 text-xs text-slate-300">{message}</div>}<div className="flex gap-2"><Button disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? <Spinner/> : <Save className="h-3.5 w-3.5"/>}保存</Button><Button variant="secondary" disabled={test.isPending} onClick={() => test.mutate()}>{test.isPending ? <Spinner/> : <ServerCog className="h-3.5 w-3.5"/>}测试连接</Button></div></div></Card>
    <div className="space-y-5"><Card className="p-5"><h2 className="text-sm font-semibold text-white">多角色路由状态</h2><div className="mt-4 space-y-2">{Object.entries(roleLabels).map(([role, label]) => <div key={role} className="flex items-center justify-between rounded-lg border border-line bg-panel2/40 px-3 py-2 text-xs"><span className="text-slate-300">{label}</span><Badge tone="warn">API 未启用</Badge></div>)}</div></Card><Card className="p-5"><div className="flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-accent"/><h2 className="text-sm font-semibold text-white">密钥边界</h2></div><ul className="mt-3 space-y-2 text-[11px] leading-5 text-muted"><li>· API Key 只写不返显</li><li>· 远程端点必须使用 HTTPS</li><li>· 远程数据共享需单独授权</li><li>· 模型输出不能替代真实验收</li></ul></Card></div>
  </div>;
}

function ProviderManager() {
  const qc = useQueryClient();
  const providers = useQuery({ queryKey: ['model-providers'], queryFn: api.modelProviders });
  const [settings, setSettings] = useState<{ items: ProviderPublicView[]; roleAssignments: Partial<Record<Exclude<ModelRole, 'fallback'>, string[]>> }>();
  const [selectedId, setSelectedId] = useState('');
  const [draft, setDraft] = useState<ProviderDraft>(newDraft);
  const [remoteConsent, setRemoteConsent] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    if (!providers.data) return;
    setSettings(providers.data);
    if (!selectedId && providers.data.items[0]) { setSelectedId(providers.data.items[0]!.id); setDraft(draftFromProvider(providers.data.items[0]!)); }
  }, [providers.data, selectedId]);
  const selected = settings?.items.find(provider => provider.id === selectedId);
  const save = useMutation({
    mutationFn: async () => {
      if (!settings) throw new Error('设置尚未加载');
      if (!draft.name.trim() || !draft.baseUrl.trim() || !draft.model.trim()) throw new Error('Provider 名称、Base URL 与模型不能为空');
      const provider = toProvider(draft);
      const payload: ProviderSaveInput = { ...provider, ...(draft.apiKey ? { apiKey: draft.apiKey } : {}) };
      const exists = settings.items.some(item => item.id === draft.id);
      const items = exists ? settings.items.map(item => item.id === draft.id ? payload : item) : [...settings.items, payload];
      const saved = await api.saveModelProviders(items, remoteConsent);
      const roles = await api.saveModelRoles(settings.roleAssignments);
      return { ...saved, roleAssignments: roles.roleAssignments };
    },
    onSuccess: value => {
      setSettings(value);
      setDraft(current => ({ ...current, apiKey: '', hasApiKey: Boolean(current.hasApiKey || current.apiKey) }));
      setMessage('Provider 与角色路由已保存；密钥不会返回前端。');
      void qc.invalidateQueries({ queryKey: ['model-providers'] });
    },
    onError: error => setMessage(errorMessage(error)),
  });
  const test = useMutation({
    mutationFn: (id: string) => api.testModelProvider(id),
    onSuccess: result => { setMessage(result.ok ? '连通测试成功；仅成功探测到的能力会被标记为可用。' : result.error ?? '连通测试失败'); if (result.capabilities) setDraft(current => ({ ...current, capabilities: result.capabilities! })); void qc.invalidateQueries({ queryKey: ['model-providers'] }); },
    onError: error => setMessage(errorMessage(error)),
  });
  function selectProvider(provider: ProviderPublicView) { setSelectedId(provider.id); setDraft(draftFromProvider(provider)); setRemoteConsent(false); setMessage(''); }
  function addProvider() { const next = newDraft(); setSelectedId(next.id); setDraft(next); setRemoteConsent(false); setMessage(''); }
  function updateRole(role: Exclude<ModelRole, 'fallback'>, id: string, checked: boolean) {
    if (!settings) return;
    const current = settings.roleAssignments[role] ?? [];
    setSettings({ ...settings, roleAssignments: { ...settings.roleAssignments, [role]: checked ? [...new Set([...current, id])] : current.filter(item => item !== id) } });
  }
  function submit(event: FormEvent) { event.preventDefault(); save.mutate(); }

  if (providers.isLoading) return <div className="flex items-center justify-center gap-2 p-12 text-sm text-muted"><Spinner/>读取 Provider…</div>;
  if (providers.isError) return <ErrorNotice error={providers.error} component="读取 Provider" onRetry={() => providers.refetch()}/>;
  if (!settings) return null;
  const isNew = !settings.items.some(provider => provider.id === draft.id);
  return <div className="grid gap-5 xl:grid-cols-[minmax(280px,.7fr)_minmax(0,1.3fr)]">
    <div className="space-y-5"><Card className="p-4"><div className="mb-3 flex items-center justify-between"><h2 className="text-sm font-semibold text-white">Providers</h2><Button variant="ghost" onClick={addProvider}><Plus className="h-3.5 w-3.5"/>新增</Button></div>{settings.items.length ? <div className="space-y-2">{settings.items.map(provider => <button key={provider.id} type="button" onClick={() => selectProvider(provider)} className={`w-full rounded-lg border p-3 text-left transition ${selectedId === provider.id ? 'border-accent/60 bg-accent/10' : 'border-line bg-panel2/40 hover:border-accent/40'}`}><div className="flex items-center justify-between gap-2"><span className="truncate text-xs font-medium text-slate-200">{provider.name}</span><Badge tone={provider.enabled ? 'success' : 'neutral'}>{provider.enabled ? '启用' : '停用'}</Badge></div><div className="mt-1 truncate font-mono text-[10px] text-muted">{provider.kind} · {provider.model}</div><div className="mt-2 flex flex-wrap gap-1">{provider.roles.map(role => <span key={role} className="rounded border border-line px-1.5 py-0.5 font-mono text-[9px] text-muted">{roleLabels[role]}</span>)}</div></button>)}</div> : <Empty title="尚未配置 Provider" description="新增一个 OpenAI 兼容、Ollama 或自定义 Provider。无 Key 时仍可使用规则型执行。"/>}</Card><Card className="p-5"><h2 className="text-sm font-semibold text-white">角色路由</h2><p className="mt-2 text-[11px] leading-5 text-muted">按优先级选择 Provider；未命中时回退到标记为 fallback 的 Provider。</p><div className="mt-4 space-y-3">{Object.entries(roleLabels).filter(([role]) => role !== 'fallback').map(([role, label]) => <div key={role}><div className="mb-1.5 text-[11px] font-medium text-slate-300">{label}</div><div className="space-y-1">{settings.items.map(provider => <label key={provider.id} className="flex items-center gap-2 text-[10px] text-muted"><input type="checkbox" checked={(settings.roleAssignments[role as Exclude<ModelRole, 'fallback'>] ?? []).includes(provider.id)} onChange={event => updateRole(role as Exclude<ModelRole, 'fallback'>, provider.id, event.target.checked)} className="accent-[rgb(var(--accent))]"/>{provider.name}</label>)}</div></div>)}</div></Card></div>

    <form onSubmit={submit} className="space-y-5"><Card className="p-5 sm:p-6"><div className="flex flex-wrap items-center justify-between gap-3"><div><div className="flex items-center gap-2"><Cpu className="h-4 w-4 text-accent"/><h2 className="text-sm font-semibold text-white">{isNew ? '新增 Provider' : 'Provider 配置'}</h2></div><p className="mt-1 font-mono text-[10px] text-muted">{draft.id}</p></div><Button type="button" variant="secondary" disabled={isNew || test.isPending} onClick={() => test.mutate(draft.id)}>{test.isPending ? <Spinner/> : <ServerCog className="h-3.5 w-3.5"/>}测试连接</Button></div>
      <div className="mt-5 grid gap-4 md:grid-cols-2"><Field label="名称"><input className={inputClass} value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} placeholder="例如：本地主控模型"/></Field><Field label="类型"><select className={inputClass} value={draft.kind} onChange={event => setDraft({ ...draft, kind: event.target.value as ProviderKind })}>{Object.entries(providerKindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field><Field label="Base URL"><input className={inputClass} value={draft.baseUrl} onChange={event => setDraft({ ...draft, baseUrl: event.target.value })} placeholder="http://127.0.0.1:11434/v1"/></Field><Field label="模型"><input className={inputClass} value={draft.model} onChange={event => setDraft({ ...draft, model: event.target.value })} placeholder="llama3.2 / gpt-4o-mini"/></Field><Field label="API Key" hint={draft.hasApiKey ? '已保存加密密钥；留空保持不变。' : '只写不返显；本地模型通常不需要。'}><div className="relative"><input type={showKey ? 'text' : 'password'} className={`${inputClass} pr-10`} value={draft.apiKey} onChange={event => setDraft({ ...draft, apiKey: event.target.value })} placeholder={draft.hasApiKey ? '••••••••（已配置）' : '可选'}/><button type="button" aria-label={showKey ? '隐藏 API Key' : '显示 API Key'} onClick={() => setShowKey(value => !value)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-accent">{showKey ? <EyeOff className="h-4 w-4"/> : <Eye className="h-4 w-4"/>}</button></div></Field><Field label="优先级" hint="数值越小越优先。"><input type="number" min={0} className={inputClass} value={draft.priority} onChange={event => setDraft({ ...draft, priority: Number(event.target.value) })}/></Field></div>
      <div className="mt-4 flex flex-wrap gap-2"><Button type="button" variant={draft.enabled ? 'primary' : 'secondary'} onClick={() => setDraft({ ...draft, enabled: !draft.enabled })}>{draft.enabled ? <CheckCircle2 className="h-3.5 w-3.5"/> : <XCircle className="h-3.5 w-3.5"/>}{draft.enabled ? '已启用' : '已停用'}</Button>{Object.entries(roleLabels).map(([role, label]) => { const checked = draft.roles.includes(role as ModelRole); return <button key={role} type="button" aria-pressed={checked} onClick={() => setDraft({ ...draft, roles: checked ? draft.roles.filter(item => item !== role) : [...draft.roles, role as ModelRole] })} className={`rounded-lg border px-2.5 py-1.5 text-[10px] ${checked ? 'border-accent/50 bg-accent/10 text-accent' : 'border-line text-muted'}`}>{label}</button>; })}</div>
      <label className="mt-4 flex items-start gap-3 rounded-lg border border-amber-400/20 p-3 text-xs leading-5 text-slate-300"><input type="checkbox" checked={remoteConsent} onChange={event => setRemoteConsent(event.target.checked)} className="mt-1 accent-[rgb(var(--accent))]"/>允许将必要数据发送到非本地模型端点。远程 Provider 必须显式授权；本地 Provider 不需要此项。</label>
      {message && <div role="status" className="mt-4 rounded-lg border border-line bg-panel2 p-3 text-xs text-slate-300">{message}</div>}
      <div className="mt-5 flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => { setDraft(selected ? draftFromProvider(selected) : newDraft()); setRemoteConsent(false); }}>重置</Button><Button type="submit" disabled={save.isPending}>{save.isPending ? <Spinner/> : <Save className="h-3.5 w-3.5"/>}保存 Provider 与角色路由</Button></div>
    </Card>

    <Card className="p-5"><div className="flex items-center gap-2"><Sparkles className="h-4 w-4 text-accent"/><h2 className="text-sm font-semibold text-white">能力检测</h2><Badge tone="info">仅标记真实成功</Badge></div><div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">{capabilityLabels.map(([key, label]) => <label key={key} className="flex items-center gap-2 rounded-lg border border-line bg-panel2/40 p-3 text-xs text-slate-300"><input type="checkbox" checked={draft.capabilities[key]} onChange={event => setDraft({ ...draft, capabilities: { ...draft.capabilities, [key]: event.target.checked } })} className="accent-[rgb(var(--accent))]"/>{label}</label>)}</div><p className="mt-3 text-[11px] leading-5 text-muted">手动勾选只表示配置意图；保存后应运行“测试连接”，由服务端探测结果更新真实能力。</p></Card>

    <Card className="p-5"><div className="flex items-center gap-2"><Wrench className="h-4 w-4 text-accent"/><h2 className="text-sm font-semibold text-white">预算与限制</h2></div><div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3"><Field label="超时 (ms)"><input type="number" min={1} className={inputClass} value={draft.limits.timeoutMs} onChange={event => setDraft({ ...draft, limits: { ...draft.limits, timeoutMs: Number(event.target.value) } })}/></Field><Field label="重试次数"><input type="number" min={0} className={inputClass} value={draft.limits.retries} onChange={event => setDraft({ ...draft, limits: { ...draft.limits, retries: Number(event.target.value) } })}/></Field><Field label="每分钟请求数"><input type="number" min={1} className={inputClass} value={draft.limits.rateLimitPerMinute} onChange={event => setDraft({ ...draft, limits: { ...draft.limits, rateLimitPerMinute: Number(event.target.value) } })}/></Field><Field label="单次 Token 上限"><input type="number" min={1} className={inputClass} value={draft.limits.maxTokensPerRequest} onChange={event => setDraft({ ...draft, limits: { ...draft.limits, maxTokensPerRequest: Number(event.target.value) } })}/></Field><Field label="单任务 Token 上限"><input type="number" min={1} className={inputClass} value={draft.limits.maxTokensPerTask} onChange={event => setDraft({ ...draft, limits: { ...draft.limits, maxTokensPerTask: Number(event.target.value) } })}/></Field><Field label="单任务费用上限 (USD)"><input type="number" min={0} step="0.01" className={inputClass} value={draft.limits.maxCostUsdPerTask} onChange={event => setDraft({ ...draft, limits: { ...draft.limits, maxCostUsdPerTask: Number(event.target.value) } })}/></Field></div></Card>
    </form>
  </div>;
}

export default function ModelManager() {
  const providers = useQuery({ queryKey: ['model-providers'], queryFn: api.modelProviders, retry: false });
  return <div className="mx-auto max-w-7xl pb-10"><div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between"><div><Link to="/autopilot" className="mb-3 inline-flex items-center gap-2 text-xs text-muted hover:text-accent"><ArrowLeft className="h-3.5 w-3.5"/>Autopilot</Link><div className="mb-2 font-mono text-[11px] uppercase tracking-[.2em] text-accent">Model management</div><h1 className="text-2xl font-semibold tracking-tight text-white">模型管理</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-muted">按角色配置 Provider、探测真实能力并限制预算。API Key 仅写入，绝不返显。</p></div><Badge tone={providers.isSuccess ? 'success' : 'warn'}>{providers.isSuccess ? 'V4 PROVIDER API' : '兼容单模型模式'}</Badge></div>{providers.isError && <div className="mb-5"><Notice tone="warn">多角色 Provider API 当前不可用，已回退到现有单模型设置。页面不会伪造角色路由或能力检测结果。</Notice></div>}{providers.isSuccess ? <ProviderManager/> : <LegacyModelSettings/>}</div>;
}

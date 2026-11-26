import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, KeyRound, Save, ServerCog, ShieldCheck } from 'lucide-react';
import { api, errorMessage, request } from '../api';
import { Badge, Button, Card, Field, PageTitle, Spinner, inputClass } from '../components/ui';
import SafetyNotice, { SafetyNoticeContent } from '../components/SafetyNotice';

export default function Settings() {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const adapters = useQuery({ queryKey: ['adapters'], queryFn: api.adapters });
  const health = useQuery({ queryKey: ['health'], queryFn: () => request<{ ok: boolean; version: string; worker: string }>('/health') });
  const [form, setForm] = useState({ enabled: false, baseUrl: 'http://127.0.0.1:11434/v1', model: '', apiKey: '', allowRemoteData: false });
  const [message, setMessage] = useState('');
  const [safetyOpen, setSafetyOpen] = useState(false);

  useEffect(() => {
    if (settings.data) setForm({ enabled: settings.data.enabled, baseUrl: settings.data.baseUrl, model: settings.data.model, apiKey: '', allowRemoteData: settings.data.allowRemoteData });
  }, [settings.data]);

  const save = useMutation({
    mutationFn: () => api.saveSettings(form),
    onSuccess: () => { setMessage('设置已加密保存；API Key 不会返回前端。'); void qc.invalidateQueries({ queryKey: ['settings'] }); },
    onError: error => setMessage(errorMessage(error)),
  });
  const test = useMutation({
    mutationFn: api.testSettings,
    onSuccess: result => setMessage(result.ok ? `模型端点连接成功（HTTP ${result.status}）` : result.error ?? '连接失败'),
    onError: error => setMessage(errorMessage(error)),
  });

  return <>
    <PageTitle title="设置中心" description="模型、工具与安全边界。默认关闭 AI；未配置密钥时，文件识别、静态分析和规则扫描仍然可用。"/>
    <div className="grid gap-5 xl:grid-cols-[1.25fr_1fr]">
      <Card className="p-5 sm:p-6">
        <div className="flex items-center gap-2"><KeyRound className="h-4 w-4 text-accent"/><h2 className="text-sm font-semibold text-white">AI 模型配置</h2><Badge tone={form.enabled ? 'success' : 'neutral'}>{form.enabled ? 'ENABLED' : 'DISABLED'}</Badge></div>
        <p className="mt-3 text-xs leading-5 text-muted">支持 OpenAI 兼容接口与本地 Ollama。模型输出只记为 INFERENCE；启用远程端点必须明确允许发送分析摘要。</p>
        <div className="mt-5 space-y-4">
          <Field label="Base URL"><input className={inputClass} value={form.baseUrl} onChange={event => setForm({ ...form, baseUrl: event.target.value })} placeholder="http://127.0.0.1:11434/v1"/></Field>
          <Field label="模型名称"><input className={inputClass} value={form.model} onChange={event => setForm({ ...form, model: event.target.value })} placeholder="llama3.2 / gpt-4o-mini"/></Field>
          <Field label="API Key" hint={settings.data?.hasApiKey ? '已保存加密密钥；留空保持不变。' : '仅保存在本机，使用 AES-256-GCM 加密。'}><input type="password" className={inputClass} value={form.apiKey} onChange={event => setForm({ ...form, apiKey: event.target.value })} placeholder={settings.data?.hasApiKey ? '••••••••（已配置）' : '可选；本地模型通常不需要'}/></Field>
          <label className="flex items-center gap-3 rounded-lg border border-line bg-panel2/40 p-3 text-xs text-slate-300"><input type="checkbox" checked={form.enabled} onChange={event => setForm({ ...form, enabled: event.target.checked })} className="accent-[rgb(var(--accent))]"/>启用 AI 辅助分析</label>
          <label className="flex items-start gap-3 rounded-lg border border-amber-400/20 p-3 text-xs leading-5 text-slate-300"><input type="checkbox" checked={form.allowRemoteData} onChange={event => setForm({ ...form, allowRemoteData: event.target.checked })} className="mt-1 accent-[rgb(var(--accent))]"/>允许将经过边界处理的分析摘要发送到非本地模型端点</label>
          {message && <div role="status" className="rounded-lg border border-line bg-panel2 p-3 text-xs text-slate-300">{message}</div>}
          <div className="flex gap-2"><Button disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? <Spinner/> : <Save className="h-3.5 w-3.5"/>}保存</Button><Button variant="secondary" disabled={test.isPending} onClick={() => test.mutate()}>{test.isPending ? <Spinner/> : <ServerCog className="h-3.5 w-3.5"/>}测试连接</Button></div>
        </div>
      </Card>
      <div className="space-y-5">
        <Card className="p-5">
          <div className="flex items-center justify-between"><h2 className="text-sm font-semibold text-white">运行环境</h2><Badge tone={health.data?.ok ? 'success' : 'danger'}>{health.data?.ok ? 'API 在线' : 'API 离线'}</Badge></div>
          <dl className="mt-4 space-y-3 text-[11px]"><div className="flex justify-between"><dt className="text-muted">版本</dt><dd className="font-mono text-slate-300">{health.data?.version ?? '—'}</dd></div><div className="flex justify-between"><dt className="text-muted">Worker</dt><dd className="text-slate-300">独立进程</dd></div><div className="flex justify-between"><dt className="text-muted">任务并发</dt><dd className="font-mono text-slate-300">1</dd></div><div className="flex justify-between"><dt className="text-muted">数据目录</dt><dd className="font-mono text-slate-300">./data</dd></div><div className="flex justify-between"><dt className="text-muted">访问绑定</dt><dd className="font-mono text-slate-300">127.0.0.1</dd></div></dl>
        </Card>
        <Card className="p-5"><h2 className="text-sm font-semibold text-white">分析工具</h2><div className="mt-4 space-y-3">{adapters.data?.map(adapter => <div key={adapter.name} className="border-b border-line/60 pb-3 last:border-0 last:pb-0"><div className="flex items-center justify-between"><span className="font-mono text-xs text-slate-200">{adapter.name}</span><Badge tone={adapter.available ? 'success' : 'danger'}>{adapter.available ? '可用' : '缺依赖'}</Badge></div><p className="mt-1.5 text-[10px] leading-4 text-muted">{adapter.detail}</p></div>)}</div><Link to="/tools" className="mt-4 inline-flex text-xs text-accent">查看官方安装指引 →</Link></Card>
        <Card className="p-5"><div className="flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-accent"/><h2 className="text-sm font-semibold text-white">首次使用安全提示</h2></div><p className="mt-2 text-xs leading-5 text-muted">重新查看只读、授权责任、AI 误差、设备风险、隐私和许可证说明。</p><Button variant="secondary" className="mt-4" onClick={() => setSafetyOpen(true)}>重新查看安全提示</Button><div className="mt-4"><SafetyNoticeContent compact/></div></Card>
        <Card className="p-5"><div className="flex items-center gap-2"><CheckCircle2 className="h-4 w-4 text-accent"/><h2 className="text-sm font-semibold text-white">默认安全策略</h2></div><ul className="mt-3 space-y-2 text-[11px] leading-5 text-muted"><li>· 不执行上传的未知程序</li><li>· SSRF、重定向和跨站请求防护</li><li>· 原始日志不记录 Cookie 与 Authorization</li><li>· 外部内容不进入系统指令</li><li>· 所有产物可下载并核对 SHA-256</li></ul></Card>
      </div>
    </div>
    <SafetyNotice open={safetyOpen} onClose={() => setSafetyOpen(false)}/>
  </>;
}

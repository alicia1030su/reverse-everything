import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, CheckCircle2, Download, Globe2, HardDrive, ShieldCheck, Sparkles, Usb, X } from 'lucide-react';
import { api, errorMessage } from '../api';
import { Badge, Button, Spinner } from './ui';
import { SafetyNoticeContent } from './SafetyNotice';

const storageKey = 'reverse-everything:onboarding:v1';
type Step = 0 | 1 | 2 | 3 | 4;
interface Completion { completed: boolean; scenario?: string; ai?: 'configured' | 'skipped' }

const scenarios = [
  { id: 'website', label: '网页分析', icon: Globe2 },
  { id: 'software', label: '软件分析', icon: HardDrive },
  { id: 'hardware', label: 'USB 硬件', icon: Usb },
  { id: 'security', label: '安全分析', icon: ShieldCheck },
];

export default function Onboarding() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>(0);
  const [scenario, setScenario] = useState('website');
  const [notice, setNotice] = useState('');
  const [safetyConfirmed, setSafetyConfirmed] = useState(false);
  const [demoLoading, setDemoLoading] = useState(false);
  const adapters = useQuery({ queryKey: ['adapters'], queryFn: api.adapters, enabled: open && step === 2 });
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings, enabled: open && step === 3 });

  useEffect(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(storageKey) ?? '{}') as Completion;
      setOpen(saved.completed !== true);
    } catch {
      setOpen(true);
    }
  }, []);

  function finish(ai: Completion['ai'] = 'skipped'): void {
    if (!safetyConfirmed) return;
    try {
      window.localStorage.setItem(storageKey, JSON.stringify({ completed: true, scenario, ai } satisfies Completion));
    } catch {
      // 隐私模式下仅跳过当前会话，不阻止基础分析。
    }
    setOpen(false);
  }

  async function downloadDemo(): Promise<void> {
    setDemoLoading(true);
    setNotice('');
    try {
      const trace = await api.demoTrace();
      const url = URL.createObjectURL(trace);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = trace.name;
      anchor.click();
      URL.revokeObjectURL(url);
      setNotice('演示记录已下载。可在创建页面选择“游戏复活”并上传，验证完整流程。');
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setDemoLoading(false);
    }
  }

  if (!open) return null;
  const available = adapters.data?.filter(item => item.available).length ?? 0;
  const total = adapters.data?.length ?? 0;

  return <div className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-[rgb(var(--overlay)/.72)] p-4 backdrop-blur-sm">
    <section role="dialog" aria-modal="true" aria-labelledby="onboarding-title" className="w-full max-w-2xl rounded-2xl border border-line bg-panel p-5 shadow-glow sm:p-7">
      <div className="flex items-start justify-between gap-4">
        <div><Badge tone="info">首次使用 · 安全优先</Badge><h2 id="onboarding-title" className="mt-3 text-xl font-semibold text-white">首次使用引导</h2><p className="mt-2 text-sm leading-6 text-muted">先阅读并确认安全边界，再了解工作区。AI 与演示均为可选，不会阻塞本地基础分析。</p></div>
        {safetyConfirmed && <Button variant="ghost" aria-label="关闭首次使用引导" onClick={() => finish('skipped')}><X className="h-4 w-4"/></Button>}
      </div>
      <ol className="mt-6 grid grid-cols-5 gap-2" aria-label="引导步骤">
        {['安全', '场景', '环境', '可选 AI', '演示'].map((label, index) => <li key={label} className={`border-t-2 pt-2 text-xs ${index <= step ? 'border-accent text-accent' : 'border-line text-muted'}`}>{index + 1}. {label}</li>)}
      </ol>
      <div className="mt-6 min-h-56">
        {step === 0 && <div><h3 className="text-sm font-semibold text-white">开始前，请了解安全边界</h3><p className="mt-1 text-xs leading-5 text-muted">以下内容适用于所有页面与演示，必须先阅读并明确确认后才能继续。</p><div className="mt-4 max-h-[340px] overflow-y-auto pr-1"><SafetyNoticeContent compact/></div><label className="mt-4 flex items-start gap-3 rounded-xl border border-amber-400/20 p-3 text-xs leading-5 text-slate-200"><input aria-label="确认已阅读并理解安全提示" type="checkbox" checked={safetyConfirmed} onChange={event => setSafetyConfirmed(event.target.checked)} className="mt-1 accent-[rgb(var(--accent))]"/>我已阅读并理解上述只读、授权、AI、设备、隐私与许可证边界。</label></div>}
        {step === 1 && <div><h3 className="text-sm font-semibold text-white">你最常分析什么？</h3><p className="mt-1 text-xs text-muted">只用于给出创建页建议，不会上传任何内容。</p><div className="mt-4 grid gap-3 sm:grid-cols-2">{scenarios.map(({ id, label, icon: Icon }) => <button key={id} type="button" aria-pressed={scenario === id} onClick={() => setScenario(id)} className={`flex min-h-16 items-center gap-3 rounded-xl border p-4 text-left text-sm ${scenario === id ? 'border-accent bg-accent/10 text-accent' : 'border-line bg-panel2 text-slate-300'}`}><Icon className="h-5 w-5"/>{label}{scenario === id && <CheckCircle2 className="ml-auto h-4 w-4"/>}</button>)}</div></div>}
        {step === 2 && <div><h3 className="text-sm font-semibold text-white">环境检测</h3><p className="mt-1 text-xs leading-5 text-muted">以下结果来自本机 API 的真实适配器探测，不安装驱动，也不要求管理员权限。</p>{adapters.isLoading ? <div className="mt-5 flex items-center gap-2 text-sm text-muted"><Spinner/>正在检测…</div> : adapters.isError ? <p role="alert" className="mt-4 text-sm text-red-300">{errorMessage(adapters.error)}</p> : <div className="mt-4 rounded-xl border border-line bg-panel2 p-4"><div className="flex items-center justify-between"><span className="text-sm text-slate-200">可用分析器</span><Badge tone="success">{available} / {total}</Badge></div><p className="mt-3 text-xs leading-5 text-muted">离线文件、安全静态检查等内置能力可直接使用；缺失的外部工具只影响对应分析器。</p></div>}</div>}
        {step === 3 && <div><h3 className="flex items-center gap-2 text-sm font-semibold text-white"><Sparkles className="h-4 w-4 text-accent"/>可选 AI 解释</h3><p className="mt-2 text-sm leading-6 text-muted">AI 只能解释已有工具证据，不能替代分析结果。密钥仅保存在服务端设置中。</p>{settings.isLoading ? <div className="mt-4 flex items-center gap-2 text-sm text-muted"><Spinner/>读取设置…</div> : settings.data ? <div className="mt-4 flex items-center gap-2 text-sm text-slate-300"><Badge tone={settings.data.enabled ? 'success' : 'neutral'}>{settings.data.enabled ? '已启用' : '未启用'}</Badge>{settings.data.enabled ? '基础分析将附带模型解释。' : '当前仅使用规则与工具证据。'}</div> : null}<div className="mt-5 flex flex-wrap gap-2"><Button variant="secondary" onClick={() => navigate('/settings')}>前往配置 AI</Button><Button variant="secondary" onClick={() => setStep(4)}>跳过 AI，继续</Button></div></div>}
        {step === 4 && <div><h3 className="text-sm font-semibold text-white">演示与创建任务</h3><p className="mt-2 text-sm leading-6 text-muted">下载项目自带的真实迷你游戏通信记录，或直接创建自己的任务。没有记录也可以先浏览工作区。</p><Button variant="secondary" className="mt-4" disabled={demoLoading} onClick={() => void downloadDemo()}>{demoLoading ? <Spinner/> : <Download className="h-4 w-4"/>}{demoLoading ? '正在下载…' : '下载演示回放记录'}</Button>{notice && <p role="status" className="mt-3 text-xs leading-5 text-muted">{notice}</p>}<Button className="mt-5 w-full sm:w-auto" onClick={() => finish('skipped')}>完成引导，开始分析<ArrowRight className="h-4 w-4"/></Button></div>}
      </div>
      <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
        {step > 0 && <Button variant="ghost" onClick={() => finish('skipped')}>先开始基础分析</Button>}
        <div className="flex gap-2">{step > 0 && <Button variant="secondary" onClick={() => setStep((step - 1) as Step)}>上一步</Button>}{step < 4 && <Button disabled={step === 0 && !safetyConfirmed} onClick={() => setStep((step + 1) as Step)}>{step === 0 ? '下一步：选择场景' : step === 2 ? '下一步：可选 AI' : '下一步'}<ArrowRight className="h-4 w-4"/></Button>}</div>
      </div>
    </section>
  </div>;
}

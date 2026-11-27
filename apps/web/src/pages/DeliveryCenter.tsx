import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft, ArrowRight, CheckCircle2, ChevronRight, CircleAlert, Download, FileCheck2,
  FileText, FolderOpen, Package, ShieldCheck, Sparkles, XCircle,
} from 'lucide-react';
import {
  api, autopilotArtifactUrl, type AutopilotTask,
} from '../api';
import { Badge, Button, Card, Empty, ErrorNotice, Notice, Spinner, inputClass } from '../components/ui';

const deliveryStatuses = new Set(['COMPLETED', 'PARTIAL_SUCCESS', 'FAILED', 'BLOCKED', 'CANCELLED']);
const statusLabels: Record<string, string> = {
  COMPLETED: '已完成', PARTIAL_SUCCESS: '部分完成', FAILED: '失败', BLOCKED: '受阻', CANCELLED: '已取消',
  WAITING_FOR_APPROVAL: '等待确认', WAITING_FOR_USER: '等待补充', PAUSED: '已暂停', RUNNING: '执行中',
};
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}
function taskStatusTone(status: string): 'success' | 'warn' | 'danger' | 'info' | 'neutral' {
  if (status === 'COMPLETED') return 'success';
  if (['FAILED', 'BLOCKED', 'CANCELLED'].includes(status)) return 'danger';
  if (['WAITING_FOR_APPROVAL', 'WAITING_FOR_USER', 'PAUSED', 'PARTIAL_SUCCESS'].includes(status)) return 'warn';
  return 'info';
}
function isTextArtifact(name: string): boolean {
  return /\.(md|txt|json|html?|css|js|ts|tsx|py|yml|yaml|csv|log)$/i.test(name) || /readme|tutorial|deploy|accept|manifest|sha256/i.test(name);
}

function DeliveryList() {
  const [searchParams] = useSearchParams();
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const [projectId, setProjectId] = useState(searchParams.get('projectId') ?? '');
  useEffect(() => {
    if (!projectId && projects.data?.length) setProjectId(projects.data[0]!.id);
  }, [projects.data, projectId]);
  const tasks = useQuery({
    queryKey: ['autopilot-tasks', projectId], queryFn: () => api.autopilotTasks(projectId),
    enabled: Boolean(projectId), refetchInterval: 5000,
  });
  const items = useMemo(() => (tasks.data?.items ?? []).filter(task => deliveryStatuses.has(task.status) || task.status === 'WAITING_FOR_USER'), [tasks.data]);

  return <div className="mx-auto max-w-6xl pb-10">
    <Link to="/autopilot" className="mb-4 inline-flex items-center gap-2 text-xs text-muted hover:text-accent"><ArrowLeft className="h-3.5 w-3.5"/>返回 Autopilot</Link>
    <header className="mb-7 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between"><div><div className="mb-2 font-mono text-[11px] uppercase tracking-[.2em] text-accent">Delivery center</div><h1 className="text-2xl font-semibold tracking-tight text-white">交付中心</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-muted">查看真实成品、SHA-256 校验、教程与独立验收结果。这里不会把模型自述当作验证成功。</p></div><Link to="/autopilot"><Button><Sparkles className="h-3.5 w-3.5"/>新建 Autopilot 任务</Button></Link></header>
    <Card className="mb-5 flex flex-col gap-3 p-4 sm:flex-row sm:items-center"><label htmlFor="delivery-project" className="text-xs font-medium text-slate-300">项目</label><select id="delivery-project" aria-label="交付项目" className={`${inputClass} sm:max-w-md`} value={projectId} onChange={event => setProjectId(event.target.value)} disabled={projects.isLoading}><option value="">请选择项目</option>{projects.data?.map(project => <option key={project.id} value={project.id}>{project.name} · {project.kind}</option>)}</select></Card>
    <Card>
      {!projectId ? <Empty title="先选择一个项目" description="交付中心按项目读取 Autopilot 任务，避免混用不同授权范围。" action={<Link to="/projects"><Button>打开项目档案</Button></Link>}/> : tasks.isLoading ? <div className="flex items-center justify-center gap-2 p-12 text-sm text-muted"><Spinner/>读取交付任务…</div> : tasks.isError ? <div className="p-4"><ErrorNotice error={tasks.error} component="读取交付任务" onRetry={() => tasks.refetch()}/></div> : items.length ? <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-left text-xs"><thead className="border-b border-line text-[10px] uppercase tracking-wider text-muted"><tr><th className="px-5 py-3 font-medium">任务</th><th className="px-3 py-3 font-medium">状态</th><th className="px-3 py-3 font-medium">计划步骤</th><th className="px-3 py-3 font-medium">模型调用</th><th className="px-3 py-3 font-medium">更新时间</th><th className="px-5 py-3"/></tr></thead><tbody className="divide-y divide-line/70">{items.map(task => { const steps = task.plan?.steps ?? []; const done = steps.filter(step => step.status === 'SUCCEEDED' || step.status === 'SKIPPED').length; return <tr key={task.id} className="hover:bg-white/[.02]"><td className="max-w-md px-5 py-4"><div className="truncate font-medium text-slate-200">{task.prompt}</div><div className="mt-1 font-mono text-[10px] text-muted">{task.id}</div></td><td className="px-3 py-4"><Badge tone={taskStatusTone(task.status)}>{statusLabels[task.status] ?? task.status}</Badge></td><td className="px-3 py-4 font-mono text-[11px] text-slate-300">{steps.length ? `${done}/${steps.length}` : '—'}</td><td className="px-3 py-4 font-mono text-[11px] text-slate-300">{task.metrics.modelCalls}</td><td className="px-3 py-4 text-[10px] text-muted">{new Date(task.updatedAt).toLocaleString('zh-CN')}</td><td className="px-5 py-4 text-right"><Link aria-label={`查看交付 ${task.id}`} to={`/delivery/${task.id}`} className="inline-flex min-h-9 min-w-9 items-center justify-center text-muted hover:text-accent"><ChevronRight className="h-4 w-4"/></Link></td></tr>; })}</tbody></table></div> : <Empty title="还没有可展示的交付" description="任务完成、部分完成或失败后，真实工件与验收报告会出现在这里。"/>}
    </Card>
  </div>;
}

interface TextDocument { name: string; content: string }
interface AcceptanceReport { status?: string; checks?: Array<{ name?: string; passed?: boolean; evidence?: string }>; limitations?: string[]; reviewer?: string }

function AcceptanceView({ report, task }: { report: AcceptanceReport | undefined; task: AutopilotTask }) {
  if (!report) {
    const verify = task.plan?.steps.find(step => step.kind === 'verify');
    return <Notice tone="warn">尚未生成独立验收报告。{verify ? `当前验收步骤状态：${verify.status}。` : '当前计划没有验收步骤。'}任务状态本身不能替代工件校验。</Notice>;
  }
  const checks = report.checks ?? [];
  const passed = checks.filter(check => check.passed).length;
  return <div className="space-y-4"><div className="flex flex-wrap items-center gap-2"><Badge tone={report.status === 'DELIVERABLE_VERIFIED' ? 'success' : report.status === 'DELIVERABLE_PARTIAL' ? 'warn' : 'danger'}>{report.status ?? 'UNKNOWN'}</Badge>{report.reviewer && <span className="font-mono text-[10px] text-muted">reviewer: {report.reviewer}</span>}{checks.length > 0 && <span className="font-mono text-[10px] text-muted">{passed}/{checks.length} checks passed</span>}</div>{checks.length ? <ul className="space-y-2">{checks.map((check, index) => <li key={`${check.name}-${index}`} className="flex gap-3 rounded-lg border border-line bg-panel2/40 p-3">{check.passed ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400"/> : <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-400"/>}<div><div className="text-xs font-medium text-slate-200">{check.name ?? `检查 ${index + 1}`}</div>{check.evidence && <p className="mt-1 break-words text-[11px] leading-5 text-muted">{check.evidence}</p>}</div></li>)}</ul> : <p className="text-xs text-muted">报告中没有逐项检查记录。</p>}{report.limitations?.length ? <div><h4 className="text-xs font-medium text-slate-300">验收限制</h4><ul className="mt-2 space-y-1 text-[11px] leading-5 text-muted">{report.limitations.map((item, index) => <li key={index}>· {item}</li>)}</ul></div> : null}</div>;
}

function DeliveryDetail({ id }: { id: string }) {
  const task = useQuery({ queryKey: ['autopilot-task', id], queryFn: () => api.autopilotTask(id), refetchInterval: 5000 });
  const artifacts = useQuery({ queryKey: ['autopilot-artifacts', id], queryFn: () => api.autopilotArtifacts(id), refetchInterval: 5000 });
  const [downloading, setDownloading] = useState(false);
  const [downloadMessage, setDownloadMessage] = useState('');
  const documents = useQuery({
    queryKey: ['autopilot-documents', id, artifacts.data?.map(item => item.name).join('|')],
    queryFn: async (): Promise<TextDocument[]> => {
      const selected = (artifacts.data ?? []).filter(item => isTextArtifact(item.name) && item.size <= 1_000_000).slice(0, 12);
      return Promise.all(selected.map(async item => {
        const response = await fetch(autopilotArtifactUrl(id, item.name), { credentials: 'same-origin' });
        if (!response.ok) return { name: item.name, content: `读取失败：HTTP ${response.status}` };
        return { name: item.name, content: await response.text() };
      }));
    },
    enabled: Boolean(artifacts.data?.length),
  });

  if (task.isLoading) return <div className="flex items-center justify-center gap-2 p-16 text-sm text-muted"><Spinner/>读取交付…</div>;
  if (task.isError) return <ErrorNotice error={task.error} component="读取交付任务" onRetry={() => task.refetch()}/>;
  if (!task.data) return <Empty title="交付不存在" description="检查任务 ID，或返回交付中心。" action={<Link to="/delivery"><Button>返回交付中心</Button></Link>}/>;
  const value = task.data;
  const files = artifacts.data ?? [];
  const totalBytes = files.reduce((total, item) => total + item.size, 0);
  const steps = value.plan?.steps ?? [];
  const completed = steps.filter(step => step.status === 'SUCCEEDED' || step.status === 'SKIPPED');
  const incomplete = steps.filter(step => !['SUCCEEDED', 'SKIPPED'].includes(step.status));
  const docs = documents.data ?? [];
  const acceptanceDoc = docs.find(item => /accept/i.test(item.name));
  const tutorialDoc = docs.find(item => /tutorial|guide|教程/i.test(item.name)) ?? docs.find(item => /readme|START-HERE/i.test(item.name));
  const deploymentDoc = docs.find(item => /deploy/i.test(item.name));
  const manifestDoc = docs.find(item => /manifest/i.test(item.name)) ?? docs.find(item => /sha256/i.test(item.name));
  let acceptance: AcceptanceReport | undefined;
  if (acceptanceDoc) { try { acceptance = JSON.parse(acceptanceDoc.content) as AcceptanceReport; } catch { acceptance = undefined; } }
  let manifest: { summary?: string; originalGoal?: string; completed?: string[]; incomplete?: string[]; acceptance?: AcceptanceReport } | undefined;
  if (manifestDoc) { try { manifest = JSON.parse(manifestDoc.content) as typeof manifest; } catch { manifest = undefined; } }
  acceptance ??= manifest?.acceptance;

  async function downloadAll() {
    setDownloading(true); setDownloadMessage('');
    try {
      for (const item of files) {
        const response = await fetch(autopilotArtifactUrl(id, item.name), { credentials: 'same-origin' });
        if (!response.ok) throw new Error(`${item.name}: HTTP ${response.status}`);
        const url = URL.createObjectURL(await response.blob());
        const anchor = document.createElement('a'); anchor.href = url; anchor.download = item.name; document.body.appendChild(anchor); anchor.click(); anchor.remove();
        URL.revokeObjectURL(url);
      }
      setDownloadMessage(`已触发 ${files.length} 个文件下载。若浏览器拦截多文件下载，请允许此站点继续，或使用逐文件下载。`);
    } catch (error) { setDownloadMessage(error instanceof Error ? error.message : String(error)); }
    finally { setDownloading(false); }
  }

  return <div className="mx-auto max-w-6xl pb-10">
    <Link to="/delivery" className="mb-4 inline-flex items-center gap-2 text-xs text-muted hover:text-accent"><ArrowLeft className="h-3.5 w-3.5"/>交付中心</Link>
    <header className="mb-7 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><Badge tone={taskStatusTone(value.status)}>{statusLabels[value.status] ?? value.status}</Badge><span className="font-mono text-[10px] text-muted">{value.id}</span></div><h1 className="mt-3 text-2xl font-semibold tracking-tight text-white">交付摘要</h1><p className="mt-2 max-w-3xl text-sm leading-6 text-muted">{manifest?.summary ?? manifest?.originalGoal ?? value.prompt}</p></div><div className="flex flex-wrap gap-2"><Link to={`/autopilot/${value.id}`}><Button variant="secondary">查看任务过程</Button></Link><Button disabled={downloading || files.length === 0} onClick={() => void downloadAll()}>{downloading ? <Spinner/> : <Download className="h-3.5 w-3.5"/>}全部下载</Button></div></header>
    {downloadMessage && <div className="mb-4"><Notice tone={downloadMessage.startsWith('已触发') ? 'success' : 'warn'}>{downloadMessage}</Notice></div>}
    {value.error && <div className="mb-4"><Notice tone="warn">{value.error}</Notice></div>}

    <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><Card className="p-4"><div className="flex items-center justify-between text-xs text-muted">交付文件<Package className="h-4 w-4 text-accent"/></div><div className="mt-3 font-mono text-2xl text-white">{files.length}</div></Card><Card className="p-4"><div className="flex items-center justify-between text-xs text-muted">总大小<FolderOpen className="h-4 w-4 text-accent"/></div><div className="mt-3 font-mono text-2xl text-white">{formatBytes(totalBytes)}</div></Card><Card className="p-4"><div className="flex items-center justify-between text-xs text-muted">计划步骤<FileCheck2 className="h-4 w-4 text-accent"/></div><div className="mt-3 font-mono text-2xl text-white">{completed.length}/{steps.length}</div></Card><Card className="p-4"><div className="flex items-center justify-between text-xs text-muted">模型调用<CpuIcon/></div><div className="mt-3 font-mono text-2xl text-white">{value.metrics.modelCalls}</div></Card></div>

    <div className="grid gap-5 xl:grid-cols-[minmax(0,1.5fr)_minmax(300px,.75fr)]">
      <div className="space-y-5">
        <Card className="overflow-hidden"><div className="flex items-center justify-between border-b border-line px-5 py-4"><div className="flex items-center gap-2"><Package className="h-4 w-4 text-accent"/><h2 className="text-sm font-semibold text-white">交付文件</h2></div><span className="font-mono text-[10px] text-muted">SHA-256 校验</span></div>{artifacts.isLoading ? <div className="flex items-center justify-center gap-2 p-10 text-sm text-muted"><Spinner/>读取工件…</div> : artifacts.isError ? <div className="p-4"><ErrorNotice error={artifacts.error} component="读取交付文件" onRetry={() => artifacts.refetch()}/></div> : files.length ? <div className="divide-y divide-line/70">{files.map(file => <div key={file.name} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center"><div className="min-w-0 flex-1"><div className="truncate font-mono text-xs text-slate-200">{file.name}</div><div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted"><span>{formatBytes(file.size)}</span><span className="break-all">sha256: {file.sha256}</span></div></div><a href={autopilotArtifactUrl(id, file.name)} download className="inline-flex min-h-9 shrink-0 items-center justify-center gap-2 rounded-lg border border-line bg-panel2 px-3 text-[11px] text-slate-200 hover:border-accent/40"><Download className="h-3.5 w-3.5"/>下载</a></div>)}</div> : <Empty title="尚无交付文件" description="任务可能尚未生成工件，或执行被阻塞。返回任务查看真实步骤与错误。"/>}</Card>

        <Card className="p-5"><div className="flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-accent"/><h2 className="text-sm font-semibold text-white">独立验收</h2></div><div className="mt-4">{documents.isLoading ? <div className="flex items-center gap-2 text-xs text-muted"><Spinner/>读取验收报告…</div> : <AcceptanceView report={acceptance} task={value}/>}</div></Card>

        <Card className="p-5"><div className="flex items-center gap-2"><FileText className="h-4 w-4 text-accent"/><h2 className="text-sm font-semibold text-white">教程与使用说明</h2></div>{tutorialDoc ? <pre className="mt-4 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-panel2/40 p-4 font-mono text-[11px] leading-6 text-slate-300">{tutorialDoc.content}</pre> : <p className="mt-4 text-xs leading-5 text-muted">交付包中没有 README 或教程文件。不会生成虚构教程。</p>}</Card>
        {deploymentDoc && <Card className="p-5"><div className="flex items-center gap-2"><FolderOpen className="h-4 w-4 text-accent"/><h2 className="text-sm font-semibold text-white">部署说明</h2></div><pre className="mt-4 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-panel2/40 p-4 font-mono text-[11px] leading-6 text-slate-300">{deploymentDoc.content}</pre></Card>}
        {manifestDoc && <Card className="p-5"><div className="flex items-center gap-2"><FileCheck2 className="h-4 w-4 text-accent"/><h2 className="text-sm font-semibold text-white">校验清单</h2></div><pre className="mt-4 max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-line bg-panel2/40 p-4 font-mono text-[10px] leading-5 text-slate-300">{manifestDoc.content}</pre></Card>}
      </div>

      <aside className="space-y-5"><Card className="p-5"><h2 className="text-sm font-semibold text-white">目标与验收口径</h2><p className="mt-3 text-xs leading-6 text-slate-300">{value.contract?.userGoal ?? value.prompt}</p>{value.contract?.acceptanceCriteria?.length ? <ul className="mt-4 space-y-2">{value.contract.acceptanceCriteria.map((item, index) => <li key={index} className="flex gap-2 text-[11px] leading-5 text-muted"><CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent"/>{item}</li>)}</ul> : <p className="mt-3 text-[11px] text-muted">尚未形成目标契约。</p>}</Card><Card className="p-5"><h2 className="text-sm font-semibold text-white">步骤结果</h2><div className="mt-4 space-y-3"><div><div className="mb-2 flex items-center gap-2 text-xs text-emerald-300"><CheckCircle2 className="h-3.5 w-3.5"/>已完成 {completed.length}</div>{completed.length ? <ul className="space-y-1.5 pl-5">{completed.map(step => <li key={step.id} className="text-[11px] leading-5 text-muted">{step.title}</li>)}</ul> : <p className="pl-5 text-[11px] text-muted">无</p>}</div><div><div className="mb-2 flex items-center gap-2 text-xs text-amber-300"><CircleAlert className="h-3.5 w-3.5"/>未完成 {incomplete.length}</div>{incomplete.length ? <ul className="space-y-1.5 pl-5">{incomplete.map(step => <li key={step.id} className="text-[11px] leading-5 text-muted">{step.title} · {step.status}{step.error ? ` · ${step.error}` : ''}</li>)}</ul> : <p className="pl-5 text-[11px] text-muted">无</p>}</div></div></Card><Card className="p-5"><h2 className="text-sm font-semibold text-white">真实指标</h2><dl className="mt-4 space-y-2.5 text-[11px]">{[['Token', value.metrics.tokens.toLocaleString()], ['费用 (USD)', value.metrics.costUsd.toFixed(4)], ['修复尝试', value.metrics.repairAttempts], ['人工介入', value.metrics.interventions], ['峰值内存', `${value.metrics.peakMemoryMB} MB`]].map(([label, item]) => <div key={label} className="flex justify-between gap-3"><dt className="text-muted">{label}</dt><dd className="font-mono text-slate-300">{item}</dd></div>)}</dl></Card><Card className="p-5"><h2 className="text-sm font-semibold text-white">风险与限制</h2>{value.intent.risks.length || value.intent.limitations.length ? <ul className="mt-3 space-y-2 text-[11px] leading-5 text-muted">{[...value.intent.risks, ...value.intent.limitations].map((item, index) => <li key={index}>· {item}</li>)}</ul> : <p className="mt-3 text-[11px] text-muted">未记录额外风险。</p>}<Link to={`/autopilot/${value.id}`} className="mt-4 inline-flex items-center gap-1 text-[11px] text-accent">查看完整任务过程<ArrowRight className="h-3 w-3"/></Link></Card></aside>
    </div>
  </div>;
}

function CpuIcon() { return <Sparkles className="h-4 w-4 text-accent"/>; }

export default function DeliveryCenter() {
  const { id } = useParams();
  return id ? <DeliveryDetail id={id}/> : <DeliveryList/>;
}

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, FileText, FlaskConical, ListChecks, Terminal, Users } from 'lucide-react';
import { api, type PlainReport, type TaskDetail } from '../api';
import { Badge, Button, Card, Empty, ErrorNotice, KindBadge, Notice, PageTitle, Spinner, StatusBadge } from '../components/ui';

function download(name: string, content: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

function reportText(report: PlainReport): string { return typeof report.content === 'string' ? report.content : JSON.stringify(report.content, null, 2); }
const activeStatuses = ['RUNNING', 'QUEUED', 'PAUSED'];

function PlainReportView({ report }: { report: PlainReport }) {
  return <article className="space-y-3 text-sm leading-7 text-slate-300">{reportText(report).split('\n').map((line, index) => {
    if (line.startsWith('# ')) return <h2 key={index} className="pt-2 text-xl font-semibold text-white">{line.slice(2)}</h2>;
    if (line.startsWith('## ')) return <h3 key={index} className="pt-4 text-base font-semibold text-white">{line.slice(3)}</h3>;
    if (line.startsWith('- ')) return <div key={index} className="flex gap-2"><span className="text-accent">·</span><span>{line.slice(2)}</span></div>;
    if (!line.trim()) return <div key={index} className="h-1"/>;
    return <p key={index}>{line}</p>;
  })}</article>;
}

function ProfessionalReport({ detail }: { detail: TaskDetail }) {
  return <div className="space-y-5">
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{[['任务状态', detail.status], ['当前阶段', detail.currentStage], ['当前工具', detail.currentTool ?? '—'], ['输入哈希', `${detail.inputHash.slice(0, 16)}…`]].map(([label, value]) => <div key={label} className="rounded-lg border border-line bg-panel2/50 p-3"><div className="text-[10px] text-muted">{label}</div><div className="mt-1 break-all font-mono text-xs text-slate-200">{value}</div></div>)}</div>
    <section><h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-white"><ListChecks className="h-4 w-4 text-accent"/>阶段轨迹</h3><div className="overflow-x-auto rounded-xl border border-line"><table className="w-full min-w-[640px] text-left text-[11px]"><thead className="border-b border-line bg-panel2/60 text-muted"><tr><th className="px-4 py-3 font-medium">阶段</th><th className="px-4 py-3 font-medium">状态</th><th className="px-4 py-3 font-medium">尝试</th><th className="px-4 py-3 font-medium">错误</th></tr></thead><tbody className="divide-y divide-line/60">{detail.stages.map(stage => <tr key={stage.name}><td className="px-4 py-2.5 font-mono text-slate-300">{stage.name}</td><td className="px-4 py-2.5"><Badge tone={stage.status === 'SUCCEEDED' ? 'success' : stage.status === 'FAILED' ? 'danger' : stage.status === 'RUNNING' ? 'info' : 'neutral'}>{stage.status}</Badge></td><td className="px-4 py-2.5 font-mono text-slate-400">{stage.attempt}</td><td className="max-w-[280px] break-words px-4 py-2.5 text-muted">{stage.error ?? '—'}</td></tr>)}</tbody></table></div></section>
    <section><h3 className="mb-3 text-sm font-semibold text-white">证据 <Badge>{detail.evidence.length}</Badge></h3>{detail.evidence.length ? <div className="space-y-2">{detail.evidence.map(item => <div key={item.id} className="rounded-lg border border-line bg-panel2/40 p-3"><div className="flex flex-wrap items-center gap-2"><KindBadge kind={item.kind}/><span className="text-xs font-medium text-slate-200">{item.title}</span></div><p className="mt-2 break-all font-mono text-[9px] text-muted">{item.source} · {item.locator}</p><pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] leading-5 text-slate-400">{typeof item.content === 'string' ? item.content : JSON.stringify(item.content, null, 2)}</pre></div>)}</div> : <p className="text-xs text-muted">尚无证据记录。</p>}</section>
    <section><h3 className="mb-3 text-sm font-semibold text-white">发现 <Badge>{detail.findings.length}</Badge></h3>{detail.findings.length ? <div className="space-y-2">{detail.findings.map(item => <div key={item.id} className="rounded-lg border border-line bg-panel2/40 p-3"><div className="flex flex-wrap items-center gap-2"><Badge tone={item.severity === 'high' || item.severity === 'critical' ? 'danger' : 'warn'}>{item.severity}</Badge><span className="text-xs font-medium text-slate-200">{item.title}</span><Badge>{item.status}</Badge></div><p className="mt-2 text-[11px] leading-5 text-muted">{item.details}</p><p className="mt-1 text-[11px] leading-5 text-slate-300">建议：{item.recommendation}</p></div>)}</div> : <p className="text-xs text-muted">未记录风险；这不代表目标没有风险。</p>}</section>
    <section><h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-white"><Terminal className="h-4 w-4 text-accent"/>工具日志 <Badge>{detail.logs.length}</Badge></h3><div className="max-h-80 overflow-auto rounded-xl border border-line bg-[#09111a] p-3 font-mono text-[10px] leading-5 text-slate-400">{detail.logs.length ? detail.logs.map(log => <div key={log.id} className="border-b border-line/40 pb-1 last:border-0"><span className="text-slate-600">{new Date(log.createdAt).toLocaleTimeString('zh-CN')}</span> <span className={log.level === 'error' ? 'text-red-300' : log.level === 'warn' ? 'text-amber-300' : 'text-accent'}>{log.level}</span> {log.tool ? `[${log.tool}] ` : ''}{log.message}</div>) : '尚未返回日志。'}</div></section>
    <section><h3 className="mb-3 text-sm font-semibold text-white">产物</h3>{detail.artifacts.length ? <div className="grid gap-2 sm:grid-cols-2">{detail.artifacts.map(artifact => <a key={artifact.name} href={artifact.downloadPath} className="flex items-center justify-between gap-3 rounded-lg border border-line bg-panel2/40 p-3 text-xs text-slate-300 hover:border-accent/40"><span className="break-all font-mono">{artifact.name}</span><Download className="h-3.5 w-3.5 shrink-0 text-accent"/></a>)}</div> : <p className="text-xs text-muted">尚无产物。</p>}</section>
  </div>;
}

export default function Reports() {
  const qc = useQueryClient();
  const tasks = useQuery({ queryKey: ['tasks'], queryFn: api.tasks, refetchInterval: 5000 });
  const [taskId, setTaskId] = useState('');
  useEffect(() => { if (!taskId && tasks.data?.[0]) setTaskId(tasks.data[0].id); }, [taskId, tasks.data]);
  const detail = useQuery({ queryKey: ['task', taskId], queryFn: () => api.task(taskId), enabled: Boolean(taskId), refetchInterval: query => query.state.data && activeStatuses.includes(query.state.data.status) ? 3000 : false });
  const report = useQuery({ queryKey: ['task-report', taskId], queryFn: () => api.taskReportPlain(taskId), enabled: Boolean(taskId), refetchInterval: () => detail.data && activeStatuses.includes(detail.data.status) ? 3000 : false });
  useEffect(() => {
    if (taskId && detail.data) void qc.invalidateQueries({ queryKey: ['task-report', taskId] });
  }, [taskId, detail.dataUpdatedAt, detail.data?.status, qc]);
  const exportMarkdown = useMutation({
    mutationFn: async () => {
      const fresh = await report.refetch({ cancelRefetch: false });
      if (fresh.error) throw fresh.error;
      if (!fresh.data) throw new Error('报告数据不完整');
      download(`report-${taskId.slice(0, 8)}.md`, reportText(fresh.data), 'text/markdown;charset=utf-8');
    },
  });
  const exportJson = useMutation({
    mutationFn: async () => {
      const fresh = await detail.refetch({ cancelRefetch: false });
      if (fresh.error) throw fresh.error;
      if (!fresh.data) throw new Error('任务数据不完整');
      download(`report-${taskId.slice(0, 8)}.json`, JSON.stringify(fresh.data, null, 2), 'application/json;charset=utf-8');
    },
  });
  const exportHtml = useMutation({
    mutationFn: async () => {
      const html = await api.taskReportPlain(taskId, 'html');
      download(`report-${taskId.slice(0, 8)}.html`, reportText(html), 'text/html;charset=utf-8');
    },
  });
  const [view, setView] = useState<'user' | 'professional'>('user');
  const selectedTask = tasks.data?.find(task => task.id === taskId);
  return <>
    <PageTitle eyebrow="Reports" title="分析报告" description="同一份真实任务数据提供通俗与专业双视图。可导出后端生成的 Markdown 或完整结构化证据。" action={<Link to="/demos"><Button variant="secondary"><FlaskConical className="h-4 w-4"/>运行演示生成报告</Button></Link>}/>
    <Card className="mb-5 flex flex-col gap-3 p-4 sm:flex-row sm:items-end"><label className="block sm:w-[420px]"><span className="mb-2 block text-xs font-medium text-slate-300">任务</span><select aria-label="报告任务" className="w-full rounded-lg border border-line bg-panel2 px-3 py-2.5 text-sm text-slate-100 outline-none focus:border-accent/60" value={taskId} onChange={event => { setTaskId(event.target.value); setView('user'); }}><option value="">请选择任务</option>{tasks.data?.map(task => <option key={task.id} value={task.id}>{task.project} · {task.adapter} · {task.id.slice(0, 8)}</option>)}</select></label>{selectedTask && <div className="flex items-center gap-2 pb-1"><StatusBadge status={selectedTask.status}/><Badge tone="info">{selectedTask.currentStage}</Badge></div>}</Card>
    {!taskId ? <Empty title="暂无可报告任务" description="运行一个内置演示，或使用智能分析创建任务后即可查看报告。" action={<Link to="/demos"><Button>前往内置演示</Button></Link>}/> : detail.isLoading || report.isLoading ? <div className="flex items-center justify-center gap-2 p-12 text-sm text-muted"><Spinner/>读取任务与报告…</div> : detail.isError || report.isError || !detail.data || !report.data ? <ErrorNotice error={detail.error ?? report.error ?? new Error('报告数据不完整')} component="报告读取" onRetry={() => { void detail.refetch(); void report.refetch(); }}/> : <>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3"><div className="flex rounded-lg border border-line bg-panel p-1" role="tablist" aria-label="报告视图"><button role="tab" aria-selected={view === 'user'} onClick={() => setView('user')} className={`inline-flex min-h-9 items-center gap-2 rounded-md px-3 text-xs ${view === 'user' ? 'bg-accent/10 text-accent' : 'text-muted hover:text-slate-200'}`}><Users className="h-3.5 w-3.5"/>普通用户视图</button><button role="tab" aria-selected={view === 'professional'} onClick={() => setView('professional')} className={`inline-flex min-h-9 items-center gap-2 rounded-md px-3 text-xs ${view === 'professional' ? 'bg-accent/10 text-accent' : 'text-muted hover:text-slate-200'}`}><FileText className="h-3.5 w-3.5"/>专业视图</button></div><div className="flex flex-wrap gap-2"><Button variant="secondary" disabled={exportMarkdown.isPending} onClick={() => exportMarkdown.mutate()}><Download className="h-3.5 w-3.5"/>{exportMarkdown.isPending ? '正在刷新…' : '导出 Markdown'}</Button><Button variant="secondary" disabled={exportJson.isPending} onClick={() => exportJson.mutate()}><Download className="h-3.5 w-3.5"/>{exportJson.isPending ? '正在刷新…' : '导出完整 JSON'}</Button><Button variant="secondary" disabled={exportHtml.isPending} onClick={() => exportHtml.mutate()}><Download className="h-3.5 w-3.5"/>{exportHtml.isPending ? '正在生成…' : '导出 HTML'}</Button></div>
      {(exportMarkdown.isError || exportJson.isError || exportHtml.isError) && <ErrorNotice error={exportMarkdown.error ?? exportJson.error ?? exportHtml.error} component="报告导出" onRetry={() => { if (exportMarkdown.isError) exportMarkdown.mutate(); else if (exportJson.isError) exportJson.mutate(); else exportHtml.mutate(); }}/>}</div>
      <Notice tone="info">通俗报告由后端根据证据、推断与未知项生成；专业视图直接展示任务阶段、证据内容、发现、日志与产物。两者都不会把推断当作事实。</Notice>
      <Card className="mt-5 p-5 sm:p-6">{view === 'user' ? <PlainReportView report={report.data}/> : <ProfessionalReport detail={detail.data}/>}</Card>
    </>}
  </>;
}

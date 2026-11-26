import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Activity, ArrowUpRight, Boxes, Terminal } from 'lucide-react';
import { api } from '../api';
import { useTask } from '../hooks';
import { Badge, Button, Card, ErrorNotice, KindBadge, ProgressBar, Spinner, StatusBadge } from './ui';

const logPageSize = 30;

export default function TaskLivePanel({ taskId, title = '真实任务进度' }: { taskId: string; title?: string }) {
  const task = useTask(taskId);
  const resources = useQuery({ queryKey: ['resources'], queryFn: api.resources, refetchInterval: 5000 });
  const [logLimit, setLogLimit] = useState(logPageSize);
  const detail = task.data;

  return <Card className="overflow-hidden">
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
      <div><h2 className="flex items-center gap-2 text-sm font-semibold text-white"><Activity className="h-4 w-4 text-accent"/>{title}</h2><p className="mt-1 text-xs text-muted">阶段、工具、日志、证据与资源均读取自本机 API。</p></div>
      <Link to={`/tasks/${taskId}`} className="inline-flex items-center gap-1 text-xs text-accent">完整任务<ArrowUpRight className="h-3.5 w-3.5"/></Link>
    </div>
    {task.isLoading ? <div className="flex items-center justify-center gap-2 p-8 text-sm text-muted"><Spinner/>读取任务状态…</div> : task.isError || !detail ? <div className="p-4"><ErrorNotice error={task.error ?? new Error('任务不存在')} component="任务进度" onRetry={() => void task.refetch()}/></div> : <div className="space-y-5 p-5">
      <div className="flex flex-wrap items-center gap-2"><StatusBadge status={detail.status}/><Badge tone="info">{detail.currentStage}</Badge><Badge>工具：{detail.currentTool ?? '尚未调用'}</Badge><span className="font-mono text-[10px] text-muted">{detail.id}</span></div>
      <div><div className="mb-2 flex items-center justify-between text-xs text-muted"><span>Worker 报告进度</span><span className="font-mono text-slate-300">{detail.progress}%</span></div><ProgressBar value={detail.progress} label={`${detail.id} 真实进度`}/></div>
      {detail.error && <ErrorNotice error={detail.error} component="任务执行" retryable={detail.status === 'FAILED'} limitations={['失败阶段可由任务工作台重试；工具依赖不可用时不会生成替代结果。']}/>}
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-xl border border-line bg-panel2/40 p-4"><h3 className="flex items-center gap-2 text-xs font-medium text-slate-200"><Terminal className="h-3.5 w-3.5 text-accent"/>最近日志</h3>{detail.logs.length ? <ol className="mt-3 max-h-64 space-y-2 overflow-auto pr-1">{detail.logs.slice(0, logLimit).map(log => <li key={log.id} className="border-b border-line/50 pb-2 text-[11px] leading-5 last:border-0"><div className="flex flex-wrap items-center gap-2 font-mono text-[10px] text-muted"><span>{new Date(log.createdAt).toLocaleTimeString('zh-CN')}</span><span className={log.level === 'error' ? 'text-red-300' : log.level === 'warn' ? 'text-amber-300' : 'text-accent'}>{log.level}</span>{log.tool && <span>{log.tool}</span>}</div><p className="mt-1 break-words text-slate-300">{log.message}</p></li>)}</ol> : <p className="mt-3 text-xs text-muted">尚未返回日志。</p>}{detail.logs.length > logLimit && <Button variant="ghost" className="mt-2" onClick={() => setLogLimit(value => value + logPageSize)}>显示更多日志（剩余 {detail.logs.length - logLimit}）</Button>}</section>
        <section className="rounded-xl border border-line bg-panel2/40 p-4"><h3 className="flex items-center gap-2 text-xs font-medium text-slate-200"><Boxes className="h-3.5 w-3.5 text-accent"/>证据记录 <Badge>{detail.evidence.length}</Badge></h3>{detail.evidence.length ? <ul className="mt-3 max-h-64 space-y-2 overflow-auto pr-1">{detail.evidence.slice(0, 20).map(item => <li key={item.id} className="rounded-lg border border-line/60 bg-panel/60 p-2.5"><div className="flex flex-wrap items-center gap-2"><KindBadge kind={item.kind}/><span className="text-[11px] font-medium text-slate-200">{item.title}</span></div><p className="mt-1 break-all font-mono text-[9px] text-muted">{item.source} · {item.locator}</p></li>)}</ul> : <p className="mt-3 text-xs text-muted">尚未返回证据。</p>}</section>
      </div>
      <section className="rounded-xl border border-line bg-panel2/40 p-4"><h3 className="text-xs font-medium text-slate-200">资源快照</h3>{resources.isLoading ? <div className="mt-2 flex items-center gap-2 text-xs text-muted"><Spinner/>读取资源…</div> : resources.isError ? <p className="mt-2 text-xs text-amber-300">资源快照不可用：{resources.error instanceof Error ? resources.error.message : String(resources.error)}</p> : <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{[['API RSS', resources.data?.api ? `${resources.data.api.selfRssMB.toFixed(1)} MB` : '—'], ['Worker RSS', resources.data?.worker ? `${resources.data.worker.selfRssMB.toFixed(1)} MB` : '未返回'], ['运行 / 排队', resources.data?.api ? `${resources.data.api.runningTasks} / ${resources.data.api.queuedTasks}` : '—'], ['API 压力', resources.data?.api?.pressure ?? '—']].map(([label, value]) => <div key={label} className="rounded-lg border border-line/60 bg-panel/60 p-3"><div className="text-[10px] text-muted">{label}</div><div className="mt-1 font-mono text-xs text-slate-200">{value}</div></div>)}</div>}</section>
    </div>}
  </Card>;
}

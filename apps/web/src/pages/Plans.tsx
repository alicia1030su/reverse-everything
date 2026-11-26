import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, Clock3, Coins, Play, RefreshCw, ShieldCheck } from 'lucide-react';
import { api } from '../api';
import { Badge, Button, Card, Empty, ErrorNotice, KindBadge, Notice, PageTitle, Spinner, StatusBadge } from '../components/ui';
import TaskLivePanel from '../components/TaskLivePanel';

const modeLabels: Record<string, string> = { beginner: '小白模式', professional: '专业模式', agent: 'AI Agent' };
const stepLabels: Record<string, string> = { 'target-identification': '目标识别', 'environment-detection': '环境检测', 'authorization-check': '授权检查', 'capability-match': '能力匹配', planning: '计划', execution: '执行', 'evidence-summary': '证据汇总', 'conclusion-validation': '结论验证', report: '报告' };
const stepTone: Record<string, 'neutral' | 'success' | 'warn' | 'danger' | 'info'> = { PENDING: 'neutral', READY: 'info', BLOCKED: 'danger', RUNNING: 'info', SUCCEEDED: 'success', FAILED: 'danger', SKIPPED: 'warn' };

function bytes(value: number): string { return value >= 1_073_741_824 ? `${(value / 1_073_741_824).toFixed(1)} GB` : `${Math.round(value / 1_048_576)} MB`; }

function PlanList() {
  const qc = useQueryClient();
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const [projectId, setProjectId] = useState('');
  useEffect(() => { if (!projectId && projects.data?.[0]) setProjectId(projects.data[0].id); }, [projectId, projects.data]);
  const plans = useQuery({ queryKey: ['plans', projectId], queryFn: () => api.plans(projectId), enabled: Boolean(projectId), refetchInterval: 5000 });
  const refresh = () => { void plans.refetch(); void qc.invalidateQueries({ queryKey: ['plans', projectId] }); };
  return <>
    <PageTitle title="分析计划" description="查看确定性步骤、授权范围与资源预算。计划状态来自后端，不在前端模拟执行进度。" action={<Link to="/wizard"><Button><Play className="h-4 w-4"/>新建计划</Button></Link>}/>
    <Card className="mb-5 flex flex-col gap-3 p-4 sm:flex-row sm:items-end"><FieldLabel label="项目"><select aria-label="计划项目" className="w-full rounded-lg border border-line bg-panel2 px-3 py-2.5 text-sm text-slate-100 outline-none focus:border-accent/60 sm:w-80" value={projectId} onChange={event => setProjectId(event.target.value)}><option value="">请选择项目</option>{projects.data?.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></FieldLabel><Button variant="secondary" onClick={refresh} disabled={plans.isFetching}><RefreshCw className="h-4 w-4"/>刷新</Button></Card>
    {!projectId ? <Empty title="先选择一个项目" description="计划按项目保存。选择项目后查看历史计划。"/> : <Card>{plans.isLoading ? <div className="flex items-center justify-center gap-2 p-10 text-sm text-muted"><Spinner/>读取计划…</div> : plans.isError ? <div className="p-4"><ErrorNotice error={plans.error} component="计划列表" onRetry={refresh}/></div> : plans.data?.items.length ? <div className="divide-y divide-line/70">{plans.data.items.map(plan => <Link key={plan.id} to={`/plans/${plan.id}`} className="flex flex-col gap-3 px-5 py-4 transition hover:bg-white/[.025] sm:flex-row sm:items-center"><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><span className="font-mono text-xs text-slate-200">{plan.id.slice(0, 12)}</span><StatusBadge status={plan.status}/><Badge>{modeLabels[plan.mode] ?? plan.mode}</Badge><KindBadge kind={plan.target.level}/></div><div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-muted"><span>目标：{plan.target.kind} · {plan.target.size} bytes</span><span>步骤：{plan.steps.length}</span><span>创建：{new Date(plan.createdAt).toLocaleString('zh-CN')}</span></div></div><ArrowRight className="hidden h-4 w-4 text-muted sm:block"/></Link>)}</div> : <Empty title="暂无分析计划" description="使用智能分析向导创建第一个带授权与预算的计划。" action={<Link to="/wizard"><Button>开始智能分析</Button></Link>}/>}</Card>}
  </>;
}

function FieldLabel({ label, children }: { label: string; children: React.ReactNode }) { return <label className="block"><span className="mb-2 block text-xs font-medium text-slate-300">{label}</span>{children}</label>; }

function PlanDetail({ id }: { id: string }) {
  const qc = useQueryClient();
  const plan = useQuery({ queryKey: ['plan', id], queryFn: () => api.plan(id), refetchInterval: query => query.state.data?.plan.status === 'RUNNING' ? 3000 : false });
  const execute = useMutation({ mutationFn: () => api.executePlan(id), onSuccess: () => { void qc.invalidateQueries({ queryKey: ['plan', id] }); void qc.invalidateQueries({ queryKey: ['plans'] }); } });
  const value = plan.data?.plan;
  if (plan.isLoading) return <div className="flex items-center justify-center gap-2 p-10 text-sm text-muted"><Spinner/>读取计划…</div>;
  if (plan.isError || !value) return <><Link to="/plans" className="mb-4 inline-flex items-center gap-1 text-xs text-accent"><ArrowLeft className="h-3.5 w-3.5"/>返回计划列表</Link><ErrorNotice error={plan.error ?? new Error('计划不存在')} component="计划详情" onRetry={() => void plan.refetch()}/></>;
  const blocked = value.steps.some(step => step.status === 'BLOCKED');
  return <>
    <Link to="/plans" className="mb-4 inline-flex items-center gap-1 text-xs text-accent"><ArrowLeft className="h-3.5 w-3.5"/>返回计划列表</Link>
    <PageTitle eyebrow="Deterministic plan" title="计划详情" description="步骤、授权与预算均来自持久化计划。执行只创建真实 Worker 任务，不生成模拟进度。" action={<div className="flex flex-wrap gap-2">{value.status === 'CREATED' && <Button disabled={blocked || execute.isPending} onClick={() => execute.mutate()}>{execute.isPending ? <Spinner/> : <Play className="h-4 w-4"/>}{blocked ? '执行被阻塞' : '执行计划'}</Button>}{value.taskId && <Link to={`/tasks/${value.taskId}`}><Button variant="secondary">打开任务</Button></Link>}</div>}/>
    <div className="mb-5 flex flex-wrap items-center gap-2"><StatusBadge status={value.status}/><Badge tone="info">{modeLabels[value.mode] ?? value.mode}</Badge><Badge>{value.target.kind}</Badge><KindBadge kind={value.target.level}/><span className="font-mono text-[10px] text-muted">{value.id}</span></div>
    {blocked && <Notice tone="warn">计划包含阻塞步骤。通常原因是授权范围或分析器依赖不足；不会执行被阻塞的计划。</Notice>}{execute.isError && <div className="mb-5"><ErrorNotice error={execute.error} component="执行计划" onRetry={() => execute.mutate()} retryable={value.status === 'CREATED'}/></div>}
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1.5fr)_minmax(300px,.75fr)]">
      <Card><div className="border-b border-line px-5 py-4"><h2 className="text-sm font-semibold text-white">执行步骤</h2><p className="mt-1 text-xs text-muted">{value.steps.length} 个确定性步骤 · 状态由后端更新</p></div><ol className="divide-y divide-line/60">{value.steps.map((step, index) => <li key={step.id} className="px-5 py-4"><div className="flex flex-wrap items-start gap-3"><span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-line bg-panel2 font-mono text-[11px] text-muted">{index + 1}</span><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h3 className="text-xs font-medium text-slate-200">{step.title}</h3><Badge tone={stepTone[step.status] ?? 'neutral'}>{step.status}</Badge>{step.critical && <Badge tone="warn">关键</Badge>}{step.analyzer && <Badge tone="info">{step.analyzer}</Badge>}</div><p className="mt-1 text-[10px] text-muted">{stepLabels[step.kind] ?? step.kind} · 授权：{step.authorization.join(', ') || '无'}</p>{step.reason && <p className="mt-2 text-[11px] leading-5 text-amber-300">{step.reason}</p>}{step.dependsOn.length > 0 && <p className="mt-1 font-mono text-[9px] text-slate-600">depends on {step.dependsOn.join(', ')}</p>}</div></div></li>)}</ol></Card>
      <div className="space-y-5"><Card className="p-5"><h2 className="flex items-center gap-2 text-sm font-semibold text-white"><ShieldCheck className="h-4 w-4 text-accent"/>授权与目标</h2><dl className="mt-4 space-y-3 text-[11px]"><div><dt className="text-muted">授权记录</dt><dd className="mt-1 break-all font-mono text-slate-300">{value.authorizationId ?? '内联授权'}</dd></div><div><dt className="text-muted">目标大小</dt><dd className="mt-1 font-mono text-slate-300">{value.target.size} bytes</dd></div><div><dt className="text-muted">识别置信度</dt><dd className="mt-1 font-mono text-slate-300">{Math.round(value.target.confidence * 100)}%</dd></div><div><dt className="text-muted">扩展名</dt><dd className="mt-1 font-mono text-slate-300">{value.target.extension ?? '—'}</dd></div></dl>{value.target.signals.length > 0 && <div className="mt-4 border-t border-line pt-4"><h3 className="text-xs font-medium text-slate-300">识别信号</h3><ul className="mt-2 space-y-2">{value.target.signals.map((signal, index) => <li key={`${signal.source}-${index}`} className="text-[10px] leading-5 text-muted"><KindBadge kind={signal.level}/> {signal.detail}</li>)}</ul></div>}</Card><Card className="p-5"><h2 className="flex items-center gap-2 text-sm font-semibold text-white"><Coins className="h-4 w-4 text-accent"/>资源预算</h2><div className="mt-4 grid grid-cols-2 gap-3 text-[11px]">{[['超时', `${value.budget.timeoutMs / 1000}s`], ['工具调用', value.budget.maxToolCalls], ['模型迭代', value.budget.maxModelIterations], ['Tokens', value.budget.maxTokens], ['费用上限', `$${value.budget.maxCostUsd}`], ['内存', bytes(value.budget.maxMemoryBytes)], ['磁盘', bytes(value.budget.maxDiskBytes)], ['无进展上限', value.budget.maxNoProgressSteps]].map(([label, item]) => <div key={label} className="rounded-lg border border-line bg-panel2/50 p-3"><div className="text-muted">{label}</div><div className="mt-1 font-mono text-slate-200">{item}</div></div>)}</div></Card><Card className="p-5"><h2 className="flex items-center gap-2 text-sm font-semibold text-white"><Clock3 className="h-4 w-4 text-accent"/>时间</h2><dl className="mt-4 space-y-2 text-[11px]"><div className="flex justify-between"><dt className="text-muted">创建</dt><dd className="text-slate-300">{new Date(value.createdAt).toLocaleString('zh-CN')}</dd></div><div className="flex justify-between"><dt className="text-muted">更新</dt><dd className="text-slate-300">{new Date(value.updatedAt).toLocaleString('zh-CN')}</dd></div></dl></Card></div>
    </div>
    {value.taskId && <div className="mt-5"><TaskLivePanel taskId={value.taskId} title="计划关联任务"/></div>}
  </>;
}

export default function Plans() {
  const { id } = useParams();
  return id ? <PlanDetail id={id}/> : <PlanList/>;
}

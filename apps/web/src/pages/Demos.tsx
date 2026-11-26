import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpRight, Boxes, Cpu, Gamepad2, Globe2, Play, Rocket, ShieldCheck, Usb } from 'lucide-react';
import { api, type DemoItem, type DemoRunResponse } from '../api';
import { Badge, Button, Card, Empty, ErrorNotice, Notice, PageTitle, Spinner } from '../components/ui';
import TaskLivePanel from '../components/TaskLivePanel';

const icons: Record<string, typeof Globe2> = { website: Globe2, game: Gamepad2, apk: Boxes, firmware: Cpu, hardware: Usb, network: Globe2, security: ShieldCheck };

export default function Demos() {
  const qc = useQueryClient();
  const demos = useQuery({ queryKey: ['demos'], queryFn: api.demos });
  const [activeRun, setActiveRun] = useState<DemoRunResponse>();
  const run = useMutation({
    mutationFn: (name: string) => api.runDemo(name),
    onSuccess: result => { setActiveRun(result); void qc.invalidateQueries({ queryKey: ['projects'] }); void qc.invalidateQueries({ queryKey: ['tasks'] }); },
  });
  const activeDemo = demos.data?.items.find(item => item.name === activeRun?.demo);
  return <>
    <PageTitle eyebrow="Built-in demos" title="内置演示" description="使用项目自带的确定性样本一键创建真实任务。演示不会访问你的个人文件，也不会伪造截图或进度。" action={<Link to="/wizard"><Button variant="secondary"><Rocket className="h-4 w-4"/>分析自己的文件</Button></Link>}/>
    <Notice tone="info">演示样本由项目生成或随仓库提供。点击运行后会创建本地项目与 Worker 任务，并显示真实阶段、日志和证据。</Notice>
    {demos.isLoading ? <div className="mt-5 flex items-center justify-center gap-2 p-12 text-sm text-muted"><Spinner/>读取演示目录…</div> : demos.isError ? <div className="mt-5"><ErrorNotice error={demos.error} component="演示目录" onRetry={() => void demos.refetch()}/></div> : demos.data?.items.length ? <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3">{demos.data.items.map((demo: DemoItem) => { const Icon = icons[demo.adapter] ?? Boxes; const pending = run.isPending && run.variables === demo.name; return <Card key={demo.name} className="flex flex-col p-5"><div className="flex items-start justify-between gap-3"><div className="grid h-10 w-10 place-items-center rounded-xl border border-accent/30 bg-accent/10 text-accent"><Icon className="h-5 w-5"/></div><Badge tone="info">{demo.adapter}</Badge></div><h2 className="mt-4 text-sm font-semibold text-white">{demo.title}</h2><p className="mt-2 flex-1 text-xs leading-5 text-muted">{demo.description}</p><div className="mt-4 flex items-center justify-between border-t border-line pt-3 text-[10px] text-muted"><span>{demo.kind}</span><span>{demo.target ?? 'built-in fixture'}</span></div><Button className="mt-4 w-full" disabled={run.isPending} onClick={() => run.mutate(demo.name)}>{pending ? <Spinner/> : <Play className="h-4 w-4"/>}{pending ? '正在创建任务…' : '一键运行'}</Button></Card>; })}</div> : <Empty title="暂无内置演示" description="后端没有返回演示目录。"/>}
    {run.isError && <div className="mt-5"><ErrorNotice error={run.error} component="运行演示" onRetry={() => activeRun ? run.mutate(activeRun.demo) : undefined}/></div>}
    {activeRun && <div className="mt-5 space-y-5"><Card className="p-5"><div className="flex flex-wrap items-center justify-between gap-3"><div><Badge tone="success">演示任务已创建</Badge><h2 className="mt-3 text-sm font-semibold text-white">{activeDemo?.title ?? activeRun.demo}</h2><p className="mt-1 font-mono text-[10px] text-muted">run {activeRun.runId} · project {activeRun.projectId}</p></div><Link to={`/projects/${activeRun.projectId}`} className="inline-flex items-center gap-1 text-xs text-accent">查看项目<ArrowUpRight className="h-3.5 w-3.5"/></Link></div></Card><TaskLivePanel taskId={activeRun.taskId} title={`${activeDemo?.title ?? '演示'} · 真实进度`}/></div>}
  </>;
}

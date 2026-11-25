import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Activity, ArrowUpRight, CheckCircle2, Cpu, FileSearch, FolderKanban, Globe2,
  ShieldAlert, Smartphone, TerminalSquare, Usb,
} from 'lucide-react';
import { api } from '../api';
import { Badge, Button, Card, Empty, PageTitle, StatusBadge } from '../components/ui';
import type { AdapterName, ProjectKind, Stats } from '@reverse/contracts';

const adapterLabels: Record<AdapterName, string> = {
  website: '网页逆向', file: '软件分析', game: '游戏复活', security: '安全分析',
  network: '网络协议', apk: 'Android APK', ghidra: 'Ghidra', hardware: 'USB 硬件', firmware: '固件',
};
const projectLabels: Record<ProjectKind, string> = {
  website: '网页项目', software: '软件项目', game: '游戏项目', security: '安全项目',
  protocol: '协议项目', hardware: '硬件项目', firmware: '固件项目',
};

function AdapterIcon({ name }: { name: string }) {
  if (name === 'website') return <Globe2 className="h-3.5 w-3.5"/>;
  if (name === 'apk') return <Smartphone className="h-3.5 w-3.5"/>;
  if (name === 'hardware') return <Usb className="h-3.5 w-3.5"/>;
  if (name === 'firmware') return <Cpu className="h-3.5 w-3.5"/>;
  return <FileSearch className="h-3.5 w-3.5"/>;
}

export default function Dashboard() {
  const stats = useQuery({ queryKey: ['stats'], queryFn: api.stats, refetchInterval: 3000 });
  const tasks = useQuery({ queryKey: ['tasks'], queryFn: api.tasks, refetchInterval: 2500 });
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const summary: Stats | undefined = stats.data;
  const cards = [
    { label: '项目', value: summary?.projects ?? 0, icon: FolderKanban, sub: '本地持久化项目' },
    { label: '分析任务', value: summary?.tasks ?? 0, icon: Activity, sub: `${summary?.running ?? 0} 个正在运行` },
    { label: '证据记录', value: summary?.evidence ?? 0, icon: FileSearch, sub: '可定位、可哈希' },
    { label: '安全发现', value: summary?.findings ?? 0, icon: ShieldAlert, sub: `${summary?.highFindings ?? 0} 个高风险候选` },
  ];

  return <>
    <PageTitle eyebrow="Local analysis workspace" title="分析总览" description="所有数字来自本地 API 与持久化任务，不使用模拟进度或预置统计。" action={<Link to="/new" className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-ink hover:brightness-110"><TerminalSquare className="h-4 w-4"/>创建逆向任务</Link>}/>
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{cards.map(({ label, value, icon: Icon, sub }) => <Card key={label} className="p-5"><div className="flex items-start justify-between"><span className="text-xs font-medium text-muted">{label}</span><Icon className="h-4 w-4 text-accent/70"/></div><div className="mt-4 font-mono text-3xl font-semibold tracking-tight text-white">{stats.isLoading ? '—' : value}</div><div className="mt-2 text-[11px] text-muted">{sub}</div></Card>)}</div>
    <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1.7fr)_minmax(280px,1fr)]">
      <Card>
        <div className="flex items-center justify-between border-b border-line px-5 py-4"><div><h2 className="text-sm font-semibold text-white">最近任务</h2><p className="mt-1 text-xs text-muted">阶段、状态与证据由 Worker 实时写入</p></div><Link to="/tasks" className="text-xs text-accent">查看全部</Link></div>
        {tasks.isLoading ? <div className="p-8 text-center text-sm text-muted">读取本地任务…</div> : tasks.data?.length ? <div className="divide-y divide-line/70">{(tasks.data ?? []).slice(0, 7).map(task => <Link to={`/tasks/${task.id}`} key={task.id} className="flex items-center gap-3 px-5 py-3.5 transition hover:bg-white/[.025] sm:gap-4"><span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-line bg-panel2 text-muted"><AdapterIcon name={task.adapter}/></span><div className="min-w-0 flex-1"><div className="truncate text-xs font-medium text-slate-200">{adapterLabels[task.adapter] ?? task.adapter} · {task.id.slice(0, 8)}</div><div className="mt-1 font-mono text-[10px] text-muted">{task.currentStage} · {task.progress}%</div></div><StatusBadge status={task.status}/><ArrowUpRight className="hidden h-3.5 w-3.5 shrink-0 text-slate-600 sm:block"/></Link>)}</div> : <Empty title="还没有分析任务" description="从网页、软件文件、安全目标、USB 记录或合法游戏回放开始。所有分析都会保留输入哈希和阶段检查点。" action={<Link to="/new"><Button>创建第一个项目</Button></Link>}/>}
      </Card>
      <div className="space-y-5">
        <Card className="p-5"><div className="flex items-center justify-between"><h2 className="text-sm font-semibold text-white">分析器状态</h2><Badge tone="success">LOCAL</Badge></div><div className="mt-4 space-y-3">{(summary?.adapters ?? []).map(adapter => <div key={adapter.name} className="flex items-center justify-between gap-3 border-b border-line/60 pb-3 last:border-0 last:pb-0"><div className="min-w-0"><div className="text-xs text-slate-200">{adapterLabels[adapter.name as AdapterName] ?? adapter.name}</div><div className="mt-1 max-w-[210px] truncate text-[10px] text-muted" title={adapter.detail}>{adapter.detail}</div></div><Badge tone={adapter.available ? 'success' : 'danger'}>{adapter.available ? '可用' : '缺依赖'}</Badge></div>)}</div></Card>
        <Card className="p-5"><div className="flex items-center justify-between"><h2 className="text-sm font-semibold text-white">项目</h2><Link to="/projects" className="text-xs text-accent">全部</Link></div><div className="mt-3 space-y-2">{projects.data?.slice(0, 4).map(project => <Link key={project.id} to={`/projects/${project.id}`} className="flex items-center justify-between gap-2 rounded-lg px-2 py-2 text-xs hover:bg-white/5"><span className="truncate text-slate-300">{project.name}</span><Badge>{projectLabels[project.kind]}</Badge></Link>)}{!projects.data?.length && <p className="py-4 text-xs leading-5 text-muted">暂无项目。创建后会显示在这里。</p>}</div><div className="mt-4 flex items-center gap-2 border-t border-line pt-4 text-[11px] text-muted"><CheckCircle2 className="h-3.5 w-3.5 text-accent"/>任务重启后从检查点恢复</div></Card>
      </div>
    </div>
  </>;
}

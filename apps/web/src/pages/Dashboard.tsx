import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Activity, ArrowRight, ArrowUpRight, Binary, CheckCircle2, Cpu, FileSearch, FlaskConical, FolderKanban, Gamepad2, Globe2, History, Play, ShieldAlert, Sparkles } from 'lucide-react';
import { api } from '../api';
import { Badge, Button, Card, Empty, PageTitle, StatusBadge } from '../components/ui';
import AiDataBoundary from '../components/AiDataBoundary';
import type { AdapterName, ProjectKind, Stats } from '@reverse/contracts';

const adapterLabels: Record<AdapterName, string> = {
  website: '网页分析', file: '软件分析', game: '游戏复活', security: '安全分析',
  network: '网络协议', apk: 'Android APK', ghidra: 'Ghidra', hardware: 'USB 硬件', firmware: '固件', console: '主机研究',
};
const projectLabels: Record<ProjectKind, string> = {
  website: '网页项目', software: '软件项目', game: '游戏项目', security: '安全项目',
  protocol: '协议项目', hardware: '硬件项目', firmware: '固件项目', console: '主机研究项目',
};
const quickActions = [
  { to: '/console-lab', title: '分析游戏主机', description: '整理公开资料、只读信息与研究证据', icon: Gamepad2 },
  { to: '/wizard?category=software', title: '分析软件', description: '识别文件格式、字符串与静态信息', icon: Binary },
  { to: '/wizard?category=firmware', title: '分析固件', description: '查看镜像身份、布局与字符串', icon: Cpu },
  { to: '/wizard?category=website', title: '分析网页', description: '采集页面结构、资源与网络元数据', icon: Globe2 },
  { to: '/wizard?category=game', title: '复活游戏', description: '从合法回放研究协议与兼容服务', icon: FlaskConical },
  { to: '/tasks', title: '历史任务', description: '继续查看阶段、日志、证据与报告', icon: History },
];

export default function Dashboard() {
  const stats = useQuery({ queryKey: ['stats'], queryFn: api.stats, refetchInterval: 3000 });
  const tasks = useQuery({ queryKey: ['tasks'], queryFn: api.tasks, refetchInterval: 2500 });
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const summary: Stats | undefined = stats.data;
  const cards = [
    { label: '项目', value: summary?.projects ?? 0, icon: FolderKanban, sub: '保存在本机' },
    { label: '分析任务', value: summary?.tasks ?? 0, icon: Activity, sub: `${summary?.running ?? 0} 个正在运行` },
    { label: '证据记录', value: summary?.evidence ?? 0, icon: FileSearch, sub: '可定位、可核对' },
    { label: '风险线索', value: summary?.findings ?? 0, icon: ShieldAlert, sub: `${summary?.highFindings ?? 0} 个需要优先复核` },
  ];

  return <>
    <PageTitle eyebrow="Your local analysis workspace" title="今天想分析什么？" description="从网页、软件、固件到游戏主机，用同一套授权、证据与报告流程把事情讲清楚。" action={<Link to="/demos"><Button variant="secondary"><Play className="h-4 w-4"/>先看内置演示</Button></Link>}/>
    <Card className="relative overflow-hidden p-6 sm:p-8">
      <div className="absolute -right-16 -top-24 h-64 w-64 rounded-full bg-accent/10 blur-3xl"/>
      <div className="relative grid gap-7 lg:grid-cols-[minmax(0,1.4fr)_minmax(280px,.6fr)] lg:items-center">
        <div><AiDataBoundary/><h2 className="mt-4 max-w-2xl text-2xl font-semibold leading-tight tracking-tight text-white sm:text-3xl">把感兴趣的东西，分析清楚。</h2><p className="mt-3 max-w-2xl text-sm leading-6 text-muted">告诉我们你想看什么，向导会先确认授权，再给出可执行计划。每一步都能查看真实工具、日志与证据。</p><div className="mt-6 flex flex-wrap gap-3"><Link to="/wizard"><Button><Sparkles className="h-4 w-4"/>开始智能分析<ArrowRight className="h-4 w-4"/></Button></Link><Link to="/console-lab"><Button variant="secondary"><Gamepad2 className="h-4 w-4"/>分析游戏主机</Button></Link></div></div>
        <div className="rounded-xl border border-line bg-panel2/50 p-4"><h3 className="text-xs font-medium text-slate-300">一次分析会发生什么</h3><ol className="mt-3 space-y-3 text-[11px] leading-5 text-muted">{['确认目标与授权范围', '识别输入并匹配可用工具', '执行真实阶段并保留证据', '生成通俗报告与专业详情'].map((item, index) => <li key={item} className="flex items-start gap-2"><span className="grid h-5 w-5 shrink-0 place-items-center rounded-md border border-accent/30 bg-accent/10 font-mono text-[9px] text-accent">{index + 1}</span>{item}</li>)}</ol></div>
      </div>
    </Card>
    <div className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{cards.map(({ label, value, icon: Icon, sub }) => <Card key={label} className="p-5"><div className="flex items-start justify-between"><span className="text-xs font-medium text-muted">{label}</span><Icon className="h-4 w-4 text-accent/70"/></div><div className="mt-4 font-mono text-3xl font-semibold tracking-tight text-white">{stats.isLoading ? '—' : value}</div><div className="mt-2 text-[11px] text-muted">{sub}</div></Card>)}</div>
    <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{quickActions.map(({ to, title, description, icon: Icon }) => <Link key={to} to={to} className="group flex items-center gap-4 rounded-xl border border-line bg-panel p-4 transition hover:border-accent/40 hover:bg-accent/[.03]"><div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-line bg-panel2 text-accent"><Icon className="h-5 w-5"/></div><div className="min-w-0 flex-1"><h2 className="text-sm font-medium text-slate-200">{title}</h2><p className="mt-1 text-[11px] leading-5 text-muted">{description}</p></div><ArrowUpRight className="h-4 w-4 shrink-0 text-slate-600 transition group-hover:text-accent"/></Link>)}</div>
    <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1.7fr)_minmax(280px,1fr)]">
      <Card><div className="flex items-center justify-between border-b border-line px-5 py-4"><div><h2 className="text-sm font-semibold text-white">最近任务</h2><p className="mt-1 text-xs text-muted">继续查看真实阶段、工具与证据</p></div><Link to="/tasks" className="text-xs text-accent">查看全部</Link></div>{tasks.isLoading ? <div className="p-8 text-center text-sm text-muted">读取任务…</div> : tasks.data?.length ? <div className="divide-y divide-line/70">{tasks.data.slice(0, 7).map(task => <Link to={`/tasks/${task.id}`} key={task.id} className="flex items-center gap-3 px-5 py-3.5 transition hover:bg-white/[.025] sm:gap-4"><span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-line bg-panel2 text-muted"><Activity className="h-3.5 w-3.5"/></span><div className="min-w-0 flex-1"><div className="truncate text-xs font-medium text-slate-200">{adapterLabels[task.adapter] ?? task.adapter} · {task.id.slice(0, 8)}</div><div className="mt-1 font-mono text-[10px] text-muted">{task.currentStage} · {task.currentTool ?? '尚未调用工具'} · {task.progress}%</div></div><StatusBadge status={task.status}/><ArrowUpRight className="hidden h-3.5 w-3.5 shrink-0 text-slate-600 sm:block"/></Link>)}</div> : <Empty title="还没有分析任务" description="从智能分析向导开始，或先运行一个内置演示。" action={<Link to="/wizard"><Button>开始智能分析</Button></Link>}/>}</Card>
      <div className="space-y-5"><Card className="p-5"><div className="flex items-center justify-between"><h2 className="text-sm font-semibold text-white">工具状态</h2><Link to="/tools" className="text-xs text-accent">查看指引</Link></div><div className="mt-4 space-y-3">{summary?.adapters.map(adapter => <div key={adapter.name} className="flex items-center justify-between gap-3 border-b border-line/60 pb-3 last:border-0 last:pb-0"><div className="min-w-0"><div className="text-xs text-slate-200">{adapterLabels[adapter.name as AdapterName] ?? adapter.name}</div><div className="mt-1 max-w-[210px] truncate text-[10px] text-muted" title={adapter.detail}>{adapter.detail}</div></div><Badge tone={adapter.available ? 'success' : 'warn'}>{adapter.available ? '可用' : '缺依赖'}</Badge></div>)}</div></Card><Card className="p-5"><div className="flex items-center justify-between"><h2 className="text-sm font-semibold text-white">最近项目</h2><Link to="/projects" className="text-xs text-accent">全部</Link></div><div className="mt-3 space-y-2">{projects.data?.slice(0, 4).map(project => <Link key={project.id} to={`/projects/${project.id}`} className="flex items-center justify-between gap-2 rounded-lg px-2 py-2 text-xs hover:bg-white/5"><span className="truncate text-slate-300">{project.name}</span><Badge>{projectLabels[project.kind]}</Badge></Link>)}{!projects.data?.length && <p className="py-4 text-xs leading-5 text-muted">暂无项目。创建后会显示在这里。</p>}</div><div className="mt-4 flex items-center gap-2 border-t border-line pt-4 text-[11px] text-muted"><CheckCircle2 className="h-3.5 w-3.5 text-accent"/>任务重启后从检查点恢复</div></Card></div>
    </div>
  </>;
}

import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowUpRight, FilePlus2 } from 'lucide-react';
import { api, errorMessage } from '../api';
import { AsyncState, Badge, Button, Card, Empty, PageTitle, Spinner, StatusBadge } from '../components/ui';
import type { AdapterName, ProjectKind } from '@reverse/contracts';

const kindLabels: Record<ProjectKind, string> = {
  website: '网页项目', software: '软件项目', game: '游戏项目', security: '安全项目',
  protocol: '协议项目', hardware: '硬件项目', firmware: '固件项目',
};
const defaultAdapters: Record<ProjectKind, AdapterName> = {
  website: 'website', software: 'file', game: 'game', security: 'security',
  protocol: 'network', hardware: 'hardware', firmware: 'firmware',
};
const pageSize = 12;

export default function Projects() {
  const { id } = useParams();
  const navigate = useNavigate();
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const tasks = useQuery({ queryKey: ['tasks'], queryFn: api.tasks, refetchInterval: 2500 });
  const [limit, setLimit] = useState(pageSize);
  const [error, setError] = useState('');
  const project = projects.data?.find(item => item.id === id);
  const projectTasks = (tasks.data ?? []).filter(task => task.projectId === id);
  const latestAdapter = projectTasks[0]?.adapter;
  const adapter = latestAdapter ?? (project ? defaultAdapters[project.kind] : 'file');
  const createTask = useMutation({
    mutationFn: () => api.createTask(id!, adapter),
    onSuccess: task => navigate(`/tasks/${task.id}`),
    onError: cause => setError(errorMessage(cause)),
  });

  if (id) {
    if (projects.isLoading) return <AsyncState loading error={null}><span/></AsyncState>;
    if (!project) return <Empty title="项目不存在" description="项目可能已被删除，或本地 API 暂时不可用。"/>;
    const hasInput = project.uploads > 0 || Boolean(project.target);
    return <>
      <PageTitle title={project.name} description={`${kindLabels[project.kind]} · 创建于 ${new Date(project.createdAt).toLocaleString('zh-CN')}`} action={<Link to="/projects"><Button variant="secondary">返回项目档案</Button></Link>}/>
      <Card className="p-5"><div className="text-xs text-muted">目标 / 输入</div><div className="mt-2 break-all font-mono text-sm text-slate-200">{project.target || '已上传文件'}</div><div className="mt-4 flex flex-wrap items-center gap-2"><Badge tone="success">授权已确认</Badge><Badge>{project.uploads} 个文件</Badge><Badge tone="info">下一次分析器：{adapter}</Badge></div><div className="mt-5 flex flex-wrap items-center gap-3 border-t border-line pt-4"><Button disabled={!hasInput || createTask.isPending} onClick={() => { setError(''); createTask.mutate(); }}>{createTask.isPending ? <Spinner/> : <FilePlus2 className="h-4 w-4"/>}基于现有输入新建任务</Button><span className="text-xs text-muted">{hasInput ? '复用项目输入哈希并创建新的 Worker 任务，不覆盖已有结果。' : '项目没有目标或上传文件，请先创建新项目。'}</span></div>{error && <p role="alert" className="mt-3 text-xs text-red-300">{error}</p>}</Card>
      <Card className="mt-5"><div className="border-b border-line px-5 py-4 text-sm font-semibold text-white">项目任务</div><AsyncState loading={tasks.isLoading} error={tasks.isError} empty={!projectTasks.length} emptyTitle="尚无分析任务" emptyDescription="使用上方入口基于现有输入创建任务。" onRetry={() => void tasks.refetch()}>{projectTasks.map(task => <Link key={task.id} to={`/tasks/${task.id}`} className="flex items-center gap-3 border-b border-line/60 px-5 py-4 last:border-0"><div className="min-w-0 flex-1"><div className="truncate font-mono text-xs text-slate-300">{task.id}</div><div className="mt-1 text-[10px] text-muted">{task.adapter} · {task.currentStage} · {task.progress}%</div></div><StatusBadge status={task.status}/><ArrowUpRight className="h-4 w-4 text-muted"/></Link>)}</AsyncState></Card>
    </>;
  }

  return <>
    <PageTitle title="项目档案" description="本地项目、授权状态和输入文件。可从已有项目直接创建下一次分析任务。" action={<Link to="/new"><Button>新建项目</Button></Link>}/>
    <AsyncState loading={projects.isLoading} error={projects.isError} empty={!projects.data?.length} emptyTitle="暂无项目" emptyDescription="创建项目后，授权和输入文件会保存在本地档案中。" onRetry={() => void projects.refetch()}>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{projects.data?.slice(0, limit).map(item => <Link to={`/projects/${item.id}`} key={item.id}><Card className="h-full p-5 transition hover:border-accent/40"><div className="flex items-center justify-between"><Badge>{kindLabels[item.kind]}</Badge><ArrowUpRight className="h-4 w-4 text-muted"/></div><h2 className="mt-4 truncate text-sm font-semibold text-white">{item.name}</h2><p className="mt-2 truncate font-mono text-[10px] text-muted">{item.target || '文件输入'}</p><div className="mt-4 border-t border-line pt-3 text-[10px] text-muted">{item.uploads} 个文件 · {new Date(item.createdAt).toLocaleDateString('zh-CN')}</div></Card></Link>)}</div>
      {(projects.data?.length ?? 0) > limit && <Button variant="secondary" className="mt-4 w-full sm:w-auto" onClick={() => setLimit(value => value + pageSize)}>加载更多项目（剩余 {(projects.data?.length ?? 0) - limit}）</Button>}
    </AsyncState>
  </>;
}

import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  AlertTriangle, ArrowLeft, ArrowRight, Bot, CheckCircle2, ChevronRight, Circle,
  Clock3, Cpu, FileUp, FolderOpen, ListChecks, MessageSquare, Pause,
  Play, ShieldCheck, Sparkles, Square, Terminal, Wrench, X,
} from 'lucide-react';
import {
  api, errorMessage, type AutopilotQuestion, type AutopilotStatus,
  type AutopilotStep, type AutopilotTask,
} from '../api';
import {
  Badge, Button, Card, Empty, ErrorNotice, Field, Notice, ProgressBar, Spinner, inputClass,
} from '../components/ui';

const statusLabels: Record<AutopilotStatus, string> = {
  DRAFT: '草稿', DISCOVERING_REQUIREMENTS: '发现需求', PLANNING: '制定计划',
  WAITING_FOR_APPROVAL: '等待确认', RUNNING: '执行中', ANALYZING: '分析中',
  RECONSTRUCTING: '重建中', BUILDING: '构建中', TESTING: '测试中', REPAIRING: '修复中',
  PACKAGING: '打包中', VERIFYING: '验收中', WAITING_FOR_USER: '等待补充',
  PAUSED: '已暂停', BLOCKED: '受阻', PARTIAL_SUCCESS: '部分完成', FAILED: '失败',
  CANCELLED: '已取消', COMPLETED: '已完成',
};
const activeStatuses = new Set<AutopilotStatus>(['PLANNING', 'RUNNING', 'ANALYZING', 'RECONSTRUCTING', 'BUILDING', 'TESTING', 'REPAIRING', 'PACKAGING', 'VERIFYING']);
const stepLabels: Record<AutopilotStep['status'], string> = {
  PENDING: '待执行', READY: '可执行', RUNNING: '执行中', WAITING_FOR_USER: '等待输入',
  SUCCEEDED: '成功', FAILED: '失败', SKIPPED: '已跳过', BLOCKED: '受阻',
};
const examples = [
  '分析这个旧软件并生成兼容重建方案',
  '修复我的静态网站并交付可部署产物',
  '只读分析这份固件，输出风险与布局报告',
  '恢复目录里的数据并给出可验证的交付物',
];

function AutopilotStatusBadge({ status }: { status: AutopilotStatus }) {
  const tone = status === 'COMPLETED' ? 'success' : ['FAILED', 'BLOCKED', 'CANCELLED'].includes(status) ? 'danger' : status === 'PAUSED' || status === 'WAITING_FOR_APPROVAL' || status === 'WAITING_FOR_USER' ? 'warn' : activeStatuses.has(status) ? 'info' : 'neutral';
  return <Badge tone={tone}>{statusLabels[status] ?? status}</Badge>;
}

function hasAnswer(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '' && (!Array.isArray(value) || value.length > 0) && value !== false;
}
function questionAnswer(question: AutopilotQuestion, answers: Record<string, unknown>): unknown {
  return Object.prototype.hasOwnProperty.call(answers, question.id) ? answers[question.id] : answers[question.field];
}
function isAnswered(question: AutopilotQuestion, answers: Record<string, unknown>): boolean {
  return hasAnswer(questionAnswer(question, answers));
}
function splitLines(value: string): string[] {
  return [...new Set(value.split(/\r?\n/).map(item => item.trim()).filter(Boolean))];
}
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}
function formatDate(value?: string): string {
  return value ? new Date(value).toLocaleString('zh-CN') : '—';
}
function inferProjectKind(prompt: string): 'website' | 'software' | 'game' | 'security' | 'firmware' {
  if (/网站|网页|website|web|landing/i.test(prompt)) return 'website';
  if (/游戏|game|协议|protocol/i.test(prompt)) return 'game';
  if (/固件|firmware|路由器|单片机/i.test(prompt)) return 'firmware';
  if (/安全|漏洞|security|渗透|headers?/i.test(prompt)) return 'security';
  return 'software';
}

interface StreamEvent { id: number; type: string; payload: unknown; receivedAt: string }

function useAutopilotEvents(id: string | undefined, qc: QueryClient): StreamEvent[] {
  const [events, setEvents] = useState<StreamEvent[]>([]);
  useEffect(() => {
    if (!id) { setEvents([]); return; }
    const controller = new AbortController();
    setEvents([]);
    void fetch(`/api/autopilot/tasks/${encodeURIComponent(id)}/events`, {
      credentials: 'same-origin', signal: controller.signal, headers: { accept: 'text/event-stream' },
    }).then(async response => {
      if (!response.ok || !response.body) return;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf('\n\n');
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const lines = frame.split(/\r?\n/);
          const event = lines.find(line => line.startsWith('event:'))?.slice(6).trim();
          const eventId = Number(lines.find(line => line.startsWith('id:'))?.slice(3).trim() ?? 0);
          const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
          if (event === 'snapshot' && data) {
            try { qc.setQueryData(['autopilot-task', id], JSON.parse(data)); } catch { /* 忽略无法解析的快照，轮询会纠正。 */ }
          } else if (event && data) {
            try {
              setEvents(current => [...current.slice(-99), { id: eventId, type: event, payload: JSON.parse(data), receivedAt: new Date().toISOString() }]);
              void qc.invalidateQueries({ queryKey: ['autopilot-task', id] });
              if (/message|conversation|answer/i.test(event)) void qc.invalidateQueries({ queryKey: ['autopilot-messages', id] });
            } catch { /* 单条事件格式异常不应中断实时流。 */ }
          }
          boundary = buffer.indexOf('\n\n');
        }
      }
    }).catch(() => { /* 轮询是实时流的降级路径。 */ });
    return () => controller.abort();
  }, [id, qc]);
  return events;
}

function ProjectSelect({ value, onChange, projects, loading }: { value: string; onChange: (value: string) => void; projects: Array<{ id: string; name: string; kind: string }>; loading: boolean }) {
  return <select aria-label="工作项目" className={inputClass} value={value} onChange={event => onChange(event.target.value)} disabled={loading}>
    <option value="">新建 Autopilot 项目</option>
    {projects.map(project => <option key={project.id} value={project.id}>{project.name} · {project.kind}</option>)}
  </select>;
}

function AutopilotHome() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const [projectId, setProjectId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [paths, setPaths] = useState('');
  const [urls, setUrls] = useState('');
  const [materialsOpen, setMaterialsOpen] = useState(false);
  const progress = useRef<{ projectId?: string; uploadIds?: string[]; idempotencyKey?: string }>({});
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!projectId && projects.data?.length) setProjectId(projects.data[0]!.id);
  }, [projects.data, projectId]);
  const recentTasks = useQuery({
    queryKey: ['autopilot-tasks', projectId], queryFn: () => api.autopilotTasks(projectId),
    enabled: Boolean(projectId), refetchInterval: 5000,
  });

  const create = useMutation({
    mutationFn: async () => {
      const cleanPrompt = prompt.trim();
      if (!cleanPrompt) throw new Error('请先用自然语言描述你想完成的事');
      let targetProjectId = progress.current.projectId ?? projectId;
      if (!targetProjectId) {
        const created = await api.createProject({
          name: cleanPrompt.slice(0, 48) || 'Autopilot 项目', kind: inferProjectKind(cleanPrompt), authorizationConfirmed: true,
        });
        targetProjectId = created.id;
        progress.current.projectId = created.id;
      }
      let uploadIds = progress.current.uploadIds;
      if (!uploadIds) {
        uploadIds = [];
        for (const file of files) uploadIds.push((await api.upload(targetProjectId, file)).id);
        progress.current.uploadIds = uploadIds;
      }
      const idempotencyKey = progress.current.idempotencyKey ?? crypto.randomUUID();
      progress.current.idempotencyKey = idempotencyKey;
      return api.createAutopilot({
        projectId: targetProjectId, prompt: cleanPrompt, idempotencyKey,
        ...(uploadIds.length ? { uploadIds } : {}),
        ...(splitLines(paths).length ? { paths: splitLines(paths) } : {}),
        ...(splitLines(urls).length ? { urls: splitLines(urls) } : {}),
      });
    },
    onSuccess: task => {
      progress.current = {};
      setPrompt(''); setFiles([]); setPaths(''); setUrls(''); setMaterialsOpen(false);
      void qc.invalidateQueries({ queryKey: ['projects'] });
      void qc.invalidateQueries({ queryKey: ['autopilot-tasks'] });
      navigate(`/autopilot/${task.id}`);
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    create.mutate();
  }
  function addFiles(next: FileList | null) {
    if (!next) return;
    setFiles(current => [...current, ...Array.from(next).filter(file => !current.some(item => item.name === file.name && item.size === file.size))].slice(0, 12));
  }

  return <div className="mx-auto max-w-4xl pb-10">
    <div className="mb-8 flex items-center justify-between gap-4">
      <Link to="/" className="inline-flex items-center gap-2 text-xs text-muted hover:text-accent"><ArrowLeft className="h-3.5 w-3.5"/>返回专业工作区</Link>
      <Link to="/models" className="inline-flex items-center gap-2 text-xs text-muted hover:text-accent"><Cpu className="h-3.5 w-3.5"/>模型管理</Link>
    </div>
    <section className="mx-auto max-w-3xl text-center">
      <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl border border-accent/30 bg-accent/10 text-accent shadow-[0_0_50px_rgb(var(--accent)/.12)]"><Sparkles className="h-6 w-6"/></div>
      <h1 className="mt-6 text-3xl font-semibold tracking-tight text-white sm:text-4xl">把想法交给 Autopilot</h1>
      <p className="mx-auto mt-3 max-w-2xl text-sm leading-7 text-muted">用自然语言说明目标。Autopilot 会先问清必要信息、展示目标契约与计划，再在授权和预算内执行，并交付可核验的成品。</p>
    </section>

    <Card className="mt-8 overflow-hidden border-accent/20 bg-panel/95 shadow-[0_24px_80px_rgb(0_0_0/.18)]">
      <form onSubmit={submit}>
        <div className="p-4 sm:p-5">
          <textarea aria-label="描述你的目标" value={prompt} onChange={event => setPrompt(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); create.mutate(); } }} placeholder="例如：分析这个旧软件，恢复兼容运行方式，并交付源码、测试与使用说明…" className="min-h-32 w-full resize-y bg-transparent text-sm leading-7 text-slate-100 outline-none placeholder:text-slate-600" maxLength={16000}/>
          {files.length > 0 && <div className="mt-3 flex flex-wrap gap-2">{files.map((file, index) => <span key={`${file.name}-${file.size}-${index}`} className="inline-flex max-w-full items-center gap-2 rounded-lg border border-line bg-panel2 px-2.5 py-1.5 text-[11px] text-slate-300"><FileUp className="h-3.5 w-3.5 shrink-0 text-accent"/><span className="truncate">{file.name}</span><span className="shrink-0 font-mono text-[10px] text-muted">{formatBytes(file.size)}</span><button type="button" aria-label={`移除 ${file.name}`} onClick={() => setFiles(current => current.filter((_, itemIndex) => itemIndex !== index))} className="text-muted hover:text-red-300"><X className="h-3.5 w-3.5"/></button></span>)}</div>}
          {materialsOpen && <div className="mt-4 grid gap-4 border-t border-line pt-4 md:grid-cols-2">
            <Field label="本机目录 / 文件路径" hint="每行一个绝对路径。浏览器不会直接读取目录；路径会作为结构化材料提交给本机服务。"><textarea aria-label="本机目录或文件路径" className={`${inputClass} min-h-24 resize-y font-mono text-xs`} value={paths} onChange={event => setPaths(event.target.value)} placeholder={'C:\\samples\\target\n/home/user/project'}/></Field>
            <Field label="目标 URL" hint="每行一个 http/https 地址；服务端仍会执行 SSRF 与授权检查。"><textarea aria-label="目标 URL" className={`${inputClass} min-h-24 resize-y font-mono text-xs`} value={urls} onChange={event => setUrls(event.target.value)} placeholder={'https://example.com\nhttps://docs.example.com'}/></Field>
          </div>}
          {create.isError && <div className="mt-4"><ErrorNotice error={create.error} component="创建 Autopilot 任务" onRetry={() => create.mutate()}/></div>}
        </div>
        <div className="flex flex-col gap-3 border-t border-line bg-panel2/40 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
          <div className="flex flex-wrap items-center gap-2">
            <input ref={fileInput} aria-label="上传材料文件" type="file" multiple className="hidden" onChange={event => { addFiles(event.target.files); event.target.value = ''; }}/>
            <Button type="button" variant="ghost" onClick={() => fileInput.current?.click()}><FileUp className="h-4 w-4"/>上传文件</Button>
            <Button type="button" variant="ghost" aria-expanded={materialsOpen} onClick={() => setMaterialsOpen(value => !value)}><FolderOpen className="h-4 w-4"/>目录 / URL<ChevronRight className={`h-3.5 w-3.5 transition ${materialsOpen ? 'rotate-90' : ''}`}/></Button>
          </div>
          <div className="flex items-center gap-3">
            <div className="hidden w-44 sm:block"><ProjectSelect value={projectId} onChange={setProjectId} projects={projects.data ?? []} loading={projects.isLoading}/></div>
            <Button type="submit" disabled={create.isPending || !prompt.trim()} className="min-w-28">{create.isPending ? <Spinner/> : <ArrowRight className="h-4 w-4"/>}{create.isPending ? '创建中' : '发送'}</Button>
          </div>
        </div>
      </form>
    </Card>
    <div className="mt-4 flex flex-wrap items-center justify-center gap-2 text-[11px] text-muted"><ShieldCheck className="h-3.5 w-3.5 text-accent"/>默认 local-only<span>·</span>未知程序不会被执行<span>·</span>计划确认前不会扩大权限</div>

    <section className="mt-8">
      <div className="mb-3 flex items-center justify-between"><h2 className="text-xs font-medium uppercase tracking-[.16em] text-muted">试试这样描述</h2><span className="font-mono text-[10px] text-slate-600">Ctrl / ⌘ + Enter 发送</span></div>
      <div className="grid gap-2 sm:grid-cols-2">{examples.map(example => <button key={example} type="button" onClick={() => setPrompt(example)} className="rounded-xl border border-line bg-panel/60 px-4 py-3 text-left text-xs leading-5 text-slate-300 transition hover:border-accent/40 hover:bg-accent/[.03]">{example}<ArrowRight className="ml-2 inline h-3 w-3 text-slate-600"/></button>)}</div>
    </section>

    <section className="mt-10">
      <div className="mb-3 flex items-center justify-between"><h2 className="text-sm font-semibold text-white">最近 Autopilot 任务</h2>{projectId && <span className="font-mono text-[10px] text-muted">当前项目</span>}</div>
      <Card>
        {!projectId ? <Empty title="选择或新建一个项目" description="创建任务时会自动新建 Autopilot 项目，也可以先在这里选择现有项目。"/> : recentTasks.isLoading ? <div className="flex items-center justify-center gap-2 p-8 text-sm text-muted"><Spinner/>读取任务…</div> : recentTasks.isError ? <div className="p-4"><ErrorNotice error={recentTasks.error} component="读取 Autopilot 任务" onRetry={() => recentTasks.refetch()}/></div> : recentTasks.data?.items.length ? <div className="divide-y divide-line/70">{recentTasks.data.items.map(task => <Link key={task.id} to={`/autopilot/${task.id}`} className="flex items-center gap-3 px-5 py-4 transition hover:bg-white/[.025]"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-line bg-panel2 text-accent"><Bot className="h-4 w-4"/></span><div className="min-w-0 flex-1"><div className="truncate text-xs font-medium text-slate-200">{task.prompt}</div><div className="mt-1 font-mono text-[10px] text-muted">{task.id.slice(0, 12)} · {formatDate(task.updatedAt)}</div></div><AutopilotStatusBadge status={task.status}/><ChevronRight className="h-4 w-4 shrink-0 text-slate-600"/></Link>)}</div> : <Empty title="还没有 Autopilot 任务" description="在上方用自然语言描述目标，任务会出现在这里。"/>}
      </Card>
    </section>
  </div>;
}

function QuestionCard({ question, task, pending, onSubmit, onUpload }: {
  question: AutopilotQuestion; task: AutopilotTask; pending: boolean;
  onSubmit: (answers: Record<string, unknown>) => void; onUpload: (file: File) => Promise<string>;
}) {
  const existing = questionAnswer(question, task.answers);
  const [value, setValue] = useState<unknown>(Array.isArray(existing) ? existing : existing ?? question.defaultValue ?? '');
  const [detail, setDetail] = useState('');
  const [file, setFile] = useState<File>();
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { setValue(Array.isArray(existing) ? existing : existing ?? question.defaultValue ?? ''); }, [question.id, existing, question.defaultValue]);
  const options = question.options ?? [];
  const multi = question.kind === 'multi';
  const choice = question.kind === 'single' || question.kind === 'platform' || question.kind === 'version' || question.kind === 'depth' || question.kind === 'permission' || question.kind === 'sharing';
  const materialQuestion = question.field === 'materials' || question.id === 'materials';

  function toggle(option: string) {
    setValue((current: unknown) => {
      const list = Array.isArray(current) ? current as string[] : [];
      return list.includes(option) ? list.filter(item => item !== option) : [...list, option];
    });
  }
  async function submit() {
    setError('');
    let next = value;
    if (question.kind === 'file') {
      if (!hasAnswer(next)) {
        if (!file) { setError('请选择一个文件'); return; }
        setUploading(true);
        try { next = await onUpload(file); setValue(next); } catch (uploadError) { setError(errorMessage(uploadError)); setUploading(false); return; }
        setUploading(false);
      }
    }
    if (materialQuestion) {
      const list = Array.isArray(next) ? next as string[] : hasAnswer(next) ? [String(next)] : [];
      if (file) {
        setUploading(true);
        try { list.push(await onUpload(file)); setFile(undefined); } catch (uploadError) { setError(errorMessage(uploadError)); setUploading(false); return; }
        setUploading(false);
      }
      next = [...list, ...splitLines(detail)];
      setValue(next);
    }
    if (question.required && !hasAnswer(next)) { setError('这项信息是继续执行所必需的'); return; }
    onSubmit({ [question.id]: next, [question.field]: next });
  }

  return <Card className="mt-5 border-accent/25 bg-accent/[.025] p-5">
    <div className="flex items-start gap-3"><span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-accent/30 bg-accent/10 text-accent"><MessageSquare className="h-3.5 w-3.5"/></span><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h3 className="text-sm font-semibold text-white">{question.prompt}</h3>{question.required && <Badge tone="warn">必需</Badge>}</div><p className="mt-1.5 text-xs leading-5 text-muted">{question.help}</p></div></div>
    <div className="mt-4 space-y-3">
      {choice && options.length > 0 && <div className="grid gap-2 sm:grid-cols-2">{options.map(option => <button key={option.value} type="button" aria-pressed={value === option.value} onClick={() => setValue(option.value)} className={`rounded-lg border px-3 py-2.5 text-left transition ${value === option.value ? 'border-accent/60 bg-accent/10' : 'border-line bg-panel2/50 hover:border-accent/40'}`}><div className="text-xs font-medium text-slate-200">{option.label}</div>{option.description && <div className="mt-1 text-[10px] leading-4 text-muted">{option.description}</div>}</button>)}</div>}
      {multi && options.length > 0 && <div className="grid gap-2 sm:grid-cols-3">{options.map(option => { const checked = Array.isArray(value) && value.includes(option.value); return <label key={option.value} className={`flex cursor-pointer items-start gap-2 rounded-lg border p-3 text-xs ${checked ? 'border-accent/60 bg-accent/10' : 'border-line bg-panel2/50'}`}><input type="checkbox" checked={checked} onChange={() => toggle(option.value)} className="mt-0.5 accent-[rgb(var(--accent))]"/><span><span className="block text-slate-200">{option.label}</span>{option.description && <span className="mt-1 block text-[10px] leading-4 text-muted">{option.description}</span>}</span></label>; })}</div>}
      {(question.kind === 'text' || question.kind === 'directory' || materialQuestion) && <textarea aria-label={question.prompt} className={`${inputClass} min-h-24 resize-y`} value={materialQuestion ? detail : typeof value === 'string' ? value : ''} onChange={event => materialQuestion ? setDetail(event.target.value) : setValue(event.target.value)} placeholder={question.kind === 'directory' ? '输入绝对路径或目标 URL；每行一个' : '输入补充信息，可多行'}/>}
      {question.kind === 'directory' && <Notice>浏览器不能直接读取本机目录。这里提交的是结构化路径，只有本机服务在授权范围内才能读取并创建任务私有快照。</Notice>}
      {(question.kind === 'file' || materialQuestion) && <div><input aria-label={`${question.prompt} 文件`} type="file" className="block w-full text-xs text-slate-300 file:mr-3 file:min-h-10 file:rounded-lg file:border file:border-line file:bg-panel2 file:px-3 file:text-slate-200" onChange={event => setFile(event.target.files?.[0])}/>{file && <p className="mt-2 text-[11px] text-muted">将上传：{file.name} · {formatBytes(file.size)}</p>}</div>}
      {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
      <div className="flex justify-end"><Button onClick={() => void submit()} disabled={pending || uploading}>{uploading ? <Spinner/> : <ArrowRight className="h-3.5 w-3.5"/>}{uploading ? '上传中' : '继续'}</Button></div>
    </div>
  </Card>;
}

function DefinitionList({ items }: { items: Array<[string, ReactNode]> }) {
  return <dl className="grid gap-3 sm:grid-cols-2">{items.map(([label, value]) => <div key={label} className="rounded-lg border border-line bg-panel2/40 p-3"><dt className="text-[10px] uppercase tracking-wider text-muted">{label}</dt><dd className="mt-1.5 break-words text-xs leading-5 text-slate-200">{value}</dd></div>)}</dl>;
}

function ContractCard({ task, pending, onApprove }: { task: AutopilotTask; pending: boolean; onApprove: () => void }) {
  const contract = task.contract;
  if (!contract) return null;
  return <Card className="mt-5 p-5">
    <div className="flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-accent"/><h3 className="text-sm font-semibold text-white">确认目标契约</h3><Badge tone="info">执行前确认</Badge></div>
    <p className="mt-2 text-xs leading-5 text-muted">契约固定授权、预算、交付与验收口径。确认后才会生成可执行计划。</p>
    <div className="mt-4"><DefinitionList items={[
      ['用户目标', contract.userGoal], ['数据边界', contract.dataSharing === 'local-only' ? '仅本地' : '已批准远程处理'],
      ['授权范围', contract.authorizedScope.join('；') || '—'], ['允许操作', contract.allowedOperations.join('；') || '—'],
      ['禁止操作', contract.forbiddenOperations.join('；') || '—'], ['预期交付', contract.expectedOutputs.join('；') || '—'],
      ['预算', `${contract.budget.timeoutMs / 1000}s · ${contract.budget.maxTokens} tokens · $${contract.budget.maxCostUsd}`],
      ['已知限制', contract.knownLimitations.join('；') || '—'],
    ]}/></div>
    <div className="mt-4"><h4 className="text-xs font-medium text-slate-300">验收标准</h4><ul className="mt-2 space-y-1.5">{contract.acceptanceCriteria.map((item, index) => <li key={`${item}-${index}`} className="flex gap-2 text-xs leading-5 text-muted"><CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent"/>{item}</li>)}</ul></div>
    <div className="mt-5 flex justify-end"><Button onClick={onApprove} disabled={pending}>{pending ? <Spinner/> : <CheckCircle2 className="h-3.5 w-3.5"/>}确认契约并生成计划</Button></div>
  </Card>;
}

function PlanCard({ task, pending, onApprove }: { task: AutopilotTask; pending: boolean; onApprove: () => void }) {
  const plan = task.plan;
  if (!plan) return null;
  return <Card className="mt-5 p-5">
    <div className="flex items-center gap-2"><ListChecks className="h-4 w-4 text-accent"/><h3 className="text-sm font-semibold text-white">确认执行计划</h3><Badge tone="info">v{plan.version}</Badge></div>
    <p className="mt-2 text-xs leading-5 text-muted">{plan.rationale}</p>
    <ol className="mt-4 space-y-2">{plan.steps.map((step, index) => <li key={step.id} className="flex gap-3 rounded-lg border border-line bg-panel2/40 p-3"><span className="grid h-6 w-6 shrink-0 place-items-center rounded-md border border-line font-mono text-[10px] text-muted">{index + 1}</span><div className="min-w-0"><div className="text-xs font-medium text-slate-200">{step.title}</div><div className="mt-1 font-mono text-[10px] text-muted">{step.tool} · 依赖 {step.dependsOn.length ? step.dependsOn.join(', ') : '无'}</div><p className="mt-1 text-[11px] leading-5 text-muted">验收：{step.acceptance}</p></div></li>)}</ol>
    <div className="mt-5 flex justify-end"><Button onClick={onApprove} disabled={pending}>{pending ? <Spinner/> : <Play className="h-3.5 w-3.5"/>}确认计划并开始执行</Button></div>
  </Card>;
}

function StepIcon({ status }: { status: AutopilotStep['status'] }) {
  if (status === 'SUCCEEDED') return <CheckCircle2 className="h-4 w-4 text-emerald-400"/>;
  if (status === 'FAILED' || status === 'BLOCKED') return <AlertTriangle className="h-4 w-4 text-red-400"/>;
  if (status === 'RUNNING') return <Spinner/>;
  if (status === 'WAITING_FOR_USER') return <MessageSquare className="h-4 w-4 text-amber-400"/>;
  if (status === 'SKIPPED') return <Circle className="h-4 w-4 text-slate-600"/>;
  return <Clock3 className="h-4 w-4 text-slate-600"/>;
}

function AutopilotTaskDetail({ id }: { id: string }) {
  const qc = useQueryClient();
  const taskQuery = useQuery({ queryKey: ['autopilot-task', id], queryFn: () => api.autopilotTask(id), refetchInterval: 2500 });
  const messagesQuery = useQuery({ queryKey: ['autopilot-messages', id], queryFn: () => api.autopilotMessages(id), refetchInterval: 3000 });
  const events = useAutopilotEvents(id, qc);
  const [followUp, setFollowUp] = useState('');
  const task = taskQuery.data;
  const action = useMutation({
    mutationFn: (name: 'pause' | 'resume' | 'cancel') => api.autopilotAction(id, name),
    onSuccess: value => { qc.setQueryData(['autopilot-task', id], value); void qc.invalidateQueries({ queryKey: ['autopilot-tasks'] }); },
  });
  const answer = useMutation({
    mutationFn: (answers: Record<string, unknown>) => api.submitAutopilotAnswers(id, { answers }),
    onSuccess: value => { qc.setQueryData(['autopilot-task', id], value); setFollowUp(''); void qc.invalidateQueries({ queryKey: ['autopilot-messages', id] }); void qc.invalidateQueries({ queryKey: ['autopilot-tasks'] }); },
  });
  const approve = useMutation({
    mutationFn: (body: { approveContract?: boolean; approvePlan?: boolean }) => api.submitAutopilotAnswers(id, { answers: {}, ...body }),
    onSuccess: value => { qc.setQueryData(['autopilot-task', id], value); void qc.invalidateQueries({ queryKey: ['autopilot-tasks'] }); },
  });
  const upload = async (file: File) => (await api.upload(task!.projectId, file)).id;

  if (taskQuery.isLoading) return <div className="flex items-center justify-center gap-2 p-16 text-sm text-muted"><Spinner/>载入 Autopilot 任务…</div>;
  if (taskQuery.isError) return <ErrorNotice error={taskQuery.error} component="载入 Autopilot 任务" onRetry={() => taskQuery.refetch()}/>;
  if (!task) return <Empty title="任务不存在" description="检查任务 ID，或返回 Autopilot 首页创建新任务。" action={<Link to="/autopilot"><Button>返回 Autopilot</Button></Link>}/>;

  const steps = task.plan?.steps ?? [];
  const completedSteps = steps.filter(step => step.status === 'SUCCEEDED' || step.status === 'SKIPPED').length;
  const progress = steps.length ? completedSteps / steps.length * 100 : 0;
  const nextQuestion = task.questions.find(question => !isAnswered(question, task.answers));
  const canPause = activeStatuses.has(task.status);
  const messages = messagesQuery.data?.items ?? [];
  const promptMessage = { id: 0, taskId: task.id, role: 'user' as const, content: task.prompt, metadata: {}, createdAt: task.createdAt };
  const displayMessages = messages.some(message => message.role === 'user' && message.content === task.prompt) ? messages : [promptMessage, ...messages];

  return <div className="pb-10">
    <div className="mb-5 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
      <div className="min-w-0"><Link to="/autopilot" className="mb-3 inline-flex items-center gap-2 text-xs text-muted hover:text-accent"><ArrowLeft className="h-3.5 w-3.5"/>Autopilot</Link><div className="flex flex-wrap items-center gap-2"><AutopilotStatusBadge status={task.status}/><span className="font-mono text-[10px] text-muted">{task.id}</span></div><h1 className="mt-3 line-clamp-2 text-xl font-semibold leading-7 text-white">{task.prompt}</h1><p className="mt-2 text-[11px] text-muted">项目 <span className="font-mono text-slate-400">{task.projectId}</span> · 更新于 {formatDate(task.updatedAt)}</p></div>
      <div className="flex flex-wrap gap-2">
        {canPause && <><Button variant="secondary" disabled={action.isPending} onClick={() => action.mutate('pause')}><Pause className="h-3.5 w-3.5"/>暂停</Button><Button variant="danger" disabled={action.isPending} onClick={() => { if (window.confirm('确认取消这个 Autopilot 任务？已生成的工件会保留。')) action.mutate('cancel'); }}><Square className="h-3.5 w-3.5"/>取消</Button></>}
        {task.status === 'PAUSED' && <Button disabled={action.isPending} onClick={() => action.mutate('resume')}><Play className="h-3.5 w-3.5"/>恢复</Button>}
        {['COMPLETED', 'PARTIAL_SUCCESS'].includes(task.status) && <Link to={`/delivery/${task.id}`}><Button>查看交付</Button></Link>}
      </div>
    </div>
    {(action.isError || answer.isError || approve.isError) && <div className="mb-4"><ErrorNotice error={action.error ?? answer.error ?? approve.error} component="更新 Autopilot 任务" onRetry={() => { void taskQuery.refetch(); }}/></div>}
    {task.error && <div className="mb-4"><Notice tone="warn">{task.error}</Notice></div>}

    <div className="grid gap-5 xl:grid-cols-[minmax(0,1.55fr)_minmax(320px,.8fr)]">
      <div className="min-w-0 space-y-5">
        <Card className="overflow-hidden">
          <div className="flex items-center justify-between border-b border-line px-5 py-4"><div className="flex items-center gap-2"><MessageSquare className="h-4 w-4 text-accent"/><h2 className="text-sm font-semibold text-white">对话</h2></div><span className="font-mono text-[10px] text-muted">{messagesQuery.isLoading ? '同步中' : `${messages.length} 条消息`}</span></div>
          <div className="max-h-[620px] space-y-5 overflow-y-auto p-5">
            {displayMessages.map(message => <div key={message.id} className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}><div className={`max-w-[88%] rounded-2xl border px-4 py-3 text-xs leading-6 ${message.role === 'user' ? 'border-accent/25 bg-accent/10 text-slate-100' : message.role === 'system' ? 'border-line bg-panel2/50 text-muted' : 'border-line bg-panel2/30 text-slate-200'}`}><div className="mb-1 font-mono text-[9px] uppercase tracking-wider text-muted">{message.role === 'user' ? '你' : message.role === 'assistant' ? 'Autopilot' : '系统'}</div><div className="whitespace-pre-wrap break-words">{message.content}</div></div></div>)}
            {messagesQuery.isError && <ErrorNotice error={messagesQuery.error} component="读取对话" onRetry={() => messagesQuery.refetch()}/>}
          </div>
        </Card>

        {(task.status === 'DISCOVERING_REQUIREMENTS' || task.status === 'WAITING_FOR_USER') && nextQuestion && <QuestionCard question={nextQuestion} task={task} pending={answer.isPending} onSubmit={values => answer.mutate(values)} onUpload={upload}/>}
        {task.status === 'WAITING_FOR_APPROVAL' && task.contract && !task.plan && <ContractCard task={task} pending={approve.isPending} onApprove={() => approve.mutate({ approveContract: true })}/>}
        {task.status === 'WAITING_FOR_APPROVAL' && task.contract && task.plan && <PlanCard task={task} pending={approve.isPending} onApprove={() => approve.mutate({ approveContract: true, approvePlan: true })}/>}
        {task.status === 'WAITING_FOR_APPROVAL' && !task.contract && <Notice tone="warn">契约尚未生成，正在等待服务端状态更新。</Notice>}

        {(task.status === 'WAITING_FOR_USER' && !nextQuestion) || task.status === 'DISCOVERING_REQUIREMENTS' ? <Card className="p-4"><form onSubmit={event => { event.preventDefault(); if (followUp.trim()) answer.mutate({ freeText: followUp.trim() }); }} className="flex items-end gap-2"><textarea aria-label="补充信息" value={followUp} onChange={event => setFollowUp(event.target.value)} placeholder="补充目标、材料或限制条件…" className={`${inputClass} min-h-20 resize-y`}/><Button type="submit" disabled={answer.isPending || !followUp.trim()}>{answer.isPending ? <Spinner/> : <ArrowRight className="h-4 w-4"/>}发送</Button></form></Card> : null}
        {activeStatuses.has(task.status) && <Card className="p-5"><div className="flex items-center gap-2"><Spinner/><span className="text-sm text-slate-200">Autopilot 正在执行真实计划</span></div><p className="mt-2 text-xs leading-5 text-muted">页面通过事件流同步状态，并每 2.5 秒轮询校正。可随时暂停或取消；不会显示虚构进度。</p></Card>}
        {task.status === 'COMPLETED' && <Card className="flex flex-col gap-3 border-emerald-400/20 bg-emerald-400/[.04] p-5 sm:flex-row sm:items-center sm:justify-between"><div><div className="flex items-center gap-2 text-sm font-semibold text-emerald-200"><CheckCircle2 className="h-4 w-4"/>任务已完成</div><p className="mt-1 text-xs text-muted">交付中心包含真实工件、SHA-256、教程与独立验收结果。</p></div><Link to={`/delivery/${task.id}`}><Button>打开交付中心<ArrowRight className="h-3.5 w-3.5"/></Button></Link></Card>}
      </div>

      <aside className="space-y-5">
        <Card className="p-5"><div className="flex items-center justify-between"><h2 className="text-sm font-semibold text-white">执行状态</h2><AutopilotStatusBadge status={task.status}/></div>{steps.length ? <div className="mt-4"><div className="mb-2 flex items-center justify-between text-[11px]"><span className="text-muted">真实计划进度</span><span className="font-mono text-slate-300">{completedSteps}/{steps.length} 步</span></div><ProgressBar value={progress} label="Autopilot 计划进度"/></div> : <p className="mt-3 text-xs leading-5 text-muted">计划生成后，这里会按真实步骤计算进度。</p>}<div className="mt-4 grid grid-cols-2 gap-2 text-[11px]"><div className="rounded-lg border border-line bg-panel2/40 p-2.5"><div className="text-muted">模型调用</div><div className="mt-1 font-mono text-slate-200">{task.metrics.modelCalls}</div></div><div className="rounded-lg border border-line bg-panel2/40 p-2.5"><div className="text-muted">Token</div><div className="mt-1 font-mono text-slate-200">{task.metrics.tokens.toLocaleString()}</div></div><div className="rounded-lg border border-line bg-panel2/40 p-2.5"><div className="text-muted">费用 (USD)</div><div className="mt-1 font-mono text-slate-200">{task.metrics.costUsd.toFixed(4)}</div></div><div className="rounded-lg border border-line bg-panel2/40 p-2.5"><div className="text-muted">修复尝试</div><div className="mt-1 font-mono text-slate-200">{task.metrics.repairAttempts}</div></div></div></Card>

        <Card className="p-5"><div className="flex items-center gap-2"><ListChecks className="h-4 w-4 text-accent"/><h2 className="text-sm font-semibold text-white">计划步骤</h2><span className="ml-auto font-mono text-[10px] text-muted">{steps.length}</span></div>{steps.length ? <ol className="mt-4 space-y-3">{steps.map(step => <li key={step.id} className="flex gap-3"><StepIcon status={step.status}/><div className="min-w-0 flex-1"><div className="text-xs font-medium leading-5 text-slate-200">{step.title}</div><div className="mt-0.5 flex flex-wrap items-center gap-2 font-mono text-[9px] text-muted"><span>{step.tool}</span><span>·</span><span>{stepLabels[step.status]}</span>{step.attempt > 0 && <><span>·</span><span>尝试 {step.attempt}</span></>}</div>{step.error && <p className="mt-1 break-words text-[10px] leading-4 text-red-300">{step.error}</p>}</div></li>)}</ol> : <p className="mt-4 text-xs leading-5 text-muted">尚无计划步骤。</p>}</Card>

        <Card className="p-5"><div className="flex items-center gap-2"><Terminal className="h-4 w-4 text-accent"/><h2 className="text-sm font-semibold text-white">实时事件</h2><span className="ml-auto font-mono text-[10px] text-muted">{events.length}</span></div>{events.length ? <div className="mt-4 max-h-72 space-y-2 overflow-y-auto pr-1">{events.slice().reverse().map((event, index) => <details key={`${event.id}-${index}`} className="rounded-lg border border-line bg-panel2/40 p-2.5"><summary className="cursor-pointer font-mono text-[10px] text-slate-300">{event.type || `event ${event.id}`}</summary><pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all text-[9px] leading-4 text-muted">{JSON.stringify(event.payload, null, 2)}</pre></details>)}</div> : <p className="mt-4 text-xs leading-5 text-muted">等待真实执行事件。心跳与空日志不会显示为进度。</p>}</Card>

        <Card className="p-5"><div className="flex items-center gap-2"><Wrench className="h-4 w-4 text-accent"/><h2 className="text-sm font-semibold text-white">运行指标</h2></div><dl className="mt-4 space-y-2.5 text-[11px]">{[['提问次数', task.metrics.questionsAsked], ['人工介入', task.metrics.interventions], ['重复提问', task.metrics.repeatedQuestions], ['无进展步骤', task.metrics.noProgressSteps], ['峰值内存', `${task.metrics.peakMemoryMB} MB`], ['开始时间', formatDate(task.metrics.startedAt)], ['结束时间', formatDate(task.metrics.endedAt)]].map(([label, value]) => <div key={String(label)} className="flex justify-between gap-3"><dt className="text-muted">{label}</dt><dd className="text-right font-mono text-slate-300">{value}</dd></div>)}</dl></Card>
      </aside>
    </div>
  </div>;
}

export default function Autopilot() {
  const { id } = useParams();
  return id ? <AutopilotTaskDetail id={id}/> : <AutopilotHome/>;
}

import { useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Binary, Bot, CheckCircle2, Cpu, Gamepad2, Globe2, Layers3, Rocket, ShieldCheck, Sparkles, Usb, Wrench } from 'lucide-react';
import { api, type AnalyzerId, type PlanBudget, type PlanMode, type TargetKind } from '../api';
import { Badge, Button, Card, ErrorNotice, Field, Notice, PageTitle, Spinner, inputClass } from '../components/ui';
import TaskLivePanel from '../components/TaskLivePanel';
import type { ProjectKind } from '@reverse/contracts';

interface Category { id: string; title: string; description: string; kind: ProjectKind; targetKind: TargetKind; analyzers: AnalyzerId[]; objective: string; accept: string; icon: typeof Globe2 }
const categories: Category[] = [
  { id: 'website', title: '分析网页', description: '采集页面结构、脚本与网络元数据', kind: 'website', targetKind: 'HAR', analyzers: ['website'], objective: '分析网页结构、资源与同源网络元数据', accept: '.har,.json', icon: Globe2 },
  { id: 'software', title: '分析软件', description: '识别格式、字符串、归档与依赖', kind: 'software', targetKind: 'UNKNOWN', analyzers: ['file', 'ghidra'], objective: '识别软件格式并提取静态元数据', accept: '.exe,.dll,.so,.elf,.bin,.zip', icon: Binary },
  { id: 'firmware', title: '分析固件', description: '识别镜像、熵、字符串与布局', kind: 'firmware', targetKind: 'FIRMWARE', analyzers: ['firmware'], objective: '识别固件身份并分析静态布局', accept: '.bin,.img,.hex,.ihex,.uf2,.elf,.zip,.fw', icon: Cpu },
  { id: 'game', title: '复活游戏', description: '从合法回放推断协议并验证兼容服务', kind: 'game', targetKind: 'UNKNOWN', analyzers: ['game'], objective: '从合法游戏回放中分析协议并验证兼容服务', accept: '.json', icon: Gamepad2 },
  { id: 'usb', title: '分析 USB 记录', description: '解析离线 USB 请求、接口与端点', kind: 'hardware', targetKind: 'PCAP', analyzers: ['usb'], objective: '解析离线 USB 记录中的设备与传输元数据', accept: '.pcap,.pcapng,.txt,.json,.bin', icon: Usb },
  { id: 'network', title: '分析网络记录', description: '解析 HAR、PCAP 与端点元数据', kind: 'protocol', targetKind: 'HAR', analyzers: ['network'], objective: '解析网络记录中的端点、方法与状态', accept: '.har,.pcap,.pcapng', icon: Layers3 },
  { id: 'security', title: '安全检查', description: '被动检查与静态危险模式复核', kind: 'security', targetKind: 'UNKNOWN', analyzers: ['security'], objective: '对自有样本执行被动静态安全检查', accept: '.txt,.json,.har,.pcap', icon: ShieldCheck },
  { id: 'android', title: '分析 Android 应用', description: '检查 APK、Manifest、DEX 与资源', kind: 'software', targetKind: 'APK', analyzers: ['jadx', 'android'], objective: '静态分析 APK 的 Manifest、DEX 与资源元数据', accept: '.apk,.dex,.zip', icon: Wrench },
];
const modes: { id: PlanMode; title: string; subtitle: string; description: string; icon: typeof Sparkles }[] = [
  { id: 'beginner', title: '小白模式', subtitle: '一步到位', description: '自动选择安全路径，用通俗语言解释每一步。', icon: Sparkles },
  { id: 'professional', title: '专业模式', subtitle: '完全可控', description: '展示完整步骤、预算与依赖，适合有经验的研究者。', icon: Wrench },
  { id: 'agent', title: 'AI Agent', subtitle: '授权内迭代', description: '允许模型在明确授权和资源预算内迭代分析。', icon: Bot },
];
const budgets: Record<PlanMode, PlanBudget> = {
  beginner: { timeoutMs: 120_000, maxToolCalls: 8, maxModelIterations: 2, maxTokens: 4096, maxCostUsd: 0.2, maxMemoryBytes: 536_870_912, maxDiskBytes: 536_870_912, maxNoProgressSteps: 2 },
  professional: { timeoutMs: 300_000, maxToolCalls: 24, maxModelIterations: 6, maxTokens: 16_384, maxCostUsd: 1, maxMemoryBytes: 1_073_741_824, maxDiskBytes: 1_073_741_824, maxNoProgressSteps: 3 },
  agent: { timeoutMs: 600_000, maxToolCalls: 48, maxModelIterations: 12, maxTokens: 32_768, maxCostUsd: 2, maxMemoryBytes: 2_147_483_648, maxDiskBytes: 2_147_483_648, maxNoProgressSteps: 4 },
};
const stepLimits: Record<PlanMode, { maxSteps: number; maxDepth: number }> = { beginner: { maxSteps: 9, maxDepth: 1 }, professional: { maxSteps: 12, maxDepth: 3 }, agent: { maxSteps: 20, maxDepth: 5 } };

function formatBytes(bytes: number): string { return bytes >= 1_073_741_824 ? `${(bytes / 1_073_741_824).toFixed(1)} GB` : `${Math.round(bytes / 1_048_576)} MB`; }

export default function Wizard() {
  const [searchParams] = useSearchParams();
  const qc = useQueryClient();
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const tools = useQuery({ queryKey: ['tools'], queryFn: api.tools });
  const requestedCategory = categories.find(category => category.id === searchParams.get('category')) ?? categories[0]!;
  const requestedMode = modes.find(mode => mode.id === searchParams.get('mode'))?.id ?? 'beginner';
  const [mode, setMode] = useState<PlanMode>(requestedMode);
  const [category, setCategory] = useState<Category>(requestedCategory);
  const [projectMode, setProjectMode] = useState<'new' | 'existing'>('new');
  const [projectName, setProjectName] = useState('');
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [file, setFile] = useState<File>();
  const [objective, setObjective] = useState(requestedCategory.objective);
  const [authorized, setAuthorized] = useState(false);
  const project = useQuery({ queryKey: ['project', selectedProjectId], queryFn: () => api.project(selectedProjectId), enabled: projectMode === 'existing' && Boolean(selectedProjectId) });
  const existingUpload = project.data?.uploads[0];
  const availableAnalyzers = category.analyzers.filter(id => tools.data?.items.find(item => item.id === id)?.available);
  const canExecute = availableAnalyzers.length > 0;
  const executionAnalyzers = canExecute ? availableAnalyzers : category.analyzers;
  const [result, setResult] = useState<{ planId: string; projectId: string; taskId?: string; executed: boolean; blockedReason?: string }>();
  const progress = useRef<{ projectId?: string; uploadId?: string; authorizationId?: string; planId?: string }>({});

  const run = useMutation({
    mutationFn: async () => {
      if (!authorized) throw new Error('请确认你拥有目标或已获得明确授权');
      if (!objective.trim()) throw new Error('请填写分析目标');
      let projectId = progress.current.projectId ?? selectedProjectId;
      let uploadId = progress.current.uploadId ?? existingUpload?.id;
      if (projectMode === 'new' && !progress.current.projectId) {
        if (!file) throw new Error('请选择要分析的文件');
        const created = await api.createProject({ name: projectName.trim() || `${category.title} ${new Date().toLocaleString('zh-CN')}`, kind: category.kind, target: '', authorizationConfirmed: true });
        projectId = created.id;
        progress.current.projectId = created.id;
      }
      if (!projectId) throw new Error(projectMode === 'new' ? '请选择要分析的文件' : '请选择现有项目');
      if (!uploadId) {
        if (!file) throw new Error('所选项目没有上传文件，请选择一个文件');
        const uploaded = await api.upload(projectId, file);
        uploadId = uploaded.id;
        progress.current.uploadId = uploaded.id;
      }
      let authorizationId = progress.current.authorizationId;
      if (!authorizationId) {
        const authorization = await api.createAuthorization(projectId, {
          target: uploadId,
          scope: ['owned-or-explicitly-authorized'],
          allowedInterfaces: executionAnalyzers,
          allowedOperations: ['read-target', 'execute-analyzer'],
          dataAccess: [category.targetKind],
          remoteAiAllowed: false,
        });
        authorizationId = authorization.id;
        progress.current.authorizationId = authorization.id;
      }
      const savedPlan = progress.current.planId ? (await api.plan(progress.current.planId)).plan : undefined;
      const createdPlan = savedPlan ?? (await api.createPlan(projectId, {
        mode,
        objective: objective.trim(),
        uploadId,
        declaredKind: category.targetKind,
        authorizationId,
        adapterAllowlist: executionAnalyzers,
        budget: budgets[mode],
        ...stepLimits[mode],
      })).plan;
      progress.current.planId = createdPlan.id;
      const executionStep = createdPlan.steps.find(step => step.kind === 'execution');
      const blockedReason = executionStep?.status === 'BLOCKED' ? executionStep.reason ?? '计划执行步骤被阻塞' : undefined;
      let taskId: string | undefined;
      if (canExecute && !blockedReason) {
        taskId = savedPlan?.taskId ?? undefined;
        if (!taskId) {
          try {
            const execution = await api.executePlan(createdPlan.id);
            taskId = execution.task.id;
          } catch (error) {
            const latest = await api.plan(createdPlan.id);
            if (latest.plan.taskId) taskId = latest.plan.taskId;
            else throw error;
          }
        }
      }
      return { planId: createdPlan.id, projectId, ...(taskId ? { taskId } : {}), executed: Boolean(taskId), ...(blockedReason ? { blockedReason } : {}) };
    },
    onSuccess: value => { setResult(value); progress.current = {}; void qc.invalidateQueries(); },
  });

  function resetRunProgress(): boolean {
    if (Object.keys(progress.current).length > 0 && !window.confirm('切换分析设置会放弃当前已创建的授权与计划进度。是否继续？')) return false;
    progress.current = {}; setResult(undefined); return true;
  }
  function selectMode(next: PlanMode): void { if (run.isPending || next === mode || !resetRunProgress()) return; setMode(next); }
  function selectCategory(next: Category): void {
    if (run.isPending || !resetRunProgress()) return;
    setCategory(next); setObjective(next.objective); setFile(undefined);
  }
  function changeProjectMode(next: 'new' | 'existing'): void {
    if (run.isPending || next === projectMode || !resetRunProgress()) return;
    setProjectMode(next); setSelectedProjectId('');
  }
  function selectProject(next: string): void { if (run.isPending || !resetRunProgress()) return; setSelectedProjectId(next); }
  function selectFile(next?: File): void { if (run.isPending || !resetRunProgress()) return; setFile(next); }

  return <>
    <PageTitle eyebrow="Guided analysis" title="开始智能分析" description="选择目标与模式，确认授权后创建可执行计划。所有步骤、预算和证据边界都会先展示给你。" action={<Link to="/demos"><Button variant="secondary"><Rocket className="h-4 w-4"/>先运行演示</Button></Link>}/>
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1.6fr)_minmax(300px,.75fr)]">
      <div className="space-y-5">
        <Card className="p-5 sm:p-6"><div className="flex items-center gap-2"><span className="grid h-6 w-6 place-items-center rounded-md border border-accent/30 bg-accent/10 font-mono text-[11px] text-accent">1</span><h2 className="text-sm font-semibold text-white">选择分析模式</h2></div><div className="mt-4 grid gap-3 md:grid-cols-3">{modes.map(item => <button key={item.id} type="button" aria-pressed={mode === item.id} onClick={() => selectMode(item.id)} className={`rounded-xl border p-4 text-left transition ${mode === item.id ? 'border-accent/60 bg-accent/[.06]' : 'border-line bg-panel2/40 hover:border-accent/40'}`}><div className="flex items-center justify-between"><item.icon className={`h-5 w-5 ${mode === item.id ? 'text-accent' : 'text-muted'}`}/>{mode === item.id && <CheckCircle2 className="h-4 w-4 text-accent"/>}</div><h3 className="mt-3 text-sm font-medium text-slate-200">{item.title}</h3><p className="mt-1 font-mono text-[10px] text-accent">{item.subtitle}</p><p className="mt-2 text-[11px] leading-5 text-muted">{item.description}</p></button>)}</div></Card>
        <Card className="p-5 sm:p-6"><div className="flex items-center gap-2"><span className="grid h-6 w-6 place-items-center rounded-md border border-accent/30 bg-accent/10 font-mono text-[11px] text-accent">2</span><h2 className="text-sm font-semibold text-white">选择目标类型</h2></div><div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{categories.map(item => <button key={item.id} type="button" aria-pressed={category.id === item.id} onClick={() => selectCategory(item)} className={`rounded-xl border p-3 text-left transition ${category.id === item.id ? 'border-accent/60 bg-accent/[.06]' : 'border-line bg-panel2/40 hover:border-accent/40'}`}><div className="flex items-center justify-between"><item.icon className={`h-4 w-4 ${category.id === item.id ? 'text-accent' : 'text-muted'}`}/>{category.id === item.id && <CheckCircle2 className="h-3.5 w-3.5 text-accent"/>}</div><h3 className="mt-3 text-xs font-medium text-slate-200">{item.title}</h3><p className="mt-1 text-[10px] leading-4 text-muted">{item.description}</p></button>)}</div></Card>
        <Card className="p-5 sm:p-6"><div className="flex items-center gap-2"><span className="grid h-6 w-6 place-items-center rounded-md border border-accent/30 bg-accent/10 font-mono text-[11px] text-accent">3</span><h2 className="text-sm font-semibold text-white">项目与输入</h2></div><div className="mt-4 flex flex-wrap gap-2"><button type="button" aria-pressed={projectMode === 'new'} onClick={() => changeProjectMode('new')} className={`min-h-10 rounded-lg border px-3 text-xs ${projectMode === 'new' ? 'border-accent bg-accent/10 text-accent' : 'border-line bg-panel2 text-slate-300'}`}>新建专用项目</button><button type="button" aria-pressed={projectMode === 'existing'} onClick={() => changeProjectMode('existing')} className={`min-h-10 rounded-lg border px-3 text-xs ${projectMode === 'existing' ? 'border-accent bg-accent/10 text-accent' : 'border-line bg-panel2 text-slate-300'}`}>使用现有项目</button></div><div className="mt-4 grid gap-4 md:grid-cols-2">{projectMode === 'new' ? <Field label="项目名称"><input className={inputClass} value={projectName} onChange={event => setProjectName(event.target.value)} placeholder={`例如：${category.title}样本`} maxLength={120}/></Field> : <Field label="现有项目"><select aria-label="现有项目" className={inputClass} value={selectedProjectId} onChange={event => selectProject(event.target.value)}><option value="">请选择项目</option>{projects.data?.map(item => <option key={item.id} value={item.id}>{item.name} · {item.kind}</option>)}</select></Field>}<Field label="分析文件" hint={existingUpload ? '执行器使用项目最早上传的文件；如需分析其他文件，请新建专用项目。' : '文件先计算 SHA-256，不会执行未知程序。'}><input aria-label="分析文件" type="file" className="block w-full text-xs text-slate-300 file:mr-3 file:min-h-10 file:rounded-lg file:border file:border-line file:bg-panel2 file:px-3 file:text-slate-200" accept={category.accept} disabled={Boolean(existingUpload)} onChange={event => selectFile(event.target.files?.[0])}/></Field></div>{project.isLoading && <p className="mt-3 flex items-center gap-2 text-xs text-muted"><Spinner/>读取项目输入…</p>}{project.isError && <div className="mt-3"><ErrorNotice error={project.error} component="项目读取" onRetry={() => void project.refetch()}/></div>}{existingUpload && <Notice tone="info">当前输入：{existingUpload.name} · {(existingUpload.size / 1024).toFixed(1)} KB · SHA-256 {existingUpload.sha256.slice(0, 16)}…</Notice>}{(project.data?.uploads.length ?? 0) > 1 && <Notice tone="warn">该项目有 {project.data?.uploads.length} 个上传文件。后端执行器使用最早上传的“{existingUpload?.name}”，本向导不会静默替换它。</Notice>}<Field label="分析目标" hint="将写入持久化计划，作为执行与报告的目标说明。"><textarea aria-label="分析目标" className={`${inputClass} min-h-24 resize-y`} value={objective} onChange={event => setObjective(event.target.value)} maxLength={2000}/></Field></Card>
        <Card className="p-5 sm:p-6"><div className="flex items-center gap-2"><span className="grid h-6 w-6 place-items-center rounded-md border border-accent/30 bg-accent/10 font-mono text-[11px] text-accent">4</span><h2 className="text-sm font-semibold text-white">授权确认</h2></div><div className="mt-4 rounded-xl border border-line bg-panel2/40 p-4 text-xs leading-6 text-slate-300"><p>将允许读取目标文件并执行 {executionAnalyzers.join(' / ')} 分析器；不允许网络访问、设备访问或远程 AI 数据发送。</p><p className="mt-2 text-muted">授权范围：自有或明确授权目标 · 数据访问：{category.targetKind} · 预算：{budgets[mode].maxToolCalls} 次工具调用 / {formatBytes(budgets[mode].maxMemoryBytes)} 内存</p></div><label className="mt-4 flex items-start gap-3 text-xs leading-5 text-slate-300"><input type="checkbox" checked={authorized} onChange={event => setAuthorized(event.target.checked)} className="mt-1 accent-[rgb(var(--accent))]"/>我确认拥有该目标或已获得明确授权，不会绕过登录、付费、DRM、反作弊或访问控制，并理解 AI 可能出错。</label>{run.isError && <div className="mt-4"><ErrorNotice error={run.error} component="创建分析计划" onRetry={() => run.mutate()} retryable={authorized}/></div>}<Button className="mt-4 w-full sm:w-auto" disabled={!authorized || run.isPending || tools.isLoading || (projectMode === 'existing' && !selectedProjectId)} onClick={() => run.mutate()}>{run.isPending ? <Spinner/> : <ArrowRight className="h-4 w-4"/>}{run.isPending ? '正在创建授权与计划…' : tools.isLoading ? '正在检测分析器…' : canExecute ? '创建并执行计划' : '创建计划（执行将被阻止）'}</Button></Card>
      </div>
      <aside className="space-y-5"><Card className="p-5"><h2 className="text-sm font-semibold text-white">本次计划摘要</h2><dl className="mt-4 space-y-3 text-xs"><div className="flex justify-between gap-3"><dt className="text-muted">模式</dt><dd className="text-slate-200">{modes.find(item => item.id === mode)?.title}</dd></div><div className="flex justify-between gap-3"><dt className="text-muted">目标</dt><dd className="text-slate-200">{category.title}</dd></div><div className="flex justify-between gap-3"><dt className="text-muted">分析器</dt><dd className="font-mono text-[11px] text-slate-300">{executionAnalyzers.join(', ')}</dd></div><div className="flex justify-between gap-3"><dt className="text-muted">最大步骤</dt><dd className="font-mono text-slate-300">{stepLimits[mode].maxSteps}</dd></div><div className="flex justify-between gap-3"><dt className="text-muted">超时</dt><dd className="font-mono text-slate-300">{budgets[mode].timeoutMs / 1000}s</dd></div><div className="flex justify-between gap-3"><dt className="text-muted">内存 / 磁盘</dt><dd className="font-mono text-slate-300">{formatBytes(budgets[mode].maxMemoryBytes)} / {formatBytes(budgets[mode].maxDiskBytes)}</dd></div></dl><div className="mt-4 border-t border-line pt-4"><Badge tone={canExecute ? 'success' : 'warn'}>{canExecute ? '分析器可用' : '缺少可用分析器'}</Badge><p className="mt-2 text-[11px] leading-5 text-muted">{canExecute ? '计划创建后将立即执行，并显示真实任务阶段。' : '仍可创建计划以记录阻塞原因；不会伪造执行结果。'}</p></div></Card><Card className="p-5"><h2 className="text-sm font-semibold text-white">安全边界</h2><ul className="mt-3 space-y-2 text-[11px] leading-5 text-muted"><li>· 只读取你确认的文件与目标</li><li>· 不执行未知程序或刷写设备</li><li>· 不绕过访问控制或反作弊</li><li>· AI 输出仅作为推断证据</li><li>· 远程 AI 默认关闭</li></ul></Card></aside>
    </div>
    {result && <div className="mt-5 space-y-5"><Card className="p-5"><div className="flex flex-wrap items-center justify-between gap-3"><div><Badge tone="success">计划已创建</Badge><h2 className="mt-3 text-sm font-semibold text-white">{result.executed ? '计划已交给 Worker 执行' : '计划已保存，执行被依赖状态阻止'}</h2><p className="mt-1 font-mono text-[10px] text-muted">plan {result.planId} · project {result.projectId}</p></div><div className="flex gap-2"><Link to={`/plans/${result.planId}`}><Button variant="secondary">查看计划</Button></Link>{result.taskId && <Link to={`/tasks/${result.taskId}`}><Button>打开任务</Button></Link>}</div></div>{!result.executed && <p className="mt-3 text-xs leading-5 text-amber-300">{result.blockedReason ?? '当前类别没有可用分析器。'}计划保留了阻塞步骤，可在“工具与依赖”中查看官方安装指引。</p>}</Card>{result.taskId && <TaskLivePanel taskId={result.taskId}/>}</div>}
  </>;
}

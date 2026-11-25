import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Binary, Check, CircuitBoard, Cpu, Download, FileUp, FlaskConical, Gamepad2, Globe2,
  Network, ShieldCheck, Smartphone, UploadCloud, Usb,
} from 'lucide-react';
import { api, errorMessage } from '../api';
import { AsyncState, Badge, Button, Card, Field, PageTitle, Spinner, inputClass } from '../components/ui';
import type { AdapterName, ProjectKind } from '@reverse/contracts';

type InputMode = 'url' | 'file' | 'local';
interface AnalysisEntry {
  id: string;
  title: string;
  description: string;
  adapter: AdapterName;
  kind: ProjectKind;
  icon: typeof Globe2;
  accept?: string;
  modes: InputMode[];
  defaultMode: InputMode;
  fileLabel: string;
  input: string;
  output: string;
  boundary: string;
}

const entries: AnalysisEntry[] = [
  {
    id: 'website', title: '网页分析', description: '采集 DOM、脚本、路由、截图与网络元数据', adapter: 'website', kind: 'website', icon: Globe2,
    modes: ['url'], defaultMode: 'url', fileLabel: '网页记录',
    input: '输入：已授权的公网 URL', output: '输出：网页快照、资源与交互证据', boundary: '边界：不绕过登录或访问控制；本地目标需单独确认',
  },
  {
    id: 'software', title: '软件分析', description: '识别格式、元数据、字符串、归档与依赖', adapter: 'file', kind: 'software', icon: Binary,
    modes: ['file'], defaultMode: 'file', fileLabel: '软件样本文件',
    input: '输入：本地二进制或归档文件', output: '输出：格式、哈希与静态元数据', boundary: '边界：不执行未知程序；默认上限 100MB',
  },
  {
    id: 'android', title: 'Android 分析', description: '检查 APK/ZIP、Manifest、DEX 与原生库', adapter: 'apk', kind: 'software', icon: Smartphone,
    modes: ['file'], defaultMode: 'file', fileLabel: 'APK 或 DEX 文件', accept: '.apk,.dex,.zip,application/vnd.android.package-archive,application/zip',
    input: '输入：APK、ZIP 或独立 DEX', output: '输出：Manifest、DEX 与组件清单', boundary: '边界：仅在可用时按需反编译，不运行上传代码',
  },
  {
    id: 'game', title: '游戏复活', description: '从合法回放记录推断协议并验证兼容服务', adapter: 'game', kind: 'game', icon: Gamepad2,
    modes: ['file'], defaultMode: 'file', fileLabel: '游戏回放记录', accept: '.json,application/json',
    input: '输入：replay-trace/v1 JSON', output: '输出：协议字段、状态转换与兼容服务', boundary: '边界：仅处理自有或明确授权的回放，不绕过反作弊',
  },
  {
    id: 'network', title: '网络协议分析', description: '离线解析 HAR、PCAP、PCAPNG 的端点与协议元数据', adapter: 'network', kind: 'protocol', icon: Network,
    modes: ['file'], defaultMode: 'file', fileLabel: '网络抓包或 HAR 文件', accept: '.har,.pcap,.pcapng,application/json,application/vnd.tcpdump.pcap',
    input: '输入：HAR、PCAP 或 PCAPNG', output: '输出：端点、协议候选与传输元数据', boundary: '边界：只做离线元数据解析，不访问抓包中的目标',
  },
  {
    id: 'security', title: '安全分析', description: '被动 HTTP 检查与静态危险模式复核', adapter: 'security', kind: 'security', icon: ShieldCheck,
    modes: ['url', 'file'], defaultMode: 'url', fileLabel: '安全分析文件',
    input: '输入：目标 URL 或本地文本/源码', output: '输出：被动检查与待复核风险候选', boundary: '边界：不进行漏洞利用、模糊测试或主动攻击',
  },
  {
    id: 'usb', title: 'USB 硬件分析', description: '离线上传 USB 记录、HID 描述符或设备快照', adapter: 'hardware', kind: 'hardware', icon: Usb,
    modes: ['file', 'local'], defaultMode: 'file', fileLabel: 'USB 记录或描述符文件', accept: '.pcap,.pcapng,.cap,.txt,.json,.bin,application/json,application/vnd.tcpdump.pcap',
    input: '输入：USB 记录、描述符或离线上传文件', output: '输出：设备、接口、端点与传输元数据', boundary: '边界：不打开设备、不抓键盘、不执行固件',
  },
  {
    id: 'firmware', title: '固件分析', description: '流式识别镜像、熵、字符串与布局元数据', adapter: 'firmware', kind: 'firmware', icon: Cpu,
    modes: ['file'], defaultMode: 'file', fileLabel: '固件镜像文件', accept: '.bin,.img,.hex,.ihex,.uf2,.elf,.zip,.fw,application/octet-stream',
    input: '输入：本地固件镜像或 HEX/UF2/ELF', output: '输出：固件身份、熵、字符串与布局', boundary: '边界：静态有界分析，不刷写、不解包、不执行目标',
  },
  {
    id: 'board', title: '开发板记录分析', description: '离线解析开发板 USB、HID 与设备枚举记录', adapter: 'hardware', kind: 'hardware', icon: CircuitBoard,
    modes: ['file', 'local'], defaultMode: 'file', fileLabel: '开发板离线记录', accept: '.pcap,.pcapng,.cap,.txt,.json,.bin,application/json,application/vnd.tcpdump.pcap',
    input: '输入：开发板 USB/HID 记录或枚举快照', output: '输出：开发板设备、接口与离线记录元数据', boundary: '边界：不打开设备或串口、不抓键盘、不刷写固件；不宣称特定开发板兼容性',
  },
];

function fileHint(entry: AnalysisEntry): string {
  if (entry.id === 'usb') return '支持 PCAP、PCAPNG、usbmon、HID 描述符和枚举快照；默认最多读取 16MB。';
  if (entry.id === 'board') return '支持 USB PCAP/PCAPNG、usbmon、HID 描述符和枚举快照；串口仅只读列出，不打开；默认最多读取 16MB。';
  if (entry.id === 'firmware') return '支持 BIN、IMG、HEX、UF2、ELF 与 ZIP；只读取中央目录，不释放归档内容。';
  if (entry.id === 'network') return '支持 HAR、PCAP、PCAPNG；仅离线解析元数据。';
  if (entry.id === 'android') return '支持 APK、ZIP 或独立 DEX；不会执行上传的代码。';
  if (entry.adapter === 'ghidra') return '需要 Ghidra headless；外部工具不可用时会显示真实原因。';
  if (entry.id === 'game') return '上传 replay-trace/v1 JSON；可下载演示记录验证完整流程。';
  return '默认最大 100MB；文件内容会先计算 SHA-256，不会执行未知程序。';
}

export default function NewProject() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const qc = useQueryClient();
  const adapters = useQuery({ queryKey: ['adapters'], queryFn: api.adapters });
  const requestedEntry = entries.find(item => item.id === searchParams.get('type')) ?? entries[0]!;
  const [selectedId, setSelectedId] = useState(requestedEntry.id);
  const [softwareAdapter, setSoftwareAdapter] = useState<'file' | 'ghidra'>('file');
  const [mode, setMode] = useState<InputMode>(requestedEntry.defaultMode);
  const [name, setName] = useState('');
  const [target, setTarget] = useState('');
  const [file, setFile] = useState<File>();
  const [authorized, setAuthorized] = useState(false);
  const [allowLocal, setAllowLocal] = useState(false);
  const [demoLoading, setDemoLoading] = useState(false);
  const [error, setError] = useState('');
  const selectedEntry = entries.find(item => item.id === selectedId) ?? entries[0]!;
  const entry: AnalysisEntry = selectedId === 'software' && softwareAdapter === 'ghidra' ? {
    ...selectedEntry, adapter: 'ghidra', title: '软件分析 · Ghidra', fileLabel: 'Ghidra 二进制文件', accept: '.exe,.dll,.so,.elf,.bin,.o,.class,.wasm,.apk',
    input: '输入：Ghidra 可导入的二进制', output: '输出：静态元数据与有界反编译文本', boundary: '边界：需要本机 Ghidra headless；不运行目标程序',
  } : selectedEntry;
  const capability = adapters.data?.find(adapter => adapter.name === entry.adapter);
  const capabilityReady = adapters.isSuccess && Boolean(capability);
  const unavailableReason = adapters.isError ? errorMessage(adapters.error) : !capability ? '后端未返回此适配器能力，无法创建任务。' : capability.available ? '' : capability.detail || '适配器当前不可用。';
  const canCreate = capabilityReady && capability?.available && mode !== 'local';

  function selectEntry(next: AnalysisEntry): void {
    setSelectedId(next.id);
    setSoftwareAdapter('file');
    setMode(next.defaultMode);
    setFile(undefined);
    setError('');
  }

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!authorized) throw new Error('请确认你拥有目标或已获得明确授权');
      if (mode === 'file' && !file) throw new Error('请选择要分析的文件');
      if (mode === 'url' && !target.trim()) throw new Error('请输入目标 URL');
      if (!capabilityReady || !capability?.available) throw new Error(unavailableReason || '适配器不可用，未创建项目或任务');
      const project = await api.createProject({
        name: name.trim() || `${entry.title} ${new Date().toLocaleString('zh-CN')}`,
        kind: entry.kind,
        target: mode === 'url' ? target.trim() : '',
        authorizationConfirmed: true,
      });
      if (file) await api.upload(project.id, file);
      const options = mode === 'url' && allowLocal ? { allowLocal: true, confirmLocal: true } : {};
      return api.createTask(project.id, entry.adapter, options);
    },
    onSuccess: async task => {
      await qc.invalidateQueries();
      navigate(`/tasks/${task.id}`);
    },
    onError: cause => setError(errorMessage(cause)),
  });

  return <>
    <PageTitle eyebrow="New investigation" title="创建逆向项目" description="九类分析共享同一套授权、输入哈希、阶段计划与证据档案。先选择输入模式，再创建真实任务。"/>
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1.65fr)_minmax(280px,1fr)]">
      <Card className="p-5 sm:p-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-white">1. 选择分析类型</h2>
          {adapters.isLoading ? <span className="flex items-center gap-2 text-xs text-muted"><Spinner/>检测适配器…</span> : adapters.isError ? <Badge tone="danger">能力检测失败</Badge> : <Badge tone="info">已读取真实适配器状态</Badge>}
        </div>
        <AsyncState loading={adapters.isLoading} error={adapters.isError} onRetry={() => void adapters.refetch()}>
          <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">{entries.map(item => {
            const adapter = adapters.data?.find(value => value.name === item.adapter);
            const available = adapter?.available === true;
            return <button key={item.id} type="button" aria-pressed={selectedId === item.id} onClick={() => selectEntry(item)} className={`min-w-0 rounded-xl border p-4 text-left transition ${selectedId === item.id ? 'border-accent/60 bg-accent/[.06] shadow-glow' : 'border-line bg-panel2/50 hover:border-slate-600'}`}>
              <div className="flex items-center justify-between gap-2"><item.icon className={`h-5 w-5 ${selectedId === item.id ? 'text-accent' : 'text-muted'}`}/>{selectedId === item.id ? <Check className="h-4 w-4 text-accent"/> : <Badge tone={available ? 'success' : 'warn'}>{available ? '可用' : '不可用'}</Badge>}</div>
              <h3 className="mt-4 text-sm font-medium text-white">{item.title}</h3>
              <p className="mt-1.5 text-xs leading-5 text-muted">{item.description}</p>
              <dl className="mt-3 space-y-1 text-[11px] leading-5 text-slate-400"><div>{item.input}</div><div>{item.output}</div><div className="text-muted">{item.boundary}</div></dl>
              {!available && <p className="mt-2 break-words text-[11px] leading-5 text-amber-300">{adapter?.detail || '适配器能力尚未返回'}</p>}
              <div className="mt-3 font-mono text-[10px] text-muted">{item.adapter}{adapter?.version ? ` · ${adapter.version}` : ''}</div>
            </button>;
          })}</div>
        </AsyncState>
        <div className="my-6 h-px bg-line"/>
        {unavailableReason && <div role="alert" className="mb-5 rounded-lg border border-amber-400/20 bg-amber-400/5 p-3 text-xs leading-5 text-amber-200">{entry.title}不可用：{unavailableReason}。不会创建假任务。</div>}
        <div className="space-y-5">
          {selectedId === 'software' && <fieldset><legend className="mb-2 text-sm font-medium text-slate-300">软件高级适配器（可选）</legend><div className="grid gap-2 sm:grid-cols-2"><label className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-xs leading-5 ${softwareAdapter === 'file' ? 'border-accent bg-accent/10 text-accent' : 'border-line bg-panel2 text-slate-300'}`}><input type="radio" name="software-adapter" value="file" checked={softwareAdapter === 'file'} onChange={() => { setSoftwareAdapter('file'); setFile(undefined); setError(''); }} className="mt-1 accent-[rgb(var(--accent))]"/><span><b className="block font-medium">基础静态分析 · file</b><span className="text-muted">格式、字符串、归档与依赖元数据</span></span></label><label className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-xs leading-5 ${softwareAdapter === 'ghidra' ? 'border-accent bg-accent/10 text-accent' : 'border-line bg-panel2 text-slate-300'}`}><input type="radio" name="software-adapter" value="ghidra" checked={softwareAdapter === 'ghidra'} onChange={() => { setSoftwareAdapter('ghidra'); setFile(undefined); setError(''); }} className="mt-1 accent-[rgb(var(--accent))]"/><span><b className="block font-medium">Ghidra 静态分析 · ghidra</b><span className="text-muted">需要本机 headless；不可用时不创建假任务</span></span></label></div></fieldset>}
          <Field label="项目名称"><input className={inputClass} value={name} onChange={event => setName(event.target.value)} placeholder={`例如：${entry.title}样本`} maxLength={120}/></Field>
          <fieldset><legend className="mb-2 text-sm font-medium text-slate-300">2. 输入模式</legend><div className="flex flex-wrap gap-2">{entry.modes.map(value => <label key={value} className={`flex min-h-10 cursor-pointer items-center gap-2 rounded-lg border px-3 text-xs ${mode === value ? 'border-accent bg-accent/10 text-accent' : 'border-line bg-panel2 text-slate-300'}`}><input type="radio" name="input-mode" value={value} checked={mode === value} onChange={() => { setMode(value); setFile(undefined); setError(''); }} className="accent-[rgb(var(--accent))]"/>{value === 'url' ? '目标 URL' : value === 'file' ? '离线上传文件' : '本地设备列表'}</label>)}</div></fieldset>
          {mode === 'url' && <Field label="目标 URL" hint="默认拒绝本地、内网、云元数据地址及公网非标准端口。"><input className={inputClass} value={target} onChange={event => setTarget(event.target.value)} placeholder="https://example.com" inputMode="url"/></Field>}
          {mode === 'file' && <Field label={entry.fileLabel} hint={fileHint(entry)}>
            <label className="flex cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed border-line bg-panel2 px-5 py-9 text-center transition hover:border-accent/50">
              <UploadCloud className="mb-3 h-7 w-7 text-muted"/><span className="text-sm text-slate-200">{file ? file.name : '点击选择文件'}</span><span className="mt-1 text-xs text-muted">{file ? `${(file.size / 1024).toFixed(1)} KB · 上传后计算 SHA-256` : entry.input}</span>
              <input aria-label={entry.fileLabel} type="file" className="hidden" accept={entry.accept} onChange={event => { setFile(event.target.files?.[0]); setError(''); }}/>
            </label>
          </Field>}
          {mode === 'local' && <div className="rounded-xl border border-line bg-panel2 p-4"><p className="text-sm leading-6 text-slate-300">本地设备列表由硬件实验室直接从本机 API 读取，不在创建页缓存或伪造设备数据。</p><Button variant="secondary" className="mt-3" onClick={() => navigate('/hardware')}><Usb className="h-4 w-4"/>浏览本地设备</Button></div>}
          {mode === 'url' && (entry.kind === 'website' || entry.kind === 'security') && <label className="flex items-start gap-3 rounded-lg border border-line bg-panel2/40 p-3 text-xs leading-5 text-slate-300"><input type="checkbox" checked={allowLocal} onChange={event => setAllowLocal(event.target.checked)} className="mt-1 accent-[rgb(var(--accent))]"/><span>允许本地演示目标（仅 127.0.0.1 / localhost）。勾选后仍需本次授权确认；公网目标不要开启。</span></label>}
          <label className="flex items-start gap-3 rounded-lg border border-amber-400/20 bg-amber-400/[.04] p-3 text-xs leading-5 text-slate-300"><input type="checkbox" checked={authorized} onChange={event => setAuthorized(event.target.checked)} className="mt-1 accent-[rgb(var(--accent))]"/><span>我确认拥有该目标，或已获得明确的分析授权；不会绕过登录、验证码、付费、DRM、反作弊或访问控制。</span></label>
          {error && <div role="alert" className="rounded-lg border border-red-400/20 bg-red-400/5 p-3 text-xs leading-5 text-red-300">{error}</div>}
          <Button onClick={() => createMutation.mutate()} disabled={!canCreate || createMutation.isPending} className="w-full sm:w-auto">{createMutation.isPending ? <Spinner/> : <FileUp className="h-4 w-4"/>}{createMutation.isPending ? '正在创建…' : '创建项目并开始分析'}</Button>
        </div>
      </Card>
      <aside className="space-y-5">
        <Card className="p-5"><Badge tone="info">执行边界</Badge><h2 className="mt-4 text-sm font-semibold text-white">本次将执行</h2><ul className="mt-3 space-y-2 text-xs leading-5 text-muted"><li>· 输入识别与 SHA-256 身份校验</li><li>· 授权检查和持久化阶段计划</li><li>· {entry.description}</li><li>· 验证、报告与产物导出</li></ul><div className="mt-4 border-t border-line pt-4 text-[11px] leading-5 text-muted">{entry.output}。{entry.boundary}。未配置 AI 时仍执行规则型分析。</div></Card>
        {entry.adapter === 'game' && <Card className="p-5"><FlaskConical className="h-5 w-5 text-accent"/><h2 className="mt-3 text-sm font-semibold text-white">没有回放记录？</h2><p className="mt-2 text-xs leading-5 text-muted">下载项目自编写迷你游戏的真实通信记录，验证协议到兼容服务的闭环。</p><Button variant="secondary" className="mt-4 w-full" disabled={demoLoading} onClick={async () => { setDemoLoading(true); try { setFile(await api.demoTrace()); setMode('file'); setError(''); } catch (cause) { setError(errorMessage(cause)); } finally { setDemoLoading(false); } }}>{demoLoading ? <Spinner/> : <Download className="h-3.5 w-3.5"/>}{demoLoading ? '正在下载…' : '下载演示回放记录'}</Button></Card>}
        {entry.adapter === 'hardware' && <Card className="p-5"><Usb className="h-5 w-5 text-accent"/><h2 className="mt-3 text-sm font-semibold text-white">先查看本机设备？</h2><p className="mt-2 text-xs leading-5 text-muted">硬件实验室展示真实 USB 拓扑、描述符树与串口列表，所有设备操作保持只读。</p><Button variant="secondary" className="mt-4 w-full" onClick={() => navigate('/hardware')}>浏览本地设备</Button></Card>}
        <Card className="p-5"><h2 className="text-sm font-semibold text-white">资源预算</h2><div className="mt-3 grid grid-cols-2 gap-3 text-xs"><div className="rounded-lg bg-panel2 p-3"><div className="text-muted">任务并发</div><div className="mt-1 font-mono text-white">1</div></div><div className="rounded-lg bg-panel2 p-3"><div className="text-muted">默认超时</div><div className="mt-1 font-mono text-white">300s</div></div></div></Card>
      </aside>
    </div>
  </>;
}

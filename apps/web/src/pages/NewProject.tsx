import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Binary, Check, Download, FileUp, FlaskConical, Globe2, Network, ShieldCheck, Smartphone, UploadCloud } from 'lucide-react';
import { api, errorMessage } from '../api';
import { AsyncState, Badge, Button, Card, Field, PageTitle, Spinner, inputClass } from '../components/ui';
import type { AdapterName, ProjectKind } from '@reverse/contracts';

const kinds = [
  { kind: 'website' as const, title: '逆向网页', desc: '采集 DOM、脚本、路由、截图与网络元数据', icon: Globe2, adapter: 'website' as AdapterName, accept: undefined },
  { kind: 'software' as const, title: '逆向软件', desc: '识别格式、元数据、字符串、归档与依赖', icon: Binary, adapter: 'file' as AdapterName, accept: undefined },
  { kind: 'game' as const, title: '复活游戏', desc: '从合法回放记录推断协议并验证兼容服务', icon: FlaskConical, adapter: 'game' as AdapterName, accept: '.json,application/json' },
  { kind: 'security' as const, title: '安全分析', desc: '被动 HTTP 检查与静态危险模式复核', icon: ShieldCheck, adapter: 'security' as AdapterName, accept: undefined },
  { kind: 'protocol' as const, title: '网络流量分析', desc: '离线解析 HAR、PCAP、PCAPNG 的端点与协议元数据', icon: Network, adapter: 'network' as AdapterName, accept: '.har,.pcap,.pcapng,application/json,application/vnd.tcpdump.pcap' },
  { kind: 'software' as const, title: 'APK / DEX 分析', desc: '安全检查 APK/ZIP、Manifest、DEX 与原生库哈希', icon: Smartphone, adapter: 'apk' as AdapterName, accept: '.apk,.dex,.zip,application/vnd.android.package-archive,application/zip' },
  { kind: 'software' as const, title: 'Ghidra 静态分析', desc: '通过 Ghidra headless 导入并导出有界静态元数据', icon: Binary, adapter: 'ghidra' as AdapterName, accept: '.exe,.dll,.so,.elf,.bin,.o,.class,.wasm,.apk' },
  { kind: 'protocol' as const, title: '协议逆向', desc: '从 replay-trace/v1 提取消息字段、状态转换与未知项', icon: Network, adapter: 'game' as AdapterName, accept: '.json,application/json' },
];

function fileHint(adapter: AdapterName): string {
  if (adapter === 'network') return '支持 .har、.pcap、.pcapng；仅离线解析元数据，不访问抓包中的目标。';
  if (adapter === 'apk') return '支持 APK、ZIP 或独立 DEX；不会执行上传的代码。';
  if (adapter === 'ghidra') return '支持 Ghidra 可导入的二进制文件；仅在适配器可用时创建任务。';
  if (adapter === 'game') return '上传 replay-trace/v1 JSON；可下载演示记录验证完整流程。';
  return '默认最大 100MB；不会执行上传的未知程序。';
}

export default function NewProject() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const adapters = useQuery({ queryKey: ['adapters'], queryFn: api.adapters });
  const [selected, setSelected] = useState(0);
  const [name, setName] = useState('');
  const [target, setTarget] = useState('');
  const [file, setFile] = useState<File>();
  const [authorized, setAuthorized] = useState(false);
  const [allowLocal, setAllowLocal] = useState(false);
  const [demoLoading, setDemoLoading] = useState(false);
  const [error, setError] = useState('');
  const item = kinds[selected]!;
  const capability = adapters.data?.find(adapter => adapter.name === item.adapter);
  const capabilityReady = adapters.isSuccess && Boolean(capability);
  const unavailableReason = adapters.isError ? errorMessage(adapters.error) : !capability ? '后端未返回此适配器能力，无法创建任务。' : capability.available ? '' : capability.detail || '适配器当前不可用。';
  const canCreate = capabilityReady && capability?.available;
  const needsFile = item.kind !== 'website';

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!authorized) throw new Error('请确认你拥有目标或已获得明确授权');
      if (needsFile && !file) throw new Error('请选择要分析的文件');
      if (!needsFile && !target.trim()) throw new Error('请输入目标 URL');
      if (!capabilityReady || !capability?.available) throw new Error(unavailableReason || '适配器不可用，未创建项目或任务');
      const project = await api.createProject({ name: name.trim() || `${item.title} ${new Date().toLocaleString('zh-CN')}`, kind: item.kind as ProjectKind, target: needsFile ? '' : target.trim(), authorizationConfirmed: true });
      if (file) await api.upload(project.id, file);
      const options = item.adapter === 'website' && allowLocal ? { allowLocal: true, confirmLocal: true } : {};
      return api.createTask(project.id, item.adapter, options);
    },
    onSuccess: async task => { await qc.invalidateQueries(); navigate(`/tasks/${task.id}`); },
    onError: e => setError(errorMessage(e)),
  });

  return <>
    <PageTitle eyebrow="New investigation" title="创建逆向项目" description="目标只在本机处理。授权确认、文件哈希、执行预算和证据来源会写入任务档案。"/>
    <div className="grid gap-5 lg:grid-cols-[1.5fr_1fr]">
      <Card className="p-5 sm:p-6">
        <div className="mb-3 flex items-center justify-between gap-3"><h2 className="text-sm font-semibold text-white">分析类型</h2>{adapters.isLoading ? <span className="flex items-center gap-2 text-xs text-muted"><Spinner/>检测适配器…</span> : adapters.isError ? <Badge tone="danger">能力检测失败</Badge> : <Badge tone="info">已读取真实适配器状态</Badge>}</div>
        <AsyncState loading={adapters.isLoading} error={adapters.isError} onRetry={() => void adapters.refetch()}>
          <div className="grid gap-3 sm:grid-cols-2">{kinds.map((kind, index) => {
            const adapter = adapters.data?.find(value => value.name === kind.adapter);
            const available = adapter?.available === true;
            return <button key={`${kind.kind}-${kind.adapter}`} onClick={() => { setSelected(index); setFile(undefined); setError(''); }} className={`rounded-xl border p-4 text-left transition ${selected === index ? 'border-accent/60 bg-accent/[.06] shadow-glow' : 'border-line bg-panel2/50 hover:border-slate-600'}`}>
              <div className="flex items-center justify-between"><kind.icon className={`h-5 w-5 ${selected === index ? 'text-accent' : 'text-muted'}`}/>{selected === index && <Check className="h-4 w-4 text-accent"/>}</div>
              <div className="mt-4 flex flex-wrap items-center gap-2 text-sm font-medium text-white">{kind.title}<Badge tone={available ? 'success' : 'warn'}>{available ? '可用' : '不可用'}</Badge></div>
              <p className="mt-1.5 text-xs leading-5 text-muted">{kind.desc}</p>
              {!available && <p className="mt-2 break-words text-[11px] leading-5 text-amber-300">{adapter?.detail || '适配器能力尚未返回'}</p>}
              <p className="mt-2 font-mono text-[10px] text-slate-600">{kind.adapter} {adapter?.version ?? ''}</p>
            </button>;
          })}</div>
        </AsyncState>
        <div className="my-6 h-px bg-line"/>
        {unavailableReason && <div className="mb-5 rounded-lg border border-amber-400/20 bg-amber-400/5 p-3 text-xs leading-5 text-amber-200">{item.title}不可用：{unavailableReason}。未安装或配置不完整时不会创建假任务。</div>}
        <div className="space-y-5">
          <Field label="项目名称"><input className={inputClass} value={name} onChange={event => setName(event.target.value)} placeholder={`例如：${item.title}样本`} maxLength={120}/></Field>
          {needsFile ? <Field label="分析文件" hint={fileHint(item.adapter)}>
            <label className="flex cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed border-line bg-[#0a121b] px-5 py-9 text-center transition hover:border-accent/50">
              <UploadCloud className="mb-3 h-7 w-7 text-muted"/><span className="text-sm text-slate-200">{file ? file.name : '点击选择或拖入文件'}</span><span className="mt-1 text-xs text-muted">{file ? `${(file.size / 1024).toFixed(1)} KB` : '文件内容将先计算 SHA-256'}</span>
              <input type="file" className="hidden" accept={item.accept} onChange={event => { setFile(event.target.files?.[0]); setError(''); }}/>
            </label>
          </Field> : <Field label="目标 URL" hint="默认拒绝本地、内网、云元数据地址及公网非标准端口。"><input className={inputClass} value={target} onChange={event => setTarget(event.target.value)} placeholder="https://example.com"/></Field>}
          {item.kind === 'website' && <label className="flex items-start gap-3 rounded-lg border border-line bg-panel2/40 p-3 text-xs leading-5 text-slate-300"><input type="checkbox" checked={allowLocal} onChange={event => setAllowLocal(event.target.checked)} className="mt-1 accent-[#40d9bb]"/><span>允许本地演示目标（仅 127.0.0.1 / localhost）。勾选后还需再次确认授权；公网目标不要开启。</span></label>}
          <label className="flex items-start gap-3 rounded-lg border border-amber-400/20 bg-amber-400/[.04] p-3 text-xs leading-5 text-slate-300"><input type="checkbox" checked={authorized} onChange={event => setAuthorized(event.target.checked)} className="mt-1 accent-[#40d9bb]"/><span>我确认拥有该目标，或已获得明确的分析授权；不会绕过登录、验证码、付费、DRM、反作弊或访问控制。</span></label>
          {error && <div role="alert" className="rounded-lg border border-red-400/20 bg-red-400/5 p-3 text-xs text-red-300">{error}</div>}
          <Button onClick={() => createMutation.mutate()} disabled={!canCreate} className="w-full sm:w-auto">{createMutation.isPending ? <Spinner/> : <FileUp className="h-4 w-4"/>}创建项目并开始分析</Button>
        </div>
      </Card>
      <div className="space-y-5">
        <Card className="p-5"><Badge tone="info">执行边界</Badge><h2 className="mt-4 text-sm font-semibold text-white">本次将执行</h2><ul className="mt-3 space-y-2 text-xs leading-5 text-muted"><li>· 输入识别与 SHA-256 身份校验</li><li>· 授权检查和持久化阶段计划</li><li>· {item.desc}</li><li>· 验证、报告与产物导出</li></ul><div className="mt-4 border-t border-line pt-4 text-[11px] leading-5 text-muted">未配置 AI 时执行规则型分析；模型文本永远不会替代工具证据。</div></Card>
        {(item.adapter === 'game') && <Card className="p-5"><FlaskConical className="h-5 w-5 text-accent"/><h2 className="mt-3 text-sm font-semibold text-white">没有回放记录？</h2><p className="mt-2 text-xs leading-5 text-muted">下载本项目自编写迷你游戏的真实通信记录，验证从协议样本到可启动兼容服务的闭环。</p><Button variant="secondary" className="mt-4 w-full" disabled={demoLoading} onClick={async () => { setDemoLoading(true); try { setFile(await api.demoTrace()); setError(''); } catch (e) { setError(errorMessage(e)); } finally { setDemoLoading(false); } }}>{demoLoading?<Spinner/>:<Download className="h-3.5 w-3.5"/>}{demoLoading?'正在下载…':'下载演示回放记录'}</Button></Card>}
        <Card className="p-5"><h2 className="text-sm font-semibold text-white">资源预算</h2><div className="mt-3 grid grid-cols-2 gap-3 text-xs"><div className="rounded-lg bg-panel2 p-3"><div className="text-muted">任务并发</div><div className="mt-1 font-mono text-white">1</div></div><div className="rounded-lg bg-panel2 p-3"><div className="text-muted">默认超时</div><div className="mt-1 font-mono text-white">300s</div></div></div></Card>
      </div>
    </div>
  </>;
}

import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, ArrowUpRight, CheckCircle2, Cpu, ExternalLink, FilePlus2, Save, Search, ShieldCheck, Usb, X } from 'lucide-react';
import { api, errorCode, type ActualAccess, type ConsoleDevice, type ConsoleEvidence, type ConsoleEvidenceKind, type ConsoleLevel, type ConsoleProfile, type UsbEnumerationSummary } from '../api';
import { AsyncState, Badge, Button, Card, Empty, ErrorNotice, Field, KindBadge, Notice, PageTitle, Spinner, inputClass } from '../components/ui';

const levelCards: { level: ConsoleLevel; name: string; requirement: string }[] = [
  { level: 'C0', name: '已建立主机档案', requirement: '字段完整，来源与未知项明确' },
  { level: 'C1', name: '已记录设备身份', requirement: '身份记录 + 官方资料；用户记录不代表设备已验证' },
  { level: 'C2', name: '合法可用设备接口', requirement: '后端验证的授权接口观察 + 合法访问' },
  { level: 'C3', name: '公开固件或自有应用静态分析', requirement: '合法样本 + SHA-256 + 方法' },
  { level: 'C4', name: '授权开发环境实测', requirement: '官方获批环境中的测试证据' },
  { level: 'C5', name: '自有实验设备独立兼容实现', requirement: '可重复、可独立复核的兼容实现' },
];
const supportLabels: Record<string, string> = { OFFICIAL_PROGRAM: '官方计划', DOCUMENTED_STANDARD_INTERFACE: '文档化标准接口', OEM_DEPENDENT: '依赖 OEM', NOT_ESTABLISHED: '尚未建立' };
const evidenceKinds: { value: ConsoleEvidenceKind; label: string }[] = [
  { value: 'IDENTITY', label: '设备身份记录' }, { value: 'OFFICIAL_DOCUMENT', label: '官方资料' },
  { value: 'READ_ONLY_ENUMERATION', label: '只读枚举' }, { value: 'AUTHORIZED_INTERFACE_OBSERVATION', label: '授权接口观察' },
  { value: 'FIRMWARE_SAMPLE', label: '固件样本' }, { value: 'AUTHORIZED_DEV_TEST', label: '授权开发测试' },
  { value: 'CONTROLLED_REPRODUCTION', label: '受控复现' },
];
const accessLabels: Record<ActualAccess, string> = { NONE: '无设备访问', READ_ONLY: '只读访问', AUTHORIZED_DEV_INTERFACE: '授权开发接口' };
const profileTextFields = [
  ['userProvidedInfo', '用户提供的信息'], ['officialInterfaces', '官方接口'], ['authorizedDevEnvironments', '授权开发环境'],
  ['firmwareSamples', '固件样本（含来源与 SHA-256）'], ['knownCapabilities', '已知能力'], ['limitations', '限制与未知项'],
] as const;

function lines(value: string[]): string { return value.join('\n'); }
function parseLines(value: string): string[] { return value.split('\n').map(item => item.trim()).filter(Boolean); }
function emptyProfile(device?: ConsoleDevice): ConsoleProfile {
  return { manufacturer: device?.manufacturer ?? '', series: device?.series ?? '', model: device?.model ?? '', hardwareVersion: '', systemVersion: '', userProvidedInfo: [], officialInterfaces: device?.capabilities ?? [], authorizedDevEnvironments: [], firmwareSamples: [], knownCapabilities: device?.capabilities ?? [], actualAccess: 'NONE', researchEvidence: [], currentLevel: 'C0', limitations: device?.limitations ?? [] };
}

export default function ConsoleLab() {
  const { projectId: routeProjectId } = useParams();
  const [searchParams] = useSearchParams();
  const qc = useQueryClient();
  const devices = useQuery({ queryKey: ['console-devices'], queryFn: api.consoleDevices });
  const support = useQuery({ queryKey: ['console-support'], queryFn: api.consoleSupport });
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const [selectedDeviceId, setSelectedDeviceId] = useState('');
  const [deviceSearch, setDeviceSearch] = useState('');
  const [projectId, setProjectId] = useState(routeProjectId ?? searchParams.get('projectId') ?? '');
  const [profileForm, setProfileForm] = useState<ConsoleProfile>(() => emptyProfile());
  const [profileDirty, setProfileDirty] = useState(false);
  const [loadedFormKey, setLoadedFormKey] = useState('');
  const [profileMessage, setProfileMessage] = useState('');
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectAuthorized, setNewProjectAuthorized] = useState(false);
  const [usb, setUsb] = useState<UsbEnumerationSummary>({ osRecognized: false, descriptorReadable: false, normalInterfaceAvailable: false, connectorForm: 'UNKNOWN', peerType: 'UNKNOWN', developerModeAuthorized: false, cableCondition: 'UNKNOWN' });

  const selectedDevice = devices.data?.items.find(device => device.id === selectedDeviceId) ?? devices.data?.items[0];
  const deviceDetail = useQuery({ queryKey: ['console-device', selectedDevice?.id], queryFn: () => api.consoleDevice(selectedDevice!.id), enabled: Boolean(selectedDevice) });
  const consoleProjects = projects.data?.filter(project => project.kind === 'console') ?? [];
  const profile = useQuery({
    queryKey: ['console-profile', projectId],
    queryFn: async () => { try { return await api.consoleProfile(projectId); } catch (error) { if (errorCode(error) === 'NOT_FOUND') return null; throw error; } },
    enabled: Boolean(projectId),
    staleTime: 0,
  });

  const formKey = `${projectId}:${selectedDevice?.id ?? ''}:${profile.dataUpdatedAt}`;
  useEffect(() => {
    if (profileDirty || loadedFormKey === formKey || profile.isLoading) return;
    if (profile.data) setProfileForm(profile.data.profile);
    else if (selectedDevice) setProfileForm(emptyProfile(selectedDevice));
    setLoadedFormKey(formKey);
  }, [formKey, loadedFormKey, profile.data, profile.isLoading, profileDirty, selectedDevice]);
  useEffect(() => {
    if (routeProjectId && routeProjectId !== projectId) {
      if (profileDirty) setProfileMessage('当前档案有未保存修改；请先保存或放弃修改后再切换项目。');
      else setProjectId(routeProjectId);
    }
  }, [routeProjectId, projectId, profileDirty]);
  useEffect(() => {
    if (!profileDirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    const interceptNavigation = (event: MouseEvent) => {
      const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!anchor || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if (!window.confirm('当前主机档案有未保存修改。是否放弃修改并离开？')) { event.preventDefault(); event.stopPropagation(); }
    };
    window.addEventListener('beforeunload', beforeUnload);
    document.addEventListener('click', interceptNavigation, true);
    return () => { window.removeEventListener('beforeunload', beforeUnload); document.removeEventListener('click', interceptNavigation, true); };
  }, [profileDirty]);

  function editProfile(next: ConsoleProfile): void { setProfileForm(next); setProfileDirty(true); }
  function confirmDiscard(): boolean { return !profileDirty || window.confirm('当前主机档案有未保存修改。是否放弃修改并继续切换？'); }
  function selectProject(next: string): void {
    if (!confirmDiscard()) return;
    setProfileDirty(false); setLoadedFormKey(''); setProjectId(next); setProfileMessage('');
  }
  function selectDevice(next: string): void {
    if (!confirmDiscard()) return;
    setProfileDirty(false); setLoadedFormKey(''); setSelectedDeviceId(next);
  }

  const filteredDevices = useMemo(() => (devices.data?.items ?? []).filter(device => `${device.manufacturer} ${device.series} ${device.model}`.toLowerCase().includes(deviceSearch.toLowerCase())), [devices.data, deviceSearch]);
  const savedLevel = profile.data?.profile.currentLevel ?? 'C0';
  const activeLevelIndex = levelCards.findIndex(card => card.level === savedLevel);

  const diagnose = useMutation({ mutationFn: () => api.diagnoseConsoleUsb(usb) });
  const saveProfile = useMutation({
    mutationFn: () => api.saveConsoleProfile(projectId, profileForm),
    onSuccess: result => { setProfileForm(result.profile); setProfileDirty(false); setProfileMessage(`档案已保存；后端根据证据计算等级为 ${result.profile.currentLevel}。`); void qc.invalidateQueries({ queryKey: ['console-profile', projectId] }); },
    onError: error => setProfileMessage(error instanceof Error ? error.message : String(error)),
  });
  const createProject = useMutation({
    mutationFn: () => {
      if (!newProjectAuthorized) throw new Error('请确认拥有该设备或已获得明确研究授权');
      if (!newProjectName.trim()) throw new Error('请输入主机研究项目名称');
      return api.createProject({ name: newProjectName.trim(), kind: 'console', target: '', authorizationConfirmed: true });
    },
    onSuccess: project => { setProjectId(project.id); setNewProjectName(''); setNewProjectAuthorized(false); void qc.invalidateQueries({ queryKey: ['projects'] }); },
  });

  function updateEvidence(id: string, patch: Partial<ConsoleEvidence>): void {
    setProfileForm(previous => ({ ...previous, researchEvidence: previous.researchEvidence.map(item => {
      if (item.id !== id) return item;
      const next = { ...item, ...patch };
      if (next.sha256 === '') delete next.sha256;
      if (next.method === '') delete next.method;
      return next;
    }) }));
  }
  function addEvidence(): void {
    setProfileForm(previous => ({ ...previous, researchEvidence: [...previous.researchEvidence, { id: crypto.randomUUID(), kind: 'OFFICIAL_DOCUMENT', source: '', observedAt: new Date().toISOString(), description: '' }] }));
  }
  const usbBooleanFields: { key: 'osRecognized' | 'descriptorReadable' | 'normalInterfaceAvailable' | 'developerModeAuthorized'; label: string }[] = [
    { key: 'osRecognized', label: '操作系统已识别设备' }, { key: 'descriptorReadable', label: '描述符可读' },
    { key: 'normalInterfaceAvailable', label: '存在普通接口' }, { key: 'developerModeAuthorized', label: '开发者模式已授权' },
  ];

  return <>
    <PageTitle eyebrow="Console research lab" title="游戏主机分析" description="从公开资料、只读枚举和合法样本建立可复核档案。C0–C5 是证据等级，不是权限或可破解程度。" action={<Link to="/wizard"><Button><Activity className="h-4 w-4"/>开始智能分析</Button></Link>}/>
    <Notice tone="warn"><strong>设备边界：</strong>本页不会打开设备、串口或执行固件。USB-C 外形与枚举成功不能证明调试接口；普通零售主机不支持主机对主机连接。</Notice>
    <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(280px,.75fr)_minmax(0,1.6fr)]">
      <Card className="overflow-hidden">
        <div className="border-b border-line p-4"><h2 className="text-sm font-semibold text-white">设备目录</h2><div className="relative mt-3"><Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted"/><input aria-label="搜索主机" className={`${inputClass} pl-9`} value={deviceSearch} onChange={event => setDeviceSearch(event.target.value)} placeholder="搜索品牌、系列或型号"/></div></div>
        <AsyncState loading={devices.isLoading} error={devices.isError} empty={!filteredDevices.length} emptyTitle="没有匹配设备" emptyDescription="尝试其他关键词，或选择“其他开放嵌入式设备”。" onRetry={() => void devices.refetch()}>
          <div className="max-h-[560px] divide-y divide-line/60 overflow-y-auto">{filteredDevices.map(device => <button key={device.id} type="button" aria-pressed={selectedDevice?.id === device.id} onClick={() => selectDevice(device.id)} className={`w-full px-4 py-3.5 text-left transition ${selectedDevice?.id === device.id ? 'bg-accent/10' : 'hover:bg-white/[.025]'}`}><div className="flex items-center justify-between gap-2"><span className="text-xs font-medium text-slate-200">{device.series}</span>{selectedDevice?.id === device.id && <CheckCircle2 className="h-3.5 w-3.5 text-accent"/>}</div><div className="mt-1 text-[10px] text-muted">{device.manufacturer} · {device.model}</div></button>)}</div>
        </AsyncState>
      </Card>
      <div className="space-y-5">
        {selectedDevice && <Card className="p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><Badge tone="info">{selectedDevice.id}</Badge><h2 className="mt-3 text-lg font-semibold text-white">{selectedDevice.manufacturer} {selectedDevice.series}</h2><p className="mt-1 text-xs text-muted">{selectedDevice.model}</p></div><Badge tone={deviceDetail.data?.support.researchSupport === 'OFFICIAL_PROGRAM' ? 'success' : 'warn'}>{supportLabels[deviceDetail.data?.support.researchSupport ?? 'NOT_ESTABLISHED']}</Badge></div><div className="mt-5 grid gap-5 md:grid-cols-2"><div><h3 className="text-xs font-medium text-slate-300">可研究内容</h3><ul className="mt-2 space-y-1.5 text-[11px] leading-5 text-muted">{selectedDevice.capabilities.map(item => <li key={item}>· {item}</li>)}</ul></div><div><h3 className="text-xs font-medium text-slate-300">限制</h3><ul className="mt-2 space-y-1.5 text-[11px] leading-5 text-muted">{selectedDevice.limitations.map(item => <li key={item}>· {item}</li>)}</ul></div></div>{selectedDevice.officialDocs.length > 0 && <div className="mt-5 flex flex-wrap gap-2 border-t border-line pt-4">{selectedDevice.officialDocs.map(doc => <a key={doc.url} href={doc.url} target="_blank" rel="noreferrer" className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-line bg-panel2 px-3 text-[11px] text-slate-300 hover:border-accent/40"><ExternalLink className="h-3 w-3"/>{doc.label}</a>)}</div>}</Card>}
        <Card className="p-5"><div className="flex items-center gap-2"><Usb className="h-4 w-4 text-accent"/><h2 className="text-sm font-semibold text-white">USB 只读诊断</h2></div><p className="mt-2 text-xs leading-5 text-muted">仅根据你确认的枚举摘要给出安全建议；不会读取或操作真实设备。</p><div className="mt-4 grid gap-3 sm:grid-cols-2">{usbBooleanFields.map(field => <label key={field.key} className="flex min-h-11 items-center gap-3 rounded-lg border border-line bg-panel2/50 px-3 text-xs text-slate-300"><input type="checkbox" checked={usb[field.key]} onChange={event => setUsb({ ...usb, [field.key]: event.target.checked })} className="accent-[rgb(var(--accent))]"/>{field.label}</label>)}</div><div className="mt-3 grid gap-3 sm:grid-cols-3"><Field label="接口外形"><select aria-label="接口外形" className={inputClass} value={usb.connectorForm} onChange={event => setUsb({ ...usb, connectorForm: event.target.value as UsbEnumerationSummary['connectorForm'] })}><option value="UNKNOWN">未知</option><option value="USB-A">USB-A</option><option value="USB-C">USB-C</option><option value="MICRO_USB">Micro USB</option><option value="OTHER">其他</option></select></Field><Field label="对端类型"><select aria-label="对端类型" className={inputClass} value={usb.peerType} onChange={event => setUsb({ ...usb, peerType: event.target.value as UsbEnumerationSummary['peerType'] })}><option value="UNKNOWN">未知</option><option value="DEVELOPMENT_CONSOLE">开发主机</option><option value="RETAIL_CONSOLE">普通零售主机</option><option value="ANDROID_TV">Android TV</option></select></Field><Field label="线缆状态"><select aria-label="线缆状态" className={inputClass} value={usb.cableCondition} onChange={event => setUsb({ ...usb, cableCondition: event.target.value as UsbEnumerationSummary['cableCondition'] })}><option value="UNKNOWN">未知</option><option value="INTACT_STANDARD">完好标准线缆</option><option value="DAMAGED">损坏</option></select></Field></div><Button className="mt-4" disabled={diagnose.isPending} onClick={() => diagnose.mutate()}>{diagnose.isPending ? <Spinner/> : <ShieldCheck className="h-4 w-4"/>}{diagnose.isPending ? '正在诊断…' : '诊断枚举摘要'}</Button>{diagnose.isError && <div className="mt-4"><ErrorNotice error={diagnose.error} component="USB 诊断" onRetry={() => diagnose.mutate()}/></div>}{diagnose.data && <div className="mt-5 rounded-xl border border-line bg-panel2/40 p-4"><div className="flex flex-wrap gap-2"><Badge tone={diagnose.data.diagnosis.supportedTopology ? 'success' : 'warn'}>{diagnose.data.diagnosis.supportedTopology ? '拓扑受支持' : '不足以支持设备操作'}</Badge><Badge tone={diagnose.data.diagnosis.hardwareSafetyRisk ? 'danger' : 'neutral'}>{diagnose.data.diagnosis.hardwareSafetyRisk ? '存在硬件安全风险' : '未报告硬件风险'}</Badge><Badge>{diagnose.data.diagnosis.needsOfficialDevEnvironment ? '需要官方开发环境' : '无需额外开发环境'}</Badge></div><div className="mt-4 grid gap-4 md:grid-cols-2"><div><h3 className="text-xs font-medium text-slate-200">诊断发现</h3><ul className="mt-2 space-y-1.5 text-[11px] leading-5 text-muted">{diagnose.data.diagnosis.findings.map(item => <li key={item}>· {item}</li>)}</ul></div><div><h3 className="text-xs font-medium text-slate-200">下一步</h3><ul className="mt-2 space-y-1.5 text-[11px] leading-5 text-muted">{diagnose.data.diagnosis.nextSteps.map(item => <li key={item}>· {item}</li>)}</ul></div></div></div>}</Card>
      </div>
    </div>

    <Card className="mt-5 p-5"><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-sm font-semibold text-white">能力矩阵</h2><p className="mt-1 text-xs text-muted">描述合法研究路径，不代表自动识别、解锁或设备操作能力。</p></div><Badge tone="info">{support.data?.devices.length ?? 0} 个平台</Badge></div><AsyncState loading={support.isLoading} error={support.isError} onRetry={() => void support.refetch()}><div className="mt-4 overflow-x-auto"><table className="w-full min-w-[760px] text-left text-xs"><thead className="border-b border-line text-[11px] text-muted"><tr><th className="py-3 pr-4 font-medium">设备</th><th className="px-4 py-3 font-medium">研究支持</th><th className="px-4 py-3 font-medium">离线样本</th><th className="px-4 py-3 font-medium">官方环境</th></tr></thead><tbody className="divide-y divide-line/60">{support.data?.devices.map(entry => { const device = devices.data?.items.find(item => item.id === entry.deviceId); return <tr key={entry.deviceId}><td className="py-3 pr-4"><div className="text-slate-200">{device?.series ?? entry.deviceId}</div><div className="mt-1 font-mono text-[9px] text-muted">{entry.deviceId}</div></td><td className="px-4 py-3"><Badge tone={entry.researchSupport === 'OFFICIAL_PROGRAM' ? 'success' : 'warn'}>{supportLabels[entry.researchSupport]}</Badge></td><td className="px-4 py-3"><Badge tone={entry.offlineSampleAnalysis === 'DOCUMENTED_STANDARD_INTERFACE' ? 'success' : 'neutral'}>{supportLabels[entry.offlineSampleAnalysis]}</Badge></td><td className="px-4 py-3 text-muted">{entry.officialEnvironment}</td></tr>; })}</tbody></table></div></AsyncState></Card>

    <Card className="mt-5 p-5 sm:p-6"><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-sm font-semibold text-white">主机档案与 C0–C5</h2><p className="mt-1 text-xs text-muted">档案保存在本地项目。等级由后端根据证据计算，不能手动提升。</p></div><Badge tone={savedLevel === 'C0' ? 'neutral' : 'success'}>当前 {savedLevel}</Badge></div>
      <Notice tone="info">C1 仅表示已记录身份与官方资料，不代表设备身份已验证。C2 及以上只计入后端验证证据；用户记录不能提升等级。</Notice>
      <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{levelCards.map((card, index) => <div key={card.level} className={`rounded-xl border p-4 ${index <= activeLevelIndex ? 'border-accent/40 bg-accent/[.06]' : 'border-line bg-panel2/40'}`}><div className="flex items-center justify-between"><span className={`font-mono text-sm ${index <= activeLevelIndex ? 'text-accent' : 'text-muted'}`}>{card.level}</span>{index <= activeLevelIndex && <CheckCircle2 className="h-4 w-4 text-accent"/>}</div><h3 className="mt-2 text-xs font-medium text-slate-200">{card.name}</h3><p className="mt-1 text-[10px] leading-5 text-muted">{card.requirement}</p></div>)}</div>
      <div className="my-6 h-px bg-line"/>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(280px,.55fr)]"><Field label="主机研究项目" hint="只有 console 类型项目可以保存主机档案。"><select aria-label="主机研究项目" className={inputClass} value={projectId} onChange={event => selectProject(event.target.value)}><option value="">请选择项目</option>{consoleProjects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></Field><Field label="新建项目名称"><input className={inputClass} value={newProjectName} onChange={event => setNewProjectName(event.target.value)} placeholder="例如：我的 PS5 公开资料档案" maxLength={120}/></Field></div>
      <label className="mt-3 flex items-start gap-3 text-xs leading-5 text-slate-300"><input type="checkbox" checked={newProjectAuthorized} onChange={event => setNewProjectAuthorized(event.target.checked)} className="mt-1 accent-[rgb(var(--accent))]"/>我确认拥有该设备或已获得明确研究授权，并理解档案存在不等于设备身份或接口能力证据。</label><div className="mt-3"><Button variant="secondary" disabled={createProject.isPending || profileDirty || !newProjectName.trim() || !newProjectAuthorized} onClick={() => createProject.mutate()}>{createProject.isPending ? <Spinner/> : <FilePlus2 className="h-4 w-4"/>}{createProject.isPending ? '正在创建…' : '创建主机研究项目'}</Button></div>{createProject.isError && <div className="mt-3"><ErrorNotice error={createProject.error} component="创建主机项目" onRetry={() => createProject.mutate()} retryable={Boolean(newProjectName.trim() && newProjectAuthorized)}/></div>}
      {!projectId ? <Empty title="选择一个主机研究项目" description="选择现有项目或先创建一个新项目，然后编辑档案。"/> : profile.isLoading ? <div className="mt-5 flex items-center gap-2 p-6 text-sm text-muted"><Spinner/>读取档案…</div> : profile.isError ? <div className="mt-5"><ErrorNotice error={profile.error} component="主机档案读取" onRetry={() => void profile.refetch()}/></div> : <div className="mt-5 space-y-5">
        {!profile.data && <Notice tone="info">该项目还没有主机档案。已根据所选设备预填公开资料，保存后将创建 C0 档案。</Notice>}
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3"><Field label="制造商"><input className={inputClass} value={profileForm.manufacturer} onChange={event => editProfile({ ...profileForm, manufacturer: event.target.value })}/></Field><Field label="系列"><input className={inputClass} value={profileForm.series} onChange={event => editProfile({ ...profileForm, series: event.target.value })}/></Field><Field label="型号"><input className={inputClass} value={profileForm.model} onChange={event => editProfile({ ...profileForm, model: event.target.value })}/></Field><Field label="硬件版本"><input className={inputClass} value={profileForm.hardwareVersion} onChange={event => editProfile({ ...profileForm, hardwareVersion: event.target.value })}/></Field><Field label="系统版本"><input className={inputClass} value={profileForm.systemVersion} onChange={event => editProfile({ ...profileForm, systemVersion: event.target.value })}/></Field><Field label="实际访问"><select aria-label="实际访问" className={inputClass} value={profileForm.actualAccess} onChange={event => editProfile({ ...profileForm, actualAccess: event.target.value as ActualAccess })}>{Object.entries(accessLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field></div>
        <div className="grid gap-4 md:grid-cols-2">{profileTextFields.map(([key, label]) => <Field key={key} label={label} hint="每行一条"><textarea aria-label={label} className={`${inputClass} min-h-24 resize-y`} value={lines(profileForm[key])} onChange={event => editProfile({ ...profileForm, [key]: parseLines(event.target.value) })}/></Field>)}</div>
        <div><div className="flex flex-wrap items-center justify-between gap-3"><h3 className="text-sm font-semibold text-white">研究证据</h3><Button variant="secondary" onClick={addEvidence}><FilePlus2 className="h-3.5 w-3.5"/>添加证据</Button></div>{profileForm.researchEvidence.length === 0 ? <p className="mt-3 text-xs text-muted">尚未添加证据。C1 及以上需要对应的可追溯证据。</p> : <div className="mt-3 space-y-3">{profileForm.researchEvidence.map((evidence, index) => <div key={evidence.id} className="rounded-xl border border-line bg-panel2/40 p-4"><div className="flex items-center justify-between gap-3"><div className="flex items-center gap-2"><KindBadge kind={evidence.kind === 'IDENTITY' || evidence.kind === 'OFFICIAL_DOCUMENT' ? 'EVIDENCE' : evidence.kind === 'READ_ONLY_ENUMERATION' ? 'VERIFIED' : 'INFERENCE'}/><span className="text-xs text-slate-300">证据 {index + 1}</span><Badge tone={evidence.verification === 'TOOL_VERIFIED' ? 'success' : 'neutral'}>{evidence.verification === 'TOOL_VERIFIED' ? '后端验证' : '用户记录'}</Badge></div><Button variant="ghost" aria-label={`删除证据 ${index + 1}`} onClick={() => editProfile({ ...profileForm, researchEvidence: profileForm.researchEvidence.filter(item => item.id !== evidence.id) })}><X className="h-4 w-4"/></Button></div><div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-4"><Field label="证据类型"><select aria-label={`证据 ${index + 1} 类型`} className={inputClass} value={evidence.kind} onChange={event => updateEvidence(evidence.id, { kind: event.target.value as ConsoleEvidenceKind })}>{evidenceKinds.map(kind => <option key={kind.value} value={kind.value}>{kind.label}</option>)}</select></Field><Field label="来源"><input aria-label={`证据 ${index + 1} 来源`} className={inputClass} value={evidence.source} onChange={event => updateEvidence(evidence.id, { source: event.target.value })}/></Field><Field label="观察时间"><input aria-label={`证据 ${index + 1} 观察时间`} type="datetime-local" className={inputClass} value={evidence.observedAt.slice(0, 16)} onChange={event => { if (event.target.value) updateEvidence(evidence.id, { observedAt: new Date(event.target.value).toISOString() }); }}/></Field><Field label="SHA-256（可选）"><input aria-label={`证据 ${index + 1} SHA-256`} className={inputClass} value={evidence.sha256 ?? ''} onChange={event => updateEvidence(evidence.id, { sha256: event.target.value })}/></Field></div><div className="mt-3 grid gap-3 md:grid-cols-2"><Field label="描述"><input aria-label={`证据 ${index + 1} 描述`} className={inputClass} value={evidence.description} onChange={event => updateEvidence(evidence.id, { description: event.target.value })}/></Field><Field label="方法（可选）"><input aria-label={`证据 ${index + 1} 方法`} className={inputClass} value={evidence.method ?? ''} onChange={event => updateEvidence(evidence.id, { method: event.target.value })}/></Field></div></div>)}</div>}</div>
        {profileDirty && <Notice tone="warn">档案有未保存修改。后台刷新不会覆盖编辑内容；切换项目或设备前会询问是否放弃。</Notice>}{profileMessage && <p role="status" className="text-xs leading-5 text-muted">{profileMessage}</p>}{saveProfile.isError && <ErrorNotice error={saveProfile.error} component="保存主机档案" onRetry={() => saveProfile.mutate()}/>}<div className="flex flex-wrap items-center gap-3 border-t border-line pt-4"><Button disabled={saveProfile.isPending} onClick={() => saveProfile.mutate()}>{saveProfile.isPending ? <Spinner/> : <Save className="h-4 w-4"/>}{saveProfile.isPending ? '正在保存…' : '保存档案并计算等级'}</Button><span className="text-[11px] text-muted">保存后由后端重新计算 C0–C5；不会把用户填写内容当作已验证事实。</span></div>
      </div>}
    </Card>
    {support.data?.officialEnvironments.length ? <Card className="mt-5 p-5"><div className="flex items-center gap-2"><Cpu className="h-4 w-4 text-accent"/><h2 className="text-sm font-semibold text-white">官方开发环境</h2></div><div className="mt-4 grid gap-3 md:grid-cols-2">{support.data.officialEnvironments.map(environment => <div key={environment.name} className="rounded-xl border border-line bg-panel2/40 p-4"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-xs font-medium text-slate-200">{environment.name}</h3><Badge tone="warn">不执行操作</Badge></div><p className="mt-2 text-[11px] leading-5 text-muted">{environment.description}</p><p className="mt-2 text-[10px] text-muted">访问条件：{environment.access}</p><div className="mt-3 flex flex-wrap gap-2">{environment.docs.map(doc => <a key={doc.url} href={doc.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[10px] text-accent">{doc.label}<ArrowUpRight className="h-3 w-3"/></a>)}</div></div>)}</div></Card> : null}
  </>;
}

import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle, CheckCircle2, Cpu, FileUp, RefreshCw, ShieldCheck, Usb,
} from 'lucide-react';
import { api, errorMessage, type HardwareDevice } from '../api';
import { AsyncState, Badge, Button, Card, Empty, Field, PageTitle, Spinner, inputClass } from '../components/ui';

const pageSize = 25;

function Topology({ device }: { device: HardwareDevice }) {
  return <dl className="grid gap-x-5 gap-y-2 text-xs sm:grid-cols-2">
    {[
      ['Bus', device.bus ?? 'UNKNOWN'],
      ['Device address', device.deviceAddress ?? 'UNKNOWN'],
      ['Vendor ID', device.identity.vendorId ?? 'UNKNOWN'],
      ['Product ID', device.identity.productId ?? 'UNKNOWN'],
      ['Speed', device.speed ?? 'UNKNOWN'],
      ['Class', device.deviceClass ?? 'UNKNOWN'],
      ['Authorization', device.identity.authorization],
      ['Serial access', device.serialAccess],
      ...Object.entries(device.topology ?? {}).map(([key, value]) => [`Topology ${key}`, String(value)] as [string, string]),
    ].map(([label, value]) => <div key={label} className="min-w-0 border-b border-line/60 pb-2"><dt className="text-muted">{label}</dt><dd className="mt-1 break-all font-mono text-slate-300">{value}</dd></div>)}
  </dl>;
}

function DescriptorTree({ device }: { device: HardwareDevice }) {
  return <div className="mt-5">
    <div className="flex items-center justify-between gap-3"><h3 className="text-sm font-semibold text-white">描述符 / 接口 / Endpoint 树</h3><Badge>{device.configurations.length} configurations</Badge></div>
    {device.reportDescriptor && <p className="mt-2 text-xs text-muted">Report descriptor：{device.reportDescriptor.byteLength} bytes（仅展示长度，不采集键盘报告）</p>}
    {device.interfaces.length === 0 ? <p className="mt-3 text-xs text-muted">本机枚举未返回接口描述符。</p> : <div className="mt-3 space-y-3">{device.interfaces.map((usbInterface, index) => <div key={`${usbInterface.number}-${usbInterface.alternateSetting ?? index}`} className="rounded-lg border border-line bg-panel2/60 p-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-200"><Usb className="h-3.5 w-3.5 text-accent"/>Interface {usbInterface.number}{usbInterface.alternateSetting !== undefined ? ` · alt ${usbInterface.alternateSetting}` : ''}<Badge>{usbInterface.class ?? 'UNKNOWN'}</Badge>{usbInterface.name && <span className="text-muted">{usbInterface.name}</span>}</div>
      {usbInterface.endpoints.length === 0 ? <p className="mt-2 text-[11px] text-muted">无 endpoint 描述符</p> : <ul className="mt-3 space-y-2 border-l border-line pl-3">{usbInterface.endpoints.map(endpoint => <li key={`${endpoint.address}-${endpoint.number}`} className="text-[11px] leading-5 text-slate-400"><span className="font-mono text-slate-300">Endpoint 0x{endpoint.address.toString(16).padStart(2, '0')}</span> · {endpoint.direction} · {endpoint.transferType} · number {endpoint.number}{endpoint.maxPacketSize !== undefined ? ` · max packet ${endpoint.maxPacketSize}` : ''}{endpoint.interval !== undefined ? ` · interval ${endpoint.interval}` : ''}</li>)}</ul>}
    </div>)}</div>}
  </div>;
}

export default function Hardware() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const enumeration = useQuery({ queryKey: ['hardware-devices'], queryFn: api.hardwareDevices, refetchInterval: 10_000 });
  const doctor = useQuery({ queryKey: ['hardware-doctor'], queryFn: api.hardwareDoctor, refetchInterval: 10_000 });
  const capabilities = useQuery({ queryKey: ['hardware-capabilities'], queryFn: api.hardwareCapabilities });
  const serial = useQuery({ queryKey: ['hardware-serial'], queryFn: api.hardwareSerial });
  const [deviceLimit, setDeviceLimit] = useState(pageSize);
  const [serialLimit, setSerialLimit] = useState(pageSize);
  const [selectedKey, setSelectedKey] = useState<string>();
  const [projectName, setProjectName] = useState('');
  const [file, setFile] = useState<File>();
  const [authorized, setAuthorized] = useState(false);
  const [error, setError] = useState('');
  const devices = enumeration.data?.devices ?? [];
  const selectedDevice = devices.find(device => device.identity.stableKey === selectedKey) ?? devices[0];
  const ports = serial.data?.ports ?? [];

  function refresh(): void {
    void enumeration.refetch();
    void doctor.refetch();
    void capabilities.refetch();
    void serial.refetch();
  }

  const createTask = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error('请选择 USB 记录、HID 描述符或设备快照');
      if (!authorized) throw new Error('请确认已获得硬件分析授权');
      const project = await api.createProject({
        name: projectName.trim() || `硬件离线分析 ${new Date().toLocaleString('zh-CN')}`,
        kind: 'hardware',
        authorizationConfirmed: true,
      });
      await api.upload(project.id, file);
      return api.createTask(project.id, 'hardware');
    },
    onSuccess: async task => {
      await qc.invalidateQueries();
      navigate(`/tasks/${task.id}`);
    },
    onError: cause => setError(errorMessage(cause)),
  });

  return <>
    <PageTitle
      eyebrow="Read-only hardware lab"
      title="硬件实验室"
      description="设备枚举、USB 拓扑、描述符树与串口列表均来自本机 API。串口不会打开，设备句柄、实时抓包与键盘报告捕获保持禁用。"
      action={<Button variant="secondary" onClick={refresh}><RefreshCw className="h-4 w-4"/>刷新本机状态</Button>}
    />
    <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <Card className="p-4"><div className="text-xs text-muted">Doctor 状态</div><div className="mt-2"><span data-testid="hardware-doctor-status">{doctor.data?.status ?? (doctor.isLoading ? '检测中' : '不可用')}</span></div></Card>
      <Card className="p-4"><div className="text-xs text-muted">枚举设备数</div><div className="mt-2 font-mono text-lg text-white" data-testid="hardware-device-count">{doctor.data?.deviceCount ?? '—'}</div></Card>
      <Card className="p-4"><div className="text-xs text-muted">平台</div><div className="mt-2 font-mono text-sm text-slate-300">{capabilities.data?.platform ?? doctor.data?.platform ?? '—'}</div></Card>
      <Card className="p-4"><div className="text-xs text-muted">权限模式</div><div className="mt-2 flex items-center gap-2 text-sm text-slate-300"><ShieldCheck className="h-4 w-4 text-accent"/>仅本机回环 API</div></Card>
    </div>
    <Card className="mb-5 p-4"><div className="flex items-start gap-3 text-xs leading-5 text-slate-300"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300"/><div><strong className="text-amber-200">权限边界：</strong>不会打开设备句柄或串口，也不会执行固件。远程访问会被后端拒绝；无设备、权限不足或平台不支持时显示真实状态，不生成演示设备。</div></div></Card>
    {(doctor.isError || capabilities.isError) && <div role="alert" className="mb-5 rounded-lg border border-red-400/20 bg-red-400/5 p-3 text-xs leading-5 text-red-300">硬件状态读取失败：{errorMessage(doctor.error ?? capabilities.error)}</div>}
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1.25fr)_minmax(320px,1fr)]">
      <Card>
        <div className="flex items-center justify-between border-b border-line px-5 py-4"><div><h2 className="text-sm font-semibold text-white">USB 设备与拓扑</h2><p className="mt-1 text-xs text-muted">按 bus / address / topology 展示可读字段</p></div><Badge tone="info">{devices.length} devices</Badge></div>
        <AsyncState loading={enumeration.isLoading} error={enumeration.isError} empty={!devices.length} emptyTitle="未枚举到 USB 设备" emptyDescription="本机当前没有可读的 USB 设备，或平台枚举能力受限。你仍可上传已有 USB 记录进行离线分析。" onRetry={() => void enumeration.refetch()}>
          <div className="grid gap-4 p-4 lg:grid-cols-[minmax(220px,.8fr)_minmax(0,1.2fr)]">
            <div data-testid="hardware-device-list" className="space-y-2">{devices.slice(0, deviceLimit).map(device => <button key={device.identity.stableKey} type="button" aria-pressed={selectedDevice?.identity.stableKey === device.identity.stableKey} onClick={() => setSelectedKey(device.identity.stableKey)} className={`w-full rounded-lg border p-3 text-left ${selectedDevice?.identity.stableKey === device.identity.stableKey ? 'border-accent bg-accent/10' : 'border-line bg-panel2/50 hover:border-accent/40'}`}><div className="truncate text-xs font-medium text-slate-200">{device.product ?? device.identity.productId ?? device.identity.stableKey}</div><div className="mt-1 font-mono text-[10px] text-muted">{device.identity.vendorId ?? '?'}:{device.identity.productId ?? '?'} · bus {device.bus ?? '?'} · addr {device.deviceAddress ?? '?'}</div></button>)}{devices.length > deviceLimit && <Button variant="secondary" className="w-full" onClick={() => setDeviceLimit(limit => limit + pageSize)}>加载更多设备（剩余 {devices.length - deviceLimit}）</Button>}</div>
            {selectedDevice ? <div className="min-w-0 rounded-xl border border-line bg-panel2/30 p-4"><div className="flex flex-wrap items-start justify-between gap-2"><div><h3 className="text-sm font-semibold text-white">{selectedDevice.product ?? 'USB 设备'}</h3><p className="mt-1 text-xs text-muted">{selectedDevice.manufacturer ?? '制造商未返回'} · {selectedDevice.version ?? '版本未返回'}</p></div><Badge tone={selectedDevice.identity.authorization === 'GRANTED' ? 'success' : 'warn'}>{selectedDevice.identity.authorization}</Badge></div><div className="mt-4"><Topology device={selectedDevice}/></div><DescriptorTree device={selectedDevice}/></div> : <Empty title="选择设备" description="选择左侧设备查看拓扑与描述符树。"/>}
          </div>
        </AsyncState>
        {enumeration.data?.truncated && <p className="border-t border-line px-5 py-3 text-xs text-amber-300">枚举结果已被本机适配器截断；当前展示不是完整设备集合。</p>}
        {enumeration.data?.limitations.length ? <ul className="border-t border-line px-5 py-3 text-[11px] leading-5 text-muted">{enumeration.data.limitations.map(limit => <li key={limit}>· {limit}</li>)}</ul> : null}
      </Card>
      <div className="space-y-5">
        <Card className="p-5"><div className="flex items-center justify-between"><h2 className="text-sm font-semibold text-white">Doctor / Capabilities</h2><Badge tone={doctor.data?.status === 'OK' ? 'success' : 'warn'}>{doctor.data?.status ?? 'UNKNOWN'}</Badge></div><AsyncState loading={doctor.isLoading || capabilities.isLoading} error={doctor.error ?? capabilities.error} onRetry={refresh}>{doctor.data && capabilities.data ? <div className="mt-4 space-y-2 text-xs">{[['USB enumeration', capabilities.data.usbEnumeration], ['Serial listing', capabilities.data.serialListing], ['Open device handles', String(capabilities.data.openDeviceHandles)], ['Live capture', String(capabilities.data.liveCapture)], ['Serial open', String(capabilities.data.serialOpen)], ['Administrator required', String(capabilities.data.administratorRequired)], ['HID keyboard capture', capabilities.data.hidKeyboardCapture]].map(([label, value]) => <div key={label} className="flex items-center justify-between gap-3 border-b border-line/60 pb-2"><span className="text-muted">{label}</span><span className="font-mono text-slate-300">{value}</span></div>)}</div> : null}</AsyncState></Card>
        <Card><div className="flex items-center justify-between border-b border-line px-5 py-4"><div><h2 className="text-sm font-semibold text-white">串口列表</h2><p className="mt-1 text-xs text-muted">串口仅列出，不打开。</p></div><Badge>{ports.length}</Badge></div><AsyncState loading={serial.isLoading} error={serial.isError} empty={!ports.length} emptyTitle="未发现串口" emptyDescription="本机没有可读串口，或枚举能力受限。不会尝试打开任何端口。" onRetry={() => void serial.refetch()}>{ports.slice(0, serialLimit).map(port => <div key={port.identity.stableKey} className="border-b border-line/60 px-5 py-3 last:border-0"><div className="font-mono text-xs text-slate-300">{port.name}</div><div className="mt-1 text-[10px] text-muted">{port.manufacturer ?? '制造商未返回'} · {port.driver ?? '驱动未返回'} · opened=false</div></div>)}{ports.length > serialLimit && <div className="p-3"><Button variant="secondary" className="w-full" onClick={() => setSerialLimit(limit => limit + pageSize)}>加载更多串口（剩余 {ports.length - serialLimit}）</Button></div>}</AsyncState></Card>
        <Card className="p-5"><div className="flex items-center gap-2"><Cpu className="h-4 w-4 text-accent"/><h2 className="text-sm font-semibold text-white">固件入口</h2></div><p className="mt-2 text-xs leading-5 text-muted">固件使用独立的有界静态分析器，不刷写目标设备。</p><Link to="/new?type=firmware"><Button variant="secondary" className="mt-4 w-full">创建固件分析任务</Button></Link></Card>
      </div>
    </div>
    <Card className="mt-5 p-5 sm:p-6"><div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-sm font-semibold text-white">USB 记录上传与离线任务</h2><p className="mt-1 text-xs leading-5 text-muted">支持 PCAP、PCAPNG、usbmon、HID 描述符和枚举快照。文件先计算 SHA-256，再由 Worker 执行有界离线解析。</p></div><Badge tone="info">hardware adapter</Badge></div><div className="mt-5 grid gap-4 lg:grid-cols-2"><Field label="任务项目名称"><input className={inputClass} value={projectName} onChange={event => setProjectName(event.target.value)} maxLength={120} placeholder="例如：USB 通信记录复核"/></Field><Field label="USB 记录或描述符文件"><input aria-label="USB 记录或描述符文件" type="file" className="block w-full text-xs text-slate-300 file:mr-3 file:min-h-10 file:rounded-lg file:border file:border-line file:bg-panel2 file:px-3 file:text-slate-200" accept=".pcap,.pcapng,.cap,.txt,.json,.bin" onChange={event => { setFile(event.target.files?.[0]); setError(''); }}/></Field></div><label className="mt-4 flex items-start gap-3 text-xs leading-5 text-slate-300"><input aria-label="确认已获得硬件分析授权" type="checkbox" checked={authorized} onChange={event => setAuthorized(event.target.checked)} className="mt-1 accent-[rgb(var(--accent))]"/>我确认拥有相关设备或已获得明确授权，并理解离线分析不会验证设备的全部语义。</label>{error && <p role="alert" className="mt-4 rounded-lg border border-red-400/20 bg-red-400/5 p-3 text-xs text-red-300">{error}</p>}<Button className="mt-4" disabled={!file || !authorized || createTask.isPending} onClick={() => createTask.mutate()}>{createTask.isPending ? <Spinner/> : <FileUp className="h-4 w-4"/>}{createTask.isPending ? '正在上传并创建…' : '上传记录并创建离线任务'}</Button><div className="mt-4 flex items-center gap-2 text-[11px] text-muted"><CheckCircle2 className="h-3.5 w-3.5 text-accent"/>原始记录保留在本机任务输入中；原始数据包内容不会写入证据报告。</div></Card>
  </>;
}

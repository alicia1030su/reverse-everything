import { ExternalLink, PackageCheck, ShieldCheck, Wrench } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { api, type AnalyzerCapability } from '../api';
import { Badge, Card, ErrorNotice, Notice, PageTitle, Spinner } from '../components/ui';

interface Guidance { title: string; official: string; install: string; alternative: string; reason: string }
const guidance: Record<AnalyzerCapability['id'], Guidance> = {
  ghidra: { title: 'Ghidra', official: 'https://ghidra-sre.org/', install: '从 Ghidra 官方发布页下载与系统匹配的安装包，解压后按官方文档配置 JDK 与安装目录。', alternative: '先用内置 file 分析器识别格式、字符串与归档元数据。', reason: 'Ghidra headless 体积较大，只应在明确需要反编译时手动安装。' },
  jadx: { title: 'JADX', official: 'https://github.com/skylot/jadx', install: '从 JADX 官方 GitHub Releases 下载发布包，解压后将可执行文件加入本机 PATH。', alternative: '使用内置 APK 分析器读取 Manifest、DEX 与资源元数据。', reason: '反编译依赖较大；基础静态分析不需要它。' },
  firmware: { title: '固件分析工具', official: 'https://github.com/ReFirmLabs/binwalk', install: '仅按 Binwalk 官方文档在隔离环境安装；不要对来源不明的安装脚本使用管理员权限。', alternative: '使用内置固件分析器识别 UF2、HEX、ELF、熵与字符串。', reason: '第三方提取工具可能解析不可信输入，应限制权限与资源。' },
  usb: { title: 'USB 离线记录工具', official: 'https://www.wireshark.org/', install: '从 Wireshark 官方下载页安装稳定版；仅在需要人工查看 PCAP 时安装。', alternative: '直接上传 PCAP、PCAPNG 或 usbmon 记录，由内置分析器离线解析。', reason: '实时抓包需要额外权限，本产品默认不抓包、不打开设备。' },
  network: { title: '网络记录工具', official: 'https://www.wireshark.org/', install: '从 Wireshark 官方下载页安装；仅用于查看已有抓包，不在分析过程中访问目标。', alternative: '使用内置 HAR / PCAP 离线元数据解析器。', reason: '网络记录可能包含敏感信息，应保持离线与最小化展示。' },
  website: { title: '网页分析浏览器', official: 'https://playwright.dev/', install: '按 Playwright 官方文档安装 Chromium；本页面不会自动下载或安装浏览器。', alternative: '使用内置网页适配器；若浏览器缺失，页面会显示真实依赖原因。', reason: '浏览器运行时较大，下载应由用户主动确认。' },
  android: { title: 'Android SDK', official: 'https://developer.android.com/studio', install: '从 Android Developers 官方页面安装 Android Studio 或命令行工具，并接受对应许可证。', alternative: '使用内置 APK / DEX 静态元数据解析。', reason: 'SDK 与构建工具受各自许可证约束，不应静默安装。' },
  game: { title: '游戏回放分析', official: 'https://nodejs.org/', install: '游戏兼容验证需要 Node.js 22 或更高版本；请从 Node.js 官方下载页安装。', alternative: '先运行“迷你游戏兼容分析”内置演示验证流程。', reason: '兼容服务只在隔离目录运行，不执行原游戏或绕过反作弊。' },
  security: { title: '静态安全检查', official: 'https://semgrep.dev/', install: '如需扩展规则，请按 Semgrep 官方文档在隔离环境安装；基础被动检查不依赖它。', alternative: '使用内置静态危险模式规则。', reason: '安全分析仅用于自有或明确授权目标，不进行漏洞利用。' },
  file: { title: '基础文件分析', official: 'https://www.apache.org/', install: '内置能力无需安装；项目按 Apache-2.0 分发。', alternative: '可直接上传文件进行格式、字符串、归档与依赖元数据分析。', reason: '不执行未知程序，不需要额外系统权限。' },
};

export default function Tools() {
  const tools = useQuery({ queryKey: ['tools'], queryFn: api.tools });
  const available = tools.data?.items.filter(item => item.available).length ?? 0;
  return <>
    <PageTitle eyebrow="Tools & dependencies" title="工具与依赖" description="查看真实分析器状态与官方安装指引。本页面只提供说明，不会自动下载、安装或修改系统配置。"/>
    <Notice tone="warn"><strong>安装边界：</strong>大型工具必须由你从官方来源主动安装。缺失依赖只会阻塞对应分析器，不会生成替代结果或伪造进度。</Notice>
    {tools.isLoading ? <div className="mt-5 flex items-center justify-center gap-2 p-12 text-sm text-muted"><Spinner/>检测分析器…</div> : tools.isError ? <div className="mt-5"><ErrorNotice error={tools.error} component="分析器状态" onRetry={() => void tools.refetch()}/></div> : <>
      <div className="mt-5 flex flex-wrap items-center gap-3"><Badge tone="success">{available} / {tools.data?.items.length ?? 0} 可用</Badge><span className="text-xs text-muted">{tools.data?.note}</span></div>
      <div className="mt-5 grid gap-4 lg:grid-cols-2">{tools.data?.items.map(item => { const info = guidance[item.id]; return <Card key={item.id} className="flex flex-col p-5"><div className="flex items-start justify-between gap-3"><div className="flex items-center gap-2"><Wrench className="h-4 w-4 text-accent"/><h2 className="text-sm font-semibold text-white">{info.title}</h2><Badge>{item.id}</Badge></div><Badge tone={item.available ? 'success' : 'danger'}>{item.available ? '可用' : '缺依赖'}</Badge></div><p className="mt-3 text-xs leading-5 text-muted">{item.detail}</p><div className="mt-3 flex flex-wrap gap-2 text-[10px] text-muted"><span className="rounded-md border border-line bg-panel2 px-2 py-1 font-mono">{item.version ?? '版本未返回'}</span><span className="rounded-md border border-line bg-panel2 px-2 py-1">{item.available ? '可执行' : '需要手动处理'}</span></div><div className="mt-4 flex-1 rounded-lg border border-line bg-panel2/40 p-3"><h3 className="flex items-center gap-1.5 text-[11px] font-medium text-slate-200"><PackageCheck className="h-3.5 w-3.5 text-accent"/>官方安装指引</h3><p className="mt-2 text-[11px] leading-5 text-muted">{info.install}</p><a href={info.official} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-[11px] text-accent">打开官方页面<ExternalLink className="h-3 w-3"/></a></div><div className="mt-3 grid gap-2 text-[11px] leading-5"><p className="text-muted"><span className="text-slate-300">安全替代：</span>{info.alternative}</p><p className="text-muted"><span className="text-slate-300">原因：</span>{info.reason}</p></div><div className="mt-4 flex items-center gap-2 border-t border-line pt-3 text-[10px] text-muted"><ShieldCheck className="h-3.5 w-3.5 text-accent"/>不自动安装 · 不请求管理员权限</div></Card>; })}</div>
    </>}
  </>;
}

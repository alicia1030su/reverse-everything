import { ArrowRight, ShieldCheck, X } from 'lucide-react';
import { Badge, Button, Card } from './ui';

export const safetyItems = [
  { title: '只读优先', detail: '默认只读取你提供的文件、公开资料与本机可读枚举；不会自动打开设备、串口或执行未知程序。' },
  { title: '授权责任', detail: '你确认拥有目标或已获得明确授权。工具不会绕过登录、付费、DRM、反作弊或其他访问控制。' },
  { title: 'AI 可能出错', detail: 'AI 解释只作为推断证据，不能替代工具结果、官方文档或独立复核。' },
  { title: '设备风险', detail: 'USB-C 外形、枚举成功或描述符可读都不代表存在调试接口；停止不安全的连接尝试。' },
  { title: '隐私边界', detail: '数据默认留在本机。启用远程 AI 前必须单独允许发送分析摘要，API Key 不会返回前端。' },
  { title: '许可证', detail: '本项目按 Apache-2.0 分发；第三方工具、固件、游戏与资料仍受各自许可证约束。' },
] as const;

export function SafetyNoticeContent({ compact = false }: { compact?: boolean }) {
  return <div className={compact ? 'space-y-3' : 'grid gap-3 sm:grid-cols-2'}>
    {safetyItems.map((item, index) => <div key={item.title} className="rounded-lg border border-line bg-panel2/50 p-3">
      <div className="flex items-center gap-2 text-xs font-medium text-slate-200"><span className="grid h-5 w-5 shrink-0 place-items-center rounded-md border border-accent/30 bg-accent/10 font-mono text-[10px] text-accent">{index + 1}</span>{item.title}</div>
      <p className="mt-2 text-[11px] leading-5 text-muted">{item.detail}</p>
    </div>)}
  </div>;
}

export default function SafetyNotice({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return <div className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-[rgb(var(--overlay)/.72)] p-4 backdrop-blur-sm">
    <section role="dialog" aria-modal="true" aria-labelledby="safety-notice-title" className="w-full max-w-3xl rounded-2xl border border-line bg-panel p-5 shadow-glow sm:p-7">
      <div className="flex items-start justify-between gap-4">
        <div><Badge tone="warn">首次使用 · 安全边界</Badge><h2 id="safety-notice-title" className="mt-3 text-xl font-semibold text-white">开始前，请了解这些限制</h2><p className="mt-2 text-sm leading-6 text-muted">逆向万物把授权、证据和未知项放在结论之前。以下规则适用于所有页面与演示。</p></div>
        <Button variant="ghost" aria-label="关闭安全提示" onClick={onClose}><X className="h-4 w-4"/></Button>
      </div>
      <div className="mt-6"><SafetyNoticeContent/></div>
      <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
        <span className="flex items-center gap-2 text-[11px] text-muted"><ShieldCheck className="h-3.5 w-3.5 text-accent"/>可随时在设置中心重新查看</span>
        <Button onClick={onClose}>我已知晓<ArrowRight className="h-4 w-4"/></Button>
      </div>
    </section>
  </div>;
}

export function SafetyNoticeCard() {
  return <Card className="p-5"><div className="flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-accent"/><h2 className="text-sm font-semibold text-white">安全、隐私与许可证</h2></div><p className="mt-2 text-xs leading-5 text-muted">这些限制适用于所有分析、演示和设备相关入口。</p><div className="mt-4"><SafetyNoticeContent compact/></div></Card>;
}

import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Activity, Boxes, ChevronRight, CirclePlus, Database, DatabaseBackup, FileSearch,
  FileText, FlaskConical, FolderKanban, Gamepad2, Gauge, KeyRound, LayoutDashboard, Menu, Moon, Network,
  PackageSearch, Settings, ShieldCheck, Sparkles, Sun, Usb, X,
} from 'lucide-react';
import { api } from '../api';
import Onboarding from './Onboarding';
import { useAiDataBoundary } from './AiDataBoundary';
import { Button } from './ui';

const themeKey = 'reverse-everything:theme';
const navigation = [
  {
    label: '分析工作区',
    items: [
      { to: '/', label: '总览', icon: LayoutDashboard, end: true },
      { to: '/wizard', label: '智能分析向导', icon: Sparkles },
      { to: '/new', label: '创建项目', icon: CirclePlus },
      { to: '/tasks', label: '任务工作台', icon: Activity },
      { to: '/evidence', label: '证据探索器', icon: FileSearch },
      { to: '/reports', label: '分析报告', icon: FileText },
    ],
  },
  {
    label: '专业分析',
    items: [
      { to: '/console-lab', label: '游戏主机分析', icon: Gamepad2 },
      { to: '/hardware', label: '硬件实验室', icon: Usb },
      { to: '/protocols', label: '协议分析中心', icon: Network },
      { to: '/revival', label: '游戏复活实验室', icon: FlaskConical },
      { to: '/security', label: '漏洞分析中心', icon: ShieldCheck },
      { to: '/validation', label: '重建与验证', icon: Boxes },
      { to: '/tools', label: '工具与依赖', icon: PackageSearch },
      { to: '/demos', label: '内置演示', icon: FlaskConical },
    ],
  },
  {
    label: '本地管理',
    items: [
      { to: '/projects', label: '项目档案', icon: FolderKanban },
      { to: '/authorizations', label: '授权管理', icon: KeyRound },
      { to: '/operations/system', label: '系统运维', icon: Gauge },
      { to: '/operations/backups', label: '备份中心', icon: DatabaseBackup },
      { to: '/settings', label: '设置中心', icon: Settings },
    ],
  },
];

type Theme = 'dark' | 'light';

function Brand() {
  return <div className="flex items-center gap-3">
    <div className="grid h-9 w-9 place-items-center rounded-lg border border-accent/30 bg-accent/10 font-mono text-sm font-bold text-accent">RE</div>
    <div><div className="text-sm font-semibold tracking-wide text-white">逆向万物</div><div className="font-mono text-[10px] tracking-wider text-muted">REVERSE EVERYTHING</div></div>
  </div>;
}

function Navigation({ onNavigate }: { onNavigate?: () => void }) {
  return <nav aria-label="主导航" className="space-y-5">
    {navigation.map(group => <div key={group.label}>
      <div className="px-3 pb-2 font-mono text-[10px] uppercase tracking-[.16em] text-muted">{group.label}</div>
      <div className="space-y-1">{group.items.map(({ to, label, icon: Icon, end }) => <NavLink
        key={to}
        to={to}
        end={Boolean(end)}
        onClick={onNavigate}
        className={({ isActive }) => `flex min-h-11 items-center gap-3 rounded-lg px-3 py-2.5 text-[13px] transition ${isActive ? 'bg-accent/10 text-accent' : 'text-slate-400 hover:bg-white/[.04] hover:text-slate-200'}`}
      ><Icon className="h-4 w-4 shrink-0"/>{label}</NavLink>)}</div>
    </div>)}
  </nav>;
}

export default function Layout() {
  const location = useLocation();
  const version = useQuery({ queryKey: ['version'], queryFn: api.version, staleTime: 60_000 });
  const aiBoundary = useAiDataBoundary();
  const [menuOpen, setMenuOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>(() => {
    try { return window.localStorage.getItem(themeKey) === 'light' ? 'light' : 'dark'; }
    catch { return 'dark'; }
  });
  const versionLabel = version.data ? `v${version.data.version}` : version.isLoading ? '版本读取中…' : '版本不可用';
  const currentItem = navigation.flatMap(group => group.items).find(item => item.to !== '/' && location.pathname.startsWith(item.to));

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { window.localStorage.setItem(themeKey, theme); } catch { /* 隐私模式不持久化主题。 */ }
  }, [theme]);
  useEffect(() => setMenuOpen(false), [location.pathname]);
  useEffect(() => {
    if (!menuOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenuOpen(false); };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [menuOpen]);

  return <div className="min-h-screen bg-ink">
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-[248px] flex-col border-r border-line bg-panel lg:flex">
      <div className="flex h-[76px] shrink-0 items-center border-b border-line px-5"><Brand/></div>
      <div className="flex-1 overflow-y-auto p-3"><Navigation/></div>
      <div className="shrink-0 border-t border-line p-4 text-[11px] text-muted">
        <div className="flex items-start gap-2" title={aiBoundary.label}><span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${aiBoundary.tone === 'warn' ? 'bg-amber-400' : 'bg-accent'}`}/><span>{aiBoundary.label}</span></div>
        <div className="mt-2 font-mono text-[10px] text-slate-600">{versionLabel} · Apache-2.0</div>
      </div>
    </aside>
    <div className="lg:pl-[248px]">
      <header className="sticky top-0 z-20 flex h-[68px] items-center justify-between border-b border-line bg-ink/90 px-4 backdrop-blur-xl sm:px-7">
        <div className="flex min-w-0 items-center gap-3">
          <Button variant="ghost" className="lg:hidden" aria-label="打开导航" aria-expanded={menuOpen} onClick={() => setMenuOpen(true)}><Menu className="h-5 w-5"/></Button>
          <div className="lg:hidden"><Brand/></div>
          <div className="hidden min-w-0 items-center gap-2 text-xs text-muted lg:flex"><Usb className="h-3.5 w-3.5"/>分析工作区<ChevronRight className="h-3 w-3 shrink-0"/><span className="truncate text-slate-300">{currentItem?.label ?? '总览'}</span></div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="hidden items-center gap-2 rounded-md border border-line bg-panel px-2.5 py-1.5 font-mono text-[10px] text-muted md:flex"><Database className="h-3 w-3"/>SQLite 持久化</span>
          <Button variant="ghost" aria-label={theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'} title={theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
            {theme === 'dark' ? <Sun className="h-4 w-4"/> : <Moon className="h-4 w-4"/>}
          </Button>
          <NavLink to="/wizard" className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-accent px-3 text-xs font-semibold text-ink"><Sparkles className="h-3.5 w-3.5"/>开始智能分析</NavLink>
        </div>
      </header>
      <main className="mx-auto max-w-[1500px] p-4 sm:p-7"><Outlet/></main>
    </div>
    {menuOpen && <div className="fixed inset-0 z-40 lg:hidden">
      <button type="button" aria-label="关闭移动导航遮罩" className="absolute inset-0 bg-[rgb(var(--overlay)/.65)]" onClick={() => setMenuOpen(false)}/>
      <section role="dialog" aria-modal="true" aria-label="移动导航" className="absolute inset-y-0 left-0 flex w-[min(84vw,320px)] flex-col border-r border-line bg-panel p-4 shadow-2xl">
        <div className="flex items-center justify-between border-b border-line pb-4"><Brand/><Button variant="ghost" aria-label="关闭导航" onClick={() => setMenuOpen(false)}><X className="h-5 w-5"/></Button></div>
        <div className="flex-1 overflow-y-auto py-5"><Navigation onNavigate={() => setMenuOpen(false)}/></div>
        <div className="space-y-1 border-t border-line pt-3 text-[11px] text-muted"><div>{aiBoundary.label}</div><div className="font-mono text-[10px] text-slate-600">{versionLabel}</div></div>
      </section>
    </div>}
    <Onboarding/>
  </div>;
}

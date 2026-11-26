import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { Badge } from './ui';

export function useAiDataBoundary() {
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings, staleTime: 15_000, refetchOnWindowFocus: true });
  if (settings.isLoading) return { label: '本地工作区 · AI 数据边界读取中…', tone: 'neutral' as const };
  if (settings.isError || !settings.data) return { label: 'AI 数据边界未知 · 请检查设置', tone: 'warn' as const };
  if (!settings.data.enabled) return { label: '本地工作区 · AI 未启用', tone: 'success' as const };
  if (settings.data.allowRemoteData) return { label: '远程 AI 已允许发送摘要', tone: 'warn' as const };
  return { label: 'AI 已启用 · 远程共享未允许', tone: 'info' as const };
}

export default function AiDataBoundary() {
  const boundary = useAiDataBoundary();
  return <Badge tone={boundary.tone}>{boundary.label}</Badge>;
}

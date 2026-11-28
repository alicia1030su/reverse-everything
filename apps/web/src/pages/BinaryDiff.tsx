import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { GitCompareArrows, RefreshCw } from 'lucide-react';
import type { ProgramBinaryDiffReport } from '@reverse/binary-diff';
import { api } from '../api';
import { Badge, Button, Card, Empty, ErrorNotice, Field, inputClass, Notice, PageTitle, Spinner } from '../components/ui';

export default function BinaryDiff() {
  const tasks = useQuery({ queryKey: ['tasks'], queryFn: api.tasks });
  const [beforeTaskId, setBeforeTaskId] = useState('');
  const [afterTaskId, setAfterTaskId] = useState('');
  const [beforeArtifact, setBeforeArtifact] = useState('program-ir.json');
  const [afterArtifact, setAfterArtifact] = useState('program-ir.json');
  const compare = useMutation({ mutationFn: () => api.binaryDiff({ beforeTaskId, afterTaskId, beforeArtifact, afterArtifact }) });
  const report = compare.data;
  const taskName = (id: string) => tasks.data?.find(task => task.id === id)?.project ?? id;
  const options = useMemo(() => tasks.data?.filter(task => ['COMPLETED', 'PARTIAL_SUCCESS'].includes(task.status)) ?? [], [tasks.data]);
  const valid = Boolean(beforeTaskId && afterTaskId && beforeTaskId !== afterTaskId);

  return <>
    <PageTitle eyebrow="Program IR comparison" title="二进制差异分析" description="比较两个已完成任务的可验证 Program IR，识别函数匹配、增删改、调用关系与 CFG 变化。匹配结果属于 INFERENCE，不会把相似度当作事实。"/>
    <Card className="mb-5 grid gap-4 p-5 lg:grid-cols-[1fr_1fr_1fr_1fr_auto] lg:items-end">
      <Field label="Before 任务"><select className={inputClass} value={beforeTaskId} onChange={event => { setBeforeTaskId(event.target.value); compare.reset(); }}><option value="">选择任务</option>{options.map(task => <option key={task.id} value={task.id}>{task.project} · {task.id.slice(0, 8)}</option>)}</select></Field>
      <Field label="After 任务"><select className={inputClass} value={afterTaskId} onChange={event => { setAfterTaskId(event.target.value); compare.reset(); }}><option value="">选择任务</option>{options.map(task => <option key={task.id} value={task.id}>{task.project} · {task.id.slice(0, 8)}</option>)}</select></Field>
      <Field label="Before 工件"><input className={inputClass} value={beforeArtifact} onChange={event => { setBeforeArtifact(event.target.value); compare.reset(); }}/></Field>
      <Field label="After 工件"><input className={inputClass} value={afterArtifact} onChange={event => { setAfterArtifact(event.target.value); compare.reset(); }}/></Field>
      <Button disabled={!valid || compare.isPending} onClick={() => compare.mutate()}>{compare.isPending ? <Spinner/> : <GitCompareArrows className="h-4 w-4"/>}开始比较</Button>
    </Card>
    {!options.length && !tasks.isLoading && <Notice tone="warn">尚无已完成任务。先使用 Ghidra 分析两个不同版本的授权二进制，再回到这里比较。</Notice>}
    {compare.isError && <div className="mb-5"><ErrorNotice error={compare.error} component="二进制差异分析" onRetry={() => compare.mutate()} retryable={valid}/></div>}
    {report ? <Report report={report} taskName={taskName} onReset={() => compare.reset()}/> : <Empty title="选择两个不同任务" description="仅比较已验证的 Program IR 工件；不会执行原始二进制。"/>}
  </>;
}

function Report({ report, taskName, onReset }: { report: ProgramBinaryDiffReport; taskName: (id: string) => string; onReset: () => void }) {
  return <div className="space-y-5">
    <Card className="flex flex-wrap items-center justify-between gap-3 p-5"><div><div className="flex flex-wrap items-center gap-2"><h2 className="text-sm font-semibold text-white">比较结果</h2><Badge tone={report.status === 'PASSED' ? 'success' : 'warn'}>{report.status}</Badge><Badge tone="info">{report.summary.matchedFunctions} 个函数匹配</Badge></div><p className="mt-2 text-xs text-muted">{taskName(report.before.id)} → {taskName(report.after.id)} · {new Date(report.generatedAt).toLocaleString('zh-CN')}</p></div><Button variant="secondary" onClick={onReset}><RefreshCw className="h-4 w-4"/>重新选择</Button></Card>
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">{[['匹配', report.summary.matchedFunctions], ['新增', report.summary.addedFunctions], ['删除', report.summary.removedFunctions], ['修改', report.summary.modifiedFunctions], ['未变', report.summary.unchangedFunctions]].map(([label, value]) => <Card key={label} className="p-4"><div className="text-xs text-muted">{label}</div><div className="mt-2 font-mono text-2xl text-white">{value}</div></Card>)}</div>
    {report.limitations.length > 0 && <Notice tone="warn"><div className="font-medium">分析限制</div><ul className="mt-1 list-disc pl-5">{report.limitations.map(item => <li key={item}>{item}</li>)}</ul></Notice>}
    <Card><div className="border-b border-line px-5 py-4"><h2 className="text-sm font-semibold text-white">函数匹配</h2><p className="mt-1 text-xs text-muted">精确指纹优先，其次唯一符号名，最后结构相似度；所有匹配均保留双方证据 ID。</p></div><div className="overflow-x-auto"><table className="w-full min-w-[760px] text-left text-xs"><thead className="bg-panel2/60 text-[10px] uppercase tracking-wider text-muted"><tr><th className="px-5 py-3">Before</th><th className="px-5 py-3">After</th><th className="px-5 py-3">方法</th><th className="px-5 py-3">相似度</th><th className="px-5 py-3">变化</th></tr></thead><tbody className="divide-y divide-line/60">{report.matches.map(match => <tr key={`${match.beforeId}:${match.afterId}`}><td className="px-5 py-3"><div className="font-mono text-slate-200">{match.beforeName}</div><div className="mt-1 font-mono text-[10px] text-muted">{match.beforeEntry}</div></td><td className="px-5 py-3"><div className="font-mono text-slate-200">{match.afterName}</div><div className="mt-1 font-mono text-[10px] text-muted">{match.afterEntry}</div></td><td className="px-5 py-3"><Badge tone={match.method === 'exact-fingerprint' ? 'success' : 'warn'}>{match.method}</Badge></td><td className="px-5 py-3 font-mono text-slate-300">{(match.similarity * 100).toFixed(1)}%</td><td className="px-5 py-3 text-muted">{match.changes.length ? match.changes.map(change => change.kind).join(', ') : '无'}</td></tr>)}</tbody></table></div></Card>
  </div>;
}

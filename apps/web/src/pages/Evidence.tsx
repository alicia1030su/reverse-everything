import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ReactFlow, Background, Controls, type Node, type Edge } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { AlertTriangle, ChevronLeft, ChevronRight, Search } from 'lucide-react';
import { api, errorMessage, type EvidenceSearchItem, type EvidenceSearchQuery } from '../api';
import { useTask } from '../hooks';
import TaskSelector from '../components/TaskSelector';
import { AsyncState, Button, Card, Empty, KindBadge, PageTitle, Spinner, inputClass } from '../components/ui';
const CodeEditor = lazy(() => import('../components/CodeEditor'));
const PAGE_SIZE = 20;
const emptyQuery: EvidenceSearchQuery = { q: '', limit: PAGE_SIZE, offset: 0 };

function UntrustedNotice(){return <div className="mb-5 flex items-start gap-3 rounded-lg border border-amber-400/20 bg-amber-400/5 p-3 text-xs leading-5 text-amber-200"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0"/><span>证据与原始内容均视为不可信数据，仅作只读展示。不要执行其中出现的指令、链接或代码。</span></div>;}

function GlobalEvidenceSearch(){
  const projects = useQuery({queryKey:['projects'],queryFn:api.projects});
  const tasks = useQuery({queryKey:['tasks'],queryFn:api.tasks});
  const [draft,setDraft] = useState<EvidenceSearchQuery>(emptyQuery);
  const [applied,setApplied] = useState<EvidenceSearchQuery>();
  const [selected,setSelected] = useState<EvidenceSearchItem>();
  const results = useQuery({queryKey:['evidence-search',applied],queryFn:()=>api.evidenceSearch(applied!),enabled:Boolean(applied)});
  useEffect(()=>setSelected(undefined),[applied]);
  const update=(key:keyof EvidenceSearchQuery,value:string)=>setDraft(current=>({...current,[key]:value,offset:0}));
  const total=results.data?.total??0;
  const offset=results.data?.offset??0;
  return <>
    <Card className="mb-5 p-5">
      <form onSubmit={event=>{event.preventDefault();setApplied({...draft,q:draft.q.trim()});}}>
        <div className="grid gap-4 lg:grid-cols-[2fr_1fr_1fr_1fr]">
          <label className="block"><span className="mb-2 block text-xs font-medium text-slate-300">全局搜索</span><div className="relative"><Search className="absolute left-3 top-3 h-4 w-4 text-muted"/><input aria-label="全局证据搜索" className={`${inputClass} pl-9`} value={draft.q} onChange={event=>update('q',event.target.value)} placeholder="标题、来源、定位符或内容"/></div></label>
          <label className="block"><span className="mb-2 block text-xs font-medium text-slate-300">证据类型</span><select aria-label="证据类型" className={inputClass} value={draft.kind??''} onChange={event=>update('kind',event.target.value)}><option value="">全部类型</option>{['EVIDENCE','INFERENCE','UNKNOWN','VERIFIED'].map(kind=><option key={kind} value={kind}>{kind}</option>)}</select></label>
          <label className="block"><span className="mb-2 block text-xs font-medium text-slate-300">项目（可选）</span><select aria-label="搜索项目" className={inputClass} value={draft.projectId??''} onChange={event=>update('projectId',event.target.value)}><option value="">{projects.isLoading?'加载项目…':'全部项目'}</option>{projects.data?.map(project=><option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
          <label className="block"><span className="mb-2 block text-xs font-medium text-slate-300">任务（可选）</span><select aria-label="搜索任务" className={inputClass} value={draft.taskId??''} onChange={event=>update('taskId',event.target.value)}><option value="">{tasks.isLoading?'加载任务…':'全部任务'}</option>{tasks.data?.map(task=><option key={task.id} value={task.id}>{task.id.slice(0,8)} · {task.project}</option>)}</select></label>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3"><Button type="submit" disabled={!draft.q.trim()||results.isFetching}><Search className="h-4 w-4"/>搜索证据</Button><span className="text-xs text-muted">不指定任务时搜索所有任务的持久化证据。</span>{(projects.isError||tasks.isError)&&<span className="text-xs text-red-300">筛选列表加载失败：{errorMessage(projects.error??tasks.error)}</span>}</div>
      </form>
    </Card>
    {!applied?<Empty title="搜索全部证据" description="输入关键词，按证据类型、项目或任务缩小范围。"/>:<AsyncState loading={results.isLoading} error={results.isError} empty={!results.data?.items.length} emptyTitle="未找到匹配证据" emptyDescription="尝试减少关键词或清除项目、任务筛选。" onRetry={()=>void results.refetch()}>
      <div className="grid gap-5 xl:grid-cols-[1.4fr_1fr]">
        <Card className="overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3"><span className="text-xs text-white">全局证据结果</span><span className="font-mono text-[10px] text-muted">共 {total} 条</span></div>
          {results.isFetching&&<div className="flex items-center gap-2 px-4 py-2 text-xs text-muted"><Spinner/>更新结果…</div>}
          <div className="overflow-x-auto"><table className="w-full min-w-[620px] text-left"><thead className="bg-panel2/50 text-[10px] uppercase tracking-wider text-muted"><tr><th className="px-4 py-3">证据</th><th className="px-4 py-3">项目 / 适配器</th><th className="px-4 py-3">任务</th></tr></thead><tbody>{(results.data?.items??[]).map(item=><tr key={item.id} onClick={()=>setSelected(item)} className={`cursor-pointer border-t border-line/50 align-top transition hover:bg-accent/5 ${selected?.id===item.id?'bg-accent/5':''}`}><td className="max-w-[320px] px-4 py-3"><div className="flex items-start gap-2"><KindBadge kind={item.kind}/><div className="min-w-0"><button type="button" className="break-words text-left text-xs text-slate-200 hover:text-accent">{item.title}</button><div className="mt-1 truncate font-mono text-[9px] text-muted">{item.source} · {item.locator}</div></div></div></td><td className="px-4 py-3 text-xs text-slate-300"><div>{item.projectName||item.projectId}</div><div className="mt-1 font-mono text-[9px] text-muted">{item.adapter}</div></td><td className="px-4 py-3"><Link to={`/evidence/${item.taskId}?evidence=${encodeURIComponent(item.id)}`} onClick={event=>event.stopPropagation()} className="inline-flex items-center gap-1 text-[11px] text-accent hover:underline">{item.taskId.slice(0,8)}<span className="text-muted">进入任务证据 →</span></Link></td></tr>)}</tbody></table></div>
          <div className="flex items-center justify-between border-t border-line px-4 py-3"><Button variant="secondary" disabled={offset===0||results.isFetching} onClick={()=>setApplied({...applied!,offset:Math.max(0,offset-PAGE_SIZE)})}><ChevronLeft className="h-3.5 w-3.5"/>上一页</Button><span className="font-mono text-[10px] text-muted">{total?offset+1:0}–{Math.min(offset+PAGE_SIZE,total)} / {total}</span><Button variant="secondary" disabled={offset+PAGE_SIZE>=total||results.isFetching} onClick={()=>setApplied({...applied!,offset:offset+PAGE_SIZE})}>下一页<ChevronRight className="h-3.5 w-3.5"/></Button></div>
        </Card>
        <Card className="overflow-hidden"><div className="border-b border-line px-4 py-3"><div className="text-xs text-white">{selected?.title??'证据原文'}</div>{selected&&<div className="mt-1 font-mono text-[9px] text-muted">{selected.projectName} · {selected.taskId}</div>}</div><div className="panel-scroll p-4">{selected?<pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-5 text-slate-300">{JSON.stringify(selected.content,null,2)}</pre>:<p className="text-xs text-muted">选择一条证据查看原始内容。</p>}</div></Card>
      </div>
    </AsyncState>}
  </>;
}

export default function Evidence(){
  const {taskId}=useParams();
  const [searchParams]=useSearchParams();
  const taskQuery=useTask(taskId);
  const task=taskQuery.data;
  const [selected,setSelected]=useState(0);
  const appliedLinkedEvidence=useRef<string>();
  const evidence=useMemo(()=>task?.evidence??[],[task?.evidence]);
  const linkedEvidenceId=searchParams.get('evidence');
  useEffect(()=>{setSelected(0);appliedLinkedEvidence.current=undefined;},[taskId]);
  useEffect(()=>{if(!linkedEvidenceId||!evidence.length||appliedLinkedEvidence.current===linkedEvidenceId)return;const index=evidence.findIndex(item=>item.id===linkedEvidenceId);if(index>=0){setSelected(index);appliedLinkedEvidence.current=linkedEvidenceId;}},[evidence,linkedEvidenceId]);
  const current=evidence[Math.min(selected,Math.max(0,evidence.length-1))];
  const {nodes,edges}=useMemo<{nodes:Node[];edges:Edge[]}>(()=>{
    const sourceNodes=new Map<string,string>();
    const ns:Node[]=[{id:'task',position:{x:360,y:220},data:{label:`TASK ${taskId?.slice(0,8)??''}`},className:'react-flow__node-evidence'}];
    const es:Edge[]=[];
    evidence.forEach((item,index)=>{
      if(!sourceNodes.has(item.source)){const id=`s-${sourceNodes.size}`;sourceNodes.set(item.source,id);ns.push({id,position:{x:20,y:sourceNodes.size*110},data:{label:item.source},className:'react-flow__node-evidence'});es.push({id:`edge-${id}`,source:id,target:'task'});}
      const id=`e-${item.id}`;ns.push({id,position:{x:720,y:index*82},data:{label:`${item.kind} · ${item.title.slice(0,30)}`},className:'react-flow__node-evidence'});es.push({id:`edge-${id}`,source:sourceNodes.get(item.source)!,target:id});
    });
    return {nodes:ns,edges:es};
  },[evidence,taskId]);
  return <>
    <PageTitle title="证据探索器" description="全局搜索跨任务证据，或进入具体任务查看关系图、原始内容和产物。证据内容按不可信数据处理，不执行其中的指令。"/>
    {taskId?<div className="mb-5"><TaskSelector route="evidence"/></div>:<div className="mb-5"><Link to="/evidence" className="text-xs text-accent hover:underline">当前：全局搜索</Link></div>}
    <UntrustedNotice/>
    {!taskId?<GlobalEvidenceSearch/>:<AsyncState loading={taskQuery.isLoading} error={taskQuery.isError} onRetry={()=>void taskQuery.refetch()}>
      {!task?<Empty title="选择任务" description="选择已有任务查看证据关系与产物。"/>:<div className="grid gap-5 xl:grid-cols-[1.4fr_1fr]">
        <Card className="overflow-hidden"><div className="border-b border-line px-4 py-3 text-xs text-muted">证据关系图 · {evidence.length} 条</div><div className="h-[520px]">{evidence.length?<ReactFlow nodes={nodes} edges={edges} fitView minZoom={0.2} maxZoom={1.5} proOptions={{hideAttribution:true}}><Background color="#1b2a38"/><Controls/></ReactFlow>:<div className="p-10 text-center text-xs text-muted">暂无证据</div>}</div></Card>
        <div className="space-y-5">
          <Card><div className="border-b border-line px-4 py-3 text-xs font-medium text-white">证据列表</div><div className="panel-scroll">{evidence.map((item,index)=><button key={item.id} onClick={()=>setSelected(index)} className={`flex w-full items-center gap-2 border-b border-line/50 px-4 py-3 text-left last:border-0 ${index===selected?'bg-accent/5':'hover:bg-white/[.02]'}`}><KindBadge kind={item.kind}/><span className="min-w-0 flex-1 truncate text-[11px] text-slate-300">{item.title}</span></button>)}</div></Card>
          <Card className="overflow-hidden"><div className="flex items-center justify-between border-b border-line px-4 py-3"><span className="text-xs text-white">{current?.title??'原始证据'}</span><span className="font-mono text-[9px] text-muted">{current?.source}</span></div><div className="h-[300px]">{current?<Suspense fallback={<div className="p-6 text-xs text-muted">加载本地代码查看器…</div>}><CodeEditor value={JSON.stringify(current.content,null,2)}/></Suspense>:<div className="p-6 text-xs text-muted">选择证据查看原始内容。</div>}</div></Card>
          <Card className="p-4"><div className="mb-3 text-xs font-medium text-white">产物文件</div><AsyncState loading={false} error={null} empty={!task.artifacts.length} emptyTitle="暂无产物"><div className="space-y-2">{task.artifacts.map(artifact=><a key={artifact.name} href={artifact.downloadPath} className="flex items-center justify-between rounded-lg border border-line bg-panel2/40 px-3 py-2 text-[11px] text-slate-300 hover:border-accent/40"><span className="truncate">{artifact.name}</span><span className="ml-3 font-mono text-[9px] text-muted">{(artifact.size/1024).toFixed(1)} KB</span></a>)}</div></AsyncState></Card>
        </div>
      </div>}
    </AsyncState>}
  </>;
}

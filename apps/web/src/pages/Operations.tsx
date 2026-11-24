import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { ArchiveRestore, DatabaseBackup, FileCheck2, ShieldAlert } from 'lucide-react';
import { api, errorMessage, request, type BackupPreview, type BackupVerification } from '../api';
import type { CacheEntry, CacheStatistics, Page } from '@reverse/contracts';
import { AsyncState, Badge, Button, Card, Field, PageTitle, Spinner, inputClass } from '../components/ui';

const titles:Record<string,string>={system:'系统状态',resources:'资源监控',cache:'缓存管理',maintenance:'数据保留',developer:'开发者接入',diagnostics:'诊断中心',backups:'备份中心'};
type ClearResult=Page<CacheEntry>&{skipped?:CacheEntry[]};

function BackupCenter(){
  const qc=useQueryClient();
  const backups=useQuery({queryKey:['backups'],queryFn:api.backups,refetchInterval:10000});
  const [confirmCreate,setConfirmCreate]=useState(false);
  const [confirmRestore,setConfirmRestore]=useState(false);
  const [selectedId,setSelectedId]=useState<string>();
  const [preview,setPreview]=useState<BackupPreview>();
  const [verification,setVerification]=useState<BackupVerification>();
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const invalidate=()=>void qc.invalidateQueries({queryKey:['backups']});
  const create=useMutation({mutationFn:api.createBackup,onSuccess:()=>{setConfirmCreate(false);setNotice('备份创建成功，已写入服务端备份目录。');setError('');invalidate();},onError:e=>setError(errorMessage(e))});
  const verify=useMutation({mutationFn:api.verifyBackup,onSuccess:result=>{setVerification(result);setSelectedId(result.backup.id);setPreview(undefined);setConfirmRestore(false);setError('');setNotice(result.valid?'备份完整性与 SQLite 校验通过。':'备份校验失败，请查看问题列表。');invalidate();},onError:e=>setError(errorMessage(e))});
  const previewBackup=useMutation({mutationFn:api.previewBackup,onSuccess:result=>{setPreview(result);setSelectedId(result.backup.id);setVerification(undefined);setConfirmRestore(false);setError('');setNotice('隔离预览已生成，尚未执行恢复。');},onError:e=>setError(errorMessage(e))});
  const restore=useMutation({mutationFn:api.restoreBackup,onSuccess:result=>{setPreview(result);setConfirmRestore(false);setError('');setNotice('隔离恢复完成。数据库仅写入预览所示的服务端隔离目录，当前运行库未被替换。');invalidate();},onError:e=>setError(errorMessage(e))});
  const busy=create.isPending||verify.isPending||previewBackup.isPending||restore.isPending;
  return <>
    <div className="mb-5 flex flex-wrap items-start justify-between gap-4"><div className="max-w-3xl"><div className="flex items-center gap-2 text-sm font-semibold text-white"><DatabaseBackup className="h-5 w-5 text-accent"/>数据库一致快照</div><p className="mt-2 text-xs leading-5 text-muted">备份包含 SQLite 数据库，不包含上传文件、任务产物或缓存载荷。验证会检查 SHA-256、Schema、SQLite 完整性与外键。</p></div><Button onClick={()=>{setConfirmCreate(true);setError('');setNotice('');}} disabled={busy}><DatabaseBackup className="h-4 w-4"/>创建备份</Button></div>
    <div className="mb-5 flex items-start gap-3 rounded-lg border border-sky-400/20 bg-sky-400/5 p-4 text-xs leading-5 text-sky-200"><ShieldAlert className="mt-0.5 h-4 w-4 shrink-0"/><span><strong>恢复边界：</strong>恢复只写入服务端自动分配的隔离目录，不会替换当前运行数据库，也不会自动切换服务。请先隔离预览，再单独确认恢复。</span></div>
    {confirmCreate&&<Card className="mb-5 border-amber-400/30 p-4"><div className="text-sm font-medium text-amber-200">确认创建当前数据库备份？</div><p className="mt-1 text-xs leading-5 text-muted">将生成 SQLite 一致快照并计算 SHA-256；不会删除或覆盖现有备份。</p><div className="mt-3 flex gap-2"><Button onClick={()=>create.mutate()} disabled={busy}>{create.isPending&&<Spinner/>}确认创建</Button><Button variant="secondary" onClick={()=>setConfirmCreate(false)} disabled={busy}>取消</Button></div></Card>}
    {error&&<div role="alert" className="mb-5 rounded-lg border border-red-400/20 bg-red-400/5 p-3 text-xs text-red-300">{error}</div>}
    {notice&&<div role="status" className="mb-5 rounded-lg border border-emerald-400/20 bg-emerald-400/5 p-3 text-xs text-emerald-300">{notice}</div>}
    <AsyncState loading={backups.isLoading} error={backups.isError} empty={!backups.data?.length} emptyTitle="尚无备份" emptyDescription="创建第一个一致快照后，可验证、隔离预览或恢复到独立目录。" onRetry={()=>void backups.refetch()}>
      <div className="space-y-3">{(backups.data??[]).map(backup=><Card key={backup.id} className="p-4">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-center">
          <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><span className="font-mono text-xs text-slate-200">{backup.id}</span><Badge tone={backup.status==='complete'?'success':'danger'}>{backup.status}</Badge><Badge>{backup.kind}</Badge><Badge tone="info">schema {backup.schemaVersion}</Badge></div><div className="mt-2 grid gap-1 text-[11px] text-muted sm:grid-cols-2"><span>创建时间：{new Date(backup.createdAt).toLocaleString('zh-CN')}</span><span>大小：{(backup.sizeBytes/1024).toFixed(1)} KB · {backup.fileCount} 个文件</span><span className="break-all font-mono text-[9px] sm:col-span-2">SHA-256：{backup.sha256}</span></div></div>
          <div className="flex flex-wrap gap-2"><Button variant="secondary" onClick={()=>verify.mutate(backup.id)} disabled={busy}>{verify.isPending&&verify.variables===backup.id?<Spinner/>:<FileCheck2 className="h-3.5 w-3.5"/>}验证</Button><Button variant="secondary" onClick={()=>previewBackup.mutate(backup.id)} disabled={busy||backup.status!=='complete'}>{previewBackup.isPending&&previewBackup.variables===backup.id?<Spinner/>:<ArchiveRestore className="h-3.5 w-3.5"/>}隔离预览</Button><Button variant="danger" title="请先隔离预览" onClick={()=>{setSelectedId(backup.id);setConfirmRestore(true);setError('');}} disabled={busy||backup.status!=='complete'||preview?.backup.id!==backup.id}>恢复到隔离目录</Button></div>
        </div>
      </Card>)}</div>
    </AsyncState>
    {verification&&<Card className="mt-5 p-4"><h2 className="text-sm font-semibold text-white">验证结果 · {verification.backup.id.slice(0,8)}</h2><Badge tone={verification.valid?'success':'danger'}>{verification.valid?'通过':'失败'}</Badge>{verification.issues.length>0&&<ul className="mt-3 space-y-1 text-xs text-red-300">{verification.issues.map(issue=><li key={issue}>· {issue}</li>)}</ul>}</Card>}
    {preview&&<Card className="mt-5 p-4"><h2 className="text-sm font-semibold text-white">隔离预览 · {preview.backup.id.slice(0,8)}</h2><div className="mt-3 rounded-lg border border-line bg-[#0a121b] p-3 font-mono text-[10px] text-slate-300"><div>目标目录：{preview.targetDir}</div>{preview.files.map(file=><div key={file.path}>{file.path} · {(file.sizeBytes/1024).toFixed(1)} KB</div>)}</div>{preview.warnings.length>0&&<ul className="mt-3 space-y-1 text-xs leading-5 text-amber-300">{preview.warnings.map(warning=><li key={warning}>· {warning}</li>)}</ul>}<p className="mt-3 text-xs text-muted">当前库保持不变；恢复仅生成可独立检查的数据库副本。</p>{confirmRestore&&selectedId===preview.backup.id&&<div className="mt-4 rounded-lg border border-red-400/30 bg-red-400/5 p-3"><div className="text-xs font-medium text-red-200">确认执行隔离恢复？服务端会分配新的隔离目录，不会替换当前库。</div><div className="mt-3 flex gap-2"><Button variant="danger" onClick={()=>restore.mutate(preview.backup.id)} disabled={busy}>{restore.isPending&&<Spinner/>}确认隔离恢复</Button><Button variant="secondary" onClick={()=>setConfirmRestore(false)} disabled={busy}>取消</Button></div></div>}</Card>}
  </>;
}

function CacheManager(){
  const qc=useQueryClient();
  const cache=useQuery({queryKey:['cache'],queryFn:()=>request<CacheStatistics>('/cache/stats'),refetchInterval:5000});
  const entries=useQuery({queryKey:['cache-entries'],queryFn:()=>request<Page<CacheEntry>>('/cache?limit=50')});
  const [result,setResult]=useState<ClearResult>();
  const [confirmClear,setConfirmClear]=useState(false);
  const [error,setError]=useState('');
  const clear=useMutation({mutationFn:(dryRun:boolean)=>request<ClearResult>('/cache/clear',{method:'POST',body:JSON.stringify({confirm:'CLEAR_CACHE',dryRun})}),onSuccess:data=>{setResult(data);setError('');void qc.invalidateQueries({queryKey:['cache']});void qc.invalidateQueries({queryKey:['cache-entries']});},onError:e=>setError(errorMessage(e))});
  return <>
    {error&&<div role="alert" className="mb-4 rounded-lg border border-red-400/20 bg-red-400/5 p-3 text-xs text-red-300">{error}</div>}
    {result&&<Card className="mb-5 p-4"><div className="text-sm font-semibold text-white">缓存清理结果</div><div className="mt-2 flex flex-wrap gap-2"><Badge tone="info">可清理 {result.total}</Badge><Badge tone="warn">跳过 {result.skipped?.length??'未返回'}</Badge></div>{result.skipped?.length?<div className="mt-3 space-y-2">{result.skipped.map(item=><div key={item.key} className="rounded border border-line bg-panel2/40 p-2 text-[10px] text-slate-400"><span className="font-mono">{item.key}</span> · {item.kind} · refCount={item.refCount}</div>)}</div>:<p className="mt-2 text-xs text-muted">被活动任务引用的条目会跳过；仅当 API 返回 skipped 列表时显示明细。</p>}</Card>}
    <div className="grid gap-5 lg:grid-cols-2">
      <Card className="p-5"><h2 className="text-sm font-semibold text-white">缓存统计</h2><AsyncState loading={cache.isLoading} error={cache.isError} onRetry={()=>void cache.refetch()}><CacheStats data={cache.data}/></AsyncState><div className="mt-4 flex gap-2"><Button variant="secondary" onClick={()=>clear.mutate(true)} disabled={clear.isPending}>{clear.isPending&&<Spinner/>}dry-run</Button><Button variant="danger" onClick={()=>setConfirmClear(true)} disabled={clear.isPending}>清理缓存</Button></div>{confirmClear&&<div className="mt-3 rounded-lg border border-red-400/30 bg-red-400/5 p-3"><div className="text-xs text-red-200">确认清理当前缓存？活动任务引用的条目会跳过，原始文件和正式证据不会删除。</div><div className="mt-3 flex gap-2"><Button variant="danger" onClick={()=>{setConfirmClear(false);clear.mutate(false);}} disabled={clear.isPending}>确认清理</Button><Button variant="secondary" onClick={()=>setConfirmClear(false)} disabled={clear.isPending}>取消</Button></div></div>}</Card>
      <Card className="p-5"><h2 className="text-sm font-semibold text-white">最近条目</h2><AsyncState loading={entries.isLoading} error={entries.isError} empty={!entries.data?.items.length} onRetry={()=>void entries.refetch()}>{entries.data?.items.length?<div className="mt-4 overflow-x-auto"><table className="w-full min-w-[440px] text-left text-[10px]"><thead className="text-muted"><tr><th className="py-2">key</th><th className="py-2">kind</th><th className="py-2">refCount</th></tr></thead><tbody>{entries.data.items.map(item=><tr key={item.key} className="border-t border-line/60"><td className="max-w-[220px] truncate py-2 font-mono text-slate-400" title={item.key}>{item.key}</td><td className="py-2 text-slate-300">{item.kind}</td><td className="py-2 font-mono text-slate-300">{item.refCount}</td></tr>)}</tbody></table></div>:null}</AsyncState></Card>
    </div>
  </>;
}

function CacheStats({data}:{data:CacheStatistics|undefined}){
  if(!data)return null;
  return <div className="mt-4 grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">{[['条目',data.entries],['大小',`${(data.sizeBytes/1024/1024).toFixed(2)} MB`],['命中率',`${(data.hitRate*100).toFixed(1)}%`],['损坏',data.corrupt],['命中',data.hits],['未命中',data.misses],['写入',data.writes],['淘汰',data.evictions]].map(([label,value])=><div key={String(label)} className="rounded-lg bg-panel2 p-3"><div className="text-muted">{label}</div><div className="mt-1 font-mono text-white">{value}</div></div>)}</div>;
}

export default function Operations(){
  const {section='system'}=useParams();
  const qc=useQueryClient();
  const [message,setMessage]=useState('');
  const title=titles[section]??'系统运维';
  const status=useQuery({queryKey:['system-status'],queryFn:()=>request<Record<string,unknown>>('/system/status'),refetchInterval:5000,enabled:section==='system'||section==='diagnostics'});
  const resources=useQuery({queryKey:['resources'],queryFn:()=>request<Record<string,unknown>>('/resources'),refetchInterval:3000,enabled:section==='resources'||section==='diagnostics'});
  const retention=useQuery({queryKey:['retention'],queryFn:()=>request<Record<string,unknown>>('/retention'),enabled:section==='maintenance'});
  const preview=useQuery({queryKey:['cleanup-preview'],queryFn:()=>request<Record<string,unknown>>('/maintenance/preview'),enabled:section==='maintenance'});
  const install=useQuery({queryKey:['browser-install'],queryFn:()=>request<Record<string,unknown>>('/system/browser/install'),refetchInterval:1500,enabled:section==='system'});
  const mutate=useMutation({mutationFn:(input:{url:string;method?:string;body?:unknown})=>request(input.url,{method:input.method??(input.body?'POST':'GET'),...(input.body?{body:JSON.stringify(input.body)}:{})}),onSuccess:data=>{setMessage(JSON.stringify(data,null,2));void qc.invalidateQueries();},onError:e=>setMessage(errorMessage(e))});
  return <>
    <PageTitle title={title} description="所有指标、备份、缓存统计和清理预览均来自真实后端；失败时显示真实错误。"/>
    {message&&<Card className="mb-5 p-4"><pre className="max-h-64 overflow-auto whitespace-pre-wrap font-mono text-xs text-slate-300">{message}</pre></Card>}
    {section==='backups'&&<BackupCenter/>}
    {section==='system'&&<div className="grid gap-5 lg:grid-cols-2"><Card className="p-5"><h2 className="text-sm font-semibold text-white">服务状态</h2><AsyncState loading={status.isLoading} error={status.isError} onRetry={()=>void status.refetch()}><pre className="mt-4 max-h-[520px] overflow-auto whitespace-pre-wrap font-mono text-xs leading-6 text-slate-300">{JSON.stringify(status.data,null,2)}</pre></AsyncState></Card><Card className="p-5"><h2 className="text-sm font-semibold text-white">分析浏览器</h2><p className="mt-2 text-xs text-muted">缺失时基础离线分析仍可用。下载必须由你主动触发。</p><div className="mt-4"><Badge tone={install.data?.status==='completed'?'success':install.data?.status==='failed'?'danger':'neutral'}>{String(install.data?.status??'idle')}</Badge></div><pre className="mt-3 max-h-48 overflow-auto font-mono text-[10px] text-muted">{Array.isArray(install.data?.progress)?install.data.progress.join('\n'):''}</pre><Button className="mt-4" disabled={install.data?.status==='running'||mutate.isPending} onClick={()=>mutate.mutate({url:'/system/browser/install',body:{confirm:true}})}>安装/修复 Chromium</Button></Card></div>}
    {section==='resources'&&<Card className="p-5"><div className="mb-4 flex items-center justify-between"><h2 className="text-sm font-semibold text-white">实时进程树与预算</h2><Button variant="secondary" onClick={()=>void resources.refetch()}>刷新</Button></div><AsyncState loading={resources.isLoading} error={resources.isError} onRetry={()=>void resources.refetch()}><pre className="max-h-[680px] overflow-auto whitespace-pre-wrap font-mono text-xs leading-6 text-slate-300">{JSON.stringify(resources.data,null,2)}</pre></AsyncState></Card>}
    {section==='cache'&&<CacheManager/>}
    {section==='maintenance'&&<div className="grid gap-5 lg:grid-cols-2"><Card className="p-5"><h2 className="text-sm font-semibold text-white">保留策略</h2><AsyncState loading={retention.isLoading} error={retention.isError} onRetry={()=>void retention.refetch()}><div className="mt-4 space-y-3">{retention.data&&Object.entries(retention.data).map(([key,value])=><Field key={key} label={key}><input className={inputClass} defaultValue={String(value)} id={`retention-${key}`}/></Field>)}</div><Button className="mt-4" onClick={()=>{const body=Object.fromEntries(Object.keys(retention.data??{}).map(key=>[key,Number((document.getElementById(`retention-${key}`) as HTMLInputElement).value)]));mutate.mutate({url:'/retention',method:'PUT',body});}}>保存策略</Button></AsyncState></Card><Card className="p-5"><h2 className="text-sm font-semibold text-white">清理预览</h2><AsyncState loading={preview.isLoading} error={preview.isError} onRetry={()=>void preview.refetch()}><pre className="mt-4 max-h-[520px] overflow-auto whitespace-pre-wrap font-mono text-[10px] text-slate-300">{JSON.stringify(preview.data,null,2)}</pre><Button variant="danger" className="mt-4" onClick={()=>{if(window.confirm('确认按预览执行清理？活动任务相关文件会被跳过。'))mutate.mutate({url:'/maintenance/apply',body:{confirm:'CLEAN'}});}}>执行确认清理</Button></AsyncState></Card></div>}
    {section==='developer'&&<div className="grid gap-5 md:grid-cols-2"><Card className="p-5"><h2 className="text-sm font-semibold text-white">API</h2><p className="mt-2 text-xs text-muted">/api/v1 与旧 /api 共用处理器。Bearer Token，OpenAPI 位于 /api/openapi.json。</p><a className="mt-4 inline-block text-xs text-accent" href="/api/openapi.json">下载 OpenAPI</a></Card><Card className="p-5"><h2 className="text-sm font-semibold text-white">MCP</h2><pre className="mt-3 overflow-x-auto rounded bg-[#09111a] p-3 font-mono text-[10px] text-slate-300">{JSON.stringify({command:'reverse-everything',args:['mcp','http','--port','4174'],env:{RE_API_URL:'http://127.0.0.1:4173'}},null,2)}</pre></Card><Card className="p-5"><h2 className="text-sm font-semibold text-white">Skill</h2><p className="mt-2 text-xs text-muted">解压 reverse-everything-skill-0.0.3.zip，运行 check-environment.mjs 后按 SKILL.md 工作流操作。</p></Card><Card className="p-5"><h2 className="text-sm font-semibold text-white">CLI / TGZ / EXE</h2><p className="mt-2 text-xs text-muted">全局安装 CLI TGZ；服务端 TGZ 需要 Node 22；Windows 安装包内置运行时，不要求预装 Node。</p></Card></div>}
    {section==='diagnostics'&&<Card className="p-5"><h2 className="text-sm font-semibold text-white">脱敏诊断快照</h2><p className="mt-2 text-xs text-muted">仅包含版本、能力和资源指标，不包含令牌或模型密钥。</p><AsyncState loading={status.isLoading||resources.isLoading} error={status.error??resources.error} onRetry={()=>{void status.refetch();void resources.refetch();}}><pre className="mt-4 max-h-[620px] overflow-auto whitespace-pre-wrap font-mono text-xs text-slate-300">{JSON.stringify({status:status.data,resources:resources.data},null,2)}</pre><Button variant="secondary" className="mt-4" onClick={()=>{const blob=new Blob([JSON.stringify({status:status.data,resources:resources.data},null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='reverse-everything-diagnostics.json';a.click();URL.revokeObjectURL(url);}}>导出诊断 JSON</Button></AsyncState></Card>}
  </>;
}

import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { inputClass } from './ui';
export default function TaskSelector({adapter,route}:{adapter?:string;route?:string}){const {taskId}=useParams();const navigate=useNavigate();const tasks=useQuery({queryKey:['tasks'],queryFn:api.tasks,refetchInterval:3000});const options=(tasks.data??[]).filter(t=>!adapter||t.adapter===adapter);return <select className={`${inputClass} max-w-sm`} value={taskId??''} onChange={e=>navigate(`/${route??adapter??'tasks'}/${e.target.value}`)}><option value="">选择一个任务…</option>{options.map(t=><option key={t.id} value={t.id}>{t.projectId.slice(0,8)} · {t.id.slice(0,8)} · {t.status}</option>)}</select>}

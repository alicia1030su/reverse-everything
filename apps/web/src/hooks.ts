import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
export function useTask(id:string|undefined){const qc=useQueryClient();const query=useQuery({queryKey:['task',id],queryFn:()=>api.task(id!),enabled:Boolean(id),refetchInterval:1500});useEffect(()=>{if(!id)return;const source=new EventSource(`/api/tasks/${id}/events`);const refresh=()=>void qc.invalidateQueries({queryKey:['task',id]});for(const type of ['task.updated','stage.updated','log'])source.addEventListener(type,refresh);source.addEventListener('snapshot',refresh);return()=>source.close();},[id,qc]);return query;}

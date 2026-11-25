import type { AiSettings, CreateProjectInput, Stats, TaskDetail, Task, Project, AdapterName, Evidence, Finding, Artifact, CapabilityInfo, Page, ProductInfo, BackupInfo, BackupPreview } from '@reverse/contracts';
export type EvidenceSearchItem=Evidence&{projectId:string;projectName:string;adapter:AdapterName};
export type EvidenceSearchResult=Page<EvidenceSearchItem>;
export interface BackupVerification {backup:BackupInfo;valid:boolean;issues:string[]}
export interface EvidenceSearchQuery {q:string;kind?:string;projectId?:string;taskId?:string;limit:number;offset:number}
export interface HardwareEndpoint {address:number;direction:'IN'|'OUT'|'UNKNOWN';number:number;transferType:string;interval?:number;maxPacketSize?:number}
export interface HardwareInterface {number:number;alternateSetting?:number;name?:string;class?:string;endpoints:HardwareEndpoint[]}
export interface HardwareDevice {identity:{stableKey:string;vendorId?:string;productId?:string;serialHash:string;identityHash:string;authorization:'REQUIRED'|'GRANTED'|'REVOKED'};product?:string;manufacturer?:string;version?:string;deviceClass?:string;speed?:string;bus?:string;deviceAddress?:string;topology?:Record<string,string|number>;configurations:unknown[];interfaces:HardwareInterface[];reportDescriptor?:Uint8Array;serialAccess:'OMITTED'}
export interface HardwareEnumeration {platform:string;status:'OK'|'UNSUPPORTED'|'BLOCKED'|'ERROR';devices:HardwareDevice[];serialPorts?:unknown[];capabilities:{usbEnumeration:string;serialListing:string;openDeviceHandles:false;liveCapture:false;serialOpen:false;administratorRequired:false;hidKeyboardCapture:'DISABLED'};limitations:string[];anomalies:string[];truncated:boolean}
export interface HardwareDoctor {platform:string;status:HardwareEnumeration['status'];deviceCount:number;capabilities:HardwareEnumeration['capabilities'];limitations:string[];anomalies:string[];truncated:boolean}
export interface HardwareSerialPort {identity:HardwareDevice['identity'];name:string;manufacturer?:string;driver?:string;subsystem?:string;opened:false}
export interface HardwareSerial {ports:HardwareSerialPort[];opened:false;liveCapture:false;limitations:string[]}
export function errorMessage(error:unknown):string{
  if(!(error instanceof Error))return String(error);
  try{const parsed=JSON.parse(error.message) as {error?:{message?:string;code?:string}};const detail=parsed.error;if(detail?.message)return detail.code?`${detail.code}: ${detail.message}`:detail.message;}catch{}
  return error.message;
}
export async function request<T>(url:string,init?:RequestInit):Promise<T>{const response=await fetch(`/api${url}`,{credentials:'same-origin',...init,headers:{...(init?.body&&typeof init.body==='string'?{'content-type':'application/json'}:{}),...init?.headers}});if(!response.ok){const text=await response.text();let message=text||`HTTP ${response.status}`;try{const parsed=JSON.parse(text) as {error?:{message?:string;code?:string}};if(parsed.error?.message)message=parsed.error.code?`${parsed.error.code}: ${parsed.error.message}`:parsed.error.message;}catch{}throw new Error(message);}const type=response.headers.get('content-type')??'';if(type.includes('application/json'))return response.json() as Promise<T>;return response.text() as Promise<T>;}
export const api={
  stats:()=>request<Stats>('/stats'),
  projects:()=>request<(Project&{uploads:number})[]>('/projects'),
  project:(id:string)=>request<Project&{uploads:unknown[]}>(`/projects/${id}`),
  tasks:()=>request<(Task&{project:string})[]>('/tasks'),
  task:(id:string)=>request<TaskDetail>(`/tasks/${id}`),
  adapters:()=>request<CapabilityInfo[]>('/adapters'),
  version:()=>request<ProductInfo>('/version'),
  evidenceSearch:(query:EvidenceSearchQuery)=>{const params=new URLSearchParams({q:query.q,limit:String(query.limit),offset:String(query.offset)});if(query.kind)params.set('kind',query.kind);if(query.projectId)params.set('projectId',query.projectId);if(query.taskId)params.set('taskId',query.taskId);return request<EvidenceSearchResult>(`/evidence/search?${params}`);},
  backups:()=>request<BackupInfo[]>('/backups'),
  createBackup:()=>request<BackupInfo>('/backups',{method:'POST',body:JSON.stringify({confirm:'CREATE_BACKUP'})}),
  verifyBackup:(id:string)=>request<BackupVerification>(`/backups/${encodeURIComponent(id)}/verify`),
  previewBackup:(id:string)=>request<BackupPreview>(`/backups/${encodeURIComponent(id)}/preview`,{method:'POST',body:'{}'}),
  restoreBackup:(id:string)=>request<BackupPreview>(`/backups/${encodeURIComponent(id)}/restore`,{method:'POST',body:JSON.stringify({confirm:'RESTORE_BACKUP'})}),
  createProject:(body:CreateProjectInput)=>request<Project>('/projects',{method:'POST',body:JSON.stringify(body)}),
  upload:(projectId:string,file:File)=>{const form=new FormData();form.append('file',file);return request<unknown>(`/projects/${projectId}/uploads`,{method:'POST',body:form});},
  createTask:(projectId:string,adapter:AdapterName,options:Record<string,unknown>={})=>request<Task>(`/projects/${projectId}/tasks`,{method:'POST',body:JSON.stringify({adapter,options})}),
  action:(id:string,action:string)=>request<Task>(`/tasks/${id}/${action}`,{method:'POST'}),
  settings:()=>request<AiSettings>('/settings'),
  saveSettings:(body:Record<string,unknown>)=>request('/settings',{method:'PUT',body:JSON.stringify(body)}),
  testSettings:()=>request<{ok:boolean;status?:number;error?:string}>('/settings/test',{method:'POST'}),
  demoTrace:()=>request<Blob>('/demo/trace').then(b=>new File([b],'captured-trace.json',{type:'application/json'})),
  hardwareDevices:()=>request<HardwareEnumeration>('/hardware/devices'),
  hardwareDoctor:()=>request<HardwareDoctor>('/hardware/doctor'),
  hardwareCapabilities:()=>request<HardwareEnumeration['capabilities']&{platform:string;status:HardwareEnumeration['status'];limitations:string[]}>('/hardware/capabilities'),
  hardwareSerial:()=>request<HardwareSerial>('/hardware/serial')
};
export type {TaskDetail,Task,Evidence,Finding,Artifact,BackupInfo,BackupPreview};

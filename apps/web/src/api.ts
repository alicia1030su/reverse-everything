import type { AiSettings, CreateProjectInput, Stats, TaskDetail, Task, Project, Upload, AdapterName, Evidence, Finding, Artifact, CapabilityInfo, Page, ProductInfo, BackupInfo, BackupPreview, ResourceSnapshot, GameProfile, GameRebuildRecord } from '@reverse/contracts';
import type { ConsoleDevice, ConsoleProfile, ConsoleSupportEntry, ConsoleUsbDiagnosis, OfficialDevelopmentEnvironment, UsbEnumerationSummary, ConsoleEvidence, ConsoleLevel, ActualAccess, ConsoleEvidenceKind } from '@reverse/console';
import type { AnalysisPlan, AnalyzerCapability, AnalyzerId, AuthorizationScope, PlanBudget, TargetKind } from '@reverse/planner';
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
export interface ConsoleDevicesResponse {items:ConsoleDevice[]}
export interface ConsoleDeviceResponse {device:ConsoleDevice;support:ConsoleSupportEntry}
export interface ConsoleSupportResponse {devices:ConsoleSupportEntry[];officialEnvironments:OfficialDevelopmentEnvironment[]}
export interface ConsoleProfileResponse {profile:ConsoleProfile}
export interface AuthorizationRecord {id:string;target:string;scope:string[];allowedInterfaces:string[];allowedOperations:string[];dataAccess:string[];remoteAiAllowed:boolean;expiresAt:string|null;createdAt:string;revokedAt:string|null}
export interface AuthorizationsResponse {items:AuthorizationRecord[]}
export interface CreateAuthorizationInput {target:string;scope:string[];allowedInterfaces:string[];allowedOperations:string[];dataAccess:string[];remoteAiAllowed?:boolean;expiresAt?:string}
export type PlanMode='beginner'|'professional'|'agent';
export interface PlanRecord {id:string;projectId:string;taskId:string|null;mode:PlanMode;target:AnalysisPlan['target'];detection:AnalysisPlan['target'];authorizationId:string|null;steps:AnalysisPlan['steps'];budget:PlanBudget;status:string;createdAt:string;updatedAt:string}
export interface PlansResponse {items:PlanRecord[]}
export interface CreatePlanInput {mode:PlanMode;objective:string;uploadId?:string;fileName?:string;size?:number;headHex?:string;declaredKind?:TargetKind;authorizationId?:string;authorization?:AuthorizationScope;budget?:Partial<PlanBudget>;maxSteps?:number;maxDepth?:number;adapterAllowlist?:AnalyzerId[]}
export interface ToolResponse {items:AnalyzerCapability[];note:string}
export interface DemoItem {name:string;title:string;description:string;kind:Project['kind'];adapter:AdapterName;target?:string}
export interface DemosResponse {items:DemoItem[]}
export interface DemoRunResponse {demo:string;projectId:string;taskId:string;runId:string}
export interface PlainReport {format:'markdown'|'json'|'html';content:string|Record<string,unknown>}
export interface ResourcesResponse {api:ResourceSnapshot;worker:ResourceSnapshot|null;desktop:ResourceSnapshot|null}
export function errorCode(error:unknown):string|undefined{const message=error instanceof Error?error.message:String(error);const match=/^([A-Z][A-Z0-9_]+):/.exec(message);return match?.[1];}
export function errorMessage(error:unknown):string{
  if(!(error instanceof Error))return String(error);
  try{const parsed=JSON.parse(error.message) as {error?:{message?:string;code?:string}};const detail=parsed.error;if(detail?.message)return detail.code?`${detail.code}: ${detail.message}`:detail.message;}catch{}
  return error.message;
}
export async function request<T>(url:string,init?:RequestInit):Promise<T>{const response=await fetch(`/api${url}`,{credentials:'same-origin',...init,headers:{...(init?.body&&typeof init.body==='string'?{'content-type':'application/json'}:{}),...init?.headers}});if(!response.ok){const text=await response.text();let message=text||`HTTP ${response.status}`;try{const parsed=JSON.parse(text) as {error?:{message?:string;code?:string}};if(parsed.error?.message)message=parsed.error.code?`${parsed.error.code}: ${parsed.error.message}`:parsed.error.message;}catch{}throw new Error(message);}const type=response.headers.get('content-type')??'';if(type.includes('application/json'))return response.json() as Promise<T>;return response.text() as Promise<T>;}
export const api={
  stats:()=>request<Stats>('/stats'),
  projects:()=>request<(Project&{uploads:number})[]>('/projects'),
  project:(id:string)=>request<Project&{uploads:Upload[]}>(`/projects/${id}`),
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
  upload:(projectId:string,file:File)=>{const form=new FormData();form.append('file',file);return request<Upload>(`/projects/${projectId}/uploads`,{method:'POST',body:form});},
  createTask:(projectId:string,adapter:AdapterName,options:Record<string,unknown>={})=>request<Task>(`/projects/${projectId}/tasks`,{method:'POST',body:JSON.stringify({adapter,options})}),
  action:(id:string,action:string)=>request<Task>(`/tasks/${id}/${action}`,{method:'POST'}),
  settings:()=>request<AiSettings>('/settings'),
  saveSettings:(body:Record<string,unknown>)=>request('/settings',{method:'PUT',body:JSON.stringify(body)}),
  testSettings:()=>request<{ok:boolean;status?:number;error?:string}>('/settings/test',{method:'POST'}),
  demoTrace:()=>request<Blob>('/demo/trace').then(b=>new File([b],'captured-trace.json',{type:'application/json'})),
  hardwareDevices:()=>request<HardwareEnumeration>('/hardware/devices'),
  hardwareDoctor:()=>request<HardwareDoctor>('/hardware/doctor'),
  hardwareCapabilities:()=>request<HardwareEnumeration['capabilities']&{platform:string;status:HardwareEnumeration['status'];limitations:string[]}>('/hardware/capabilities'),
  hardwareSerial:()=>request<HardwareSerial>('/hardware/serial'),
  consoleDevices:()=>request<ConsoleDevicesResponse>('/console/devices'),
  consoleDevice:(id:string)=>request<ConsoleDeviceResponse>(`/console/devices/${encodeURIComponent(id)}`),
  consoleSupport:()=>request<ConsoleSupportResponse>('/console/support'),
  diagnoseConsoleUsb:(summary:UsbEnumerationSummary)=>request<{diagnosis:ConsoleUsbDiagnosis}>('/console/diagnose-usb',{method:'POST',body:JSON.stringify(summary)}),
  consoleProfile:(id:string)=>request<ConsoleProfileResponse>(`/projects/${encodeURIComponent(id)}/console-profile`),
  saveConsoleProfile:(id:string,profile:ConsoleProfile)=>request<ConsoleProfileResponse>(`/projects/${encodeURIComponent(id)}/console-profile`,{method:'PUT',body:JSON.stringify(profile)}),
  authorizations:(id:string)=>request<AuthorizationsResponse>(`/projects/${encodeURIComponent(id)}/authorizations`),
  createAuthorization:(id:string,body:CreateAuthorizationInput)=>request<{id:string}>(`/projects/${encodeURIComponent(id)}/authorizations`,{method:'POST',body:JSON.stringify(body)}),
  revokeAuthorization:(id:string)=>request<{revoked:boolean}>(`/authorizations/${encodeURIComponent(id)}/revoke`,{method:'POST'}),
  plans:(id:string)=>request<PlansResponse>(`/projects/${encodeURIComponent(id)}/plans`),
  plan:(id:string)=>request<{plan:PlanRecord}>(`/plans/${encodeURIComponent(id)}`),
  createPlan:(id:string,body:CreatePlanInput)=>request<{plan:AnalysisPlan;status:string}>(`/projects/${encodeURIComponent(id)}/plans`,{method:'POST',body:JSON.stringify(body)}),
  executePlan:(id:string)=>request<{task:Task}>(`/plans/${encodeURIComponent(id)}/execute`,{method:'POST'}),
  tools:()=>request<ToolResponse>('/tools'),
  demos:()=>request<DemosResponse>('/demos'),
  runDemo:(name:string)=>request<DemoRunResponse>(`/demos/${encodeURIComponent(name)}/run`,{method:'POST'}),
  taskReportPlain:(id:string,format:'markdown'|'json'|'html'='markdown')=>request<PlainReport>(`/tasks/${encodeURIComponent(id)}/report/plain?format=${format}`),
  resources:()=>request<ResourcesResponse>('/resources'),
  gameProfiles:()=>request<{items:GameProfile[]}>('/game/profiles'),
  saveGameProfile:(id:string,value:Record<string,unknown>)=>request<{profile:GameProfile}>(`/projects/${encodeURIComponent(id)}/game-profile`,{method:'PUT',body:JSON.stringify(value)}),
  scanGame:(id:string,rootPath:string)=>request<{filesScanned:number;bytesScanned:number;truncated:boolean;files:unknown[];skipped:unknown[]}>(`/projects/${encodeURIComponent(id)}/game-scan`,{method:'POST',body:JSON.stringify({rootPath})}),
  createGameSpec:(id:string)=>request<{spec:{id:string;name:string;genre:string;level:string;modules:unknown[];limitations:string[]}}>(`/projects/${encodeURIComponent(id)}/game-spec`,{method:'POST',body:'{}'}),
  gameRebuilds:()=>request<{items:GameRebuildRecord[]}>('/game/rebuilds'),
  createGameRebuild:(specId:string)=>request<GameRebuildRecord>('/game/rebuilds',{method:'POST',body:JSON.stringify({specId})}),
  gameRebuild:(id:string)=>request<GameRebuildRecord>(`/game/rebuilds/${encodeURIComponent(id)}`)
};
export type {TaskDetail,Task,Evidence,Finding,Artifact,BackupInfo,BackupPreview,ConsoleDevice,ConsoleProfile,ConsoleSupportEntry,ConsoleUsbDiagnosis,UsbEnumerationSummary,ConsoleEvidence,ConsoleLevel,ActualAccess,ConsoleEvidenceKind,AnalyzerCapability,TargetKind,AnalyzerId,PlanBudget,AuthorizationScope};

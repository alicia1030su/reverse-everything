export type LegacyEvidenceStatus = 'EVIDENCE' | 'INFERENCE' | 'UNKNOWN' | 'VERIFIED';
export type LegacyFormat = 'PE' | 'ELF' | 'Mach-O' | 'MSI' | 'JAR' | 'Electron' | 'Python' | 'SQLite' | 'CSV' | 'DBF' | 'INI' | 'JSON' | 'XML' | 'Directory' | 'Unknown';
export interface LegacyFinding { id:string; severity:'info'|'low'|'medium'|'high'; title:string; detail:string; recommendation:string; evidenceStatus:LegacyEvidenceStatus }
export interface LegacySoftwareProfile {
  name:string; version:string; vendor:string; sourcePath:string; sha256:string; sizeBytes:number;
  formats:LegacyFormat[]; architecture:string; targetOs:string; runtimes:string[]; dependencies:string[];
  files:Array<{path:string;size:number;sha256:string}>; compatibility:LegacyFinding[];
  license:{status:'UNKNOWN'|'USER_DECLARED'|'OPEN_SOURCE'; name:string; source:string; notes:string[]};
  dataFormats:LegacyFormat[]; limitations:string[]; evidenceStatus:LegacyEvidenceStatus; truncated:boolean;
}
export interface LegacyAnalysis { profile:LegacySoftwareProfile; privacy:{localOnly:true;remoteAiUsed:false;networkRequired:string[];externalTools:string[];remoteAiNote:string}; summary:string }
export interface LegacyRecoveryResult { format:LegacyFormat; sourceSha256:string; outputDir:string; records:number; fields:string[]; preview:Array<Record<string,unknown>>; files:Array<{name:string;size:number;sha256:string}>; integrity:{sourceUnchanged:boolean;exportSha256:string}; limitations:string[]; evidenceStatus:LegacyEvidenceStatus; truncated:boolean }
export interface LegacyReconstructionSpec { id:string; name:string; kind:'ini-editor'|'csv-viewer'|'text-tool'|'data-converter'; requirements:string[]; sourceProfileSha256:string; evidenceStatus:LegacyEvidenceStatus; limitations:string[] }
export interface LegacyGeneratedProject { files:Map<string,string>; spec:LegacyReconstructionSpec }

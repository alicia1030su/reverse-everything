export type GameRevivalLevel = 'L0' | 'L1' | 'L2' | 'L3' | 'L4' | 'L5' | 'L6' | 'L7';
export type EvidenceStatus = 'OBSERVED' | 'INFERRED' | 'VERIFIED' | 'UNKNOWN' | 'INACCESSIBLE' | 'NOT_IMPLEMENTED';
export type GameModuleName = 'authentication' | 'rooms' | 'fps' | 'rpg' | 'movement' | 'combat' | 'inventory' | 'quests' | 'persistence' | 'reconnection' | 'settlement' | 'admin';

export interface EvidenceRef {
  path: string;
  detail: string;
}

export interface Evidence<T = unknown> {
  value: T;
  evidenceStatus: EvidenceStatus;
  evidenceRefs: EvidenceRef[];
}

export interface GameFileRecord {
  path: string;
  relativePath: string;
  size: number;
  mtimeMs: number;
  ctimeMs?: number;
  dev?: number | string;
  ino?: number | string;
  sha256?: string;
  extension: string;
  evidenceStatus: EvidenceStatus;
  evidenceRefs: EvidenceRef[];
}

export interface GameProfile {
  name: string;
  root: string;
  genre: 'fps' | 'rpg' | 'unknown';
  engine?: string;
  assets: string[];
  observations: EvidenceRef[];
  limitations: string[];
}

export interface GameServerSpec {
  id: string;
  name: string;
  genre: 'fps' | 'rpg';
  level: GameRevivalLevel;
  modules: Array<{ name: GameModuleName; evidenceStatus: EvidenceStatus; evidenceRefs: EvidenceRef[]; design: string }>;
  map: Evidence<{ name: string; width: number; height: number; obstacles: Array<{ x: number; y: number }> }>;
  rules: Evidence<Record<string, number | boolean | string>>;
  ports: Evidence<{ game: number; admin: number; adminHost: string }>;
  compatibility: Evidence<{ originalClient: 'UNKNOWN'; notes: string[] }>;
  files: GameFileRecord[];
  limitations: string[];
}

export interface GameScanSkipped {
  path: string;
  reason: string;
}

export interface GameScanResult {
  files: GameFileRecord[];
  filesScanned: number;
  bytesScanned: number;
  truncated: boolean;
  skipped: GameScanSkipped[];
}

export interface GameScanOptions {
  signal?: AbortSignal;
  maxFiles?: number;
  maxBytes?: number;
  previous?: GameFileRecord[] | GameScanResult;
}

export interface GameObservation {
  kind: 'fps' | 'rpg' | 'map' | 'rule' | 'engine' | 'client';
  value?: string | number | boolean | Record<string, number | boolean | string>;
  ref: string;
  detail: string;
  status?: EvidenceStatus;
}

export interface GameValidationCheck {
  id: string;
  name: string;
  passed: boolean;
  detail: string;
  durationMs?: number;
}

export interface GameValidationCapabilities {
  build: boolean;
  independentStart: boolean;
  twoPlayerSameMatch: boolean;
  roomIsolation: boolean;
  serverAuthoritativeState: boolean;
  persistence: boolean;
  reconnect: boolean;
  settlement: boolean;
  adminAuth: boolean;
  multiRoomConcurrency: boolean;
  dockerDeployment: boolean;
}

export interface GameValidationReport {
  schemaVersion: 1;
  valid: boolean;
  genre: 'fps' | 'rpg';
  gameMode: string;
  transport: 'websocket';
  clients: Array<{ kind: 'real-game-client' | 'simulated-load'; count: number }>;
  capabilities: GameValidationCapabilities;
  deployment?: { docker: { tested: boolean; command?: string; evidence?: string } };
  metrics?: { durationMs: number; rooms: number; players: number; rounds: number; loadClients: number };
  checks: GameValidationCheck[];
  projectDir: string;
  files: string[];
  sha256: string;
  errors: string[];
  startedAt: string;
  finishedAt: string;
}

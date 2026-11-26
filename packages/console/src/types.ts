export type ConsoleDeviceId =
  | 'ps5'
  | 'ps5-slim'
  | 'ps5-pro'
  | 'ps4'
  | 'xbox-series-x'
  | 'xbox-series-s'
  | 'xbox-one'
  | 'android-tv'
  | 'android-tv-box'
  | 'other-open-embedded';

export type ConsoleLevel = 'C0' | 'C1' | 'C2' | 'C3' | 'C4' | 'C5';
export type ConsoleEvidenceKind =
  | 'IDENTITY'
  | 'OFFICIAL_DOCUMENT'
  | 'READ_ONLY_ENUMERATION'
  | 'AUTHORIZED_INTERFACE_OBSERVATION'
  | 'FIRMWARE_SAMPLE'
  | 'AUTHORIZED_DEV_TEST'
  | 'CONTROLLED_REPRODUCTION';
export type ConsoleEvidenceVerification = 'USER_RECORDED' | 'TOOL_VERIFIED';
export type ActualAccess = 'NONE' | 'READ_ONLY' | 'AUTHORIZED_DEV_INTERFACE';
export type SupportState = 'OFFICIAL_PROGRAM' | 'DOCUMENTED_STANDARD_INTERFACE' | 'OEM_DEPENDENT' | 'NOT_ESTABLISHED';

export interface OfficialLink {
  label: string;
  url: string;
}

export interface ConsoleDevice {
  id: ConsoleDeviceId;
  manufacturer: string;
  series: string;
  model: string;
  officialDocs: OfficialLink[];
  capabilities: string[];
  limitations: string[];
}

export interface ConsoleEvidence {
  id: string;
  kind: ConsoleEvidenceKind;
  source: string;
  observedAt: string;
  description: string;
  sha256?: string;
  method?: string;
  /** User records are never trusted to raise a profile beyond C1. */
  verification?: ConsoleEvidenceVerification;
}

export interface ConsoleProfile {
  manufacturer: string;
  series: string;
  model: string;
  hardwareVersion: string;
  systemVersion: string;
  userProvidedInfo: string[];
  officialInterfaces: string[];
  authorizedDevEnvironments: string[];
  firmwareSamples: string[];
  knownCapabilities: string[];
  actualAccess: ActualAccess;
  researchEvidence: ConsoleEvidence[];
  currentLevel: ConsoleLevel;
  limitations: string[];
}

export interface UsbEnumerationSummary {
  osRecognized: boolean;
  descriptorReadable: boolean;
  normalInterfaceAvailable: boolean;
  connectorForm: 'USB-A' | 'USB-C' | 'MICRO_USB' | 'OTHER' | 'UNKNOWN';
  peerType: 'DEVELOPMENT_CONSOLE' | 'RETAIL_CONSOLE' | 'ANDROID_TV' | 'UNKNOWN';
  developerModeAuthorized: boolean;
  cableCondition: 'INTACT_STANDARD' | 'DAMAGED' | 'UNKNOWN';
}

export interface ConsoleUsbDiagnosis {
  osRecognized: boolean;
  descriptorReadable: boolean;
  normalInterfaceAvailable: boolean;
  supportedTopology: boolean;
  needsOfficialDevEnvironment: boolean;
  needsOfflineSample: boolean;
  hardwareSafetyRisk: boolean;
  findings: string[];
  nextSteps: string[];
}

export interface ConsoleLevelDefinition {
  level: ConsoleLevel;
  name: string;
  requiredEvidence: ConsoleEvidenceKind[];
  requirements: string[];
  allows: string[];
  prohibits: string[];
}

export interface ConsoleSupportEntry {
  deviceId: ConsoleDeviceId;
  researchSupport: SupportState;
  offlineSampleAnalysis: SupportState;
  officialEnvironment: string;
  officialDocs: OfficialLink[];
  limitations: string[];
}

export interface OfficialDevelopmentEnvironment {
  deviceIds: ConsoleDeviceId[];
  name: string;
  access: string;
  description: string;
  docs: OfficialLink[];
  operationsExecuted: false;
}

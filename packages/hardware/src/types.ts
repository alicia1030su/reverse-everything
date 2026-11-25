export const UNKNOWN='UNKNOWN' as const;
export type PlatformStatus='OK'|'UNSUPPORTED'|'BLOCKED'|'ERROR';
export type DeviceAuthorization='REQUIRED'|'GRANTED'|'REVOKED';

export interface DeviceIdentity {
  stableKey:string;
  vendorId?:string;
  productId?:string;
  serialHash:string;
  identityHash:string;
  authorization:DeviceAuthorization;
}
export interface UsbEndpoint {
  address:number;
  direction:'IN'|'OUT'|'UNKNOWN';
  number:number;
  transferType:'CONTROL'|'ISOCHRONOUS'|'BULK'|'INTERRUPT'|'UNKNOWN';
  interval?:number;
  maxPacketSize?:number;
}
export interface UsbInterface {
  number:number;
  alternateSetting?:number;
  name?:string;
  nameHash?:string;
  class?:string;
  subclass?:string;
  protocol?:string;
  endpoints:UsbEndpoint[];
}
export interface UsbConfiguration {
  value:string;
  valueHash?:string;
  configurationValue?:string;
  attributes?:string;
  maxPower?:string;
}
export interface UsbDevice {
  identity:DeviceIdentity;
  product?:string;
  productHash?:string;
  manufacturer?:string;
  manufacturerHash?:string;
  version?:string;
  deviceClass?:string;
  deviceSubclass?:string;
  deviceProtocol?:string;
  speed?:string;
  bus?:string;
  deviceAddress?:string;
  topology?:Record<string,string|number>;
  configurations:UsbConfiguration[];
  interfaces:UsbInterface[];
  reportDescriptor?:Uint8Array;
  serialAccess:'OMITTED';
}
export interface HidReport {
  valid:boolean;
  bytes:number;
  usagePage?:string;
  usagePages:string[];
  usages:string[];
  usageMinimum?:number;
  usageMaximum?:number;
  logicalMinimum?:number;
  logicalMaximum?:number;
  reportSize?:number;
  reportCount?:number;
  collections:string[];
  keyboardCaptureDefault:'DISABLED';
  anomalies:string[];
  truncated:boolean;
}
export interface SerialPort {
  identity:DeviceIdentity;
  name:string;
  manufacturer?:string;
  manufacturerHash?:string;
  driver?:string;
  driverHash?:string;
  subsystem?:string;
  opened:false;
}
export type DeviceEventType='connect'|'disconnect'|'reconnect';
export interface DeviceEvent {
  type:DeviceEventType;
  device?:UsbDevice;
  stableKey:string;
  authorizationRequired:boolean;
  reason:string;
}
export interface UsbCaptureRecord {
  recordIndex:number;
  format:'PCAP'|'PCAPNG'|'USBMON';
  encapsulation?:'USBPcap'|'USB_RAW'|'USB_LINUX'|'USB_LINUX_MMAPPED';
  timestamp:string;
  timestampMicros:number;
  bus:string;
  device:string;
  deviceAddress:string;
  interfaceNumber:string|number;
  interfaceAlternateSetting:string|number;
  endpoint:string;
  endpointNumber:string|number;
  direction:'IN'|'OUT'|'UNKNOWN';
  transferType:string;
  status:string;
  function?:string;
  irpId?:string;
  responseTo?:string;
  info?:string;
  length:number;
  dataLength:number;
  capturedLength:number;
  dataTruncated:boolean;
  dataOffset:number|string;
  rawOffset:number;
  rawLength:number;
  payloadSha256:string;
  anomalies:string[];
  isoPacketCount?:number;
  isoErrorCount?:number;
  interval?:number;
  startFrame?:number;
  controlStage?:number;
  setup?:{bmRequestType:string;bRequest:number;wValue:number;wIndex:number;wLength:number};
  descriptorCandidate?:import('./capture.js').DescriptorCandidate;
}
export interface PlatformCapabilities {
  usbEnumeration:'AVAILABLE'|'UNSUPPORTED'|'BLOCKED';
  serialListing:'AVAILABLE'|'UNSUPPORTED'|'BLOCKED';
  openDeviceHandles:false;
  liveCapture:false;
  serialOpen:false;
  administratorRequired:false;
  hidKeyboardCapture:'DISABLED';
}
export interface EnumerationResult {
  platform:NodeJS.Platform;
  status:PlatformStatus;
  devices:UsbDevice[];
  serialPorts?:SerialPort[];
  capabilities:PlatformCapabilities;
  limitations:string[];
  anomalies:string[];
  truncated:boolean;
}

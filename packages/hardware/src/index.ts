import { detectUsbFormat, parseUsbCapture, parseUsbmon, type CaptureLimits, type UsbCaptureAnalysis } from './capture.js';
import { parseHidReportDescriptor } from './hid.js';
import { deviceIdentity } from './identity.js';
import { UNKNOWN, type UsbDevice } from './types.js';
export * from './types.js';
export * from './capture.js';
export * from './hid.js';
export * from './identity.js';
export * from './hotplug.js';
export * from './enumerate.js';

export interface HardwareInputAnalysis {
  format:'PCAP'|'PCAPNG'|'USBMON'|'HID_DESCRIPTOR'|'SNAPSHOT';
  capture?:UsbCaptureAnalysis;
  descriptor?:ReturnType<typeof parseHidReportDescriptor>;
  snapshot?:{platform:string;deviceCount:number;devices:UsbDevice[];status:string};
  keyboardCaptureDefault:'DISABLED';
  limitations:string[];
}
/** Validates untrusted snapshots against the public enumeration shape and discards unexpected fields. */
export async function inspectHardwareInput(bytes:Buffer,name:string,options:CaptureLimits={}):Promise<HardwareInputAnalysis> {
  const format=detectUsbFormat(name,bytes.subarray(0,64));if(!format)throw new Error('Hardware adapter supports USB PCAP, PCAPNG, usbmon text, HID report descriptors and enumeration snapshots');
  if(format==='PCAP'||format==='PCAPNG')return {format,capture:await parseUsbCapture(bytes,options),keyboardCaptureDefault:'DISABLED',limitations:['Offline capture analysis only; no live capture or device access']};
  if(format==='HID_DESCRIPTOR')return {format,descriptor:parseHidReportDescriptor(bytes),keyboardCaptureDefault:'DISABLED',limitations:['Descriptor metadata is parsed; report capture and keystroke decoding are disabled']};
  if(format==='USBMON')return {format,capture:parseUsbmon(bytes.toString('utf8'),options),keyboardCaptureDefault:'DISABLED',limitations:['Offline usbmon text analysis only']};
  if(bytes.length>1_000_000)throw new Error('Snapshot exceeds the 1000000 byte bound');
  const parsed=JSON.parse(bytes.toString('utf8')) as Record<string,unknown>;if(!parsed||typeof parsed!=='object'||!Array.isArray(parsed.devices))throw new Error('Malformed hardware snapshot: devices must be an array');
  if(parsed.devices.length>5_000)throw new Error('Snapshot device count exceeds 5000');const devices:UsbDevice[]=[];
  for(const [index,value] of parsed.devices.entries()){
    if(!value||typeof value!=='object')throw new Error(`Malformed hardware snapshot: device ${index} is not an object`);const device=value as Record<string,unknown>,identity=device.identity;
    if(!identity||typeof identity!=='object'||typeof (identity as Record<string,unknown>).stableKey!=='string')throw new Error(`Malformed hardware snapshot: device ${index} identity is missing`);
    const raw=identity as Record<string,unknown>,vid=typeof raw.vendorId==='string'?raw.vendorId:undefined,pid=typeof raw.productId==='string'?raw.productId:undefined;
    devices.push({identity:deviceIdentity({stableKey:String(raw.stableKey).slice(0,512),...(vid?{vendorId:vid}:{}),...(pid?{productId:pid}:{}),...(typeof raw.serialHash==='string'?{serialHash:raw.serialHash}:{})}),...(typeof device.product==='string'?{product:device.product.slice(0,256)}:{}),...(typeof device.manufacturer==='string'?{manufacturer:device.manufacturer.slice(0,256)}:{}),...(typeof device.speed==='string'?{speed:device.speed}:{}),configurations:Array.isArray(device.configurations)?device.configurations.slice(0,32).flatMap(value=>{if(!value||typeof value!=='object'||typeof (value as Record<string,unknown>).value!=='string')return [];const configuration=value as Record<string,unknown>;return [{value:String(configuration.value).slice(0,256),...(typeof configuration.configurationValue==='string'?{configurationValue:configuration.configurationValue.slice(0,32)}:{})}];}):[],interfaces:Array.isArray(device.interfaces)?device.interfaces.slice(0,256) as UsbDevice['interfaces']:[],serialAccess:'OMITTED'});
  }
  return {format,snapshot:{platform:typeof parsed.platform==='string'?parsed.platform:UNKNOWN,status:typeof parsed.status==='string'?parsed.status:UNKNOWN,deviceCount:devices.length,devices},keyboardCaptureDefault:'DISABLED',limitations:['Uploaded snapshot is metadata only; it does not grant permission to access devices']};
}

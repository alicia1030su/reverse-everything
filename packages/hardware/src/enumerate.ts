import { execFile } from 'node:child_process';
import { readdir, readFile, readlink } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { deviceIdentity, hashIdentity } from './identity.js';
import { UNKNOWN, type EnumerationResult, type PlatformCapabilities, type SerialPort, type UsbDevice, type UsbEndpoint, type UsbInterface } from './types.js';

const run=promisify(execFile);
/** Fixed read-only query. Only VID/PID-shaped HardwareID entries and a one-way instance hash leave PowerShell. */
export const WINDOWS_HARDWARE_SCRIPT=`$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$usb=@(Get-CimInstance Win32_PnPEntity | Where-Object { $_.PNPClass -eq 'USB' -or $_.Name -like 'USB *' } | ForEach-Object {
  $hardwareIds=@($_.HardwareID | Where-Object { $_ -cmatch '^USB\\\\VID_[0-9A-Fa-f]{4}&PID_[0-9A-Fa-f]{4}(?:&REV_[0-9A-Fa-f]{4})?$' } | Select-Object -Unique)
  $instanceHash=''
  if($_.DeviceID){
    $sha=[System.Security.Cryptography.SHA256]::Create()
    try{$instanceHash=([System.BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes([string]$_.DeviceID)))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
  }
  [ordered]@{ name=$_.Name; manufacturer=$_.Manufacturer; status=$_.Status; service=$_.Service; pnpClass=$_.PNPClass; hardwareIds=$hardwareIds; instanceHash=$instanceHash }
})
$serial=@(Get-CimInstance Win32_SerialPort | ForEach-Object {
  [ordered]@{ name=$_.Name; manufacturer=$_.Manufacturer; driver=$_.DriverName; status=$_.Status }
})
[ordered]@{ usb=$usb; serial=$serial } | ConvertTo-Json -Depth 4 -Compress`;
const WINDOWS_HARDWARE_ID=/^USB\\VID_([0-9a-f]{4})&PID_([0-9a-f]{4})(?:&REV_[0-9a-f]{4})?$/i;
function arrayValue(value:unknown):unknown[]{return Array.isArray(value)?value:value?[value]:[];}
const DEFAULT_CAPABILITIES:PlatformCapabilities={usbEnumeration:'AVAILABLE',serialListing:'AVAILABLE',openDeviceHandles:false,liveCapture:false,serialOpen:false,administratorRequired:false,hidKeyboardCapture:'DISABLED'};
export interface EnumerateOptions { platform?:NodeJS.Platform;sysfsRoot?:string;timeoutMs?:number;maxOutputBytes?:number;maxDevices?:number;signal?:AbortSignal }
function capabilities(platform:string,_status:EnumerationResult['status']):PlatformCapabilities {
  if(platform==='win32')return {...DEFAULT_CAPABILITIES};
  if(platform==='linux')return {...DEFAULT_CAPABILITIES};
  return {...DEFAULT_CAPABILITIES,usbEnumeration:'UNSUPPORTED',serialListing:'UNSUPPORTED'};
}
export async function enumerateDevices(options:EnumerateOptions={}):Promise<EnumerationResult> {
  const platform=options.platform??process.platform;
  if(options.signal?.aborted)throw options.signal.reason;
  if(platform==='darwin')return {platform,status:'UNSUPPORTED',devices:[],capabilities:capabilities(platform,'UNSUPPORTED'),limitations:['macOS USB enumeration is BLOCKED/UNSUPPORTED in this build; no IOKit device handles are opened'],anomalies:[],truncated:false};
  if(platform==='win32')return enumerateWindows(options);
  if(platform==='linux')return enumerateLinux(options);
  return {platform,status:'UNSUPPORTED',devices:[],capabilities:capabilities(platform,'UNSUPPORTED'),limitations:[`${platform} USB enumeration is unsupported`],anomalies:[],truncated:false};
}
export function parseWindowsHardwareOutput(output:string,maxDevices=1_000):{devices:UsbDevice[];serialPorts:SerialPort[];truncated:boolean} {
  const parsed=JSON.parse(output) as {usb?:unknown;serial?:unknown};if(!parsed||typeof parsed!=='object')throw new Error('Malformed Windows CIM output');
  const rawUsb=arrayValue(parsed.usb),rawSerial=arrayValue(parsed.serial),bound=Math.min(Math.max(Math.floor(maxDevices),0),5_000),devices:UsbDevice[]=[],serialPorts:SerialPort[]=[];
  for(const [index,entry] of rawUsb.entries()){
    if(index>=bound)break;if(!entry||typeof entry!=='object')continue;const item=entry as Record<string,unknown>,name=text(item.name),manufacturer=text(item.manufacturer);
    let vendorId:string|undefined,productId:string|undefined;for(const value of arrayValue(item.hardwareIds)){if(typeof value!=='string')continue;const match=WINDOWS_HARDWARE_ID.exec(value);if(match){vendorId=match[1]!.toLowerCase();productId=match[2]!.toLowerCase();break;}}
    const instanceHash=typeof item.instanceHash==='string'&&/^[a-f0-9]{64}$/i.test(item.instanceHash)?item.instanceHash.toLowerCase():hashIdentity('windows-pnp',vendorId,productId,index);
    const stableKey=`win32:${instanceHash}:${vendorId??UNKNOWN}:${productId??UNKNOWN}`,identity=deviceIdentity({stableKey,...(vendorId?{vendorId}:{}),...(productId?{productId}:{}),authorization:'REQUIRED'});
    devices.push({identity,product:`USB ${vendorId??UNKNOWN}:${productId??UNKNOWN}`,...(name?{productHash:hashIdentity(name)}:{}),...(manufacturer?{manufacturerHash:hashIdentity(manufacturer)}:{}),configurations:[],interfaces:[],serialAccess:'OMITTED'});
  }
  for(const [index,entry] of rawSerial.entries()){
    if(index>=bound)break;if(!entry||typeof entry!=='object')continue;const item=entry as Record<string,unknown>,name=windowsSerialName(item.name),manufacturer=text(item.manufacturer),driver=text(item.driver);
    serialPorts.push({identity:deviceIdentity({instance:`windows-serial:${name}:${index}`}),name,...(manufacturer?{manufacturerHash:hashIdentity(manufacturer)}:{}),...(driver?{driverHash:hashIdentity(driver)}:{}),opened:false});
  }
  return {devices,serialPorts,truncated:rawUsb.length>bound||rawSerial.length>bound};
}
async function enumerateWindows(options:EnumerateOptions):Promise<EnumerationResult> {
  const timeoutMs=Math.min(Math.max(options.timeoutMs??10_000,100),30_000),maxOutputBytes=Math.min(options.maxOutputBytes??4_000_000,8_000_000),maxDevices=Math.min(options.maxDevices??1_000,5_000);
  try{
    const {stdout}=await run('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',WINDOWS_HARDWARE_SCRIPT],{timeout:timeoutMs,maxBuffer:maxOutputBytes,windowsHide:true,encoding:'utf8'});
    if(Buffer.byteLength(stdout)>maxOutputBytes)throw new Error('OUTPUT_LIMIT');
    const {devices,serialPorts,truncated}=parseWindowsHardwareOutput(stdout,maxDevices);
    return {platform:'win32',status:'OK',devices,serialPorts,capabilities:capabilities('win32','OK'),limitations:['Windows enumeration queries VID/PID-shaped HardwareID values only; serial-bearing IDs and serial properties are never returned','No device handles are opened and no live capture is performed'],anomalies:[],truncated};
  }catch(error){
    const code=(error as NodeJS.ErrnoException).code,message=(error as Error).message;const blocked=code==='OUTPUT_LIMIT'||/ENOBUFS|maxBuffer/i.test(message);
    return {platform:'win32',status:blocked?'BLOCKED':'ERROR',devices:[],capabilities:{...capabilities('win32','ERROR'),usbEnumeration:blocked?'BLOCKED':'UNSUPPORTED',serialListing:blocked?'BLOCKED':'UNSUPPORTED'},limitations:[blocked?`PowerShell output exceeded ${maxOutputBytes} bytes`:`Windows read-only CIM query failed: ${code??'QUERY_ERROR'}`],anomalies:[blocked?'OUTPUT_LIMIT':code==='ETIMEDOUT'?'TIMEOUT':'POWERSHELL_ERROR'],truncated:blocked};
  }
}
export async function enumerateSerialPorts(options:EnumerateOptions={}):Promise<SerialPort[]> {
  const platform=options.platform??process.platform;
  if(platform==='win32')return (await enumerateWindows(options)).serialPorts??[];
  if(platform==='linux'){
    const result=await enumerateLinux(options),ports:SerialPort[]=[];const root=options.sysfsRoot??'/sys/class/tty';
    try{for(const name of (await readdir(root)).slice(0,options.maxDevices??1_000)){if(!/^(tty(?:USB|ACM|S|AMA)\d+)$/.test(name))continue;const identity=deviceIdentity({instance:`linux-serial:${name}`});ports.push({identity,name,opened:false});}}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    void result;return ports;
  }
  return [];
}
function text(value:unknown):string|undefined { return typeof value==='string'&&value.trim()?value.trim().slice(0,256):undefined; }
function windowsSerialName(value:unknown):string { const name=text(value)??'';const match=/\bCOM\d+\b/i.exec(name);return match?match[0].toUpperCase():'Serial port'; }
async function readSmall(file:string,max=4096):Promise<Buffer|undefined>{try{const data=await readFile(file);return data.subarray(0,max);}catch(error){if(['ENOENT','EACCES','EPERM','EIO'].includes((error as NodeJS.ErrnoException).code??''))return undefined;throw error;}}
async function readText(file:string):Promise<string|undefined>{const data=await readSmall(file);return data?.toString('utf8').trim();}
function hex(value:string|undefined):string|undefined { return value&&/^[a-f0-9]{4}$/i.test(value)?value.toLowerCase():undefined; }
function decimal(value:string|undefined):number|undefined { if(!value||!/^\d+$/.test(value))return undefined;const parsed=Number(value);return Number.isSafeInteger(parsed)&&parsed<=0xffff?parsed:undefined; }
export async function enumerateLinux(options:EnumerateOptions={}):Promise<EnumerationResult> {
  const root=options.sysfsRoot??'/sys/bus/usb/devices',maxDevices=Math.min(options.maxDevices??1_000,5_000),devices:UsbDevice[]=[],anomalies:string[]=[];let truncated=false;
  let names:string[];try{names=await readdir(root);}catch(error){const code=(error as NodeJS.ErrnoException).code;if(code==='ENOENT'||code==='EACCES')return {platform:'linux',status:'BLOCKED',devices:[],capabilities:capabilities('linux','BLOCKED'),limitations:[`Linux sysfs root unavailable: ${code}`],anomalies:[code??'SYSFS_UNAVAILABLE'],truncated:false};throw error;}
  for(const name of names.sort()){
    if(!/^\d+-\d+(?:\.\d+)*$/.test(name))continue;
    if(devices.length>=maxDevices){truncated=true;break;}
    const dir=path.join(root,name),idVendor=hex(await readText(path.join(dir,'idVendor'))),idProduct=hex(await readText(path.join(dir,'idProduct')));
    if(!idVendor||!idProduct){anomalies.push(`${name}: vanished or incomplete VID/PID while enumerating`);continue;}
    try{
      const identity=deviceIdentity({stableKey:`linux:${name}:${idVendor}:${idProduct}`,vendorId:idVendor,productId:idProduct});
      const interfaces:UsbInterface[]=[];const entries=await readdir(dir);
      for(const entry of entries.filter(item=>/^\d+-\d+(?:\.\d+)*:\d+\.\d+$/.test(item)).slice(0,256)){
        const interfaceDir=path.join(dir,entry),number=decimal(await readText(path.join(interfaceDir,'bInterfaceNumber')))??Number(/\.(\d+)$/.exec(entry)?.[1]??0),alternateSetting=decimal(await readText(path.join(interfaceDir,'bAlternateSetting'))),endpoints:UsbEndpoint[]=[];
        for(const epName of (await readdir(interfaceDir)).filter(item=>/^ep_[0-9a-f]{2}$/.test(item)).slice(0,256)){
          const address=Number.parseInt(epName.slice(3),16);if(!Number.isInteger(address)||address>255)continue;const type=await readText(path.join(interfaceDir,epName,'type')),interval=decimal(await readText(path.join(interfaceDir,epName,'interval'))),maxPacketSize=decimal(await readText(path.join(interfaceDir,epName,'maxpacket')));
          endpoints.push({address,direction:address&0x80?'IN':'OUT',number:address&15,transferType:type?.toUpperCase()==='INTERRUPT'?'INTERRUPT':type?.toUpperCase()==='ISOCHRONOUS'?'ISOCHRONOUS':type?.toUpperCase()==='BULK'?'BULK':'UNKNOWN',...(interval!==undefined?{interval}:{}),...(maxPacketSize!==undefined?{maxPacketSize}: {})});
        }
        const interfaceName=await readText(path.join(interfaceDir,'interface')),interfaceClass=await readText(path.join(interfaceDir,'bInterfaceClass')),interfaceSubclass=await readText(path.join(interfaceDir,'bInterfaceSubClass')),interfaceProtocol=await readText(path.join(interfaceDir,'bInterfaceProtocol'));
        interfaces.push({number,...(alternateSetting!==undefined?{alternateSetting}:{}),...(interfaceName?{nameHash:hashIdentity(interfaceName)}:{}),...(interfaceClass?{class:interfaceClass}:{}),...(interfaceSubclass?{subclass:interfaceSubclass}:{}),...(interfaceProtocol?{protocol:interfaceProtocol}:{}),endpoints});
      }
      const product=await readText(path.join(dir,'product')),manufacturer=await readText(path.join(dir,'manufacturer')),version=await readText(path.join(dir,'version')),speed=await readText(path.join(dir,'speed')),deviceClass=await readText(path.join(dir,'bDeviceClass')),deviceSubclass=await readText(path.join(dir,'bDeviceSubClass')),deviceProtocol=await readText(path.join(dir,'bDeviceProtocol')),deviceAddress=await readText(path.join(dir,'devnum')),configuration=await readText(path.join(dir,'configuration')),configurationValue=await readText(path.join(dir,'bConfigurationValue')),attributes=await readText(path.join(dir,'bmAttributes')),maxPower=await readText(path.join(dir,'MaxPower'));const descriptor=await readSmall(path.join(dir,'report_descriptor'),65_536);let topology:Record<string,string|number>;
      try{const target=await readlink(dir);topology={path:target.length<=1_024&&!path.isAbsolute(target)?target:name};}catch{topology={path:name};}
      const device:UsbDevice={identity,product:`USB ${idVendor}:${idProduct}`,...(product?{productHash:hashIdentity(product)}:{}),...(manufacturer?{manufacturerHash:hashIdentity(manufacturer)}:{}),...(version&&/^\d+(?:\.\d+){0,3}$/.test(version)?{version}:{}),...(speed?{speed}:{}),...(deviceClass?{deviceClass}:{}),...(deviceSubclass?{deviceSubclass}:{}),...(deviceProtocol?{deviceProtocol}:{}),bus:name.split('-')[0]??UNKNOWN,...(deviceAddress?{deviceAddress}:{}),topology,configurations:configuration||configurationValue||attributes||maxPower?[{value:configurationValue??UNKNOWN,...(configuration?{valueHash:hashIdentity(configuration)}:{}),...(configurationValue?{configurationValue}:{}),...(attributes?{attributes}:{}),...(maxPower?{maxPower}: {})}]:[],interfaces,...(descriptor?{reportDescriptor:descriptor}:{}),serialAccess:'OMITTED'};devices.push(device);
    }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')anomalies.push(`${name}: device disappeared during enumeration`);else if((error as NodeJS.ErrnoException).code==='EACCES')anomalies.push(`${name}: sysfs attribute access denied`);else throw error;}
  }
  return {platform:'linux',status:'OK',devices,capabilities:capabilities('linux','OK'),limitations:['Linux sysfs values are metadata snapshots; no device handles are opened','Serial numbers are not read from sysfs; only VID/PID and topology-derived stable keys are used'],anomalies,truncated};
}

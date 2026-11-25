import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as hardware from '../../packages/hardware/src/index.js';

type WindowsParser=(output:string,maxDevices?:number)=>{devices:hardware.UsbDevice[];serialPorts:hardware.SerialPort[];truncated:boolean};
const parseWindowsOutput=(hardware as unknown as {parseWindowsHardwareOutput?:WindowsParser}).parseWindowsHardwareOutput;

describe('Windows read-only PnP enumeration',()=>{
  it('queries HardwareID with a fixed non-administrative script and never selects serial-bearing properties',()=>{
    expect(hardware.WINDOWS_HARDWARE_SCRIPT).toContain('Get-CimInstance Win32_PnPEntity');
    expect(hardware.WINDOWS_HARDWARE_SCRIPT).toContain('HardwareID');
    expect(hardware.WINDOWS_HARDWARE_SCRIPT).toMatch(/VID_\[0-9A-Fa-f\]\{4\}/);
    expect(hardware.WINDOWS_HARDWARE_SCRIPT).toMatch(/PID_\[0-9A-Fa-f\]\{4\}/);
    expect(hardware.WINDOWS_HARDWARE_SCRIPT).not.toMatch(/Get-PnpDeviceProperty|Win32_USBController|Open|Start-Service|Set-ExecutionPolicy/i);
  });

  it('parses VID/PID while discarding raw hardware IDs and serial suffixes',()=>{
    expect(parseWindowsOutput).toBeTypeOf('function');
    const raw=JSON.stringify({usb:[{
      name:'USB Composite Device',manufacturer:'Fixture Vendor',status:'OK',service:'usbccgp',pnpClass:'USB',
      instanceHash:createHash('sha256').update('fixture-instance').digest('hex'),
      hardwareIds:['USB\\VID_1234&PID_ABCD&REV_0001','USB\\VID_1234&PID_ABCD&MI_00','HID\\VID_1234&PID_ABCD&COL01\\PRIVATE-SERIAL-42'],
    }],serial:[]});
    const result=parseWindowsOutput!(raw);
    expect(result.devices).toHaveLength(1);
    expect(result.devices[0]).toMatchObject({product:'USB 1234:abcd',productHash:createHash('sha256').update('USB Composite Device').digest('hex'),manufacturerHash:createHash('sha256').update('Fixture Vendor').digest('hex'),serialAccess:'OMITTED',identity:{vendorId:'1234',productId:'abcd',serialHash:'UNKNOWN',authorization:'REQUIRED'}});expect(result.devices[0]?.manufacturer).toBeUndefined();
    expect(result.devices[0]?.identity.stableKey).toContain('1234:abcd');
    expect(JSON.stringify(result)).not.toContain('PRIVATE-SERIAL-42');
    expect(JSON.stringify(result)).not.toContain('hardwareIds');
  });

  it('does not return friendly names that may embed a serial and keeps only COM labels',()=>{
    const raw=JSON.stringify({usb:[{name:'USB Device PRIVATE-SERIAL-42',manufacturer:'Fixture Vendor',service:'usbccgp',pnpClass:'USB',instanceHash:'a'.repeat(64),hardwareIds:['USB\\VID_1234&PID_ABCD']}],serial:[{name:'USB Serial Device PRIVATE-SERIAL-42 (COM7)',manufacturer:'Fixture Vendor',driver:'usbser'}]});
    const result=parseWindowsOutput!(raw),serialized=JSON.stringify(result);expect(result.devices[0]?.product).toBe('USB 1234:abcd');expect(result.serialPorts[0]?.name).toBe('COM7');expect(result.serialPorts[0]?.manufacturer).toBeUndefined();expect(result.serialPorts[0]?.driver).toBeUndefined();expect(serialized).not.toContain('PRIVATE-SERIAL-42');
  });

  it('marks inventories beyond the device bound as truncated',()=>{
    const raw=JSON.stringify({usb:[0,1,2].map(index=>({name:`USB ${index}`,hardwareIds:[`USB\\VID_0001&PID_000${index}`]})),serial:[]});
    const result=parseWindowsOutput!(raw,2);
    expect(result.devices).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });
});

const temporaryRoots:string[]=[];
afterEach(async()=>{for(const root of temporaryRoots.splice(0))await rm(root,{recursive:true,force:true});});
async function fixtureRoot():Promise<string>{const root=await mkdtemp(path.join(os.tmpdir(),'re-sysfs-'));temporaryRoots.push(root);return root;}
async function put(root:string,name:string,value:string|Buffer):Promise<void>{const file=path.join(root,name);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,value);}

describe('Linux sysfs enumeration fixtures',()=>{
  it('reads known VID/PID, configuration, interface, endpoint, speed, topology and report descriptor values',async()=>{
    const root=await fixtureRoot();
    await put(root,'1-1/idVendor','1d6b\n');await put(root,'1-1/idProduct','0002\n');await put(root,'1-1/product','Fixture Root Hub\n');await put(root,'1-1/manufacturer','Fixture Linux\n');await put(root,'1-1/version','2.00\n');await put(root,'1-1/bDeviceClass','09\n');await put(root,'1-1/bConfigurationValue','01\n');await put(root,'1-1/configuration','USB 2.0 Hub\n');await put(root,'1-1/speed','480\n');await put(root,'1-1/devnum','7\n');await put(root,'1-1/report_descriptor',Buffer.from([0x05,0x07,0x09,0x06]));
    if(process.platform!=='win32'){
      await put(root,'1-1/1-1:1.0/interface','hub\n');await put(root,'1-1/1-1:1.0/bInterfaceClass','09\n');await put(root,'1-1/1-1:1.0/bInterfaceSubClass','00\n');await put(root,'1-1/1-1:1.0/bInterfaceProtocol','01\n');await put(root,'1-1/1-1:1.0/bAlternateSetting','00\n');
      await put(root,'1-1/1-1:1.0/ep_81/type','Interrupt\n');await put(root,'1-1/1-1:1.0/ep_81/interval','12\n');await put(root,'1-1/1-1:1.0/ep_81/maxpacket','4\n');
    }
    const result=await hardware.enumerateDevices({platform:'linux',sysfsRoot:root});
    expect(result.status).toBe('OK');expect(result.devices).toHaveLength(1);
    const item=result.devices[0]!;
    expect(item).toMatchObject({identity:{vendorId:'1d6b',productId:'0002'},product:'USB 1d6b:0002',productHash:createHash('sha256').update('Fixture Root Hub').digest('hex'),manufacturerHash:createHash('sha256').update('Fixture Linux').digest('hex'),version:'2.00',deviceClass:'09',speed:'480',bus:'1',deviceAddress:'7',topology:{path:'1-1'},serialAccess:'OMITTED'});expect(item.manufacturer).toBeUndefined();
    expect(item.configurations[0]).toMatchObject({value:'01',valueHash:createHash('sha256').update('USB 2.0 Hub').digest('hex'),configurationValue:'01'});
    expect(item.reportDescriptor).toEqual(Buffer.from([0x05,0x07,0x09,0x06]));
    if(process.platform!=='win32')expect(item.interfaces[0]).toMatchObject({number:0,alternateSetting:0,nameHash:createHash('sha256').update('hub').digest('hex'),class:'09',endpoints:[{address:129,direction:'IN',number:1,transferType:'INTERRUPT',interval:12,maxPacketSize:4}]});
  });

  it('does not read or return sysfs serial numbers',async()=>{
    const root=await fixtureRoot();await put(root,'1-1/idVendor','1234\n');await put(root,'1-1/idProduct','5678\n');await put(root,'1-1/iSerial','PRIVATE-SERIAL-42\n');
    const result=await hardware.enumerateDevices({platform:'linux',sysfsRoot:root}),serialized=JSON.stringify(result);
    expect(result.devices[0]?.identity.serialHash).toBe('UNKNOWN');expect(serialized).not.toContain('PRIVATE-SERIAL-42');
  });

  it('classifies a missing sysfs root as BLOCKED',async()=>{
    const result=await hardware.enumerateDevices({platform:'linux',sysfsRoot:path.join(await fixtureRoot(),'missing')});
    expect(result.status).toBe('BLOCKED');expect(result.devices).toEqual([]);expect(result.anomalies.join(' ')).toContain('ENOENT');
  });

  it.skipIf(process.platform==='win32')('classifies sysfs permission denial as BLOCKED',async()=>{
    const root=await fixtureRoot();await put(root,'1-1/idVendor','1234\n');await put(root,'1-1/idProduct','5678\n');await chmod(root,0);
    try{const result=await hardware.enumerateDevices({platform:'linux',sysfsRoot:root});expect(result.status).toBe('BLOCKED');expect(result.anomalies.join(' ')).toMatch(/EACCES|EPERM/);}finally{await chmod(root,0o700);}
  });

  it('records an incomplete device that vanished during enumeration without returning partial identity',async()=>{
    const root=await fixtureRoot();await put(root,'2-1/idProduct','0002\n');
    const result=await hardware.enumerateDevices({platform:'linux',sysfsRoot:root});
    expect(result.devices).toEqual([]);expect(result.anomalies.join(' ')).toMatch(/vanished|disappeared/i);
  });

  it('bounds device inventories and reports truncation',async()=>{
    const root=await fixtureRoot();for(const name of ['1-1','1-2']){await put(root,`${name}/idVendor`,'1234\n');await put(root,`${name}/idProduct`,'5678\n');}
    const result=await hardware.enumerateDevices({platform:'linux',sysfsRoot:root,maxDevices:1});
    expect(result.devices).toHaveLength(1);expect(result.truncated).toBe(true);
  });
});

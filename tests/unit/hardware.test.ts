import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DeviceHotplugTracker, deviceIdentity, enumerateDevices, parseHidReportDescriptor,
  parseUsbCapture, parseUsbmon, redactSerial,
} from '../../packages/hardware/src/index.js';
import { hardwareAdapter } from '../../packages/core/src/adapters/hardware.js';

function pcap(linkType:number,packets:Buffer[],little=true):Buffer {
  const global=Buffer.alloc(24);global.writeUInt32LE(little?0xa1b2c3d4:0xd4c3b2a1,0);global.writeUInt16LE(little?2:0x0200,4);global.writeUInt16LE(little?4:0x0400,6);global.writeUInt32LE(65535,16);global.writeUInt32LE(linkType,20);
  return Buffer.concat([global,...packets.map((packet,index)=>{const header=Buffer.alloc(16);header.writeUInt32LE(index+1,0);header.writeUInt32LE(packet.length,8);header.writeUInt32LE(packet.length+5,12);return Buffer.concat([header,packet]);})]);
}
function linuxHeader(transfer=2,endpoint=0x80,length=0,status=0,info='S',irp=0x1234,full=true):Buffer {
  const b=Buffer.alloc(full?64:48);b.writeBigUInt64LE(BigInt(irp),0);b[8]=info.charCodeAt(0);b[9]=transfer;b[10]=endpoint;b[11]=2;b.writeUInt16LE(1,12);b.writeUInt32LE(1700000000,16);b.writeInt32LE(status,28);b.writeUInt32LE(length,32);b.writeUInt32LE(length,36);return b;
}
function usbpcapHeader(transfer=2,endpoint=0x80,length=0,info=1,irp=0x1234):Buffer {
  const headerLength=transfer===2?28:27,b=Buffer.alloc(headerLength);b.writeUInt16LE(headerLength,0);b.writeBigUInt64LE(BigInt(irp),2);b.writeInt32LE(info?0:0xc0000001|0,10);b.writeUInt16LE(0x200,14);b[16]=info;b.writeUInt16LE(1,17);b.writeUInt16LE(3,19);b[21]=endpoint;b[22]=transfer;b.writeUInt32LE(length,23);if(transfer===2)b[27]=info?3:0;return b;
}
function pcapng(linkType:number,packet:Buffer,little=true):Buffer {
  const shb=Buffer.alloc(28);shb.writeUInt32BE(0x0a0d0d0a,0);shb.writeUInt32LE(28,4);shb.writeUInt32LE(0x1a2b3c4d,8);shb.writeUInt32LE(28,24);
  const idb=Buffer.alloc(20);idb.writeUInt32LE(1,0);idb.writeUInt32LE(20,4);idb.writeUInt16LE(linkType,8);idb.writeUInt32LE(65535,12);idb.writeUInt32LE(20,16);
  const padded=Buffer.alloc(Math.ceil(packet.length/4)*4);packet.copy(padded);const length=32+padded.length,epb=Buffer.alloc(length);epb.writeUInt32LE(6,0);epb.writeUInt32LE(length,4);epb.writeUInt32LE(packet.length,20);epb.writeUInt32LE(packet.length+3,24);packet.copy(epb,28);epb.writeUInt32LE(length,length-4);
  if(little)return Buffer.concat([shb,idb,epb]);
  const swap=(data:Buffer,offsets:number[])=>{for(const o of offsets)data.writeUInt32BE(data.readUInt32LE(o),o);};
  swap(shb,[4,8,16,24]);swap(idb,[0,4,12,16]);idb.writeUInt16BE(linkType,8);swap(epb,[0,4,12,16,20,24,length-4]);return Buffer.concat([shb,idb,epb]);
}

describe('hardware identities and HID',()=>{
  it('hashes serials and changes authorization when identity changes',()=>{
    expect(redactSerial('private-serial')).toBe(`sha256:${createHash('sha256').update('private-serial').digest('hex')}`);
    expect(redactSerial('private-serial')).not.toContain('private-serial');expect(redactSerial(undefined)).toBe('UNKNOWN');
  });
  it('parses bounded HID usages, logical bounds and rejects malformed items',()=>{
    // Usage Page(Keyboard), Usage(A..Z), Logical Minimum(0), Logical Maximum(101), Report Size(8), Report Count(1), Input(Data,Variable)
    const descriptor=Buffer.from([0x05,0x07,0x19,0x04,0x29,0x1d,0x15,0x00,0x25,0x65,0x00,0x75,0x08,0x95,0x01,0x05,0x01,0x09,0x06,0xa1,0x01,0x81,0x02,0xc0]);
    const report=parseHidReportDescriptor(descriptor);expect(report.valid).toBe(true);expect(report.usagePage).toBe('Keyboard / Keypad');expect(report.usagePages).toEqual(['Keyboard / Keypad','Generic Desktop']);expect(report.usages).toEqual(expect.arrayContaining(['Keyboard A','Keyboard Z']));expect(report.logicalMinimum).toBe(0);expect(report.logicalMaximum).toBe(101);expect(report.collections).toContain('Keyboard');expect(report.keyboardCaptureDefault).toBe('DISABLED');
    expect(parseHidReportDescriptor(Buffer.from([0x1a,0x01])).anomalies).not.toHaveLength(0);
    expect(parseHidReportDescriptor(Buffer.from([0xfe,0xff,0xff,0xff])).valid).toBe(false);
  });
  it('tracks connect/disconnect/reconnect without inherited authorization',()=>{
    const tracker=new DeviceHotplugTracker();const identity={stableKey:'usb:1234:abcd',serialHash:'sha256:a',identityHash:'id-a'},device={identity};
    expect(tracker.apply([device])[0]).toMatchObject({type:'connect',device,authorizationRequired:true});expect(tracker.apply([device])).toEqual([]);
    expect(tracker.apply([])[0]).toMatchObject({type:'disconnect',stableKey:'usb:1234:abcd'});expect(tracker.apply([device])[0]).toMatchObject({type:'connect',authorizationRequired:true});
    const changed={...device,identity:{...device.identity,identityHash:'id-b'}};expect(tracker.apply([changed])[0]).toMatchObject({type:'reconnect',authorizationRequired:true});
  });
  it('requires fresh authorization after revocation and after VID/PID identity changes',()=>{
    const tracker=new DeviceHotplugTracker(),granted={identity:deviceIdentity({stableKey:'usb:1234:abcd',vendorId:'1234',productId:'abcd',authorization:'GRANTED'}),configurations:[],interfaces:[],serialAccess:'OMITTED' as const};
    tracker.apply([granted]);
    const revoked={...granted,identity:{...granted.identity,authorization:'REVOKED' as const}};expect(tracker.apply([revoked])[0]).toMatchObject({type:'reconnect',authorizationRequired:true});
    const changed={...granted,identity:deviceIdentity({stableKey:'usb:1234:abcd',vendorId:'1234',productId:'abce',authorization:'GRANTED'})};expect(tracker.apply([changed])[0]).toMatchObject({type:'reconnect',authorizationRequired:true,reason:/identity|authorization/i});
    const fresh=new DeviceHotplugTracker();expect(fresh.apply([changed])[0]).toMatchObject({type:'connect',authorizationRequired:true});
  });
  it('reports platform support without claiming non-Windows enumeration',async()=>{
    const result=await enumerateDevices();expect(result.platform).toBe(process.platform);expect(result.capabilities).toHaveProperty('openDeviceHandles',false);
    if(process.platform==='darwin')expect(result.status).toBe('UNSUPPORTED');
    if(process.platform!=='win32')expect(result.devices).toEqual([]);
  });
});

describe('USB capture parsing',()=>{
  it('parses DLT_USB_LINUX_MMAPPED and keeps raw record offsets',async()=>{
    const setup=Buffer.from([0x80,0x06,0x00,0x01,0x00,0x00,0x12,0x00]),header=linuxHeader();header.set(setup,40);
    const result=await parseUsbCapture(pcap(220,[header]));expect(result.records).toHaveLength(1);expect(result.records[0]).toMatchObject({device:'2',bus:'1',interfaceNumber:'UNKNOWN',transferType:'CONTROL',direction:'IN',rawOffset:40,dataOffset:64,irpId:'4660'});expect(result.descriptorCandidates[0]).toMatchObject({descriptorType:'DEVICE',requestType:'STANDARD',state:'REQUEST_ONLY'});expect(result.stats.records).toBe(1);
  });
  it('parses non-isochronous DLT_USB_LINUX at data offset 48',async()=>{
    const header=linuxHeader(3,0x81,4,0,'S',0x1234,false);Buffer.from('DATA').copy(header,48);const result=await parseUsbCapture(pcap(189,[header]));expect(result.records[0]).toMatchObject({transferType:'BULK',direction:'IN',dataLength:4,dataOffset:48});expect(result.stats.bytes).toBe(4);
  });
  it('parses packed USBPcap headers and matches IRP request/response',async()=>{
    const request=Buffer.concat([usbpcapHeader(2,0x80,8,0),Buffer.from([0x80,0x06,0,1,0,0,8,0])]);const response=Buffer.concat([usbpcapHeader(2,0x80,8,1),Buffer.from([0x12,0x02,0,0,0,0,0,0])]);
    response.writeInt32LE(-115,10);const result=await parseUsbCapture(pcap(249,[request,response]));expect(result.records[0]).toMatchObject({irpId:'4660',rawOffset:40,dataLength:8});expect(result.records[1]?.responseTo).toBe('4660');expect(result.transactions[0]).toMatchObject({requestIndex:0,responseIndex:1});expect(result.descriptorCandidates).toHaveLength(1);expect(result.descriptorCandidates[0]?.state).toBe('OBSERVED');expect(result.stats).toMatchObject({records:2,requests:1,responses:1,errors:1});
  });
  it('parses PCAPNG with USB link type and big endian',async()=>{
    const result=await parseUsbCapture(pcapng(249,usbpcapHeader(1,0x81,0,1),false));expect(result.format).toBe('PCAPNG');expect(result.byteOrder).toBe('big');expect(result.records[0]?.endpoint).toBe('0x81');expect(result.records[0]?.status).toBe('SUCCESS');
  });
  it('parses usbmon text and matches submission/completion tags',async()=>{
    const text='ffff 3575914555 S Ci:1:002:0 s 80 06 0100 0000 0012 4 <\nffff 3575914560 C Ci:1:002:0 0 18 = 12010200 00000800 00000000 00000000 0000\n';
    const result=parseUsbmon(text);expect(result.records).toHaveLength(2);expect(result.records[1]?.responseTo).toBe('ffff');expect(result.records[0]?.irpId).toBe('ffff');expect(result.transactions[0]).toMatchObject({requestIndex:0,responseIndex:1,complete:true});expect(result.descriptorCandidates[0]?.state).toBe('OBSERVED');
    const error=parseUsbmon('ffff 1 C Bi:1:002:1 -115 8 <\n');expect(error.stats.errors).toBe(1);
  });
  it('bounds malformed counts, lengths, interfaces and ISO without hangs',async()=>{
    const huge=Buffer.alloc(27);huge.writeUInt16LE(27,0);huge.writeUInt32LE(0xffffffff,23);const malformed=pcap(249,[Buffer.alloc(4),huge]);const result=await parseUsbCapture(malformed,{maxRecords:1});expect(result.truncated).toBe(true);expect(result.anomalies.length).toBeGreaterThan(0);expect(result.records.length).toBeLessThanOrEqual(1);
    const iso=Buffer.alloc(64);iso.writeUInt16LE(27,0);iso[22]=0;iso.writeUInt32LE(0xffffffff,35);iso.writeUInt32LE(0xffffffff,39);const isoResult=await parseUsbCapture(pcap(249,[iso]));expect(isoResult.anomalies.join(' ')).toMatch(/ISO|isochronous|header/i);
  });
  it('does not classify a four-byte magic prefix in usbmon text as PCAP',async()=>{
    const text=Buffer.from([0xd4,0xc3,0xb2,0xa1,...Buffer.from(' 1 S Ci:1:002:0 s 80 06 0100 0000 0012 4 <\n')]);const {detectUsbFormat}=await import('../../packages/hardware/src/index.js');expect(detectUsbFormat('usbmon.txt',text.subarray(0,64))).toBe('USBMON');
  });
  it('rejects unsupported link types and malformed global headers',async()=>{
    await expect(parseUsbCapture(pcap(1,[Buffer.alloc(4)]))).rejects.toThrow(/Unsupported USB link type/);await expect(parseUsbCapture(Buffer.from('nope'))).rejects.toThrow(/PCAP/);
  });
});

describe('hardware adapter',()=>{
  it('exists with offline-only capabilities and default disabled keyboard capture',async()=>{
    const capability=await hardwareAdapter.available();expect(capability.available).toBe(true);expect(JSON.stringify(capability)).toMatch(/read-only|offline/i);expect(hardwareAdapter.description).toMatch(/USB/i);
  });
});

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseUsbCapture, parseUsbmon } from '../../packages/hardware/src/index.js';

function pcap(linkType:number,packets:Buffer[]):Buffer{
  const global=Buffer.alloc(24);global.writeUInt32LE(0xa1b2c3d4,0);global.writeUInt16LE(2,4);global.writeUInt16LE(4,6);global.writeUInt32LE(65_535,16);global.writeUInt32LE(linkType,20);
  return Buffer.concat([global,...packets.map(packet=>{const header=Buffer.alloc(16);header.writeUInt32LE(packet.length,8);header.writeUInt32LE(packet.length,12);return Buffer.concat([header,packet]);})]);
}
function pcapng(linkType:number,packets:Buffer[]):Buffer{
  const shb=Buffer.alloc(28);shb.writeUInt32BE(0x0a0d0d0a,0);shb.writeUInt32LE(28,4);shb.writeUInt32LE(0x1a2b3c4d,8);shb.writeUInt32LE(28,24);
  const idb=Buffer.alloc(20);idb.writeUInt32LE(1,0);idb.writeUInt32LE(20,4);idb.writeUInt16LE(linkType,8);idb.writeUInt32LE(65_535,12);idb.writeUInt32LE(20,16);
  return Buffer.concat([shb,idb,...packets.map(packet=>{const padded=Buffer.alloc(Math.ceil(packet.length/4)*4);packet.copy(padded);const length=32+padded.length,epb=Buffer.alloc(length);epb.writeUInt32LE(6,0);epb.writeUInt32LE(length,4);epb.writeUInt32LE(packet.length,20);epb.writeUInt32LE(packet.length,24);packet.copy(epb,28);epb.writeUInt32LE(length,length-4);return epb;})]);
}
function usbpcapRequest(irp:number,length:number):Buffer{const header=Buffer.alloc(36);header.writeUInt16LE(28,0);header.writeBigUInt64LE(BigInt(irp),2);header.writeUInt16LE(0x200,14);header[16]=0;header.writeUInt16LE(1,17);header.writeUInt16LE(3,19);header[21]=0x80;header[22]=2;header.writeUInt32LE(length,23);header[27]=0;header.set(Buffer.from([0x80,0x06,0,1,0,0,length,0]),28);return header;}
function usbpcapResponse(irp:number,length:number,actual:number):Buffer{const packet=Buffer.concat([usbpcapRequest(irp,length),Buffer.alloc(actual)]);packet.writeUInt32LE(actual,23);packet[16]=1;packet[27]=3;packet.fill(0,28,36);return packet;}

describe('USB capture container and usbmon boundaries',()=>{
  it('parses DLT_USB_RAW as opaque packet bytes without inventing Linux URB fields',async()=>{
    const payload=Buffer.from([0xc3,0x12,0x34]);const result=await parseUsbCapture(pcap(186,[payload]));
    expect(result.records[0]).toMatchObject({format:'PCAP',encapsulation:'USB_RAW',bus:'UNKNOWN',device:'UNKNOWN',deviceAddress:'UNKNOWN',transferType:'UNKNOWN',dataOffset:0,rawOffset:40,dataLength:3,capturedLength:3});
    expect(result.records[0]?.payloadSha256).toBe(createHash('sha256').update(payload).digest('hex'));
  });

  it('derives non-mapped DLT_USB_LINUX ISO data offset from bounded frame descriptors',async()=>{
    const packet=Buffer.alloc(84);packet[8]=67;packet[9]=0;packet[10]=0x81;packet[11]=2;packet.writeUInt16LE(1,12);packet.writeUInt32LE(4,32);packet.writeUInt32LE(4,36);packet.writeInt32LE(2,44);packet.writeInt32LE(1,40);packet.writeInt32LE(-32,64);Buffer.from([1,2,3,4]).copy(packet,80);
    const result=await parseUsbCapture(pcap(189,[packet]));
    expect(result.records[0]).toMatchObject({transferType:'ISOCHRONOUS',isoPacketCount:2,isoErrorCount:1,dataOffset:80,capturedLength:4});
  });

  it('parses deprecated usbmon 1t ISO rows without treating data length as a descriptor count',()=>{
    const result=parseUsbmon('aaaa 10 S Zi:002:1 0 4 = 0102\n');
    expect(result.records).toHaveLength(1);expect(result.records[0]).toMatchObject({bus:'UNKNOWN',device:'2',transferType:'ISOCHRONOUS',direction:'IN',length:4,capturedLength:2,dataTruncated:true});
  });

  it('parses usbmon 1u status, interval, start frame and ISO descriptor errors',()=>{
    const result=parseUsbmon('bbbb 11 C Zi:1:002:1 0:8:123:1 2 0:0:2 -32:2:0 2 = aabb\n');
    expect(result.records).toHaveLength(1);expect(result.records[0]).toMatchObject({bus:'1',device:'2',transferType:'ISOCHRONOUS',interval:8,startFrame:123,isoPacketCount:2,isoErrorCount:1,capturedLength:2});
  });

  it('rejects malformed ISO descriptors and odd-length payload hex',()=>{
    const malformed=parseUsbmon('aaaa 10 S Zi:1:002:1 0 1 garbage 0 =\n'),odd=parseUsbmon('bbbb 11 S Bi:1:002:1 0 2 = a\n');
    expect(malformed.records).toEqual([]);expect(malformed.anomalies.join(' ')).toMatch(/isochronous descriptor/i);
    expect(odd.records).toEqual([]);expect(odd.anomalies.join(' ')).toMatch(/hex/i);
  });

  it('keeps byte-accurate raw offsets for CRLF usbmon input',()=>{
    const first='aaaa 10 S Bi:1:002:1 0 0\r\n',second='bbbb 11 C Bi:1:002:1 0 0\r\n',result=parseUsbmon(first+second);
    expect(result.records[1]?.rawOffset).toBe(Buffer.byteLength(first));expect(result.records[1]?.rawLength).toBe(Buffer.byteLength(second.trimEnd()));
  });

  it('scopes usbmon tag pairing by bus, device and endpoint',()=>{
    const text='aaaa 10 S Bi:1:002:1 0 0\naaaa 11 S Bi:1:003:1 0 0\naaaa 12 C Bi:1:003:1 0 0\n',result=parseUsbmon(text);
    expect(result.records[2]?.responseTo).toBe('aaaa');expect(result.transactions[0]).toMatchObject({requestIndex:1,responseIndex:2});
    expect(result.transactions.find(item=>!item.complete)).toMatchObject({requestIndex:0});
  });

  it('pairs PCAPNG descriptor responses by IRP rather than by device alone',async()=>{
    const requestA=usbpcapRequest(1,8),requestB=usbpcapRequest(2,18),responseB=usbpcapResponse(2,18,2),responseA=usbpcapResponse(1,8,8);
    const result=await parseUsbCapture(pcapng(249,[requestA,requestB,responseB,responseA]));
    const candidates=result.descriptorCandidates.filter(item=>item.state!=='REQUEST_ONLY');
    expect(candidates).toHaveLength(2);expect(candidates.find(item=>item.length===18)?.state).toBe('TRUNCATED');expect(candidates.find(item=>item.length===8)?.state).toBe('OBSERVED');
  });

  it('rejects hostile PCAP and PCAPNG lengths before reading out of bounds',async()=>{
    const pcapHeader=Buffer.alloc(24);pcapHeader.writeUInt32LE(0xa1b2c3d4,0);pcapHeader.writeUInt16LE(2,4);pcapHeader.writeUInt16LE(4,6);pcapHeader.writeUInt32LE(249,20);const recordHeader=Buffer.alloc(16);recordHeader.writeUInt32LE(0xffffffff,8);
    await expect(parseUsbCapture(Buffer.concat([pcapHeader,recordHeader]))).rejects.toThrow(/truncated|exceeds/i);
    const shb=Buffer.alloc(28);shb.writeUInt32BE(0x0a0d0d0a,0);shb.writeUInt32LE(28,4);shb.writeUInt32LE(0x1a2b3c4d,8);shb.writeUInt32LE(28,24);const broken=Buffer.from(shb);broken.writeUInt32LE(0xffffffff,4);
    await expect(parseUsbCapture(broken)).rejects.toThrow(/block length|truncated/i);
  });
});

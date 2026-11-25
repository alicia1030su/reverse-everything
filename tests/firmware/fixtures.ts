import { createHash } from 'node:crypto';

export function hexRecord(type:number,address:number,data:Buffer):string {
  const bytes=[data.length,address>>8,address&255,type,...data];
  let sum=0;for(const byte of bytes)sum=(sum+byte)&255;
  return ':'+bytes.map(byte=>byte.toString(16).padStart(2,'0')).join('').toUpperCase()+((-sum)&255).toString(16).padStart(2,'0').toUpperCase();
}
export function knownHex():Buffer {
  return Buffer.from([
    hexRecord(2,0,Buffer.from([0x10,0])),
    hexRecord(4,0,Buffer.from([0x10,0])),
    hexRecord(0,0,Buffer.from([0x7f,0x45,0x4c,0x46])),
    hexRecord(0,4,Buffer.from([2,1,1])),
    hexRecord(1,0,Buffer.alloc(0)),
  ].join('\r\n')+'\r\n','ascii');
}
export function uf2Block(payload:Buffer,blockNo:number,numBlocks:number,address:number,flags=0x2000,family=0):Buffer {
  const block=Buffer.alloc(512);
  block.writeUInt32LE(0x0a324655,0);block.writeUInt32LE(0x9e5d5157,4);block.writeUInt32LE(flags,12);block.writeUInt32LE(address,16);block.writeUInt32LE(payload.length,20);block.writeUInt32LE(blockNo,24);block.writeUInt32LE(numBlocks,28);block.writeUInt32LE(family,32);payload.copy(block,44);block.fill(0,44+payload.length);block.writeUInt32LE(0x0ab16f30,508);
  return block;
}
export function knownUf2():Buffer { const first=Buffer.alloc(256),second=Buffer.alloc(256);first.set([0xde,0xad,0xbe,0xef]);second.set([1,2,3,4]);return Buffer.concat([uf2Block(first,0,2,0x10000000,0x2000,0xe48bff59),uf2Block(second,1,2,0x10000100,0x2000,0xe48bff59)]); }
export function knownElf():Buffer {
  const data=Buffer.alloc(64+56+64+8);
  data.set([0x7f,0x45,0x4c,0x46,2,1,1,0],0);data.writeUInt16LE(2,16);data.writeUInt16LE(62,18);data.writeUInt32LE(1,20);data.writeBigUInt64LE(0x400000n,24);data.writeBigUInt64LE(64n,32);data.writeBigUInt64LE(120n,40);data.writeUInt32LE(0,48);data.writeUInt16LE(64,52);data.writeUInt16LE(56,54);data.writeUInt16LE(1,56);data.writeUInt16LE(64,58);data.writeUInt16LE(1,60);data.writeUInt16LE(0,62);
  data.writeUInt32LE(1,64);data.writeUInt32LE(5,68);data.writeBigUInt64LE(184n,72);data.writeBigUInt64LE(0x400000n,80);data.writeBigUInt64LE(0x400000n,88);data.writeBigUInt64LE(8n,96);data.writeBigUInt64LE(8n,104);
  data.writeUInt32LE(1,120);data.writeUInt32LE(1,124);data.writeBigUInt64LE(6n,128);data.writeBigUInt64LE(0x400000n,136);data.writeBigUInt64LE(184n,144);data.writeBigUInt64LE(8n,152);data.writeBigUInt64LE(8n,160);data.writeUInt32LE(0x1000,168);return data;
}
export function gptHeader():Buffer {
  const data=Buffer.alloc(92);data.write('EFI PART',0,'ascii');data.writeUInt32LE(0x10000,8);data.writeUInt32LE(92,12);data.writeUInt32LE(0,16);data.writeUInt32LE(0,20);data.writeBigUInt64LE(1n,24);data.writeBigUInt64LE(4096n,32);data.writeBigUInt64LE(34n,40);data.writeBigUInt64LE(4082n,48);Buffer.from('0123456789abcdef',0,'hex').copy(data,56);data.writeBigUInt64LE(2n,72);data.writeUInt32LE(128,80);data.writeUInt32LE(128,84);data.writeUInt32LE(0,88);return data;
}
export function mbrHeader():Buffer {
  const data=Buffer.alloc(512);data[446]=0x80;data[450]=0x83;data.writeUInt32LE(1,454);data.writeUInt32LE(2048,458);data[510]=0x55;data[511]=0xaa;return data;
}
export function entropyFixture(size=65536):Buffer {
  const data=Buffer.alloc(size);let state=0x12345678;for(let index=0;index<size;index++){state^=state<<13;state^=state>>>17;state^=state<<5;data[index]=state&255;}return data;
}
export function sha256(data:Buffer):string{return createHash('sha256').update(data).digest('hex');}

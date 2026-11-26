import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { UNKNOWN, type UsbCaptureRecord } from './types.js';

export type { UsbCaptureRecord };
export interface DescriptorCandidate { descriptorType:string; requestType:string; request:number; value:number; index:number; length:number; direction:'IN'|'OUT'|'UNKNOWN'; state:'REQUEST_ONLY'|'OBSERVED'|'TRUNCATED'; recordIndex:number; device:string; interfaceNumber:string|number; endpoint:string }
export interface UsbTransaction { tag:string;requestIndex:number;responseIndex?:number;requestLength:number;responseLength:number;complete:boolean }
export interface UsbCaptureStats { records:number;requests:number;responses:number;bytes:number;dataRecords:number;errors:number;truncatedDataRecords:number;transferTypes:Record<string,number>;devices:Record<string,number>;interfaces:Record<string,number>;endpoints:Record<string,number> }
export interface UsbCaptureAnalysis { format:'PCAP'|'PCAPNG'|'USBMON';linkType:number|string;byteOrder:'little'|'big'|'UNKNOWN';sourceBytes:number;bytesRead:number;recordCount:number;records:UsbCaptureRecord[];timeline:UsbCaptureRecord[];transactions:UsbTransaction[];descriptorCandidates:DescriptorCandidate[];stats:UsbCaptureStats;anomalies:string[];truncated:boolean;limitations:string[];interfaceLinkTypes:number[];skippedPackets:number }
export interface CaptureLimits { maxRecords?:number;maxTimeline?:number;maxTransactions?:number;maxDescriptors?:number;maxInterfaces?:number;maxIsoPackets?:number;maxPayloadBytes?:number;maxLineBytes?:number }
const LIMITS={maxRecords:20_000,maxTimeline:20_000,maxTransactions:5_000,maxDescriptors:1_000,maxInterfaces:1_000,maxIsoPackets:1_024,maxPayloadBytes:65_536,maxLineBytes:1_000_000};
const TRANSFERS=['ISOCHRONOUS','INTERRUPT','CONTROL','BULK'];
const DESCRIPTORS:Record<number,string>={1:'DEVICE',2:'CONFIGURATION',3:'STRING',4:'INTERFACE',5:'ENDPOINT',6:'DEVICE_QUALIFIER',7:'OTHER_SPEED_CONFIGURATION',0x21:'HID',0x22:'REPORT',0x29:'HUB',0x33:'BOS'};
function limit(options:CaptureLimits,key:keyof CaptureLimits):number { const fallback=LIMITS[key];const value=options[key];return typeof value==='number'&&Number.isFinite(value)&&value>0?Math.min(Math.floor(value),fallback):fallback; }
function stats():UsbCaptureStats{return {records:0,requests:0,responses:0,bytes:0,dataRecords:0,errors:0,truncatedDataRecords:0,transferTypes:{},devices:{},interfaces:{},endpoints:{}};}
function inc(map:Record<string,number>,key:string):void{map[key]=(map[key]??0)+1;}
function anomaly(result:UsbCaptureAnalysis,message:string):void{if(result.anomalies.length<200)result.anomalies.push(message);}
function bounded(result:UsbCaptureAnalysis,message:string):void{result.truncated=true;if(result.limitations.length<50)result.limitations.push(message);}
function statusName(value:number):string{return value===0?'SUCCESS':value<0?`ERROR_0x${(value>>>0).toString(16).padStart(8,'0')}`:`0x${(value>>>0).toString(16).padStart(8,'0')}`;}
function transferName(value:number|string):string{return typeof value==='number'?(TRANSFERS[value]??`UNKNOWN_${value}`):value;}
function addRecord(result:UsbCaptureAnalysis,record:UsbCaptureRecord,maxTimeline:number):void{
  result.recordCount++;result.stats.records++;result.records.push(record);inc(result.stats.transferTypes,record.transferType);inc(result.stats.devices,record.device);inc(result.stats.interfaces,String(record.interfaceNumber));inc(result.stats.endpoints,record.endpoint);
  const response=record.info==='PDO_TO_FDO'||record.info==='COMPLETION';if(response)result.stats.responses++;else result.stats.requests++;
  if(record.status.startsWith('ERROR')&&response)result.stats.errors++;
  if(record.dataTruncated)result.stats.truncatedDataRecords++;if(record.dataLength>0)result.stats.dataRecords++;result.stats.bytes+=record.dataLength;
  if(result.timeline.length<maxTimeline)result.timeline.push(record);else bounded(result,`Timeline limit ${maxTimeline} reached`);
}
function finalizeRecord(result:UsbCaptureAnalysis,record:UsbCaptureRecord,raw:Buffer,maxTimeline:number,descriptorLimit:number,interfaceLimit:number):void{
  if(!record.device||record.device===UNKNOWN)anomaly(result,`record ${record.recordIndex}: device is UNKNOWN`);
  if(record.interfaceNumber!==UNKNOWN&&Number.isInteger(Number(record.interfaceNumber))&&Number(record.interfaceNumber)>=interfaceLimit)bounded(result,`Interface inventory limit ${interfaceLimit} reached`);
  if(record.dataLength>record.capturedLength){anomaly(result,`record ${record.recordIndex}: declared data length ${record.dataLength} exceeds captured ${record.capturedLength}`);if(result.limitations.length<50)result.limitations.push(`Record ${record.recordIndex} data was truncated; only captured bytes were analyzed`);}
  const setupOffset=record.format==='USBMON'?0:record.transferType==='CONTROL'?(record.encapsulation==='USBPcap'?28:(record.encapsulation==='USB_LINUX'||record.encapsulation==='USB_LINUX_MMAPPED')?40:27):27;
  if(record.transferType==='CONTROL'&&raw.length>=setupOffset+8){
    const setup=raw.subarray(setupOffset,setupOffset+8),setupType=setup.readUInt8(0),bRequest=setup.readUInt8(1);record.setup={bmRequestType:`0x${setupType.toString(16).padStart(2,'0')}`,bRequest,wValue:setup.readUInt16LE(2),wIndex:setup.readUInt16LE(4),wLength:setup.readUInt16LE(6)};
    if(bRequest===6&&(setupType&0x60)===0&&(setupType&0x80)!==0){
      const descriptorTypeByte=setup.readUInt8(3);record.descriptorCandidate={descriptorType:DESCRIPTORS[descriptorTypeByte]??`UNKNOWN_0x${descriptorTypeByte.toString(16)}`,requestType:(setupType&0x1f)===0?'STANDARD':'UNKNOWN',request:6,value:setup.readUInt16LE(2),index:setup.readUInt16LE(4),length:setup.readUInt16LE(6),direction:'IN',state:'REQUEST_ONLY',recordIndex:record.recordIndex,device:record.device,interfaceNumber:record.interfaceNumber,endpoint:record.endpoint};
    }
  }
  addRecord(result,record,maxTimeline);
}
function rawRecord(raw:Buffer,index:number,offset:number,timestamp:string,format:'PCAP'|'PCAPNG'):UsbCaptureRecord{
  const length=raw.length;
  return {recordIndex:index,format,encapsulation:'USB_RAW',timestamp,timestampMicros:0,bus:UNKNOWN,device:UNKNOWN,deviceAddress:UNKNOWN,interfaceNumber:UNKNOWN,interfaceAlternateSetting:UNKNOWN,endpoint:UNKNOWN,endpointNumber:UNKNOWN,direction:'UNKNOWN',transferType:UNKNOWN,status:UNKNOWN,length,dataLength:length,capturedLength:length,dataTruncated:false,dataOffset:0,rawOffset:offset,rawLength:length,payloadSha256:createHash('sha256').update(raw).digest('hex'),anomalies:[]};
}
function linuxBinaryRecord(raw:Buffer,index:number,offset:number,timestamp:string,format:'PCAP'|'PCAPNG',fullHeader:boolean,maxPayload:number,maxIso:number):UsbCaptureRecord{
  const headerLength=fullHeader?64:48,transfer=raw[9]??0xff,ep=raw[10]??0,length=raw.readUInt32LE(32),capturedHeader=raw.readUInt32LE(36),anomalies:string[]=[];let dataOffset=headerLength,isoPacketCount:number|undefined,isoErrorCount:number|undefined;
  if(![83,67,69].includes(raw[8]??0))anomalies.push(`unknown Linux USB event type ${raw[8]}`);
  if(transfer>3)anomalies.push(`unknown Linux USB transfer type ${transfer}`);
  if(transfer===0){
    const declaredCount=fullHeader?raw.readUInt32LE(60):raw.readInt32LE(44),capacity=Math.floor(Math.max(0,raw.length-headerLength)/16);
    if(declaredCount<0){anomalies.push('isochronous packet count is negative');dataOffset=raw.length;}
    else{const boundedCount=Math.min(declaredCount,maxIso,capacity);isoPacketCount=boundedCount;isoErrorCount=raw.readInt32LE(40);if(declaredCount>maxIso||declaredCount>capacity)anomalies.push(`isochronous packet count ${declaredCount} exceeds bound or header capacity`);dataOffset=headerLength+boundedCount*16;}
  }
  const captured=Math.min(capturedHeader,Math.max(0,raw.length-dataOffset),maxPayload),seconds=raw.readBigInt64LE(16),micros=raw.readInt32LE(24),timestampMicros=seconds>=0n&&seconds<=BigInt(Math.floor(Number.MAX_SAFE_INTEGER/1_000_000))&&micros>=0&&micros<1_000_000?Number(seconds)*1_000_000+micros:0;
  if(length>captured||capturedHeader>raw.length-dataOffset)anomalies.push('capture truncation');
  return {recordIndex:index,format,encapsulation:fullHeader?'USB_LINUX_MMAPPED':'USB_LINUX',timestamp,timestampMicros,bus:String(raw.readUInt16LE(12)),device:String(raw[11]),deviceAddress:String(raw[11]),interfaceNumber:UNKNOWN,interfaceAlternateSetting:UNKNOWN,endpoint:`0x${ep.toString(16).padStart(2,'0')}`,endpointNumber:ep&15,direction:ep===0?'UNKNOWN':ep&0x80?'IN':'OUT',transferType:transferName(transfer),status:statusName(raw.readInt32LE(28)),irpId:raw.readBigUInt64LE(0).toString(),length,dataLength:length,capturedLength:captured,dataTruncated:captured<length,dataOffset,rawOffset:offset,rawLength:raw.length,payloadSha256:createHash('sha256').update(raw.subarray(dataOffset,dataOffset+captured)).digest('hex'),anomalies,info:raw[8]===83?'SUBMISSION':'COMPLETION',...(fullHeader&&(transfer===0||transfer===1)?{interval:raw.readInt32LE(48)}:{}),...(fullHeader&&transfer===0?{startFrame:raw.readInt32LE(52)}:{}),...(isoPacketCount!==undefined?{isoPacketCount}:{}),...(isoErrorCount!==undefined?{isoErrorCount}: {})};
}
function linuxRecord(raw:Buffer,index:number,offset:number,timestamp:string,format:'PCAP'|'PCAPNG',mapped:boolean,maxPayload:number,maxIso:number):UsbCaptureRecord{return linuxBinaryRecord(raw,index,offset,timestamp,format,mapped,maxPayload,maxIso);}
function usbpcapRecord(raw:Buffer,index:number,offset:number,timestamp:string,format:'PCAP'|'PCAPNG',maxPayload:number,maxIso:number):UsbCaptureRecord{
  const headerLength=raw.readUInt16LE(0),transfer=raw[22]??255,ep=raw[21]??0,length=raw.readUInt32LE(23),info=raw[16]??0,response=(info&1)===1,anomalies:string[]=[];
  let isoCount:number|undefined,isoErrorCount:number|undefined;const expected=transfer===2?28:transfer===0?39:27;
  if(headerLength<expected||headerLength>raw.length){anomalies.push(`invalid USBPcap header length ${headerLength}`);}
  if(transfer===0){if(raw.length<39)anomalies.push('truncated isochronous header');else{isoCount=raw.readUInt32LE(31);isoErrorCount=raw.readUInt32LE(35);if(isoCount>maxIso||headerLength<39+isoCount*12){anomalies.push(`isochronous packet count ${isoCount} exceeds bound or header capacity`);isoCount=Math.min(isoCount,maxIso);}}}
  if(transfer===2){const stage=raw[27]??255;if(stage>3)anomalies.push(`unknown control stage ${stage}`);}
  const dataOffset=Math.min(headerLength,raw.length),captured=Math.min(length,Math.max(0,raw.length-dataOffset),maxPayload);if(length>captured)anomalies.push('capture truncation');
  return {recordIndex:index,format,encapsulation:'USBPcap',timestamp,timestampMicros:0,bus:String(raw.readUInt16LE(17)),device:String(raw.readUInt16LE(19)),deviceAddress:String(raw.readUInt16LE(19)),interfaceNumber:UNKNOWN,interfaceAlternateSetting:UNKNOWN,endpoint:`0x${ep.toString(16).padStart(2,'0')}`,endpointNumber:ep&15,direction:ep&0x80?'IN':'OUT',transferType:transferName(transfer),status:statusName(raw.readInt32LE(10)),function:`0x${raw.readUInt16LE(14).toString(16)}`,irpId:raw.readBigUInt64LE(2).toString(),info:response?'PDO_TO_FDO':'FDO_TO_PDO',length,dataLength:length,capturedLength:captured,dataTruncated:captured<length,dataOffset,rawOffset:offset,rawLength:raw.length,payloadSha256:createHash('sha256').update(raw.subarray(dataOffset,dataOffset+captured)).digest('hex'),anomalies,...(isoCount!==undefined?{isoPacketCount:isoCount}:{}),...(isoErrorCount!==undefined?{isoErrorCount}:{}),...(transfer===2?{controlStage:raw[27]??255}: {})};
}
function pairingKey(record:UsbCaptureRecord):string{return `${record.encapsulation??record.format}\0${record.bus}\0${record.device}\0${record.endpoint}\0${record.irpId}`;}
class Pairer {
  private readonly pending=new Map<string,number[]>();
  constructor(private readonly result:UsbCaptureAnalysis,private readonly max:number){}
  private key(record:UsbCaptureRecord):string{return pairingKey(record);}
  apply(record:UsbCaptureRecord):void{
    if((record.encapsulation==='USBPcap'||record.encapsulation==='USB_LINUX'||record.encapsulation==='USB_LINUX_MMAPPED'||record.format==='USBMON')&&typeof record.irpId==='string'){
      const requestInfo=record.encapsulation==='USBPcap'?'FDO_TO_PDO':'SUBMISSION',responseInfo=record.encapsulation==='USBPcap'?'PDO_TO_FDO':'COMPLETION',key=this.key(record);
      if(record.info===requestInfo){const list=this.pending.get(key)??[];if(list.length<this.max)list.push(record.recordIndex);this.pending.set(key,list);}
      else if(record.info===responseInfo){const request=this.pending.get(key)?.shift();record.responseTo=record.irpId;if(request!==undefined&&this.result.transactions.length<this.max)this.result.transactions.push({tag:record.irpId,requestIndex:request,responseIndex:record.recordIndex,requestLength:this.result.records[request]?.dataLength??0,responseLength:record.dataLength,complete:true});else anomaly(this.result,`record ${record.recordIndex}: response without paired request`);}
    }
  }
  incomplete():void{for(const pending of this.pending.values())for(const requestIndex of pending){const record=this.result.records[requestIndex];if(this.result.transactions.length<this.max)this.result.transactions.push({tag:record?.irpId??UNKNOWN,requestIndex,requestLength:record?.dataLength??0,responseLength:0,complete:false});}}
}
function usbMagic(magic:number):{little:boolean;nano:boolean}|undefined{if([0xa1b2c3d4,0xa1b23c4d].includes(magic))return {little:true,nano:magic===0xa1b23c4d};if([0xd4c3b2a1,0x4d3cb2a1].includes(magic))return {little:false,nano:magic===0x4d3cb2a1};return undefined;}
function validPcapHead(head:Buffer):boolean{if(head.length<24)return false;const magic=usbMagic(head.readUInt32LE(0));if(!magic)return false;const u16=(offset:number)=>magic.little?head.readUInt16LE(offset):head.readUInt16BE(offset);return u16(4)===2&&u16(6)===4;}
export function detectUsbFormat(name:string,head:Buffer):'PCAP'|'PCAPNG'|'USBMON'|'HID_DESCRIPTOR'|'SNAPSHOT'|undefined{
  if(validPcapHead(head))return 'PCAP';if(head.length>=4&&head.readUInt32BE(0)===0x0a0d0d0a)return 'PCAPNG';if(/\.(pcap|cap)$/i.test(name))return 'PCAP';if(/\.pcapng$/i.test(name))return 'PCAPNG';if(/usbmon/i.test(name))return 'USBMON';if(/hid|descriptor/i.test(name)&&head.length&&head[0]===5)return 'HID_DESCRIPTOR';if(/snapshot/i.test(name)||(head.length&&head[0]===123))return 'SNAPSHOT';return undefined;
}
function base(format:UsbCaptureAnalysis['format'],sourceBytes:number,bytesRead:number):UsbCaptureAnalysis{return {format,linkType:UNKNOWN,byteOrder:'UNKNOWN',sourceBytes,bytesRead,recordCount:0,records:[],timeline:[],transactions:[],descriptorCandidates:[],stats:stats(),anomalies:[],truncated:bytesRead<sourceBytes,limitations:bytesRead<sourceBytes?[`Capture byte limit ${bytesRead} reached`]:[],interfaceLinkTypes:[],skippedPackets:0};}
export async function parseUsbCapture(buffer:Buffer,options:CaptureLimits={}):Promise<UsbCaptureAnalysis>{
  if(buffer.length>=4&&usbMagic(buffer.readUInt32LE(0)))return parsePcap(buffer,options);
  if(buffer.length>=4&&buffer.readUInt32BE(0)===0x0a0d0d0a)return parsePcapng(buffer,options);
  throw new Error('Malformed PCAP/PCAPNG: missing recognized file header');
}
async function parsePcap(buffer:Buffer,options:CaptureLimits):Promise<UsbCaptureAnalysis>{
  if(buffer.length<24)throw new Error('Malformed PCAP: truncated global header');const magic=usbMagic(buffer.readUInt32LE(0))!;const r=(o:number)=>magic.little?buffer.readUInt16LE(o):buffer.readUInt16BE(o),q=(o:number)=>magic.little?buffer.readUInt32LE(o):buffer.readUInt32BE(o);if(r(4)!==2||r(6)!==4)throw new Error('Malformed PCAP: unsupported version');
  const linkType=q(20);if(![186,189,220,249].includes(linkType))throw new Error(`Unsupported USB link type ${linkType}; expected DLT_USB_RAW=186, DLT_USB_LINUX=189, DLT_USB_LINUX_MMAPPED=220 or DLT_USBPCAP=249`);
  const result=base('PCAP',buffer.length,buffer.length);result.linkType=linkType;result.byteOrder=magic.little?'little':'big';const maxRecords=limit(options,'maxRecords'),maxTimeline=limit(options,'maxTimeline'),maxPayload=limit(options,'maxPayloadBytes'),maxIso=limit(options,'maxIsoPackets'),maxDescriptors=limit(options,'maxDescriptors'),maxInterfaces=limit(options,'maxInterfaces'),maxTransactions=limit(options,'maxTransactions');const pairer=new Pairer(result,maxTransactions),requests=new Map<string,DescriptorCandidate>();let offset=24,examined=0;
  while(offset<buffer.length){
    if(examined++>=maxRecords){bounded(result,`Record limit ${maxRecords} reached`);break;}if(offset+16>buffer.length){if(result.truncated)break;throw new Error('Malformed PCAP: truncated packet header');}
    const captured=q(offset+8),original=q(offset+12);if(captured>original)throw new Error(`Malformed PCAP: record ${result.recordCount} captured length exceeds original`);if(offset+16+captured>buffer.length){if(result.truncated)break;throw new Error(`Malformed PCAP: record ${result.recordCount} data is truncated`);}
    const raw=buffer.subarray(offset+16,offset+16+captured),secs=q(offset),fraction=q(offset+4),timestamp=new Date(secs*1000+Math.floor(fraction/(magic.nano?1_000_000:1_000))).toISOString();let record:UsbCaptureRecord|undefined;
    if(linkType===249){if(raw.length<27)anomaly(result,`record ${result.recordCount}: short USBPcap header`);else record=usbpcapRecord(raw,result.recordCount,offset+16,timestamp,'PCAP',maxPayload,maxIso);}
    else if(linkType===186){record=rawRecord(raw,result.recordCount,offset+16,timestamp,'PCAP');}
    else{const minimum=linkType===220?64:48;if(raw.length<minimum)anomaly(result,`record ${result.recordCount}: short Linux USB header`);else record=linuxRecord(raw,result.recordCount,offset+16,timestamp,'PCAP',linkType===220,maxPayload,maxIso);}
    if(record){for(const item of record.anomalies)anomaly(result,`record ${record.recordIndex}: ${item}`);finalizeRecord(result,record,raw,maxTimeline,maxDescriptors,maxInterfaces);pairer.apply(record);if(record.descriptorCandidate){record.descriptorCandidate.state='REQUEST_ONLY';if(record.irpId){if(requests.size>=maxDescriptors&&!requests.has(pairingKey(record)))bounded(result,`Descriptor candidate limit ${maxDescriptors} reached`);else requests.set(pairingKey(record),record.descriptorCandidate);}if(result.descriptorCandidates.length<maxDescriptors)result.descriptorCandidates.push(record.descriptorCandidate);else bounded(result,`Descriptor candidate limit ${maxDescriptors} reached`);}if((record.encapsulation==='USBPcap'||record.encapsulation==='USB_LINUX'||record.encapsulation==='USB_LINUX_MMAPPED')&&record.info===(record.encapsulation==='USBPcap'?'PDO_TO_FDO':'COMPLETION')&&record.irpId){const candidate=requests.get(pairingKey(record));if(candidate&&candidate.device===record.device&&candidate.length>=2)candidate.state=record.capturedLength<candidate.length?'TRUNCATED':'OBSERVED';}}
    offset+=16+captured;
  }
  pairer.incomplete();
  return result;
}
async function parsePcapng(buffer:Buffer,options:CaptureLimits):Promise<UsbCaptureAnalysis>{
  const result=base('PCAPNG',buffer.length,buffer.length),maxRecords=limit(options,'maxRecords'),maxTimeline=limit(options,'maxTimeline'),maxPayload=limit(options,'maxPayloadBytes'),maxIso=limit(options,'maxIsoPackets'),maxDescriptors=limit(options,'maxDescriptors'),maxInterfaces=limit(options,'maxInterfaces'),maxTransactions=limit(options,'maxTransactions'),pairer=new Pairer(result,maxTransactions);let little=true,offset=0,blockCount=0,interfaceCount=0;let interfaces:{linkType:number;snaplen:number}[]=[];const requests=new Map<string,{candidate:DescriptorCandidate;recordIndex:number}>();
  while(offset<buffer.length){
    if(blockCount++>100_000){bounded(result,'PCAPNG block limit 100000 reached');break;}if(result.recordCount>=maxRecords){bounded(result,`Record limit ${maxRecords} reached`);break;}if(offset+12>buffer.length){if(result.truncated)break;throw new Error('Malformed PCAPNG: truncated block header');}
    if(buffer.readUInt32BE(offset)===0x0a0d0d0a){if(offset+28>buffer.length){if(result.truncated)break;throw new Error('Malformed PCAPNG: truncated section header');}const bom=buffer.readUInt32LE(offset+8);if(bom===0x1a2b3c4d)little=true;else if(bom===0x4d3c2b1a)little=false;else throw new Error('Malformed PCAPNG: invalid byte-order magic');interfaces=[];result.byteOrder=little?'little':'big';}
    const q=(o:number)=>little?buffer.readUInt32LE(o):buffer.readUInt32BE(o),h=(o:number)=>little?buffer.readUInt16LE(o):buffer.readUInt16BE(o),type=q(offset),length=q(offset+4);
    if(length<12||length%4||offset+length>buffer.length){if(result.truncated)break;throw new Error('Malformed PCAPNG: invalid or truncated block length');}if(q(offset+length-4)!==length)throw new Error('Malformed PCAPNG: block length trailer mismatch');const body=offset+8,bodyLength=length-12;
    if(type===1){if(bodyLength<8)throw new Error('Malformed PCAPNG: truncated interface description');if(interfaceCount++>=maxInterfaces)throw new Error(`PCAPNG interface inventory exceeds bound ${maxInterfaces}`);const linkType=h(body)&0xffff;interfaces.push({linkType,snaplen:q(body+4)});result.interfaceLinkTypes.push(linkType);}
    else if([6,2,3].includes(type)){
      let id=0,captured=0,original=0,data=0,secs=0,fraction=0;if(type===6||type===2){const fixed=type===6?20:20;if(bodyLength<fixed)throw new Error('Malformed PCAPNG: truncated packet block');id=type===6?q(body):h(body);captured=q(body+12);original=q(body+16);data=body+20;if(type===6){const high=q(body),low=q(body+4);secs=high;fraction=low;}}
      else{if(bodyLength<4)throw new Error('Malformed PCAPNG: truncated simple packet block');original=q(body);captured=Math.min(original,interfaces[0]?.snaplen||original,bodyLength-4);data=body+4;}
      const iface=interfaces[id];if(!iface)throw new Error('Malformed PCAPNG: packet references an unknown interface');if(![186,189,220,249].includes(iface.linkType)){result.skippedPackets++;anomaly(result,`Skipped packet on unsupported link type ${iface.linkType}`);if(!result.limitations.some(item=>item.includes(`link type ${iface.linkType}`)))result.limitations.push(`Link type ${iface.linkType} is outside the supported USB parser set and was skipped`);offset+=length;continue;}result.linkType=iface.linkType;if(captured>bodyLength-(data-body)){if(result.truncated)break;throw new Error('Malformed PCAPNG: captured packet length exceeds block');}if(original<captured)throw new Error('Malformed PCAPNG: original length is smaller than captured length');
      const raw=buffer.subarray(data,data+captured);if(result.recordCount>=maxRecords){bounded(result,`Record limit ${maxRecords} reached`);break;}const timestamp=type===6?new Date(secs*1000+Math.floor(fraction/1_000)).toISOString():'UNKNOWN';let record:UsbCaptureRecord|undefined;
      if(iface.linkType===249){if(raw.length<27)anomaly(result,'short USBPcap header');else record=usbpcapRecord(raw,result.recordCount,data,timestamp,'PCAPNG',maxPayload,maxIso);}else if(iface.linkType===186){record=rawRecord(raw,result.recordCount,data,timestamp,'PCAPNG');}else{const minimum=iface.linkType===220?64:48;if(raw.length<minimum)anomaly(result,'short Linux USB header');else record=linuxRecord(raw,result.recordCount,data,timestamp,'PCAPNG',iface.linkType===220,maxPayload,maxIso);}
      if(record){
        if(record.timestampMicros===0&&type===6)record.timestampMicros=secs*1_000_000+fraction;
        for(const item of record.anomalies)anomaly(result,`record ${record.recordIndex}: ${item}`);finalizeRecord(result,record,raw,maxTimeline,maxDescriptors,maxInterfaces);pairer.apply(record);
        if(record.descriptorCandidate){const key=record.irpId?pairingKey(record):`unpaired:${record.recordIndex}`;if(requests.size>=maxDescriptors&&!requests.has(key))bounded(result,`Descriptor candidate limit ${maxDescriptors} reached`);else requests.set(key,{candidate:record.descriptorCandidate,recordIndex:record.recordIndex});}
        if((record.encapsulation==='USBPcap'||record.encapsulation==='USB_LINUX'||record.encapsulation==='USB_LINUX_MMAPPED')&&record.info===(record.encapsulation==='USBPcap'?'PDO_TO_FDO':'COMPLETION')&&record.capturedLength>=2){const request=record.irpId?requests.get(pairingKey(record)):undefined;if(request&&request.candidate.device===record.device&&request.candidate.length>=2){request.candidate.state=record.capturedLength<request.candidate.length?'TRUNCATED':'OBSERVED';requests.delete(pairingKey(record));if(result.descriptorCandidates.length<maxDescriptors)result.descriptorCandidates.push(request.candidate);else bounded(result,`Descriptor candidate limit ${maxDescriptors} reached`);}}
      }
    }
    offset+=length;
  }
  pairer.incomplete();
  for(const request of requests.values()){request.candidate.state='REQUEST_ONLY';if(result.descriptorCandidates.length<maxDescriptors)result.descriptorCandidates.push(request.candidate);else bounded(result,`Descriptor candidate limit ${maxDescriptors} reached`);}
  return result;
}
interface UsbmonLine { line:string; offset:number; truncated?:boolean }
function createUsbmonParser(sourceBytes:number,options:CaptureLimits={}):{push:(item:UsbmonLine)=>boolean;finish:()=>UsbCaptureAnalysis}{
  const result=base('USBMON',sourceBytes,sourceBytes),maxRecords=limit(options,'maxRecords'),maxTimeline=limit(options,'maxTimeline'),maxTransactions=limit(options,'maxTransactions'),maxDescriptors=limit(options,'maxDescriptors'),maxInterfaces=limit(options,'maxInterfaces'),maxPayload=limit(options,'maxPayloadBytes'),maxIso=limit(options,'maxIsoPackets'),maxLineBytes=limit(options,'maxLineBytes'),pairer=new Pairer(result,maxTransactions),pendingCandidates=new Map<string,DescriptorCandidate>();
  const push=(item:UsbmonLine):boolean=>{
    const rawLine=item.line,lineOffset=item.offset;
    if(item.truncated){anomaly(result,`offset ${lineOffset}: usbmon line exceeded ${maxLineBytes}-byte limit and was skipped`);return true;}
    const line=rawLine.endsWith('\r')?rawLine.slice(0,-1):rawLine;
    if(result.recordCount>=maxRecords){bounded(result,`Record limit ${maxRecords} reached`);return false;}if(!line.trim())return true;const parts=line.trim().split(/\s+/);if(parts.length<6){anomaly(result,`offset ${lineOffset}: malformed usbmon row`);return true;}
    const [tag,timestampWord,event,address,statusWord]=parts as [string,string,string,string,string];const match=/^([CZIB])([io])(?::(\d+))?:(\d+):(\d+)$/.exec(address),timestampMicros=Number(timestampWord);
    if(!tag||tag.length>128||!['S','C','E'].includes(event!)||!match||!/^\d+$/.test(timestampWord!)||!Number.isSafeInteger(timestampMicros)){anomaly(result,`offset ${lineOffset}: invalid usbmon tag/timestamp/event/address`);return true;}
    const transferCode=match[1]!,directionCode=match[2]!,bus=match[3]??UNKNOWN,deviceNumber=Number(match[4]),epNumber=Number(match[5]),device=String(deviceNumber);if(!Number.isInteger(deviceNumber)||deviceNumber<0||deviceNumber>127||!Number.isInteger(epNumber)||epNumber<0||epNumber>255){anomaly(result,`offset ${lineOffset}: invalid endpoint`);return true;}
    const transfer=transferCode==='Z'?'ISOCHRONOUS':transferCode==='I'?'INTERRUPT':transferCode==='C'?'CONTROL':'BULK',direction=directionCode==='i'?'IN':'OUT',info=event==='C'||event==='E'?'COMPLETION':'SUBMISSION';let cursor=5,status=0,interval:number|undefined,startFrame:number|undefined,statusIsoErrors:number|undefined;
    if(statusWord==='s'||statusWord==='a'){
      if(statusWord==='a')anomaly(result,`offset ${lineOffset}: setup packet was present but not captured`);
    }else{
      const statusMatch=/^(-?\d+)(?::(\d+))?(?::(\d+))?(?::(\d+))?$/.exec(statusWord!);if(!statusMatch){anomaly(result,`offset ${lineOffset}: invalid usbmon status`);return true;}
      status=Number(statusMatch[1]);if(!Number.isSafeInteger(status)||status<-2_147_483_648||status>0xffffffff){anomaly(result,`offset ${lineOffset}: usbmon status exceeds int32 bound`);return true;}
      interval=optionalUint(statusMatch[2]);startFrame=optionalUint(statusMatch[3]);statusIsoErrors=optionalUint(statusMatch[4]);
    }
    const setup=Buffer.alloc(8);let rowValid=true;
    if(statusWord==='s'){
      if(parts.length<cursor+5){anomaly(result,`offset ${lineOffset}: truncated setup packet`);return true;}const widths=[1,1,2,2,2];let setupOffset=0;
      for(let index=0;index<5;index++){const word=parts[cursor+index]!;if(!/^(?:0x)?[0-9a-f]+$/i.test(word)){anomaly(result,`offset ${lineOffset}: invalid setup word`);rowValid=false;break;}const value=Number.parseInt(word,16),width=widths[index]!;if(!Number.isSafeInteger(value)||value>=2**(width*8)){anomaly(result,`offset ${lineOffset}: setup word exceeds field width`);rowValid=false;break;}for(let byte=0;byte<width;byte++)setup[setupOffset+byte]=(value>>>(8*byte))&255;setupOffset+=width;}
      if(!rowValid)return true;cursor+=5;
    }
    let isoPacketCount:number|undefined,isoErrorCount:number|undefined;
    if(transfer==='ISOCHRONOUS'&&bus!==UNKNOWN&&parts[cursor]&&/^\d+$/.test(parts[cursor]!)){
      const count=Number(parts[cursor++]!);if(!Number.isSafeInteger(count)||count>maxIso||cursor+count>=parts.length){anomaly(result,`offset ${lineOffset}: isochronous descriptor count ${count} exceeds bound or capacity`);return true;}isoPacketCount=count;isoErrorCount=statusIsoErrors;
      for(let index=0;index<count;index++){
        const descriptor=/^(-?\d+):(\d+):(\d+)$/.exec(parts[cursor+index]!),values=descriptor?.slice(1).map(Number);
        if(!descriptor||!values||!values.every(Number.isSafeInteger)||values[1]!<0||values[1]!>0xffffffff||values[2]!<0||values[2]!>0xffffffff||values[0]!<-2_147_483_648||values[0]!>0xffffffff||values[1]!+values[2]!>0x1_0000_0000){anomaly(result,`offset ${lineOffset}: invalid isochronous descriptor`);rowValid=false;break;}
        if(info==='COMPLETION'&&values[0]!==0&&statusIsoErrors===undefined)isoErrorCount=(isoErrorCount??0)+1;
      }
      if(!rowValid)return true;if(isoErrorCount!==undefined&&isoErrorCount>0xffffffff){anomaly(result,`offset ${lineOffset}: isochronous error count exceeds uint32 bound`);return true;}cursor+=count;
    }else if(statusIsoErrors!==undefined)isoErrorCount=statusIsoErrors;
    if(cursor>=parts.length){anomaly(result,`offset ${lineOffset}: missing data length`);return true;}const lengthWord=parts[cursor++]!;if(!/^\d+$/.test(lengthWord)){anomaly(result,`offset ${lineOffset}: invalid data length`);return true;}const declared=Number(lengthWord);if(!Number.isSafeInteger(declared)||declared>0xffffffff){anomaly(result,`offset ${lineOffset}: data length exceeds uint32 bound`);return true;}
    let saved:number|undefined;if(parts[cursor]&&/^\d+$/.test(parts[cursor]!)&&parts[cursor+1]&&['=','>','<'].includes(parts[cursor+1]!)){saved=Number(parts[cursor++]);if(!Number.isSafeInteger(saved)){anomaly(result,`offset ${lineOffset}: saved length exceeds safe integer bound`);return true;}}
    let dataBytes=Buffer.alloc(0);
    if(parts[cursor]==='='){const words=parts.slice(cursor+1);if(words.some(word=>!/^(?:[0-9a-f]{2}){1,4}$/i.test(word))){anomaly(result,`offset ${lineOffset}: invalid payload hex word`);return true;}dataBytes=Buffer.from(words.join(''),'hex');}
    else if(parts[cursor]&&parts[cursor]!=='>'&&parts[cursor]!=='<'){anomaly(result,`offset ${lineOffset}: invalid usbmon data tag`);return true;}
    saved=Math.min(saved??dataBytes.length,declared,maxPayload);const dateMs=Math.floor(timestampMicros/1_000),timestamp=dateMs<=8_640_000_000_000_000?new Date(dateMs).toISOString():'UNKNOWN';
    const record:UsbCaptureRecord={recordIndex:result.recordCount,format:'USBMON',timestamp,timestampMicros,bus,device,deviceAddress:device,interfaceNumber:UNKNOWN,interfaceAlternateSetting:UNKNOWN,endpoint:`0x${epNumber.toString(16).padStart(2,'0')}`,endpointNumber:epNumber&15,direction,transferType:transfer,status:statusName(status),irpId:tag,info,length:declared,dataLength:declared,capturedLength:saved,dataTruncated:saved<declared,dataOffset:UNKNOWN,rawOffset:lineOffset,rawLength:Buffer.byteLength(line),payloadSha256:createHash('sha256').update(dataBytes.subarray(0,saved)).digest('hex'),anomalies:[],...(interval!==undefined?{interval}:{}),...(startFrame!==undefined?{startFrame}:{}),...(isoPacketCount!==undefined?{isoPacketCount}:{}),...(isoErrorCount!==undefined?{isoErrorCount}: {})};
    if(saved<declared)record.anomalies.push('capture truncation');for(const item of record.anomalies)anomaly(result,`record ${record.recordIndex}: ${item}`);finalizeRecord(result,record,setup,maxTimeline,maxDescriptors,maxInterfaces);pairer.apply(record);
    if(record.descriptorCandidate){const key=pairingKey(record);if(pendingCandidates.size<maxDescriptors)pendingCandidates.set(key,record.descriptorCandidate);if(result.descriptorCandidates.length<maxDescriptors)result.descriptorCandidates.push(record.descriptorCandidate);}
    if(info==='COMPLETION'){const key=pairingKey(record),candidate=pendingCandidates.get(key);if(candidate&&candidate.device===device)candidate.state=saved<candidate.length?'TRUNCATED':'OBSERVED';pendingCandidates.delete(key);}
    return true;
  };
  return {push,finish:()=>{pairer.incomplete();return result;}};
}
function parseUsbmonLines(lines:Iterable<UsbmonLine>,sourceBytes:number,options:CaptureLimits={}):UsbCaptureAnalysis{const parser=createUsbmonParser(sourceBytes,options);for(const item of lines){if(!parser.push(item))break;}return parser.finish();}
export function parseUsbmon(text:string,options:CaptureLimits={}):UsbCaptureAnalysis{
  const lines:UsbmonLine[]=[];let offset=0;for(const raw of text.split('\n')){lines.push({line:raw,offset});offset+=Buffer.byteLength(raw)+1;}return parseUsbmonLines(lines,Buffer.byteLength(text),options);
}
function throwIfAborted(signal?:AbortSignal):void{if(signal?.aborted)throw signal.reason instanceof Error?signal.reason:new DOMException('The operation was aborted','AbortError');}
async function* usbmonLines(file:string,maxLineBytes:number,signal?:AbortSignal):AsyncGenerator<UsbmonLine>{
  const decoder=new StringDecoder('utf8'),stream=createReadStream(file,{highWaterMark:65_536});let pending='',baseBytes=0,discarding=false;
  try{
    for await(const chunk of stream){
      throwIfAborted(signal);pending+=decoder.write(Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk));
      if(discarding){const newline=pending.indexOf('\n');if(newline<0){pending='';continue;}baseBytes+=Buffer.byteLength(pending.slice(0,newline+1));pending=pending.slice(newline+1);discarding=false;continue;}
      let newline:number;while((newline=pending.indexOf('\n'))>=0){const raw=pending.slice(0,newline),offset=baseBytes;baseBytes+=Buffer.byteLength(raw)+1;pending=pending.slice(newline+1);if(Buffer.byteLength(raw)>maxLineBytes)yield {line:'',offset,truncated:true};else yield {line:raw.endsWith('\r')?raw.slice(0,-1):raw,offset};}
      if(Buffer.byteLength(pending)>maxLineBytes){const offset=baseBytes;baseBytes+=Buffer.byteLength(pending);pending='';discarding=true;yield {line:'',offset,truncated:true};}
    }
    pending+=decoder.end();
    if(discarding){const newline=pending.indexOf('\n');if(newline>=0){baseBytes+=Buffer.byteLength(pending.slice(0,newline+1));pending=pending.slice(newline+1);discarding=false;}}
    if(!discarding&&pending){const offset=baseBytes;if(Buffer.byteLength(pending)>maxLineBytes)yield {line:'',offset,truncated:true};else yield {line:pending.endsWith('\r')?pending.slice(0,-1):pending,offset};}
  }finally{stream.destroy();}
}
export async function parseUsbmonStream(file:string,sourceBytes:number,options:CaptureLimits={},signal?:AbortSignal):Promise<UsbCaptureAnalysis>{const parser=createUsbmonParser(sourceBytes,options);for await(const item of usbmonLines(file,limit(options,'maxLineBytes'),signal)){if(!parser.push(item))break;}return parser.finish();}
function optionalUint(value:string|undefined):number|undefined{if(value===undefined)return undefined;const parsed=Number(value);return Number.isSafeInteger(parsed)&&parsed>=0&&parsed<=0xffffffff?parsed:undefined;}

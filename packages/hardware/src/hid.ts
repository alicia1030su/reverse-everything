import type { HidReport } from './types.js';

const MAX_ITEMS=4096,MAX_USAGES=256,MAX_COLLECTIONS=64;
const USAGE_PAGES:Record<number,string>={1:'Generic Desktop',7:'Keyboard / Keypad',8:'LEDs',9:'Button',12:'Consumer',13:'Digitizers',0xff00:'Vendor-defined'};
const DESKTOP_USAGES:Record<number,string>={1:'Pointer',2:'Mouse',4:'Joystick',5:'Game Pad',6:'Keyboard',0x30:'X',0x31:'Y',0x32:'Z'};
const KEY_NAMES=['','','','','Keyboard A','Keyboard B','Keyboard C','Keyboard D','Keyboard E','Keyboard F','Keyboard G','Keyboard H','Keyboard I','Keyboard J','Keyboard K','Keyboard L','Keyboard M','Keyboard N','Keyboard O','Keyboard P','Keyboard Q','Keyboard R','Keyboard S','Keyboard T','Keyboard U','Keyboard V','Keyboard W','Keyboard X','Keyboard Y','Keyboard Z'];
function signed(value:number,size:number):number { const bits=size*8,sign=2**(bits-1);return value>=sign?value-2**bits:value; }
/** Parses only item structure and a bounded HID metadata subset. Payload decoding/capture remains disabled. */
export function parseHidReportDescriptor(input:Uint8Array,maxBytes=65_536):HidReport {
  const requested=Number.isFinite(maxBytes)&&maxBytes>0?Math.min(Math.floor(maxBytes),65_536):65_536,bytes=Math.min(input.length,requested);const report:HidReport={valid:true,bytes,usagePages:[],usages:[],collections:[],keyboardCaptureDefault:'DISABLED',anomalies:[],truncated:input.length>requested};
  if(report.truncated)report.anomalies.push(`descriptor byte limit ${requested} reached`);
  let offset=0,items=0,usagePage=0,usageMinimum:number|undefined,usageMaximum:number|undefined,logicalMinimum:number|undefined,logicalMaximum:number|undefined,reportSize:number|undefined,reportCount:number|undefined;
  const collections:{usage:string;application:boolean}[]=[];
  while(offset<bytes){
    if(items++>=MAX_ITEMS){report.valid=false;report.truncated=true;report.anomalies.push(`HID item limit ${MAX_ITEMS} reached`);break;}
    const prefix=input[offset++]!;if(prefix===0xfe){report.valid=false;report.anomalies.push(`Long item at byte ${offset-1} is unsupported`);break;}
    const size=prefix&3,type=prefix>>>2&3,tag=prefix>>>4;const length=size===3?4:size;
    if(offset+length>bytes){report.valid=false;report.anomalies.push(`truncated item payload at byte ${offset-1}`);break;}
    let value=0;for(let i=0;i<length;i++)value+=input[offset+i]!*2**(8*i);
    if(tag===0&&type===1){usagePage=value;const name=USAGE_PAGES[value]??`0x${value.toString(16)}`;if(!report.usagePage)report.usagePage=name;if(report.usagePages.length<64&&!report.usagePages.includes(name))report.usagePages.push(name);else if(report.usagePages.length>=64)report.truncated=true;}
    else if(tag===0&&type===2){if(value>0xffffffff){report.valid=false;report.anomalies.push('Usage exceeds the uint32 bound');}else if(report.usages.length<MAX_USAGES)report.usages.push(usageName(usagePage,value));else report.truncated=true;}
    else if(tag===1&&type===2){usageMinimum=value;if(usageMaximum!==undefined)appendUsageRange(report,usagePage,usageMinimum,usageMaximum);}else if(tag===2&&type===2){usageMaximum=value;if(usageMinimum!==undefined)appendUsageRange(report,usagePage,usageMinimum,usageMaximum);}
    else if(tag===1&&type===1)logicalMinimum=signed(value,length);else if(tag===2&&type===1)logicalMaximum=signed(value,length);
    else if(tag===7&&type===1){reportSize=value;if(value<1||value>32){report.valid=false;report.anomalies.push(`Report size ${value} exceeds the 1..32 bound`);}}
    else if(tag===9&&type===1)reportCount=value;
    else if(tag===12&&type===0){if(value!==0){report.valid=false;report.anomalies.push('End Collection payload must be zero');}else{const collection=collections.pop();if(!collection){report.valid=false;report.anomalies.push('End Collection without matching Collection');}}}
    else if(tag===10&&type===0){
      if(value===0){report.valid=false;report.anomalies.push('Collection type zero is invalid');}
      else if(collections.length<MAX_COLLECTIONS){const usage=report.usages.at(-1)??usageName(usagePage,value);collections.push({usage,application:value===1});report.collections.push(usage);}else{report.valid=false;report.anomalies.push('Collection nesting limit reached');break;}
    }else if(tag===0&&type===0&&reportSize!==undefined&&reportCount!==undefined){
      if(reportSize*reportCount>MAX_BITS){report.valid=false;report.anomalies.push('Report field bit count exceeds 65536');break;}
    }
    offset+=length;
  }
  if(usageMinimum!==undefined)report.usageMinimum=usageMinimum;if(usageMaximum!==undefined)report.usageMaximum=usageMaximum;
  if(logicalMinimum!==undefined)report.logicalMinimum=logicalMinimum;if(logicalMaximum!==undefined)report.logicalMaximum=logicalMaximum;
  if(reportSize!==undefined)report.reportSize=reportSize;if(reportCount!==undefined)report.reportCount=reportCount;
  if(usageMinimum!==undefined&&usageMaximum!==undefined&&usageMinimum>usageMaximum){report.valid=false;report.anomalies.push('Usage range minimum exceeds maximum');}
  if(logicalMinimum!==undefined&&logicalMaximum!==undefined&&logicalMinimum>logicalMaximum){report.valid=false;report.anomalies.push('Logical minimum exceeds maximum');}
  if(collections.length){report.valid=false;report.anomalies.push(`${collections.length} unterminated Collection item(s)`);}
  return report;
}
const MAX_BITS=65_536;
function appendUsageRange(report:HidReport,page:number,minimum:number,maximum:number):void{
  if(minimum>maximum){report.valid=false;report.anomalies.push('Usage range minimum exceeds maximum');return;}
  if(maximum>0xffffffff){report.valid=false;report.anomalies.push('Usage range exceeds the uint32 bound');return;}
  const available=Math.max(0,MAX_USAGES-report.usages.length),count=Math.min(maximum-minimum+1,available);
  for(let index=0;index<count;index++)report.usages.push(usageName(page,minimum+index));
  if(maximum-minimum+1>available)report.truncated=true;
}
function usageName(page:number,usage:number):string { if(page===1)return DESKTOP_USAGES[usage]??`Generic Desktop 0x${usage.toString(16)}`;if(page===7)return KEY_NAMES[usage]??`Keypad / Keyboard 0x${usage.toString(16)}`;return `${USAGE_PAGES[page]??`Page 0x${page.toString(16)}`} 0x${usage.toString(16)}`; }

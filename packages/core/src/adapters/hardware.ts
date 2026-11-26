import { DeviceHotplugTracker, detectUsbFormat, inspectHardwareInput, parseUsbmonStream, type HardwareInputAnalysis } from '@reverse/hardware';
import { defineAdapter, limitedRead, noReconstruction, output, uploadPath } from './base.js';

interface PrepareResult { format:'PCAP'|'PCAPNG'|'USBMON'|'HID_DESCRIPTOR'|'SNAPSHOT';limits:{maxRecords:number;maxTimeline:number;maxDescriptors:number;maxLineBytes:number};maxBytes:number }
function bound(value:unknown,fallback:number,maximum:number):number { return typeof value==='number'&&Number.isFinite(value)&&value>0?Math.min(Math.floor(value),maximum):fallback; }
function assertAuthorized(authorized:boolean):void { if(!authorized)throw new Error('Explicit authorization confirmation is required before hardware capture analysis'); }
export const hardwareAdapter=defineAdapter({
  name:'hardware',version:'1.0.0',description:'Read-only device enumeration and bounded offline USB PCAP/PCAPNG/usbmon, HID descriptor and snapshot analysis. No device handles, live capture, serial access or keyboard report capture.',
  available:async()=>({available:true,detail:'Built-in offline parser plus read-only Windows CIM and Linux sysfs enumeration; no drivers, administrator privileges or device handles required'}),
  detect:async ctx=>{const head=await limitedRead(uploadPath(ctx),64);const format=detectUsbFormat(ctx.upload?.name??'',head);if(!format)throw new Error('Hardware adapter supports USB PCAP/PCAPNG, usbmon, HID descriptors and enumeration snapshots');return {adapter:'hardware',confidence:format==='SNAPSHOT'?0.8:1,format,details:{size:ctx.upload?.size},limitations:['Metadata analysis is offline; observed fields are not proof of device semantics']};},
  prepare:async ctx=>{assertAuthorized(ctx.project.authorizationConfirmed);const head=await limitedRead(uploadPath(ctx),64),format=detectUsbFormat(ctx.upload?.name??'',head);if(!format)throw new Error('Unsupported hardware input format');const maxRecords=bound(ctx.options.hardwareMaxRecords,20_000,100_000),maxTimeline=bound(ctx.options.hardwareMaxTimeline,20_000,100_000);return {format,limits:{maxRecords,maxTimeline,maxDescriptors:bound(ctx.options.hardwareMaxDescriptors,1_000,10_000),maxLineBytes:bound(ctx.options.hardwareMaxLineBytes,1_000_000,8_000_000)},maxBytes:bound(ctx.options.hardwareMaxBytes,16_000_000,64_000_000)};},
  analyze:async ctx=>{
    assertAuthorized(ctx.project.authorizationConfirmed);const prep=output<PrepareResult>(ctx,'PREPARE')??await hardwareAdapter.prepare(ctx) as PrepareResult;let analysis:HardwareInputAnalysis;
    if(prep.format==='USBMON'){
      const capture=await parseUsbmonStream(uploadPath(ctx),ctx.upload?.size??0,prep.limits,ctx.signal);
      analysis={format:'USBMON',capture,keyboardCaptureDefault:'DISABLED',limitations:['Offline usbmon text analysis only; input is parsed as a bounded stream']};
    }else{
      const bytes=await limitedRead(uploadPath(ctx),prep.maxBytes);analysis=await inspectHardwareInput(bytes,ctx.upload?.name??'',prep.limits);analysis.limitations.push(`Only the first ${prep.maxBytes} bytes may be read; raw packet payloads are not retained`);if(bytes.length<(ctx.upload?.size??0))analysis.limitations.push('Input byte limit reached; analysis is truncated');
    }
    await ctx.log('info',`Analyzed ${analysis.format}; keyboard capture remains disabled`,'hardware-offline');return analysis;
  },
  extractEvidence:async ctx=>{
    const analysis=output<HardwareInputAnalysis>(ctx,'ANALYZE');const capture=analysis.capture;
    if(capture){await ctx.evidence('EVIDENCE',`${capture.format} USB transfer metadata`,'usb-capture-parser','capture',{format:capture.format,linkType:capture.linkType,recordCount:capture.recordCount,stats:capture.stats,truncated:capture.truncated,anomalies:capture.anomalies.slice(0,200)});await ctx.evidence('INFERENCE','Request/response and descriptor candidates','usb-capture-parser','transactions',{transactions:capture.transactions.slice(0,1000),descriptorCandidates:capture.descriptorCandidates.slice(0,1000)});await ctx.writeArtifact('hardware-timeline.json',JSON.stringify(capture.timeline,null,2),'application/json');}
    if(analysis.descriptor)await ctx.evidence('EVIDENCE','Bounded HID report descriptor metadata','hid-descriptor-parser','descriptor',analysis.descriptor);
    if(analysis.snapshot){await ctx.evidence('EVIDENCE','Uploaded hardware snapshot metadata','snapshot-parser','snapshot',{platform:analysis.snapshot.platform,status:analysis.snapshot.status,deviceCount:analysis.snapshot.deviceCount});const events=new DeviceHotplugTracker().apply(analysis.snapshot.devices);await ctx.evidence('INFERENCE','Snapshot hotplug comparison requires explicit reauthorization','hardware-hotplug','events',events.map(event=>({type:event.type,stableKey:event.stableKey,authorizationRequired:event.authorizationRequired,reason:event.reason})));}
    await ctx.writeArtifact('hardware-analysis.json',JSON.stringify(analysis,null,2),'application/json');return {format:analysis.format,records:capture?.recordCount,truncated:capture?.truncated??false,artifacts:['hardware-analysis.json',...(capture?['hardware-timeline.json']:[])]};
  },
  reconstruct:async ctx=>{await ctx.evidence('UNKNOWN','Hardware observation does not reconstruct firmware or driver source','hardware-adapter','reconstruct',{reason:'No target code or device behavior was generated'});return noReconstruction(ctx,'No firmware, driver or device behavior was reconstructed');},
  validate:async ctx=>{const analysis=output<HardwareInputAnalysis>(ctx,'ANALYZE'),capture=analysis.capture;const checks=[{name:'recognized hardware format',passed:['PCAP','PCAPNG','USBMON','HID_DESCRIPTOR','SNAPSHOT'].includes(analysis.format)},{name:'keyboard capture disabled',passed:analysis.keyboardCaptureDefault==='DISABLED'},{name:'raw payloads omitted',passed:capture===undefined||capture.records.every(record=>!('dataPreview' in record))},{name:'bounded records',passed:capture===undefined||capture.recordCount===capture.records.length}];return {passed:checks.every(check=>check.passed),checks,limitations:[...analysis.limitations,...(analysis.descriptor?.anomalies??[]),...(capture?.anomalies??[]).slice(0,100)]};}
});

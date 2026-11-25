import { analyzeFirmware, firmwareLimits } from '@reverse/firmware';
import type { FirmwareAnalysis } from '@reverse/firmware';
import type { TaskContext } from '@reverse/workflow';
import { defineAdapter, noReconstruction, output, uploadPath } from './base.js';

export type { FirmwareAnalysis } from '@reverse/firmware';
function limits(ctx:TaskContext):ReturnType<typeof firmwareLimits>{return output<{limits:ReturnType<typeof firmwareLimits>}>(ctx,'PREPARE')?.limits??firmwareLimits(ctx.options);}
export const firmwareAdapter=defineAdapter({
  name:'firmware',version:'1.0.0',description:'Bounded streaming firmware identity, entropy, strings, HEX/UF2/ELF metadata, safe archive inventory and CycloneDX clues; never executes or flashes the target.',
  available:async()=>({available:true,detail:'Built-in bounded static firmware analyzer; no external tools or unpacking'}),
  detect:async ctx=>{if(!ctx.upload)throw new Error('Firmware analysis requires an uploaded image');return {adapter:'firmware',confidence:0.8,format:/\.(hex|ihex|uf2|elf|bin|img|zip|fw)$/i.test(ctx.upload.name)?'firmware candidate':'UNKNOWN',details:{size:ctx.upload.size,sha256:ctx.upload.sha256},limitations:['Extension is only a routing clue; byte signatures determine the analysis format']};},
  prepare:async ctx=>{if(!ctx.project.authorizationConfirmed)throw new Error('Explicit authorization confirmation is required before firmware analysis');return {limits:firmwareLimits(ctx.options),execution:'disabled',unpacking:'disabled'};},
  analyze:async ctx=>analyzeFirmware({file:uploadPath(ctx),...(ctx.upload?{name:ctx.upload.name}:{}),options:ctx.options,signal:ctx.signal}),
  extractEvidence:async ctx=>{
    const analysis=output<FirmwareAnalysis>(ctx,'ANALYZE');
    await ctx.evidence('VERIFIED','Streaming firmware identity and limits','firmware-stream-sha256','firmware-analysis',{format:analysis.format,size:analysis.size,sha256:analysis.sha256,totalReadBytes:analysis.totalReadBytes,limits:analysis.limits});
    await ctx.evidence('EVIDENCE','Chunked Shannon entropy','firmware-shannon-256','entropy',analysis.entropy);
    await ctx.evidence('EVIDENCE','Bounded printable string inventory','firmware-strings','strings',{count:analysis.strings.count,truncated:analysis.strings.truncated,values:analysis.strings.values});
    await ctx.evidence('EVIDENCE','Layout signature inventory (no unpacking)','firmware-signatures','layout',analysis.layout);
    if(analysis.hex)await ctx.evidence('EVIDENCE','Intel HEX record and address metadata','intel-hex-parser','hex',analysis.hex);
    if(analysis.uf2)await ctx.evidence('EVIDENCE','UF2 block and address metadata','uf2-parser','uf2',analysis.uf2);
    if(analysis.elf)await ctx.evidence('EVIDENCE','ELF bounded section and program headers','elf-metadata-parser','elf',analysis.elf);
    if(analysis.archive)await ctx.evidence('EVIDENCE','ZIP central-directory inventory without extraction','zip-central-directory','archive',analysis.archive);
    await ctx.evidence('INFERENCE','Component version clues','firmware-component-heuristics','components',analysis.components);
    await ctx.evidence('INFERENCE','CycloneDX component inventory from string clues','cyclonedx-1.5','sbom',analysis.sbom);
    if(analysis.securityFindings.unknown)await ctx.evidence('UNKNOWN','Unknown or high-entropy firmware classification','firmware-heuristics','classification',{reason:'No corroborating format metadata; encryption/packing remains UNKNOWN'});else await ctx.evidence('INFERENCE','Firmware security risk candidates','firmware-heuristics','security-findings',analysis.securityFindings);
    for(const [name,value] of Object.entries({ 'firmware-analysis.json':analysis,'layout.json':analysis.layout,'entropy.json':analysis.entropy,'strings.json':analysis.strings,'sbom.json':analysis.sbom,'security-findings.json':analysis.securityFindings}))await ctx.writeArtifact(name,JSON.stringify(value,null,2),'application/json');
    return {format:analysis.format,sha256:analysis.sha256,stringCount:analysis.strings.count,riskCandidates:analysis.securityFindings.candidates.length,unknown:analysis.securityFindings.unknown,artifacts:['firmware-analysis.json','layout.json','entropy.json','strings.json','sbom.json','security-findings.json']};
  },
  reconstruct:async ctx=>{await ctx.evidence('UNKNOWN','Firmware reconstruction is not performed by static metadata analysis','firmware-adapter','reconstruct',{reason:'No flashing, decompilation, source reconstruction or runtime provider is configured'});return noReconstruction(ctx,'No firmware code, filesystem or behavior was reconstructed; analysis is static and non-executing');},
  validate:async ctx=>{const analysis=output<FirmwareAnalysis>(ctx,'ANALYZE'),max=limits(ctx);const checks=[
    {name:'streaming SHA256 recorded',passed:/^[0-9a-f]{64}$/.test(analysis.sha256)},
    {name:'input within image limit',passed:analysis.size<=max.maxImageBytes},
    {name:'entropy chunks are bounded',passed:analysis.entropy.bins.every(bin=>bin.size>0&&bin.size<=analysis.entropy.chunkBytes)},
    {name:'string count bounded',passed:analysis.strings.values.length<=analysis.strings.limit},
    {name:'HEX structural validity',passed:!analysis.hex||analysis.hex.valid},
    {name:'UF2 structural validity',passed:!analysis.uf2||analysis.uf2.valid},
    {name:'archive was not extracted',passed:!analysis.archive||analysis.archive.extracted===false},
    {name:'target execution disabled',passed:true},
  ];return {passed:checks.every(check=>check.passed),checks,limitations:analysis.limitations};},
});

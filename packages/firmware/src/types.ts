export const DEFAULT_CHUNK_BYTES=65_536;
export interface FirmwareLimits {
  chunkBytes:number;maxImageBytes:number;maxStrings:number;maxStringBytes:number;maxStringTotalBytes:number;
  maxHexRecords:number;maxHexBytes:number;maxUf2Blocks:number;maxElfSections:number;maxElfProgramHeaders:number;maxElfBytes:number;
  maxArchiveEntries:number;maxArchiveTotalBytes:number;maxArchiveRatio:number;maxSignatureScanBytes:number;
}
export const DEFAULT_LIMITS:FirmwareLimits={
  chunkBytes:65_536,maxImageBytes:2_147_483_648,maxStrings:20_000,maxStringBytes:512,maxStringTotalBytes:8_000_000,
  maxHexRecords:1_000_000,maxHexBytes:256_000_000,maxUf2Blocks:1_000_000,maxElfSections:4096,maxElfProgramHeaders:4096,maxElfBytes:1_000_000_000,
  maxArchiveEntries:10_000,maxArchiveTotalBytes:512_000_000,maxArchiveRatio:200,maxSignatureScanBytes:16_000_000,
};
export interface EntropyBin { offset:number;size:number;entropy:number }
export interface EntropyAnalysis { algorithm:'Shannon-256';chunkBytes:number;global:number;bins:EntropyBin[] }
export interface FirmwareString { offset:number;encoding:'ASCII'|'UTF-16LE';value:string;truncated:boolean }
export interface StringAnalysis { values:FirmwareString[];count:number;limit:number;truncated:boolean }
export interface HexOverlap { address:number;size:number;record:number }
export interface HexAnalysis {
  format:'Intel HEX';recordCount:number;byteCount:number;valid:boolean;checksumErrors:number[];overlaps:HexOverlap[];
  types:Record<string,number>;addressBase:number;minAddress:number|null;maxAddress:number|null;overflow:boolean;eof:boolean;
}
export interface Uf2Analysis {
  format:'UF2';blockCount:number;payloadBytes:number;valid:boolean;flags:number[];families:string[];numBlocks:number|null;
  minAddress:number|null;maxAddress:number|null;addressRegions:{start:string;size:number}[];overlaps:number;
}
export interface ElfSection { index:number;name:string;type:number;flags:string;address:string;offset:number;size:number }
export interface ElfProgramHeader { index:number;type:string;offset:number;virtualAddress:string;physicalAddress:string;fileSize:number;memorySize:number;flags:string }
export interface ElfAnalysis {
  format:'ELF';architecture:string;bits:32|64;endian:'little'|'big';entry:string;type:string;machine:number;sections:ElfSection[];programHeaders:ElfProgramHeader[];
  declaredSections:number;declaredProgramHeaders:number;truncated:boolean;
}
export interface LayoutSignature { format:string;offset:number;confidence:'EVIDENCE';details?:Record<string,string|number> }
export interface LayoutAnalysis { formats:string[];signatures:LayoutSignature[];encrypted:boolean;notes:string[] }
export interface ComponentClue { name:string;version:string;kind:'INFERENCE';offset:number;matched:string }
export interface ComponentAnalysis { values:ComponentClue[];truncated:boolean }
export interface ArchiveEntry { name:string;compressedSize:number;uncompressedSize:number;compressed:boolean }
export interface ArchiveAnalysis { entries:number;values:ArchiveEntry[];compressedBytes:number;uncompressedBytes:number;maxRatio:number;extracted:false;truncated:boolean }
export interface RiskCandidate { code:string;severity:'INFO'|'MEDIUM'|'HIGH';classification:'UNKNOWN'|'INFERENCE';offset:number;description:string }
export interface SecurityAnalysis { candidates:RiskCandidate[];unknown:boolean;encrypted:boolean;highEntropyRegions:{offset:number;size:number;entropy:number}[];limitations:string[] }
export interface SbomComponent { type:'library'|'operating-system'|'application';name:string;version:string;purl:string;evidence:{kind:'INFERENCE';offset:number} }
export interface FirmwareSbom { bomFormat:'CycloneDX';specVersion:'1.5';version:number;metadata:{component:{type:'application',name:string;version:'UNKNOWN'}};components:SbomComponent[];limitations:string[] }
export interface FirmwareAnalysis {
  format:string;size:number;sha256:string;entropy:EntropyAnalysis;strings:StringAnalysis;hex:HexAnalysis|null;uf2:Uf2Analysis|null;elf:ElfAnalysis|null;
  layout:LayoutAnalysis;components:ComponentAnalysis;archive:ArchiveAnalysis|null;sbom:FirmwareSbom;securityFindings:SecurityAnalysis;
  limits:FirmwareLimits;totalReadBytes:number;truncated:boolean;limitations:string[];
}

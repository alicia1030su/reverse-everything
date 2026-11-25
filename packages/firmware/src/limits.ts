import { DEFAULT_LIMITS, type FirmwareLimits } from './types.js';
export function throwIfAborted(signal?:AbortSignal):void { if(signal?.aborted)throw signal.reason instanceof Error?signal.reason:new DOMException('The operation was aborted','AbortError'); }
export function bounded(value:unknown,fallback:number,max:number):number { return typeof value==='number'&&Number.isSafeInteger(value)&&value>0?Math.min(value,max):fallback; }
export function firmwareLimits(options:Record<string,unknown>):FirmwareLimits {
  return {
    chunkBytes:65_536,maxImageBytes:bounded(options.firmwareMaxImageBytes,DEFAULT_LIMITS.maxImageBytes,8_589_934_592),
    maxStrings:bounded(options.firmwareMaxStrings,DEFAULT_LIMITS.maxStrings,100_000),maxStringBytes:bounded(options.firmwareMaxStringBytes,DEFAULT_LIMITS.maxStringBytes,65_536),
    maxStringTotalBytes:bounded(options.firmwareMaxStringTotalBytes,DEFAULT_LIMITS.maxStringTotalBytes,64_000_000),
    maxHexRecords:bounded(options.firmwareMaxHexRecords,DEFAULT_LIMITS.maxHexRecords,4_000_000),maxHexBytes:bounded(options.firmwareMaxHexBytes,DEFAULT_LIMITS.maxHexBytes,1_000_000_000),
    maxUf2Blocks:bounded(options.firmwareMaxUf2Blocks,DEFAULT_LIMITS.maxUf2Blocks,4_000_000),maxElfSections:bounded(options.firmwareMaxElfSections,DEFAULT_LIMITS.maxElfSections,65_536),
    maxElfProgramHeaders:bounded(options.firmwareMaxElfProgramHeaders,DEFAULT_LIMITS.maxElfProgramHeaders,65_536),maxElfBytes:DEFAULT_LIMITS.maxElfBytes,
    maxArchiveEntries:bounded(options.firmwareMaxArchiveEntries,DEFAULT_LIMITS.maxArchiveEntries,100_000),maxArchiveTotalBytes:bounded(options.firmwareMaxArchiveTotalBytes,DEFAULT_LIMITS.maxArchiveTotalBytes,1_000_000_000),
    maxArchiveRatio:bounded(options.firmwareMaxArchiveRatio,DEFAULT_LIMITS.maxArchiveRatio,1_000),maxSignatureScanBytes:bounded(options.firmwareMaxSignatureScanBytes,DEFAULT_LIMITS.maxSignatureScanBytes,64_000_000),
  };
}

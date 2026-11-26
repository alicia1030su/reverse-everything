export interface CompatServer { close(): Promise<void>; url: string }
export function startPixelknightServer(options?: { port?: number; wsPort?: number; dataDir?: string; reset?: boolean }): Promise<CompatServer>;
export function startTronServer(options?: { port?: number; dataDir?: string; reset?: boolean }): Promise<CompatServer>;

import type { AdapterDefinition } from '@reverse/workflow';
import { fileAdapter } from './adapters/file.js';
import { websiteAdapter } from './adapters/website.js';
import { securityAdapter } from './adapters/security.js';
import { gameAdapter } from './adapters/game.js';
export const adapters:AdapterDefinition[]=[websiteAdapter,fileAdapter,securityAdapter,gameAdapter];
export { inferProtocol } from './adapters/game.js';
export { fileAdapter, websiteAdapter, securityAdapter, gameAdapter };

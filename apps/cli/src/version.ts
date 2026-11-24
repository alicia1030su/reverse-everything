import { readFile } from 'node:fs/promises';

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version?: unknown };
if (typeof packageJson.version !== 'string' || !packageJson.version) throw new Error('CLI package version is missing');
export const VERSION = packageJson.version;

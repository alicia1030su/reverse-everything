import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetGeneratedDirectory } from './reset-generated-dir.mjs';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'web');
await resetGeneratedDirectory(path.join(webRoot, 'dist'), webRoot, 'dist');

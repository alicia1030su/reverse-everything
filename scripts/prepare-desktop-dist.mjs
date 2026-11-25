import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetGeneratedDirectory } from './reset-generated-dir.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await resetGeneratedDirectory(path.join(root, 'dist', 'desktop'), path.join(root, 'dist'), 'desktop');

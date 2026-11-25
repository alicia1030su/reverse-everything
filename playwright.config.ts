import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defineConfig } from '@playwright/test';
const windowsChrome='C:/Program Files/Google/Chrome/Application/chrome.exe';
export default defineConfig({testDir:'./tests/e2e',outputDir:path.join(tmpdir(),`reverse-everything-web-e2e-${randomUUID()}`),timeout:120000,fullyParallel:false,workers:1,use:{baseURL:'http://127.0.0.1:4173',headless:true,launchOptions:{...(existsSync(windowsChrome)?{executablePath:windowsChrome}:{})},screenshot:'only-on-failure',trace:'retain-on-failure'},webServer:[{command:'node --input-type=module -e "import {resetGeneratedDirectory} from \'./scripts/reset-generated-dir.mjs\';await resetGeneratedDirectory(\'data/e2e\',\'data\',\'e2e\')" && node scripts/start.mjs',url:'http://127.0.0.1:4173/api/health',reuseExistingServer:false,timeout:30000,env:{RE_PORT:'4173',RE_DATA_DIR:'data/e2e',RE_WORKER_MAX_RSS_MB:'2048'}},{command:'node examples/demo-website/server.mjs',url:'http://127.0.0.1:3199/',reuseExistingServer:false,timeout:15000,env:{PORT:'3199'}}]});

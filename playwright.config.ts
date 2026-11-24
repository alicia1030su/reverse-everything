import { existsSync } from 'node:fs';
import { defineConfig } from '@playwright/test';
const windowsChrome='C:/Program Files/Google/Chrome/Application/chrome.exe';
export default defineConfig({testDir:'./tests/e2e',timeout:60000,fullyParallel:false,workers:1,use:{baseURL:'http://127.0.0.1:4173',headless:true,launchOptions:{...(existsSync(windowsChrome)?{executablePath:windowsChrome}:{})},screenshot:'only-on-failure',trace:'retain-on-failure'},webServer:[{command:'node scripts/start.mjs',url:'http://127.0.0.1:4173/api/health',reuseExistingServer:false,timeout:30000,env:{RE_PORT:'4173',RE_DATA_DIR:'data/e2e',RE_WORKER_MAX_RSS_MB:'2048'}},{command:'node examples/demo-website/server.mjs',url:'http://127.0.0.1:3199/',reuseExistingServer:false,timeout:15000,env:{PORT:'3199'}}]});

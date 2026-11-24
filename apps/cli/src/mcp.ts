#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createMcpServer } from './tools.js';
await serveStdio(()=>createMcpServer(true));

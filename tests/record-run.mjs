#!/usr/bin/env node
/**
 * 记录一次真实的 opencode_run 结果（供 tests/smoke-result.md 引用）。
 * 用法：node tests/record-run.mjs [model]
 * 输出：JSON 打到 stdout，同时写 .smoke/last-run.json。
 */

import path from 'node:path';
import fs from 'node:fs';
import { startClient, projectDir } from './lib/mcp-client.mjs';

const smokeCwd = path.join(projectDir, '.smoke');
fs.mkdirSync(smokeCwd, { recursive: true });

const model = process.argv[2] || process.env.SMOKE_MODEL || 'opencode-go/beam-free';
const token = `BRIDGE_SMOKE_${Date.now().toString(36).toUpperCase()}`;

const client = startClient();
await client.request('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'record-run', version: '1.0.0' },
});
client.notify('notifications/initialized', {});

const { payload } = await client.callTool(
  'opencode_run',
  {
    prompt: `Reply with exactly: ${token}`,
    cwd: smokeCwd,
    model,
    timeoutMs: 240000,
    maxOutputChars: 2000,
  },
  300000,
);

const out = { token, model, payload };
fs.writeFileSync(path.join(smokeCwd, 'last-run.json'), JSON.stringify(out, null, 2), 'utf8');
console.log(JSON.stringify(out, null, 2));
await client.stop();
process.exit(payload?.ok ? 0 : 1);

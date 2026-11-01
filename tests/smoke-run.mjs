#!/usr/bin/env node
/**
 * 真实冒烟：通过 MCP 调 opencode_run 跑一次真实任务，并验证 session_show 与 async 任务。
 * 默认模型 opencode-go/beam-free（可用 SMOKE_MODEL 覆盖）。
 *
 * 用法：node tests/smoke-run.mjs
 * 退出码：0 全绿，1 有失败。
 */

import path from 'node:path';
import fs from 'node:fs';
import { startClient, projectDir, makeCheck } from './lib/mcp-client.mjs';

const harness = makeCheck();
const { check } = harness;

const smokeCwd = path.join(projectDir, '.smoke');
fs.mkdirSync(smokeCwd, { recursive: true });

const model = process.env.SMOKE_MODEL || 'opencode-go/beam-free';
const token = `BRIDGE_SMOKE_${Date.now().toString(36).toUpperCase()}`;

async function main() {
  const client = startClient();
  try {
    const init = await client.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'smoke-run', version: '1.0.0' },
    });
    check('initialize 成功', init.result?.serverInfo?.name === 'opencode-bridge', init.result?.protocolVersion);
    client.notify('notifications/initialized', {});

    // 1) 同步真实调用
    const startedAt = Date.now();
    const { response, payload } = await client.callTool(
      'opencode_run',
      {
        prompt: `Reply with exactly: ${token}`,
        cwd: smokeCwd,
        model,
        timeoutMs: 240000,
        maxOutputChars: 4000,
      },
      300000,
    );
    const wallMs = Date.now() - startedAt;
    check('opencode_run: 没有协议层错误', !response.error, response.error);
    check('opencode_run: isError 为空', !response.result?.isError, response.result?.isError);
    check('opencode_run: ok=true', payload?.ok === true, payload?.errors);
    check('opencode_run: exitCode=0', payload?.exitCode === 0, payload?.exitCode);
    check('opencode_run: 返回文本命中固定串', String(payload?.text || '').includes(token), payload?.text);
    check('opencode_run: 返回真实 sessionId', /^ses_[A-Za-z0-9]+$/.test(String(payload?.sessionId || '')), payload?.sessionId);
    check('opencode_run: 返回 token 用量结构', Boolean(payload?.usage) && typeof payload.usage.input === 'number', payload?.usage);
    check('opencode_run: 用时合理（>0ms）', wallMs > 0, `${wallMs}ms`);

    const sessionId = payload?.sessionId;

    // 2) 会话详情
    if (sessionId) {
      const show = await client.callTool('opencode_session_show', { sessionId, cwd: smokeCwd, maxMessages: 5 });
      const showPayload = show.payload;
      check('opencode_session_show: ok=true', showPayload?.ok === true, showPayload?.error);
      check('opencode_session_show: 有消息', (showPayload?.messageCount || 0) > 0, showPayload?.messageCount);
      check('opencode_session_show: 返回模型信息', Boolean(showPayload?.session?.model?.id), showPayload?.session?.model);
      check(
        'opencode_session_show: 会话 token 统计可用',
        (showPayload?.session?.tokens?.input || 0) > 0,
        showPayload?.session?.tokens,
      );
    }

    // 3) async 任务
    const asyncRun = await client.callTool('opencode_run', {
      prompt: `Reply with exactly: ${token}_ASYNC`,
      cwd: smokeCwd,
      model,
      timeoutMs: 240000,
      async: true,
    });
    const taskId = asyncRun.payload?.taskId;
    check('opencode_run(async): 返回 taskId', typeof taskId === 'string' && taskId.startsWith('task_'), taskId);
    if (taskId) {
      const status = await client.callTool('opencode_task_status', { taskId, waitMs: 60000 });
      const statusPayload = status.payload;
      check(
        'opencode_task_status: 任务完成',
        ['done', 'failed', 'timeout', 'cancelled'].includes(statusPayload?.status),
        statusPayload?.status,
      );
      check('opencode_task_status: done 且文本命中', statusPayload?.status === 'done' && String(statusPayload?.result?.text || '').includes(token), {
        status: statusPayload?.status,
        text: statusPayload?.result?.text,
      });
      const list = await client.callTool('opencode_task_list', { limit: 5 });
      check('opencode_task_list: 能列出任务', (list.payload?.tasks || []).some((task) => task.taskId === taskId), list.payload?.total);
    }

    // 4) 真实失败路径：不可用模型必须结构化返回，不吞异常
    const badModel = await client.callTool('opencode_run', {
      prompt: 'noop',
      cwd: smokeCwd,
      model: 'nonexistent/nope',
      timeoutMs: 60000,
    });
    check('失败路径: 不可用模型 ok=false', badModel.payload?.ok === false, badModel.payload?.ok);
    check(
      '失败路径: 不可用模型带回 opencode 错误类型',
      String(badModel.payload?.errors?.[0]?.type || '').includes('provider.'),
      badModel.payload?.errors,
    );
    check('失败路径: 不可用模型 exitCode 非 0', badModel.payload?.exitCode !== 0, badModel.payload?.exitCode);
  } catch (error) {
    check('未捕获异常', false, String(error?.stack || error));
  } finally {
    const stderr = client.getStderr();
    if (stderr.trim()) console.log(`\n[server stderr]\n${stderr.trim().slice(-2000)}`);
    await client.stop();
  }

  const failures = harness.failures;
  console.log(`\n${failures === 0 ? 'SMOKE PASS' : 'SMOKE FAILED'} — ${failures} 项失败，token=${token}，model=${model}`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();

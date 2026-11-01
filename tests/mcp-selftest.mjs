#!/usr/bin/env node
/**
 * MCP 自测：自己 spawn server.mjs，走完整握手
 *   initialize → notifications/initialized → tools/list → tools/call opencode_health
 * 另外覆盖失败路径（缺参数、cwd 越界、cwd 不存在、未知工具）与 models / session_list。
 *
 * 用法：node tests/mcp-selftest.mjs
 * 退出码：0 全绿，1 有失败。
 */

import { startClient, projectDir, makeCheck } from './lib/mcp-client.mjs';

const harness = makeCheck();
const { check } = harness;

async function main() {
  const client = startClient();
  try {
    // 1. initialize
    const init = await client.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'mcp-selftest', version: '1.0.0' },
    });
    check('initialize: 返回 serverInfo.name=opencode-bridge', init.result?.serverInfo?.name === 'opencode-bridge', init.result?.serverInfo);
    check(
      'initialize: 协议版本是受支持值',
      ['2025-06-18', '2025-03-26', '2024-11-05'].includes(init.result?.protocolVersion),
      init.result?.protocolVersion,
    );
    check('initialize: 声明 tools 能力', Boolean(init.result?.capabilities?.tools), init.result?.capabilities);
    client.notify('notifications/initialized', {});

    // 2. tools/list
    const list = await client.request('tools/list', {});
    const tools = list.result?.tools || [];
    const names = tools.map((tool) => tool.name);
    const expected = [
      'opencode_health',
      'opencode_models',
      'opencode_run',
      'opencode_session_list',
      'opencode_session_show',
    ];
    check('tools/list: 5 个必需工具齐全', expected.every((name) => names.includes(name)), names);
    check(
      'tools/list: 每个工具都有 object 类型 inputSchema',
      tools.length > 0 && tools.every((tool) => tool.inputSchema?.type === 'object'),
      tools.length,
    );
    const runSchema = tools.find((tool) => tool.name === 'opencode_run')?.inputSchema;
    check('tools/list: opencode_run.prompt 必填', Array.isArray(runSchema?.required) && runSchema.required.includes('prompt'), runSchema?.required);

    // 3. tools/call opencode_health
    const { response: healthResp, payload: health } = await client.callTool('opencode_health', {});
    check('opencode_health: isError 为空', !healthResp.result?.isError, healthResp.result?.isError);
    check('opencode_health: ok=true', health?.ok === true, health?.ok);
    check(
      'opencode_health: binary.path 指向真实 opencode.exe（非 shim）',
      typeof health?.binary?.path === 'string' &&
        /opencode\.exe$/i.test(health.binary.path) &&
        !/agent-purge/i.test(health.binary.path),
      health?.binary,
    );
    check(
      'opencode_health: 版本号形如 opencode v2.x',
      /opencode\s*v?\d+\.\d+\.\d+/i.test(String(health?.binary?.version || '')),
      health?.binary?.version,
    );
    check('opencode_health: 报告 shim 检测结果', typeof health?.shim?.detected === 'boolean', health?.shim?.detected);
    check('opencode_health: models 可用且数量>0', health?.models?.ok === true && health.models.count > 0, health?.models);
    check('opencode_health: 默认不加 --auto', health?.policy?.autoDefault === false, health?.policy?.autoDefault);
    check(
      'opencode_health: 白名单含 Desktop 与 OpenBot',
      Array.isArray(health?.policy?.allowedCwdRoots) &&
        health.policy.allowedCwdRoots.some((p) => /Desktop$/i.test(p)) &&
        health.policy.allowedCwdRoots.some((p) => /OpenBot$/i.test(p)),
      health?.policy?.allowedCwdRoots,
    );
    check('opencode_health: 输出里没有 sk- 形态的 key', !/sk-[A-Za-z0-9_-]{16,}/.test(JSON.stringify(health)), 'none');

    // 4. 失败路径：缺 prompt
    const missingPrompt = await client.callTool('opencode_run', {});
    check('失败路径: 缺 prompt 返回 isError', missingPrompt.response.result?.isError === true, missingPrompt.response.result?.isError);
    check('失败路径: 缺 prompt 的 code=INVALID_ARGUMENT', missingPrompt.payload?.error?.code === 'INVALID_ARGUMENT', missingPrompt.payload?.error);

    // 5. 失败路径：cwd 越界
    const outside = await client.callTool('opencode_run', { prompt: 'noop', cwd: 'C:\\Windows' });
    check('失败路径: cwd 越界 isError', outside.response.result?.isError === true, outside.response.result?.isError);
    check('失败路径: cwd 越界 code=CWD_NOT_ALLOWED', outside.payload?.error?.code === 'CWD_NOT_ALLOWED', outside.payload?.error?.code);

    // 6. 失败路径：cwd 不存在
    const ghost = await client.callTool('opencode_run', {
      prompt: 'noop',
      cwd: `${projectDir}\\no-such-dir-for-selftest`,
    });
    check('失败路径: cwd 不存在 code=CWD_NOT_FOUND', ghost.payload?.error?.code === 'CWD_NOT_FOUND', ghost.payload?.error?.code);

    // 7. models
    const models = await client.callTool('opencode_models', { limit: 5 });
    check(
      'opencode_models: ok 且返回 5 条以内',
      models.payload?.ok === true && models.payload.models.length > 0 && models.payload.models.length <= 5,
      { total: models.payload?.total, returned: models.payload?.returned },
    );
    check(
      'opencode_models: 每条形如 provider/model',
      (models.payload?.models || []).every((id) => /^[^/]+\/[^/]+$/.test(id)),
      models.payload?.models,
    );

    // 8. session_list（不依赖已有会话，只要结构正确）
    const sessions = await client.callTool('opencode_session_list', { cwd: projectDir, maxCount: 3 });
    check('opencode_session_list: ok 且返回数组', sessions.payload?.ok === true && Array.isArray(sessions.payload.sessions), {
      count: sessions.payload?.count,
    });

    // 9. 未知工具
    const unknown = await client.callTool('nope_tool', {});
    check('失败路径: 未知工具 code=UNKNOWN_TOOL', unknown.payload?.error?.code === 'UNKNOWN_TOOL', unknown.payload?.error?.code);
  } catch (error) {
    check('未捕获异常', false, String(error?.stack || error));
  } finally {
    const stderr = client.getStderr();
    if (stderr.trim()) console.log(`\n[server stderr]\n${stderr.trim().slice(-2000)}`);
    await client.stop();
  }

  const failures = harness.failures;
  const total = harness.results.length;
  console.log(`\n${failures === 0 ? 'ALL PASS' : 'FAILED'} — ${total - failures}/${total} 项通过`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();

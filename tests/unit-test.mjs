#!/usr/bin/env node
/**
 * 纯函数单测：脱敏、cwd 白名单、JSONL 解析、结果汇总（含非 JSON / 超时 / 非零退出路径）。
 * 直接 import ../server.mjs —— import 不会启动 server。
 *
 * 用法：node tests/unit-test.mjs
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  execOpencode,
  parseJsonLines,
  parseModelList,
  redact,
  resolveCwd,
  resolveOpencodeBinary,
  summarizeRun,
  truncateMiddle,
} from '../server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(here, '..');

let failures = 0;
function check(name, condition, detail) {
  const ok = Boolean(condition);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
}

// --- 脱敏 ---------------------------------------------------------------
check('redact: sk- key 被打码', redact('key sk-abcdefghijklmnop1234 end') === 'key sk-[REDACTED] end');
check(
  'redact: apiKey JSON 值被打码',
  !/super-secret-value/.test(redact('{"apiKey":"super-secret-value","model":"x"}')),
  redact('{"apiKey":"super-secret-value","model":"x"}'),
);
check('redact: password 字段被打码', !/hunter2hunter2/.test(redact('password: hunter2hunter2')), redact('password: hunter2hunter2'));
check('redact: Bearer token 被打码', !/abcdefghijklmnop/.test(redact('Authorization: Bearer abcdefghijklmnop')), redact('Authorization: Bearer abcdefghijklmnop'));
check('redact: tokens 统计不被误伤', /"tokens"?: 37/.test(redact('"tokens": 37')), redact('"tokens": 37'));
check('redact: 普通文本不变', redact('hello world') === 'hello world');

// --- 截断 ---------------------------------------------------------------
const long = 'x'.repeat(500);
const truncated = truncateMiddle(long, 100);
check('truncateMiddle: 超长被截断并留标记', truncated.length < 500 && truncated.includes('输出已截断'), truncated.length);
check('truncateMiddle: 不超长时原样返回', truncateMiddle('short', 100) === 'short');

// --- JSONL 解析 ---------------------------------------------------------
const parsed = parseJsonLines(
  [
    '{"type":"step_start","sessionID":"ses_abc"}',
    '',
    'not json at all',
    '{"type":"text","part":{"text":"hi"}}',
    '{broken',
  ].join('\n'),
);
check('parseJsonLines: 解析出 2 个事件', parsed.events.length === 2, parsed.events.length);
check('parseJsonLines: 非法行计数=2', parsed.unparsed === 2, parsed.unparsed);
check('parseJsonLines: 空行计数=1', parsed.blanks === 1, parsed.blanks);

// --- 模型列表 -----------------------------------------------------------
const models = parseModelList('openai/gpt-5.5\n\nopencode-go/beam-free\n# comment\nnot-a-model\nopenai/gpt-5.5\n');
check('parseModelList: 去空行/注释/非法行并去重', models.length === 2, models.map((m) => m.id));
check('parseModelList: provider 拆分正确', models[0].provider === 'openai' && models[0].model === 'gpt-5.5', models[0]);

// --- cwd 白名单 ---------------------------------------------------------
check('resolveCwd: 默认目录被接受', resolveCwd(projectDir).cwd.toLowerCase().startsWith(projectDir.toLowerCase()), resolveCwd(projectDir).cwd);
let outsideCode = null;
try {
  resolveCwd('C:\\Windows');
} catch (error) {
  outsideCode = error.code;
}
check('resolveCwd: C:\\Windows 被拒绝', outsideCode === 'CWD_NOT_ALLOWED', outsideCode);

let traversalCode = null;
try {
  resolveCwd(path.join(projectDir, '..', '..', '..', '..', 'Windows', 'System32'));
} catch (error) {
  traversalCode = error.code;
}
check('resolveCwd: .. 逃逸到 C:\\Windows\\System32 被拒绝', traversalCode === 'CWD_NOT_ALLOWED', traversalCode);

let missingCode = null;
try {
  resolveCwd(path.join(projectDir, 'no-such-dir'));
} catch (error) {
  missingCode = error.code;
}
check('resolveCwd: 不存在的目录被拒绝', missingCode === 'CWD_NOT_FOUND', missingCode);

check('resolveCwd: 空 cwd 回落到白名单目录', Boolean(resolveCwd(undefined).cwd), resolveCwd(undefined).cwd);

// --- 二进制解析 ---------------------------------------------------------
const binary = resolveOpencodeBinary();
check('resolveOpencodeBinary: 找到真实 exe', binary.ok && /opencode\.exe$/i.test(binary.path), binary.path);
check('resolveOpencodeBinary: 不是 agent-purge shim', !/agent-purge/i.test(binary.path || ''), binary.path);

// --- summarizeRun 失败路径 ---------------------------------------------
function summarize(exec, meta = {}) {
  return summarizeRun(exec, {
    cwd: projectDir,
    model: 'test/model',
    agent: null,
    auto: false,
    timeoutMs: 1000,
    maxOutputChars: 2000,
    ...meta,
  });
}

const okRun = summarize({
  exitCode: 0,
  signal: null,
  stdout: [
    '{"type":"step_start","sessionID":"ses_test1"}',
    '{"type":"text","sessionID":"ses_test1","part":{"id":"p1","text":"HELLO"}}',
    '{"type":"step_finish","part":{"tokens":{"input":10,"output":2},"cost":0.001}}',
  ].join('\n'),
  stderr: '',
  durationMs: 5,
  timedOut: false,
  stdoutTruncated: false,
});
check('summarizeRun: 成功时 ok=true 且有 sessionId', okRun.ok && okRun.sessionId === 'ses_test1', { ok: okRun.ok, sessionId: okRun.sessionId });
check('summarizeRun: 文本聚合正确', okRun.text === 'HELLO', okRun.text);
check('summarizeRun: token 用量聚合正确', okRun.usage.input === 10 && okRun.usage.output === 2, okRun.usage);

const nonZero = summarize(
  { exitCode: 2, signal: null, stdout: '', stderr: 'boom', durationMs: 5, timedOut: false, stdoutTruncated: false },
);
check('summarizeRun: 非零退出 ok=false 且报 nonzero_exit', !nonZero.ok && nonZero.errors.some((e) => e.type === 'nonzero_exit'), nonZero.errors);

const nonJson = summarize(
  { exitCode: 0, signal: null, stdout: 'banner line\nmore banner', stderr: '', durationMs: 5, timedOut: false, stdoutTruncated: false },
);
check('summarizeRun: 非 JSON 输出报 non_json_output', !nonJson.ok && nonJson.errors.some((e) => e.type === 'non_json_output'), nonJson.errors);

const timedOut = summarize(
  { exitCode: null, signal: null, stdout: '', stderr: '', durationMs: 1000, timedOut: true, stdoutTruncated: false },
);
check('summarizeRun: 超时 ok=false 且报 timeout', !timedOut.ok && timedOut.errors.some((e) => e.type === 'timeout'), timedOut.errors);

const errEvent = summarize({
  exitCode: 1,
  signal: null,
  stdout: '{"type":"error","sessionID":"ses_e","error":{"type":"provider.no-route","message":"Model unavailable"}}',
  stderr: '',
  durationMs: 5,
  timedOut: false,
  stdoutTruncated: false,
});
check(
  'summarizeRun: 解析 opencode error 事件',
  !errEvent.ok && errEvent.errors[0]?.type === 'provider.no-route' && errEvent.errors[0]?.message === 'Model unavailable',
  errEvent.errors,
);

const truncatedRun = summarize({
  exitCode: 0,
  signal: null,
  stdout: `{"type":"text","part":{"id":"p1","text":"${'a'.repeat(5000)}"}}`,
  stderr: '',
  durationMs: 5,
  timedOut: false,
  stdoutTruncated: false,
});
check('summarizeRun: 长文本按 maxOutputChars 截断', truncatedRun.text.length <= 2100 && truncatedRun.textTruncated, {
  len: truncatedRun.text.length,
  truncated: truncatedRun.textTruncated,
});
check('summarizeRun: stderr 尾部被脱敏', !/sk-[A-Za-z0-9]{20,}/.test(summarize({
  exitCode: 1,
  signal: null,
  stdout: '',
  stderr: 'sk-abcdefghijklmnopqrstuvwx',
  durationMs: 5,
  timedOut: false,
  stdoutTruncated: false,
}).stderrTail), 'none');

// --- 真实超时：execOpencode 必须杀掉子进程（用 node 长进程替代 opencode）------
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const childPid = { value: null };
const timeoutExec = await execOpencode(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
  cwd: projectDir,
  timeoutMs: 1500,
  onSpawn: (child) => {
    childPid.value = child.pid;
  },
});
check('execOpencode: 超时被标记 timedOut=true', timeoutExec.timedOut === true, {
  timedOut: timeoutExec.timedOut,
  durationMs: timeoutExec.durationMs,
});
check('execOpencode: 超时时长接近阈值（<10s）', timeoutExec.durationMs < 10000, `${timeoutExec.durationMs}ms`);

let exitedPid = false;
for (let i = 0; i < 40; i += 1) {
  if (!childPid.value || !isAlive(childPid.value)) {
    exitedPid = true;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
}
check('execOpencode: 超时后进程树被杀掉', exitedPid && Boolean(childPid.value), { pid: childPid.value, alive: childPid.value ? isAlive(childPid.value) : null });

console.log(`\n${failures === 0 ? 'ALL PASS' : 'FAILED'} — ${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);

#!/usr/bin/env node
/**
 * opencode-bridge — 本地 stdio MCP server
 *
 * 把本机 opencode CLI 的 agent 能力（run / models / session）暴露成 MCP 工具，
 * 供 OpenBot 的任意 agent 直接调用。
 *
 * 设计要点：
 * - 零依赖，手写 MCP JSON-RPC 2.0（换行分隔），不依赖 npm install。
 * - 只用参数数组 spawn，绝不拼 shell 字符串；不经过 PATH 上的 agent-purge shim。
 * - cwd 白名单 + realpath 校验，拒绝 .. 逃逸。
 * - 默认不加 --auto；超时杀进程树；输出截断且脱敏。
 * - 不读取、不打印、不落盘任何 apiKey / password。
 *
 * stdout 只用于 MCP 协议帧；所有日志走 stderr。
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// 常量与配置
// ---------------------------------------------------------------------------

const SERVER_NAME = 'opencode-bridge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const DEBUG = /^(1|true|yes)$/i.test(process.env.OPENCODE_BRIDGE_LOG || '');

const DEFAULT_TIMEOUT_MS = clampInt(
  process.env.OPENCODE_BRIDGE_DEFAULT_TIMEOUT_MS,
  300000,
  5000,
  1800000,
);
const MAX_TIMEOUT_MS = 1800000;
const MAX_OUTPUT_CHARS = clampInt(process.env.OPENCODE_BRIDGE_MAX_OUTPUT_CHARS, 60000, 1000, 200000);
const MAX_STDOUT_BYTES = 16 * 1024 * 1024;
const STDERR_TAIL_CHARS = 20000;
const STDERR_RETURN_CHARS = 4000;
const MAX_TOOL_CALLS = 60;

const INSTRUCTIONS = [
  'opencode-bridge 把本机 opencode CLI 的编程 agent 暴露成工具。',
  '先调 opencode_health 确认二进制/模型可用，再调 opencode_run 让 opencode 在指定目录里写码或改文件。',
  'opencode_run 默认不加 --auto（权限由 opencode 自己判定）；长任务传 async=true，再用 opencode_task_status 查询。',
  'cwd 必须在白名单内（默认 Desktop 与 OpenBot），否则返回 CWD_NOT_ALLOWED。',
].join('\n');

// ---------------------------------------------------------------------------
// 日志（只走 stderr）
// ---------------------------------------------------------------------------

function log(level, message, extra) {
  if (!DEBUG) return;
  try {
    const line = { ts: new Date().toISOString(), level, component: SERVER_NAME, message };
    if (extra !== undefined) line.extra = extra;
    process.stderr.write(`${JSON.stringify(line)}\n`);
  } catch {
    /* stderr 关闭时忽略 */
  }
}

function clampInt(raw, fallback, min, max) {
  const n = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// ---------------------------------------------------------------------------
// 脱敏与截断
// ---------------------------------------------------------------------------

const SECRET_PATTERNS = [
  // OpenAI 风格 sk- key
  [/sk-[A-Za-z0-9_-]{16,}/g, 'sk-[REDACTED]'],
  // Bearer token
  [/(\bBearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1[REDACTED]'],
  // key=value / key: "value" 形式的敏感字段
  [
    /((?:"|')?\b(?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|secret|authorization)(?:"|')?\s*[:=]\s*)(?:"[^"]{6,}"|'[^']{6,}'|[A-Za-z0-9._~+/=-]{6,})/gi,
    '$1"[REDACTED]"',
  ],
  // URL 里的 key/token 查询参数
  [/([?&](?:api[_-]?key|key|token|access_token)=)[^&\s"]{6,}/gi, '$1[REDACTED]'],
  // Cookie / Set-Cookie 头
  [/(\bset-cookie\s*:\s*)[^\r\n]+/gi, '$1[REDACTED]'],
];

function redact(value) {
  if (typeof value !== 'string' || value.length === 0) return value;
  let out = value;
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

function tailOf(text, maxChars) {
  if (typeof text !== 'string') return '';
  return text.length <= maxChars ? text : text.slice(text.length - maxChars);
}

function truncateMiddle(text, maxChars) {
  if (typeof text !== 'string') return '';
  if (text.length <= maxChars) return text;
  const keep = Math.max(1, Math.floor(maxChars / 2));
  const removed = text.length - keep * 2;
  return `${text.slice(0, keep)}\n…[输出已截断 ${removed} 字符]…\n${text.slice(text.length - keep)}`;
}

// ---------------------------------------------------------------------------
// 工具级错误
// ---------------------------------------------------------------------------

class ToolError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
    this.details = details;
  }
}

function requireString(args, key, { required = true, maxLength = 200000 } = {}) {
  const value = args[key];
  if (value === undefined || value === null || value === '') {
    if (!required) return undefined;
    throw new ToolError('INVALID_ARGUMENT', `缺少必填参数 ${key}`);
  }
  if (typeof value !== 'string') throw new ToolError('INVALID_ARGUMENT', `参数 ${key} 必须是字符串`);
  if (value.length > maxLength) throw new ToolError('INVALID_ARGUMENT', `参数 ${key} 超过 ${maxLength} 字符`);
  return value;
}

function requireBoolean(args, key, fallback) {
  const value = args[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') throw new ToolError('INVALID_ARGUMENT', `参数 ${key} 必须是布尔值`);
  return value;
}

function requireInt(args, key, fallback, min, max) {
  const value = args[key];
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value)) throw new ToolError('INVALID_ARGUMENT', `参数 ${key} 必须是整数`);
  if (value < min || value > max) throw new ToolError('INVALID_ARGUMENT', `参数 ${key} 必须在 ${min}..${max} 之间`);
  return value;
}

function optionalString(args, key, maxLength = 4096) {
  const value = requireString(args, key, { required: false, maxLength });
  return value === undefined ? undefined : value;
}

// ---------------------------------------------------------------------------
// cwd 白名单
// ---------------------------------------------------------------------------

function defaultCwdRoots() {
  const home = os.homedir();
  return [path.join(home, 'Desktop'), path.join(home, 'OpenBot')];
}

function configuredCwdRoots() {
  const separator = process.platform === 'win32' ? ';' : path.delimiter;
  const extra = String(process.env.OPENCODE_BRIDGE_ALLOWED_CWDS || '')
    .split(separator)
    .map((item) => item.trim())
    .filter(Boolean);
  const all = [...defaultCwdRoots(), ...extra];
  const seen = new Set();
  const roots = [];
  for (const item of all) {
    const resolved = path.resolve(item);
    const key = normalizeForCompare(resolved);
    if (seen.has(key)) continue;
    seen.add(key);
    roots.push(resolved);
  }
  return roots;
}

function normalizeForCompare(p) {
  const normalized = path.normalize(p);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isInside(candidate, root) {
  const a = normalizeForCompare(candidate);
  const b = normalizeForCompare(root);
  if (a === b) return true;
  const withSep = b.endsWith(path.sep) ? b : b + path.sep;
  return a.startsWith(withSep);
}

function realpathSafe(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
}

/**
 * 解析并校验 cwd。
 * 返回 { cwd, source, roots }；失败抛 ToolError。
 */
function resolveCwd(input, fallbackToRoot = true) {
  const roots = configuredCwdRoots();

  let candidate;
  let source;
  if (input && String(input).trim()) {
    candidate = String(input).trim();
    source = 'argument';
  } else {
    const processCwd = realpathSafe(process.cwd()) || path.resolve(process.cwd());
    const processCwdAllowed = roots.some((root) => {
      const realRoot = realpathSafe(root) || root;
      return isInside(processCwd, realRoot);
    });
    if (processCwdAllowed) {
      candidate = processCwd;
      source = 'process.cwd';
    } else if (fallbackToRoot) {
      candidate = roots.find((root) => fs.existsSync(root)) || roots[0];
      source = 'default';
    } else {
      throw new ToolError('CWD_NOT_ALLOWED', '当前进程目录不在白名单内，请显式传 cwd', { allowedRoots: roots });
    }
  }

  if (candidate.includes('\0')) throw new ToolError('INVALID_CWD', 'cwd 含非法字符');

  const absolute = path.resolve(candidate);
  const real = realpathSafe(absolute);
  if (!real) {
    throw new ToolError('CWD_NOT_FOUND', `cwd 不存在：${absolute}`, { allowedRoots: roots });
  }
  let stat;
  try {
    stat = fs.statSync(real);
  } catch {
    throw new ToolError('CWD_NOT_FOUND', `无法读取 cwd：${absolute}`, { allowedRoots: roots });
  }
  if (!stat.isDirectory()) throw new ToolError('CWD_NOT_DIRECTORY', `cwd 不是目录：${absolute}`);

  const allowed = roots.some((root) => {
    const realRoot = realpathSafe(root) || root;
    return isInside(real, realRoot);
  });
  if (!allowed) {
    throw new ToolError('CWD_NOT_ALLOWED', `cwd 不在白名单内：${real}`, {
      allowedRoots: roots,
      hint: '通过环境变量 OPENCODE_BRIDGE_ALLOWED_CWDS 追加允许目录（分号分隔）',
    });
  }

  return { cwd: real, source, roots };
}

// ---------------------------------------------------------------------------
// opencode 二进制解析（规避 agent-purge shim）
// ---------------------------------------------------------------------------

function isShimPath(p) {
  return /[\\/]\.agent-purge[\\/]/i.test(p) || /agent-purge/i.test(p);
}

function isForbiddenExtension(p) {
  return /\.(cmd|bat|ps1|vbs)$/i.test(p);
}

function pathEntries() {
  return String(process.env.PATH || process.env.Path || '')
    .split(path.delimiter)
    .map((item) => item.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
}

function scanPathForOpencode() {
  const found = [];
  for (const dir of pathEntries()) {
    for (const name of ['opencode.exe', 'opencode.cmd', 'opencode.bat', 'opencode.ps1', 'opencode']) {
      const full = path.join(dir, name);
      if (fs.existsSync(full)) found.push(full);
    }
  }
  return [...new Set(found)];
}

function candidateBinaries() {
  const candidates = [];
  if (process.env.OPENCODE_BIN) {
    candidates.push({ path: process.env.OPENCODE_BIN, source: 'env:OPENCODE_BIN' });
  }
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  candidates.push({
    path: path.join(appData, 'npm', 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe'),
    source: 'npm-global:@opencode/cli',
  });
  candidates.push({
    path: path.join(appData, 'npm', 'node_modules', '@opencode', 'cli', 'bin', 'opencode'),
    source: 'npm-global:@opencode/cli(bin)',
  });
  for (const shim of scanPathForOpencode()) {
    candidates.push({ path: shim, source: 'PATH' });
  }
  return candidates;
}

function resolveOpencodeBinary() {
  const rejected = [];
  for (const candidate of candidateBinaries()) {
    const p = candidate.path;
    if (!p) continue;
    if (isShimPath(p)) {
      rejected.push({ path: p, source: candidate.source, reason: 'agent-purge shim，会污染 stdout' });
      continue;
    }
    if (isForbiddenExtension(p)) {
      rejected.push({ path: p, source: candidate.source, reason: '批处理/脚本包装器不能直接 spawn' });
      continue;
    }
    if (!fs.existsSync(p)) continue;
    return { ok: true, path: path.resolve(p), source: candidate.source, rejected };
  }
  return { ok: false, path: null, source: null, rejected };
}

function detectShim() {
  const onPath = scanPathForOpencode().map((p) => ({
    path: p,
    kind: isShimPath(p) ? 'agent-purge-shim' : 'other',
  }));
  const shim = onPath.find((entry) => entry.kind === 'agent-purge-shim');
  return {
    detected: Boolean(shim),
    shimPath: shim ? shim.path : null,
    onPath,
    note: shim
      ? 'PATH 上的 opencode 是 agent-purge 的包装器（先打印中文 banner）。本 server 显式使用真实 exe，桥接不受影响；但请在 shell 里也避免走它。'
      : 'PATH 上没有检测到 agent-purge 包装器。',
  };
}

function requireBinary() {
  const resolved = resolveOpencodeBinary();
  if (!resolved.ok) {
    throw new ToolError('OPENCODE_BINARY_NOT_FOUND', '找不到可用的 opencode 可执行文件', {
      tried: candidateBinaries().map((c) => c.path),
      rejected: resolved.rejected,
      hint: '用 OPENCODE_BIN 环境变量指定真实 exe（不能是 .cmd/.bat，也不能是 .agent-purge 下的 shim）',
    });
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// 子进程执行
// ---------------------------------------------------------------------------

function childEnv() {
  const env = { ...process.env };
  env.NO_COLOR = '1';
  env.FORCE_COLOR = '0';
  env.OPENCODE_NO_UPDATE_CHECK = env.OPENCODE_NO_UPDATE_CHECK || '1';
  return env;
}

function killTree(child, state) {
  if (!child || !child.pid) return;
  if (state.killed) return;
  state.killed = true;
  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.on('error', () => {});
    } catch {
      /* ignore */
    }
  } else {
    try {
      child.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  }
  setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }, 3000).unref?.();
}

/**
 * 执行 opencode 子进程。
 * @returns {Promise<{exitCode:number|null, signal:string|null, stdout:string, stderr:string,
 *   durationMs:number, timedOut:boolean, stdoutTruncated:boolean, spawnError?:Error}>}
 */
function execOpencode(binPath, args, options = {}) {
  const {
    cwd,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    onSpawn,
    onStdoutChunk,
  } = options;

  return new Promise((resolve) => {
    const startedAt = Date.now();
    const state = { killed: false };
    let child;
    try {
      child = spawn(binPath, args, {
        cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: childEnv(),
      });
    } catch (error) {
      resolve({
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: '',
        durationMs: Date.now() - startedAt,
        timedOut: false,
        stdoutTruncated: false,
        spawnError: error,
      });
      return;
    }

    if (typeof onSpawn === 'function') {
      try {
        onSpawn(child);
      } catch {
        /* ignore */
      }
    }

    let stdout = '';
    let stdoutBytes = 0;
    let stdoutTruncated = false;
    let stderr = '';
    let timedOut = false;
    let settled = false;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      const size = Buffer.byteLength(chunk, 'utf8');
      stdoutBytes += size;
      if (stdout.length < MAX_STDOUT_BYTES) {
        stdout += chunk;
      } else {
        stdoutTruncated = true;
      }
      if (typeof onStdoutChunk === 'function') {
        try {
          onStdoutChunk(size);
        } catch {
          /* ignore */
        }
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.length > STDERR_TAIL_CHARS * 2) stderr = stderr.slice(-STDERR_TAIL_CHARS);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      log('warn', 'opencode 超时，杀进程树', { pid: child.pid, timeoutMs });
      killTree(child, state);
    }, timeoutMs);
    timer.unref?.();

    const finish = (extra) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: null,
        signal: null,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        timedOut,
        stdoutTruncated,
        stdoutBytes,
        ...extra,
      });
    };

    child.on('error', (error) => finish({ spawnError: error }));
    child.on('close', (code, signal) => finish({ exitCode: code, signal }));
  });
}

// ---------------------------------------------------------------------------
// opencode run 事件解析
// ---------------------------------------------------------------------------

function parseJsonLines(stdout) {
  const events = [];
  let unparsed = 0;
  let blanks = 0;
  for (const rawLine of String(stdout || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      blanks += 1;
      continue;
    }
    if (!line.startsWith('{') && !line.startsWith('[')) {
      unparsed += 1;
      continue;
    }
    try {
      events.push(JSON.parse(line));
    } catch {
      unparsed += 1;
    }
  }
  return { events, unparsed, blanks };
}

function previewValue(value, maxChars = 400) {
  if (value === undefined || value === null) return null;
  let text;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  return truncateMiddle(redact(text), maxChars);
}

function summarizeRun(exec, meta) {
  const { events, unparsed } = parseJsonLines(exec.stdout);
  const sessionId = events.find((event) => event && typeof event.sessionID === 'string')?.sessionID || null;
  const textParts = new Map();
  const toolCalls = [];
  const errors = [];
  const usage = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
  let cost = 0;

  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    const type = event.type;
    const part = event.part || {};

    if (type === 'error') {
      const err = event.error || {};
      errors.push({
        type: typeof err.type === 'string' ? err.type : 'unknown',
        message: redact(String(err.message || '')),
        status: err.status ?? null,
      });
      continue;
    }

    if (type === 'text' && typeof part.text === 'string') {
      const key = part.id || part.messageID || crypto.randomUUID();
      textParts.set(key, part.text);
      continue;
    }

    if (type === 'tool_use' || (type === 'tool' && part.tool)) {
      if (toolCalls.length < MAX_TOOL_CALLS) {
        toolCalls.push({
          tool: part.tool || part.name || null,
          status: part.state?.status || null,
          input: previewValue(part.state?.input, 300),
          output: previewValue(part.state?.output, 400),
        });
      }
      continue;
    }

    if (type === 'step_finish') {
      const tokens = part.tokens || {};
      usage.input += Number(tokens.input || 0);
      usage.output += Number(tokens.output || 0);
      usage.reasoning += Number(tokens.reasoning || 0);
      usage.cacheRead += Number(tokens.cache?.read || 0);
      usage.cacheWrite += Number(tokens.cache?.write || 0);
      cost += Number(part.cost || 0);
    }
  }

  const text = [...textParts.values()].join('\n').trim();
  const maxChars = meta.maxOutputChars;

  if (exec.spawnError) {
    errors.push({ type: 'spawn_failed', message: redact(String(exec.spawnError.message || exec.spawnError)) });
  }
  if (exec.timedOut) {
    errors.push({
      type: 'timeout',
      message: `opencode 在 ${meta.timeoutMs} ms 内未结束，已杀掉进程树。长任务请用 async=true + opencode_task_status。`,
    });
  }
  if (exec.exitCode !== 0 && !exec.timedOut && errors.length === 0) {
    errors.push({
      type: 'nonzero_exit',
      message: `opencode 退出码 ${exec.exitCode}${exec.signal ? `（signal ${exec.signal}）` : ''}`,
    });
  }
  if (unparsed > 0 && text.length === 0 && errors.length === 0) {
    errors.push({
      type: 'non_json_output',
      message: 'opencode 的 stdout 不是 JSON 行，无法解析事件；见 stderrTail',
    });
  }
  if (exec.stdoutTruncated) {
    errors.push({
      type: 'stdout_truncated',
      message: `stdout 超过 ${MAX_STDOUT_BYTES} 字节，后半段未被解析`,
    });
  }

  const ok = !exec.timedOut && exec.exitCode === 0 && errors.length === 0;
  const textTruncated = text.length > maxChars;
  const usageTotal = usage.input + usage.output + usage.reasoning;
  const usageNote =
    usageTotal === 0 && text.length > 0
      ? '本次运行没有 step_finish 事件（opencode 简单回复时可能不发），所以 token 用量为 0；权威用量见 opencode_session_show 的 tokens。'
      : null;

  return {
    ok,
    sessionId,
    exitCode: exec.exitCode,
    signal: exec.signal || null,
    durationMs: exec.durationMs,
    cwd: meta.cwd,
    model: meta.model || null,
    agent: meta.agent || null,
    auto: Boolean(meta.auto),
    text: truncateMiddle(redact(text), maxChars),
    textChars: text.length,
    textTruncated,
    toolCalls,
    usage,
    usageNote,
    cost,
    errors,
    unparsedStdoutLines: unparsed,
    stderrTail: truncateMiddle(redact(tailOf(exec.stderr, STDERR_TAIL_CHARS)), STDERR_RETURN_CHARS),
  };
}

// ---------------------------------------------------------------------------
// 工具实现
// ---------------------------------------------------------------------------

async function toolHealth(args) {
  const binary = resolveOpencodeBinary();
  const shim = detectShim();
  const checkModels = requireBoolean(args, 'checkModels', true);
  const allowRoots = configuredCwdRoots();

  const result = {
    ok: false,
    server: { name: SERVER_NAME, version: SERVER_VERSION, node: process.version, protocol: SUPPORTED_PROTOCOLS[0] },
    binary: {
      path: binary.path,
      source: binary.source,
      version: null,
      versionOk: false,
    },
    shim,
    models: { checked: checkModels, ok: false, count: 0, providers: 0, durationMs: 0 },
    policy: {
      allowedCwdRoots: allowRoots,
      defaultCwd: allowRoots.find((root) => fs.existsSync(root)) || null,
      defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
      maxOutputChars: MAX_OUTPUT_CHARS,
      autoDefault: false,
      shellUsed: false,
      readsOpencodeConfig: false,
      redactsSecrets: true,
    },
    warnings: [],
  };

  if (binary.rejected.length > 0) {
    result.warnings.push(...binary.rejected.map((entry) => `已跳过 ${entry.path}：${entry.reason}`));
  }

  if (!binary.ok) {
    result.errors = [
      {
        code: 'OPENCODE_BINARY_NOT_FOUND',
        message: '找不到可用的 opencode 可执行文件',
        tried: candidateBinaries().map((c) => c.path),
      },
    ];
    return result;
  }

  const version = await execOpencode(binary.path, ['--version'], { cwd: undefined, timeoutMs: 20000 });
  const versionText = redact(String(version.stdout || '').trim());
  result.binary.version = versionText || null;
  result.binary.versionOk = version.exitCode === 0 && /opencode\s*v?\d+\.\d+\.\d+/i.test(versionText);
  if (!result.binary.versionOk) {
    result.errors = result.errors || [];
    result.errors.push({
      code: 'OPENCODE_VERSION_FAILED',
      message: 'opencode --version 没有返回预期版本号',
      exitCode: version.exitCode,
      stdout: truncateMiddle(versionText, 400),
      stderrTail: truncateMiddle(redact(tailOf(version.stderr, 4000)), 800),
    });
  }
  if (versionText.includes('\n')) {
    result.warnings.push('--version 输出包含多行（可能走了包装器），请确认 binary.path 是真实 exe。');
  }

  if (checkModels) {
    const startedAt = Date.now();
    const models = await execOpencode(binary.path, ['models'], { cwd: undefined, timeoutMs: 60000 });
    const list = parseModelList(models.stdout);
    result.models = {
      checked: true,
      ok: models.exitCode === 0 && list.length > 0,
      count: list.length,
      providers: new Set(list.map((entry) => entry.provider)).size,
      sample: list.slice(0, 10).map((entry) => entry.id),
      durationMs: Date.now() - startedAt,
    };
    if (!result.models.ok) {
      result.errors = result.errors || [];
      result.errors.push({
        code: 'OPENCODE_MODELS_FAILED',
        message: 'opencode models 没有返回可用模型列表',
        exitCode: models.exitCode,
        stderrTail: truncateMiddle(redact(tailOf(models.stderr, 4000)), 800),
      });
    }
  }

  result.ok = Boolean(result.binary.versionOk) && !result.errors;
  return result;
}

function parseModelList(stdout) {
  const models = [];
  const seen = new Set();
  for (const rawLine of String(stdout || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._@#:+-]+$/.test(line)) continue;
    if (seen.has(line)) continue;
    seen.add(line);
    const slash = line.indexOf('/');
    models.push({ id: line, provider: line.slice(0, slash), model: line.slice(slash + 1) });
  }
  return models;
}

async function toolModels(args) {
  const query = optionalString(args, 'query', 200);
  const provider = optionalString(args, 'provider', 100);
  const limit = requireInt(args, 'limit', 200, 1, 2000);

  const binary = requireBinary();
  const exec = await execOpencode(binary.path, ['models'], { cwd: undefined, timeoutMs: 60000 });
  if (exec.timedOut) throw new ToolError('MODELS_TIMEOUT', 'opencode models 超时');
  if (exec.exitCode !== 0) {
    throw new ToolError('MODELS_FAILED', `opencode models 失败（exit ${exec.exitCode}）`, {
      stderrTail: truncateMiddle(redact(tailOf(exec.stderr, 4000)), 800),
    });
  }

  const all = parseModelList(exec.stdout);
  if (all.length === 0) {
    throw new ToolError('MODELS_EMPTY', 'opencode models 没有输出可解析的模型', {
      stdoutHead: truncateMiddle(redact(exec.stdout), 400),
    });
  }

  const filtered = all.filter((entry) => {
    if (provider && entry.provider.toLowerCase() !== provider.toLowerCase()) return false;
    if (query && !entry.id.toLowerCase().includes(query.toLowerCase())) return false;
    return true;
  });

  const byProvider = {};
  for (const entry of filtered) byProvider[entry.provider] = (byProvider[entry.provider] || 0) + 1;

  return {
    ok: true,
    total: all.length,
    matched: filtered.length,
    returned: Math.min(filtered.length, limit),
    providers: byProvider,
    models: filtered.slice(0, limit).map((entry) => entry.id),
    truncated: filtered.length > limit,
    usage: {
      modelArgument: 'opencode_run 的 model 参数：<provider>/<model>，变体写成 <provider>/<model>#<variant>',
      example: filtered[0]?.id || all[0].id,
      binary: binary.path,
      durationMs: exec.durationMs,
    },
  };
}

function buildRunArguments(args) {
  const prompt = requireString(args, 'prompt', { maxLength: 200000 });
  const model = optionalString(args, 'model', 200);
  const agent = optionalString(args, 'agent', 100);
  const session = optionalString(args, 'session', 200);
  const title = optionalString(args, 'title', 200);
  const auto = requireBoolean(args, 'auto', false);
  const continueSession = requireBoolean(args, 'continue', false);
  const fork = requireBoolean(args, 'fork', false);
  const timeoutMs = requireInt(args, 'timeoutMs', DEFAULT_TIMEOUT_MS, 5000, MAX_TIMEOUT_MS);
  const maxOutputChars = requireInt(args, 'maxOutputChars', MAX_OUTPUT_CHARS, 1000, 200000);

  if (continueSession && session) {
    throw new ToolError('INVALID_ARGUMENT', 'continue 与 session 不能同时使用：continue 续最近会话，session 指定会话');
  }
  if (fork && !(continueSession || session)) {
    throw new ToolError('INVALID_ARGUMENT', 'fork 需要配合 continue 或 session 使用');
  }

  const { cwd, source } = resolveCwd(args.cwd);

  const spawnArgs = ['run', '--format', 'json'];
  if (model) spawnArgs.push('-m', model);
  if (agent) spawnArgs.push('--agent', agent);
  if (session) spawnArgs.push('--session', session);
  if (continueSession) spawnArgs.push('--continue');
  if (fork) spawnArgs.push('--fork');
  if (auto) spawnArgs.push('--auto');
  if (title) spawnArgs.push('--title', title);
  spawnArgs.push('--', prompt);

  return {
    spawnArgs,
    meta: { cwd, cwdSource: source, model, agent, auto, timeoutMs, maxOutputChars },
  };
}

async function executeRun(prepared) {
  const binary = requireBinary();
  const exec = await execOpencode(binary.path, prepared.spawnArgs, {
    cwd: prepared.meta.cwd,
    timeoutMs: prepared.meta.timeoutMs,
  });
  return summarizeRun(exec, prepared.meta);
}

async function toolRun(args) {
  const prepared = buildRunArguments(args);
  const useAsync = requireBoolean(args, 'async', false);
  if (!useAsync) {
    const result = await executeRun(prepared);
    return { ...result, binary: resolveOpencodeBinary().path };
  }

  const binary = requireBinary();
  const task = createTask(prepared);
  task.promise = execOpencode(binary.path, prepared.spawnArgs, {
    cwd: prepared.meta.cwd,
    timeoutMs: prepared.meta.timeoutMs,
    onSpawn: (child) => {
      task.child = child;
    },
    onStdoutChunk: (size) => {
      task.stdoutBytes += size;
      task.lastActivityAt = Date.now();
    },
  })
    .then((exec) => {
      task.result = summarizeRun(exec, prepared.meta);
      task.status = task.cancelled ? 'cancelled' : task.result.ok ? 'done' : exec.timedOut ? 'timeout' : 'failed';
    })
    .catch((error) => {
      task.result = {
        ok: false,
        errors: [{ type: 'task_failed', message: redact(String(error?.message || error)) }],
      };
      task.status = 'failed';
    })
    .finally(() => {
      task.finishedAt = Date.now();
      task.child = null;
    });

  return taskSnapshot(task, { includeResult: false });
}

// ---------------------------------------------------------------------------
// 异步任务
// ---------------------------------------------------------------------------

const tasks = new Map();
const MAX_TASKS = 20;

function pruneTasks() {
  const finished = [...tasks.values()]
    .filter((task) => task.status !== 'running')
    .sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0));
  for (const task of finished.slice(MAX_TASKS)) tasks.delete(task.id);
}

function createTask(prepared) {
  pruneTasks();
  const task = {
    id: `task_${crypto.randomBytes(6).toString('hex')}`,
    status: 'running',
    startedAt: Date.now(),
    finishedAt: null,
    lastActivityAt: Date.now(),
    stdoutBytes: 0,
    cancelled: false,
    child: null,
    promise: null,
    result: null,
    meta: prepared.meta,
  };
  tasks.set(task.id, task);
  return task;
}

function taskSnapshot(task, { includeResult = true } = {}) {
  const snapshot = {
    taskId: task.id,
    status: task.status,
    startedAt: new Date(task.startedAt).toISOString(),
    finishedAt: task.finishedAt ? new Date(task.finishedAt).toISOString() : null,
    durationMs: (task.finishedAt || Date.now()) - task.startedAt,
    lastActivityAt: new Date(task.lastActivityAt).toISOString(),
    stdoutBytes: task.stdoutBytes,
    cwd: task.meta.cwd,
    model: task.meta.model || null,
    agent: task.meta.agent || null,
    timeoutMs: task.meta.timeoutMs,
  };
  if (task.status === 'running') {
    snapshot.sessionId = null;
    snapshot.next = `用 opencode_task_status({ taskId: "${task.id}" }) 查询进度；status 变为 done/failed/timeout 后 stop。`;
    return snapshot;
  }
  if (includeResult && task.result) snapshot.result = task.result;
  return snapshot;
}

function requireTask(args) {
  const taskId = requireString(args, 'taskId', { maxLength: 100 });
  const task = tasks.get(taskId);
  if (!task) {
    throw new ToolError('TASK_NOT_FOUND', `没有这个任务：${taskId}`, {
      knownTasks: [...tasks.keys()].slice(-10),
      hint: '任务表在 server 进程内存里，server 重启后清空',
    });
  }
  return task;
}

async function toolTaskStatus(args) {
  const task = requireTask(args);
  const waitMs = requireInt(args, 'waitMs', 0, 0, 60000);
  if (waitMs > 0 && task.status === 'running') {
    const deadline = Date.now() + waitMs;
    while (task.status === 'running' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  return taskSnapshot(task);
}

async function toolTaskList(args) {
  const limit = requireInt(args, 'limit', 10, 1, MAX_TASKS);
  return {
    ok: true,
    total: tasks.size,
    tasks: [...tasks.values()]
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, limit)
      .map((task) => taskSnapshot(task, { includeResult: false })),
  };
}

function toolTaskCancel(args) {
  const task = requireTask(args);
  if (task.status !== 'running') {
    return { ok: true, taskId: task.id, status: task.status, note: '任务已结束，无需取消' };
  }
  task.cancelled = true;
  if (task.child) killTree(task.child, { killed: false });
  return { ok: true, taskId: task.id, status: 'cancelling', note: '已发送 kill；稍后用 opencode_task_status 确认最终状态' };
}

// ---------------------------------------------------------------------------
// 会话工具
// ---------------------------------------------------------------------------

async function toolSessionList(args) {
  const maxCount = requireInt(args, 'maxCount', 20, 1, 200);
  const { cwd, source } = resolveCwd(args.cwd);
  const binary = requireBinary();
  const exec = await execOpencode(
    binary.path,
    ['session', 'list', '--format', 'json', '-n', String(maxCount)],
    { cwd, timeoutMs: 60000 },
  );
  if (exec.timedOut) throw new ToolError('SESSION_LIST_TIMEOUT', 'opencode session list 超时');
  if (exec.exitCode !== 0) {
    throw new ToolError('SESSION_LIST_FAILED', `opencode session list 失败（exit ${exec.exitCode}）`, {
      stderrTail: truncateMiddle(redact(tailOf(exec.stderr, 4000)), 800),
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(exec.stdout.trim() || '[]');
  } catch {
    throw new ToolError('SESSION_LIST_NOT_JSON', 'opencode session list 的输出不是 JSON', {
      stdoutHead: truncateMiddle(redact(exec.stdout), 400),
    });
  }
  if (!Array.isArray(parsed)) {
    throw new ToolError('SESSION_LIST_UNEXPECTED', 'opencode session list 返回的不是数组', {
      type: typeof parsed,
    });
  }

  return {
    ok: true,
    cwd,
    cwdSource: source,
    count: parsed.length,
    sessions: parsed.map((entry) => ({
      id: entry.id,
      title: entry.title ? redact(String(entry.title)) : null,
      directory: entry.directory || null,
      created: entry.created ? new Date(entry.created).toISOString() : null,
      updated: entry.updated ? new Date(entry.updated).toISOString() : null,
    })),
  };
}

async function toolSessionShow(args) {
  const sessionId = requireString(args, 'sessionId', { maxLength: 100 });
  if (!/^ses_[A-Za-z0-9]+$/.test(sessionId)) {
    throw new ToolError('INVALID_ARGUMENT', 'sessionId 形如 ses_xxx');
  }
  const sanitize = requireBoolean(args, 'sanitize', false);
  const maxMessages = requireInt(args, 'maxMessages', 20, 1, 200);
  const maxCharsPerMessage = requireInt(args, 'maxCharsPerMessage', 4000, 200, 20000);
  const { cwd, source } = resolveCwd(args.cwd);

  const binary = requireBinary();
  const spawnArgs = ['session', 'export', sessionId];
  if (sanitize) spawnArgs.push('--sanitize');

  const exec = await execOpencode(binary.path, spawnArgs, { cwd, timeoutMs: 60000 });
  if (exec.timedOut) throw new ToolError('SESSION_EXPORT_TIMEOUT', 'opencode session export 超时');
  if (exec.exitCode !== 0) {
    throw new ToolError('SESSION_EXPORT_FAILED', `opencode session export 失败（exit ${exec.exitCode}）`, {
      stderrTail: truncateMiddle(redact(tailOf(exec.stderr, 4000)), 800),
    });
  }

  let bundle;
  try {
    bundle = JSON.parse(exec.stdout.trim());
  } catch {
    throw new ToolError('SESSION_EXPORT_NOT_JSON', '导出内容不是 JSON', {
      stdoutHead: truncateMiddle(redact(exec.stdout), 400),
    });
  }

  const info = bundle.info || {};
  const messages = Array.isArray(bundle.messages) ? bundle.messages : [];
  const summary = messages.slice(-maxMessages).map((message) => {
    const base = {
      id: message.id,
      type: message.type,
      at: message.time?.created ? new Date(message.time.created).toISOString() : null,
      text: '',
      tools: [],
    };
    if (typeof message.text === 'string' && message.text) {
      base.text = truncateMiddle(redact(message.text), maxCharsPerMessage);
    } else if (Array.isArray(message.content)) {
      const textParts = [];
      for (const part of message.content) {
        if (!part || typeof part !== 'object') continue;
        if (typeof part.text === 'string' && (part.type === 'text' || part.type === 'reasoning')) {
          textParts.push(part.text);
        }
        if (part.type === 'tool') {
          base.tools.push({ name: part.name || null, status: part.state?.status || null });
        }
      }
      if (textParts.length > 0) base.text = truncateMiddle(redact(textParts.join('\n')), maxCharsPerMessage);
    }
    return base;
  });

  return {
    ok: true,
    cwd,
    cwdSource: source,
    sanitize,
    session: {
      id: info.id || sessionId,
      title: info.title ? redact(String(info.title)) : null,
      directory: info.location?.directory || null,
      model: info.model || null,
      outcome: info.outcome || null,
      cost: info.cost ?? null,
      tokens: info.tokens || null,
      created: info.time?.created ? new Date(info.time.created).toISOString() : null,
      updated: info.time?.updated ? new Date(info.time.updated).toISOString() : null,
    },
    messageCount: messages.length,
    returned: summary.length,
    truncated: messages.length > summary.length,
    messages: summary,
  };
}

// ---------------------------------------------------------------------------
// 工具清单（MCP tools/list）
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'opencode_health',
    description:
      '检查本机 opencode CLI 是否可用：真实二进制路径、版本、是否踩到 agent-purge shim、模型列表是否可用、cwd 白名单与超时策略。不读取任何密钥。',
    inputSchema: {
      type: 'object',
      properties: {
        checkModels: {
          type: 'boolean',
          description: '是否顺带跑一次 opencode models（默认 true，约 1-3 秒）。',
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'opencode_models',
    description:
      '列出 opencode 可用模型（provider/model），支持按 provider 或关键字过滤。opencode_run 的 model 参数用这里返回的 id。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '按模型 id 子串过滤，例如 "glm" 或 "luna"。' },
        provider: { type: 'string', description: '只保留某个 provider，例如 "openai"、"opencode-go"。' },
        limit: { type: 'integer', minimum: 1, maximum: 2000, description: '最多返回多少条，默认 200。' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'opencode_run',
    description:
      '让本机 opencode 的编程 agent 在指定目录执行任务（读/改文件、跑命令、写代码），返回文本结果、session id、工具调用与 token 用量。默认不加 --auto；长任务用 async=true 立即返回 taskId。',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          minLength: 1,
          maxLength: 200000,
          description: '交给 opencode 的完整任务描述：目标、目录、约束、验收标准。',
        },
        cwd: {
          type: 'string',
          description: '工作目录，必须在白名单内（默认 Desktop、OpenBot）。省略时用进程目录或 Desktop。',
        },
        model: { type: 'string', description: 'provider/model 或 provider/model#variant，见 opencode_models。' },
        agent: { type: 'string', description: 'opencode agent 名，例如 build、plan。' },
        session: { type: 'string', description: '指定 session id（不存在则创建）。' },
        continue: { type: 'boolean', description: '继续最近一次会话（--continue），与 session 互斥。' },
        fork: { type: 'boolean', description: '继续会话前先 fork（--fork）。' },
        auto: { type: 'boolean', description: '显式开启 --auto 自动批准权限，默认 false。' },
        title: { type: 'string', description: '会话标题。' },
        timeoutMs: {
          type: 'integer',
          minimum: 5000,
          maximum: 1800000,
          description: `超时毫秒，默认 ${DEFAULT_TIMEOUT_MS}，超时杀进程树。`,
        },
        async: { type: 'boolean', description: 'true 时立刻返回 taskId，用 opencode_task_status 查询结果。' },
        maxOutputChars: { type: 'integer', minimum: 1000, maximum: 200000, description: '返回文本的截断上限。' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: 'opencode_task_status',
    description: '查询 opencode_run(async=true) 的后台任务：status、耗时、结果、错误。可选 waitMs 等待最多 60 秒。',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', minLength: 1, description: 'opencode_run 返回的 taskId。' },
        waitMs: { type: 'integer', minimum: 0, maximum: 60000, description: '最长等待毫秒，默认 0（立即返回）。' },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'opencode_task_list',
    description: '列出当前 server 进程里最近的 opencode_run 后台任务。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 20, description: '最多返回多少条，默认 10。' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'opencode_task_cancel',
    description: '取消一个仍在运行的 opencode_run 后台任务（杀进程树）。',
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string', minLength: 1, description: '任务 id。' } },
      required: ['taskId'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
  {
    name: 'opencode_session_list',
    description: '列出某个目录（opencode project）下的会话，最新的在前。',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: '工作目录，必须在白名单内；省略用默认目录。' },
        maxCount: { type: 'integer', minimum: 1, maximum: 200, description: '最多返回多少条，默认 20。' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'opencode_session_show',
    description:
      '导出一个 opencode 会话的详情：标题、模型、token、成本与最近若干条消息（含工具调用）。sanitize=true 会让 opencode 自己的脱敏把文本全部打码。',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', minLength: 1, description: 'session id，形如 ses_xxx。' },
        cwd: { type: 'string', description: '工作目录，必须在白名单内。' },
        sanitize: { type: 'boolean', description: '使用 opencode 的 --sanitize（会把 transcript 全部打码），默认 false。' },
        maxMessages: { type: 'integer', minimum: 1, maximum: 200, description: '返回最近多少条消息，默认 20。' },
        maxCharsPerMessage: {
          type: 'integer',
          minimum: 200,
          maximum: 20000,
          description: '每条消息文本的截断上限，默认 4000。',
        },
      },
      required: ['sessionId'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
];

const TOOL_HANDLERS = {
  opencode_health: toolHealth,
  opencode_models: toolModels,
  opencode_run: toolRun,
  opencode_task_status: toolTaskStatus,
  opencode_task_list: toolTaskList,
  opencode_task_cancel: toolTaskCancel,
  opencode_session_list: toolSessionList,
  opencode_session_show: toolSessionShow,
};

function toolResult(payload) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  const result = {
    content: [{ type: 'text', text: redact(text) }],
  };
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    result.structuredContent = payload;
  }
  return result;
}

function toolErrorResult(error) {
  const payload = {
    ok: false,
    error: {
      code: error instanceof ToolError ? error.code : 'INTERNAL_ERROR',
      message: redact(String(error?.message || error)),
      ...(error instanceof ToolError && error.details ? { details: error.details } : {}),
    },
  };
  return {
    content: [{ type: 'text', text: redact(JSON.stringify(payload, null, 2)) }],
    structuredContent: payload,
    isError: true,
  };
}

async function callTool(params) {
  try {
    const name = params?.name;
    if (!name || typeof name !== 'string') {
      throw new ToolError('INVALID_ARGUMENT', 'tools/call 缺少 name');
    }
    const handler = TOOL_HANDLERS[name];
    if (!handler) throw new ToolError('UNKNOWN_TOOL', `没有这个工具：${name}`, { tools: Object.keys(TOOL_HANDLERS) });

    const args = params.arguments;
    if (args !== undefined && (args === null || typeof args !== 'object' || Array.isArray(args))) {
      throw new ToolError('INVALID_ARGUMENT', 'tools/call 的 arguments 必须是对象');
    }

    log('info', 'tool call', { name, argKeys: Object.keys(args || {}) });
    const payload = await handler(args || {});
    return toolResult(payload);
  } catch (error) {
    log('warn', 'tool error', {
      name: params?.name,
      code: error?.code || 'INTERNAL_ERROR',
      message: String(error?.message || error),
    });
    return toolErrorResult(error);
  }
}

// ---------------------------------------------------------------------------
// MCP JSON-RPC
// ---------------------------------------------------------------------------

function send(message) {
  if (!process.stdout.writable) return;
  try {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  } catch (error) {
    log('error', '写 stdout 失败', { message: String(error?.message || error) });
  }
}

function respond(id, result) {
  if (id === undefined || id === null) return;
  send({ jsonrpc: '2.0', id, result });
}

function respondError(id, code, message, data) {
  if (id === undefined || id === null) return;
  send({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } });
}

async function handleMessage(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    respondError(null, -32600, 'Invalid Request');
    return;
  }
  const { id, method, params } = message;
  const isNotification = !Object.prototype.hasOwnProperty.call(message, 'id');

  try {
    switch (method) {
      case 'initialize': {
        const requested = params?.protocolVersion;
        const protocolVersion = SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0];
        respond(id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, title: 'OpenCode Bridge', version: SERVER_VERSION },
          instructions: INSTRUCTIONS,
        });
        return;
      }
      case 'notifications/initialized':
      case 'initialized':
        return;
      case 'ping':
        respond(id, {});
        return;
      case 'tools/list':
        respond(id, { tools: TOOLS });
        return;
      case 'tools/call': {
        const result = await callTool(params || {});
        respond(id, result);
        return;
      }
      case 'resources/list':
        respond(id, { resources: [] });
        return;
      case 'resources/templates/list':
        respond(id, { resourceTemplates: [] });
        return;
      case 'prompts/list':
        respond(id, { prompts: [] });
        return;
      case 'logging/setLevel':
        respond(id, {});
        return;
      default:
        if (isNotification) return;
        respondError(id, -32601, `Method not found: ${method}`);
    }
  } catch (error) {
    log('error', '处理消息失败', { method, message: String(error?.message || error) });
    if (!isNotification) respondError(id, -32603, redact(String(error?.message || error)));
  }
}

function start() {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      respondError(null, -32700, 'Parse error');
      return;
    }
    void handleMessage(message);
  });

  rl.on('close', () => {
    log('info', 'stdin 关闭，server 退出');
    const running = [...tasks.values()].filter((task) => task.status === 'running');
    for (const task of running) {
      task.cancelled = true;
      if (task.child) killTree(task.child, { killed: false });
    }
    setTimeout(() => process.exit(0), 50).unref?.();
  });

  process.stdout.on('error', () => {});
  process.on('uncaughtException', (error) => {
    log('error', 'uncaughtException', { message: String(error?.stack || error) });
  });
  process.on('unhandledRejection', (error) => {
    log('error', 'unhandledRejection', { message: String(error?.stack || error) });
  });

  log('info', 'server started', { node: process.version, cwd: process.cwd() });
}

const isMainModule =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  start();
}

// 供 tests/*.mjs 直接测试纯函数（import 本文件不会启动 server）
export {
  SERVER_NAME,
  SERVER_VERSION,
  TOOLS,
  configuredCwdRoots,
  execOpencode,
  parseJsonLines,
  parseModelList,
  redact,
  resolveCwd,
  resolveOpencodeBinary,
  summarizeRun,
  truncateMiddle,
};

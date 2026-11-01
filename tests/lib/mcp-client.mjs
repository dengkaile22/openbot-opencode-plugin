/**
 * 极简 MCP stdio 客户端，供 tests/ 下脚本复用。
 * 只实现测试需要的部分：request / notify / 解析 text content。
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const serverPath = path.resolve(here, '..', '..', 'server.mjs');
export const projectDir = path.resolve(here, '..', '..');

export function startClient({ env = {} } = {}) {
  const child = spawn(process.execPath, [serverPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, ...env },
  });

  const pending = new Map();
  let nextId = 1;
  let stderr = '';
  let exited = false;

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      stderr += `\n[非 JSON stdout] ${trimmed.slice(0, 200)}`;
      return;
    }
    if (message.id !== undefined && pending.has(message.id)) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(entry.timer);
      entry.resolve(message);
    }
  });

  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
    if (stderr.length > 8000) stderr = stderr.slice(-8000);
  });

  child.on('exit', (code, signal) => {
    exited = true;
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`server 退出 code=${code} signal=${signal}`));
    }
    pending.clear();
  });

  function request(method, params, timeoutMs = 120000) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      if (exited) {
        reject(new Error('server 已退出'));
        return;
      }
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`请求超时：${method} (${timeoutMs}ms)`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  function notify(method, params) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async function callTool(name, args, timeoutMs) {
    const response = await request('tools/call', { name, arguments: args }, timeoutMs);
    return { response, payload: toolPayload(response) };
  }

  return {
    child,
    request,
    notify,
    callTool,
    getStderr: () => stderr,
    stop: () =>
      new Promise((resolve) => {
        if (exited) {
          resolve();
          return;
        }
        child.once('exit', resolve);
        child.stdin.end();
        setTimeout(() => {
          try {
            child.kill();
          } catch {
            /* ignore */
          }
          resolve();
        }, 3000).unref?.();
      }),
  };
}

export function toolPayload(response) {
  const content = response?.result?.content;
  if (!Array.isArray(content) || content.length === 0) return null;
  const text = content.find((item) => item.type === 'text')?.text;
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export function makeCheck() {
  const results = [];
  let failures = 0;
  function check(name, condition, detail) {
    const ok = Boolean(condition);
    if (!ok) failures += 1;
    results.push({ ok, name, detail });
    console.log(
      `${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`,
    );
    return ok;
  }
  return { check, results, get failures() { return failures; } };
}

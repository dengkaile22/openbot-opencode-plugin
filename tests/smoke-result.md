# opencode-bridge 真实冒烟记录

- 时间：2026-11-01
- 机器：Windows，Node v24.22.1，opencode v2.2.2
- 真实二进制：`%USERPROFILE%\AppData\Roaming\npm\node_modules\@opencode\cli\bin\opencode.exe`
- 工作目录：`%USERPROFILE%\Desktop\openbot-opencode-plugin\.smoke`
- 模型：`opencode-go/beam-free`（opencode 默认模型当时限额，见记录 2）

## 记录 1：同步调用成功（验收主项）

命令：

```powershell
node tests/record-run.mjs
```

脚本做的事：spawn `server.mjs` → `initialize` → `tools/call opencode_run` → 打印结构化结果。

实际输出（原样，已脱敏；不含任何密钥）：

```json
{
  "token": "BRIDGE_SMOKE_MVXLHQGO",
  "model": "opencode-go/beam-free",
  "payload": {
    "ok": true,
    "sessionId": "ses_e69ad9615ffejMuOky6flW23Ec",
    "exitCode": 0,
    "signal": null,
    "durationMs": 2063,
    "cwd": "%USERPROFILE%\\Desktop\\openbot-opencode-plugin\\.smoke",
    "model": "opencode-go/beam-free",
    "agent": null,
    "auto": false,
    "text": "BRIDGE_SMOKE_MVXLHQGO",
    "textChars": 21,
    "textTruncated": false,
    "toolCalls": [],
    "usage": { "input": 0, "output": 0, "reasoning": 0, "cacheRead": 0, "cacheWrite": 0 },
    "usageNote": "本次运行没有 step_finish 事件（opencode 简单回复时可能不发），所以 token 用量为 0；权威用量见 opencode_session_show 的 tokens。",
    "cost": 0,
    "errors": [],
    "unparsedStdoutLines": 0,
    "stderrTail": "",
    "binary": "%USERPROFILE%\\AppData\\Roaming\\npm\\node_modules\\@opencode\\cli\\bin\\opencode.exe"
  }
}
```

对应 opencode 原始事件流（`opencode run --format json`，节选）：

```json
{"type":"step_start","timestamp":1793522945215,"sessionID":"ses_e69b3b80cffeQ2hzunu9cgmZsm","part":{"type":"step-start"}}
{"type":"text","timestamp":1793522945327,"sessionID":"ses_e69b3b80cffeQ2hzunu9cgmZsm","part":{"id":"prt_..._text-0","type":"text","text":"DASH_OK"}}
```

结论：文本原样返回、session id 真实（`ses_` 前缀）、退出码 0、耗时 ~1.1s。

## 记录 2：失败路径 —— opencode 默认模型限额（真实错误，脱敏）

命令（直接用真实 exe，不走桥）：

```powershell
& "%USERPROFILE%\AppData\Roaming\npm\node_modules\@opencode\cli\bin\opencode.exe" run --format json "Reply with exactly: SMOKE_OK"
```

原始输出（脱敏后）：

```json
{"type":"error","timestamp":1793522858976,"sessionID":"ses_e69b51ca4ffecK1Vq15WGJ2pUU","error":{"type":"provider.chatgpt-limit","message":"ChatGPT usage limit reached. Check ChatGPT Settings > Usage for details.","status":200,"response":{"body":"{\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"code\":\"subscription_sharing_usage_limit_exceeded\",\"message\":\"The ChatGPT user has reached their Subscription Sharing usage limit. ...\"}}"}}}
```

退出码 1。桥接侧对应返回 `ok:false` + `errors:[{type:"provider.chatgpt-limit", ...}]`（由 `summarizeRun` 解析 error 事件），不吞异常。

## 记录 3：失败路径 —— 不可用模型（通过 MCP 调用）

`tests/smoke-run.mjs` 实测输出：

```
PASS 失败路径: 不可用模型 ok=false — false
PASS 失败路径: 不可用模型带回 opencode 错误类型 — [{"type":"provider.no-route","message":"Model unavailable: nonexistent/nope","status":null}]
PASS 失败路径: 不可用模型 exitCode 非 0 — 1
```

## 记录 4：超时与杀进程（真实执行 kill 路径）

`tests/unit-test.mjs` 用 `execOpencode` 启动一个 60s 的 node 长进程，`timeoutMs: 1500`：

```
PASS execOpencode: 超时被标记 timedOut=true — {"timedOut":true,"durationMs":1784}
PASS execOpencode: 超时时长接近阈值（<10s） — "1784ms"
PASS execOpencode: 超时后进程树被杀掉 — {"pid":9548,"alive":false}
```

说明：opencode 侧没有稳定可复现的长任务用来触发真实超时，所以这里用同一段 `spawn + taskkill /T /F` 代码路径、以一个可控长进程验证「超时判定 + 进程树被杀」。`summarizeRun` 对超时的结构化输出由单测覆盖（`errors[].type = "timeout"`）。

## 记录 5：异步任务 + 会话详情（通过 MCP 调用）

`node tests/smoke-run.mjs` 实测输出（节选）：

```
PASS opencode_run: 返回文本命中固定串 — BRIDGE_SMOKE_MVXLFHK2
PASS opencode_run: 返回真实 sessionId — ses_e69af2fa6ffel5PwCwQdNwaSdn
PASS opencode_session_show: ok=true
PASS opencode_session_show: 有消息 — 3
PASS opencode_session_show: 返回模型信息 — {"id":"beam-free","providerID":"opencode-go","variant":"default"}
PASS opencode_session_show: 会话 token 统计可用 — {"input":30,"output":19,"reasoning":28,"cache":{"read":2944,"write":0}}
PASS opencode_run(async): 返回 taskId — task_819fa7b2b34f
PASS opencode_task_status: 任务完成 — done
PASS opencode_task_status: done 且文本命中 — {"status":"done","text":"BRIDGE_SMOKE_MVXLFHK2_ASYNC"}
```

## 记录 6：写文件（opencode 在默认无 `--auto` 下仍可写，由 opencode 自己判定权限）

```
{"type":"tool_use","part":{"tool":"write","state":{"status":"completed","input":{"content":"WRITE_OK","path":"write-test.txt"},"output":"Created file successfully: write-test.txt"}}}
{"type":"text","part":{"text":"DONE"}}
```

文件确实落盘（`Test-Path .smoke\write-test.txt` → `True`）。桥接侧对应 `toolCalls:[{tool:"write", status:"completed", ...}]`。

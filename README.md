# opencode-bridge

OpenBot ⇄ opencode 的桥：把本机 **opencode CLI 的编程 agent** 包成一个零依赖的本地 **stdio MCP server**，让 OpenBot 里的任意 agent 直接调用它写码、改文件、跑测试。

```
OpenBot agent ──MCP(stdio)──> opencode-bridge ──spawn(argv)──> opencode.exe run --format json
```

- 交付物是「一个目录 + `plugin.json`」，与官方 catalog 条目同构；安装 = 把 `apps[].server` 注册进 OpenBot。
- 不用 npm 安装任何依赖：手写 MCP JSON-RPC 2.0（换行分隔），Node 20+ 直接跑。

## 1. 目录

| 文件 | 作用 |
| --- | --- |
| `plugin.json` | 插件清单（slug / prompts / apps[].server），字段与官方 catalog 一致 |
| `server.mjs` | MCP stdio server 本体（8 个工具） |
| `tests/mcp-selftest.mjs` | 自测：自行 spawn server，走 `initialize → tools/list → tools/call opencode_health`，并覆盖失败路径 |
| `tests/unit-test.mjs` | 纯函数单测：脱敏、cwd 白名单、JSONL 解析、非 JSON/超时/非零退出汇总 |
| `tests/smoke-run.mjs` | 真实调用冒烟：`opencode_run` 同步 + 异步任务 + `session_show` + 不可用模型失败路径 |
| `tests/record-run.mjs` | 记录单次真实调用结果（写 `.smoke/last-run.json`），供 `smoke-result.md` 引用 |
| `tests/smoke-result.md` | 一次真实调用的记录（命令、耗时、session id、输出） |
| `install.ps1` / `uninstall.ps1` | **只打印**注册/注销参数，不自己调用 OpenBot 接口 |

## 2. 工具

| 工具 | 作用 |
| --- | --- |
| `opencode_health` | 真实二进制路径与版本、是否踩到 agent-purge shim、`opencode models` 是否可用、cwd 白名单与超时策略。不读任何密钥 |
| `opencode_models` | 可用模型清单（`provider/model`），支持按 provider / 关键字过滤 |
| `opencode_run` | 让 opencode 在 `cwd` 里执行任务；返回 `{ ok, sessionId, exitCode, durationMs, text, toolCalls, usage, usageNote, errors, stderrTail }` |
| `opencode_task_status` | 查 `async: true` 的后台任务（可 `waitMs` 等最多 60s） |
| `opencode_task_list` / `opencode_task_cancel` | 列出 / 取消后台任务 |
| `opencode_session_list` | 某个目录（opencode project）下的会话，最新在前 |
| `opencode_session_show` | 导出会话详情：标题、模型、token、成本、最近 N 条消息与工具调用 |

### `opencode_run` 参数

| 参数 | 说明 |
| --- | --- |
| `prompt`（必填） | 交给 opencode 的完整任务描述 |
| `cwd` | 工作目录，必须在白名单内；省略时用进程目录（在白名单内时）或 `Desktop` |
| `model` | `provider/model`，变体写 `provider/model#variant`，取值见 `opencode_models` |
| `agent` | opencode agent 名，如 `build`、`plan` |
| `session` / `continue` / `fork` | 指定会话 / 续最近会话 / 续之前 fork |
| `auto` | **默认 false**；true 才加 `--auto`（自动批准权限） |
| `timeoutMs` | 默认 300000，上限 1800000，超时杀进程树 |
| `async` | true 立刻返回 `taskId`，长任务用 |
| `maxOutputChars` | 返回文本截断上限，默认 60000 |

## 3. 安装（由用户/管理者批准后执行）

先打印注册参数：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

它会输出可直接用于 `openbot.save_mcp_server` 的 JSON：

```json
{
  "name": "opencode-bridge",
  "transport": "stdio",
  "command": "node",
  "args": ["C:\\path\\to\\openbot-opencode-plugin\\server.mjs"]
}
```

`install.ps1` 会把 `args` 换成**你本机的真实 `server.mjs` 路径**（`plugin.json` 里写的是占位路径），克隆到任何目录都能直接用。

说明：`plugin.json` 里 `apps[].server` 用 `"command": "node"` + `"args": [...]`，与官方 catalog 的 stdio 条目（如 `obsidian`、`apple-apps`）以及 `openbot.save_mcp_server` 的入参（`command` 字符串 + `args` 数组）一致；`command` 写成数组的形式 OpenBot 不认。

如果 OpenBot 进程的 PATH 里没有 `node`（连接时报 command not found），把 `command` 换成绝对路径即可：

```json
{ "name": "opencode-bridge", "transport": "stdio", "command": "C:\\Program Files\\nodejs\\node.exe", "args": ["C:\\path\\to\\openbot-opencode-plugin\\server.mjs"] }
```

注册后建议再跑一次连通性检查（`openbot.test_mcp_server`，agent 侧），或本机：

```powershell
node tests/mcp-selftest.mjs
```

## 4. 卸载

```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
```

打印 `openbot.remove_mcp_server { "name": "opencode-bridge" }` 与本地清理步骤（`-PurgeSmoke` 才会删 `.smoke/` 测试目录）。

## 5. 配置（环境变量）

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `OPENCODE_BIN` | 自动探测 | 指定 opencode 真实 exe；`.cmd/.bat/.ps1` 与 `.agent-purge` 下的 shim 一律拒绝 |
| `OPENCODE_BRIDGE_ALLOWED_CWDS` | — | 追加 cwd 白名单，Windows 用 `;` 分隔（默认已有 `Desktop`、`OpenBot`） |
| `OPENCODE_BRIDGE_DEFAULT_TIMEOUT_MS` | 300000 | 默认超时 |
| `OPENCODE_BRIDGE_MAX_OUTPUT_CHARS` | 60000 | 默认返回文本上限 |
| `OPENCODE_BRIDGE_LOG` | 关 | `1` 时把调试日志打到 stderr（stderr 从不进 stdout） |

## 6. 排障

**stdout 被 banner 污染 / JSON 解析失败**
PATH 上的 `opencode` 可能是 agent-purge 的 shim（`%USERPROFILE%\.agent-purge\bin\opencode.cmd`，先打印中文 banner）。本 server 不解析 PATH，只用真实 exe：`opencode_health` 的 `binary.path` 应是 `...\@opencode\cli\bin\opencode.exe`。若 `shim.detected=true`，那只是提示，不影响桥接。

**`provider.chatgpt-limit` / `subscription_sharing_usage_limit_exceeded`**
opencode 的默认模型可能限额。用 `opencode_models` 挑一个可用模型显式传 `model`（本机实测 `opencode-go/beam-free` 可用）。这是 opencode 侧账号/限额问题，桥只如实回传 `errors`。

**超时**
单次默认 300s。长任务用 `async: true` + `opencode_task_status({ taskId, waitMs })`；`opencode_task_cancel` 会 `taskkill /T /F` 整棵进程树。任务表在 server 进程内存里，server 重启即清空。

**并发**
多个 `opencode_run` 共享同一个 opencode 后台服务，会在 opencode 侧排队；同一 `cwd` 上并发写文件有冲突风险。需要并行时用不同 `cwd`，或用 `async` 串行等待。

**Windows 相关**
- 只用 `spawn(exe, argv[])`，不走 shell；`prompt` 里带空格/引号/中文都安全。
- `cwd` 用 `realpath` 归一化后再判白名单，`..` 逃逸会落到白名单外被拒（`CWD_NOT_ALLOWED`），不存在的目录返回 `CWD_NOT_FOUND`。
- 中文输出在 PowerShell 里用 `[Console]::OutputEncoding = [Text.Encoding]::UTF8` 才不乱码。

**非 JSON 输出**
若 opencode 输出不是 JSON 行（升级改了格式、或走了包装器），`opencode_run` 返回 `errors[].type = "non_json_output"` 并附 `stderrTail`，不会静默当作成功。

## 7. 安全边界

- 不读取、不打印、不落盘任何 `apiKey` / `password`：不打开 `~/.config/opencode/*`。
- 所有返回文本（含 stdout、stderr 尾部、错误消息）过一遍脱敏：`sk-*`、`Bearer *`、`apiKey/password/token` 字段、URL 里的 key、`set-cookie`。
- `cwd` 白名单 + realpath 校验，拒绝白名单外目录。
- 默认不加 `--auto`；需要自动批准时由调用方显式传 `auto: true`。
- stdout 只写 MCP 协议帧；日志走 stderr。

## 8. 已知限制

1. `opencode session export --sanitize` 会把标题、目录、消息正文全部打码（不只是密钥），所以 `opencode_session_show` 默认 `sanitize: false`，靠本 server 自己的脱敏；需要 opencode 自己的打码时才传 `sanitize: true`。
2. `opencode session` 没有 `show` 子命令，`session_show` 用 `session export <id>` 实现；消息正文只取 `content[].text/reasoning` 与工具名，不含工具原始输入输出的完整内容。
3. `opencode_run` 的文本按 `part.id` 聚合，取每个 part 的最后一次文本（opencode `--format json` 目前每条 `text` 事件是该 part 的完整文本，不是增量）。
4. 后台任务只在 server 进程内存里，server 重启后丢失；任务不持久化、不通知。
5. 未实现 MCP resources / prompts（返回空列表）；未实现鉴权（本地 stdio，靠 OpenBot 自身权限）。
6. `opencode` 需已登录（opencode 自己的登录态），桥不做任何登录操作。
7. `opencode run --format json` 对简单回复可能不发 `step_finish` 事件，此时 `usage` 全为 0（结果里带 `usageNote` 说明）；权威 token 用量看 `opencode_session_show` 的 `session.tokens`。
8. `plugin.json` 的 `iconUrl` / `websiteUrl` / `privacyPolicyUrl` / `termsUrl` 指向 opencode 官网（`https://opencode.ai`，实测 200），仅为与官方 catalog 字段对齐，不是本项目自己的站点。

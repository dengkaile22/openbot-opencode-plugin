<#
.SYNOPSIS
  opencode-bridge 安装助手：只打印注册参数与自检结果，不调用任何 OpenBot 接口。

.DESCRIPTION
  本脚本不会注册 MCP server。注册由用户在 OpenBot 里批准后，由 agent 调用
  openbot.save_mcp_server 执行（参数见输出）。

.PARAMETER Verify
  额外跑一次 node tests/mcp-selftest.mjs（不联网、不启动 GUI）。

.PARAMETER Json
  只输出 JSON 参数（便于复制粘贴）。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install.ps1 -Verify
#>
[CmdletBinding()]
param(
  [switch]$Verify,
  [switch]$Json
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverPath = Join-Path $root 'server.mjs'
$pluginPath = Join-Path $root 'plugin.json'

if (-not (Test-Path $serverPath)) {
  throw "找不到 $serverPath"
}
if (-not (Test-Path $pluginPath)) {
  throw "找不到 $pluginPath"
}

# plugin.json 自检（字段齐全 + server 形状）
$plugin = Get-Content -Raw -Encoding UTF8 -Path $pluginPath | ConvertFrom-Json
$missing = @()
foreach ($field in @('slug', 'name', 'tagline', 'description', 'category', 'creatorName', 'version', 'prompts', 'apps', 'skills')) {
  if (-not $plugin.PSObject.Properties.Name.Contains($field)) { $missing += $field }
}
if ($missing.Count -gt 0) {
  throw "plugin.json 缺字段：$($missing -join ', ')"
}

$server = $plugin.apps[0].server
if (-not $server) { throw 'plugin.json 的 apps[0].server 为空' }
if ($server.transport -ne 'stdio') { throw "apps[0].server.transport 应为 stdio，实际 $($server.transport)" }
if (-not $server.name) { throw 'apps[0].server.name 为空' }
if (-not $server.command) { throw 'apps[0].server.command 为空' }
if (-not $server.args -or $server.args.Count -eq 0) { throw 'apps[0].server.args 为空' }

# node 解析
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  throw '找不到 node（需要 Node 20+），请先安装 Node.js'
}
$nodePath = $nodeCmd.Source
$nodeVersion = (& node --version).Trim()
$nodeMajor = [int](($nodeVersion -replace '^v', '').Split('.')[0])
if ($nodeMajor -lt 20) { throw "Node 版本过低：$nodeVersion（需要 20+）" }

# opencode 真实二进制（只探测，不打印任何密钥）
$opencodePath = Join-Path $env:APPDATA 'npm\node_modules\@opencode\cli\bin\opencode.exe'
$opencodeVersion = $null
if (Test-Path $opencodePath) {
  $opencodeVersion = (& $opencodePath --version 2>$null | Out-String).Trim()
} else {
  Write-Warning "未在默认位置找到 opencode.exe：$opencodePath（可用环境变量 OPENCODE_BIN 指定）"
}

$registerParams = [ordered]@{
  name              = $server.name
  transport         = 'stdio'
  command           = $server.command
  # args 用本机解析出的真实路径，plugin.json 里是仓库中的占位路径
  args              = @($serverPath)
}

if ($Json) {
  $registerParams | ConvertTo-Json -Depth 6
  exit 0
}

if ($server.args -and $server.args.Count -gt 0 -and $server.args[0] -ne $serverPath) {
  Write-Host "提示：plugin.json 的 args 是占位路径（$($server.args[0])），注册参数已替换为 $serverPath" -ForegroundColor DarkGray
}

Write-Host '=== opencode-bridge 安装参数（本地文件无需复制） ===' -ForegroundColor Cyan
Write-Host ""
Write-Host "插件目录 : $root"
Write-Host "server   : $serverPath"
Write-Host "node     : $nodePath ($nodeVersion)"
Write-Host "opencode : $(if ($opencodeVersion) { $opencodeVersion } else { '未检测到' })"
Write-Host ""
Write-Host '--- 交给 openbot.save_mcp_server 的参数 ---' -ForegroundColor Yellow
$registerParams | ConvertTo-Json -Depth 6
Write-Host ""
Write-Host '提示：本脚本不会自行注册。上面这段 JSON 由用户在 OpenBot 里批准后，由 agent 调 openbot.save_mcp_server 提交。' -ForegroundColor DarkGray
Write-Host '      每个 agent 都会在下一次发言时拿到这些工具。' -ForegroundColor DarkGray

if ($Verify) {
  Write-Host ""
  Write-Host '=== 自检 ===' -ForegroundColor Cyan
  Push-Location $root
  try {
    & node (Join-Path $root 'tests\mcp-selftest.mjs')
    $code = $LASTEXITCODE
  } finally {
    Pop-Location
  }
  if ($code -ne 0) { throw "自检失败（exit $code）" }
  Write-Host '自检通过' -ForegroundColor Green
}

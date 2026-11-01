<#
.SYNOPSIS
  opencode-bridge 卸载助手：只打印注销参数与本地清理步骤，不调用任何 OpenBot 接口。

.PARAMETER PurgeSmoke
  删除 tests 产生的 .smoke/ 临时目录（仅本地文件操作）。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
#>
[CmdletBinding()]
param(
  [switch]$PurgeSmoke
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$pluginPath = Join-Path $root 'plugin.json'
$serverName = 'opencode-bridge'

if (Test-Path $pluginPath) {
  $plugin = Get-Content -Raw -Encoding UTF8 -Path $pluginPath | ConvertFrom-Json
  if ($plugin.apps[0].server.name) { $serverName = $plugin.apps[0].server.name }
}

Write-Host '=== 卸载 opencode-bridge ===' -ForegroundColor Cyan
Write-Host ""
Write-Host '1) 在 OpenBot 里移除 MCP server（由用户在 OpenBot 中批准，本脚本不代做）：' -ForegroundColor Yellow
[ordered]@{ name = $serverName } | ConvertTo-Json -Depth 3
Write-Host ""
Write-Host '2) 本地文件（可选，删了就没了）：' -ForegroundColor Yellow
Write-Host "   Remove-Item -Recurse -Force '$root'"
Write-Host ""

if ($PurgeSmoke) {
  $smoke = Join-Path $root '.smoke'
  if (Test-Path $smoke) {
    Remove-Item -Recurse -Force $smoke
    Write-Host "已删除测试目录：$smoke" -ForegroundColor Green
  } else {
    Write-Host '没有 .smoke 测试目录需要清理。' -ForegroundColor DarkGray
  }
} else {
  Write-Host '（加 -PurgeSmoke 可一并删除 .smoke 测试目录）' -ForegroundColor DarkGray
}

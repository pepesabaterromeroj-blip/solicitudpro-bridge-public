$ErrorActionPreference = 'Stop'
$bridgeRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$pidFile = Join-Path $bridgeRoot 'data\bridge.pid'
$bridgePid = if (Test-Path -LiteralPath $pidFile) { [int](Get-Content -LiteralPath $pidFile -Raw).Trim() } else { 0 }
$details = if ($bridgePid) { Get-CimInstance Win32_Process -Filter "ProcessId = $bridgePid" } else { $null }
$entrypoint = Join-Path $bridgeRoot 'dist\src\index.js'
$active = $details -and $details.Name -eq 'node.exe' -and $details.CommandLine.Contains($entrypoint)
$children = if ($active) { @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $bridgePid" | Where-Object Name -eq 'codex.exe') } else { @() }
[pscustomobject]@{
  Bridge = if ($active) { 'active' } else { 'inactive' }
  ProcessId = if ($active) { $bridgePid } else { $null }
  Transport = 'stdio (no listening port)'
  AppServer = if ($children.Count) { 'active' } else { 'inactive/on demand' }
  Tunnel = 'not managed/configured'
  ConfigPresent = Test-Path -LiteralPath (Join-Path $bridgeRoot 'config\local.json')
} | Format-List

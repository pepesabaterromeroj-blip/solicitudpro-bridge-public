$ErrorActionPreference = 'Stop'
$bridgeRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$pidFile = Join-Path $bridgeRoot 'data\bridge.pid'

if (-not (Test-Path -LiteralPath $pidFile)) {
  Write-Host 'No bridge PID file exists; nothing to stop.'
  exit 0
}

$bridgePid = [int](Get-Content -LiteralPath $pidFile -Raw).Trim()
$process = Get-Process -Id $bridgePid -ErrorAction SilentlyContinue
if (-not $process) {
  Remove-Item -LiteralPath $pidFile -Force
  Write-Host 'Stale PID file removed; bridge was not running.'
  exit 0
}

$entrypoint = Join-Path $bridgeRoot 'dist\src\index.js'
$details = Get-CimInstance Win32_Process -Filter "ProcessId = $bridgePid"
if (-not $details -or $details.Name -ne 'node.exe' -or -not $details.CommandLine.Contains($entrypoint)) {
  throw 'PID does not belong to this Bridge entrypoint. Refusing to stop another process.'
}
taskkill /PID $bridgePid /T /F | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not stop the Bridge process tree.' }
Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
Write-Host "Stopped SolicitudPro Bridge process $bridgePid."

param(
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$bridgeRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $bridgeRoot

if (-not (Test-Path -LiteralPath (Join-Path $bridgeRoot 'config\local.json'))) {
  throw 'Missing config/local.json. Copy config/local.example.json and set only local allowlisted paths.'
}

if (-not $SkipBuild) {
  npm run build
  if ($LASTEXITCODE -ne 0) { throw 'Bridge build failed.' }
}

Write-Host 'SolicitudPro Bridge MCP starting over stdio. Press Ctrl+C to stop.'
Write-Host 'No tunnel is started by this script.'
node (Join-Path $bridgeRoot 'dist\src\index.js')

param([Parameter(Mandatory = $true)][string]$ProjectPath, [string]$CodexCommand = 'codex')
$ErrorActionPreference = 'Stop'
$bridgeRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $bridgeRoot
if (-not (Test-Path -LiteralPath $ProjectPath -PathType Container)) { throw 'ProjectPath must be an existing checkout directory.' }
node --version
if ($LASTEXITCODE -ne 0) { throw 'Node.js 22+ is required.' }
$configPath = Join-Path $bridgeRoot 'config\local.json'
if (Test-Path -LiteralPath $configPath) { throw 'Local configuration already exists; preserve it and edit it manually if needed.' }
$config = Get-Content -Raw -LiteralPath (Join-Path $bridgeRoot 'config\local.example.json') | ConvertFrom-Json
$config.projects.solicitudpro.path = (Resolve-Path -LiteralPath $ProjectPath).Path
$config.codex.command = $CodexCommand
[System.IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json -Depth 10), [System.Text.UTF8Encoding]::new($false))
& $CodexCommand --version
if ($LASTEXITCODE -ne 0) { throw 'Codex is unavailable. Configure a native codex.exe path on Windows.' }
& $CodexCommand login status
if ($LASTEXITCODE -ne 0) { throw 'Log into Codex locally before continuing.' }
npm ci
if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
npm run check
if ($LASTEXITCODE -ne 0) { throw 'TypeScript check failed.' }
npm run build
if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }
npm test
if ($LASTEXITCODE -ne 0) { throw 'Unit tests failed.' }
Write-Host 'Bootstrap complete. Run npm run test:integration, then start-bridge.ps1.'

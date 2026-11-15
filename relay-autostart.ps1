param(
  [ValidateSet('Install', 'Status', 'Uninstall', 'Run')]
  [string]$Action = 'Status',
  [string]$NodePath,
  [string]$GitDirectory
)

$ErrorActionPreference = 'Stop'
$taskName = 'SolicitudPro Bridge Relay'
$entry = Join-Path $PSScriptRoot 'dist\local\start-relay.js'

if ($Action -eq 'Run') {
  if (-not $NodePath -or -not $GitDirectory) { throw 'Missing executable configuration' }
  $env:Path = "$GitDirectory;$env:Path"
  while ($true) {
    & $NodePath $entry
    # Configuration errors need a local correction. Other exits are restartable.
    if ($LASTEXITCODE -eq 78) { exit 0 }
    Start-Sleep -Seconds 15
  }
}

$task = Get-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction SilentlyContinue
if ($Action -eq 'Status') {
  if (-not $task) { Write-Output 'Auto-start task not installed'; exit 1 }
  $task | Select-Object TaskName, State
  $task | Get-ScheduledTaskInfo | Select-Object LastRunTime, LastTaskResult
  exit
}

$account = [Security.Principal.WindowsIdentity]::GetCurrent()
$owner = $account.User.Value
if ($task) {
  $taskOwner = $task.Principal.UserId
  if ($taskOwner -notlike 'S-1-*') {
    $taskOwner = ([Security.Principal.NTAccount]::new($taskOwner)).Translate([Security.Principal.SecurityIdentifier]).Value
  }
  $sameOwner = $taskOwner -eq $owner
  $sameRoot = $task.Actions.Count -eq 1 -and $task.Actions[0].WorkingDirectory -eq $PSScriptRoot
  if (-not ($sameOwner -and $sameRoot)) { throw 'Existing task belongs to a different user or checkout' }
}
if ($Action -eq 'Uninstall') {
  if ($task) {
    if ($task.State -eq 'Running') { Stop-ScheduledTask -InputObject $task }
    Unregister-ScheduledTask -InputObject $task -Confirm:$false
  }
  exit
}

$node = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source
$git = (Get-Command git.exe -CommandType Application | Select-Object -First 1).Source
& $node $entry --check-config
if ($LASTEXITCODE -ne 0) { throw 'Build the Bridge and fix the reported preflight issue before installing' }
if ($task -and $task.State -eq 'Running') { throw 'Stop the existing scheduled relay before reinstalling' }

$arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -File "{0}" -Action Run -NodePath "{1}" -GitDirectory "{2}"' -f $PSCommandPath, $node, (Split-Path -Parent $git)
$windowsPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$scheduledAction = New-ScheduledTaskAction -Execute $windowsPowerShell -Argument $arguments -WorkingDirectory $PSScriptRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $owner
$principal = New-ScheduledTaskPrincipal -UserId $owner -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $taskName -TaskPath '\' -Action $scheduledAction -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $taskName -TaskPath '\'
Write-Output 'Relay auto-start installed and start requested'

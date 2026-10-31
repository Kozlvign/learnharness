<#
.SYNOPSIS
    Registers (or removes) a daily scheduled task that keeps the fork's
    installed app current: it runs release-windows.ps1, which merges upstream,
    builds and publishes a fork release only when something changed. Installed
    copies then update themselves from that release.

.EXAMPLE
    .\install-update-task.ps1            # daily at 13:00
.EXAMPLE
    .\install-update-task.ps1 -At 09:30
.EXAMPLE
    .\install-update-task.ps1 -Remove
#>
[CmdletBinding()]
param(
    [string]$At = '13:00',
    [switch]$Remove
)
$ErrorActionPreference = 'Stop'
$name = 'LearnHarness fork update'
if ($Remove) {
    Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "Removed the scheduled task '$name'."
    exit 0
}
$script = Join-Path $PSScriptRoot 'release-windows.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`""
$trigger = New-ScheduledTaskTrigger -Daily -At $At
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RunOnlyIfNetworkAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 2)
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Force `
    -Description 'Merges upstream LearnHarness into the Claude fork and publishes a new fork release when something changed. Logs: %LOCALAPPDATA%\LearnHarness-fork\logs' | Out-Null
Write-Host "Registered '$name': daily at $At (runs later if the computer was off)."

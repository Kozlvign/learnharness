<#
.SYNOPSIS
    Sets up (or removes) the automatic updates of the fork's installed app, so
    the desktop icon always opens what is on the fork's main.

.DESCRIPTION
    1. Clones the fork into a folder only the automation uses
       (D:\Codes\Projects\learnharness-build by default), so builds never touch
       your own checkout. Run again, it fast-forwards that folder instead.
    2. Registers a scheduled task that runs auto-update.ps1 from that folder
       every 5 minutes, without a window: when the fork's main or upstream
       moved, it builds, publishes and installs a fork release.
    3. Compiles the launcher (launcher.cs, with build-launcher.ps1) and points
       the desktop's LearnHarness icon at it. The launcher opens the app
       updated: it waits for a build in progress and installs a waiting
       version first. The installer keeps the desktop shortcut on updates
       (KeepShortcuts), so the icon stays on the launcher.
    4. Points the Start menu's "Atualizar LearnHarness (Claude)" at an
       immediate update from the build folder.

.EXAMPLE
    .\install-update-task.ps1
.EXAMPLE
    .\install-update-task.ps1 -Remove
    Remove the task and the launcher, and point the desktop icon at the app
    again. The build folder stays.
#>
[CmdletBinding()]
param(
    # The checkout only the automation uses.
    [string]$BuildDir = 'D:\Codes\Projects\learnharness-build',
    # How often to look for new commits on the fork and upstream.
    [int]$Minutes = 5,
    [switch]$Remove,
    # The fork on GitHub.
    [string]$Repository = 'https://github.com/Kozlvign/learnharness.git'
)
$ErrorActionPreference = 'Stop'
$name = 'LearnHarness fork update'
$appExe = Join-Path $env:LOCALAPPDATA 'Programs\learnharness\LearnHarness.exe'
$desktopLink = Join-Path ([Environment]::GetFolderPath('Desktop')) 'LearnHarness.lnk'
$updateLink = Join-Path ([Environment]::GetFolderPath('Programs')) 'Atualizar LearnHarness (Claude).lnk'
$conhost = Join-Path $env:SystemRoot 'System32\conhost.exe'
# Where build-launcher.ps1 puts the launcher.
$launcherDir = Join-Path $env:LOCALAPPDATA 'LearnHarness-fork\launcher'
$launcherExe = Join-Path $launcherDir 'LearnHarness Launcher.exe'
$shell = New-Object -ComObject WScript.Shell

function Set-Shortcut([string]$Path, [string]$Target, [string]$Arguments, [string]$WorkingDirectory, [string]$Icon, [string]$Description) {
    $link = $shell.CreateShortcut($Path)
    $link.TargetPath = $Target
    $link.Arguments = $Arguments
    $link.WorkingDirectory = $WorkingDirectory
    if ($Icon) { $link.IconLocation = $Icon }
    if ($Description) { $link.Description = $Description }
    $link.Save()
}

function Invoke-Git([string[]]$Arguments) {
    & git.exe @Arguments
    if ($LASTEXITCODE -ne 0) { throw "'git $($Arguments -join ' ')' failed with exit code $LASTEXITCODE." }
}

if ($Remove) {
    Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "Removed the scheduled task '$name'."
    if (Test-Path -LiteralPath $appExe) {
        Set-Shortcut $desktopLink $appExe '' (Split-Path -Parent $appExe) "$appExe,0" ''
        Write-Host 'The desktop icon opens the app directly again.'
    }
    Remove-Item -LiteralPath $launcherDir -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "The build folder stays at $BuildDir. Delete it to free the space."
    exit 0
}

foreach ($tool in 'git', 'node', 'npm', 'gh') {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "$tool was not found in PATH." }
}
if (-not (Test-Path -LiteralPath $appExe)) { throw "LearnHarness is not installed at $appExe. Install a release of the fork first." }

if (Test-Path -LiteralPath (Join-Path $BuildDir '.git')) {
    Write-Host "Updating the build folder $BuildDir."
    if ((& git.exe -C $BuildDir branch --show-current) -ne 'main') { throw "$BuildDir is not on main." }
    Invoke-Git @('-C', $BuildDir, 'fetch', '--quiet', 'origin')
    Invoke-Git @('-C', $BuildDir, 'merge', '--ff-only', '--quiet', 'origin/main')
} else {
    if ((Test-Path -LiteralPath $BuildDir) -and (Get-ChildItem -LiteralPath $BuildDir -Force | Select-Object -First 1)) {
        throw "$BuildDir exists and is not a checkout of the fork."
    }
    Write-Host "Cloning the fork into $BuildDir."
    Invoke-Git @('clone', '--quiet', $Repository, $BuildDir)
}
if (-not (& git.exe -C $BuildDir remote | Where-Object { $_ -eq 'upstream' })) {
    Invoke-Git @('-C', $BuildDir, 'remote', 'add', 'upstream', 'https://github.com/amosblomqvist/learnharness.git')
}
$updater = Join-Path $BuildDir 'scripts\fork\auto-update.ps1'
$builder = Join-Path $BuildDir 'scripts\fork\build-launcher.ps1'
foreach ($file in $updater, $builder) {
    if (-not (Test-Path -LiteralPath $file)) { throw "The fork's main has no $(Split-Path -Leaf $file) yet." }
}

# conhost --headless runs PowerShell with no console window at all.
$action = New-ScheduledTaskAction -Execute $conhost -Argument "--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$updater`"" -WorkingDirectory $BuildDir
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes $Minutes)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RunOnlyIfNetworkAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 2)
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Force `
    -Description "Builds, publishes and installs a release of the Claude fork of LearnHarness when its main or upstream has new commits. Runs from $BuildDir. State and logs: %LOCALAPPDATA%\LearnHarness-fork" | Out-Null
Write-Host "Registered '$name': every $Minutes minutes, from $BuildDir."

& $builder -OutDir $launcherDir
# The desktop icon starts a program, not a script: Kaspersky deletes
# shortcuts that start a hidden PowerShell.
Set-Shortcut $desktopLink $launcherExe "--repo `"$BuildDir`"" $launcherDir "$appExe,0" "LearnHarness, updated to the fork's main"
Write-Host 'The desktop icon now opens LearnHarness updated to the fork''s main.'
Set-Shortcut $updateLink (Join-Path $BuildDir 'scripts\fork\Update-LearnHarness.cmd') '' $BuildDir '' ''
Write-Host "'Atualizar LearnHarness (Claude)' in the Start menu now updates from $BuildDir."

Start-ScheduledTask -TaskName $name
Write-Host 'The first check is running now.'

# An antivirus acts within seconds of a new file; say so instead of leaving a dead icon.
Start-Sleep -Seconds 5
foreach ($file in $launcherExe, $desktopLink) {
    if (-not (Test-Path -LiteralPath $file)) {
        Write-Host "$file was removed, probably by the antivirus. Run install-update-task.ps1 -Remove to point the icon at the app again." -ForegroundColor Yellow
    }
}

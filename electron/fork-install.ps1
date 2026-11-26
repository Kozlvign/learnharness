<#
    Fork (update button, docs/claude.md): installs the version the release
    script copied beside the installed app (release-windows.ps1 -StageDir).

    electron/fork-update.cjs writes this file to the update state folder and
    starts it hidden as the app quits. It waits for LearnHarness to exit, then:
    the installed folder becomes <folder>.previous (the backup for a rollback,
    replacing the one before), the staged folder becomes the installed one,
    and a failure puts the installed folder back. The outcome goes to
    -ResultFile, which the next launch reads. -Relaunch opens the app again,
    the new version or, after a failure, the old one.
#>
param(
    [Parameter(Mandatory = $true)][string]$InstallDir,
    [Parameter(Mandatory = $true)][string]$StagedDir,
    [Parameter(Mandatory = $true)][string]$Commit,
    [Parameter(Mandatory = $true)][string]$ResultFile,
    [string]$Version,
    # The app that started this; it is gone before anything moves.
    [int]$ParentPid,
    [switch]$Relaunch
)

$ErrorActionPreference = 'Stop'
$InstallDir = $InstallDir.TrimEnd('\')
$previous = "$InstallDir.previous"
$old = "$InstallDir.old"
$exe = Join-Path $InstallDir 'LearnHarness.exe'

function Write-Outcome([bool]$Ok, [string]$Message) {
    $json = [ordered]@{ ok = $Ok; commit = $Commit; version = $Version; message = $Message; finished = (Get-Date).ToString('o') } | ConvertTo-Json
    [IO.File]::WriteAllText($ResultFile, $json, (New-Object Text.UTF8Encoding($false)))
}

# Antivirus scanners and the search indexer hold files for a moment after
# they are written or a program exits, which makes a rename fail.
function Retry([scriptblock]$Action, [string]$What) {
    for ($attempt = 1; ; $attempt++) {
        try { & $Action; return }
        catch {
            if ($attempt -ge 30) { throw "$What failed: $($_.Exception.Message)" }
            Start-Sleep -Seconds 1
        }
    }
}

# LearnHarness processes running from the installed folder: the app and its server.
function Get-AppProcess {
    $prefix = "$InstallDir\"
    @(Get-CimInstance Win32_Process -Filter "Name = 'LearnHarness.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) })
}

try {
    $deadline = (Get-Date).AddMinutes(2)
    while (($ParentPid -gt 0 -and (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) -or (Get-AppProcess).Count -gt 0) {
        if ((Get-Date) -gt $deadline) { throw 'LearnHarness was still running after 2 minutes.' }
        Start-Sleep -Milliseconds 500
    }

    $marker = Join-Path $StagedDir '.lh-build.json'
    $staged = $null
    if (Test-Path -LiteralPath $marker) { $staged = [IO.File]::ReadAllText($marker) | ConvertFrom-Json }
    if (-not $staged -or "$($staged.commit)" -ne $Commit -or -not (Test-Path -LiteralPath (Join-Path $StagedDir 'LearnHarness.exe'))) {
        throw "The new version in $StagedDir is incomplete."
    }

    # The last backup goes aside at once and is deleted after the app reopens.
    if (Test-Path -LiteralPath $previous) {
        if (Test-Path -LiteralPath $old) { Retry { Remove-Item -LiteralPath $old -Recurse -Force } 'Removing an old backup' }
        Retry { Rename-Item -LiteralPath $previous -NewName (Split-Path $old -Leaf) } 'Moving the last backup aside'
    }
    Retry { Rename-Item -LiteralPath $InstallDir -NewName (Split-Path $previous -Leaf) } 'Moving the installed version aside'
    try { Retry { Rename-Item -LiteralPath $StagedDir -NewName (Split-Path $InstallDir -Leaf) } 'Moving the new version in' }
    catch {
        Retry { Rename-Item -LiteralPath $previous -NewName (Split-Path $InstallDir -Leaf) } 'Putting the installed version back'
        throw
    }

    # The installer's uninstaller lives beside the app; the packaged folder lacks it.
    $uninstaller = Join-Path $previous 'Uninstall LearnHarness.exe'
    if ((Test-Path -LiteralPath $uninstaller) -and -not (Test-Path -LiteralPath (Join-Path $InstallDir 'Uninstall LearnHarness.exe'))) {
        Copy-Item -LiteralPath $uninstaller -Destination $InstallDir
    }
    # The version Windows lists under installed apps.
    if ($Version) {
        try {
            foreach ($key in Get-ChildItem -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall') {
                $entry = Get-ItemProperty -LiteralPath $key.PSPath
                if ("$($entry.UninstallString)".IndexOf("$InstallDir\", [StringComparison]::OrdinalIgnoreCase) -ge 0) {
                    Set-ItemProperty -LiteralPath $key.PSPath -Name DisplayVersion -Value $Version
                    Set-ItemProperty -LiteralPath $key.PSPath -Name DisplayName -Value "LearnHarness $Version"
                }
            }
        } catch { }
    }
    Write-Outcome $true $null
} catch {
    Write-Outcome $false $_.Exception.Message
} finally {
    if ($Relaunch -and (Test-Path -LiteralPath $exe)) { Start-Process -FilePath $exe -WorkingDirectory $InstallDir }
}
if (Test-Path -LiteralPath $old) { try { Remove-Item -LiteralPath $old -Recurse -Force } catch { } }

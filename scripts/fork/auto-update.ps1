<#
.SYNOPSIS
    Keeps the installed fork app current with the fork's main branch.

.DESCRIPTION
    install-update-task.ps1 schedules this every 5 minutes, without a window,
    from a checkout only the automation uses. Each run:
    1. Fetches the fork (origin) and upstream. When neither moved since the
       last run, it stops there, without writing a log.
    2. Otherwise it runs release-windows.ps1 -Install: merge upstream, build,
       publish a fork release when the app changed, and install it when the
       app is closed.
    3. It records the outcome in %LOCALAPPDATA%\LearnHarness-fork\state.json
       for the desktop launcher (launcher.ps1): a build in progress, the
       newest version built here and its installer, or why it failed.
    The state survives restarts, so the same commits are never built twice:
    after a finished run, only new commits on either branch start another.
    A failed run is not retried on its own either; new commits or -Now do.
    Only a run cut short (the computer turned off mid-build) runs again.

.EXAMPLE
    .\auto-update.ps1 -Now
    Run the release now, even when nothing moved. The Start menu's
    "Atualizar LearnHarness (Claude)" does this.
#>
[CmdletBinding()]
param(
    # Run the release even when neither branch moved since the last run.
    [switch]$Now,
    # Where the state, the release logs and the release result live.
    [string]$StateDir = (Join-Path $env:LOCALAPPDATA 'LearnHarness-fork')
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).ProviderPath
$stateFile = Join-Path $StateDir 'state.json'
$keepLogs = 50
New-Item -ItemType Directory -Force -Path $StateDir | Out-Null

function Invoke-Git([string[]]$Arguments) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { $lines = @(& git.exe -C $repo @Arguments 2>$null) } finally { $ErrorActionPreference = $previous }
    if ($LASTEXITCODE -ne 0) { throw "'git $($Arguments -join ' ')' failed with exit code $LASTEXITCODE." }
    $lines | ForEach-Object { "$_" }
}

function Read-State {
    if (-not (Test-Path -LiteralPath $stateFile)) { return $null }
    try { return [IO.File]::ReadAllText($stateFile) | ConvertFrom-Json } catch { return $null }
}

# The launcher reads this file while it waits, so it is replaced whole.
function Write-State($State) {
    $temp = "$stateFile.$PID.tmp"
    [IO.File]::WriteAllText($temp, ($State | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
    for ($attempt = 1; ; $attempt++) {
        try { Move-Item -LiteralPath $temp -Destination $stateFile -Force; return }
        catch { if ($attempt -ge 10) { throw }; Start-Sleep -Milliseconds 200 }
    }
}

$lock = New-Object System.Threading.Mutex($false, 'Local\LearnHarness-fork-update')
$owned = $false
try { $owned = $lock.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $owned = $true }
if (-not $owned) {
    if ($Now) { Write-Host 'An update is already running. The desktop icon shows its progress.' }
    exit 0
}

$exitCode = 0
try {
    if (-not (Invoke-Git @('remote') | Where-Object { $_ -eq 'upstream' })) {
        Invoke-Git @('remote', 'add', 'upstream', 'https://github.com/amosblomqvist/learnharness.git') | Out-Null
    }
    Invoke-Git @('fetch', '--quiet', 'origin') | Out-Null
    Invoke-Git @('fetch', '--quiet', 'upstream') | Out-Null
    $origin = Invoke-Git @('rev-parse', 'origin/main') | Select-Object -First 1
    $upstream = Invoke-Git @('rev-parse', 'upstream/main') | Select-Object -First 1

    $state = Read-State
    # 'building' here means a run that never finished (this one holds the lock).
    $skip = (-not $Now) -and $state -and $state.origin -eq $origin -and $state.upstream -eq $upstream -and $state.status -in @('ready', 'failed')

    if (-not $skip) {
        Write-State ([ordered]@{
            status = 'building'; pid = $PID; started = (Get-Date).ToString('o')
            origin = $origin; upstream = $upstream
            version = $state.version; installer = $state.installer
        })
        $resultFile = Join-Path $StateDir 'release-result.json'
        Remove-Item -LiteralPath $resultFile -ErrorAction SilentlyContinue
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'release-windows.ps1') -Install -ResultFile $resultFile
        $code = $LASTEXITCODE
        $result = $null
        if (Test-Path -LiteralPath $resultFile) { try { $result = [IO.File]::ReadAllText($resultFile) | ConvertFrom-Json } catch { } }

        $ok = ($code -eq 0) -and $result -and $result.ok
        $message = $null
        if (-not $ok) {
            $message = if ($result -and $result.message) { $result.message } else { "The release script stopped with exit code $code." }
        }
        $version = $state.version
        $installer = $state.installer
        if ($result -and $result.version) { $version = $result.version; $installer = $result.installer }
        # A release pushes its tag, and may push an upstream merge to main.
        $after = Invoke-Git @('rev-parse', 'origin/main') | Select-Object -First 1
        Write-State ([ordered]@{
            status = $(if ($ok) { 'ready' } else { 'failed' }); finished = (Get-Date).ToString('o')
            origin = $after; upstream = $upstream
            version = $version; installer = $installer
            message = $message; log = $(if ($result) { $result.log } else { $null })
        })
        if (-not $ok) { $exitCode = 1 }

        $logs = Join-Path $StateDir 'logs'
        if (Test-Path -LiteralPath $logs) {
            Get-ChildItem -LiteralPath $logs -Filter 'release-*.log' | Sort-Object LastWriteTime -Descending | Select-Object -Skip $keepLogs | Remove-Item -Force -ErrorAction SilentlyContinue
        }
    }
} catch {
    # Fetch failures (offline) land here too; the next run tries again.
    Write-Host $_.Exception.Message -ForegroundColor Red
    $exitCode = 1
} finally {
    $lock.ReleaseMutex()
}
exit $exitCode

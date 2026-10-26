<#
.SYNOPSIS
    Syncs the fork with upstream LearnHarness, builds the Windows installer and
    publishes it as a release of the fork, which installed copies update from.

.DESCRIPTION
    1. Merges upstream/main into main (stops on conflicts, changing nothing).
    2. Skips everything when nothing changed since the last fork release.
    3. Builds and checks the app the way upstream's release workflow does.
    4. Tags the commit and publishes the installer, blockmap and latest.yml as
       a GitHub release of the fork. Installed copies then update themselves.

    Fork versions encode the upstream version and a fork revision in the patch
    number: upstream 0.3.8, revision 1 -> 0.3.801. They are applied at build
    time only, so package.json keeps upstream's version and merges stay clean.

.EXAMPLE
    .\release-windows.ps1 -Install
    Sync, build, publish, then install the new build on this computer.

.EXAMPLE
    .\release-windows.ps1 -NoPublish
    Build an installer into dist\ without tagging or publishing.
#>
[CmdletBinding()]
param(
    # Do not merge upstream changes first.
    [switch]$NoSync,
    # Build only: no tag, push or release.
    [switch]$NoPublish,
    # Install the new build silently afterwards (skipped while the app runs).
    [switch]$Install,
    # Release even when nothing changed since the last fork release.
    [switch]$Force,
    # The fork on GitHub.
    [string]$Repository = 'Kozlvign/learnharness'
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).ProviderPath
Set-Location -LiteralPath $repo
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

$logDir = Join-Path $env:LOCALAPPDATA 'LearnHarness-fork\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir ('release-{0:yyyyMMdd-HHmmss}.log' -f (Get-Date))
Start-Transcript -LiteralPath $log | Out-Null

function Step([string]$Text) { Write-Host ''; Write-Host "== $Text" -ForegroundColor Cyan }
function Native([string]$File, [string[]]$Arguments) {
    & $File @Arguments
    if ($LASTEXITCODE -ne 0) { throw "'$File $($Arguments -join ' ')' failed with exit code $LASTEXITCODE." }
}
function Invoke-Git([string[]]$Arguments) {
    $output = & git.exe @Arguments
    if ($LASTEXITCODE -ne 0) { throw "'git $($Arguments -join ' ')' failed with exit code $LASTEXITCODE." }
    $output
}

$exitCode = 0
try {
    foreach ($tool in 'git', 'node', 'npm', 'gh') {
        if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "$tool was not found in PATH." }
    }
    if ((Invoke-Git @('branch', '--show-current')) -ne 'main') { throw 'Check out main first.' }
    if (Invoke-Git @('status', '--porcelain', '--untracked-files=no')) { throw 'The working tree has uncommitted changes. Commit or discard them first.' }
    if (-not (& git.exe remote | Where-Object { $_ -eq 'upstream' })) { Invoke-Git @('remote', 'add', 'upstream', 'https://github.com/amosblomqvist/learnharness.git') | Out-Null }

    if (-not $NoSync) {
        Step 'Syncing with upstream'
        Invoke-Git @('fetch', '--quiet', 'origin') | Out-Null
        Invoke-Git @('fetch', '--quiet', 'upstream') | Out-Null
        $behindOrigin = [int](Invoke-Git @('rev-list', '--count', 'HEAD..origin/main'))
        if ($behindOrigin -gt 0) { Invoke-Git @('merge', '--ff-only', '--quiet', 'origin/main') | Out-Null }
        $behind = [int](Invoke-Git @('rev-list', '--count', 'HEAD..upstream/main'))
        if ($behind -gt 0) {
            & git.exe merge --no-edit --quiet upstream/main
            if ($LASTEXITCODE -ne 0) {
                & git.exe merge --abort
                throw "Upstream has $behind new commits that conflict with the fork. Merge upstream/main by hand, then run this again."
            }
            Write-Host "Merged $behind upstream commits."
        } else { Write-Host 'Already up to date with upstream.' }
    }

    $upstreamVersion = ((Get-Content -LiteralPath (Join-Path $repo 'package.json') -Raw -Encoding UTF8) | ConvertFrom-Json).version
    if ($upstreamVersion -notmatch '^(\d+)\.(\d+)\.(\d+)$') { throw "Unexpected version '$upstreamVersion' in package.json." }
    $major = [int]$Matches[1]; $minor = [int]$Matches[2]; $base = [int]$Matches[3] * 100
    $revisions = @(& git.exe tag -l "v$major.$minor.*" | ForEach-Object {
        if ($_ -match "^v$major\.$minor\.(\d+)$") { [int]$Matches[1] - $base }
    } | Where-Object { $_ -ge 1 -and $_ -le 99 })
    $last = ($revisions | Measure-Object -Maximum).Maximum
    if ($last -and -not $Force) {
        $lastTag = "v$major.$minor.$($base + $last)"
        if ([int](Invoke-Git @('rev-list', '--count', "$lastTag..HEAD")) -eq 0) {
            Write-Host "Nothing changed since $lastTag. No new release is needed."
            return
        }
    }
    $revision = if ($last) { $last + 1 } else { 1 }
    if ($revision -gt 99) { throw "Too many fork releases for upstream $upstreamVersion." }
    $version = "$major.$minor.$($base + $revision)"
    Write-Host "Building LearnHarness $version (upstream $upstreamVersion, fork revision $revision)."

    Step 'Installing dependencies'
    foreach ($path in 'dist', (Join-Path '.next' 'standalone')) { if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Recurse -Force } }
    Native 'npm' @('ci', '--no-audit', '--no-fund')
    if (-not (Test-Path -LiteralPath (Join-Path $repo 'node_modules\electron\dist\electron.exe'))) { Native 'node' @('node_modules/electron/install.js') }

    Step 'Checking'
    Native 'npx' @('tsc', '--noEmit')
    $env:NODE_ENV = 'test'
    try { Native 'npx' @('tsx', '--test', 'tests/claude-code-bridge.test.ts') } finally { Remove-Item Env:NODE_ENV -ErrorAction SilentlyContinue }

    Step 'Building'
    Native 'npm' @('run', 'build')
    Native 'node' @('scripts/smoke-provider-runtime.mjs')
    Native 'node' @('scripts/build-server.mjs')
    Native 'node' @('scripts/smoke-server.mjs', '--electron')
    Native 'npx' @('electron-builder', '--win', '--x64', '--publish', 'never', "-c.extraMetadata.version=$version")
    $installer = Join-Path $repo "dist\LearnHarness-$version-x64-setup.exe"
    if (-not (Test-Path -LiteralPath $installer)) { throw "The installer was not produced: $installer" }

    if (-not $NoPublish) {
        Step 'Publishing'
        $tag = "v$version"
        Invoke-Git @('tag', '-a', $tag, '-m', "LearnHarness $version (Claude fork of upstream $upstreamVersion)") | Out-Null
        Invoke-Git @('push', '--quiet', 'origin', 'main', $tag) | Out-Null
        $assets = @($installer, "$installer.blockmap", (Join-Path $repo 'dist\latest.yml'))
        $notes = "LearnHarness $upstreamVersion with the Claude connection (Claude models through your own Claude Code sign-in). Fork revision $revision.`n`nInstalled copies update automatically. Upstream changes: https://github.com/amosblomqvist/learnharness/releases"
        Native 'gh' (@('release', 'create', $tag) + $assets + @('--repo', $Repository, '--title', "LearnHarness $version", '--notes', $notes, '--latest'))
        Write-Host "Published https://github.com/$Repository/releases/tag/$tag"
    }

    if ($Install) {
        Step 'Installing'
        if (Get-Process -Name 'LearnHarness' -ErrorAction SilentlyContinue) {
            Write-Host 'LearnHarness is running, so it was not reinstalled now. It updates itself from the release when it next checks.' -ForegroundColor Yellow
        } else {
            $process = Start-Process -FilePath $installer -ArgumentList '/S' -Wait -PassThru
            if ($process.ExitCode -ne 0) { throw "The installer exited with code $($process.ExitCode)." }
            Write-Host "Installed LearnHarness $version."
        }
    }
} catch {
    Write-Host ''
    Write-Host $_.Exception.Message -ForegroundColor Red
    $exitCode = 1
} finally {
    Stop-Transcript | Out-Null
    Write-Host "Log: $log"
}
exit $exitCode

<#
.SYNOPSIS
    Syncs the fork with upstream LearnHarness, builds the Windows app and
    publishes it as a release of the fork.

.DESCRIPTION
    1. Merges upstream/main into main (stops on conflicts, changing nothing).
       With -ForkOnly it moves to the fork's main instead.
    2. Builds nothing when nothing changed: when the installed app
       (-InstalledCommit) already has what main has, or when the last build in
       dist\ does (it is reused, and its release completed if an earlier run
       was cut short). Run by hand without -InstalledCommit, it also stops when
       nothing changed since the last fork release.
    3. Installs dependencies, only where a package-lock.json changed since the
       last install that finished here.
    4. Translates new upstream interface text into Brazilian Portuguese with
       your Claude Code (scripts/fork/i18n/sync.ts) and commits the catalog.
       Untranslated text just stays in English, so a failure here only warns.
    5. Builds and checks the app the way upstream's release workflow does
       (-SkipChecks leaves the type check, tests and smoke tests out).
    6. With -StageDir (the app's update button), copies the packaged app there
       and reports it ready, so the app can swap it in; then makes the
       installer. Otherwise it makes the installer, and installs it with
       -Install.
    7. Tags the commit and publishes the installer, blockmap and latest.yml as
       a GitHub release of the fork.

    Fork versions encode the upstream version and a fork revision in the patch
    number: upstream 0.3.8, revision 1 -> 0.3.801. They are applied at build
    time only, so package.json keeps upstream's version and merges stay clean.

    The build records the commit it was made from and this checkout's folder
    in its package.json (lhForkCommit, lhForkSource). The app's update button
    (electron/fork-update.cjs) compares that commit with the fork's main and
    runs this script with -ForkOnly -InstalledCommit -StageDir -SkipChecks.

.EXAMPLE
    .\release-windows.ps1 -Install
    Sync, build, install the new build on this computer, then publish.

.EXAMPLE
    .\release-windows.ps1 -ForkOnly -Install
    Release what is on the fork's main, without merging upstream.

.EXAMPLE
    .\release-windows.ps1 -NoPublish
    Build an installer into dist\ without tagging or publishing.
#>
[CmdletBinding()]
param(
    # Do not merge upstream changes first.
    [switch]$NoSync,
    # Bring this checkout to the fork's main instead of merging upstream. When
    # the fork was rewritten on GitHub (rebased onto upstream), the checkout is
    # reset to it; this only runs on a clean checkout.
    [switch]$ForkOnly,
    # Build only: no tag, push or release.
    [switch]$NoPublish,
    # Install the new build silently afterwards (skipped while the app runs).
    [switch]$Install,
    # Build a new release even when nothing changed.
    [switch]$Force,
    # Do not translate new interface text (it stays in English until the next run).
    [switch]$NoTranslate,
    # The fork on GitHub.
    [string]$Repository = 'Kozlvign/learnharness',
    # Write the outcome here as JSON (ok, version, installer, built, commit,
    # staged, message, log). auto-update.ps1 and the app's update button read it.
    [string]$ResultFile,
    # Write the current step here as JSON (step, log), for the update button.
    [string]$ProgressFile,
    # The commit the installed app was built from (the update button passes it).
    # Nothing is built when the installed app already has what main has.
    [string]$InstalledCommit,
    # Copy the packaged app into this folder, beside the installed app, and
    # report it ready before the installer is made and the release published.
    # The update button swaps it in (electron/fork-install.ps1).
    [string]$StageDir,
    # Leave out the type check, the tests and the smoke tests.
    [switch]$SkipChecks
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).ProviderPath
Set-Location -LiteralPath $repo
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
$utf8 = New-Object Text.UTF8Encoding($false)

$logDir = Join-Path $env:LOCALAPPDATA 'LearnHarness-fork\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir ('release-{0:yyyyMMdd-HHmmss}.log' -f (Get-Date))
Start-Transcript -LiteralPath $log | Out-Null

function Step([string]$Text) {
    # The time shows in the log only; the update button maps the step's text.
    Write-Host ''; Write-Host "== $Text ($(Get-Date -Format 'HH:mm:ss'))" -ForegroundColor Cyan
    if ($ProgressFile) {
        try { [IO.File]::WriteAllText($ProgressFile, ([ordered]@{ step = $Text; log = $log } | ConvertTo-Json), $utf8) } catch { }
    }
}
# Windows PowerShell turns a native program's stderr into error records when
# output is redirected; with Stop they would end the script on a mere warning.
# Exit codes decide success instead.
function Native([string]$File, [string[]]$Arguments) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $File @Arguments 2>&1 | ForEach-Object { "$_" } } finally { $ErrorActionPreference = $previous }
    if ($LASTEXITCODE -ne 0) { throw "'$File $($Arguments -join ' ')' failed with exit code $LASTEXITCODE." }
}
function Invoke-Git([string[]]$Arguments) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { $lines = @(& git.exe @Arguments 2>&1) } finally { $ErrorActionPreference = $previous }
    $errors = @($lines | Where-Object { $_ -is [System.Management.Automation.ErrorRecord] } | ForEach-Object { "$_" })
    if ($LASTEXITCODE -ne 0) { throw "'git $($Arguments -join ' ')' failed with exit code $LASTEXITCODE. $($errors -join ' ')" }
    $lines | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] } | ForEach-Object { "$_" }
}
function Invoke-GitStatus([string[]]$Arguments) {
    # For commands whose exit code is the answer (merge): returns the code.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & git.exe @Arguments 2>&1 | ForEach-Object { "$_" } | Out-Host } finally { $ErrorActionPreference = $previous }
    $LASTEXITCODE
}
function Test-Exit([string]$File, [string[]]$Arguments) {
    # Whether a command succeeds, without its output.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $File @Arguments 2>&1 | Out-Null } finally { $ErrorActionPreference = $previous }
    $LASTEXITCODE -eq 0
}
# Whether this checkout has the commit (a rebase of the fork may have dropped it).
function Test-Commit([string]$Revision) { $Revision -match '^[0-9a-fA-F]{40}$' -and (Test-Exit 'git.exe' @('cat-file', '-e', "$Revision^{commit}")) }
# Whether anything that changes the app differs between two commits. The
# fork's own scripts and docs do not change the app.
function Test-AppChanged([string]$From, [string]$To) {
    @(Invoke-Git @('diff', '--name-only', $From, $To) | Where-Object { $_ -and $_ -notmatch '^(scripts/fork/|docs/|README\.md$)' }).Count -gt 0
}

# npm ci takes minutes. It runs only when the lockfile changed since the last
# install that finished here, or node_modules is gone. A plugin's API types
# (its "sdk" script) are a file: dependency, so they are made before its npm ci.
function Install-Dependencies([string]$Directory, [switch]$Sdk) {
    $hash = (Get-FileHash -LiteralPath (Join-Path $Directory 'package-lock.json') -Algorithm SHA256).Hash
    $stamp = Join-Path $Directory 'node_modules\.lh-lock-hash'
    $name = if ($Directory -eq $repo) { 'The app' } else { Split-Path $Directory -Leaf }
    if ((Test-Path -LiteralPath $stamp) -and ([IO.File]::ReadAllText($stamp).Trim() -eq $hash)) {
        Write-Host "${name}: dependencies unchanged, npm ci skipped."
        return
    }
    Push-Location -LiteralPath $Directory
    try {
        if ($Sdk) { Native 'npm' @('run', 'sdk') }
        Native 'npm' @('ci', '--no-audit', '--no-fund')
    } finally { Pop-Location }
    [IO.File]::WriteAllText($stamp, $hash, $utf8)
}

# dist\build.json describes the build in dist\: its version, commit, installer
# and whether it was published. An update cut short leaves it unpublished.
$buildFile = Join-Path $repo 'dist\build.json'
$packaged = Join-Path $repo 'dist\win-unpacked'
function Read-Build {
    try { [IO.File]::ReadAllText($buildFile) | ConvertFrom-Json } catch { $null }
}
function Save-Build($Build) { [IO.File]::WriteAllText($buildFile, ($Build | ConvertTo-Json), $utf8) }

# The installer, made from the packaged app in dist\ (no second packaging).
function New-Installer($Build) {
    Step 'Packaging the installer'
    Native 'npx' @('electron-builder', '--win', 'nsis', '--x64', '--prepackaged', $packaged, '--publish', 'never', "-c.extraMetadata.version=$($Build.version)")
    $installer = Join-Path $repo "dist\LearnHarness-$($Build.version)-x64-setup.exe"
    if (-not (Test-Path -LiteralPath $installer)) { throw "The installer was not produced: $installer" }
    $Build.installer = $installer
    Save-Build $Build
}

function Publish-Build($Build) {
    if (-not $Build.installer -or -not (Test-Path -LiteralPath $Build.installer)) { New-Installer $Build }
    Step 'Publishing'
    $tag = "v$($Build.version)"
    $tagged = $false
    if (-not (Invoke-Git @('tag', '-l', $tag))) {
        Invoke-Git @('tag', '-a', $tag, $Build.commit, '-m', "LearnHarness $($Build.version) (Claude fork of upstream $upstreamVersion)") | Out-Null
        $tagged = $true
    }
    # All or nothing: a main that moved on GitHub during the build leaves
    # no tag without its release behind.
    try { Invoke-Git @('push', '--quiet', '--atomic', 'origin', 'main', $tag) | Out-Null }
    catch {
        if ($tagged) { try { Invoke-Git @('tag', '-d', $tag) | Out-Null } catch { } }
        throw "Nothing was published: pushing main and $tag to GitHub failed. If main moved on GitHub during the build, run the update again. $($_.Exception.Message)"
    }
    if (Test-Exit 'gh' @('release', 'view', $tag, '--repo', $Repository, '--json', 'tagName')) {
        Write-Host "The release $tag is already on GitHub."
    } else {
        $assets = @($Build.installer, "$($Build.installer).blockmap", (Join-Path $repo 'dist\latest.yml'))
        foreach ($asset in $assets) { if (-not (Test-Path -LiteralPath $asset)) { throw "Cannot publish ${tag}: $asset is missing." } }
        $notes = "LearnHarness $upstreamVersion with the Claude connection (Claude models through your own Claude Code sign-in), a Brazilian Portuguese interface and tutor (Settings > General > Language), images in messages (paste, drop or attach them), and local dictation in Portuguese and English with no key (Settings > Providers > Dictation).`n`nThe installed app updates itself from the fork's main with the update button beside Settings. Upstream changes: https://github.com/amosblomqvist/learnharness/releases"
        Native 'gh' (@('release', 'create', $tag) + $assets + @('--repo', $Repository, '--title', "LearnHarness $($Build.version)", '--notes', $notes, '--latest', '--verify-tag'))
        Write-Host "Published https://github.com/$Repository/releases/tag/$tag"
    }
    $Build.published = $true
    Save-Build $Build
}

# Copies the packaged app beside the installed one (same drive, so installing
# is a rename). The marker is written last: a copy cut short is never
# installed.
function Copy-ToStage($Build) {
    Step 'Copying the new version'
    if (-not (Test-Path -LiteralPath (Join-Path $packaged 'LearnHarness.exe'))) { throw "The packaged app is missing: $packaged" }
    $marker = Join-Path $StageDir '.lh-build.json'
    New-Item -ItemType Directory -Force -Path $StageDir | Out-Null
    Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & robocopy.exe $packaged $StageDir /MIR /MT:16 /R:3 /W:1 /NFL /NDL /NJH /NJS /NP 2>&1 | ForEach-Object { "$_" } } finally { $ErrorActionPreference = $previous }
    # robocopy: 0-7 are success (files copied, extras removed), 8 and up failures.
    if ($LASTEXITCODE -ge 8) { throw "Copying the new version to $StageDir failed (robocopy exit code $LASTEXITCODE)." }
    [IO.File]::WriteAllText($marker, ([ordered]@{ version = $Build.version; commit = $Build.commit } | ConvertTo-Json), $utf8)
}

$exitCode = 0
$resultMessage = $null
# Outcome for -ResultFile. With -StageDir it is written as soon as the new
# version is ready to install; the installer and the release come after.
$result = [ordered]@{ ok = $false; version = $null; installer = $null; built = $false; commit = $null; staged = $null; message = $null; log = $log }
$resultWritten = $false
function Write-Result {
    if (-not $ResultFile) { return }
    [IO.File]::WriteAllText($ResultFile, ($result | ConvertTo-Json), $utf8)
    $script:resultWritten = $true
}
# One release at a time on this computer, whichever checkout it runs from:
# two runs would build the same next version and race to publish it.
$releaseLock = New-Object System.Threading.Mutex($false, 'Local\LearnHarness-fork-release')
$haveLock = $false
try {
    try { $haveLock = $releaseLock.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $haveLock = $true }
    if (-not $haveLock) {
        # The run before may still be publishing a version the app already installed.
        Step 'Waiting for the previous update'
        try { $haveLock = $releaseLock.WaitOne([TimeSpan]::FromMinutes(20)) } catch [System.Threading.AbandonedMutexException] { $haveLock = $true }
        if (-not $haveLock) { throw 'Another LearnHarness release is still running on this computer.' }
    }
    foreach ($tool in 'git', 'node', 'npm', 'gh') {
        if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "$tool was not found in PATH." }
    }
    if ((Invoke-Git @('branch', '--show-current')) -ne 'main') { throw 'Check out main first.' }
    # next build rewrites this generated file; it is never a real change.
    Invoke-Git @('checkout', '--', 'next-env.d.ts') | Out-Null
    if (Invoke-Git @('status', '--porcelain', '--untracked-files=no')) { throw 'The working tree has uncommitted changes. Commit or discard them first.' }
    if (-not (Invoke-Git @('remote') | Where-Object { $_ -eq 'upstream' })) { Invoke-Git @('remote', 'add', 'upstream', 'https://github.com/amosblomqvist/learnharness.git') | Out-Null }

    if ($ForkOnly) {
        Step 'Syncing with the fork'
        Invoke-Git @('fetch', '--quiet', 'origin') | Out-Null
        $behind = [int](Invoke-Git @('rev-list', '--count', 'HEAD..origin/main'))
        $ahead = [int](Invoke-Git @('rev-list', '--count', 'origin/main..HEAD'))
        if ($behind -gt 0 -and $ahead -gt 0) {
            # The fork was rewritten on GitHub (rebased onto upstream). The
            # working tree was found clean above; local commits are only
            # translations, which the next step makes again.
            Invoke-Git @('reset', '--quiet', '--hard', 'origin/main') | Out-Null
            Write-Host "The fork's main was rewritten on GitHub. Reset this checkout to it."
        } elseif ($behind -gt 0) {
            Invoke-Git @('merge', '--ff-only', '--quiet', 'origin/main') | Out-Null
            Write-Host "Moved to the fork's main ($behind new commits)."
        } else { Write-Host "Already up to date with the fork's main." }
    } elseif (-not $NoSync) {
        Step 'Syncing with upstream'
        Invoke-Git @('fetch', '--quiet', 'origin') | Out-Null
        Invoke-Git @('fetch', '--quiet', 'upstream') | Out-Null
        $behindOrigin = [int](Invoke-Git @('rev-list', '--count', 'HEAD..origin/main'))
        if ($behindOrigin -gt 0) { Invoke-Git @('merge', '--ff-only', '--quiet', 'origin/main') | Out-Null }
        $behind = [int](Invoke-Git @('rev-list', '--count', 'HEAD..upstream/main'))
        if ($behind -gt 0) {
            if ((Invoke-GitStatus @('merge', '--no-edit', '--quiet', 'upstream/main')) -ne 0) {
                Invoke-GitStatus @('merge', '--abort') | Out-Null
                throw "Upstream has $behind new commits that conflict with the fork. Merge upstream/main by hand, then run this again."
            }
            Write-Host "Merged $behind upstream commits."
        } else { Write-Host 'Already up to date with upstream.' }
    }

    $head = Invoke-Git @('rev-parse', 'HEAD') | Select-Object -First 1
    $upstreamVersion = ((Get-Content -LiteralPath (Join-Path $repo 'package.json') -Raw -Encoding UTF8) | ConvertFrom-Json).version
    if ($upstreamVersion -notmatch '^(\d+)\.(\d+)\.(\d+)$') { throw "Unexpected version '$upstreamVersion' in package.json." }
    $major = [int]$Matches[1]; $minor = [int]$Matches[2]; $base = [int]$Matches[3] * 100
    $revisions = @(Invoke-Git @('tag', '-l', "v$major.$minor.*") | ForEach-Object {
        if ($_ -match "^v$major\.$minor\.(\d+)$") { [int]$Matches[1] - $base }
    } | Where-Object { $_ -ge 1 -and $_ -le 99 })
    $last = ($revisions | Measure-Object -Maximum).Maximum
    $lastTag = if ($last) { "v$major.$minor.$($base + $last)" } else { $null }

    $installed = if ($InstalledCommit -and (Test-Commit $InstalledCommit)) { $InstalledCommit.ToLower() } else { $null }
    # The build still in dist\, when it has what main has: reused, not rebuilt.
    $build = Read-Build
    $reusable = $build -and $build.version -and (Test-Commit "$($build.commit)") -and (Test-Path -LiteralPath (Join-Path $packaged 'LearnHarness.exe')) -and -not (Test-AppChanged $build.commit $head)

    if ($installed -and -not $Force -and -not (Test-AppChanged $installed $head)) {
        Write-Host "The installed app already has everything on the fork's main. Nothing to build."
        $result.ok = $true
        $result.commit = $installed
        Write-Result
        # An update cut short may have left this build unpublished.
        if ($reusable -and -not $build.published -and -not $NoPublish) { Publish-Build $build }
        return
    }
    if ($reusable -and -not $Force) {
        Write-Host "Main has nothing new for the app since the build of $($build.version) in dist\. Reusing it."
    } elseif ($lastTag -and -not $installed -and -not $Force -and -not (Test-AppChanged $lastTag $head)) {
        # By hand (the installed commit is unknown): the last release has it all.
        Write-Host "The app has not changed since $lastTag. No new release is needed."
        $result.ok = $true
        $result.version = $lastTag.Substring(1)
        $result.commit = (Invoke-Git @('rev-parse', "$lastTag^{commit}") | Select-Object -First 1)
        $lastInstaller = Join-Path $repo "dist\LearnHarness-$($result.version)-x64-setup.exe"
        if (Test-Path -LiteralPath $lastInstaller) { $result.installer = $lastInstaller }
        return
    } else {
        $revision = if ($last) { $last + 1 } else { 1 }
        if ($revision -gt 99) { throw "Too many fork releases for upstream $upstreamVersion." }
        $version = "$major.$minor.$($base + $revision)"
        Write-Host "Building LearnHarness $version (upstream $upstreamVersion, fork revision $revision)."

        Step 'Installing dependencies'
        foreach ($path in 'dist', (Join-Path '.next' 'standalone')) { if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Recurse -Force } }
        Install-Dependencies $repo
        if (-not (Test-Path -LiteralPath (Join-Path $repo 'node_modules\electron\dist\electron.exe'))) { Native 'node' @('node_modules/electron/install.js') }
        # The core plugins' own dependencies (@codemirror/*); the build needs
        # them. The same as `npm run plugins:setup`, plugin by plugin.
        foreach ($plugin in Get-ChildItem -LiteralPath (Join-Path $repo 'plugins') -Directory | Sort-Object Name) {
            $manifest = Join-Path $plugin.FullName 'package.json'
            if (-not (Test-Path -LiteralPath $manifest)) { continue }
            if (-not (Test-Path -LiteralPath (Join-Path $plugin.FullName 'package-lock.json'))) { throw "$($plugin.Name): package-lock.json is required for reproducible setup" }
            $scripts = (Get-Content -LiteralPath $manifest -Raw -Encoding UTF8 | ConvertFrom-Json).scripts
            Install-Dependencies $plugin.FullName -Sdk:([bool]($scripts -and $scripts.sdk))
        }

        if (-not $NoTranslate) {
            Step 'Translating new interface text'
            $catalog = 'src/core/i18n/catalog/pt-BR.json'
            try { Native 'npx' @('tsx', 'scripts/fork/i18n/sync.ts') } catch { Write-Host "Some interface text stays in English for now: $($_.Exception.Message)" -ForegroundColor Yellow }
            if (Invoke-Git @('status', '--porcelain', '--', $catalog)) {
                Invoke-Git @('add', '--', $catalog) | Out-Null
                Invoke-Git @('commit', '--quiet', '-m', 'chore(i18n): translate new interface text into Portuguese') | Out-Null
                Write-Host 'Committed the updated Portuguese catalog.'
            }
        }

        if (-not $SkipChecks) {
            Step 'Checking'
            Native 'npx' @('tsc', '--noEmit')
            $env:NODE_ENV = 'test'
            try { Native 'npx' @('tsx', '--test', 'tests/claude-bridge.test.ts', 'tests/claude-migration.test.ts', 'tests/i18n.test.ts', 'tests/images.test.tsx', 'tests/local-dictation.test.tsx', 'tests/evidence.test.ts', 'tests/evidence-server.test.ts', 'tests/evidence-ui.test.tsx', 'tests/anki-core.test.ts', 'tests/anki-server.test.ts', 'tests/anki-pipeline.test.ts', 'tests/anki-tutor.test.ts', 'tests/anki-ui.test.tsx') } finally { Remove-Item Env:NODE_ENV -ErrorAction SilentlyContinue }
        }

        Step 'Building'
        Native 'npm' @('run', 'build')
        if (-not $SkipChecks) { Native 'node' @('scripts/smoke-provider-runtime.mjs') }
        Native 'node' @('scripts/build-server.mjs')
        if (-not $SkipChecks) {
            Native 'node' @('scripts/smoke-server.mjs', '--electron')
            Native 'node' @('scripts/fork/check-dictation-runtime.mjs')
        }
        # The update button compares this commit with the fork's main.
        $commit = Invoke-Git @('rev-parse', 'HEAD') | Select-Object -First 1
        $metadata = @("-c.extraMetadata.version=$version", "-c.extraMetadata.lhForkCommit=$commit", "-c.extraMetadata.lhForkSource=$repo")
        $build = [pscustomobject]@{ version = $version; commit = $commit; installer = $null; published = $false }
        if ($StageDir) {
            # The packaged folder only; the installer is made once the app has it.
            Native 'npx' (@('electron-builder', '--win', '--x64', '--dir', '--publish', 'never') + $metadata)
            if (-not (Test-Path -LiteralPath (Join-Path $packaged 'LearnHarness.exe'))) { throw "The app was not packaged: $packaged" }
        } else {
            Native 'npx' (@('electron-builder', '--win', '--x64', '--publish', 'never') + $metadata)
            $build.installer = Join-Path $repo "dist\LearnHarness-$version-x64-setup.exe"
            if (-not (Test-Path -LiteralPath $build.installer)) { throw "The installer was not produced: $($build.installer)" }
        }
        Save-Build $build
        $result.built = $true
    }

    $result.version = $build.version
    $result.commit = $build.commit
    if ($StageDir) {
        Copy-ToStage $build
        $result.ok = $true
        $result.staged = $StageDir
        Write-Result
        Write-Host "LearnHarness $($build.version) is ready to install."
        if (-not $NoPublish -and -not $build.published) { Publish-Build $build }
    } else {
        if (-not $build.installer -or -not (Test-Path -LiteralPath $build.installer)) { New-Installer $build }
        $result.installer = $build.installer
        if ($Install) {
            Step 'Installing'
            if (Get-Process -Name 'LearnHarness' -ErrorAction SilentlyContinue) {
                Write-Host 'LearnHarness is running, so it was not reinstalled now. Close it and run this again with -Install, or use the update button.' -ForegroundColor Yellow
            } else {
                $process = Start-Process -FilePath $build.installer -ArgumentList '/S' -Wait -PassThru
                if ($process.ExitCode -ne 0) { throw "The installer exited with code $($process.ExitCode)." }
                Write-Host "Installed LearnHarness $($build.version)."
            }
        }
        if (-not $NoPublish -and -not $build.published) { Publish-Build $build }
    }
} catch {
    Write-Host ''
    Write-Host $_.Exception.Message -ForegroundColor Red
    $resultMessage = $_.Exception.Message
    $exitCode = 1
} finally {
    if ($haveLock) { try { & git.exe checkout -- next-env.d.ts 2>$null } catch { } }
    if ($haveLock) { $releaseLock.ReleaseMutex() }
    Write-Host "Finished at $(Get-Date -Format 'HH:mm:ss')."
    Stop-Transcript | Out-Null
    Write-Host "Log: $log"
    # A result written at ready stays: a failure to publish afterwards does not
    # undo a version the app can install. It is in the log, and the next run
    # publishes that build.
    if (-not $resultWritten) {
        $result.ok = ($exitCode -eq 0)
        $result.message = $resultMessage
        Write-Result
    }
}
exit $exitCode

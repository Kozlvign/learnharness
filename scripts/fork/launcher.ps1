<#
.SYNOPSIS
    The desktop icon of the fork's app: opens LearnHarness updated to the
    fork's main.

.DESCRIPTION
    install-update-task.ps1 points the desktop shortcut here, run without a
    console (conhost --headless). On each click:
    1. If the app is open, it brings it forward.
    2. It asks GitHub for the fork's main (6 seconds at most). When main moved
       since the last update run, it starts the update task (auto-update.ps1)
       at once.
    3. While a new version builds, a small window shows the progress. Open now
       skips the wait; closing the window cancels the click.
    4. A version built while the app was open is installed before it opens.
    5. If the last update failed, the app opens and the window says why.
    The window follows the app's interface language. Any problem in here still
    opens the installed app.
    (Saved as UTF-8 with a byte order mark: Windows PowerShell reads files
    without one in the ANSI code page, which would garble the Portuguese text.)
#>
[CmdletBinding()]
param(
    # Where auto-update.ps1 keeps its state and logs.
    [string]$StateDir = (Join-Path $env:LOCALAPPDATA 'LearnHarness-fork'),
    # The installed app.
    [string]$AppExe = (Join-Path $env:LOCALAPPDATA 'Programs\learnharness\LearnHarness.exe'),
    # The scheduled task install-update-task.ps1 registers.
    [string]$TaskName = 'LearnHarness fork update',
    # The app's language setting (src/agent/language.ts).
    [string]$LanguageFile = (Join-Path $env:APPDATA 'LearnHarness\data\language.json')
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).ProviderPath
$stateFile = Join-Path $StateDir 'state.json'
$appName = [IO.Path]::GetFileNameWithoutExtension($AppExe)

$text = @{
    checking = 'Checking for updates…'
    building = 'Updating LearnHarness…'
    buildingDetail = 'Building the latest version from main. This takes about 7 minutes ({0} so far).'
    installing = 'Installing LearnHarness {0}…'
    installingDetail = 'This takes a few seconds.'
    failed = 'LearnHarness could not update'
    failedDetail = '{0} The current version is open.'
    openNow = 'Open now'
    viewLog = 'View log'
}
try {
    if (([IO.File]::ReadAllText($LanguageFile) | ConvertFrom-Json).ui -eq 'pt-BR') {
        $text = @{
            checking = 'Procurando atualizações…'
            building = 'Atualizando o LearnHarness…'
            buildingDetail = 'Gerando a versão mais recente da main. Leva cerca de 7 minutos ({0} até agora).'
            installing = 'Instalando o LearnHarness {0}…'
            installingDetail = 'Leva alguns segundos.'
            failed = 'Não foi possível atualizar o LearnHarness'
            failedDetail = '{0} A versão atual foi aberta.'
            openNow = 'Abrir agora'
            viewLog = 'Ver log'
        }
    }
} catch { }

function Write-LauncherLog([string]$Message) {
    try {
        $dir = Join-Path $StateDir 'logs'
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
        Add-Content -LiteralPath (Join-Path $dir 'launcher.log') -Value ('[{0:o}] {1}' -f (Get-Date), $Message) -Encoding UTF8
    } catch { }
}

function Read-State {
    # auto-update.ps1 replaces the file whole; a read that races it retries.
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        if (-not (Test-Path -LiteralPath $stateFile)) { return $null }
        try { return [IO.File]::ReadAllText($stateFile) | ConvertFrom-Json } catch { Start-Sleep -Milliseconds 100 }
    }
    $null
}

function Get-Time([string]$Value) {
    if (-not $Value) { return $null }
    try { return [datetime]::Parse($Value, $null, [Globalization.DateTimeStyles]::RoundtripKind) } catch { return $null }
}

function Get-Version([string]$Value) {
    if ($Value -match '^(\d+)\.(\d+)\.(\d+)') { return [version]::new([int]$Matches[1], [int]$Matches[2], [int]$Matches[3]) }
    $null
}

function Test-AppRunning { [bool](Get-Process -Name $appName -ErrorAction SilentlyContinue) }

function Test-Running($Id) {
    if (-not $Id) { return $false }
    [bool](Get-Process -Id ([int]$Id) -ErrorAction SilentlyContinue)
}

function Start-App {
    # A second start of the app brings its open window forward.
    if (Test-Path -LiteralPath $AppExe) { Start-Process -FilePath $AppExe -WorkingDirectory (Split-Path -Parent $AppExe) }
}

function Get-RemoteMain {
    try {
        $info = New-Object System.Diagnostics.ProcessStartInfo 'git.exe'
        $info.Arguments = "-C `"$repo`" ls-remote origin refs/heads/main"
        $info.UseShellExecute = $false
        $info.RedirectStandardOutput = $true
        $info.CreateNoWindow = $true
        $info.EnvironmentVariables['GIT_TERMINAL_PROMPT'] = '0'
        $info.EnvironmentVariables['GCM_INTERACTIVE'] = 'never'
        $process = [System.Diagnostics.Process]::Start($info)
        $output = $process.StandardOutput.ReadToEndAsync()
        if (-not $process.WaitForExit(6000)) {
            try { $process.Kill() } catch { }
            return $null
        }
        if ($process.ExitCode -eq 0 -and $output.Result -match '^([0-9a-f]{40})\s') { return $Matches[1] }
    } catch { }
    $null
}

$script:form = $null
$script:openNow = $false
$script:closed = $false
$script:logPath = $null

function New-Window {
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    # Under conhost --headless the title bar's close button (SC_CLOSE) never
    # reaches the form, so the form closes itself on it. It also asks for a
    # dark title bar, like the app's (Windows 11; ignored elsewhere).
    Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;
namespace LearnHarnessFork {
    public class LauncherForm : Form {
        [DllImport("dwmapi.dll")]
        static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);
        protected override void OnHandleCreated(EventArgs e) {
            base.OnHandleCreated(e);
            try { int dark = 1; DwmSetWindowAttribute(Handle, 20, ref dark, 4); } catch (Exception) { }
        }
        protected override void WndProc(ref Message m) {
            if (m.Msg == 0x0112 && ((int)m.WParam & 0xFFF0) == 0xF060) { Close(); return; }
            base.WndProc(ref m);
        }
    }
}
'@
    [System.Windows.Forms.Application]::EnableVisualStyles()
    $foreground = [System.Drawing.Color]::FromArgb(237, 237, 237)
    $button = {
        param([string]$Label, [int]$X)
        $b = New-Object System.Windows.Forms.Button
        $b.Text = $Label
        $b.Location = New-Object System.Drawing.Point($X, 122)
        $b.Size = New-Object System.Drawing.Size(104, 30)
        $b.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
        $b.BackColor = [System.Drawing.Color]::FromArgb(45, 45, 45)
        $b.ForeColor = $foreground
        $b.FlatAppearance.BorderColor = [System.Drawing.Color]::FromArgb(72, 72, 72)
        $b.Visible = $false
        $b
    }
    $form = New-Object LearnHarnessFork.LauncherForm
    $form.SuspendLayout()
    $form.Text = 'LearnHarness'
    $form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedSingle
    $form.MaximizeBox = $false
    $form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
    $form.BackColor = [System.Drawing.Color]::FromArgb(23, 23, 23)
    $form.ForeColor = $foreground
    $form.Font = New-Object System.Drawing.Font('Segoe UI', 9.75)
    try { $form.Icon = [System.Drawing.Icon]::ExtractAssociatedIcon($AppExe) } catch { }

    $title = New-Object System.Windows.Forms.Label
    $title.Location = New-Object System.Drawing.Point(20, 18)
    $title.Size = New-Object System.Drawing.Size(420, 28)
    $title.Font = New-Object System.Drawing.Font('Segoe UI Semibold', 12)
    $detail = New-Object System.Windows.Forms.Label
    $detail.Location = New-Object System.Drawing.Point(20, 52)
    $detail.Size = New-Object System.Drawing.Size(420, 62)
    $detail.ForeColor = [System.Drawing.Color]::FromArgb(163, 163, 163)
    $open = & $button $text.openNow 336
    $log = & $button $text.viewLog 222
    $open.Add_Click({ $script:openNow = $true })
    $log.Add_Click({ if ($script:logPath) { Start-Process -FilePath $script:logPath } })
    $form.Add_FormClosed({ $script:closed = $true })
    $form.Controls.AddRange(@($title, $detail, $open, $log))
    # Sizes above are for 96 DPI; scale them to the screen.
    $form.AutoScaleDimensions = New-Object System.Drawing.SizeF(96, 96)
    $form.AutoScaleMode = [System.Windows.Forms.AutoScaleMode]::Dpi
    $form.ClientSize = New-Object System.Drawing.Size(460, 168)
    $form.ResumeLayout($false)

    $script:form = $form
    $script:titleLabel = $title
    $script:detailLabel = $detail
    $script:openButton = $open
    $script:logButton = $log
    # View log takes the right-hand slot when Open now is hidden.
    $script:logLeft = @{ $true = $log.Left; $false = $open.Left }
    $form.Show()
    $form.Activate()
}

function Show-Window([string]$Title, [string]$Detail, [switch]$OpenNow, [string]$Log) {
    if (-not $script:form) { New-Window }
    $script:titleLabel.Text = $Title
    $script:detailLabel.Text = $Detail
    $script:openButton.Visible = [bool]$OpenNow
    $script:logPath = $Log
    $script:logButton.Left = $script:logLeft[[bool]$OpenNow]
    $script:logButton.Visible = [bool]$Log
    [System.Windows.Forms.Application]::DoEvents()
}

function Wait-Window([int]$Milliseconds) {
    $until = (Get-Date).AddMilliseconds($Milliseconds)
    while ((Get-Date) -lt $until -and -not $script:openNow -and -not $script:closed) {
        if ($script:form) { [System.Windows.Forms.Application]::DoEvents() }
        Start-Sleep -Milliseconds 50
    }
}

$launch = $true
try {
    if (Test-AppRunning) { return }
    $clicked = Get-Date
    $remote = Get-RemoteMain
    $lastTrigger = $null
    $triggers = 0
    while ($true) {
        if ($script:closed) { $launch = $false; return }
        if ($script:openNow) { return }
        $state = Read-State
        if ($state -and $state.status -eq 'building' -and (Test-Running $state.pid)) {
            $since = Get-Time $state.started
            if (-not $since) { $since = $clicked }
            $seconds = [int][Math]::Max(0, ((Get-Date) - $since).TotalSeconds)
            $elapsed = '{0}:{1:00}' -f [int][Math]::Floor($seconds / 60), ($seconds % 60)
            Show-Window $text.building ($text.buildingDetail -f $elapsed) -OpenNow
            Wait-Window 1000
            continue
        }
        if ($remote -and -not ($state -and $state.origin -eq $remote)) {
            $finished = if ($state) { Get-Time $state.finished } else { $null }
            if ($lastTrigger -and $finished -and $finished -gt $lastTrigger) {
                # A run finished since the click; main may have moved during it.
                $remote = Get-RemoteMain
                $lastTrigger = $null
                $triggers = 0
                continue
            }
            # No update task (not set up, or removed): open what is installed.
            $running = $false
            try { $running = (Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop).State -eq 'Running' } catch { break }
            if (-not $running) {
                # A run already going when main moved may have fetched before it.
                if ($triggers -ge 3) { break }
                if (-not $lastTrigger -or ((Get-Date) - $lastTrigger).TotalSeconds -ge 10) {
                    Start-ScheduledTask -TaskName $TaskName
                    $lastTrigger = Get-Date
                    $triggers++
                }
            }
            if (((Get-Date) - $clicked).TotalSeconds -ge 1.5) { Show-Window $text.checking '' -OpenNow }
            Wait-Window 500
            continue
        }
        break
    }

    $state = Read-State
    if ($state -and $state.status -eq 'failed' -and (-not $remote -or $state.origin -eq $remote)) {
        $launch = $false
        Start-App
        Show-Window $text.failed ($text.failedDetail -f $state.message) -Log $state.log
        Wait-Window 8000
        return
    }
    if ($state -and $state.installer -and (Test-Path -LiteralPath $state.installer) -and -not (Test-AppRunning)) {
        $ready = Get-Version $state.version
        $installed = $null
        if (Test-Path -LiteralPath $AppExe) { $installed = Get-Version (Get-Item -LiteralPath $AppExe).VersionInfo.ProductVersion }
        if ($ready -and (-not $installed -or $ready -gt $installed)) {
            Show-Window ($text.installing -f $state.version) $text.installingDetail
            $script:form.ControlBox = $false
            # Run a copy: a build starting meanwhile empties dist\.
            $setup = Join-Path $env:TEMP 'LearnHarness-fork-setup.exe'
            Copy-Item -LiteralPath $state.installer -Destination $setup -Force
            # The installer keeps the desktop shortcut (KeepShortcuts) and does
            # not start the app when silent.
            $process = Start-Process -FilePath $setup -ArgumentList '/S' -PassThru
            while (-not $process.HasExited) {
                [System.Windows.Forms.Application]::DoEvents()
                Start-Sleep -Milliseconds 100
            }
            if ($process.ExitCode -ne 0) { Write-LauncherLog "The installer $($state.installer) exited with code $($process.ExitCode)." }
            Remove-Item -LiteralPath $setup -Force -ErrorAction SilentlyContinue
        }
    }
} catch {
    Write-LauncherLog "$($_.Exception.Message) $($_.InvocationInfo.PositionMessage)"
} finally {
    if ($launch) { Start-App }
    if ($script:form) { $script:form.Close(); $script:form.Dispose() }
}

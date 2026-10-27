<#
.SYNOPSIS
    Compiles the desktop launcher (launcher.cs) into
    %LOCALAPPDATA%\LearnHarness-fork\launcher\LearnHarness Launcher.exe.

.DESCRIPTION
    Uses the C# compiler that ships with Windows (.NET Framework 4), with the
    app's icon. install-update-task.ps1 runs it once; auto-update.ps1 runs it
    with -IfChanged after each update, so changes to launcher.cs reach the
    desktop icon. While the launcher runs its file is locked, and the next
    update replaces it.
#>
[CmdletBinding()]
param(
    [string]$OutDir = (Join-Path $env:LOCALAPPDATA 'LearnHarness-fork\launcher'),
    # Compile only when launcher.cs changed since the last build.
    [switch]$IfChanged
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).ProviderPath
$source = Join-Path $PSScriptRoot 'launcher.cs'
$icon = Join-Path $repo 'build\icon.ico'
$exe = Join-Path $OutDir 'LearnHarness Launcher.exe'
$stamp = Join-Path $OutDir 'launcher.cs.sha256'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$hash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
if ($IfChanged -and (Test-Path -LiteralPath $exe) -and (Test-Path -LiteralPath $stamp) -and ([IO.File]::ReadAllText($stamp).Trim() -eq $hash)) { return }

$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $csc)) { throw "The C# compiler of .NET Framework 4 is missing: $csc" }
$temp = Join-Path $OutDir 'launcher.new.exe'
$previous = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
    $output = @(& $csc /nologo /target:winexe /optimize+ /codepage:65001 "/win32icon:$icon" "/out:$temp" `
        /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll `
        /reference:System.Core.dll /reference:Microsoft.CSharp.dll $source 2>&1 | ForEach-Object { "$_" })
} finally { $ErrorActionPreference = $previous }
if ($LASTEXITCODE -ne 0) { throw "The launcher did not compile: $($output -join ' ')" }
Move-Item -LiteralPath $temp -Destination $exe -Force
[IO.File]::WriteAllText($stamp, $hash)
Write-Host "Built $exe"

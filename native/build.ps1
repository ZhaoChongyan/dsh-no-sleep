# Builds the native helper for the no-sleep plugin.
#
#   no-sleep.dll  the helper; the Host half loads it in-process
#
# The compiled DLL is deployed under %USERPROFILE%\.dsh\lib\native\ as its own
# folder, which is where the plugin looks. It is never built inside the plugin
# directory: an in-process load locks the file until the Harness restarts, so a
# fresh folder per build keeps rebuilds possible while a Host is running.
#
#   PowerShell -File build.ps1            # compile + deploy
#   PowerShell -File build.ps1 -NoDeploy  # compile only
param(
  [switch]$NoDeploy,
  [string]$OutDir = ''
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$source = Join-Path $here 'no-sleep.cs'

if (-not $OutDir) { $OutDir = Join-Path $here 'out' }
if (Test-Path -LiteralPath $OutDir) { Remove-Item -LiteralPath $OutDir -Recurse -Force }
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
$dll = Join-Path $OutDir 'no-sleep.dll'

Add-Type -Path $source -OutputAssembly $dll -OutputType Library

# Smoke test: the helper must load here and report what Windows answered.
$bytes = [System.IO.File]::ReadAllBytes($dll)
[void][System.Reflection.Assembly]::Load($bytes)
Write-Host "Query()  -> $([KeepAwake.NoSleep]::Query())"
$startError = [KeepAwake.NoSleep]::Begin('display', 'no-sleep build smoke test')
if ($startError) { throw "Begin failed: $startError" }
Start-Sleep -Milliseconds 400
$held = ([KeepAwake.NoSleep]::Query() -match '"active":true')
Write-Host "Windows confirmed the hold: $held"
$endError = [KeepAwake.NoSleep]::End('no-sleep build smoke test')
if ($endError) { throw "End failed: $endError" }
if (-not $held) { throw 'SetThreadExecutionState was not confirmed' }

if (-not $NoDeploy) {
  $target = Join-Path $env:USERPROFILE '.dsh\lib\native'
  New-Item -ItemType Directory -Path $target -Force | Out-Null
  $folder = Join-Path $target ('no-sleep-' + (Get-Date -Format 'yyyyMMddHHmmssfff'))
  New-Item -ItemType Directory -Path $folder -Force | Out-Null
  Copy-Item -LiteralPath $dll -Destination (Join-Path $folder 'no-sleep.dll')
  Write-Host "Deployed -> $folder"
}


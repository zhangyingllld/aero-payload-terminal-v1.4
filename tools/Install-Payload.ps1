param(
    [Parameter(Mandatory=$true)][string]$HdcPath,
    [Parameter(Mandatory=$true)][string]$Target,
    [switch]$Check,
    [switch]$Connect
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $HdcPath -PathType Leaf)) { throw 'HdcPath must name an existing hdc.exe.' }
$python = Get-Command python.exe -ErrorAction SilentlyContinue
if (-not $python) { throw 'Python 3.10+ is required. Verify python --version before deployment.' }
$deployArgs = @((Join-Path $PSScriptRoot 'deploy.py'), 'install', '--hdc', (Resolve-Path -LiteralPath $HdcPath).Path, '--target', $Target)
if ($Check) { $deployArgs += '--check' }
if ($Connect) { $deployArgs += '--connect' }
& $python.Source @deployArgs
if ($LASTEXITCODE -ne 0) { throw 'Deployment stopped. Read STOP above; do not continue with later steps.' }

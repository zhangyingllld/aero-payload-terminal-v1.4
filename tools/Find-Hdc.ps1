# Search the current user's files; do not assume a developer's installation path.
param([string]$SearchRoot = $env:USERPROFILE)
$ErrorActionPreference = 'Stop'
$found = @()
$onPath = Get-Command hdc.exe -ErrorAction SilentlyContinue
if ($onPath) { $found += $onPath.Source }
if (-not (Test-Path -LiteralPath $SearchRoot -PathType Container)) { throw "SearchRoot does not exist: $SearchRoot" }
Write-Host "Searching for hdc.exe under $SearchRoot (may take a minute)..."
$found += Get-ChildItem -LiteralPath $SearchRoot -Filter hdc.exe -File -Recurse -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName
$found | Sort-Object -Unique
Write-Host 'Copy one actual full path above into $Hdc, then run: & $Hdc version'

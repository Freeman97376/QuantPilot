[CmdletBinding()]
param(
  [string]$RepositoryRoot = ''
)

$ErrorActionPreference = 'Stop'
if (-not $RepositoryRoot) {
  $RepositoryRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
}
$principal = New-Object Security.Principal.WindowsPrincipal(
  [Security.Principal.WindowsIdentity]::GetCurrent()
)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run this script from an elevated PowerShell window.'
}

$repo = [System.IO.Path]::GetFullPath($RepositoryRoot).TrimEnd('\')
$target = [System.IO.Path]::GetFullPath((Join-Path $repo 'services\market-data\.pytest_cache'))
$repoPrefix = $repo + '\'
if (-not $target.StartsWith($repoPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to operate outside the repository: $target"
}
if ([System.IO.Path]::GetFileName($target) -ne '.pytest_cache') {
  throw "Refusing unexpected cache target: $target"
}

if (Test-Path -LiteralPath $target) {
  & takeown.exe /F $target /R /D Y | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "takeown failed for $target" }
  & icacls.exe $target /grant:r "${env:USERNAME}:(OI)(CI)F" /T /C | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "icacls failed for $target" }
  Remove-Item -LiteralPath $target -Recurse -Force
}

if (Test-Path -LiteralPath $target) {
  throw "Cache directory still exists: $target"
}
Write-Host "Generated pytest cache removed: $target"

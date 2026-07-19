[CmdletBinding()]
param(
  [string]$DistDirectory = '',
  [string]$ExpectedPublisher = $env:AZURE_SIGNING_PUBLISHER_NAME,
  [string]$ExpectedVersion = '',
  [switch]$AllowUnsigned
)

$ErrorActionPreference = 'Stop'
if (-not $DistDirectory) {
  $DistDirectory = Join-Path $PSScriptRoot '..\..\dist'
}
$dist = (Resolve-Path -LiteralPath $DistDirectory).Path
if (-not $ExpectedVersion) {
  $packagePath = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..\package.json')).Path
  $ExpectedVersion = [string](Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json).version
}
$installerPath = Join-Path $dist "QuantPilot Setup $ExpectedVersion.exe"
if (-not (Test-Path -LiteralPath $installerPath -PathType Leaf)) {
  throw "Expected QuantPilot installer was not found: $installerPath"
}
$installer = Get-Item -LiteralPath $installerPath
$unexpectedInstallers = @(Get-ChildItem -LiteralPath $dist -File -Filter 'QuantPilot Setup *.exe' |
  Where-Object { $_.FullName -ne $installer.FullName })
if ($unexpectedInstallers.Count -gt 0) {
  throw "Unexpected QuantPilot installers found: $($unexpectedInstallers.Name -join ', ')"
}

$required = @(
  $installer.FullName,
  (Join-Path $dist 'win-unpacked\QuantPilot.exe'),
  (Join-Path $dist 'win-unpacked\resources\sidecar\quantpilot-market-data.exe'),
  (Join-Path $dist 'latest.yml'),
  ($installer.FullName + '.blockmap')
)
foreach ($file in $required) {
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing release artifact: $file" }
}

$executables = $required | Where-Object { [System.IO.Path]::GetExtension($_) -eq '.exe' }
$signatures = foreach ($file in $executables) {
  $signature = Get-AuthenticodeSignature -LiteralPath $file
  if (-not $AllowUnsigned) {
    if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
      throw "Invalid Authenticode signature for $file`: $($signature.Status)"
    }
    if (-not $signature.TimeStamperCertificate) {
      throw "Missing trusted timestamp for $file"
    }
    if ($ExpectedPublisher -and $signature.SignerCertificate.Subject -notlike "*$ExpectedPublisher*") {
      throw "Unexpected publisher for $file`: $($signature.SignerCertificate.Subject)"
    }
  }
  [pscustomobject]@{
    File = $file
    Status = $signature.Status.ToString()
    Publisher = if ($signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { '' }
    Timestamped = [bool]$signature.TimeStamperCertificate
  }
}

$standalone = Join-Path $dist 'win-unpacked\resources\standalone'
$forbidden = @(Get-ChildItem -LiteralPath $standalone -Recurse -Force -File |
  Where-Object { $_.Name -match '^\.env(?:\.|$)' })
if ($forbidden.Count -gt 0) {
  throw "Packaged standalone contains forbidden environment files: $($forbidden.FullName -join ', ')"
}

$safeInstallerName = "QuantPilot-Setup-$ExpectedVersion.exe"
$safeBlockmapName = "$safeInstallerName.blockmap"
$latestPath = Join-Path $dist 'latest.yml'
$latestContent = Get-Content -LiteralPath $latestPath -Raw
$expectedLatestPath = '^path:\s*' + [regex]::Escape($safeInstallerName) + '\s*$'
if ($latestContent -notmatch "(?m)$expectedLatestPath") {
  throw "latest.yml does not reference the expected GitHub asset: $safeInstallerName"
}

$releaseDirectory = Join-Path $dist 'release-assets'
New-Item -ItemType Directory -Path $releaseDirectory -Force | Out-Null
$publishInstaller = Join-Path $releaseDirectory $safeInstallerName
$publishBlockmap = Join-Path $releaseDirectory $safeBlockmapName
$publishLatest = Join-Path $releaseDirectory 'latest.yml'
Copy-Item -LiteralPath $installer.FullName -Destination $publishInstaller -Force
Copy-Item -LiteralPath ($installer.FullName + '.blockmap') -Destination $publishBlockmap -Force
Copy-Item -LiteralPath $latestPath -Destination $publishLatest -Force

$hashTargets = @($publishInstaller, $publishBlockmap, $publishLatest)
$hashLines = foreach ($file in $hashTargets) {
  $hash = Get-FileHash -LiteralPath $file -Algorithm SHA256
  "$($hash.Hash)  $([System.IO.Path]::GetFileName($file))"
}
$hashFile = Join-Path $releaseDirectory 'SHA256SUMS.txt'
Set-Content -LiteralPath $hashFile -Value $hashLines -Encoding ascii

[pscustomobject]@{
  Installer = $installer.FullName
  Signatures = $signatures
  ForbiddenEnvironmentFiles = $forbidden.Count
  PublishInstaller = $publishInstaller
  PublishBlockmap = $publishBlockmap
  HashFile = $hashFile
} | ConvertTo-Json -Depth 5

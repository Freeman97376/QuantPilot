[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$CurrentInstaller,
  [string]$PreviousInstaller = '',
  [string]$TestRoot = (Join-Path ([System.IO.Path]::GetTempPath()) ("quantpilot-installer-test-" + [Guid]::NewGuid().ToString('N'))),
  [int]$TimeoutSeconds = 75
)

$ErrorActionPreference = 'Stop'
$current = (Resolve-Path -LiteralPath $CurrentInstaller).Path
$previous = if ($PreviousInstaller) { (Resolve-Path -LiteralPath $PreviousInstaller).Path } else { '' }
$localAppData = Join-Path $TestRoot 'LocalAppData'
$installRoot = Join-Path $localAppData 'Programs\QuantPilot'
$dataRoot = Join-Path $localAppData 'QuantPilot'
New-Item -ItemType Directory -Path $localAppData -Force | Out-Null

$saved = @{
  LOCALAPPDATA = $env:LOCALAPPDATA
  QUANTPILOT_DISABLE_AUTO_UPDATE = $env:QUANTPILOT_DISABLE_AUTO_UPDATE
  QUANTPILOT_MARKET_API_URL = $env:QUANTPILOT_MARKET_API_URL
}

function Restore-Environment {
  foreach ($entry in $saved.GetEnumerator()) {
    if ($null -eq $entry.Value) {
      Remove-Item -Path ("Env:" + $entry.Key) -ErrorAction SilentlyContinue
    } else {
      Set-Item -Path ("Env:" + $entry.Key) -Value $entry.Value
    }
  }
}

function Get-TestProcesses {
  @(Get-CimInstance Win32_Process | Where-Object {
    $_.ExecutablePath -and $_.ExecutablePath.StartsWith($installRoot, [System.StringComparison]::OrdinalIgnoreCase)
  })
}

function Stop-TestProcesses {
  Get-TestProcesses | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2
  $remaining = Get-TestProcesses
  if ($remaining.Count -gt 0) { throw "Installer test left $($remaining.Count) process(es) running." }
}

function Install-Package([string]$installer) {
  $env:LOCALAPPDATA = $localAppData
  # NSIS remembers the last installation directory in the registry. Setting
  # LOCALAPPDATA alone is therefore not enough to isolate an upgrade smoke
  # test on a workstation that already has QuantPilot installed. /D must be
  # the final NSIS argument and explicitly pins the installation to TestRoot.
  $process = Start-Process -FilePath $installer -ArgumentList ("/S /D=" + $installRoot) `
    -WindowStyle Hidden -PassThru -Wait
  Restore-Environment
  if ($process.ExitCode -ne 0) { throw "Installer exited with code $($process.ExitCode): $installer" }
  $exe = Join-Path $installRoot 'QuantPilot.exe'
  if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw "Installed executable was not found: $exe" }
  return $exe
}

function Start-And-Verify([string]$exe) {
  $stdout = Join-Path $TestRoot ('app-' + [Guid]::NewGuid().ToString('N') + '.stdout.log')
  $stderr = Join-Path $TestRoot ('app-' + [Guid]::NewGuid().ToString('N') + '.stderr.log')
  $env:LOCALAPPDATA = $localAppData
  $env:QUANTPILOT_DISABLE_AUTO_UPDATE = '1'
  Remove-Item Env:QUANTPILOT_MARKET_API_URL -ErrorAction SilentlyContinue
  $process = Start-Process -FilePath $exe -WorkingDirectory $installRoot -WindowStyle Hidden `
    -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
  Restore-Environment
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $required = @('app.db', 'market.duckdb', 'installation-id')
  do {
    Start-Sleep -Milliseconds 500
    if ($process.HasExited) { throw "Installed QuantPilot exited with code $($process.ExitCode)." }
    $ready = $true
    foreach ($name in $required) {
      if (-not (Test-Path -LiteralPath (Join-Path $dataRoot $name) -PathType Leaf)) { $ready = $false }
    }
  } while (-not $ready -and (Get-Date) -lt $deadline)
  if (-not $ready) { throw "Installed QuantPilot did not initialize within $TimeoutSeconds seconds." }
  Stop-TestProcesses
}

$beforeInstallationId = $null
$beforeDatabaseLength = 0
$marker = Join-Path $dataRoot 'workspaces\release-upgrade-marker.txt'
$uninstaller = $null
try {
  if ($previous) {
    $previousExe = Install-Package $previous
    Start-And-Verify $previousExe
    $beforeInstallationId = [System.IO.File]::ReadAllText((Join-Path $dataRoot 'installation-id')).Trim()
    $beforeDatabaseLength = (Get-Item -LiteralPath (Join-Path $dataRoot 'app.db')).Length
    New-Item -ItemType Directory -Path (Split-Path -Parent $marker) -Force | Out-Null
    Set-Content -LiteralPath $marker -Value 'preserve-across-upgrade' -Encoding utf8
  }

  $currentExe = Install-Package $current
  Start-And-Verify $currentExe
  $afterInstallationId = [System.IO.File]::ReadAllText((Join-Path $dataRoot 'installation-id')).Trim()
  $afterDatabaseLength = (Get-Item -LiteralPath (Join-Path $dataRoot 'app.db')).Length
  if ($previous) {
    if ($afterInstallationId -ne $beforeInstallationId) { throw 'Upgrade replaced the installation identity.' }
    if ($afterDatabaseLength -le 0 -or $beforeDatabaseLength -le 0) { throw 'Upgrade database validation failed.' }
    if (-not (Test-Path -LiteralPath $marker -PathType Leaf)) { throw 'Upgrade removed the workspace marker.' }
  }

  $uninstaller = Get-ChildItem -LiteralPath $installRoot -File -Filter 'Uninstall *.exe' | Select-Object -First 1
  [pscustomobject]@{
    Installer = $current
    PreviousInstaller = $previous
    ProductVersion = (Get-Item -LiteralPath $currentExe).VersionInfo.ProductVersion
    InstallationIdPreserved = if ($previous) { $afterInstallationId -eq $beforeInstallationId } else { $true }
    DatabasePresent = $afterDatabaseLength -gt 0
    WorkspaceMarkerPreserved = if ($previous) { Test-Path -LiteralPath $marker } else { $true }
    TestRoot = $TestRoot
  } | ConvertTo-Json -Depth 4
} finally {
  Restore-Environment
  Stop-TestProcesses
  if ($uninstaller -and (Test-Path -LiteralPath $uninstaller.FullName -PathType Leaf)) {
    $env:LOCALAPPDATA = $localAppData
    Start-Process -FilePath $uninstaller.FullName -ArgumentList '/S' -WindowStyle Hidden -Wait
    Restore-Environment
  }
}

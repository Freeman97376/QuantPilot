[CmdletBinding()]
param(
  [string]$BuildRoot = '',
  [int]$TimeoutSeconds = 60
)

$ErrorActionPreference = 'Stop'
if (-not $BuildRoot) {
  $BuildRoot = Join-Path $PSScriptRoot '..\..\dist\win-unpacked'
}
$build = (Resolve-Path -LiteralPath $BuildRoot).Path.TrimEnd('\')
$mainExe = Join-Path $build 'QuantPilot.exe'
$sidecarExe = Join-Path $build 'resources\sidecar\quantpilot-market-data.exe'
if (-not (Test-Path -LiteralPath $mainExe -PathType Leaf)) { throw "Missing desktop executable: $mainExe" }
if (-not (Test-Path -LiteralPath $sidecarExe -PathType Leaf)) { throw "Missing sidecar executable: $sidecarExe" }

$smokeRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("quantpilot-desktop-smoke-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $smokeRoot -Force | Out-Null
$stdoutPath = Join-Path $smokeRoot 'stdout.log'
$stderrPath = Join-Path $smokeRoot 'stderr.log'
$saved = @{
  LOCALAPPDATA = $env:LOCALAPPDATA
  ELECTRON_ENABLE_LOGGING = $env:ELECTRON_ENABLE_LOGGING
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

function Get-SmokeProcesses {
  @(Get-CimInstance Win32_Process | Where-Object {
    $_.ExecutablePath -and $_.ExecutablePath.StartsWith($build, [System.StringComparison]::OrdinalIgnoreCase)
  })
}

function Stop-SmokeProcesses {
  Get-SmokeProcesses | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2
  $remaining = Get-SmokeProcesses
  if ($remaining.Count -gt 0) {
    throw "Desktop smoke left $($remaining.Count) process(es) running."
  }
}

try {
  $env:LOCALAPPDATA = $smokeRoot
  $env:ELECTRON_ENABLE_LOGGING = '1'
  $env:QUANTPILOT_DISABLE_AUTO_UPDATE = '1'
  Remove-Item Env:QUANTPILOT_MARKET_API_URL -ErrorAction SilentlyContinue
  $main = Start-Process -FilePath $mainExe -WorkingDirectory $build -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru
  Restore-Environment

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $webPort = $null
  $listeners = @()
  while ((Get-Date) -lt $deadline -and -not $webPort) {
    Start-Sleep -Milliseconds 500
    if ($main.HasExited) { throw "QuantPilot exited during startup with code $($main.ExitCode)." }
    $processes = Get-SmokeProcesses
    $pids = @($processes.ProcessId)
    if ($pids.Count -eq 0) { continue }
    $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
      Where-Object { $pids -contains $_.OwningProcess } |
      Sort-Object LocalPort)
    foreach ($listener in $listeners) {
      $status = & curl.exe --max-time 3 --silent --output NUL --write-out '%{http_code}' `
        ("http://127.0.0.1:{0}/" -f $listener.LocalPort)
      if ($LASTEXITCODE -eq 0 -and $status -eq '200') {
        $webPort = $listener.LocalPort
        break
      }
    }
  }
  if (-not $webPort) { throw "Desktop web server did not return HTTP 200 within $TimeoutSeconds seconds." }

  $dataRoot = Join-Path $smokeRoot 'QuantPilot'
  $requiredData = @('app.db', 'market.duckdb', 'installation-id')
  foreach ($name in $requiredData) {
    $file = Join-Path $dataRoot $name
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing desktop data file: $file" }
  }
  $processCount = (Get-SmokeProcesses).Count
  Stop-SmokeProcesses
  $stdout = if (Test-Path -LiteralPath $stdoutPath) {
    [System.IO.File]::ReadAllText($stdoutPath)
  } else { '' }
  if ($stdout -notmatch 'GET /health HTTP/1\.1" 200') {
    throw 'Sidecar authenticated health check was not observed in the startup log.'
  }

  $bootstrapSmokeScript = Join-Path $PSScriptRoot 'smoke-windows-bootstrap-resume.ps1'
  $resumeSmoke = & $bootstrapSmokeScript -BuildRoot $build -LocalAppDataRoot $smokeRoot -TimeoutSeconds $TimeoutSeconds

  [pscustomobject]@{
    MainProcessId = $main.Id
    ProcessCount = $processCount
    WebPort = $webPort
    ListenerPorts = @($listeners.LocalPort)
    DataRoot = $dataRoot
    OfflineUpdateCheckDisabled = $true
    BootstrapResume = $resumeSmoke
  } | ConvertTo-Json -Depth 4
} finally {
  Restore-Environment
  Stop-SmokeProcesses
}

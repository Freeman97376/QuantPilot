[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$BuildRoot,
  [Parameter(Mandatory = $true)]
  [string]$LocalAppDataRoot,
  [int]$TimeoutSeconds = 90
)

$ErrorActionPreference = 'Stop'
$build = (Resolve-Path -LiteralPath $BuildRoot).Path.TrimEnd([char]92)
$mainExe = Join-Path $build 'QuantPilot.exe'
$mockScript = Join-Path $PSScriptRoot 'mock-eastmoney-catalog.js'
if (-not (Test-Path -LiteralPath $mainExe -PathType Leaf)) {
  throw "Missing desktop executable: $mainExe"
}
if (-not (Test-Path -LiteralPath $mockScript -PathType Leaf)) {
  throw "Missing EastMoney smoke mock: $mockScript"
}

$statePath = Join-Path $LocalAppDataRoot 'eastmoney-smoke-state.txt'
$mockStdout = Join-Path $LocalAppDataRoot 'eastmoney-smoke.stdout.log'
$mockStderr = Join-Path $LocalAppDataRoot 'eastmoney-smoke.stderr.log'
$mockProcess = $null
$currentMain = $null
$smokeToken = [Guid]::NewGuid().ToString('N')
$saved = @{
  LOCALAPPDATA = $env:LOCALAPPDATA
  ELECTRON_ENABLE_LOGGING = $env:ELECTRON_ENABLE_LOGGING
  QUANTPILOT_DISABLE_AUTO_UPDATE = $env:QUANTPILOT_DISABLE_AUTO_UPDATE
  QUANTPILOT_MARKET_API_URL = $env:QUANTPILOT_MARKET_API_URL
  EASTMONEY_BASE_URLS = $env:EASTMONEY_BASE_URLS
  QUANTPILOT_DESKTOP_SMOKE_TEST = $env:QUANTPILOT_DESKTOP_SMOKE_TEST
  QUANTPILOT_LAUNCH_TOKEN = $env:QUANTPILOT_LAUNCH_TOKEN
  NO_PROXY = $env:NO_PROXY
}

function Restore-SmokeEnvironment {
  foreach ($entry in $saved.GetEnumerator()) {
    if ($null -eq $entry.Value) {
      Remove-Item -Path ("Env:" + $entry.Key) -ErrorAction SilentlyContinue
    } else {
      Set-Item -Path ("Env:" + $entry.Key) -Value $entry.Value
    }
  }
}

function Get-PackagedProcesses {
  @(Get-CimInstance Win32_Process | Where-Object {
    $_.ExecutablePath -and $_.ExecutablePath.StartsWith(
      $build,
      [System.StringComparison]::OrdinalIgnoreCase
    )
  })
}

function Stop-PackagedProcesses {
  Get-PackagedProcesses | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Milliseconds 750
  $remaining = Get-PackagedProcesses
  if ($remaining.Count -gt 0) {
    throw "Bootstrap smoke left $($remaining.Count) packaged process(es) running."
  }
}

function Get-FreeLoopbackPort {
  $listener = [System.Net.Sockets.TcpListener]::new(
    [System.Net.IPAddress]::Loopback,
    0
  )
  $listener.Start()
  try {
    return ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
  } finally {
    $listener.Stop()
  }
}

function Start-PackagedApp([string]$Phase, [string]$MockBaseUrl) {
  $stdoutPath = Join-Path $LocalAppDataRoot ("bootstrap-" + $Phase + ".stdout.log")
  $stderrPath = Join-Path $LocalAppDataRoot ("bootstrap-" + $Phase + ".stderr.log")
  $env:LOCALAPPDATA = $LocalAppDataRoot
  $env:ELECTRON_ENABLE_LOGGING = '1'
  $env:QUANTPILOT_DISABLE_AUTO_UPDATE = '1'
  $env:EASTMONEY_BASE_URLS = $MockBaseUrl
  $env:QUANTPILOT_DESKTOP_SMOKE_TEST = '1'
  $env:QUANTPILOT_LAUNCH_TOKEN = $smokeToken
  $env:NO_PROXY = '127.0.0.1,localhost'
  Remove-Item Env:QUANTPILOT_MARKET_API_URL -ErrorAction SilentlyContinue
  try {
    return Start-Process -FilePath $mainExe -WorkingDirectory $build -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru
  } finally {
    Restore-SmokeEnvironment
  }
}

function Wait-ForWebPort($MainProcess) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    $MainProcess.Refresh()
    if ($MainProcess.HasExited) {
      throw "QuantPilot exited during bootstrap smoke with code $($MainProcess.ExitCode)."
    }
    $pids = @(Get-PackagedProcesses | Select-Object -ExpandProperty ProcessId)
    if ($pids.Count -eq 0) {
      continue
    }
    $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
      Where-Object { $pids -contains $_.OwningProcess } |
      Sort-Object LocalPort)
    foreach ($listener in $listeners) {
      $status = & curl.exe --max-time 3 --silent --output NUL --write-out '%{http_code}' ("http://127.0.0.1:{0}/" -f $listener.LocalPort)
      if ($LASTEXITCODE -eq 0 -and $status -eq '200') {
        return $listener.LocalPort
      }
    }
  }
  throw "Desktop web server did not start within $TimeoutSeconds seconds."
}

function Invoke-SmartStrategy([int]$Port, [hashtable]$Payload) {
  Invoke-RestMethod -Method Post -Uri ("http://127.0.0.1:{0}/api/quant/smart-strategy" -f $Port) -Headers @{ 'X-QuantPilot-Launch-Token' = $smokeToken } -ContentType 'application/json' -Body ($Payload | ConvertTo-Json -Compress) -TimeoutSec 20
}

function Wait-ForCatalogStatus(
  [int]$Port,
  [string]$JobId,
  [string]$ExpectedStatus,
  [int]$WaitSeconds
) {
  $deadline = (Get-Date).AddSeconds($WaitSeconds)
  $lastJob = $null
  while ((Get-Date) -lt $deadline) {
    try {
      $status = Invoke-SmartStrategy -Port $Port -Payload @{ action = 'data-status' }
      $lastJob = @($status.data.ingestionJobs.jobs) |
        Where-Object { $_.id -eq $JobId } |
        Select-Object -First 1
      if ($lastJob -and $lastJob.status -eq $ExpectedStatus) {
        return $lastJob
      }
    } catch {
      # The web process can briefly accept connections before the sidecar proxy is ready.
    }
    Start-Sleep -Milliseconds 500
  }
  $actual = if ($lastJob) { $lastJob.status } else { 'missing' }
  throw "Catalog job $JobId did not reach $ExpectedStatus; last status: $actual"
}

try {
  New-Item -ItemType Directory -Path $LocalAppDataRoot -Force | Out-Null
  [System.IO.File]::WriteAllText($statePath, 'partial')
  $mockPort = Get-FreeLoopbackPort
  $mockBaseUrl = "http://127.0.0.1:$mockPort"
  $nodeExe = (Get-Command node.exe -ErrorAction Stop).Source
  $mockArguments = @(
    ('"' + $mockScript + '"'),
    '--port',
    [string]$mockPort,
    '--state',
    ('"' + $statePath + '"')
  )
  $mockProcess = Start-Process -FilePath $nodeExe -ArgumentList $mockArguments -WindowStyle Hidden -RedirectStandardOutput $mockStdout -RedirectStandardError $mockStderr -PassThru

  $mockDeadline = (Get-Date).AddSeconds(10)
  do {
    Start-Sleep -Milliseconds 200
    $mockStatus = & curl.exe --max-time 2 --silent --output NUL --write-out '%{http_code}' "$mockBaseUrl/health"
  } until (
    ($LASTEXITCODE -eq 0 -and $mockStatus -eq '200') -or
    (Get-Date) -ge $mockDeadline
  )
  if ($mockStatus -ne '200') {
    throw 'EastMoney smoke mock did not start.'
  }

  $currentMain = Start-PackagedApp -Phase 'partial' -MockBaseUrl $mockBaseUrl
  $firstPort = Wait-ForWebPort -MainProcess $currentMain
  $unauthorizedStatus = & curl.exe --max-time 5 --silent --output NUL --write-out '%{http_code}' `
    ("http://127.0.0.1:{0}/api/settings" -f $firstPort)
  if ($LASTEXITCODE -ne 0 -or $unauthorizedStatus -ne '401') {
    throw "Desktop API without a launch token returned $unauthorizedStatus; expected 401."
  }

  $dataStatusTimer = [System.Diagnostics.Stopwatch]::StartNew()
  $null = Invoke-SmartStrategy -Port $firstPort -Payload @{ action = 'data-status' }
  $dataStatusTimer.Stop()
  $dataStatusMilliseconds = [int][Math]::Ceiling($dataStatusTimer.Elapsed.TotalMilliseconds)
  if ($dataStatusMilliseconds -gt 2000) {
    throw "Packaged data-status took $dataStatusMilliseconds ms; expected at most 2000 ms."
  }
  $initialize = Invoke-SmartStrategy -Port $firstPort -Payload @{
    action = 'initialize-market-data'
    universeId = 'desktop-smoke-resume'
  }
  $jobId = [string]$initialize.data.catalogJobId
  if (-not $jobId) {
    throw 'Bootstrap smoke did not receive catalogJobId.'
  }
  $partialJob = Wait-ForCatalogStatus -Port $firstPort -JobId $jobId -ExpectedStatus 'partial' -WaitSeconds 45
  if ([int]$partialJob.lastSuccessfulPage -ne 1 -or [int]$partialJob.nextPage -ne 2) {
    throw "Unexpected partial checkpoint: last=$($partialJob.lastSuccessfulPage), next=$($partialJob.nextPage)"
  }

  Stop-PackagedProcesses
  $currentMain = $null
  [System.IO.File]::WriteAllText($statePath, 'complete')

  $currentMain = Start-PackagedApp -Phase 'resume' -MockBaseUrl $mockBaseUrl
  $secondPort = Wait-ForWebPort -MainProcess $currentMain
  $completedJob = Wait-ForCatalogStatus -Port $secondPort -JobId $jobId -ExpectedStatus 'completed' -WaitSeconds 30
  if ([int]$completedJob.lastSuccessfulPage -ne 2) {
    throw "Catalog did not resume through page two: $($completedJob.lastSuccessfulPage)"
  }

  Stop-PackagedProcesses
  $currentMain = $null
  [pscustomobject]@{
    CatalogJobId = $jobId
    DataStatusMilliseconds = $dataStatusMilliseconds
    FirstWebPort = $firstPort
    SecondWebPort = $secondPort
    PartialNextPage = [int]$partialJob.nextPage
    CompletedPage = [int]$completedJob.lastSuccessfulPage
    ReusedPersistedJob = $true
  }
} finally {
  Restore-SmokeEnvironment
  Stop-PackagedProcesses
  if ($mockProcess -and -not $mockProcess.HasExited) {
    Stop-Process -Id $mockProcess.Id -Force -ErrorAction SilentlyContinue
  }
}

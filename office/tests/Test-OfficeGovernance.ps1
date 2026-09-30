[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$initializer = Join-Path $projectRoot 'office\scripts\Initialize-Office.ps1'
$validator = Join-Path $projectRoot 'office\scripts\Test-OfficeGovernance.ps1'
$powershellExe = Join-Path $PSHOME 'powershell.exe'
if (-not (Test-Path -LiteralPath $powershellExe -PathType Leaf)) {
    $powershellExe = (Get-Command powershell.exe -ErrorAction Stop).Source
}

$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("office-governance-tests-{0}" -f [guid]::NewGuid().ToString('N'))
$failures = [System.Collections.Generic.List[string]]::new()

function Invoke-ScriptProcess {
    param(
        [Parameter(Mandatory)][string]$Script,
        [Parameter(Mandatory)][string[]]$Arguments
    )
    & $powershellExe -NoProfile -ExecutionPolicy Bypass -File $Script @Arguments *> $null
    return $LASTEXITCODE
}

function Assert-True {
    param(
        [Parameter(Mandatory)][bool]$Condition,
        [Parameter(Mandatory)][string]$Name
    )
    if ($Condition) {
        Write-Output "[PASS] $Name"
    } else {
        $script:failures.Add($Name)
        Write-Output "[FAIL] $Name"
    }
}

try {
    New-Item -ItemType Directory -Path $testRoot | Out-Null

    $seedExit = Invoke-ScriptProcess -Script $validator -Arguments @('-ProjectRoot', $projectRoot)
    Assert-True -Condition ($seedExit -eq 0) -Name 'Current governance seed validates'

    $targetRoot = Join-Path $testRoot 'existing-project'
    New-Item -ItemType Directory -Path $targetRoot | Out-Null
    $sentinel = '# Existing project instruction - preserve me'
    Set-Content -LiteralPath (Join-Path $targetRoot 'AGENTS.md') -Value $sentinel -Encoding UTF8

    $firstInitExit = Invoke-ScriptProcess -Script $initializer -Arguments @('-ProjectRoot', $targetRoot)
    Assert-True -Condition ($firstInitExit -eq 0) -Name 'Initializer succeeds for an existing project'

    $rootAgentsContent = Get-Content -LiteralPath (Join-Path $targetRoot 'AGENTS.md') -Raw
    Assert-True -Condition ($rootAgentsContent.Contains($sentinel)) -Name 'Existing root AGENTS.md content is preserved'
    Assert-True -Condition ($rootAgentsContent.Contains('<!-- office-governance:start -->')) -Name 'Managed office block is appended'

    $secondInitExit = Invoke-ScriptProcess -Script $initializer -Arguments @('-ProjectRoot', $targetRoot)
    $afterSecondInit = Get-Content -LiteralPath (Join-Path $targetRoot 'AGENTS.md') -Raw
    $managedBlockCount = ([regex]::Matches($afterSecondInit, '<!-- office-governance:start -->')).Count
    Assert-True -Condition ($secondInitExit -eq 0 -and $managedBlockCount -eq 1) -Name 'Initializer is idempotent'

    $missingRecord = Join-Path $targetRoot 'office\records\task-log.md'
    Remove-Item -LiteralPath $missingRecord -Force
    $invalidExit = Invoke-ScriptProcess -Script $validator -Arguments @('-ProjectRoot', $targetRoot)
    Assert-True -Condition ($invalidExit -ne 0) -Name 'Validator rejects a missing required record'
}
finally {
    if (Test-Path -LiteralPath $testRoot -PathType Container) {
        $resolvedTestRoot = [System.IO.Path]::GetFullPath($testRoot)
        $resolvedTempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
        if (-not $resolvedTestRoot.StartsWith($resolvedTempRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing to remove a test directory outside the OS temp root: $resolvedTestRoot"
        }
        Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force
    }
}

if ($failures.Count -gt 0) {
    Write-Output "[FAIL] $($failures.Count) governance test(s) failed."
    exit 1
}

Write-Output '[PASS] All office governance tests passed.'
exit 0

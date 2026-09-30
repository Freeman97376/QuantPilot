[CmdletBinding()]
param(
    [Parameter()]
    [string]$ProjectRoot = (Get-Location).Path,

    [Parameter()]
    [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-NormalizedPath {
    param([Parameter(Mandatory)][string]$Path)
    return [System.IO.Path]::GetFullPath($Path).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
}

function Test-IsFileSystemRoot {
    param([Parameter(Mandatory)][string]$Path)
    $root = [System.IO.Path]::GetPathRoot($Path).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
    return [string]::Equals($root, $Path.TrimEnd([System.IO.Path]::DirectorySeparatorChar), [System.StringComparison]::OrdinalIgnoreCase)
}

$resolvedProjectRoot = Get-NormalizedPath -Path $ProjectRoot
if (-not (Test-Path -LiteralPath $resolvedProjectRoot -PathType Container)) {
    throw "ProjectRoot must be an existing directory: $resolvedProjectRoot"
}
if (Test-IsFileSystemRoot -Path $resolvedProjectRoot) {
    throw "Refusing to initialize a filesystem root: $resolvedProjectRoot"
}

$sourceOffice = Get-NormalizedPath -Path (Join-Path $PSScriptRoot '..')
$targetOffice = Get-NormalizedPath -Path (Join-Path $resolvedProjectRoot 'office')
$sameOffice = [string]::Equals($sourceOffice, $targetOffice, [System.StringComparison]::OrdinalIgnoreCase)
$trimCharacters = [char[]]@('\', '/')

if (-not $sameOffice) {
    New-Item -ItemType Directory -Path $targetOffice -Force | Out-Null

    $sourceFiles = Get-ChildItem -LiteralPath $sourceOffice -File -Recurse | Where-Object {
        $relative = $_.FullName.Substring($sourceOffice.Length).TrimStart($trimCharacters)
        -not $relative.StartsWith('records\', [System.StringComparison]::OrdinalIgnoreCase) -and
        -not $relative.StartsWith('records/', [System.StringComparison]::OrdinalIgnoreCase)
    }

    foreach ($sourceFile in $sourceFiles) {
        $relativePath = $sourceFile.FullName.Substring($sourceOffice.Length).TrimStart($trimCharacters)
        $destination = Join-Path $targetOffice $relativePath
        $destinationDirectory = Split-Path -Parent $destination
        if (-not (Test-Path -LiteralPath $destinationDirectory -PathType Container)) {
            New-Item -ItemType Directory -Path $destinationDirectory -Force | Out-Null
        }
        if ($Force -or -not (Test-Path -LiteralPath $destination -PathType Leaf)) {
            Copy-Item -LiteralPath $sourceFile.FullName -Destination $destination -Force:$Force
        }
    }
}

$recordsDirectory = Join-Path $targetOffice 'records'
New-Item -ItemType Directory -Path $recordsDirectory -Force | Out-Null
$recordTemplates = @{
    'decision-log.md' = 'decision-log.template.md'
    'task-log.md' = 'task-log.template.md'
}
foreach ($recordName in $recordTemplates.Keys) {
    $destination = Join-Path $recordsDirectory $recordName
    if (-not (Test-Path -LiteralPath $destination -PathType Leaf)) {
        $template = Join-Path (Join-Path $targetOffice 'templates') $recordTemplates[$recordName]
        if (-not (Test-Path -LiteralPath $template -PathType Leaf)) {
            throw "Missing record template: $template"
        }
        Copy-Item -LiteralPath $template -Destination $destination
    }
}

$managedBlock = @"
<!-- office-governance:start -->
Before substantive work in this project, read `office/README.md` and `office/AGENTS.md`. Treat `office/AGENTS.md` as the project-wide agent governance contract.

When creating, repairing, or auditing agent governance, use `office/skills/manage-agent-governance/SKILL.md`. Run `office/scripts/Test-OfficeGovernance.ps1` after governance changes. Preserve user work and never store secrets in `office/records/`.
<!-- office-governance:end -->
"@

$rootAgents = Join-Path $resolvedProjectRoot 'AGENTS.md'
if (-not (Test-Path -LiteralPath $rootAgents -PathType Leaf)) {
    $content = "# Project Agent Entry Point`r`n`r`n$managedBlock`r`n"
    Set-Content -LiteralPath $rootAgents -Value $content -Encoding UTF8
} else {
    $existing = Get-Content -LiteralPath $rootAgents -Raw
    if ($existing -notmatch '<!-- office-governance:start -->') {
        Add-Content -LiteralPath $rootAgents -Value "`r`n$managedBlock`r`n" -Encoding UTF8
    }
}

$validator = Join-Path $targetOffice 'scripts\Test-OfficeGovernance.ps1'
if (-not (Test-Path -LiteralPath $validator -PathType Leaf)) {
    throw "Office initializer did not produce the validator: $validator"
}

$valid = & $validator -ProjectRoot $resolvedProjectRoot -Quiet -NoExit
if (-not $valid) {
    throw "Office governance initialization failed validation: $resolvedProjectRoot"
}

Write-Output "Office governance is ready: $resolvedProjectRoot"

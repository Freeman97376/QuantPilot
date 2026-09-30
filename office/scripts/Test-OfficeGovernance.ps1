[CmdletBinding()]
param(
    [Parameter()]
    [string]$ProjectRoot = (Get-Location).Path,

    [Parameter()]
    [switch]$Quiet,

    [Parameter()]
    [switch]$NoExit
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$resolvedRoot = [System.IO.Path]::GetFullPath($ProjectRoot).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
$failures = [System.Collections.Generic.List[string]]::new()

function Add-Failure {
    param([Parameter(Mandatory)][string]$Message)
    $script:failures.Add($Message)
}

$requiredFiles = @(
    'AGENTS.md',
    'office\README.md',
    'office\AGENTS.md',
    'office\skills\manage-agent-governance\SKILL.md',
    'office\skills\manage-agent-governance\agents\openai.yaml',
    'office\scripts\Initialize-Office.ps1',
    'office\scripts\Test-OfficeGovernance.ps1',
    'office\records\decision-log.md',
    'office\records\task-log.md',
    'office\templates\decision-log.template.md',
    'office\templates\task-log.template.md',
    'office\templates\global-AGENTS.md',
    'office\tests\cases.md',
    'office\tests\Test-OfficeGovernance.ps1'
)

foreach ($relativePath in $requiredFiles) {
    $fullPath = Join-Path $resolvedRoot $relativePath
    if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
        Add-Failure "Missing required file: $relativePath"
    }
}

$rootAgents = Join-Path $resolvedRoot 'AGENTS.md'
if (Test-Path -LiteralPath $rootAgents -PathType Leaf) {
    $rootContent = Get-Content -LiteralPath $rootAgents -Raw
    foreach ($requiredText in @('office/README.md', 'office/AGENTS.md', '<!-- office-governance:start -->', '<!-- office-governance:end -->')) {
        if ($rootContent -notlike "*$requiredText*") {
            Add-Failure "Root AGENTS.md does not contain: $requiredText"
        }
    }
}

$misCasedAgents = Get-ChildItem -LiteralPath $resolvedRoot -File -ErrorAction SilentlyContinue | Where-Object {
    $_.Name -ieq 'AGENTS.md' -and $_.Name -cne 'AGENTS.md'
}
foreach ($file in $misCasedAgents) {
    Add-Failure "Use exact AGENTS.md casing instead of: $($file.Name)"
}

$skillFile = Join-Path $resolvedRoot 'office\skills\manage-agent-governance\SKILL.md'
if (Test-Path -LiteralPath $skillFile -PathType Leaf) {
    $skillContent = Get-Content -LiteralPath $skillFile -Raw
    if ($skillContent -notmatch '(?s)^---\s*\r?\nname:\s*manage-agent-governance\s*\r?\ndescription:\s*\S.+?\r?\n---') {
        Add-Failure 'Skill frontmatter must contain a valid name and non-empty description.'
    }
    if ($skillContent -match '\[TODO') {
        Add-Failure 'Skill contains unresolved TODO placeholders.'
    }
}

$scriptDirectory = Join-Path $resolvedRoot 'office\scripts'
$testDirectory = Join-Path $resolvedRoot 'office\tests'
$powerShellFiles = @()
if (Test-Path -LiteralPath $scriptDirectory -PathType Container) {
    $powerShellFiles += Get-ChildItem -LiteralPath $scriptDirectory -Filter '*.ps1' -File
}
if (Test-Path -LiteralPath $testDirectory -PathType Container) {
    $powerShellFiles += Get-ChildItem -LiteralPath $testDirectory -Filter '*.ps1' -File
}
foreach ($file in $powerShellFiles) {
    $tokens = $null
    $parseErrors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$parseErrors)
    foreach ($parseError in $parseErrors) {
        Add-Failure "PowerShell parse error in $($file.Name): $($parseError.Message)"
    }
}

$valid = $failures.Count -eq 0
if (-not $Quiet) {
    if ($valid) {
        Write-Output "[PASS] Office governance structure is valid: $resolvedRoot"
    } else {
        foreach ($failure in $failures) {
            Write-Output "[FAIL] $failure"
        }
        Write-Output "[FAIL] Office governance structure has $($failures.Count) error(s)."
    }
}

if ($NoExit) {
    return $valid
}
if ($valid) {
    exit 0
}
exit 1

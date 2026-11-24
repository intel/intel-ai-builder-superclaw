#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$RepositoryRoot,
    [switch]$PassThru
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($RepositoryRoot)) {
    $RepositoryRoot = Join-Path $PSScriptRoot '..\..'
}
$RepositoryRoot = (Resolve-Path -LiteralPath $RepositoryRoot).Path
. (Join-Path $PSScriptRoot 'patch-set.ps1')

function Invoke-LockGit {
    param(
        [Parameter(Mandatory = $true)]
        [string]$WorkingDirectory,
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    $result = Invoke-LlamaGit -WorkingDirectory $WorkingDirectory -Arguments $Arguments
    if ($result.ExitCode -ne 0) {
        throw "git $($Arguments -join ' ') failed in '$WorkingDirectory':`n$($result.Output -join "`n")"
    }
    return $result.Output
}

$manifest = Get-LlamaPatchLock -RepositoryRoot $RepositoryRoot
$patchSet = Get-LlamaPatchSet `
    -Directory (Join-Path $RepositoryRoot 'patches\llama.cpp') `
    -Manifest $manifest

$submoduleRelativePath = 'third_party/llama.cpp'
$submodulePath = Join-Path $RepositoryRoot 'third_party\llama.cpp'
$gitmodulesPath = Join-Path $RepositoryRoot '.gitmodules'
if (-not (Test-Path -LiteralPath $gitmodulesPath -PathType Leaf)) {
    throw "Submodule configuration not found: $gitmodulesPath"
}

$submoduleUrl = (Invoke-LockGit -WorkingDirectory $RepositoryRoot -Arguments @(
    'config',
    '-f',
    $gitmodulesPath,
    '--get',
    'submodule.third_party/llama.cpp.url'
)).Trim()
if ($submoduleUrl -ne $manifest.Url) {
    throw "llama.cpp submodule URL is $submoduleUrl; lock requires $($manifest.Url)"
}

$headGitlink = (Invoke-LockGit -WorkingDirectory $RepositoryRoot -Arguments @(
    'rev-parse',
    "HEAD:$submoduleRelativePath"
)).Trim()
if ($headGitlink -ne $manifest.Sha) {
    throw "Superproject HEAD pins $submoduleRelativePath at $headGitlink; lock requires $($manifest.Sha)"
}

$indexEntries = @(Invoke-LockGit -WorkingDirectory $RepositoryRoot -Arguments @(
    'ls-files',
    '--stage',
    '--',
    $submoduleRelativePath
))
if ($indexEntries.Count -ne 1) {
    throw "Expected one stage-0 gitlink for $submoduleRelativePath in the superproject index"
}
$indexParts = $indexEntries[0] -split "`t", 2
if ($indexParts.Count -ne 2) {
    throw "Could not parse the superproject index entry for $submoduleRelativePath"
}
$indexMetadata = $indexParts[0] -split '\s+'
if (
    $indexParts[1] -ne $submoduleRelativePath -or
    $indexMetadata.Count -ne 3 -or
    $indexMetadata[0] -ne '160000' -or
    $indexMetadata[1] -ne $manifest.Sha -or
    $indexMetadata[2] -ne '0'
) {
    throw "The superproject index does not pin $submoduleRelativePath at $($manifest.Sha)"
}

if (-not (Test-Path -LiteralPath $submodulePath -PathType Container)) {
    throw "llama.cpp submodule is not initialized. Run: git submodule update --init $submoduleRelativePath"
}
$actualSubmoduleCommit = (Invoke-LockGit -WorkingDirectory $submodulePath -Arguments @(
    'rev-parse',
    '--verify',
    'HEAD'
)).Trim()
if ($actualSubmoduleCommit -ne $manifest.Sha) {
    throw "llama.cpp submodule checkout is at $actualSubmoduleCommit; lock requires $($manifest.Sha)"
}

$verification = [pscustomobject]@{
    Manifest = $manifest
    PatchSet = $patchSet
}
if ($PassThru) {
    return $verification
}

Write-Host 'llama.cpp upstream lock verified' -ForegroundColor Green
Write-Output "Base: $($manifest.Sha)"
Write-Output "Patched tree: $($manifest.PatchedTree)"
Write-Output "Patches: $($patchSet.Patches.Count)"
Write-Output "Patch set SHA-256: $($patchSet.Sha256)"

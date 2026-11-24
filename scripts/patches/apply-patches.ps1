#Requires -Version 5.1
[CmdletBinding()]
param([string]$Destination)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repositoryRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
. (Join-Path $PSScriptRoot 'patch-set.ps1')

$lockState = & (Join-Path $PSScriptRoot 'verify-lock.ps1') `
    -RepositoryRoot $repositoryRoot `
    -PassThru
$manifest = $lockState.Manifest
$patchSet = $lockState.PatchSet
$baseCommit = $manifest.Sha
$expectedTree = $manifest.PatchedTree
$submoduleRelativePath = 'third_party/llama.cpp'
$submodulePath = Join-Path $repositoryRoot 'third_party\llama.cpp'

if ([string]::IsNullOrWhiteSpace($Destination)) {
    $Destination = Join-Path $repositoryRoot 'build\llama.cpp-src-patched'
}
if (-not [System.IO.Path]::IsPathRooted($Destination)) {
    $Destination = Join-Path $repositoryRoot $Destination
}
$destinationPath = [System.IO.Path]::GetFullPath($Destination)
$normalizedDestinationPath = $destinationPath.TrimEnd([char[]]@('\', '/'))

function Invoke-Git {
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

function Test-RegisteredWorktreePath {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$WorktreeList,
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $normalizedPath = [System.IO.Path]::GetFullPath($Path).TrimEnd([char[]]@('\', '/'))
    foreach ($line in $WorktreeList) {
        if ($line.StartsWith('worktree ', [System.StringComparison]::Ordinal)) {
            $registeredPath = $line.Substring('worktree '.Length)
            $normalizedRegisteredPath = [System.IO.Path]::GetFullPath($registeredPath).TrimEnd([char[]]@('\', '/'))
            if ([string]::Equals($normalizedPath, $normalizedRegisteredPath, [System.StringComparison]::OrdinalIgnoreCase)) {
                return $true
            }
        }
    }

    return $false
}

function Confirm-DestinationCleanup {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Prompt,
        [Parameter(Mandatory = $true)]
        [string]$DestinationPath
    )

    try {
        $confirmation = Read-Host -Prompt $Prompt
    } catch {
        throw "Could not request cleanup confirmation. Destination was left untouched: $DestinationPath. Run this script in an interactive PowerShell session. $($_.Exception.Message)"
    }

    return ($confirmation -match '^(?i:y|yes)$')
}

if (-not (Test-Path -LiteralPath $submodulePath -PathType Container)) {
    throw "llama.cpp submodule is not initialized. Run: git submodule update --init $submoduleRelativePath"
}

$submoduleRoot = (Invoke-Git -WorkingDirectory $submodulePath -Arguments @('rev-parse', '--show-toplevel')).Trim()
$normalizedSubmoduleRoot = [System.IO.Path]::GetFullPath($submoduleRoot).TrimEnd([char[]]@('\', '/'))
$normalizedSubmodulePath = [System.IO.Path]::GetFullPath($submodulePath).TrimEnd([char[]]@('\', '/'))
if (-not [string]::Equals($normalizedSubmoduleRoot, $normalizedSubmodulePath, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "llama.cpp submodule is not initialized at the expected path: $submodulePath"
}
if ([string]::Equals($normalizedDestinationPath, $normalizedSubmodulePath, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Destination must not be the llama.cpp submodule worktree: $destinationPath"
}

$submoduleStatus = @(Invoke-Git -WorkingDirectory $submodulePath -Arguments @(
    'status',
    '--porcelain',
    '--untracked-files=all'
))
if ($submoduleStatus.Count -gt 0) {
    throw "Submodule worktree must be clean before applying the patch:`n$($submoduleStatus -join "`n")"
}

$registeredWorktrees = @(
    (Invoke-Git -WorkingDirectory $submodulePath -Arguments @('worktree', 'list', '--porcelain')) |
        Where-Object { $_.StartsWith('worktree ', [System.StringComparison]::Ordinal) }
)
$destinationIsRegistered = Test-RegisteredWorktreePath -WorktreeList $registeredWorktrees -Path $destinationPath
$destinationExists = Test-Path -LiteralPath $destinationPath

if ($destinationExists) {
    if (-not $destinationIsRegistered) {
        throw "Destination exists but is not a registered llama.cpp worktree; refusing to replace it: $destinationPath"
    }
    if (-not (Test-Path -LiteralPath $destinationPath -PathType Container)) {
        throw "Registered destination is not a directory; refusing to replace it: $destinationPath"
    }

    $worktreeRoot = (Invoke-Git -WorkingDirectory $destinationPath -Arguments @('rev-parse', '--show-toplevel')).Trim()
    $normalizedWorktreeRoot = [System.IO.Path]::GetFullPath($worktreeRoot).TrimEnd([char[]]@('\', '/'))
    if (-not [string]::Equals($normalizedWorktreeRoot, $normalizedDestinationPath, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Destination is not a worktree at the expected path: $worktreeRoot"
    }

    $destinationStatus = @(Invoke-Git -WorkingDirectory $destinationPath -Arguments @(
        'status',
        '--porcelain',
        '--untracked-files=all'
    ))
    if ($destinationStatus.Count -gt 0) {
        throw "Destination worktree has local changes; refusing to reuse or remove it:`n$($destinationStatus -join "`n")"
    }

    $existingHead = (Invoke-Git -WorkingDirectory $destinationPath -Arguments @('rev-parse', '--verify', 'HEAD')).Trim()
    $existingTree = (Invoke-Git -WorkingDirectory $destinationPath -Arguments @('write-tree')).Trim()
    $existingPatchCountText = (Invoke-Git -WorkingDirectory $destinationPath -Arguments @(
        'rev-list',
        '--count',
        "$baseCommit..HEAD"
    )).Trim()
    $existingPatchCount = [int]0
    $hasExpectedPatchCount = (
        [int]::TryParse($existingPatchCountText, [ref]$existingPatchCount) -and
        $existingPatchCount -eq $patchSet.Patches.Count
    )
    $existingBase = ''
    if ($hasExpectedPatchCount) {
        $historyCountText = (Invoke-Git -WorkingDirectory $destinationPath -Arguments @(
            'rev-list',
            '--first-parent',
            '--count',
            'HEAD'
        )).Trim()
        $historyCount = [int]0
        if (
            [int]::TryParse($historyCountText, [ref]$historyCount) -and
            $historyCount -gt $patchSet.Patches.Count
        ) {
            $existingBase = (Invoke-Git -WorkingDirectory $destinationPath -Arguments @(
                'rev-parse',
                '--verify',
                "HEAD~$($patchSet.Patches.Count)"
            )).Trim()
        }
    }

    if (
        $hasExpectedPatchCount -and
        $existingBase -eq $baseCommit -and
        $existingTree -eq $expectedTree
    ) {
        Write-Host "llama.cpp patches already applied at $destinationPath. No changes made." -ForegroundColor Green
        return
    }

    Write-Host "Existing destination does not match the locked patch set: $destinationPath" -ForegroundColor Yellow
    Write-Host "Patch commits: $existingPatchCountText (expected $($patchSet.Patches.Count)); tree: $existingTree (expected $expectedTree)"
    $ignoredStatus = @(Invoke-Git -WorkingDirectory $destinationPath -Arguments @(
        'status',
        '--porcelain',
        '--untracked-files=all',
        '--ignored=matching'
    ) | Where-Object { $_.StartsWith('!!') })
    if ($ignoredStatus.Count -gt 0) {
        throw "Destination worktree contains ignored files; refusing to remove it:`n$($ignoredStatus -join "`n")"
    }

    $replaceDestination = Confirm-DestinationCleanup `
        -Prompt "Remove and recreate this clean worktree? [y/N]" `
        -DestinationPath $destinationPath
    if (-not $replaceDestination) {
        Write-Host "No changes made; destination left untouched: $destinationPath" -ForegroundColor Yellow
        return
    }

    $destinationStatus = @(Invoke-Git -WorkingDirectory $destinationPath -Arguments @(
        'status',
        '--porcelain',
        '--untracked-files=all'
    ))
    if ($destinationStatus.Count -gt 0) {
        throw "Destination worktree changed while awaiting confirmation; refusing to remove it:`n$($destinationStatus -join "`n")"
    }
    $ignoredStatus = @(Invoke-Git -WorkingDirectory $destinationPath -Arguments @(
        'status',
        '--porcelain',
        '--untracked-files=all',
        '--ignored=matching'
    ) | Where-Object { $_.StartsWith('!!') })
    if ($ignoredStatus.Count -gt 0) {
        throw "Destination worktree contains ignored files; refusing to remove it:`n$($ignoredStatus -join "`n")"
    }
    $confirmedHead = (Invoke-Git -WorkingDirectory $destinationPath -Arguments @('rev-parse', '--verify', 'HEAD')).Trim()
    $confirmedTree = (Invoke-Git -WorkingDirectory $destinationPath -Arguments @('write-tree')).Trim()
    if ($confirmedHead -ne $existingHead -or $confirmedTree -ne $existingTree) {
        throw "Destination worktree changed while awaiting confirmation; refusing to remove it: $destinationPath"
    }
    $registeredWorktrees = @(
        (Invoke-Git -WorkingDirectory $submodulePath -Arguments @('worktree', 'list', '--porcelain')) |
            Where-Object { $_.StartsWith('worktree ', [System.StringComparison]::Ordinal) }
    )
    if (-not (Test-RegisteredWorktreePath -WorktreeList $registeredWorktrees -Path $destinationPath)) {
        throw "Destination is no longer a registered llama.cpp worktree; refusing to remove it: $destinationPath"
    }
    $null = Invoke-Git -WorkingDirectory $submodulePath -Arguments @('worktree', 'remove', $destinationPath)
} elseif ($destinationIsRegistered) {
    Write-Host "Destination is missing, but Git has a stale worktree registration: $destinationPath" -ForegroundColor Yellow
    $removeStaleRegistration = Confirm-DestinationCleanup `
        -Prompt "Remove the stale registration and continue? [y/N]" `
        -DestinationPath $destinationPath
    if (-not $removeStaleRegistration) {
        Write-Host "No changes made; stale registration left untouched: $destinationPath" -ForegroundColor Yellow
        return
    }
    if (Test-Path -LiteralPath $destinationPath) {
        throw "Destination appeared while awaiting confirmation; refusing to remove its registration: $destinationPath"
    }
    $registeredWorktrees = @(
        (Invoke-Git -WorkingDirectory $submodulePath -Arguments @('worktree', 'list', '--porcelain')) |
            Where-Object { $_.StartsWith('worktree ', [System.StringComparison]::Ordinal) }
    )
    if (Test-RegisteredWorktreePath -WorktreeList $registeredWorktrees -Path $destinationPath) {
        $null = Invoke-Git -WorkingDirectory $submodulePath -Arguments @('worktree', 'remove', $destinationPath)
    }
}

$parentPath = Split-Path -Parent $destinationPath
if (-not (Test-Path -LiteralPath $parentPath -PathType Container)) {
    New-Item -ItemType Directory -Path $parentPath -Force | Out-Null
}

$null = Invoke-Git -WorkingDirectory $submodulePath -Arguments @(
    'worktree',
    'add',
    '--detach',
    $destinationPath,
    $baseCommit
)
$worktreeRoot = (Invoke-Git -WorkingDirectory $destinationPath -Arguments @('rev-parse', '--show-toplevel')).Trim()
$normalizedWorktreeRoot = [System.IO.Path]::GetFullPath($worktreeRoot).TrimEnd([char[]]@('\', '/'))
if (-not [string]::Equals($normalizedWorktreeRoot, $normalizedDestinationPath, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Git worktree was created at an unexpected path: $worktreeRoot"
}

$actualHead = (Invoke-Git -WorkingDirectory $destinationPath -Arguments @('rev-parse', 'HEAD')).Trim()
if ($actualHead -ne $baseCommit) {
    throw "Worktree HEAD mismatch: expected $baseCommit, found $actualHead"
}

$null = Invoke-LlamaPatchSeries -WorkingDirectory $destinationPath -Patches $patchSet.Patches
$appliedHead = Assert-LlamaPatchSeriesCommitChain `
    -WorkingDirectory $destinationPath `
    -BaseCommit $baseCommit `
    -PatchCount $patchSet.Patches.Count

$actualTree = (Invoke-Git -WorkingDirectory $destinationPath -Arguments @('write-tree')).Trim()
if ($actualTree -ne $expectedTree) {
    throw "Applied tree mismatch: expected $expectedTree, found $actualTree"
}

$status = @(Invoke-Git -WorkingDirectory $destinationPath -Arguments @('status', '--porcelain', '--untracked-files=all'))
if ($status.Count -gt 0) {
    throw "The applied worktree is not clean: $($status -join "`n")"
}

if ((Invoke-Git -WorkingDirectory $submodulePath -Arguments @('rev-parse', '--verify', 'HEAD')).Trim() -ne $baseCommit) {
    throw "Submodule HEAD changed while applying the patch: $submodulePath"
}
$submoduleStatus = @(Invoke-Git -WorkingDirectory $submodulePath -Arguments @(
    'status',
    '--porcelain',
    '--untracked-files=all'
))
if ($submoduleStatus.Count -gt 0) {
    throw "Submodule worktree changed while applying the patch:`n$($submoduleStatus -join "`n")"
}

Write-Output "Applied tree: $actualTree"
Write-Output "Applied commit: $appliedHead"
Write-Output "Submodule base: $baseCommit"
Write-Output "Patches applied: $($patchSet.Patches.Count)"
Write-Output "Patch set SHA-256: $($patchSet.Sha256)"
Write-Output "Source: $destinationPath"
Write-Host 'llama.cpp patches applied successfully' -ForegroundColor Green

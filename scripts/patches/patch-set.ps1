#Requires -Version 5.1

function Invoke-LlamaGit {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$WorkingDirectory,
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $output = @(& git -C $WorkingDirectory @Arguments 2>&1)
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }

    $output = @($output | ForEach-Object { [string]$_ })
    return [pscustomobject]@{
        Output = $output
        ExitCode = $exitCode
    }
}

function Get-LlamaPatchLock {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepositoryRoot
    )

    $lockPath = Join-Path $RepositoryRoot 'patches\upstream.lock.json'
    if (-not (Test-Path -LiteralPath $lockPath -PathType Leaf)) {
        throw "llama.cpp patch lock not found: $lockPath"
    }

    $document = Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json
    $componentProperty = $document.PSObject.Properties['llama.cpp']
    if ($null -eq $componentProperty -or $null -eq $componentProperty.Value) {
        throw "llama.cpp component is missing from the patch lock: $lockPath"
    }
    $component = $componentProperty.Value

    foreach ($propertyName in @('url', 'sha', 'license', 'upstream_build_number', 'ui_archive_sha256', 'patched_tree', 'patches')) {
        if ($null -eq $component.PSObject.Properties[$propertyName]) {
            throw "Required property '$propertyName' is missing from the llama.cpp patch lock: $lockPath"
        }
    }

    $upstreamUrl = [string]$component.url
    if ($upstreamUrl -notmatch '^https://github\.com/[^/]+/[^/]+(?:\.git)?$') {
        throw "llama.cpp lock URL must be a public HTTPS GitHub URL: $upstreamUrl"
    }

    $baseCommit = [string]$component.sha
    if ($baseCommit -notmatch '^[0-9a-fA-F]{40}$') {
        throw "llama.cpp lock SHA must be a 40-character commit ID: $baseCommit"
    }

    $patchedTree = [string]$component.patched_tree
    if ($patchedTree -notmatch '^[0-9a-fA-F]{40}$') {
        throw "llama.cpp patched_tree must be a 40-character tree ID: $patchedTree"
    }

    $license = [string]$component.license
    if ([string]::IsNullOrWhiteSpace($license)) {
        throw 'llama.cpp lock license must not be empty'
    }

    $upstreamBuildNumber = [int]0
    if (
        -not [int]::TryParse([string]$component.upstream_build_number, [ref]$upstreamBuildNumber) -or
        $upstreamBuildNumber -le 0
    ) {
        throw "llama.cpp upstream_build_number must be a positive integer: $($component.upstream_build_number)"
    }

    $uiArchiveSha256 = [string]$component.ui_archive_sha256
    if ($uiArchiveSha256 -notmatch '^[0-9a-fA-F]{64}$') {
        throw 'llama.cpp ui_archive_sha256 must be a 64-character hexadecimal value'
    }

    $patchesProperty = $component.PSObject.Properties['patches']
    if ($null -eq $patchesProperty.Value) {
        throw 'llama.cpp lock patches must be a non-empty array'
    }
    $patchDefinitions = @($patchesProperty.Value)
    if ($patchDefinitions.Count -eq 0) {
        throw 'llama.cpp lock patches must be a non-empty array'
    }

    return [pscustomobject]@{
        Url = $upstreamUrl
        Sha = $baseCommit.ToLowerInvariant()
        License = $license
        UpstreamBuildNumber = $upstreamBuildNumber
        UiArchiveSha256 = $uiArchiveSha256.ToLowerInvariant()
        PatchedTree = $patchedTree.ToLowerInvariant()
        Patches = $patchDefinitions
    }
}

function Get-LlamaPatchSet {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Directory,
        [Parameter(Mandatory = $true)]
        [pscustomobject]$Manifest
    )

    if (-not (Test-Path -LiteralPath $Directory -PathType Container)) {
        throw "llama.cpp patch directory not found: $Directory"
    }

    $patchFiles = @(Get-ChildItem -LiteralPath $Directory -Filter '*.patch' -File -ErrorAction Stop)
    $numberedPatches = @()
    $lockedPatchNames = @{}
    for ($index = 0; $index -lt $Manifest.Patches.Count; $index++) {
        $patchDefinition = $Manifest.Patches[$index]
        if ($null -eq $patchDefinition) {
            throw "Patch entry $($index + 1) is empty in the llama.cpp lock"
        }
        foreach ($propertyName in @('file', 'sha256', 'upstreamable')) {
            if ($null -eq $patchDefinition.PSObject.Properties[$propertyName]) {
                throw "Required property '$propertyName' is missing from llama.cpp lock patch entry $($index + 1)"
            }
        }

        $patchName = [string]$patchDefinition.file
        if ($patchName -notmatch '^(?<number>[0-9]+)-(?<slug>[A-Za-z0-9][A-Za-z0-9._-]*)\.patch$') {
            throw "Patch filename must be a numbered patch basename: $patchName"
        }
        if ($lockedPatchNames.ContainsKey($patchName)) {
            throw "Duplicate patch filename in llama.cpp lock: $patchName"
        }

        $number = [long]0
        if (-not [long]::TryParse($Matches['number'], [ref]$number)) {
            throw "Patch sequence number is out of range: $patchName"
        }
        $expectedNumber = [long]($index + 1)
        if ($number -ne $expectedNumber) {
            throw "Patch lock order must be contiguous from 0001; expected $expectedNumber, found $number"
        }
        if ($patchDefinition.upstreamable -isnot [bool]) {
            throw "Patch upstreamable flag must be true or false: $patchName"
        }

        $expectedSha256 = [string]$patchDefinition.sha256
        if ($expectedSha256 -notmatch '^[0-9a-fA-F]{64}$') {
            throw "Patch SHA-256 must be a 64-character hexadecimal value: $patchName"
        }

        $patchPath = Join-Path $Directory $patchName
        if (-not (Test-Path -LiteralPath $patchPath -PathType Leaf)) {
            throw "Patch listed in lock was not found: $patchPath"
        }
        $patchFile = Get-Item -LiteralPath $patchPath
        if ($patchFile.Length -le 0) {
            throw "Patch file is empty: $patchPath"
        }
        if ([System.IO.File]::ReadAllText($patchPath).Contains("`r`n")) {
            throw "Patch file contains CRLF line endings: $patchPath"
        }

        $actualSha256 = (Get-FileHash -LiteralPath $patchPath -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actualSha256 -ne $expectedSha256.ToLowerInvariant()) {
            throw "Patch SHA-256 mismatch for $patchName; lock has $expectedSha256, file has $actualSha256"
        }

        $lockedPatchNames[$patchName] = $true
        $numberedPatches += [pscustomobject]@{
            Number = $number
            Name = $patchName
            Path = $patchFile.FullName
            Sha256 = $actualSha256
            Upstreamable = [bool]$patchDefinition.upstreamable
        }
    }

    $unlockedPatches = @($patchFiles | Where-Object { -not $lockedPatchNames.ContainsKey($_.Name) })
    if ($unlockedPatches.Count -gt 0) {
        throw "Patch files are not listed in patches\upstream.lock.json: $($unlockedPatches.Name -join ', ')"
    }

    if ($numberedPatches.Count -eq 1) {
        $patchSetSha256 = $numberedPatches[0].Sha256
    } else {
        $patchManifest = [string]::Join(
            "`n",
            [string[]]@($numberedPatches | ForEach-Object { "$($_.Name):$($_.Sha256)" })
        )
        $sha256 = [System.Security.Cryptography.SHA256]::Create()
        try {
            $digest = $sha256.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($patchManifest))
        } finally {
            $sha256.Dispose()
        }
        $patchSetSha256 = [System.BitConverter]::ToString($digest).Replace('-', '').ToLowerInvariant()
    }

    return [pscustomobject]@{
        Patches = $numberedPatches
        Sha256 = $patchSetSha256
    }
}

function Assert-LlamaPatchSeriesCommitChain {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$WorkingDirectory,
        [Parameter(Mandatory = $true)]
        [string]$BaseCommit,
        [Parameter(Mandatory = $true)]
        [ValidateRange(1, [int]::MaxValue)]
        [int]$PatchCount
    )

    $countResult = Invoke-LlamaGit -WorkingDirectory $WorkingDirectory -Arguments @(
        'rev-list',
        '--count',
        "$BaseCommit..HEAD"
    )
    $countOutput = $countResult.Output
    if ($countResult.ExitCode -ne 0) {
        throw "Could not count patch commits in '$WorkingDirectory':`n$($countOutput -join "`n")"
    }
    $countText = ($countOutput -join "`n").Trim()
    $actualCount = [int]0
    if (-not [int]::TryParse($countText, [ref]$actualCount) -or $actualCount -ne $PatchCount) {
        throw "Expected $PatchCount patch commits after $BaseCommit, found '$countText'"
    }

    $baseResult = Invoke-LlamaGit -WorkingDirectory $WorkingDirectory -Arguments @(
        'rev-parse',
        '--verify',
        "HEAD~$PatchCount"
    )
    $baseAtDistance = $baseResult.Output
    if ($baseResult.ExitCode -ne 0) {
        throw "Could not verify the patch commit ancestry in '$WorkingDirectory':`n$($baseAtDistance -join "`n")"
    }
    $actualBase = ($baseAtDistance -join "`n").Trim()
    if ($actualBase -ne $BaseCommit) {
        throw "Patch series does not start at $BaseCommit; HEAD~$PatchCount resolves to $actualBase"
    }

    $headResult = Invoke-LlamaGit -WorkingDirectory $WorkingDirectory -Arguments @(
        'rev-parse',
        '--verify',
        'HEAD'
    )
    $headOutput = $headResult.Output
    if ($headResult.ExitCode -ne 0) {
        throw "Could not read the patched HEAD in '$WorkingDirectory':`n$($headOutput -join "`n")"
    }
    return ($headOutput -join "`n").Trim()
}

function Invoke-LlamaPatchSeries {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$WorkingDirectory,
        [Parameter(Mandatory = $true)]
        [object[]]$Patches
    )

    for ($index = 0; $index -lt $Patches.Count; $index++) {
        $patch = $Patches[$index]
        Write-Host "[$($index + 1)/$($Patches.Count)] Applying patch $($patch.Name)..."

        $result = Invoke-LlamaGit -WorkingDirectory $WorkingDirectory -Arguments @(
            '-c', 'user.name=superclaw-llama-patch',
            '-c', 'user.email=noreply@invalid',
            'am',
            '--no-3way',
            $patch.Path
        )
        if ($result.ExitCode -ne 0) {
            throw "git am --no-3way failed for '$($patch.Name)' in '$WorkingDirectory':`n$($result.Output -join "`n")"
        }
    }
}

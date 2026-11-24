<#
.SYNOPSIS
    Verify the OpenCode upstream submodule pin and patch file against the
    'opencode' entry in patches/upstream.lock.json.

.DESCRIPTION
    Three checks, none of which require third_party/opencode to be
    initialized (no `git submodule update --init` needed just to validate):
      1. .gitmodules declares the submodule URL the lock expects.
      2. The superproject's own git index pins third_party/opencode (a 160000
         gitlink) at the commit the lock expects - read straight out of git's
         object model (the index, not HEAD, so this also works for a staged
         but not-yet-committed bump), not out of a JSON/string field that
         could drift from what's actually committed.
      3. Every patch file's sha256 matches the lock.

    This is the check fetch-runtime-bin.ps1 and prepare-sidecar.mjs run on
    every invocation (including in CI) to decide whether the committed
    runtime binary is still fresh. opencode-apply-patches.ps1 (which does
    require the submodule initialized) calls this first and then
    additionally confirms the initialized submodule's actual HEAD matches
    too.

    Also computes $Lock.Fingerprint = sha256(sha + each patch's sha256, in
    lock order + patched_tree). That's what fetch-runtime-bin.ps1 and
    prepare-sidecar.mjs stamp/compare, not patched_tree alone: patched_tree
    is only ever recomputed when opencode-apply-patches.ps1 actually runs
    (it needs the submodule checked out), so if a maintainer updates sha or
    a patch's sha256 but forgets to recompute patched_tree, comparing
    patched_tree alone would never detect that the lock's own fields have
    drifted apart - the one check that could (opencode-apply-patches.ps1's
    tree comparison) would never even run, because this lightweight gate
    would have already decided nothing changed. Folding sha and the patch
    hashes into the compared value forces a rebuild attempt whenever any of
    them move, even if patched_tree was left stale by mistake.

.PARAMETER RepositoryRoot
    Defaults to the repo root two levels up from this script.

.PARAMETER PassThru
    Return the parsed lock manifest instead of printing a summary. Used by
    opencode-apply-patches.ps1 and fetch-runtime-bin.ps1.
#>

[CmdletBinding()]
param(
    [string] $RepositoryRoot,
    [switch] $PassThru
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($RepositoryRoot)) {
    $RepositoryRoot = Join-Path $PSScriptRoot "..\.."
}
$RepositoryRoot = (Resolve-Path -LiteralPath $RepositoryRoot).Path

function Fail($msg) { Write-Host "[verify-lock] $msg" -ForegroundColor Red; exit 1 }

function Invoke-Git([string] $WorkingDirectory, [string[]] $Arguments) {
    # git routinely writes progress (clone/worktree) to stderr on success. Under
    # $ErrorActionPreference = "Stop", capturing stderr via 2>&1 turns each line
    # into a terminating ErrorRecord regardless of exit code - drop EAP to
    # Continue for just this call and rely on $LASTEXITCODE instead.
    $PrevEap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $output = git -C $WorkingDirectory @Arguments 2>&1
    } finally {
        $ErrorActionPreference = $PrevEap
    }
    $output = $output | ForEach-Object { $_.ToString() }
    if ($LASTEXITCODE -ne 0) {
        throw "git $($Arguments -join ' ') failed in '$WorkingDirectory':`n$($output -join "`n")"
    }
    return ($output -join "`n")
}

$SubmoduleRelativePath = "third_party/opencode"
$OpencodePatchesDir = Join-Path $RepositoryRoot "patches\opencode"
$LockPath = Join-Path $RepositoryRoot "patches\upstream.lock.json"
$GitmodulesPath = Join-Path $RepositoryRoot ".gitmodules"

if (-not (Test-Path -LiteralPath $LockPath)) { Fail "lock file not found: $LockPath" }
$Lock = (Get-Content $LockPath -Raw | ConvertFrom-Json).opencode
if (-not $Lock) { Fail "$LockPath has no 'opencode' entry" }
foreach ($field in @("url", "sha", "patched_tree", "patches")) {
    if (-not $Lock.$field) { Fail "$LockPath is missing required field '$field'" }
}
# Format checks (not identity checks - this cannot prove the URL is really the
# legitimate upstream, only that the lock is internally well-formed; identity
# is established once, at PR-review time, by a human).
if ($Lock.url -notmatch '^https://github\.com/[^/]+/[^/]+(?:\.git)?$') {
    Fail "$LockPath 'url' must be a public HTTPS GitHub URL: $($Lock.url)"
}
if ($Lock.sha -notmatch '^[0-9a-f]{40}$') {
    Fail "$LockPath 'sha' must be a 40-character lowercase commit SHA: $($Lock.sha)"
}
if ($Lock.patched_tree -notmatch '^[0-9a-f]{40}$') {
    Fail "$LockPath 'patched_tree' must be a 40-character lowercase tree SHA: $($Lock.patched_tree)"
}

if (-not (Test-Path -LiteralPath $GitmodulesPath -PathType Leaf)) {
    Fail "submodule configuration not found: $GitmodulesPath"
}
$SubmoduleUrl = (Invoke-Git $RepositoryRoot @(
    "config", "-f", $GitmodulesPath, "--get", "submodule.$SubmoduleRelativePath.url"
)).Trim()
if ($SubmoduleUrl -ne $Lock.url) {
    Fail "$SubmoduleRelativePath submodule URL is $SubmoduleUrl; lock requires $($Lock.url)"
}

$IndexEntry = (Invoke-Git $RepositoryRoot @("ls-files", "--stage", "--", $SubmoduleRelativePath)).Trim()
if (-not $IndexEntry) { Fail "no index entry for $SubmoduleRelativePath" }
$IndexParts = $IndexEntry -split "`t", 2
$IndexMetadata = $IndexParts[0] -split '\s+'
if ($IndexMetadata.Count -ne 3 -or $IndexMetadata[0] -ne "160000" -or $IndexMetadata[1] -ne $Lock.sha) {
    Fail "index entry for $SubmoduleRelativePath is '$IndexEntry'; expected a 160000 gitlink at $($Lock.sha)"
}

$LockedPatchNames = @{}
foreach ($patch in $Lock.patches) {
    if (-not $patch.file -or -not $patch.sha256) {
        Fail "a patch entry in $LockPath is missing 'file' or 'sha256'"
    }
    $LockedPatchNames[$patch.file] = $true
    $PatchPath = Join-Path $OpencodePatchesDir $patch.file
    if (-not (Test-Path -LiteralPath $PatchPath -PathType Leaf)) { Fail "patch file not found: $PatchPath" }
    # A core.autocrlf LF->CRLF round-trip is a known way for a patch file's
    # bytes (and therefore its sha256 and the fingerprint it feeds) to change
    # silently; catch it directly rather than relying solely on .gitattributes.
    if ([System.IO.File]::ReadAllText($PatchPath).Contains("`r`n")) {
        Fail "$($patch.file) contains CRLF line endings (expected LF - see .gitattributes)"
    }
    $ActualHash = (Get-FileHash -LiteralPath $PatchPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($ActualHash -ne $patch.sha256.ToLowerInvariant()) {
        Fail "$($patch.file) sha256 is $ActualHash; lock requires $($patch.sha256)"
    }
}

# A patch file present on disk but not registered in the lock would be silently
# ignored by opencode-apply-patches.ps1 - catch that instead of building from a
# source nobody has verified against a recorded sha256.
$UnlockedPatches = @(
    Get-ChildItem -LiteralPath $OpencodePatchesDir -Filter "*.patch" -File |
        Where-Object { -not $LockedPatchNames.ContainsKey($_.Name) }
)
if ($UnlockedPatches.Count -gt 0) {
    Fail "patch file(s) not listed in $LockPath : $($UnlockedPatches.Name -join ', ')"
}

if ($Lock.upstream_version) {
    $PkgJsonPath = Join-Path $RepositoryRoot "sandbox\orchestrator\package.json"
    $PkgJson = Get-Content $PkgJsonPath -Raw | ConvertFrom-Json
    if ($PkgJson.opencodeVersion -and $PkgJson.opencodeVersion -ne $Lock.upstream_version) {
        Fail "sandbox/orchestrator/package.json::opencodeVersion is $($PkgJson.opencodeVersion); lock's upstream_version is $($Lock.upstream_version)"
    }
}

# If the submodule happens to be initialized already, make sure it actually
# points at the pinned commit too - catches a stale/corrupted local checkout
# before opencode-apply-patches.ps1 builds on top of it.
$SubmodulePath = Join-Path $RepositoryRoot ($SubmoduleRelativePath -replace '/', '\')
if (Test-Path -LiteralPath (Join-Path $SubmodulePath ".git")) {
    $ActualCommit = (Invoke-Git $SubmodulePath @("rev-parse", "--verify", "HEAD")).Trim()
    if ($ActualCommit -ne $Lock.sha) {
        Fail "initialized $SubmoduleRelativePath checkout is at $ActualCommit; lock requires $($Lock.sha)"
    }
}

# Covers sha + every patch's sha256 (in lock order) + patched_tree, so the
# freshness gate (fetch-runtime-bin.ps1 / prepare-sidecar.mjs) reacts to any
# of these three drifting apart, not just to patched_tree in isolation - see
# the .DESCRIPTION note above.
$FingerprintInput = @($Lock.sha) + @($Lock.patches | ForEach-Object { $_.sha256.ToLowerInvariant() }) + @($Lock.patched_tree)
$FingerprintBytes = [System.Text.Encoding]::UTF8.GetBytes(($FingerprintInput -join "`n"))
$Sha256 = [System.Security.Cryptography.SHA256]::Create()
try {
    $Fingerprint = [System.BitConverter]::ToString($Sha256.ComputeHash($FingerprintBytes)).Replace("-", "").ToLowerInvariant()
} finally {
    $Sha256.Dispose()
}
$Lock | Add-Member -NotePropertyName Fingerprint -NotePropertyValue $Fingerprint -Force

if ($PassThru) { return $Lock }

Write-Host "OpenCode upstream lock verified" -ForegroundColor Green
Write-Output "Upstream: $($Lock.url) @ $($Lock.sha)"
Write-Output "Patched tree: $($Lock.patched_tree)"
Write-Output "Patches: $($Lock.patches.Count)"
Write-Output "Fingerprint: $Fingerprint"

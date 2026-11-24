<#
.SYNOPSIS
    Produce a clean OpenCode checkout with the SuperClaw patch applied, and
    prove its content matches the 'opencode' entry in patches/upstream.lock.json.

.DESCRIPTION
    Runs opencode-verify-lock.ps1 first (the lightweight, no-submodule-needed
    check), then:
      1. Initializes the third_party/opencode submodule if it isn't already
         (a full `git submodule update --init` - not a shallow fetch, so an
         arbitrary pinned commit is always reachable without relying on a
         host's support for fetching by bare SHA).
      2. Creates (or reuses) a `git worktree` off the submodule's own .git at
         a short path under .cache/ rather than under third_party/ itself -
         this is the Windows MAX_PATH escape hatch bun's flattened
         node_modules nesting needs; a C++-only vendoring job (e.g. the
         llama.cpp patch-set this script's design mirrors) never hits that
         limit, so don't copy its third_party/-relative worktree default.
      3. Applies the patch with `git apply --index`, commits it, and checks
         the resulting tree against `patched_tree` in the lock - this is the
         integrity check the old content-hash-of-the-patch-file model could
         not give: it validates the *result*, not just that the patch bytes
         are untouched.

.PARAMETER RepositoryRoot
    Defaults to the repo root two levels up from this script.

.PARAMETER Destination
    Where to create the patched worktree. Defaults to
    .cache/opencode-src/<first 12 hex chars of patched_tree>.
#>

[CmdletBinding()]
param(
    [string] $RepositoryRoot,
    [string] $Destination
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($RepositoryRoot)) {
    $RepositoryRoot = Join-Path $PSScriptRoot "..\.."
}
$RepositoryRoot = (Resolve-Path -LiteralPath $RepositoryRoot).Path

function Log($msg)  { Write-Host "[apply-patches] $msg" -ForegroundColor Cyan }
function Fail($msg) { Write-Host "[apply-patches] $msg" -ForegroundColor Red; exit 1 }

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

$Lock = & (Join-Path $PSScriptRoot "opencode-verify-lock.ps1") -RepositoryRoot $RepositoryRoot -PassThru

$SubmoduleRelativePath = "third_party/opencode"
$SubmodulePath = Join-Path $RepositoryRoot ($SubmoduleRelativePath -replace '/', '\')

if (-not (Test-Path -LiteralPath (Join-Path $SubmodulePath ".git"))) {
    Log "initializing $SubmoduleRelativePath submodule from $($Lock.url)..."
    Invoke-Git $RepositoryRoot @("submodule", "update", "--init", "--", $SubmoduleRelativePath) | Out-Null
}

$SubmoduleCommit = (Invoke-Git $SubmodulePath @("rev-parse", "--verify", "HEAD")).Trim()
if ($SubmoduleCommit -ne $Lock.sha) {
    Fail "$SubmoduleRelativePath is at $SubmoduleCommit after init; lock requires $($Lock.sha)"
}
$SubmoduleStatus = Invoke-Git $SubmodulePath @("status", "--porcelain", "--untracked-files=all")
if ($SubmoduleStatus) {
    Fail "$SubmoduleRelativePath worktree must be clean before applying the patch:`n$SubmoduleStatus"
}

if ([string]::IsNullOrWhiteSpace($Destination)) {
    $Slug = $Lock.patched_tree.Substring(0, 12)
    $Destination = Join-Path $RepositoryRoot ".cache\opencode-src\$Slug"
}
$Destination = [System.IO.Path]::GetFullPath($Destination)

$RegisteredWorktrees = @(
    (Invoke-Git $SubmodulePath @("worktree", "list", "--porcelain")) -split "`n" |
        Where-Object { $_.StartsWith("worktree ") } |
        ForEach-Object { [System.IO.Path]::GetFullPath($_.Substring("worktree ".Length)).TrimEnd('\', '/') }
)
$NormalizedDestination = $Destination.TrimEnd('\', '/')
$IsRegistered = $RegisteredWorktrees -contains $NormalizedDestination

if ((Test-Path -LiteralPath $Destination) -and $IsRegistered) {
    $ExistingTree = $null
    try { $ExistingTree = (Invoke-Git $Destination @("rev-parse", "HEAD^{tree}")).Trim() } catch { $ExistingTree = $null }
    $ExistingStatus = $null
    try { $ExistingStatus = Invoke-Git $Destination @("status", "--porcelain", "--untracked-files=all") } catch { $ExistingStatus = "unreadable" }
    # Content match alone cannot distinguish "built from the pinned base commit"
    # from "happens to have identical file content via some other history" -
    # a cache hit must also prove the same ancestry a fresh apply would.
    $ExistingParent = $null
    try { $ExistingParent = (Invoke-Git $Destination @("rev-parse", "--verify", "HEAD~1")).Trim() } catch { $ExistingParent = $null }
    if ($ExistingTree -eq $Lock.patched_tree -and $ExistingParent -eq $Lock.sha -and -not $ExistingStatus) {
        Log "patch already applied at $Destination (tree $ExistingTree) - reusing."
        Write-Output $Destination
        return
    }
    if ($ExistingStatus) {
        Fail "destination has local changes or an unreadable status; refusing to remove it: $Destination"
    }
    Log "existing worktree at $Destination does not match the lock (tree $ExistingTree, parent $ExistingParent) - recreating."
    Invoke-Git $SubmodulePath @("worktree", "remove", $Destination) | Out-Null
} elseif ($IsRegistered) {
    Invoke-Git $SubmodulePath @("worktree", "prune") | Out-Null
} elseif (Test-Path -LiteralPath $Destination) {
    Fail "destination exists but is not a registered worktree of $SubmoduleRelativePath; refusing to touch it: $Destination"
}

$ParentDir = Split-Path -Parent $Destination
New-Item -ItemType Directory -Force -Path $ParentDir | Out-Null

Log "creating worktree at $Destination from $($Lock.sha)..."
Invoke-Git $SubmodulePath @("worktree", "add", "--detach", $Destination, $Lock.sha) | Out-Null

$WorktreeHead = (Invoke-Git $Destination @("rev-parse", "HEAD")).Trim()
if ($WorktreeHead -ne $Lock.sha) { Fail "worktree HEAD is $WorktreeHead, expected $($Lock.sha)" }

$OpencodePatchesDir = Join-Path $RepositoryRoot "patches\opencode"
foreach ($patch in $Lock.patches) {
    $PatchPath = Join-Path $OpencodePatchesDir $patch.file
    Log "applying $($patch.file)..."
    Invoke-Git $Destination @("apply", "--index", "--whitespace=nowarn", $PatchPath) | Out-Null
}

Invoke-Git $Destination @(
    "-c", "user.name=superclaw-opencode-patch",
    "-c", "user.email=noreply@invalid",
    "commit", "--quiet", "-m", "Apply SuperClaw OpenCode patch (patches/upstream.lock.json)"
) | Out-Null

# Ancestry check, not just content: a tree hash match alone cannot distinguish
# "built from the pinned base commit" from "happens to have identical file
# content via some other history". Exactly one commit must sit on top of
# $Lock.sha, and HEAD~1 must resolve to $Lock.sha exactly.
$CommitsSincePin = (Invoke-Git $Destination @("rev-list", "--count", "$($Lock.sha)..HEAD")).Trim()
if ($CommitsSincePin -ne "1") {
    Fail "expected exactly 1 commit on top of $($Lock.sha), found $CommitsSincePin"
}
$ParentCommit = (Invoke-Git $Destination @("rev-parse", "--verify", "HEAD~1")).Trim()
if ($ParentCommit -ne $Lock.sha) {
    Fail "patch commit's parent is $ParentCommit; expected the pinned base $($Lock.sha)"
}

$ActualTree = (Invoke-Git $Destination @("rev-parse", "HEAD^{tree}")).Trim()
if ($ActualTree -ne $Lock.patched_tree) {
    Fail "applied tree is $ActualTree; lock requires patched_tree $($Lock.patched_tree). The patch, the pinned commit, or the lock file is out of sync."
}
$FinalStatus = Invoke-Git $Destination @("status", "--porcelain", "--untracked-files=all")
if ($FinalStatus) { Fail "applied worktree is not clean after commit:`n$FinalStatus" }

$SubmoduleStatusAfter = Invoke-Git $SubmodulePath @("status", "--porcelain", "--untracked-files=all")
if ($SubmoduleStatusAfter) { Fail "$SubmoduleRelativePath changed while applying the patch:`n$SubmoduleStatusAfter" }

Log "OK. Patched tree $ActualTree at $Destination"
Write-Output $Destination

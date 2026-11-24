<#
.SYNOPSIS
    Validate (or rebuild) the SuperClaw Windows runtime binary.

.DESCRIPTION
        Canonical runtime bin path:
            packaging/docker/superclaw-runtime-bin/superclaw-windows-x64.exe

    Behavior:
      1) If -ForceRefresh is set, rebuild from source via build-local-runtime.ps1,
         using the pin in the 'opencode' entry of patches/upstream.lock.json
         (verified by scripts/patches/opencode-verify-lock.ps1), then
         validate the result.
      2) Else, if the canonical binary is missing, invalid, or stale relative
         to the locked fingerprint (opencode-verify-lock.ps1's Fingerprint -
         sha, each patch's sha256, and patched_tree combined), rebuild
         automatically.
      3) Else, reuse the existing binary after validating that it is a real
         Windows executable.
      4) If no valid binary can be produced, fail with a manual build command.

    The Windows-native backend payload and build-superclaw.ps1 both resolve the
    runtime through this script.

    -NoRebuild, or a CI environment (CI set and not 'false'), turns a rebuild into
    a failure unless -ForceRefresh asks for one: a release lane must ship the
    committed binary, not one its runner built.

    The freshness check (opencode-verify-lock.ps1) never needs
    third_party/opencode initialized - it reads the pin straight out of the
    git index. Only an actual rebuild (step 1 or 2 above) requires the
    submodule, and build-local-runtime.ps1 initializes it lazily when that
    happens.
#>

[CmdletBinding()]
param(
    [switch] $ForceRefresh,
    [switch] $NoRebuild
)

$ErrorActionPreference = "Stop"

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$OutDir   = Join-Path $RepoRoot "packaging\docker\superclaw-runtime-bin"
$OutBin   = Join-Path $OutDir "superclaw-windows-x64.exe"
$OutStamp = Join-Path $OutDir "superclaw-windows-x64.exe.head"
$VerifyLockScript = Join-Path $RepoRoot "scripts\patches\opencode-verify-lock.ps1"

function Log($msg)  { Write-Host "[fetch-runtime] $msg" -ForegroundColor Cyan }
function Fail($msg) { Write-Host "[fetch-runtime] $msg" -ForegroundColor Red; exit 1 }

# A real Windows executable starts with 'MZ' and is several MB.
# An un-pulled Git LFS pointer file is a small text stub - catch that case
# before it silently gets installed into the desktop sidecars as a broken binary.
function Test-PeBinary([string] $Path) {
    if ((Get-Item $Path).Length -lt 1024) { return $false }
    $Header = [byte[]]::new(2)
    $Stream = [System.IO.File]::OpenRead($Path)
    try { $Stream.Read($Header, 0, 2) | Out-Null } finally { $Stream.Close() }
    return ($Header[0] -eq 0x4D) -and ($Header[1] -eq 0x5A)
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$BuildScript = Join-Path $PSScriptRoot "build-local-runtime.ps1"
if (-not (Test-Path $VerifyLockScript)) { Fail "verify-lock script missing: $VerifyLockScript" }
$Lock = & $VerifyLockScript -RepositoryRoot $RepoRoot -PassThru
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
# Fingerprint, not patched_tree alone: it also covers sha and each patch's
# sha256, so a lock left internally inconsistent (e.g. sha256 updated for a
# changed patch but patched_tree not recomputed) still triggers a rebuild
# attempt instead of being silently treated as "nothing changed" - see
# opencode-verify-lock.ps1's own comment on this.
$PinnedFingerprint = $Lock.Fingerprint.Trim()

$Reason = if ($ForceRefresh) { "-ForceRefresh" }
    elseif (-not (Test-Path $OutBin)) { "runtime bin missing" }
    elseif (-not (Test-PeBinary $OutBin)) { "runtime bin is not a real Windows executable (LFS pointer?)" }
    elseif (-not (Test-Path $OutStamp)) { "runtime stamp missing" }
    elseif ((Get-Content $OutStamp -Raw).Trim() -ne $PinnedFingerprint) { "pinned runtime fingerprint changed ($((Get-Content $OutStamp -Raw).Trim()) -> $PinnedFingerprint)" }
    else { $null }

if ($Reason) {
    $InCi = $env:CI -and $env:CI -ne 'false'
    if (-not $ForceRefresh -and ($NoRebuild -or $InCi)) {
        $Mode = if ($NoRebuild) { "-NoRebuild" } else { "CI" }
        Fail "${Reason}; refusing to rebuild under $Mode. Run fetch-runtime-bin.ps1 -ForceRefresh locally and commit superclaw-windows-x64.exe and its .head."
    }
    if (-not (Test-Path $BuildScript)) { Fail "build script missing: $BuildScript" }
    Log "${Reason}; rebuilding $OutBin from locked fingerprint $PinnedFingerprint..."
    # -Force: a matching stamp beside an invalid binary must still rebuild.
    & $BuildScript -Force
    if ($LASTEXITCODE -ne 0) { Fail "build-local-runtime.ps1 failed (exit code $LASTEXITCODE)." }
    if (-not (Test-Path $OutBin) -or -not (Test-PeBinary $OutBin)) { Fail "no valid Windows runtime at $OutBin after rebuild." }
    $Built = if (Test-Path $OutStamp) { (Get-Content $OutStamp -Raw).Trim() } else { "missing" }
    if ($Built -ne $PinnedFingerprint) { Fail "rebuilt runtime stamp $Built does not match pinned fingerprint $PinnedFingerprint." }
}

Log "using Windows runtime bin: $OutBin ($([math]::Round((Get-Item $OutBin).Length / 1MB, 1)) MB, fingerprint=$PinnedFingerprint)"
exit 0

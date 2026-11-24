<#
.SYNOPSIS
    Build the SuperClaw runtime from source and drop the resulting binaries at
    packaging/docker/superclaw-runtime-bin/superclaw-windows-x64.exe and
    packaging/docker/superclaw-runtime-bin/superclaw-linux-x64.

.DESCRIPTION
    Sources from the public third_party/opencode submodule (the 'opencode'
    entry in patches/upstream.lock.json pins the upstream commit) plus the
    Intel delta carried as patches/opencode/*.patch, applied by
    scripts/patches/opencode-apply-patches.ps1 into a short-path worktree
    under .cache/ (not under third_party/ - bun's flattened node_modules
    nesting needs the shorter path to stay under Windows' MAX_PATH). Builds
    with bun on Windows; bun cross-compiles the Linux binary. The Windows
    binary is the one apps/desktop/scripts/prepare-sidecar.mjs installs into
    the desktop sidecars; the Linux binary is used by the Linux CI lanes
    (ci.yml, ci-daily.yml). A `.head` stamp next to each binary records
    opencode-verify-lock.ps1's Fingerprint (the 'opencode' entry's sha, each
    patch's sha256, and patched_tree combined - not patched_tree alone, so a
    lock left internally inconsistent still invalidates the cache) it was
    built from - an exact match, not a prefix match.

.PARAMETER Force
    Always rebuild, even if the resolved fingerprint matches the stamp files
    ($WinOutBin.head, $LinuxOutBin.head) from a previous build. Without this, a
    checkout that resolves to the same fingerprint as last time is treated as
    a cache hit and the build is skipped.
#>

[CmdletBinding()]
param(
    [switch] $Force
)

$ErrorActionPreference = "Stop"

$RepoRoot   = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$WinOutDir  = Join-Path $RepoRoot "packaging\docker\superclaw-runtime-bin"
$WinOutBin  = Join-Path $WinOutDir "superclaw-windows-x64.exe"
$WinStamp   = "$WinOutBin.head"
$LinuxOutBin = Join-Path $WinOutDir "superclaw-linux-x64"
$LinuxStamp  = "$LinuxOutBin.head"
$ApplyPatchesScript = Join-Path $RepoRoot "scripts\patches\opencode-apply-patches.ps1"
$VerifyLockScript = Join-Path $RepoRoot "scripts\patches\opencode-verify-lock.ps1"

function Log($msg)  { Write-Host "[build-runtime] $msg" -ForegroundColor Cyan }
function Fail($msg) { Write-Host "[build-runtime] $msg" -ForegroundColor Red; exit 1 }

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Fail "git not found in PATH." }
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    Fail "bun not found in PATH. Install bun (https://bun.sh) and re-run."
}

# Same SHA + stamp must mean the same binary, so pin the compiler to CI's bun.
$BunPinFile = Join-Path $RepoRoot "scripts\ci\install-bun.sh"
if ((Get-Content $BunPinFile -Raw) -notmatch 'BUN_VERSION:-([0-9]+\.[0-9]+\.[0-9]+)') {
    Fail "could not read the pinned bun version from $BunPinFile"
}
$PinnedBun = $Matches[1]
$BunVersion = (bun --version).Trim()
if ($BunVersion -ne $PinnedBun) {
    Fail "bun $BunVersion is on PATH, but runtime binaries must be built with bun $PinnedBun (pinned in scripts/ci/install-bun.sh). Install it with: iex `"& {`$(irm https://bun.com/install.ps1)} -Version $PinnedBun`""
}

if (-not (Test-Path $ApplyPatchesScript)) { Fail "apply-patches script missing: $ApplyPatchesScript" }
if (-not (Test-Path $VerifyLockScript)) { Fail "verify-lock script missing: $VerifyLockScript" }

$PkgJson = Join-Path $RepoRoot "sandbox\orchestrator\package.json"
$Pkg = Get-Content $PkgJson -Raw | ConvertFrom-Json

$Lock = & $VerifyLockScript -RepositoryRoot $RepoRoot -PassThru
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$Fingerprint = $Lock.Fingerprint.Trim()

Log "resolving opencode source (patches/upstream.lock.json)..."
$SrcDirRaw = & $ApplyPatchesScript | Select-Object -Last 1
if ($LASTEXITCODE -ne 0) {
    # opencode-apply-patches.ps1 already printed the real reason via its own Fail();
    # don't let a null/empty $SrcDirRaw mask it behind a .Trim()-on-null crash.
    exit $LASTEXITCODE
}
$SrcDir = "$SrcDirRaw".Trim()
if (-not $SrcDir -or -not (Test-Path (Join-Path $SrcDir ".git"))) {
    Fail "opencode-apply-patches.ps1 did not produce a usable source checkout."
}
$PatchedTree = (git -C $SrcDir rev-parse "HEAD^{tree}").Trim()
Log "src:         $SrcDir"
Log "tree:        $PatchedTree"
Log "fingerprint: $Fingerprint"
Log "output:      $WinOutBin"
Log "output:      $LinuxOutBin"

$VersionForBuild = $Pkg.opencodeVersion -replace '^v', ''

# Fast-skip when output already matches the current fingerprint. -Force
# always rebuilds, even on a cache hit.
if ($Force) {
    Log "-Force set: rebuilding runtime binaries for fingerprint $Fingerprint."
}
elseif ((Test-Path $WinOutBin) -and (Test-Path $WinStamp) -and
        (Test-Path $LinuxOutBin) -and (Test-Path $LinuxStamp)) {
    $WinStampedFingerprint = (Get-Content $WinStamp -Raw).Trim()
    $LinuxStampedFingerprint = (Get-Content $LinuxStamp -Raw).Trim()
    if ($WinStampedFingerprint -eq $Fingerprint -and $LinuxStampedFingerprint -eq $Fingerprint) {
        Log "Runtime binaries already built for fingerprint $Fingerprint - skipped."
        exit 0
    }
}

Log "Building runtime binaries with bun (Windows native + Linux cross-compile)..."
$PkgOpencodeSrc = Join-Path $SrcDir "packages\opencode"

# --os/--cpu "*" also installs the Linux native modules the cross-compile embeds.
Push-Location $SrcDir
try {
    bun install --frozen-lockfile --ignore-scripts --os="*" --cpu="*"
    if ($LASTEXITCODE -ne 0) { Fail "bun install --frozen-lockfile failed (exit $LASTEXITCODE); the runtime lockfile must match its package.json." }
} finally {
    Pop-Location
}

Push-Location $PkgOpencodeSrc
try {
    $env:OPENCODE_VERSION = $VersionForBuild

    # generate.ts embeds a models.dev snapshot in the binary and otherwise fetches
    # https://models.dev/api.json live on every build. That network call has no
    # retry/cache of its own and is fully opaque to this script's pinned-fingerprint
    # cache, so a slow or unreachable models.dev turns into a build failure that has
    # nothing to do with opencode's source. Prefer opencode's own fixture snapshot,
    # which it ships at a fixed path and refreshes periodically (upstream commit
    # a244d82aba, "test(opencode): refresh models.dev fixture") - using it keeps the
    # embedded catalog pinned to the same checkout as everything else this script
    # builds, rather than whatever models.dev happens to answer on a given day.
    $ModelsFixture = Join-Path $PkgOpencodeSrc "test\tool\fixtures\models-api.json"
    $CallerModelsDevApiJson = $env:MODELS_DEV_API_JSON
    if ($CallerModelsDevApiJson) {
        Log "MODELS_DEV_API_JSON already set by caller ($CallerModelsDevApiJson); leaving it alone."
    } elseif (Test-Path $ModelsFixture) {
        $env:MODELS_DEV_API_JSON = $ModelsFixture
        Log "using bundled models.dev fixture: $ModelsFixture"
    } else {
        Log "no bundled models.dev fixture at $ModelsFixture; build.ts will fetch https://models.dev/api.json live."
    }

    # build.ts builds every target, including Linux.
    bun run script/build.ts --baseline --skip-install
    if ($LASTEXITCODE -ne 0) { Fail "bun build failed (exit $LASTEXITCODE)" }

    $winBin = Get-ChildItem -Path "dist" -Recurse -Filter "opencode.exe" |
              Where-Object { $_.FullName -match 'windows-x64' } |
              Select-Object -First 1
    if (-not $winBin) { Fail "Windows opencode.exe not found in dist/ after build." }

    New-Item -ItemType Directory -Force -Path $WinOutDir | Out-Null
    Copy-Item $winBin.FullName $WinOutBin -Force
    [System.IO.File]::WriteAllText($WinStamp, $Fingerprint, [System.Text.UTF8Encoding]::new($false))
    $WinSize = (Get-Item $WinOutBin).Length
    Log "OK. Wrote $WinOutBin"
    Log "    size:        $WinSize bytes"
    Log "    tree:        $PatchedTree"
    Log "    fingerprint: $Fingerprint"

    $linuxBin = Join-Path "dist" "opencode-linux-x64-baseline\bin\opencode"
    if (-not (Test-Path $linuxBin)) { Fail "Linux opencode not found at $linuxBin after build." }
    $elf = [byte[]]::new(4)
    $stream = [System.IO.File]::OpenRead((Resolve-Path $linuxBin).Path)
    try { $stream.Read($elf, 0, 4) | Out-Null } finally { $stream.Close() }
    if (-not ($elf[0] -eq 0x7F -and $elf[1] -eq 0x45 -and $elf[2] -eq 0x4C -and $elf[3] -eq 0x46)) {
        Fail "$linuxBin is not a Linux ELF binary."
    }
    Copy-Item $linuxBin $LinuxOutBin -Force
    [System.IO.File]::WriteAllText($LinuxStamp, $Fingerprint, [System.Text.UTF8Encoding]::new($false))
    $LinuxSize = (Get-Item $LinuxOutBin).Length
    Log "OK. Wrote $LinuxOutBin"
    Log "    size:        $LinuxSize bytes"
    Log "    tree:        $PatchedTree"
    Log "    fingerprint: $Fingerprint"
} finally {
    Pop-Location
    Remove-Item Env:OPENCODE_VERSION -ErrorAction SilentlyContinue
    Remove-Item Env:MODELS_DEV_API_JSON -ErrorAction SilentlyContinue
}

exit 0

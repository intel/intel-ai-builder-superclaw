# build-ui.ps1 — Build the SuperClaw desktop UI and sync the executable
#
# Runs a Tauri build (debug or release) and copies the resulting SuperClaw.exe
# into build/<Configuration>/ for production deployment.
#
# Prerequisites:
#   - Node.js + pnpm on the host
#   - Rust toolchain + Tauri prerequisites (WebView2, MSVC build tools)
#
# Usage (from repo root):
#   powershell -ExecutionPolicy Bypass -File packaging\installer\build-ui.ps1
#   powershell -ExecutionPolicy Bypass -File packaging\installer\build-ui.ps1 -Configuration Release
#   powershell -ExecutionPolicy Bypass -File packaging\installer\build-ui.ps1 -SkipBuild
#
# Output:
#   build/<Configuration>/SuperClaw.exe   (Tauri desktop binary)

param(
    [ValidateSet('Debug','Release')] [string]$Configuration = 'Debug',
    [switch]$SkipBuild,
    [switch]$CleanUIDependencies,
    # Run the dependency cleanup (-CleanUIDependencies) and then stop, without
    # building or copying the binary. Used by build-superclaw.ps1 to perform the
    # cleanup + reinstall ONCE, serially, before the parallel build steps —
    # node_modules is a shared resource and must not be reinstalled concurrently.
    [switch]$CleanDependenciesOnly
)

$ErrorActionPreference = 'Stop'

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding           = [System.Text.Encoding]::UTF8
$null = chcp 65001 2>$null

$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir    = Resolve-Path "$ScriptDir\..\.."
# Agent/sandbox shells may redirect Rust output; always use the repo target dir.
$env:CARGO_TARGET_DIR = (Join-Path $RootDir "apps\desktop\src-tauri\target")
$OutDir     = Join-Path $RootDir "build\$Configuration"
$ExeName    = "SuperClaw.exe"
$TargetExe  = Join-Path $OutDir $ExeName

if ($Configuration -eq 'Debug') {
    $TauriOut = Join-Path $RootDir "apps\desktop\src-tauri\target\debug"
} else {
    $TauriOut = Join-Path $RootDir "apps\desktop\src-tauri\target\release"
}
$SourceExe = Join-Path $TauriOut $ExeName

# Per-step timing. No-op unless the parent build set SUPERCLAW_BUILD_TIMING_DIR.
. (Join-Path $PSScriptRoot 'build-timing.ps1')

function Remove-DirectoryWithLongPaths {
    param([string]$Path)
    # Use the \\?\ extended-length prefix so cmd's rd /s /q handles MAX_PATH-busting pnpm trees.
    $longPath = "\\?\$($Path.TrimEnd('\'))"
    & cmd /c "rd /s /q `"$longPath`""
    if ($LASTEXITCODE -ne 0) {
        throw "rd /s /q failed for: $Path"
    }
}

function Invoke-UIDependencyCleanup {
    Write-Host ""
    Write-Host "============================================" -ForegroundColor Yellow
    Write-Host "  Cleaning UI Build Dependencies" -ForegroundColor Yellow
    Write-Host "============================================" -ForegroundColor Yellow

    Push-Location $RootDir

    try {
        # Clean OUR crate's artifacts only. `cargo clean` (no -p) also wipes every
        # dependency's compiled output -- ~4.9 GB under src-tauri\target that is
        # pinned byte-for-byte by Cargo.lock and cannot go stale, so removing it
        # buys no cleanliness and forces a full cold rebuild. -p superclaw keeps
        # the dependency artifacts and still guarantees our own code is rebuilt
        # from scratch.
        $tauriDir = Join-Path $RootDir "apps\desktop\src-tauri"
        if (Test-Path $tauriDir) {
            Write-Host "[Clean] cargo clean -p superclaw" -ForegroundColor Cyan
            Push-Location $tauriDir
            try {
                & cargo clean -p superclaw
                if ($LASTEXITCODE -ne 0) { throw "cargo clean -p superclaw failed." }
            } finally {
                Pop-Location
            }
        } else {
            Write-Host "[Clean] cargo clean - skipped (src-tauri not found)" -ForegroundColor DarkGray
        }

        # Remove all node_modules
        Write-Host "[Clean] Removing node_modules..." -ForegroundColor Cyan

        $nodeModulesDirs = Get-ChildItem `
            -Path $RootDir `
            -Recurse `
            -Filter "node_modules" `
            -Directory `
            -ErrorAction SilentlyContinue |
        Where-Object {
            $_.Parent.FullName -notmatch '\\node_modules(\\|$)'
        } |
        Sort-Object { $_.FullName.Length } -Descending

        if ($nodeModulesDirs) {
            foreach ($dir in $nodeModulesDirs) {
                Write-Host "  Removing $($dir.FullName)" -ForegroundColor DarkGray
                Remove-DirectoryWithLongPaths -Path $dir.FullName
            }
        } else {
            Write-Host "  No node_modules found - skipped" -ForegroundColor DarkGray
        }

        # The pnpm store is deliberately NOT pruned. It is content-addressed and
        # integrity-checked, so it cannot go stale the way node_modules can --
        # pruning it only forces every package to be re-downloaded. Removing
        # node_modules above is what actually guarantees a clean dependency tree;
        # keeping the store lets the reinstall below relink from disk with no
        # network at all.
        Write-Host "[Clean] pnpm install --frozen-lockfile (relinking from the preserved store)" -ForegroundColor Cyan

        & pnpm install --frozen-lockfile

        if ($LASTEXITCODE -ne 0) {
            throw "pnpm install failed."
        }
    }
    finally {
        Pop-Location
    }

    Write-Host ""
    Write-Host "[Clean] UI dependencies refreshed." -ForegroundColor Green
    Write-Host ""
}


# ── Banner ─────────────────────────────────────────────────────────
Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  SuperClaw UI - Build & Sync"                -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  Configuration: $Configuration" -ForegroundColor DarkCyan
Write-Host ""

if ($CleanUIDependencies -or $CleanDependenciesOnly) {
    Invoke-UIDependencyCleanup
}

# When invoked only to prepare dependencies (serial pre-step from the
# orchestrator), stop here — the actual Tauri build runs later in the parallel
# pool without re-touching node_modules.
if ($CleanDependenciesOnly) {
    Write-Host "[clean-only] Dependency preparation complete; skipping build." -ForegroundColor Green
    exit 0
}

if (-not $SkipBuild) {
    if ($Configuration -eq 'Debug') {
        Write-Host "[1/3] Running 'pnpm tauri build --debug' (Tauri debug build)..." -ForegroundColor Cyan
    } else {
        Write-Host "[1/3] Running 'pnpm tauri build' (Tauri release build)..." -ForegroundColor Cyan
    }
    Write-Host "  This compiles the SolidJS frontend and the Rust binary." -ForegroundColor DarkGray
    Write-Host ""

    $hadBuildDebug = Test-Path Env:BUILD_DEBUG
    $prevBuildDebug = $env:BUILD_DEBUG

    $tauriStart = Get-Date
    Push-Location $RootDir
    try {
        if ($Configuration -eq 'Debug') {
            $env:BUILD_DEBUG = '1'
            & pnpm tauri build --debug --no-bundle
        } else {
            Remove-Item Env:BUILD_DEBUG -ErrorAction SilentlyContinue
            & pnpm tauri build --no-bundle
        }
        if ($LASTEXITCODE -ne 0) {
            Write-BuildTiming -Label 'pnpm tauri build' -Start $tauriStart -Scope 'ui' -Status 'failed'
            Write-Error "Tauri build failed (exit code $LASTEXITCODE). Fix errors and retry."
            exit 1
        }
    } finally {
        if ($hadBuildDebug) {
            $env:BUILD_DEBUG = $prevBuildDebug
        } else {
            Remove-Item Env:BUILD_DEBUG -ErrorAction SilentlyContinue
        }
        Pop-Location
    }
    Write-BuildTiming -Label 'pnpm tauri build' -Start $tauriStart -Scope 'ui'

    Write-Host ""
    Write-Host "  Build completed successfully." -ForegroundColor Green
} else {
    Write-Host "[1/3] Skipping build (--SkipBuild)." -ForegroundColor DarkGray
    Write-Host "  Assuming '$ExeName' already exists at $TauriOut." -ForegroundColor DarkGray
}

# ── Step 2: Copy SuperClaw.exe to build/<Configuration> ──────────
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null

Write-Host "[2/3] Copying $ExeName to build\$Configuration\..." -ForegroundColor Cyan

if (-not (Test-Path $SourceExe)) {
    Write-Error "Source binary not found: $SourceExe`nRun without -SkipBuild, or verify the Tauri build succeeded."
    exit 1
}

Copy-Item -Path $SourceExe -Destination $TargetExe -Force

$sizeMB = [math]::Round((Get-Item $TargetExe).Length / 1MB, 1)
$sha256 = (Get-FileHash -Path $TargetExe -Algorithm SHA256).Hash.Substring(0, 16)
Write-Host "  Copied ${ExeName}: $sizeMB MB (SHA256: $sha256...)" -ForegroundColor Green

# `--no-bundle` (used above) skips Tauri's normal bundling step, but at COMPILE
# time tauri-build's own build script already resolves each `bundle.externalBin`
# entry and copies it (target-triple suffix stripped) into $TauriOut next to the
# main exe -- e.g. `sidecars/opencode` -> "$TauriOut\opencode.exe". That is the exact
# layout `Command::sidecar()` looks for relative to the running exe at runtime,
# so we mirror those same files into $OutDir instead of re-deriving names
# ourselves; a stale/missing entry here would silently break that sidecar.
$TauriConfPath = Join-Path $RootDir "apps\desktop\src-tauri\tauri.conf.json"
$externalBin = (Get-Content $TauriConfPath -Raw | ConvertFrom-Json).bundle.externalBin
if ($externalBin) {
    Write-Host "  Syncing sidecars to build\$Configuration\..." -ForegroundColor Cyan
    foreach ($entry in $externalBin) {
        $sidecarName = Split-Path $entry -Leaf
        $sidecarSource = Join-Path $TauriOut "$sidecarName.exe"
        if (Test-Path $sidecarSource) {
            Copy-Item -Path $sidecarSource -Destination $OutDir -Force
            Write-Host "    $sidecarName.exe" -ForegroundColor DarkGray
        } else {
            Write-Host "    [WARN] $sidecarSource not found; '$sidecarName' will fail to start at runtime." -ForegroundColor Yellow
        }
    }
} else {
    Write-Host "  [WARN] No bundle.externalBin entries found in tauri.conf.json; skipping sidecar sync." -ForegroundColor Yellow
}

# ── Step 3: Verify resource ───────────────────────────────────────
Write-Host "[3/3] Verifying resource..." -ForegroundColor Cyan

if (Test-Path $TargetExe) {
    $size = [math]::Round((Get-Item $TargetExe).Length / 1MB, 1)
    Write-Host "  [OK] $ExeName ($size MB)" -ForegroundColor Green
} else {
    Write-Host "  [X]  $ExeName - MISSING" -ForegroundColor Red
    Write-Error "Resource verification failed."
    exit 1
}

# Compare source vs target hashes to ensure copy integrity
$srcHash = (Get-FileHash -Path $SourceExe -Algorithm SHA256).Hash
$dstHash = (Get-FileHash -Path $TargetExe -Algorithm SHA256).Hash
if ($srcHash -ne $dstHash) {
    Write-Error "Hash mismatch between source and copied binary!"
    exit 1
} else {
    Write-Host "  [OK] Source/target SHA256 match" -ForegroundColor Green
}

# ── Summary ───────────────────────────────────────────────────────
Write-Host ""
Write-Host "============================================" -ForegroundColor Green
Write-Host "  UI Build & Sync Complete"                   -ForegroundColor Green
Write-Host "============================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Configuration:   $Configuration" -ForegroundColor DarkGray
Write-Host "  Output dir:      $OutDir" -ForegroundColor DarkGray
Write-Host "  Binary:          $TargetExe"   -ForegroundColor DarkGray
Write-Host ""
Write-Host "  Next steps:" -ForegroundColor Cyan
Write-Host "    Build the installer (MSI):"
Write-Host "      powershell -File packaging\installer\build-superclaw.ps1"
Write-Host "============================================" -ForegroundColor Green

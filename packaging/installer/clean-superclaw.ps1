#Requires -Version 5.1
<#
.SYNOPSIS
    Purge SuperClaw local build/runtime state without rebuilding product artifacts.

.DESCRIPTION
    The uninstall half of build-superclaw.ps1. It performs exactly the same
    runtime-state purge as build-superclaw.ps1 -Clean, then stops — it never
    builds ServiceHub, the UI, the trajectory inspector, or
    the installer, and it never runs the capability-hash regeneration step.

    Runtime purge (the "runtime state" referred to below) is:
      1. Kill SuperClaw.exe.
      2. Kill sandbox_manager.exe.
      3. Kill superclaw-services.exe and its child services (llmrouter_manager,
         privacy_manager), plus superclaw-trajectory.exe — the latter runs
         outside any job object by design and holds log files open, which would
         otherwise block step 5.
        4. Revoke the owner-by-tier accounts with the signed broker, then remove any
         legacy SC*Tier fixed accounts, their profiles and their credentials.
        5. Delete %LOCALAPPDATA%\SuperClaw entirely (all ServiceHub child-service
         state: servicehub, sandbox_manager, llmrouter_manager, privacy_manager
         — resources + logs + db written at runtime).
        6. Delete %LOCALAPPDATA%\com.aibuilder.superclaw (Tauri app-data store).

    Missing processes, directories, accounts, and credentials
    are safely skipped. Account reset is fail-closed: if the elevated steps cannot
    remove both machine accounts and user-scoped credentials, the script stops before
    deleting the runtime tree so it cannot manufacture a half-provisioned identity.

    Repository build artefacts are deliberately NOT touched. build\Debug,
    build\Release and build\_logs are left alone, matching what
    build-superclaw.ps1 -Clean does (and does not do).

.PARAMETER Clean
    Runtime purge (steps 1-6) PLUS the UI dependency cleanup:
      cargo clean, remove every node_modules, pnpm store prune.
    NOTE: unlike build-superclaw.ps1 -Clean, this script stops there — it does
    NOT run 'pnpm install --frozen-lockfile', because reinstalling dependencies
    is a build action. The next build-superclaw.ps1 run installs them itself.
    Equivalent to -CleanRuntimeOnly -CleanUIDependencies.
    Can also be specified as -C.

.PARAMETER CleanRuntimeOnly
    Runtime purge (steps 1-6) only; skips the UI dependency cleanup. This is
    also the default when no clean flag is supplied at all.
    Mutually exclusive with -Clean. Can also be specified as -CRO.

.PARAMETER CleanUIDependencies
    UI dependency cleanup only (cargo clean, remove node_modules, pnpm store
    prune). On its own it does NOT perform the runtime purge, matching how
    build-superclaw.ps1 forwards this flag to build-ui.ps1. Combine with
    -CleanRuntimeOnly (or just use -Clean) to do both.
    Can also be specified as -CUD.

.PARAMETER KeepModels
    Preserve downloaded model files under
    %LOCALAPPDATA%\SuperClaw\llmrouter_manager\models\ and
    %LOCALAPPDATA%\SuperClaw\privacy_manager\models\ so they do not need to be
    re-downloaded. Also preserves only the matching model-verification rows from
    llmrouter_manager.db, avoiding a full rehash while all unrelated runtime
    state is still reset. Only meaningful with a runtime purge.
    Can also be specified as -KM.

.EXAMPLE
    # Default: runtime purge only (same as -CleanRuntimeOnly)
    powershell -ExecutionPolicy Bypass -File packaging\installer\clean-superclaw.ps1

.EXAMPLE
    # Full purge including UI dependency cleanup, but keep the downloaded models
    powershell -ExecutionPolicy Bypass -File packaging\installer\clean-superclaw.ps1 -Clean -KM

.EXAMPLE
    # Reset first-run provisioning but keep the downloaded models
    powershell -ExecutionPolicy Bypass -File packaging\installer\clean-superclaw.ps1 -CRO -KM

.EXAMPLE
    # Only refresh UI build dependencies; leave runtime state alone
    powershell -ExecutionPolicy Bypass -File packaging\installer\clean-superclaw.ps1 -CleanUIDependencies
#>
param(
    # Runtime purge + UI dependency cleanup (no pnpm install).
    [Alias('C')][switch]$Clean,

    # Runtime purge only. Also the default when no clean flag is given.
    [Alias('CRO')][switch]$CleanRuntimeOnly,

    # UI dependency cleanup only (cargo clean / node_modules / pnpm store prune).
    [Alias('CUD')][switch]$CleanUIDependencies,

    # Keep downloaded model files when purging runtime state.
    [Alias('KM')][switch]$KeepModels
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding           = [System.Text.Encoding]::UTF8
$null = chcp 65001 2>$null

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir   = Resolve-Path "$ScriptDir\..\.."

# Set once the script starts mutating state, so the trap further down can tell
# an argument-validation failure (nothing touched) apart from a mid-purge
# failure (state partially removed). Declared up here because the trap reads it
# and Set-StrictMode makes an undefined read a secondary error.
$MutationStarted = $false

# ── Helpers ──────────────────────────────────────────────────────

# Kill every instance of a process by name, best-effort. taskkill is used
# instead of Stop-Process because /T also takes down the child tree (e.g. the
# ServiceHub-managed children) and it does not fail the script when the process
# has already exited.
function Stop-ProcessByName {
    param(
        [Parameter(Mandatory)][string]$Name,
        [int]$SettleMs = 1000
    )

    $processes = @(Get-Process -Name $Name -ErrorAction SilentlyContinue)
    if ($processes.Count -eq 0) {
        Write-Host "[Clean] $Name.exe not running." -ForegroundColor DarkGray
        return
    }

    foreach ($proc in $processes) {
        Write-Host "[Clean] Stopping $Name.exe (PID $($proc.Id))..." -ForegroundColor Yellow
        $prevEAP = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        & taskkill /F /T /PID $proc.Id 2>$null | Out-Null
        $ErrorActionPreference = $prevEAP
    }

    Start-Sleep -Milliseconds $SettleMs
}

function Stop-SuperClawProcesses {
    # Order matters: the app first, then ServiceHub, then its children, so a
    # supervisor does not restart a child we just killed.
    Stop-ProcessByName -Name 'SuperClaw'          -SettleMs 2000
    Stop-ProcessByName -Name 'sandbox_manager'    -SettleMs 2000
    # Every role of the merged bundle runs as superclaw-services.exe; 'servicehub'
    # is the pre-rename image, still killed so a clean works on a machine whose
    # last build predates the rename.
    Stop-ProcessByName -Name 'superclaw-services' -SettleMs 1000
    Stop-ProcessByName -Name 'servicehub'         -SettleMs 1000
    Stop-ProcessByName -Name 'llmrouter_manager'  -SettleMs 1000
    Stop-ProcessByName -Name 'privacy_manager'   -SettleMs 1000
    # superclaw-trajectory.exe is launched by sandbox_manager with
    # CREATE_NEW_PROCESS_GROUP and deliberately NOT placed in a Windows job
    # object (see trajectory_inspector.py), so it survives the kills above and
    # keeps trajectory-inspector.log open — which would block the state-dir
    # removal below. It must be stopped explicitly.
    Stop-ProcessByName -Name 'superclaw-trajectory' -SettleMs 1000
}

function Invoke-RuntimePurge {
    param([switch]$KeepModels)

    Write-Host ""
    Write-Host "============================================" -ForegroundColor Yellow
    Write-Host "  Purging SuperClaw runtime state" -ForegroundColor Yellow
    if ($KeepModels) {
        Write-Host "  (-KeepModels: model files will be preserved)" -ForegroundColor Yellow
    }
    Write-Host "============================================" -ForegroundColor Yellow

    # Steps 1-3: stop everything holding the state dirs open.
    Stop-SuperClawProcesses

    # Step 4: The signed broker revokes owner-by-tier identity state first; the helper
    # then removes any fixed-account state left by the deleted legacy launchers.
    # Any UAC cancellation or partial failure aborts before runtime state deletion.
    & (Join-Path $ScriptDir 'reset-windows-sandbox-accounts.ps1') `
        -RootDir $RootDir `
        -LogPrefix 'Clean'

    # Step 5: Delete the entire %LOCALAPPDATA%\SuperClaw tree. ServiceHub and
    # each of its child services write runtime state (resources + logs +
    # db) into their own sibling dir under this root, so wiping the root clears
    # them all in one shot.
    $superClawStateDir = Join-Path $env:LOCALAPPDATA 'SuperClaw'
    if (Test-Path $superClawStateDir) {
        # Preserve selected items by moving them aside before the recursive
        # wipe, then restoring them to their original relative locations.
        #   -KeepModels : llmrouter_manager\models\, privacy_manager\models\ and
        #                 model verification rows
        $preserve = @()
        if ($KeepModels) {
            $preserve += @{
                RelPath = 'llmrouter_manager\models'
                Temp    = (Join-Path $env:TEMP "superclaw_models_backup_$PID")
                Moved   = $false
                Label   = 'model files'
            }
            $preserve += @{
                RelPath = 'privacy_manager\models'
                Temp    = (Join-Path $env:TEMP "superclaw_privacy_models_backup_$PID")
                Moved   = $false
                Label   = 'privacy model files'
            }
            $verificationDb = Join-Path $superClawStateDir 'llmrouter_manager\llmrouter_manager.db'
            if (Test-Path $verificationDb) {
                if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
                    throw "Cannot preserve model verification state: 'uv' is not installed."
                }
                $verificationBackup = Join-Path $env:TEMP "superclaw_model_verifications_backup_$PID.db"
                $lrmDir = Join-Path $RootDir 'host\llmrouter_manager'
                $exportScript = Join-Path $lrmDir 'scripts\export_model_verifications.py'
                Write-Host "[Clean] Exporting model verification state: $verificationDb -> $verificationBackup" -ForegroundColor DarkGray
                $prevPref = $ErrorActionPreference
                $ErrorActionPreference = 'Continue'
                try {
                    & uv run --directory $lrmDir python $exportScript $verificationDb $verificationBackup
                } finally {
                    $ErrorActionPreference = $prevPref
                }
                if ($LASTEXITCODE -ne 0) {
                    throw "Failed to preserve model verification state (exit $LASTEXITCODE)."
                }
                $preserve += @{
                    RelPath = 'llmrouter_manager\llmrouter_manager.db'
                    Temp    = $verificationBackup
                    Moved   = $true
                    Label   = 'model verification state'
                }
            }
        }

        foreach ($item in $preserve) {
            if ($item.Moved) { continue }
            $srcPath = Join-Path $superClawStateDir $item.RelPath
            if (Test-Path $srcPath) {
                Write-Host "[Clean] Preserving $($item.Label): $srcPath -> $($item.Temp)" -ForegroundColor DarkGray
                Move-Item -LiteralPath $srcPath -Destination $item.Temp -Force
                $item.Moved = $true
            } else {
                Write-Host "[Clean] No $($item.Label) found at $srcPath, nothing to preserve." -ForegroundColor DarkGray
            }
        }

        Write-Host "[Clean] Removing $superClawStateDir ..." -ForegroundColor DarkGray
        Remove-Item -LiteralPath $superClawStateDir -Recurse -Force
        Write-Host "[Clean] Removed $superClawStateDir" -ForegroundColor Green

        foreach ($item in $preserve) {
            if (-not $item.Moved) { continue }
            $restorePath = Join-Path $superClawStateDir $item.RelPath
            New-Item -ItemType Directory -Path (Split-Path $restorePath) -Force | Out-Null
            Move-Item -LiteralPath $item.Temp -Destination $restorePath -Force
            Write-Host "[Clean] Restored $($item.Label) to $restorePath" -ForegroundColor Green
        }
    } else {
        Write-Host "[Clean] $superClawStateDir not found, skipping." -ForegroundColor DarkGray
    }

    # Step 6: Delete %LOCALAPPDATA%\com.aibuilder.superclaw (Tauri app-data).
    $tauriDir = Join-Path $env:LOCALAPPDATA 'com.aibuilder.superclaw'
    if (Test-Path $tauriDir) {
        Write-Host "[Clean] Removing $tauriDir ..." -ForegroundColor DarkGray
        Remove-Item -LiteralPath $tauriDir -Recurse -Force
        Write-Host "[Clean] Removed $tauriDir" -ForegroundColor Green
    } else {
        Write-Host "[Clean] $tauriDir not found, skipping." -ForegroundColor DarkGray
    }

    Write-Host ""
    Write-Host "[Clean] Runtime state purged." -ForegroundColor Green
}

function Remove-DirectoryWithLongPaths {
    param([Parameter(Mandatory)][string]$Path)
    # Use the \\?\ extended-length prefix so cmd's rd /s /q handles
    # MAX_PATH-busting pnpm trees.
    $longPath = "\\?\$($Path.TrimEnd('\'))"
    & cmd /c "rd /s /q `"$longPath`""
    if ($LASTEXITCODE -ne 0) {
        throw "rd /s /q failed for: $Path"
    }
}

function Invoke-UIDependencyCleanup {
    Write-Host ""
    Write-Host "============================================" -ForegroundColor Yellow
    Write-Host "  Cleaning UI build dependencies" -ForegroundColor Yellow
    Write-Host "  (no pnpm install - the next build installs)" -ForegroundColor Yellow
    Write-Host "============================================" -ForegroundColor Yellow

    Push-Location $RootDir
    try {
        # cargo clean
        $tauriDir = Join-Path $RootDir 'apps\desktop\src-tauri'
        if (Test-Path $tauriDir) {
            Write-Host "[Clean] cargo clean" -ForegroundColor Cyan
            Push-Location $tauriDir
            try {
                & cargo clean
                if ($LASTEXITCODE -ne 0) { throw "cargo clean failed." }
            } finally {
                Pop-Location
            }
        } else {
            Write-Host "[Clean] cargo clean - skipped (src-tauri not found)" -ForegroundColor DarkGray
        }

        # Remove all node_modules
        Write-Host "[Clean] Removing node_modules..." -ForegroundColor Cyan
        $nodeModulesDirs = @(
            Get-ChildItem -Path $RootDir -Recurse -Filter 'node_modules' -Directory -ErrorAction SilentlyContinue |
                Where-Object { $_.Parent.FullName -notmatch '\\node_modules(\\|$)' } |
                Sort-Object { $_.FullName.Length } -Descending
        )
        if ($nodeModulesDirs.Count -gt 0) {
            foreach ($dir in $nodeModulesDirs) {
                Write-Host "  Removing $($dir.FullName)" -ForegroundColor DarkGray
                Remove-DirectoryWithLongPaths -Path $dir.FullName
            }
        } else {
            Write-Host "  No node_modules found - skipped" -ForegroundColor DarkGray
        }

        # Prune pnpm store
        Write-Host "[Clean] pnpm store prune" -ForegroundColor Cyan
        & pnpm store prune
        if ($LASTEXITCODE -ne 0) { throw "pnpm store prune failed." }
    } finally {
        Pop-Location
    }

    Write-Host ""
    Write-Host "[Clean] UI dependencies cleaned." -ForegroundColor Green
}

# ── Argument resolution ──────────────────────────────────────────

if ($Clean -and $CleanRuntimeOnly) {
    throw "-Clean and -CleanRuntimeOnly are mutually exclusive. -Clean is the runtime purge plus the UI dependency cleanup; -CleanRuntimeOnly is the runtime purge alone. Pick one."
}

# -CleanUIDependencies on its own means "UI dependencies only", matching how
# build-superclaw.ps1 forwards that flag to build-ui.ps1. With no flags at all,
# a script named clean-superclaw should still do the thing it is named for, so
# the runtime purge is the default.
$DoRuntimePurge = $Clean -or $CleanRuntimeOnly -or (-not $CleanUIDependencies)
$DoUIDepClean   = $Clean -or $CleanUIDependencies

if (-not $DoRuntimePurge -and $KeepModels) {
    Write-Warning "-KeepModels only affects the runtime purge, which is not running (-CleanUIDependencies was given on its own). Ignoring."
}

$Elapsed = [System.Diagnostics.Stopwatch]::StartNew()

trap {
    Write-Host ""
    Write-Host "############################################" -ForegroundColor Red
    Write-Host "  CLEAN FAILED" -ForegroundColor Red
    Write-Host "############################################" -ForegroundColor Red
    Write-Host "  Error : $_" -ForegroundColor Red
    Write-Host ""
    if ($MutationStarted) {
        Write-Host "  Local state may be partially purged. Re-running this script is safe." -ForegroundColor Yellow
        Write-Host "  If a directory removal failed, a SuperClaw process is probably still" -ForegroundColor Yellow
        Write-Host "  holding a log file open - check Task Manager for SuperClaw.exe," -ForegroundColor Yellow
        Write-Host "  superclaw-services.exe, sandbox_manager.exe, or superclaw-trajectory.exe." -ForegroundColor Yellow
    } else {
        Write-Host "  Nothing was removed. Fix the arguments and re-run." -ForegroundColor Yellow
    }
    Write-Host "############################################" -ForegroundColor Red
    Write-Host ""
    exit 1
}

# ── Run ──────────────────────────────────────────────────────────

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  clean-superclaw.ps1" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  Repo root      : $RootDir" -ForegroundColor DarkGray
Write-Host "  Runtime purge  : $DoRuntimePurge" -ForegroundColor DarkGray
Write-Host "  UI dep cleanup : $DoUIDepClean" -ForegroundColor DarkGray
Write-Host "  Product artefacts are not rebuilt; the elevated account helper may be compiled." -ForegroundColor DarkGray

$MutationStarted = $true

if ($DoRuntimePurge) {
    Invoke-RuntimePurge -KeepModels:$KeepModels
}

if ($DoUIDepClean) {
    Invoke-UIDependencyCleanup
}

Write-Host ""
Write-Host "============================================" -ForegroundColor Green
Write-Host "  clean-superclaw.ps1 complete" -ForegroundColor Green
Write-Host ("  Total time: {0:mm\:ss} ({1:F0}s)" -f $Elapsed.Elapsed, $Elapsed.Elapsed.TotalSeconds) -ForegroundColor Green
Write-Host "  Next: packaging\installer\build-superclaw.ps1" -ForegroundColor Green
Write-Host "============================================" -ForegroundColor Green
Write-Host ""

#Requires -Version 5.1
<#
.SYNOPSIS
    Unified one-click build for SuperClaw.

.DESCRIPTION
    Runs the full build in order:
    2. build-servicehub.ps1       - ServiceHub + completed subservices (includes sandbox_manager)
    3. build-ui.ps1               - unless -SkipUI
     4. scripts\native-backend\build-native-backend.ps1 - the Windows-native backend
         payload. Runs after ServiceHub because
         Release staging writes into build\Release\servicehub\native-backend,
         which the installer packages.
    5. Debug only local sync: copies the trajectory inspector to
       %LOCALAPPDATA%\SuperClaw\sandbox_manager\resources\ - unless -SkipLocalSync
    6. Release only: advinst\build-installer.ps1 (skipped if -SkipInstaller)

    Windows-native is the only backend, so there is no sandbox image to build.

    All steps use -Configuration to select Debug or Release behavior.
    Default configuration is Debug; the installer step is skipped in Debug mode.

.PARAMETER Configuration
    Debug (default) or Release. Controls all sub-scripts and whether the
    installer is packaged.

.PARAMETER SkipNativeBackend
    Skip scripts\native-backend\build-native-backend.ps1 and
    reuse the payload already staged for this configuration; errors if that
    payload is absent.

.PARAMETER SkipLocalSync
    Skip copying runtime resources to %LOCALAPPDATA%\SuperClaw\sandbox_manager\resources\.
    Only applies to Debug builds. Release relies on the Advanced Installer EXE to
    install resources.

.PARAMETER SkipServiceHub
    Skip building build\<Configuration>\servicehub.

.PARAMETER SkipUI
    Skip building and syncing build\<Configuration>\SuperClaw.exe.

.PARAMETER SkipInstaller
    Skip the Advanced Installer build step even in Release mode. Preserved from
    old script for backward compatibility.

.PARAMETER Rebuild
    Forward -Rebuild to advinst\build-installer.ps1 (incremental vs full rebuild).
    Preserved from old script for backward compatibility.

.PARAMETER RunInstallerBackendBuild
    Backward-compatible no-op. There is no backend image to build.

.PARAMETER Sign
    Authenticode-sign the native backend payload before its manifest is written, and
    (Release only) forward -Sign to the installer build step.
    A signed installer build REQUIRES this: Advanced Installer signs the payload
    executables itself, which invalidates a manifest written before signing.
    Nothing on the Debug path requires a signature (the client-side broker trust gate
    is gone), so -Sign is optional there.
    No certificate in Cert:\CurrentUser\My is not an error — the payload then ships
    unsigned and the manifest describes those unsigned bytes.

.PARAMETER SigningCertificateThumbprint
    (With -Sign) Thumbprint of the code-signing certificate in Cert:\CurrentUser\My
    to sign the native payload with. Required when the store holds more than one
    code-signing certificate — the signing step refuses to guess.
    See scripts\native-backend\payload-signing-policy.ps1.

.PARAMETER SigningCertificateSubject
    (With -Sign) Alternative to -SigningCertificateThumbprint: the exact Subject of
    the certificate to use, e.g. 'CN=Example Corp'.

.PARAMETER Version
    (Release only) Override installer base/product version. Ignored in Debug.
    A three-part value (x.y.z) receives the build-date suffix automatically.
    A four-part value (x.y.z.n) is used as-is.

.PARAMETER Build
    (Release only) Forward -Build to advinst\build-installer.ps1. Default: DefaultBuild.

.PARAMETER AipName
    (Release only) .aip project filename. Default: SuperClaw.aip.

.PARAMETER AdvancedInstallerCom
    (Release only) Path to AdvancedInstaller.com. Default: standard install location.

.PARAMETER Clean
    Before building, purge all previous artefacts and runtime state:
      1. Kill any running SuperClaw.exe.
      2. Kill any running sandbox_manager.exe.
        4. Revoke the owner-by-tier accounts with the signed broker, then remove any
         legacy SC*Tier fixed accounts, their profiles and their credentials.
        5. Delete %LOCALAPPDATA%\SuperClaw entirely (all ServiceHub child-service
         state: servicehub, sandbox_manager, llmrouter_manager, privacy_manager —
         resources + logs + db written at runtime).
        6. Delete %LOCALAPPDATA%\com.aibuilder.superclaw (Tauri app-data store).
        7. Performs UI dependency cleanup (cargo clean, remove node_modules, pnpm store prune, pnpm install).
    Can also be specified as -C.
    Missing processes, directories, accounts, and credentials
    are safely skipped. Account reset is fail-closed: failure or UAC cancellation
    stops before the runtime tree is deleted.

.PARAMETER CleanRuntimeOnly
    Purge only runtime state before building, skipping the expensive UI
    dependency full-clean that -Clean performs:
     1-6. Same runtime purge as -Clean steps 1-6 (kill SuperClaw.exe,
           sandbox_manager.exe, servicehub and child services;
         revoke tier accounts and remove legacy SC*Tier state; delete
         %LOCALAPPDATA%\SuperClaw and
           %LOCALAPPDATA%\com.aibuilder.superclaw).
     NOT step 7: does NOT run cargo clean / remove node_modules / pnpm install.
    The Rust/Tauri build runs incrementally against the existing node_modules â€” so
    first-run provisioning is re-exercised without paying for a full dependency
    reinstall. Mutually exclusive with -Clean (passing both is an error).
    Honors -KeepModels. Can also be specified as -CRO.

.PARAMETER KeepModels
    When combined with -Clean or -CleanRuntimeOnly, preserve downloaded model files under
    %LOCALAPPDATA%\SuperClaw\llmrouter_manager\models\ and
    %LOCALAPPDATA%\SuperClaw\privacy_manager\models\ so they do not need
    to be re-downloaded after a clean build. Also preserves only the matching
    model-verification rows from llmrouter_manager.db, avoiding a full rehash
    while all unrelated runtime state is still reset.
    Can also be specified as -KM.

.PARAMETER CleanBackendManager
    Forward -Clean to build-backend-manager.ps1.

.PARAMETER CleanUIDependencies
    Forward to build-ui.ps1.
    Clean UI build dependencies before building.
    Performs:
      1) cargo clean
      2) remove node_modules directories
      3) pnpm store prune
      4) pnpm install
    Useful when troubleshooting Tauri, Cargo, pnpm, or dependency-related build failures.

.PARAMETER SkipUIBuild
    Forward -SkipBuild to build-ui.ps1 (reuse an existing Tauri binary).

.EXAMPLE
    # Default: Debug build, no installer
    powershell -ExecutionPolicy Bypass -File packaging\installer\build-superclaw.ps1

.EXAMPLE
    # Full clean then Debug build (kills processes, wipes app-data)
    powershell -ExecutionPolicy Bypass -File packaging\installer\build-superclaw.ps1 -Clean

.EXAMPLE
    # Verify first-run provisioning WITHOUT the slow UI dependency full-clean.
    # Wipes runtime state, keeps models, and
    # rebuilds incrementally (Rust/node caches reused).
    powershell -ExecutionPolicy Bypass -File packaging\installer\build-superclaw.ps1 -CleanRuntimeOnly -KM

.EXAMPLE
    # Release build with installer
    powershell -ExecutionPolicy Bypass -File packaging\installer\build-superclaw.ps1 -Configuration Release

.EXAMPLE
    # Release, sign, version override. Produces 0.2.0.<Mdd> unless a fourth field is supplied.
    powershell -ExecutionPolicy Bypass -File packaging\installer\build-superclaw.ps1 -Configuration Release -Sign -Version 0.2.0
#>
param(
    [ValidateSet('Debug','Release')] [string]$Configuration = 'Debug',
    [switch]$SkipNativeBackend,
    [switch]$SkipLocalSync,
    [switch]$SkipServiceHub,
    [switch]$SkipUI,
    # Backward-compat installer control flags (Release path)
    [switch]$SkipInstaller,
    [switch]$Rebuild,
    [switch]$RunInstallerBackendBuild,
    # Payload signing. Forwarded for both configurations; only the *installer* signing
    # step below is Release-only.
    [switch]$Sign,
    [string]$SigningCertificateThumbprint,
    [string]$SigningCertificateSubject,
    # Release-only flags (ignored when Debug)
    [string]$Version,
    [ValidateSet('DefaultBuild', 'FullOffline', 'WebBootstrapper', 'MsiOnly', 'All')]
    [string]$Build = 'DefaultBuild',
    [string]$AipName = 'SuperClaw.aip',
    [string]$AdvancedInstallerCom = 'C:\Program Files (x86)\Caphyon\Advanced Installer 22.2\bin\x86\AdvancedInstaller.com',
    # Forwarded flags
    [switch]$SkipUIBuild,

    [switch]$CleanUIDependencies,

    # Clean flag: purge all previous state before building
    [Alias('C')][switch]$Clean,

    # Clean only runtime state (kill processes, wipe %LOCALAPPDATA%\SuperClaw and
    # the Tauri app-data store) so the next launch re-exercises first-run
    # provisioning, WITHOUT the expensive UI dependency full-clean (cargo clean +
    # node_modules removal + pnpm install) that -Clean performs. Mutually
    # exclusive with -Clean. Honors -KeepModels.
    # Can also be specified as -CRO.
    [Alias('CRO')][switch]$CleanRuntimeOnly,

    # Keep downloaded model files when cleaning (avoids re-downloading large models)
    [Alias('KM')][switch]$KeepModels
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding           = [System.Text.Encoding]::UTF8
$null = chcp 65001 2>$null

# Check Windows Long Path support â€” Cargo, pnpm, and PyInstaller can fail with
# path-too-long errors on deeply nested repo/build trees if this is not enabled.
$longPathValue = (Get-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' `
    -Name 'LongPathsEnabled' -ErrorAction SilentlyContinue).LongPathsEnabled
if ($longPathValue -ne 1) {
    Write-Warning "Windows Long Path support is OFF. Run as Administrator then reboot:"
    Write-Host "    Set-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' -Name LongPathsEnabled -Type DWord -Value 1" -ForegroundColor Cyan
} else {
    Write-Host "  [OK] Windows Long Path support is enabled." -ForegroundColor Green
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir   = Resolve-Path "$ScriptDir\..\.."

$NativeBackendScript  = Join-Path $RootDir 'scripts\native-backend\build-native-backend.ps1'
$RuntimeBinScript     = Join-Path $RootDir 'packaging\docker\fetch-runtime-bin.ps1'
$ServiceHubScript     = Join-Path $ScriptDir 'build-servicehub.ps1'
$UiScript             = Join-Path $ScriptDir 'build-ui.ps1'
$InstallerScript      = Join-Path $ScriptDir 'advinst\build-installer.ps1'

# Per-step timing. Initialize-BuildTiming publishes the row directory through
# SUPERCLAW_BUILD_TIMING_DIR, which every child process inherits, so nested
# scripts record into the same run without being passed a parameter.
. (Join-Path $ScriptDir 'build-timing.ps1')
. (Join-Path $RootDir 'scripts\native-backend\payload-verification.ps1')
$BuildStartedAt = Get-Date
$TimingDir      = Initialize-BuildTiming -RepoRoot $RootDir -RunLabel $Configuration

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  build-superclaw.ps1 -Configuration $Configuration" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  Repo root: $RootDir" -ForegroundColor DarkGray
if ($TimingDir) {
    Write-Host "  Timing   : $TimingDir" -ForegroundColor DarkGray
}
Write-Host ""

if ($RunInstallerBackendBuild) {
    Write-Warning "-RunInstallerBackendBuild is accepted for compatibility but ignored. There is no backend image to build."
}

# Helper: invoke a sub-script via a child powershell process, fail-fast.
function Invoke-BuildStep {
    param(
        [Parameter(Mandatory)][string]$Label,
        [Parameter(Mandatory)][string]$ScriptPath,
        [string[]]$Arguments = @()
    )

    if (-not (Test-Path $ScriptPath)) {
        throw "[$Label] Script not found: $ScriptPath"
    }

    Write-Host ""
    Write-Host "--------------------------------------------" -ForegroundColor Cyan
    Write-Host "  $Label" -ForegroundColor Cyan
    Write-Host "--------------------------------------------" -ForegroundColor Cyan
    if ($Arguments.Count -gt 0) {
        Write-Host "  Args: $($Arguments -join ' ')" -ForegroundColor DarkGray
    }
    Write-Host ""

    # Relax ErrorActionPreference around the child invocation: native exes
    # (uv, pyinstaller, taskkill) in the child write progress to stderr,
    # which under Stop preference would be wrapped as NativeCommandError and
    # terminate this script before $LASTEXITCODE is checked. The check below
    # is the authoritative pass/fail signal.
    $prevPref = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $stepStart = Get-Date
    try {
        & powershell -ExecutionPolicy Bypass -File $ScriptPath @Arguments
    } finally {
        $ErrorActionPreference = $prevPref
    }
    if ($LASTEXITCODE -ne 0) {
        Write-BuildTiming -Label $Label -Start $stepStart -Scope 'superclaw' -Status 'failed'
        throw "[$Label] Failed with exit code $LASTEXITCODE."
    }
    Write-BuildTiming -Label $Label -Start $stepStart -Scope 'superclaw'

    Write-Host ""
    Write-Host "[$Label] Completed." -ForegroundColor Green
}

# Helper: launch a sub-script as a background job, writing output to a log file.
# Returns a hashtable with keys: Job, Label, LogFile.
function Start-BuildStep {
    param(
        [Parameter(Mandatory)][string]$Label,
        [Parameter(Mandatory)][string]$ScriptPath,
        [string[]]$Arguments = @(),
        [Parameter(Mandatory)][string]$LogDir
    )

    if (-not (Test-Path $ScriptPath)) {
        throw "[$Label] Script not found: $ScriptPath"
    }

    $safeName = $Label -replace '[^A-Za-z0-9_-]', '_'
    $logFile  = Join-Path $LogDir "$safeName.log"

    Write-Host "  [parallel] $Label => $logFile" -ForegroundColor DarkGray

    $scriptPath_ = $ScriptPath
    $arguments_  = $Arguments
    $job = Start-Job -ScriptBlock {
        param($sp, $args_, $log)
        $prevPref = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            & powershell -ExecutionPolicy Bypass -File $sp @args_ *>&1 |
                Tee-Object -FilePath $log
        } finally {
            $ErrorActionPreference = $prevPref
        }
        # Throw on non-zero exit so the job State becomes 'Failed'. `exit` alone
        # leaves the job 'Completed', and Wait-BuildSteps only checks for 'Failed'.
        if ($LASTEXITCODE -ne 0) {
            throw "Build step '$sp' exited with code $LASTEXITCODE"
        }
    } -ArgumentList $scriptPath_, $arguments_, $logFile

    return @{ Job = $job; Label = $Label; LogFile = $logFile; StartTime = Get-Date }
}

# Helper: wait for all background build jobs started by Start-BuildStep.
# Polls every 2 s; as soon as any job fails it stops all remaining jobs
# immediately and throws, rather than waiting for every step to finish.
# On failure, prints the last 40 lines of each failed log.
function Wait-BuildSteps {
    param(
        [Parameter(Mandatory)][object[]]$Steps
    )

    Write-Host ""
    Write-Host "  Waiting for parallel steps to complete..." -ForegroundColor Cyan

    $remaining = [System.Collections.Generic.List[object]]($Steps)
    $failed    = @()

    while ($remaining.Count -gt 0) {
        Start-Sleep -Milliseconds 2000

        $justFinished = @($remaining | Where-Object {
            $s = $_.Job.State
            $s -eq 'Completed' -or $s -eq 'Failed' -or $s -eq 'Stopped'
        })

        foreach ($step in $justFinished) {
            $remaining.Remove($step) | Out-Null
            # Receive-Job rethrows the terminating error the job threw ("Build step
            # ... exited with code N"). With the script-scope $ErrorActionPreference
            # = 'Stop' that aborts this function right here, so the failure summary
            # below - which prints the failing step's log excerpt - never runs and
            # the outer trap reports only log *paths*. Swallow it: the job's State
            # already tells us it failed, and the tee'd output is on disk.
            try { Receive-Job -Job $step.Job -ErrorAction SilentlyContinue | Out-Null } catch { }

            $childState = $step.Job.ChildJobs[0].JobStateInfo.State
            if ($step.Job.State -eq 'Failed' -or $childState -eq 'Failed') {
                $failed += $step
                Write-BuildTimingFromJob -Label $step.Label -Job $step.Job -FallbackStart $step.StartTime -Scope 'superclaw' -Status 'failed'
                Write-Host "  [FAILED] $($step.Label)" -ForegroundColor Red

                # Kill every job still running â€” fail fast.
                foreach ($other in $remaining) {
                    Write-Host "  [abort]  stopping $($other.Label) due to failure in $($step.Label)" -ForegroundColor Yellow
                    Stop-Job  -Job $other.Job
                    try { Receive-Job -Job $other.Job -ErrorAction SilentlyContinue | Out-Null } catch { }
                    Remove-Job  -Job $other.Job
                }
                $remaining.Clear()
                break
            } else {
                Write-BuildTimingFromJob -Label $step.Label -Job $step.Job -FallbackStart $step.StartTime -Scope 'superclaw'
                Write-Host "  [OK]     $($step.Label) => $($step.LogFile)" -ForegroundColor Green
            }
            Remove-Job -Job $step.Job
        }
    }

    if ($failed.Count -gt 0) {
        Write-Host ""
        Write-Host "############################################" -ForegroundColor Red
        # ASCII-only on purpose: this file has no UTF-8 BOM, so Windows PowerShell
        # 5.1 decodes it with the host ANSI codepage. On a CP1252 runner an em dash
        # (E2 80 94) decodes to a trailing 0x94 = right curly quote, which PowerShell
        # accepts as a string terminator - the literal closed early, "step(s)" was
        # then parsed as code, and invoking command "s" aborted this whole summary
        # before it could print the failing step's log. Keep string literals ASCII.
        Write-Host "  BUILD FAILED - parallel step(s) errored" -ForegroundColor Red
        Write-Host "############################################" -ForegroundColor Red
        foreach ($step in $failed) {
            Write-Host ""
            Write-Host "  Step   : $($step.Label)" -ForegroundColor Red
            Write-Host "  Log    : $($step.LogFile)" -ForegroundColor Yellow
            Write-Host ""
            if (Test-Path $step.LogFile) {
                Write-Host "  --- last 40 lines of log ---" -ForegroundColor DarkGray
                Get-Content $step.LogFile -Tail 40 | ForEach-Object { Write-Host "  $_" }
                Write-Host "  --- end of log excerpt ---" -ForegroundColor DarkGray
                Write-Host ""
                Write-Host "  Full log: $($step.LogFile)" -ForegroundColor Yellow
            } else {
                Write-Host "  (log file not found)" -ForegroundColor DarkGray
            }
        }
        Write-Host ""
        Write-Host "############################################" -ForegroundColor Red
        $labels = ($failed | ForEach-Object { $_.Label }) -join ', '
        throw "Parallel build step(s) failed: $labels"
    }
}

function Test-ServiceHubPayload {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Label
    )

    $expectedFiles = @(
        'superclaw-services.exe',
        'service_cfg.json',
        'service_cfg.schema.json',
        '_internal',
        'agent-config\profiles\lite\profile.json',
        'agent-config\profiles\standard\profile.json',
        'agent-config\profiles\pro\profile.json',
        # Exe-adjacent llama-server payload; LRM resolves it relative to
        # sys.executable, so it must be at the bundle root, not under _internal.
        'inference\llama-win-sycl\llama-server.exe'
    )
    foreach ($relative in $expectedFiles) {
        $candidate = Join-Path $Path $relative
        if (-not (Test-Path $candidate)) {
            throw "[$Label] ServiceHub payload is incomplete: missing $candidate"
        }
    }
}

function Sync-ServiceHubPayloadForDebug {
    param(
        [Parameter(Mandatory)][string]$Configuration
    )

    $sourceDir = Join-Path $RootDir "build\$Configuration\servicehub"
    $destDir = Join-Path $RootDir "build\$Configuration\servicehub"
    # Keep the installed-layout name explicit even though Debug already builds
    # into the SuperClaw.exe sibling directory. This function is the regression
    # guard for the Tauri production resolver: SuperClaw.exe expects
    # .\servicehub\superclaw-services.exe and child bundles underneath that directory.
    Test-ServiceHubPayload -Path $sourceDir -Label '2/5 ServiceHub Build'
    Test-ServiceHubPayload -Path $destDir -Label '2/5 ServiceHub Debug payload'
    Write-Host "  [OK] ServiceHub Debug payload is installed-layout compatible: $destDir" -ForegroundColor Green
}

function Stop-RunningSuperClaw {
    $stoppedAny = $false
    $processes = Get-Process -Name 'SuperClaw' -ErrorAction SilentlyContinue

    foreach ($proc in $processes) {
        Write-Host "[build-superclaw] Stopping running SuperClaw.exe (PID $($proc.Id)) before build..." -ForegroundColor Yellow
        $prevEAP = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
        & taskkill /F /T /PID $proc.Id 2>$null | Out-Null
        $ErrorActionPreference = $prevEAP
        $stoppedAny = $true
    }

    if ($stoppedAny) {
        Start-Sleep -Milliseconds 2000
    }
}

function Stop-RunningSandboxManager {
    $stoppedAny = $false
    $processes = Get-Process -Name 'sandbox_manager' -ErrorAction SilentlyContinue

    foreach ($proc in $processes) {
        Write-Host "[Clean] Stopping running sandbox_manager.exe (PID $($proc.Id))..." -ForegroundColor Yellow
        $prevEAP = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
        & taskkill /F /T /PID $proc.Id 2>$null | Out-Null
        $ErrorActionPreference = $prevEAP
        $stoppedAny = $true
    }

    if ($stoppedAny) {
        Start-Sleep -Milliseconds 2000
    }
}

function Stop-RunningServiceHub {
    $stoppedAny = $false
    # Both names: 'superclaw-services' is the current multi-role image, 'servicehub'
    # the pre-rename one, and a clean has to work on a machine that last ran either.
    $processes = Get-Process -Name 'superclaw-services', 'servicehub' -ErrorAction SilentlyContinue

    foreach ($proc in $processes) {
        Write-Host "[Clean] Stopping running $($proc.ProcessName).exe (PID $($proc.Id))..." -ForegroundColor Yellow
        $prevEAP = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
        & taskkill /F /T /PID $proc.Id 2>$null | Out-Null
        $ErrorActionPreference = $prevEAP
        $stoppedAny = $true
    }

    if ($stoppedAny) {
        Start-Sleep -Milliseconds 1000
    }
}

function Stop-RunningLlmRouterManager {
    $stoppedAny = $false
    $processes = Get-Process -Name 'llmrouter_manager' -ErrorAction SilentlyContinue

    foreach ($proc in $processes) {
        Write-Host "[Clean] Stopping running llmrouter_manager.exe (PID $($proc.Id))..." -ForegroundColor Yellow
        $prevEAP = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
        & taskkill /F /T /PID $proc.Id 2>$null | Out-Null
        $ErrorActionPreference = $prevEAP
        $stoppedAny = $true
    }

    if ($stoppedAny) {
        Start-Sleep -Milliseconds 1000
    }
}

function Stop-RunningSecurityManager {
    $stoppedAny = $false
    $processes = Get-Process -Name 'privacy_manager' -ErrorAction SilentlyContinue

    foreach ($proc in $processes) {
        Write-Host "[Clean] Stopping running privacy_manager.exe (PID $($proc.Id))..." -ForegroundColor Yellow
        $prevEAP = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
        & taskkill /F /T /PID $proc.Id 2>$null | Out-Null
        $ErrorActionPreference = $prevEAP
        $stoppedAny = $true
    }

    if ($stoppedAny) {
        Start-Sleep -Milliseconds 1000
    }
}

function Stop-TrajectoryInspector {
    # superclaw-trajectory.exe is launched by sandbox_manager
    # with CREATE_NEW_PROCESS_GROUP and is deliberately NOT placed in a Windows
    # job object (see trajectory_inspector.py).  That means it outlives any
    # parent kill and keeps trajectory-inspector.log open, blocking Remove-Item
    # on the state dirs.  We must stop it explicitly before wiping the logs.
    $stoppedAny = $false
    $processes = Get-Process -Name 'superclaw-trajectory' -ErrorAction SilentlyContinue

    foreach ($proc in $processes) {
        Write-Host "[Clean] Stopping running superclaw-trajectory.exe (PID $($proc.Id))..." -ForegroundColor Yellow
        $prevEAP = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
        & taskkill /F /PID $proc.Id 2>$null | Out-Null
        $ErrorActionPreference = $prevEAP
        $stoppedAny = $true
    }

    if ($stoppedAny) {
        Start-Sleep -Milliseconds 1000
    }
}

function Invoke-CleanEnvironment {
    param([switch]$KeepModels)

    Write-Host ""
    Write-Host "============================================" -ForegroundColor Yellow
    Write-Host "  --Clean: Purging previous environment" -ForegroundColor Yellow
    if ($KeepModels) {
        Write-Host "  (-KeepModels: model files will be preserved)" -ForegroundColor Yellow
    }
    Write-Host "============================================" -ForegroundColor Yellow

    # Step 1: Kill SuperClaw.exe (already handled unconditionally above, but
    # called here so Clean is self-contained when invoked standalone).
    Stop-RunningSuperClaw

    # Step 2: Kill sandbox_manager.exe
    Stop-RunningSandboxManager

    # Step 2b: Kill the ServiceHub multi-role image
    Stop-RunningServiceHub

    # Step 2c: Kill the ServiceHub child services (llmrouter_manager, privacy_manager).
    # Each writes its own logs under %LOCALAPPDATA%\SuperClaw\<service> and holds
    # those files open, which would block the Step 5 removal.
    Stop-RunningLlmRouterManager
    Stop-RunningSecurityManager

    # Step 2d: Kill superclaw-trajectory.exe â€” it runs outside any job object
    # by design and survives parent-process kills, holding log files open.
    # Must be stopped before the state-dir removal in Step 5.
    Stop-TrajectoryInspector

    # Revoke owner-by-tier state through the signed broker before deleting runtime
    # state. The helper then removes any fixed-account state left by the legacy launchers.
    # Rebuild the broker first so the revoke never runs a stale binary from an earlier checkout.
    Write-Host "[Clean] Building native isolation broker for revoke..." -ForegroundColor DarkGray
    $prevPref = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & cargo build --manifest-path (Join-Path $RootDir 'host\native_isolation_broker\Cargo.toml') `
            --target-dir (Join-Path $RootDir 'host\native_isolation_broker\target') --release --bins --locked
    } finally {
        $ErrorActionPreference = $prevPref
    }
    if ($LASTEXITCODE -ne 0) {
        throw "[Clean] Native isolation broker build failed (exit $LASTEXITCODE)."
    }
    & (Join-Path $ScriptDir 'reset-windows-sandbox-accounts.ps1') `
        -RootDir $RootDir `
        -LogPrefix 'Clean'

    # Step 5: Delete the entire %LOCALAPPDATA%\SuperClaw tree. ServiceHub and each
    # of its child services (servicehub, sandbox_manager, llmrouter_manager,
    # privacy_manager) write runtime state (resources + logs + db) into their own
    # sibling dir under this root, so wiping the root clears them all in one shot.
    $superClawStateDir = Join-Path $env:LOCALAPPDATA 'SuperClaw'
    if (Test-Path $superClawStateDir) {
        # Preserve selected items by moving them aside before the recursive wipe,
        # then restoring them to their original relative locations afterwards.
        #   -KeepModels : llmrouter_manager\models\, privacy_manager\models\ and
        #                 model verification rows
        # Each entry: RelPath (under SuperClaw), Temp (aside location), Moved flag.
        $preserve = @()
        if ($KeepModels) {
            $preserve += @{ RelPath = 'llmrouter_manager\models'; Temp = (Join-Path $env:TEMP "superclaw_models_backup_$PID"); Moved = $false; Label = 'model files' }
            $preserve += @{ RelPath = 'privacy_manager\models'; Temp = (Join-Path $env:TEMP "superclaw_privacy_models_backup_$PID"); Moved = $false; Label = 'privacy model files' }
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
                $preserve += @{ RelPath = 'llmrouter_manager\llmrouter_manager.db'; Temp = $verificationBackup; Moved = $true; Label = 'model verification state' }
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

    # Step 6: Delete %LOCALAPPDATA%\com.aibuilder.superclaw (Tauri app-data)
    $tauriDir = Join-Path $env:LOCALAPPDATA 'com.aibuilder.superclaw'
    if (Test-Path $tauriDir) {
        Write-Host "[Clean] Removing $tauriDir ..." -ForegroundColor DarkGray
        Remove-Item -LiteralPath $tauriDir -Recurse -Force
        Write-Host "[Clean] Removed $tauriDir" -ForegroundColor Green
    } else {
        Write-Host "[Clean] $tauriDir not found, skipping." -ForegroundColor DarkGray
    }

    Write-Host ""
    Write-Host "[Clean] Environment purged. Proceeding with build..." -ForegroundColor Green
    Write-Host ""
}

if ($Clean -and $CleanRuntimeOnly) {
    throw "-Clean and -CleanRuntimeOnly are mutually exclusive. -Clean performs the full clean (including UI dependency reinstall); -CleanRuntimeOnly clears only runtime state and skips the UI dependency full-clean. Pick one."
}

Stop-RunningSuperClaw
$BuildStart = [System.Diagnostics.Stopwatch]::StartNew()

# Both -Clean and -CleanRuntimeOnly run the same runtime-state purge
# (Invoke-CleanEnvironment): kill processes, wipe
# %LOCALAPPDATA%\SuperClaw and the Tauri app-data store. The difference is that
# -Clean ALSO triggers the UI dependency full-clean below (cargo clean +
# node_modules reinstall), which -CleanRuntimeOnly deliberately skips for speed.
if ($Clean -or $CleanRuntimeOnly) {
    Invoke-CleanEnvironment -KeepModels:$KeepModels
}

# â”€â”€ Parallel Steps 1, 2, 3 â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
# Steps 1 (Backend), 2 (ServiceHub), and 3 (UI) have no mutual dependencies
# and are run in parallel. Logs for each step are written to build/_logs/.
# Step 5 (Installer, Release only) runs sequentially after all three complete.

$LogDir = Join-Path $RootDir 'build\_logs'
New-Item -ItemType Directory -Path $LogDir -Force | Out-Null

# Trap any unhandled terminating error and print a prominent pointer to the
# log directory before the script exits, so the developer knows exactly where
# to look regardless of which step failed.
trap {
    Write-Host "" 
    Write-Host "############################################" -ForegroundColor Red
    Write-Host "  BUILD FAILED" -ForegroundColor Red
    Write-Host "############################################" -ForegroundColor Red
    Write-Host "  Error : $_" -ForegroundColor Red
    Write-Host ""
    if (Test-Path variable:BuildStart) {
        $elapsed = $BuildStart.Elapsed
        Write-Host ("  Failed after: {0:mm\:ss} ({1:F0}s)" -f $elapsed, $elapsed.TotalSeconds) -ForegroundColor Red
        Write-Host ""
    }
    if (Test-Path variable:LogDir) {
        $logs = @(Get-ChildItem -LiteralPath $LogDir -Filter '*.log' -ErrorAction SilentlyContinue)
        if ($logs.Count -gt 0) {
            Write-Host "  Logs written to: $LogDir" -ForegroundColor Yellow
            foreach ($l in $logs) {
                Write-Host "    $($l.FullName)" -ForegroundColor Yellow
            }
        } else {
            Write-Host "  Log dir (no files yet): $LogDir" -ForegroundColor Yellow
        }
    }
    Write-Host "############################################" -ForegroundColor Red
    Write-Host ""
    # Propagate a non-zero exit code so CI/automation reliably sees the failure.
    # `break` alone would consume the terminating error and exit 0.
    exit 1
}

Write-Host ""
# â”€â”€ Serial dependency preparation (before parallel launch) â”€â”€â”€â”€â”€â”€â”€
# The UI dependency cleanup wipes and reinstalls the repo-root node_modules.
# That same node_modules is read â€” and auto-installed via pnpm if vite is
# missing â€” by the backend step's Assert-PnpmDependencies. Backend and UI run
# in the parallel pool below, so if the cleanup ran inside the parallel UI step
# the two pnpm processes would race on node_modules and fail mid-install
# (ENOENT creating .pnpm subdirs; #1149 regression). Do the cleanup + reinstall
# ONCE here, serially, before any Start-BuildStep launches. Afterwards the
# parallel UI step builds against ready deps and the backend step finds vite
# present and skips its own install â€” no concurrent node_modules writer.
if (-not $SkipUI -and ($CleanUIDependencies -or $Clean)) {
    if ($SkipUIBuild) {
        throw "-SkipUIBuild cannot be combined with -Clean or -CleanUIDependencies because UI cleanup runs 'cargo clean' and removes the existing Tauri binary."
    }
    Invoke-BuildStep -Label 'Dependency Preparation' -ScriptPath $UiScript -Arguments @('-Configuration', $Configuration, '-CleanDependenciesOnly')
}

# The shell compiles SUPERCLAW_BUILD_VERSION in as its installed version for the update
# check, and builds in parallel with ServiceHub, so the version both stamp is fixed here
# first: build-servicehub.ps1's own computation, or the VERSION an existing bundle carries.
if (-not $env:SUPERCLAW_BUILD_VERSION) {
    $existingBundleVersion = Join-Path $RootDir "build\$Configuration\servicehub\VERSION"
    if ($SkipServiceHub -and (Test-Path $existingBundleVersion)) {
        $env:SUPERCLAW_BUILD_VERSION = (Get-Content -LiteralPath $existingBundleVersion -Raw).Trim()
    } else {
        $baseVersion = '0.1.0'
        $pyproject = Join-Path $RootDir 'host\sandbox_manager\pyproject.toml'
        if (Test-Path $pyproject) {
            $projectBlock = [regex]::Match((Get-Content $pyproject -Raw), '(?ms)^\[project\]\s*(?<body>.*?)(?=^\[|\z)')
            $versionMatch = [regex]::Match($projectBlock.Groups['body'].Value, '(?m)^\s*version\s*=\s*["''](?<version>\d+\.\d+\.\d+)')
            if ($versionMatch.Success) { $baseVersion = $versionMatch.Groups['version'].Value }
        }
        $today = Get-Date
        $env:SUPERCLAW_BUILD_VERSION = "$baseVersion.$([int]('{0}{1:00}' -f $today.Month, $today.Day))"
    }
}
Write-Host "  Build version: $env:SUPERCLAW_BUILD_VERSION" -ForegroundColor DarkGray

# Resolve the pinned SuperClaw runtime serially, before the UI step's sidecar and
# the native payload both consume it. A stale stamp is rebuilt here instead of
# failing inside prepare-sidecar.mjs.
$skipsSidecar = $SkipUI -or $SkipUIBuild
if (-not ($skipsSidecar -and $SkipNativeBackend)) {
    Invoke-BuildStep -Label '1/5 SuperClaw Runtime (windows-x64)' -ScriptPath $RuntimeBinScript -Arguments @()
}

Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  Steps 2-3: running in parallel" -ForegroundColor Cyan
Write-Host "  Logs: $LogDir" -ForegroundColor DarkGray
Write-Host "============================================" -ForegroundColor Cyan

$parallelSteps = @()

# â”€â”€ Step 2: ServiceHub â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
if ($SkipServiceHub) {
    Write-Host "[2/5] Skipping ServiceHub build (-SkipServiceHub)." -ForegroundColor DarkGray
    $serviceHubExe = Join-Path $RootDir "build\$Configuration\servicehub\superclaw-services.exe"
    if (-not (Test-Path $serviceHubExe)) {
        throw "[2/5] superclaw-services.exe not found at $serviceHubExe. Run without -SkipServiceHub first."
    }
    Write-Host "  [OK] superclaw-services.exe exists" -ForegroundColor Green
} else {
    $serviceHubArgs = @('-Configuration', $Configuration)
    # Forward -Clean to the ServiceHub step. Without this
    # the ServiceHub step never sees -Clean, so `build-superclaw.ps1 -Clean` left
    # both the output tree and the PyInstaller workpath caches untouched â€” the one
    # documented escape hatch for a suspected-stale bundle did nothing at all.
    # -CleanRuntimeOnly is deliberately NOT forwarded: it purges runtime state
    # (processes, app-data), not build artifacts.
    if ($Clean) { $serviceHubArgs += '-Clean' }
    $parallelSteps += Start-BuildStep -Label '2/5 ServiceHub Build' -ScriptPath $ServiceHubScript -Arguments $serviceHubArgs -LogDir $LogDir
}

# â”€â”€ Step 3: UI â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
if ($SkipUI) {
    Write-Host "[3/5] Skipping UI build (-SkipUI)." -ForegroundColor DarkGray
    $uiExe = Join-Path $RootDir "build\$Configuration\SuperClaw.exe"
    if (-not (Test-Path $uiExe)) {
        throw "[3/5] SuperClaw.exe not found at $uiExe. Run without -SkipUI first."
    }
    Write-Host "  [OK] SuperClaw.exe exists" -ForegroundColor Green
} else {
    # Dependency cleanup (-Clean/-CleanUIDependencies) already ran serially above,
    # including the -SkipUIBuild incompatibility guard. Here we only launch the
    # actual Tauri build in the parallel pool; it does not touch node_modules.
    $uiArgs = @('-Configuration', $Configuration)
    if ($SkipUIBuild) { $uiArgs += '-SkipBuild' }

    $parallelSteps += Start-BuildStep -Label '3/5 UI Build' -ScriptPath $UiScript -Arguments $uiArgs -LogDir $LogDir
}

# Wait for all launched parallel steps (may be 0 if all were skipped)
if ($parallelSteps.Count -gt 0) {
    Wait-BuildSteps -Steps $parallelSteps
}

if ($Configuration -eq 'Debug') {
    Sync-ServiceHubPayloadForDebug -Configuration $Configuration
}

# ── Step 3.5: Windows-native backend payload ─────────────────────
# Runs serially AFTER the parallel pool, not inside it: the Release staging in
# build-native-backend.ps1 writes into build\Release\servicehub\native-backend
# and no-ops when that directory does not exist yet, so racing the ServiceHub
# step would silently produce an installer with no backend.
$NativePayloadRoot = if ($Configuration -eq 'Release') {
    Join-Path $RootDir 'build\Release\servicehub\native-backend'
} else {
    Join-Path $RootDir 'build\Debug\servicehub\native-backend'
}

if ($SkipNativeBackend) {
    Write-Host "[3.5/5] Skipping native backend build (-SkipNativeBackend)." -ForegroundColor DarkGray
    Assert-NativeBackendPayload -PayloadRoot $NativePayloadRoot -Label '3.5/5 Native Backend'
} else {
    $nativeArgs = @()
    if ($Configuration -eq 'Release') {
        # Release packages from the staged tree; the %LOCALAPPDATA% sync is dev-only.
        $nativeArgs += '-SkipResourceSync'
    } else {
        # Debug resolves the payload beside superclaw-services.exe; build there directly.
        $nativeArgs += @('-OutDir', $NativePayloadRoot, '-SkipResourceSync', '-SkipReleaseStage', '-DevelopmentPayloadIdentity')
    }
    # The payload has to be signed before its manifest is written, because the
    # installer signs whatever it packages. See payload-signing-policy.ps1.
    #
    # Forwarded for both configurations. What #2661 is about is the *absence* of a
    # certificate, handled where it belongs: Get-PayloadSigningCertificate returns
    # $null instead of throwing, so a machine that never created a dev certificate
    # builds fine and simply ships an unsigned payload.
    if ($Sign) {
        $nativeArgs += '-Sign'
        if ($SigningCertificateThumbprint) {
            $nativeArgs += @('-SigningCertificateThumbprint', $SigningCertificateThumbprint)
        }
        if ($SigningCertificateSubject) {
            $nativeArgs += @('-SigningCertificateSubject', $SigningCertificateSubject)
        }
    }
    Invoke-BuildStep -Label '3.5/5 Native Backend Payload' -ScriptPath $NativeBackendScript -Arguments $nativeArgs
    Assert-NativeBackendPayload -PayloadRoot $NativePayloadRoot -Label '3.5/5 Native Backend'
}

# ── Step 5: Debug local sync to manager resources dirs ────────────
if ($Configuration -eq 'Release') {
    # Release stages no sandbox resources: the installer packages build\Release\servicehub.
    Write-Host "[4/5] Skipping Release sandbox resource staging (the installer packages the ServiceHub bundle)." -ForegroundColor DarkGray
} elseif ($SkipLocalSync) {
    Write-Host "[4/5] Skipping local sync (-SkipLocalSync)." -ForegroundColor DarkGray
} else {
    $localSyncStart = Get-Date
    $trajectoryDir = Join-Path $RootDir 'tools\trajectory'
    $trajectorySrc = Join-Path $trajectoryDir 'superclaw-trajectory.exe'

    Write-Host "[4/5] Building superclaw-trajectory.exe in $trajectoryDir ..." -ForegroundColor Cyan
    Push-Location $trajectoryDir
    try {
        if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
            throw "[4/5] bun not found in PATH; cannot build superclaw-trajectory.exe. Install bun or rerun with -SkipLocalSync."
        }
        if (Test-Path $trajectorySrc) {
            Remove-Item -LiteralPath $trajectorySrc -Force
        }
        # Relax ErrorActionPreference around the native bun call: bun writes its
        # build banner to stderr, which under the script-level 'Stop' is wrapped
        # as a terminating NativeCommandError and aborts the build BEFORE the
        # $LASTEXITCODE check below â€” a false failure even though the compile
        # succeeded (and it silently skips the local sync). Mirrors the child
        # invocation guard above; $LASTEXITCODE is the real success signal.
        $prevTrajPref = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            & bun run build:windows
        } finally {
            $ErrorActionPreference = $prevTrajPref
        }
        if ($LASTEXITCODE -ne 0) {
            throw "Trajectory inspector build failed with exit code $LASTEXITCODE."
        }
    } finally {
        Pop-Location
    }

    Write-Host ""
    Write-Host "--------------------------------------------" -ForegroundColor Cyan
    Write-Host "  4/5 Local Sync -> %LOCALAPPDATA%\SuperClaw\sandbox_manager\resources\" -ForegroundColor Cyan
    Write-Host "--------------------------------------------" -ForegroundColor Cyan

    # Debug hand-populates sandbox_manager's resources dir (there is no installer
    # in Debug). sandbox_manager reads from
    # %LOCALAPPDATA%\SuperClaw\sandbox_manager\resources (config.py
    # _default_data_dir() -> resources_dir).
    $localResourcesDirs = @(
        (Join-Path $env:LOCALAPPDATA 'SuperClaw\sandbox_manager\resources')
    )

    if (-not (Test-Path $trajectorySrc)) {
        throw "[4/5] superclaw-trajectory.exe not found at $trajectorySrc. Build it first with: bun run build:windows (in tools\trajectory)."
    }

    $trajectoryUiSrc = Join-Path $trajectoryDir 'ui'

    foreach ($localResourcesDir in $localResourcesDirs) {
        New-Item -ItemType Directory -Path $localResourcesDir -Force | Out-Null

        # The native backend has no image tarballs, and since step 3.5 started
        # building the Debug payload beside superclaw-services.exe it no longer
        # syncs one into this resources dir either. resolve_bin_dir() therefore
        # prefers the repo build tree over this dir on a source-dev runtime; do
        # not "restore" a native payload sync here without reading that docstring,
        # because it costs a second full copy of a ~1.34 GB / 30k-file tree.
        Copy-Item -Path $trajectorySrc -Destination $localResourcesDir -Force
        Write-Host "  Copied superclaw-trajectory.exe -> $localResourcesDir" -ForegroundColor Green

        # Copy trajectory UI static files alongside the exe so the compiled binary
        # can resolve ROOT/ui/index.html (dirname(process.execPath) logic in server.ts).
        $trajectoryUiDst = Join-Path $localResourcesDir 'ui'
        if (Test-Path $trajectoryUiSrc) {
            if (Test-Path $trajectoryUiDst) {
                Remove-Item -LiteralPath $trajectoryUiDst -Recurse -Force
            }
            New-Item -ItemType Directory -Path $trajectoryUiDst -Force | Out-Null
            Copy-Item -Path (Join-Path $trajectoryUiSrc '*') -Destination $trajectoryUiDst -Recurse -Force
            Write-Host "  Copied trajectory ui/ -> $trajectoryUiDst" -ForegroundColor Green
        } else {
            Write-Warning "[4/5] tools\trajectory\ui not found - trajectory UI will be unavailable."
        }
    }
    Write-BuildTiming -Label '4/5 Debug local sync' -Start $localSyncStart -Scope 'superclaw'
}

# â”€â”€ Step 6: Installer (Release only) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
if ($Configuration -eq 'Release') {
    if ($SkipInstaller) {
        Write-Host "[5/5] Skipping installer build (-SkipInstaller)." -ForegroundColor DarkGray
    } else {
        $installerArgs = @('-Build', $Build, '-AipName', $AipName, '-AdvancedInstallerCom', $AdvancedInstallerCom)
        if ($Rebuild)  { $installerArgs += '-Rebuild' }
        if ($Sign)     { $installerArgs += '-Sign' }
        if ($Version)  { $installerArgs += @('-Version', $Version) }
        Invoke-BuildStep -Label '5/5 Installer Build' -ScriptPath $InstallerScript -Arguments $installerArgs
    }
} else {
    Write-Host "[5/5] Debug build - skipping installer packaging." -ForegroundColor DarkGray
    Write-Host "  Debug build complete; artifacts in build\Debug" -ForegroundColor Green
    Write-Host "  Quick Start: Double-click build\Debug\SuperClaw.exe" -ForegroundColor Green
}

Write-Host ""
Write-Host "============================================" -ForegroundColor Green
Write-Host "  build-superclaw.ps1 complete ($Configuration)" -ForegroundColor Green
if (Test-Path variable:BuildStart) {
    $elapsed = $BuildStart.Elapsed
    Write-Host ("  Total time: {0:mm\:ss} ({1:F0}s)" -f $elapsed, $elapsed.TotalSeconds) -ForegroundColor Green
}
Write-Host "============================================" -ForegroundColor Green
Write-Host ""

if ($TimingDir) {
    Show-BuildTimingSummary -Dir $TimingDir -BuildStart $BuildStartedAt
}

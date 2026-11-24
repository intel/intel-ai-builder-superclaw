#Requires -Version 5.1
<#
.SYNOPSIS
    Build ServiceHub and the services it supervises as ONE PyInstaller onedir bundle.

.DESCRIPTION
    Produces build\<Configuration>\servicehub\superclaw-services.exe, a single
    multi-role bundle hosting servicehub, llmrouter_manager, sandbox_manager,
    privacy_manager, tts_manager, asr_manager and mcp_host_manager. A role is selected at spawn with
    `--service <name>`; a bare invocation is the `servicehub` role, which is why
    the Rust shell's launch path needed no change.

    The payload DIRECTORY stays `servicehub\` (the Rust shell resolves it and the
    installer synchronizes it into APPDIR\servicehub) while the IMAGE is named for
    the bundle: every role runs from this one exe, so `servicehub.exe` named only
    the supervisor and Task Manager showed identical rows of it. The spec also
    stamps a version resource whose FileDescription is "SuperClaw Services", which
    is the string Task Manager prefers over the image name.

    Why one bundle: host/.venv is a single shared workspace venv
    (uv sync --all-packages), so PyInstaller's Analysis runs against every
    sibling service's dependency stack no matter which spec is building.
    Separate onedir bundles therefore each carried their own copy of the shared
    stack; folding the four children in measured 2302 MB -> 1450 MB (853 MB, 37%).

    Folding ServiceHub itself in buys the larger win: parent and children are one
    PyInstaller application, so ProcessManager no longer needs the PowerShell
    broker, the _PYI_* environment stripping, or the DLL-directory reset that
    launching an independent frozen app required.

    Replaces build-llmrouter-manager.ps1, build-sandbox-manager.ps1,
    build-security-manager.ps1 and build-tts-manager.ps1 in the packaged build.
    Those remain as standalone single-service dev conveniences.
#>
param(
    [ValidateSet('Debug','Release')] [string]$Configuration = 'Debug',
    [switch]$Clean
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Continue'

$RepoRoot      = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$HostDir       = Join-Path $RepoRoot 'host'
$ServiceHubDir = Join-Path $HostDir 'servicehub'
$SpecDir       = Join-Path $HostDir 'superclaw_services'
$OutDir        = Join-Path $RepoRoot "build\$Configuration\servicehub"
$WorkPath      = Join-Path $RepoRoot 'build\_pyinstaller_work_servicehub'
$SpecFile      = Join-Path $SpecDir 'superclaw_services.spec'
$ExeName       = 'superclaw-services.exe'
$ExePath       = Join-Path $OutDir $ExeName
$ProfilesSourceRoot = Join-Path $RepoRoot 'sandbox\agent_config\profiles'
$ProfileParityScript = Join-Path $RepoRoot 'shared\contracts\scripts\check-product-profile-parity.mjs'

# Single source for the bundle's version: the spec stamps it into the exe's version
# resource (read from SUPERCLAW_SERVICES_VERSION) and the VERSION file written below
# carries the same string, so the two cannot drift. That file is also what every
# hosted service resolves its crash-report release from, so it must be the REAL
# product version (x.y.z.<Mdd>) rather than this package's own semver. Base comes
# from sandbox_manager's pyproject.toml -- the version reported everywhere else,
# e.g. /v1/system/status -- mirroring build-sandbox-manager.ps1's own computation.
$SandboxPyprojectPath = Join-Path $HostDir 'sandbox_manager\pyproject.toml'
$baseVersion = '0.1.0'  # fallback if pyproject.toml cannot be parsed
if (Test-Path $SandboxPyprojectPath) {
    $pyprojectContent = Get-Content $SandboxPyprojectPath -Raw
    $projectBlock = [regex]::Match($pyprojectContent, '(?ms)^\[project\]\s*(?<body>.*?)(?=^\[|\z)')
    if ($projectBlock.Success) {
        $versionMatch = [regex]::Match(
            $projectBlock.Groups['body'].Value,
            '(?m)^\s*version\s*=\s*["''](?<version>[^"'']+)["'']\s*$'
        )
        if ($versionMatch.Success) {
            $parsedBase = $versionMatch.Groups['version'].Value.Trim()
            $coreMatch  = [regex]::Match($parsedBase, '^\d+\.\d+\.\d+')
            if ($coreMatch.Success) { $baseVersion = $coreMatch.Value }
        }
    }
}
$today         = Get-Date
$dateSuffix    = [int]('{0}{1:00}' -f $today.Month, $today.Day)
$BundleVersion = "$baseVersion.$dateSuffix"

# Protected release workflows pin the exact per-build credential version before
# compilation. Reuse it so credential metadata and the packaged artifact cannot
# drift if the build crosses midnight.
$credentialBuildVersion = ''
if ($env:SUPERCLAW_BUILD_VERSION) {
    $credentialBuildVersion = $env:SUPERCLAW_BUILD_VERSION.Trim()
}
if ($credentialBuildVersion) {
    if ($credentialBuildVersion -notmatch '^\d+\.\d+\.\d+\.\d+$') {
        throw "SUPERCLAW_BUILD_VERSION must be a four-part numeric version."
    }
    if (-not $credentialBuildVersion.StartsWith("$baseVersion.")) {
        throw "SUPERCLAW_BUILD_VERSION '$credentialBuildVersion' does not match pyproject base '$baseVersion'."
    }
    $BundleVersion = $credentialBuildVersion
}

# Roles this bundle hosts. Must match `_SERVICES` in _pyinstaller_entry.py and the
# `launch.kind = "role"` entries in service_cfg.json (whose exe_name must name the
# image built here -- ProcessManager refuses to re-exec a mismatched name).
$HubRole = 'servicehub'
$ChildRoles = @('llmrouter_manager', 'sandbox_manager', 'privacy_manager', 'tts_manager', 'asr_manager', 'mcp_host_manager')
$AllRoles = @($HubRole) + $ChildRoles

# Per-step timing. No-op unless the parent build set SUPERCLAW_BUILD_TIMING_DIR.
. (Join-Path $PSScriptRoot 'build-timing.ps1')
# PyInstaller workpath cache gate (content-stamped; see the script header).
. (Join-Path $PSScriptRoot 'build-pyinstaller-cache.ps1')
# Fails the build if GPL-3.0 phonemizer / espeak code is bundled.
. (Join-Path $PSScriptRoot 'build-gpl-gate.ps1')

Write-Host "[build-servicehub] repo root: $RepoRoot" -ForegroundColor Cyan
Write-Host "[build-servicehub] configuration: $Configuration" -ForegroundColor Cyan

function Assert-ProductProfileParity {
    param([Parameter(Mandatory)][string]$PackagedProfilesRoot)

    & node $ProfileParityScript $ProfilesSourceRoot $PackagedProfilesRoot
    if (-not $? -or $LASTEXITCODE -ne 0) {
        throw "[build-servicehub] Product Profile packaging parity failed for $PackagedProfilesRoot."
    }
}

function Remove-WithRetry {
    param(
        [Parameter(Mandatory)][string]$Path,
        [int]$MaxAttempts = 5,
        [int]$DelayMs = 500
    )

    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
        try {
            if (Test-Path $Path) {
                Remove-Item $Path -Recurse -Force -ErrorAction Stop
            }
            return
        } catch {
            if ($attempt -eq $MaxAttempts) { throw }
            Write-Warning "[build-servicehub] Remove attempt $attempt/$MaxAttempts failed for $Path; retrying in ${DelayMs}ms. $_"
            Start-Sleep -Milliseconds $DelayMs
            $DelayMs = [Math]::Min($DelayMs * 2, 5000)
        }
    }
}

function Stop-RunningServiceHub {
    # Every role now runs from this ONE image path, so a single exact-path match
    # catches the Hub and all four children. Matching on the exact path (never the
    # image name) keeps an unrelated process of the same name untouched.
    #
    # The pre-rename servicehub.exe is included because a build that crosses the
    # rename would otherwise leave the previous image running and locking the tree.
    $outExeLower = @(
        $ExePath.ToLowerInvariant(),
        (Join-Path $OutDir 'servicehub.exe').ToLowerInvariant()
    )
    $running = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.ExecutablePath -and ($outExeLower -contains $_.ExecutablePath.ToLowerInvariant())
    }
    foreach ($match in $running) {
        Write-Host "[build-servicehub] Stopping output-path $($match.Name) (PID $($match.ProcessId)) before rebuild..." -ForegroundColor Yellow
        & taskkill /F /T /PID $match.ProcessId 2>$null | Out-Null
    }
}

if (-not (Test-Path $SpecFile)) { throw "[build-servicehub] Missing spec: $SpecFile" }

Stop-RunningServiceHub

# Only -Clean removes the whole tree; PyInstaller's COLLECT recreates $OutDir
# itself, and the stale-payload sweep below deletes anything that stopped being
# produced (notably the four per-service child directories the previous layout
# shipped under this root).
if ($Clean -and (Test-Path $OutDir)) {
    Write-Host "[build-servicehub] Removing $OutDir (-Clean requested) ..." -ForegroundColor Yellow
    Remove-WithRetry -Path $OutDir
}

if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    throw "[build-servicehub] 'uv' not found. Install it: https://docs.astral.sh/uv/"
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "[build-servicehub] 'node' not found. Install Node.js before running Product Profile parity."
}

Write-Host "[build-servicehub] Running uv sync --locked --all-packages in $HostDir ..." -ForegroundColor Cyan
$uvSyncStart = Get-Date
Push-Location $HostDir
try {
    uv sync --locked --all-packages
    if ($LASTEXITCODE -ne 0) { throw "uv sync --locked --all-packages failed (exit $LASTEXITCODE)" }
} finally {
    Pop-Location
}
Write-BuildTiming -Label 'uv sync --locked --all-packages' -Start $uvSyncStart -Scope 'servicehub'

# --- PyInstaller workpath cache (content-gated; wiped for Release / -Clean) ---
# --workpath holds PyInstaller's cached module graph (Analysis-00.toc) and the
# compiled PYZ. Keeping it turns a no-change rebuild into a COLLECT-only copy
# instead of a full module-graph analysis, which is where nearly all of this
# build's time goes.
#
# PyInstaller invalidates that cache per entry by comparing each listed source
# file's mtime against the TOC, so an edited file is always re-analyzed. What it
# cannot see is a content change that does not advance mtime (a file restored with
# a preserved timestamp), which would re-link a fresh exe around stale cached
# bytecode while BUILD_COMMIT advertises the new git hash. Sync-PyInstallerWorkPath
# closes that by content digest. Release still rebuilds from scratch: a shipped
# artifact should not depend on any cache being correct.
#
# EVERY service tree feeds this one Analysis, so the digest must cover all of them:
# a change in any single service has to invalidate the shared module graph. Under
# the previous per-service specs each script only digested its own tree.
#
# Runs AFTER uv sync, not before, for two reasons. The cached module graph resolves
# third-party imports into the venv, so the installed packages belong in the cache
# key and can only be read once they are installed. `--locked` also refuses stale
# manifests rather than silently rewriting the committed dependency graph.
#
# The roots, and which of their files are known not to reach the bundle (each
# root's top-level tests\), live in Get-ServiceHubSourceInputs with the reasoning.
# A tests-only edit therefore keeps the cache; editing a shipped .py still does not.
# What the digest hashed is listed in <workpath>\.superclaw-source-stamp.entries.
$hubInputs = Get-ServiceHubSourceInputs -RepoRoot $RepoRoot
$cacheState = Sync-PyInstallerWorkPath `
    -WorkPath $WorkPath `
    -SourceRoot $hubInputs.SourceRoot `
    -ExcludeRootDirectory $hubInputs.ExcludeRootDirectory `
    -SourceFile @($SpecFile) `
    -DependencyFile (Get-HostDependencyInputs -HostDir $HostDir) `
    -EnvironmentRoot (Join-Path $HostDir '.venv') `
    -Wipe:($Clean -or $Configuration -eq 'Release') `
    -WipeReason $(if ($Clean) { '-Clean requested' } else { 'Release build' }) `
    -LogPrefix '[build-servicehub]'

Push-Location $HostDir
try {
    $pyiCheck = uv run python -c "import PyInstaller; print(PyInstaller.__version__)" 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "[build-servicehub] PyInstaller is not available after uv sync. Ensure servicehub's dev dependency group includes pyinstaller and host\uv.lock is up to date."
    } else {
        Write-Host "[build-servicehub] PyInstaller $pyiCheck found." -ForegroundColor Green
    }
} finally {
    Pop-Location
}

Write-Host "[build-servicehub] Running PyInstaller (merged multi-role bundle) ..." -ForegroundColor Cyan
$pyiStart = Get-Date
# Run from the spec's own directory: the spec derives every source path from
# SPECPATH, and its COLLECT name is `servicehub`, so --distpath build\<Cfg>
# lands the bundle at build\<Cfg>\servicehub\.
Push-Location $SpecDir
try {
    $distPath = Join-Path $RepoRoot "build\$Configuration"
    $previousPyInstallerDebug = $env:PYINSTALLER_DEBUG
    $previousBundleVersion = $env:SUPERCLAW_SERVICES_VERSION
    if ($Configuration -eq 'Debug') { $env:PYINSTALLER_DEBUG = '1' }
    $env:SUPERCLAW_SERVICES_VERSION = $BundleVersion
    try {
        uv run pyinstaller --distpath $distPath --workpath "$WorkPath" --noconfirm "$SpecFile"
        if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed (exit $LASTEXITCODE)" }
    } finally {
        if ($null -eq $previousPyInstallerDebug) {
            Remove-Item Env:\PYINSTALLER_DEBUG -ErrorAction SilentlyContinue
        } else {
            $env:PYINSTALLER_DEBUG = $previousPyInstallerDebug
        }
        if ($null -eq $previousBundleVersion) {
            Remove-Item Env:\SUPERCLAW_SERVICES_VERSION -ErrorAction SilentlyContinue
        } else {
            $env:SUPERCLAW_SERVICES_VERSION = $previousBundleVersion
        }
    }
} finally {
    Pop-Location
}
Write-BuildTiming -Label 'pyinstaller servicehub' -Start $pyiStart -Scope 'servicehub'

if (-not (Test-Path $ExePath)) {
    throw "[build-servicehub] Expected $ExePath not found after PyInstaller run."
}

# The version resource is what Task Manager reads instead of the image name, and a
# spec that failed to attach it fails silently -- the exe still runs, it just shows
# up as `superclaw-services.exe` again. Assert it here rather than discovering it in
# a screenshot.
$fileDescription = (Get-Item -LiteralPath $ExePath).VersionInfo.FileDescription
if ($fileDescription -ne 'SuperClaw Services') {
    throw "[build-servicehub] Version resource missing or wrong: FileDescription is '$fileDescription', expected 'SuperClaw Services'. Check the version= argument in $SpecFile."
}
Write-Host "[build-servicehub] Version resource verified: FileDescription='$fileDescription', FileVersion=$((Get-Item -LiteralPath $ExePath).VersionInfo.FileVersion)" -ForegroundColor Green

# --- exe-sibling files -------------------------------------------------------
# PyInstaller 6.x onedir places all spec `datas` under _internal/, but
# config.default_service_cfg_path and ManifestArtifactLocator.default both resolve
# at `Path(sys.executable).parent`. These copies are what the Hub actually reads.
$cfgSrc = Join-Path $ServiceHubDir 'service_cfg.json'
$schemaSrc = Join-Path $ServiceHubDir 'service_cfg.schema.json'
Copy-Item -LiteralPath $cfgSrc -Destination (Join-Path $OutDir 'service_cfg.json') -Force
Copy-Item -LiteralPath $schemaSrc -Destination (Join-Path $OutDir 'service_cfg.schema.json') -Force

# Product Profiles are a read-only payload. Keep the directory tree unchanged.
$profilesSrc = Join-Path $OutDir '_internal\agent-config\profiles'
$agentConfigDst = Join-Path $OutDir 'agent-config'
$profilesDst = Join-Path $agentConfigDst 'profiles'
if (-not (Test-Path $profilesSrc)) {
    throw "[build-servicehub] Missing bundled Product Profiles under _internal\ ($profilesSrc). Check the spec's datas list."
}
Assert-ProductProfileParity -PackagedProfilesRoot $profilesSrc
Remove-WithRetry -Path $agentConfigDst
New-Item -ItemType Directory -Path $agentConfigDst -Force | Out-Null
Copy-Item -LiteralPath $profilesSrc -Destination $profilesDst -Recurse -Force
foreach ($profile in @('lite', 'standard', 'pro')) {
    if (-not (Test-Path (Join-Path $profilesDst "$profile\profile.json"))) {
        throw "[build-servicehub] Product Profile sibling copy incomplete: $profile\profile.json not found at $profilesDst."
    }
}
Assert-ProductProfileParity -PackagedProfilesRoot $profilesDst
Write-Host "[build-servicehub] Mirrored Product Profiles to exe-sibling root: $profilesDst" -ForegroundColor Green

# --- llama-server inference bundle (exe-adjacent, "mechanism B") -------------
# llmrouter_manager.local.paths resolves llama-server at
# `Path(sys.executable).parent / inference / llama-win-sycl` in a frozen build, so
# this ~322 MB payload must sit at the bundle ROOT, not under _internal/_MEIPASS.
# Absorbed from build-llmrouter-manager.ps1: when LRM had its own onedir the
# staging lived there, and merging the bundles silently dropped it - an installed
# build would then fail local llama-cpp provisioning with "llama-server.exe not
# found". The installer's synchronized folder packages it automatically, so there
# are no .aip rows to maintain.
$inferenceSrc = Join-Path $HostDir 'llmrouter_manager\inference'
$inferenceDst = Join-Path $OutDir 'inference'
$llamaRelative = 'llama-win-sycl\llama-server.exe'
if (-not (Test-Path (Join-Path $inferenceSrc $llamaRelative))) {
    throw "[build-servicehub] Missing inference bundle source: $inferenceSrc\$llamaRelative"
}
if (Test-Path $inferenceDst) {
    # robocopy /MIR matches the destination to the source while skipping identical
    # files. A delete-then-recopy would move ~322 MB on every build for a payload
    # that almost never changes. Exit codes 0-7 are success (>=8 is a real error).
    $null = & robocopy $inferenceSrc $inferenceDst /MIR /NJH /NJS /NFL /NDL /NP
    if ($LASTEXITCODE -ge 8) { throw "[build-servicehub] robocopy of inference bundle failed (exit $LASTEXITCODE)" }
    $global:LASTEXITCODE = 0
} else {
    Copy-Item -LiteralPath $inferenceSrc -Destination $inferenceDst -Recurse -Force
}
if (-not (Test-Path (Join-Path $inferenceDst $llamaRelative))) {
    throw "[build-servicehub] Missing staged llama-server.exe at $inferenceDst\$llamaRelative"
}
Write-Host "[build-servicehub] Staged inference bundle -> $inferenceDst" -ForegroundColor Green

# --- per-service runtime assets ---------------------------------------------
# Carried over from the four absorbed specs' own assertions. Each of these fails
# silently at runtime rather than loudly, which is why it is asserted at build time.
# Only the privacy models' pinned manifest ships; without it privacy_manager
# cannot verify a download.
$requiredAssets = @(
    @{ Path = '_internal\protection_service\model_manifest.json'; Why = 'privacy_manager model download manifest' },
    @{ Path = '_internal\en_core_web_sm'; Why = 'tts_manager English G2P (silently loses the phonemizer without it)' },
    @{ Path = '_internal\tts_manager\voices.json'; Why = 'tts_manager voice registry' },
    @{ Path = '_internal\tts_manager\kokoro_vocab.json'; Why = 'tts_manager Kokoro phoneme vocabulary' },
    @{ Path = '_internal\llmrouter_manager\data'; Why = 'llmrouter_manager routing data' },
    @{ Path = '_internal\data\sandbox.default.json'; Why = 'sandbox_manager seed config' },
    @{ Path = '_internal\protection_service'; Why = 'privacy_manager service package (loose datas)' }
)
foreach ($asset in $requiredAssets) {
    $full = Join-Path $OutDir $asset.Path
    if (-not (Test-Path $full)) {
        throw "[build-servicehub] Missing bundled asset ($($asset.Why)): $full. Check the datas list in $SpecFile."
    }
}

# --- GPL gate (see build-gpl-gate.ps1) ----------------------------------------
Assert-NoGplInBundle -PyzToc (Join-Path $WorkPath 'superclaw_services\PYZ-00.toc') `
    -BundleDir $OutDir -LogPrefix '[build-servicehub]'

# --- ServiceHub's own frozen smokes (bare invocation = the servicehub role) ---
$contractsSmoke = & $ExePath --contracts-import-smoke 2>&1
if ($LASTEXITCODE -ne 0 -or $contractsSmoke -notcontains 'CONTRACTS_IMPORT_OK') {
    throw "[build-servicehub] Frozen contracts import smoke failed: $contractsSmoke"
}
Write-Host "[build-servicehub] Frozen contracts import smoke passed." -ForegroundColor Green

# --- role set + per-role frozen import smokes --------------------------------
# `--list-services` must agree with $AllRoles, so a role added to the dispatcher
# without updating this script (or service_cfg.json) fails the build instead of
# shipping a role nothing launches.
$listed = @(& $ExePath --list-services 2>&1)
if ($LASTEXITCODE -ne 0) { throw "[build-servicehub] --list-services failed: $listed" }
$listedRoles = @($listed | ForEach-Object { ($_ -split "`t")[0] } | Where-Object { $_ }) | Sort-Object
$expectedRoles = @($AllRoles | Sort-Object)
if (($listedRoles -join ',') -ne ($expectedRoles -join ',')) {
    throw "[build-servicehub] Role set mismatch. Bundle hosts [$($listedRoles -join ', ')] but this script expects [$($expectedRoles -join ', ')]. Update _pyinstaller_entry.py, service_cfg.json and the role lists here together."
}
Write-Host "[build-servicehub] Role set verified: $($listedRoles -join ', ')" -ForegroundColor Green

# service_cfg.json is the OTHER half of the contract: ServiceHub passes
# `--service <entry.name>` for every role entry, so a name the dispatcher does not
# host is a runtime exit 2 on that child rather than a build failure. Cross-check
# it here, against the same file that ships beside the exe. Property access goes
# through PSObject.Properties because Set-StrictMode -Latest throws on a missing
# member, and `launch` is optional per the schema.
$cfgJson = Get-Content -LiteralPath (Join-Path $OutDir 'service_cfg.json') -Raw | ConvertFrom-Json
$cfgRoles = @(
    foreach ($svc in $cfgJson.services) {
        $launch = $svc.PSObject.Properties['launch']
        if (-not $launch) { continue }
        $kind = $launch.Value.PSObject.Properties['kind']
        if ($kind -and $kind.Value -eq 'role') { $svc.name }
    }
)
if ($cfgRoles.Count -eq 0) {
    throw "[build-servicehub] service_cfg.json declares no role services, but this bundle is built as a multi-role payload. One of the two is wrong."
}
$unhosted = @($cfgRoles | Where-Object { $listedRoles -notcontains $_ })
if ($unhosted.Count -gt 0) {
    throw "[build-servicehub] service_cfg.json requests role(s) [$($unhosted -join ', ')] that this bundle does not host (it hosts [$($listedRoles -join ', ')]). ServiceHub would spawn them with --service and the child would exit 2."
}

# The role entries' exe_name must equal the image built here. ProcessManager.child_argv
# re-execs `sys.executable` and raises when its name disagrees with the declared
# exe_name, so a rename applied to only one of the two files is a runtime failure on
# the first child spawn -- i.e. an app that starts and then dies in the field. Catch it
# at build time instead.
$mismatched = @(
    foreach ($svc in $cfgJson.services) {
        $launch = $svc.PSObject.Properties['launch']
        if (-not $launch) { continue }
        $kind = $launch.Value.PSObject.Properties['kind']
        if (-not ($kind -and $kind.Value -eq 'role')) { continue }
        $declared = $launch.Value.PSObject.Properties['exe_name']
        $declaredName = if ($declared) { $declared.Value } else { '<missing>' }
        if ($declaredName -ne $ExeName) { "$($svc.name) -> $declaredName" }
    }
)
if ($mismatched.Count -gt 0) {
    throw "[build-servicehub] service_cfg.json declares launch.exe_name values that are not the built image ($ExeName): $($mismatched -join '; '). ProcessManager would refuse to re-exec, so update service_cfg.json and this script together."
}
Write-Host "[build-servicehub] service_cfg.json roles hosted: $($cfgRoles -join ', ') (exe_name $ExeName)" -ForegroundColor Green

# One process PER ROLE, never all of them at once: at runtime each role is its own
# process importing only its own stack, and the combined import produces failures
# that cannot happen in production (llmrouter_manager's _runtime_stubs finds the
# real torch that privacy_manager needs, skips its stub install, and the combined
# onnxruntime + openvino + torch import dies with an access violation).
#
# The smoke is the first execution of a freshly written bundle, so it pays
# Defender's real-time scan plus a cold read of every collected DLL - measured at
# 35.8 s across the five roles. Its verdict is a function of the sources the cache
# digest already covers (COLLECT copies from fixed paths, so an unchanged digest
# means an identical bundle), so skip it when the digest is unchanged AND the smoke
# already passed for that same digest. A failed smoke records nothing and is always
# retried; -Clean and Release always verify.
$smokeRequired = -not ($cacheState.Reused -and $cacheState.SmokeOk) -or $Clean -or $Configuration -eq 'Release'
if (-not $smokeRequired) {
    Write-Host "[build-servicehub] Skipping frozen import smokes (sources unchanged since the last verified build)." -ForegroundColor DarkGray
} else {
    # Run them CONCURRENTLY but throttled. Serial cost is 35.8 s and is dominated by
    # two roles (privacy_manager 19.1 s, llmrouter_manager 12.3 s), so overlapping
    # them takes the phase to roughly the slowest one. Throttled rather than
    # unbounded because each concurrent smoke unpacks the bundle and imports a heavy
    # native stack (torch / openvino / onnxruntime / spacy); three at a time captures
    # nearly all of the win without assuming the build host has the RAM this one has.
    $smokePhaseStart = Get-Date
    # The privacy models are downloaded after install, so the privacy_manager smoke
    # tokenizes with the repo's copy (tokenizer files are plain git files, not LFS).
    $privacySmokeModelsDir = Join-Path $HostDir 'privacy_manager\data_protection\models'
    $throttle = 3
    $pending = [System.Collections.Generic.Queue[string]]::new()
    $AllRoles | ForEach-Object { $pending.Enqueue($_) }
    $running = @{}
    $failures = @()

    while ($pending.Count -gt 0 -or $running.Count -gt 0) {
        while ($pending.Count -gt 0 -and $running.Count -lt $throttle) {
            $role = $pending.Dequeue()
            $running[$role] = Start-Job -ScriptBlock {
                param($exe, $roleName, $privacyModelsDir)
                # Job-local: the variable exists only for this smoke process.
                $env:SUPERCLAW_SMOKE_PRIVACY_MODELS_DIR = $privacyModelsDir
                $out = @(& $exe --import-smoke $roleName 2>&1)
                [pscustomobject]@{ Role = $roleName; ExitCode = $LASTEXITCODE; Output = $out }
            } -ArgumentList $ExePath, $role, $privacySmokeModelsDir
        }

        $done = @($running.Values | Wait-Job -Any)
        foreach ($job in $done) {
            $role = ($running.GetEnumerator() | Where-Object { $_.Value.Id -eq $job.Id }).Key
            $result = Receive-Job -Job $job
            Write-BuildTimingFromJob -Label "import smoke $role" -Job $job -FallbackStart $smokePhaseStart -Scope 'servicehub'
            Remove-Job -Job $job
            $running.Remove($role)

            if ($null -eq $result) {
                # The job itself died (crashed runspace, host out of resources) rather
                # than the smoke reporting a verdict. Under Set-StrictMode -Latest a
                # bare $result.ExitCode here would surface as an opaque property error.
                $failures += "  [$role] smoke job produced no result$([Environment]::NewLine)    $(($job.ChildJobs[0].JobStateInfo.Reason.Message) -replace '\s+', ' ')"
                Write-Host "[build-servicehub] Frozen import smoke job DIED: $role" -ForegroundColor Red
            } elseif ($result.ExitCode -ne 0 -or $result.Output -notcontains "SERVICES_IMPORT_OK $role") {
                $failures += "  [$role]$([Environment]::NewLine)$($result.Output -join [Environment]::NewLine)"
                Write-Host "[build-servicehub] Frozen import smoke FAILED: $role" -ForegroundColor Red
            } else {
                foreach ($note in @($result.Output | Where-Object { $_ -like 'OPENVINO_*' })) {
                    Write-Host "[build-servicehub]   [$role] $note" -ForegroundColor DarkGray
                }
                Write-Host "[build-servicehub] Frozen import smoke passed: $role" -ForegroundColor Green
            }
        }
    }

    if ($failures.Count -gt 0) {
        throw "[build-servicehub] Frozen import smoke failed for $($failures.Count) role(s):$([Environment]::NewLine)$($failures -join [Environment]::NewLine)"
    }
    Write-BuildTiming -Label 'import smokes (all roles)' -Start $smokePhaseStart -Scope 'servicehub'
    Set-PyInstallerSmokeVerified -WorkPath $WorkPath -Digest $cacheState.Digest
}

$commit = (& git -C $RepoRoot rev-parse --short HEAD 2>$null)
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($commit)) { $commit = 'unknown' }
Set-Content -LiteralPath (Join-Path $OutDir 'BUILD_COMMIT') -Value $commit -Encoding ASCII
Set-Content -LiteralPath (Join-Path $OutDir 'VERSION') -Value $BundleVersion -Encoding ASCII

# The payload tree is not wiped before the build, because COLLECT recreates its own
# directory. What that misses is a directory that STOPPED being produced: the four
# per-service child bundles this layout replaced would otherwise keep shipping
# their last build forever, and in Release the installer syncs this entire tree.
# So enumerate what this script is contractually responsible for and delete
# anything else at the top level. The pre-rename servicehub.exe is swept by exactly
# this rule, so an incremental build across the rename cannot ship two images.
$expectedTopLevel = @(
    $ExeName,
    '_internal',
    'service_cfg.json',
    'service_cfg.schema.json',
    'agent-config',
    # The exe-adjacent llama-server payload staged above. Omitting it here would
    # make this sweep delete the very bundle the previous step just staged.
    'inference',
    # The Windows-native backend payload, which build-native-backend.ps1 stages
    # beside the exe in both configurations. A full build stages it after this
    # sweep runs, so its absence here was invisible there; rebuilding ServiceHub
    # alone against an existing payload deleted ~1.34 GB and left
    # -SkipNativeBackend failing on the payload it was asked to reuse.
    'native-backend',
    'BUILD_COMMIT',
    'VERSION'
)

$stalePayload = @(
    Get-ChildItem -LiteralPath $OutDir -Force | Where-Object { $expectedTopLevel -notcontains $_.Name }
)
foreach ($item in $stalePayload) {
    Write-Host "[build-servicehub] Removing stale payload entry: $($item.Name)" -ForegroundColor Yellow
    Remove-WithRetry -Path $item.FullName
}
Assert-ProductProfileParity -PackagedProfilesRoot $profilesDst

# Advanced Installer's LZMA bootstrapper first expands files below a per-user
# temporary root and still uses legacy path handling in parts of that flow.
# Keep enough headroom for that staging prefix, not only Program Files.
$maxRelativePathLength = 160
$longPayloadPaths = @(
    Get-ChildItem -LiteralPath $OutDir -Recurse -Force -File | ForEach-Object {
        $relativePath = $_.FullName.Substring($OutDir.Length + 1)
        if ($relativePath.Length -gt $maxRelativePathLength) {
            [pscustomobject]@{
                Length = $relativePath.Length
                Path = $relativePath
            }
        }
    }
)
if ($longPayloadPaths.Count -gt 0) {
    $details = ($longPayloadPaths | Sort-Object Length -Descending | ForEach-Object {
        "  $($_.Length): $($_.Path)"
    }) -join [Environment]::NewLine
    throw "[build-servicehub] Payload path budget exceeded (maximum $maxRelativePathLength characters relative to servicehub):$([Environment]::NewLine)$details"
}

Write-Host "[build-servicehub] Build complete: $ExePath" -ForegroundColor Green

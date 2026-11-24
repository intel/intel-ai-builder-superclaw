<#
.SYNOPSIS
    Test ServiceHub backend readiness with one ServiceHub process lifetime.

.DESCRIPTION
    Launches a built/frozen superclaw-services.exe, waits for SERVICEHUB_READY, verifies
    Hub aggregate status and child health through the Hub proxy, then verifies
    sandbox-manager readiness through ServiceHub's restricted lifecycle adapter.
    It also records the current Product Profile and Runtime
    status so SKU-dependent startup behavior is visible in CI logs. TTS readiness
    is skipped by default because tts_manager is started on demand; pass
    -RequireTtsReadiness in a TTS-specific lane.

    On hardware that qualifies for the bundle-free Lite Product Profile, ServiceHub
    starts Lite at boot. Runtime convergence is then accepted, and the smoke requires
    that runtime to reach ready. While it waits it records the runtime's target
    Profile and state, and it fails as soon as readiness or the runtime reports
    state=failed (held for FailedConfirmSec), printing the blockers and the tail of
    the sandbox-manager log instead of waiting out SandboxReadinessTimeoutSec.

    This is intended to become the CI backend smoke entry point. It does not
    start sandbox_manager.exe separately; ServiceHub owns child process startup.

.PARAMETER ServiceHubExe
    Path to built superclaw-services.exe, for example build\Debug\servicehub\superclaw-services.exe.

.PARAMETER ReadinessScript
    Deprecated compatibility parameter. Sandbox readiness now uses ServiceHub's
    restricted lifecycle adapter instead of invoking the child smoke script.

.PARAMETER Port
    Requested ServiceHub port. ServiceHub may select a nearby free port; this
    script uses the port from SERVICEHUB_READY.

.PARAMETER HubToken
    Bearer token passed to ServiceHub. If empty, a random token is generated.

.PARAMETER LogDir
    Directory for ServiceHub stdout/stderr and sandbox readiness logs.

.PARAMETER AllowReuse
    Accept a REUSE handshake from an already-running ServiceHub. CI should keep
    the default false after pre-cleaning old processes.

.PARAMETER KeepRunningOnSuccess
    Leave the owned ServiceHub running after readiness succeeds so a following
    installed-build suite can use it. The caller must clean it up. Failures still
    stop the owned process; default behavior remains stop-on-exit.

.PARAMETER SkipSandboxReadiness
    Only verify ServiceHub and child health; skip sandbox readiness.

.PARAMETER RequireTtsReadiness
    Require the on-demand tts_manager child to pass readiness, proxy health, and
    aggregate status checks. By default these checks are skipped because launching
    the app no longer starts TTS.

.PARAMETER RequireSandboxRunning
    By default this smoke accepts runtime_deployment_required before a Product
    Profile has been selected and committed. CI resets its environment every run
    and cannot guarantee a selected local or Edge primary Bundle, so the default
    verifies Host readiness and the pre-activation Runtime API surface. Pass this
    switch in a SKU-specific lane that activates a Product Profile and requires a
    running Runtime.

.PARAMETER ActivateLocalModel
    Before checking sandbox readiness, and only when no Product Profile is active
    yet, drive a real Model Binding Activation (POST /app/model-binding/activations,
    intent=download_and_connect) against LRM's recommended local Bundle, the same
    call the app makes on a user's first run. Without this switch a fresh box with
    no committed Runtime Deployment is indistinguishable from "hardware has no local
    match, cloud-only Lite will auto-bootstrap" -- both hit runtime_deployment_required
    and are accepted below -- so sandbox readiness on hardware that DOES match a local
    Bundle has never actually been exercised by this script. Costs a real model
    download (single-digit GB); see ModelActivationTimeoutSec.

.PARAMETER ModelActivationTimeoutSec
    Budget for ActivateLocalModel's download-and-activate wait. Default is generous
    (a real multi-GB model download), not a tight regression budget.

.PARAMETER FailedConfirmSec
    How long readiness or the runtime must keep reporting state=failed before the
    smoke stops waiting and fails. Short, so a failed start is reported in seconds;
    non-zero, so a single transient failed probe does not end a slow but healthy start.

.PARAMETER MaxCumulativeFailedSec
    Total time ever observed in state=failed across the whole wait, regardless of
    intervening non-failed polls, before the smoke stops waiting and fails. A native
    deployment that retries can oscillate applying/failed fast enough that no single
    failed streak ever reaches FailedConfirmSec, which would otherwise hide a real,
    persistent failure behind the full SandboxReadinessTimeoutSec wait.

.PARAMETER VerifySandboxRestart
    Force-kill the ServiceHub-owned sandbox_manager process, then require a new
    healthy instance to appear through ServiceHub within RestartTimeoutSec.

.PARAMETER RequireSandboxDescendant
    Before force-killing Sandbox Manager, require a SuperClaw-owned descendant
    process to exist. This exercises desktop capability-runtime
    recovery rather than the child-only startup case.

.PARAMETER RequireRuntimeRecovery
    After Sandbox Manager recovers, require the OpenWork runtime health endpoint
    and authenticated OpenCode health proxy on port 8787 to recover and remain
    healthy for RuntimeStabilitySec.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File host\servicehub\scripts\test_servicehub_backend_readiness.ps1 `
      -ServiceHubExe build\Debug\servicehub\superclaw-services.exe
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)] [string] $ServiceHubExe,
    [string] $ReadinessScript = "",
    [int] $Port = 19000,
    [string] $HubToken = "",
    [string] $LogDir = ".\servicehub-smoke-logs",
    [int] $StartupTimeoutSec = 180,
    [int] $TtsReadinessTimeoutSec = 180,
    [int] $SandboxReadinessTimeoutSec = 1200,
    [int] $FailedConfirmSec = 10,
    [int] $MaxCumulativeFailedSec = 30,
    [int] $RestartTimeoutSec = 45,
    [int] $DescendantTimeoutSec = 30,
    [int] $RuntimeRecoveryTimeoutSec = 120,
    [int] $RuntimeStabilitySec = 30,
    [int] $ModelActivationTimeoutSec = 1800,
    [switch] $AllowReuse,
    [switch] $KeepRunningOnSuccess,
    [switch] $SkipSandboxReadiness,
    [switch] $RequireTtsReadiness,
    [switch] $RequireSandboxRunning,
    [switch] $ActivateLocalModel,
    [switch] $VerifySandboxRestart,
    [switch] $RequireSandboxDescendant,
    [switch] $RequireRuntimeRecovery
)

$ErrorActionPreference = "Stop"

function Write-Step([string]$Message) { Write-Host "`n==> $Message" -ForegroundColor Cyan }
function Write-Ok([string]$Message)   { Write-Host "    [OK]   $Message" -ForegroundColor Green }
function Write-Warn([string]$Message) { Write-Host "    [WARN] $Message" -ForegroundColor Yellow }
function Write-Fail([string]$Message) { Write-Host "    [FAIL] $Message" -ForegroundColor Red }

function Add-ReadinessCheckpoint([string]$Name) {
    $elapsed = $script:ReadinessClock.ElapsedMilliseconds
    $script:ReadinessCheckpoints.Add([ordered]@{ name = $Name; elapsed_ms = $elapsed })
    Write-Host "    [TIMING] checkpoint=$Name elapsed_ms=$elapsed"
}

function New-HubToken {
    $bytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $rng.GetBytes($bytes)
    } finally {
        $rng.Dispose()
    }
    return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Invoke-HubJson {
    param(
        [Parameter(Mandatory = $true)] [string] $BaseUrl,
        [Parameter(Mandatory = $true)] [string] $Path,
        [string] $Method = "GET",
        [string] $Token = "",
        [string] $Body = ""
    )
    $params = @{ Method = $Method; Uri = "$BaseUrl$Path"; TimeoutSec = 10; ErrorAction = "Stop" }
    if ($Token) {
        $params["Headers"] = @{ Authorization = "Bearer $Token" }
    }
    if ($Body) {
        $params["ContentType"] = "application/json"
        $params["Body"] = $Body
    }
    return Invoke-RestMethod @params
}

function Get-ApiErrorCode {
    param($ErrorRecord)
    try {
        $body = $ErrorRecord.ErrorDetails.Message | ConvertFrom-Json
        if ($body.error.code) { return [string]$body.error.code }
        if ($body.detail.error.code) { return [string]$body.detail.error.code }
    } catch {
        return $null
    }
    return $null
}

function Format-ReadinessBlockers {
    param($Readiness)

    if ($null -eq $Readiness) { return "no readiness document was retrieved" }
    $blockers = @($Readiness.components | Where-Object {
        $_.startup -eq "required" -and $_.state -ne "ready"
    } | ForEach-Object {
        "$($_.name)=$($_.state)$(if ($_.reason_code) { "/$($_.reason_code)" })"
    })
    if ($blockers.Count -eq 0) { return "state=$($Readiness.state) with no required blocker reported" }
    return "state=$($Readiness.state) blockers: $($blockers -join ', ')"
}

function Get-ProductProfileSummary {
    param(
        [Parameter(Mandatory = $true)] [string] $BaseUrl,
        [Parameter(Mandatory = $true)] [string] $Token
    )
    try {
        $capabilityProfile = Invoke-HubJson -BaseUrl $BaseUrl -Path "/app/capability-profile" -Token $Token
    } catch {
        $statusCode = [int]$_.Exception.Response.StatusCode
        if ($statusCode -in @(423, 503)) {
            return [pscustomobject]@{
                Active = $false
                Text   = "not active yet (HTTP $statusCode $(Get-ApiErrorCode -ErrorRecord $_))"
            }
        }
        throw
    }
    if ($capabilityProfile.lifecycle_state -eq "active") {
        return [pscustomobject]@{
            Active = $true
            Text   = "id=$($capabilityProfile.product_profile_id), revision=$($capabilityProfile.profile_revision), lifecycle=active"
        }
    }
    return [pscustomobject]@{
        Active = $false
        Text   = "lifecycle=$($capabilityProfile.lifecycle_state), recovery_code=$($capabilityProfile.recovery_code), reasons=$(@($capabilityProfile.reasons) -join ',')"
    }
}

function Request-ModelActivation {
    # Drives the same Model Binding Activation flow the app's first-run model picker
    # uses, so a box whose hardware matches a local Bundle (and therefore never
    # qualifies for the free cloud-only Lite auto-bootstrap -- see the
    # cloud_only_product_profile_id check below) gets a committed Runtime Deployment
    # too. Without this, sandbox readiness below has nothing to converge and silently
    # accepts runtime_deployment_required as "nothing to test here".
    param(
        [Parameter(Mandatory = $true)] [string] $BaseUrl,
        [Parameter(Mandatory = $true)] [string] $Token,
        [Parameter(Mandatory = $true)] [int] $TimeoutSec
    )
    $capability = Invoke-HubJson -BaseUrl $BaseUrl -Path "/llm-router/v1/capability/primary-bundle" -Token $Token
    if ($capability.cloud_only_product_profile_id -eq "lite") {
        Write-Warn "Hardware matches no local Bundle; the automatic cloud-only Lite bootstrap commits a Runtime Deployment in the background -- nothing to activate here."
        return
    }
    $bundleId = $capability.recommended_bundle_id
    if (-not $bundleId) {
        throw "No recommended local Bundle and no cloud-only Lite eligibility: reasons=$(@($capability.reasons) -join ',')"
    }
    $bundle = @($capability.supported_bundles) | Where-Object { $_.bundle_id -eq $bundleId } | Select-Object -First 1
    if ($bundle.download_feasibility -eq "insufficient_disk") {
        throw "Recommended Bundle '$bundleId' cannot be activated: $($bundle.download_block_reason)"
    }
    # "connect" (no download) when the installer or a prior run already cached the
    # Bundle; download_and_connect requires user_confirmed_download -- including that
    # field under "connect" would fail contract validation (extra="forbid").
    $intent = if ($bundle.fully_cached_and_verified) { "connect" } else { "download_and_connect" }
    $downloadGb = [math]::Round([double]$bundle.total_download_bytes / 1GB, 2)
    Write-Ok "Recommended Bundle: $bundleId (intent=$intent, ${downloadGb} GB, feasibility=$($bundle.download_feasibility))"

    $expectedRevision = if ($capability.primary_bundle) { [long]$capability.primary_bundle.bundle_revision } else { 0 }
    $bodyMap = [ordered]@{
        contract_version         = 1
        intent                   = $intent
        target_bundle_id         = $bundleId
        expected_bundle_revision = $expectedRevision
        candidate_revision       = [long]$capability.model_candidate_revision
        idempotency_key          = "g4-smoke-$([guid]::NewGuid().ToString('N'))"
    }
    if ($intent -eq "download_and_connect") { $bodyMap["user_confirmed_download"] = $true }
    $activation = Invoke-HubJson -BaseUrl $BaseUrl -Path "/app/model-binding/activations" -Method "POST" -Token $Token `
        -Body ($bodyMap | ConvertTo-Json)
    $operationId = [string]$activation.operation_id
    if ([string]::IsNullOrWhiteSpace($operationId)) {
        throw "Model Binding Activation returned no operation_id."
    }

    # /activations/active drops terminal operations. Follow the accepted operation's
    # durable result so a runtime failure cannot turn into a full activation timeout.
    # A successful operation still needs the Product Profile to become active.
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    $lastStage = $null
    $profileActiveNow = $false
    do {
        Start-Sleep -Seconds 3
        $op = Invoke-HubJson -BaseUrl $BaseUrl -Path "/app/operations/$operationId" -Token $Token
        if ($op) {
            $stage = "status=$($op.status) stage=$($op.stage) pct=$($op.progress.pct)"
            if ($stage -ne $lastStage) { Write-Host "    [WAIT] model activation: $stage"; $lastStage = $stage }
            if ($op.status -eq "failed") {
                Write-SandboxManagerLogTail
                throw "Model Binding Activation $operationId failed: $($op.error.code) -- $($op.error.message)"
            }
        }
        $profileActiveNow = (Get-ProductProfileSummary -BaseUrl $BaseUrl -Token $Token).Active
    } while (-not $profileActiveNow -and (Get-Date) -lt $deadline)
    if (-not $profileActiveNow) {
        throw "Product Profile did not become active within ${TimeoutSec}s of requesting activation (last: $lastStage)"
    }
    Write-Ok "Model activation for '$bundleId' committed a Product Profile"
}

function Get-RuntimeProfileStatus {
    param(
        [Parameter(Mandatory = $true)] [string] $BaseUrl,
        [Parameter(Mandatory = $true)] [string] $Token
    )
    try {
        return Invoke-HubJson -BaseUrl $BaseUrl -Path "/sandbox-manager/v1/capability/runtime-profile" -Token $Token
    } catch {
        $reason = Get-ApiErrorCode -ErrorRecord $_
        if (-not $reason) { $reason = $_.Exception.Message }
        return [pscustomobject]@{ state = "unavailable"; reason = $reason }
    }
}

function Format-RuntimeProfileStatus {
    param($Status)
    switch ($Status.state) {
        "ready"    { return "state=ready profile=$($Status.profile)" }
        "applying" { return "state=applying target_profile=$($Status.target_profile)" }
        "failed"   { return "state=failed target_profile=$($Status.target_profile) error=$($Status.error.code): $($Status.error.message)" }
        default    { return "state=$($Status.state) ($($Status.reason))" }
    }
}

function Write-SandboxManagerLogTail {
    param([int] $Lines = 60)
    $logRoot = Join-Path $env:LOCALAPPDATA "SuperClaw\sandbox_manager\logs"
    $latest = Get-ChildItem -Path $logRoot -Recurse -File -Filter "sbms-*.log" -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
    if (-not $latest) {
        Write-Warn "No sandbox-manager log (sbms-*.log) found under $logRoot"
        return
    }
    Write-Host "    --- last $Lines lines of $($latest.FullName) ---"
    try {
        Get-Content -LiteralPath $latest.FullName -Tail $Lines -ErrorAction Stop |
            Where-Object { $_.Trim() } |
            ForEach-Object { Write-Host "    $_" }
    } catch {
        Write-Warn "Could not read $($latest.FullName): $($_.Exception.Message)"
    }
    Write-Host "    --- end of sandbox-manager log ---"
}

function Wait-ServiceHubHandshake {
    param(
        [Parameter(Mandatory = $true)] [System.Diagnostics.Process] $Process,
        [Parameter(Mandatory = $true)] [string] $StdoutPath,
        [Parameter(Mandatory = $true)] [int] $TimeoutSec
    )
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    $lastLength = 0
    $buffer = ""
    while ((Get-Date) -lt $deadline) {
        if (Test-Path $StdoutPath) {
            $content = Get-Content -LiteralPath $StdoutPath -Raw -ErrorAction SilentlyContinue
            if ($content -and $content.Length -ne $lastLength) {
                $lastLength = $content.Length
                $buffer = $content
                foreach ($line in @($buffer -split "`r?`n")) {
                    $trimmed = $line.Trim()
                    if ($trimmed -match '^(SERVICEHUB_READY|REUSE)\s+(\{.*\})$') {
                        $payload = $Matches[2] | ConvertFrom-Json
                        return [pscustomobject]@{
                            Kind  = $Matches[1]
                            Port  = [int]$payload.port
                            Token = [string]$payload.token
                        }
                    }
                }
            }
        }
        if ($Process.HasExited) {
            throw "servicehub exited before SERVICEHUB_READY (code $($Process.ExitCode)). See $StdoutPath"
        }
        Start-Sleep -Milliseconds 200
    }
    throw "Timed out after ${TimeoutSec}s waiting for SERVICEHUB_READY. Last stdout: $buffer"
}

function Assert-ServicesReady {
    param(
        [Parameter(Mandatory = $true)] $Payload,
        [Parameter(Mandatory = $true)] [string[]] $ExpectedNames
    )
    if (-not $Payload.ok) {
        throw "ServiceHub /app/services/status reported ok=false: $($Payload | ConvertTo-Json -Depth 8 -Compress)"
    }
    $services = @($Payload.services)
    foreach ($name in $ExpectedNames) {
        $service = $services | Where-Object { $_.name -eq $name } | Select-Object -First 1
        if (-not $service) {
            throw "Expected ServiceHub child service missing from /app/services/status: $name"
        }
        if ($service.state -ne "running") {
            throw "ServiceHub child service '$name' state is '$($service.state)', expected running"
        }
        if ($service.error) {
            throw "ServiceHub child service '$name' status error: $($service.error | ConvertTo-Json -Depth 5 -Compress)"
        }
        Write-Ok "Service status ready: $name (port=$($service.port), prefix=$($service.proxy_prefix))"
    }
}

function Wait-OptionalServiceReady {
    param(
        [Parameter(Mandatory = $true)] [string] $BaseUrl,
        [Parameter(Mandatory = $true)] [string] $Token,
        [Parameter(Mandatory = $true)] [string] $ServiceName,
        [Parameter(Mandatory = $true)] [int] $TimeoutSec
    )
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    $lastEntry = $null
    $lastError = $null
    while ((Get-Date) -lt $deadline) {
        try {
            $aggregate = Invoke-HubJson -BaseUrl $BaseUrl -Path "/app/services/health" -Token $Token
            $lastEntry = @($aggregate.services) |
                Where-Object { $_.name -eq $ServiceName } |
                Select-Object -First 1
            if (
                $lastEntry -and
                $lastEntry.state -eq "running" -and
                $lastEntry.healthy -eq $true -and
                $lastEntry.registry_healthy -eq $true -and
                $lastEntry.probe_healthy -eq $true -and
                -not [string]::IsNullOrWhiteSpace([string]$lastEntry.instance_id)
            ) {
                return $lastEntry
            }
            $lastError = $null
        } catch {
            $lastError = $_.Exception.Message
        }
        Start-Sleep -Milliseconds 500
    }
    $detail = if ($lastEntry) {
        $lastEntry | ConvertTo-Json -Depth 6 -Compress
    } elseif ($lastError) {
        $lastError
    } else {
        "<service not registered>"
    }
    throw "Optional child '$ServiceName' did not become healthy within ${TimeoutSec}s; last observation: $detail"
}

function Copy-IfPresent {
    param([string]$Source, [string]$Destination)
    if (-not (Test-Path $Source)) { return }
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    Copy-Item -Path (Join-Path $Source "*") -Destination $Destination -Recurse -Force -ErrorAction SilentlyContinue
}

function Stop-ProcessTreeById {
    param(
        [Parameter(Mandatory = $true)] [int] $ProcessId,
        [Parameter(Mandatory = $true)] [string] $Label
    )
    if (-not (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) {
        return
    }
    Write-Warn "Stopping $Label (pid $ProcessId)"
    & cmd.exe /c "taskkill /F /T /PID $ProcessId 2>&1" | Out-Null
    $global:LASTEXITCODE = 0
}

if (-not (Test-Path $ServiceHubExe)) {
    throw "superclaw-services.exe not found: $ServiceHubExe"
}
$ServiceHubExe = (Resolve-Path $ServiceHubExe).Path

if (-not $HubToken) {
    $HubToken = New-HubToken
}

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$LogDir = (Resolve-Path $LogDir).Path
$stdoutLog = Join-Path $LogDir "servicehub.stdout.log"
$stderrLog = Join-Path $LogDir "servicehub.stderr.log"
Remove-Item $stdoutLog, $stderrLog -ErrorAction SilentlyContinue

$serviceHubProcess = $null
$ownsProcess = $false
$readinessPassed = $false
$readinessStartedAt = [DateTime]::UtcNow.ToString('o')
$script:ReadinessCheckpoints = [Collections.Generic.List[object]]::new()
$script:ReadinessClock = [Diagnostics.Stopwatch]::StartNew()
try {
    Write-Step "Launching ServiceHub"
    Write-Host "    superclaw-services.exe: $ServiceHubExe"
    Write-Host "    requested port: $Port"
    $env:CAPABILITY_GATING_V1 = "1"
    Write-Host "    capability architecture: CAPABILITY_GATING_V1=1"
    Add-ReadinessCheckpoint 'servicehub.launch'
    $serviceHubProcess = Start-Process -FilePath $ServiceHubExe `
        -ArgumentList @('--port', [string]$Port, '--hub-token', $HubToken) `
        -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog `
        -PassThru -WindowStyle Hidden
    $ownsProcess = $true

    $handshake = Wait-ServiceHubHandshake -Process $serviceHubProcess -StdoutPath $stdoutLog -TimeoutSec $StartupTimeoutSec
    Add-ReadinessCheckpoint 'servicehub.handshake'
    if ($handshake.Kind -eq "REUSE" -and -not $AllowReuse) {
        throw "ServiceHub emitted REUSE. CI smoke expects a fresh ServiceHub after cleanup. Stop the existing Hub or pass -AllowReuse for local debugging."
    }
    if ($handshake.Kind -eq "REUSE") {
        $ownsProcess = $false
        Write-Warn "Reusing existing ServiceHub on port $($handshake.Port)"
    } else {
        Write-Ok "SERVICEHUB_READY port=$($handshake.Port)"
    }
    # A caller cannot always safely capture this script's own live stdout to recover the bound port
    # (e.g. piping it through Tee-Object while -KeepRunningOnSuccess intentionally leaves this
    # process's child running: confirmed live 2026-10-29 that the pipe then never sees EOF, because
    # the still-running child can end up holding an inherited handle to it, so the piping step hangs
    # until the job times out). Writing it to a plain file sidesteps that pipe entirely.
    Set-Content -LiteralPath (Join-Path $LogDir "servicehub-port.txt") -Value $handshake.Port -Encoding ascii

    $baseUrl = "http://127.0.0.1:$($handshake.Port)"

    Write-Step "Verifying ServiceHub meta routes"
    $health = Invoke-HubJson -BaseUrl $baseUrl -Path "/health"
    if ($health.status -ne "ok") {
        throw "ServiceHub /health status is '$($health.status)', expected ok"
    }
    Write-Ok "Hub /health: $($health | ConvertTo-Json -Compress)"
    $version = Invoke-HubJson -BaseUrl $baseUrl -Path "/version"
    Write-Ok "Hub /version: $($version | ConvertTo-Json -Compress)"

    Write-Step "Verifying ServiceHub aggregate status"
    $status = Invoke-HubJson -BaseUrl $baseUrl -Path "/app/services/status" -Token $handshake.Token
    Assert-ServicesReady -Payload $status -ExpectedNames @("llmrouter_manager", "privacy_manager", "sandbox_manager")
    Add-ReadinessCheckpoint 'services.status'

    Write-Step "Recording Product Profile and Runtime status"
    $profileSummary = Get-ProductProfileSummary -BaseUrl $baseUrl -Token $handshake.Token
    $profileActive = $profileSummary.Active
    if (-not $profileActive -and $ActivateLocalModel) {
        Write-Warn "Product Profile: $($profileSummary.Text)"
        Add-ReadinessCheckpoint 'model_activation.begin'
        Request-ModelActivation -BaseUrl $baseUrl -Token $handshake.Token -TimeoutSec $ModelActivationTimeoutSec
        Add-ReadinessCheckpoint 'model_activation.end'
        $profileSummary = Get-ProductProfileSummary -BaseUrl $baseUrl -Token $handshake.Token
        $profileActive = $profileSummary.Active
    }
    if ($profileActive) {
        Write-Ok "Product Profile: $($profileSummary.Text)"
    } else {
        Write-Warn "Product Profile: $($profileSummary.Text)"
    }
    $readiness = Invoke-HubJson -BaseUrl $baseUrl -Path "/app/readiness" -Token $handshake.Token
    Write-Ok "App readiness: $(Format-ReadinessBlockers $readiness)"
    $runtimeProfile = Get-RuntimeProfileStatus -BaseUrl $baseUrl -Token $handshake.Token
    Write-Ok "Runtime Profile: $(Format-RuntimeProfileStatus $runtimeProfile)"

    Write-Step "Verifying child health through ServiceHub proxy"
    $healthChecks = @(
        @{ Path = "/llm-router/v1/health"; Service = "llmrouter_manager" },
        @{ Path = "/data-protection/v1/health"; Service = "privacy_manager" },
        @{ Path = "/sandbox-manager/v1/health"; Service = "sandbox_manager" }
    )
    foreach ($check in $healthChecks) {
        $childHealth = Invoke-HubJson -BaseUrl $baseUrl -Path $check.Path
        if ($childHealth.service -ne $check.Service -or $childHealth.status -ne "ok") {
            throw "Unexpected child health for $($check.Path): $($childHealth | ConvertTo-Json -Depth 5 -Compress)"
        }
        Write-Ok "$($check.Path): service=$($childHealth.service), status=$($childHealth.status), pid=$($childHealth.pid)"
    }

    if ($RequireTtsReadiness) {
        Write-Step "Waiting for optional tts_manager readiness"
        $ttsAggregateHealth = Wait-OptionalServiceReady `
            -BaseUrl $baseUrl `
            -Token $handshake.Token `
            -ServiceName "tts_manager" `
            -TimeoutSec $TtsReadinessTimeoutSec
        Write-Ok "TTS aggregate health ready: instance_id=$($ttsAggregateHealth.instance_id)"

        $ttsHealth = Invoke-HubJson -BaseUrl $baseUrl -Path "/tts-narration/v1/health"
        if (
            $ttsHealth.service -ne "tts_manager" -or
            $ttsHealth.status -ne "ok" -or
            [int]$ttsHealth.pid -le 0 -or
            [string]$ttsHealth.instance_id -ne [string]$ttsAggregateHealth.instance_id
        ) {
            throw "Unexpected TTS child health: $($ttsHealth | ConvertTo-Json -Depth 5 -Compress)"
        }
        Write-Ok "/tts-narration/v1/health: status=ok, pid=$($ttsHealth.pid), model_status=$($ttsHealth.model_status)"

        $ttsAggregateStatus = Invoke-HubJson -BaseUrl $baseUrl -Path "/app/services/status" -Token $handshake.Token
        $ttsStatus = @($ttsAggregateStatus.services) |
            Where-Object { $_.name -eq "tts_manager" } |
            Select-Object -First 1
        if (
            -not $ttsStatus -or
            $ttsStatus.state -ne "running" -or
            $ttsStatus.status_supported -ne $true -or
            $ttsStatus.error -or
            $ttsStatus.status.state -ne "running" -or
            -not $ttsStatus.status.summary.tts
        ) {
            $detail = if ($ttsStatus) {
                $ttsStatus | ConvertTo-Json -Depth 8 -Compress
            } else {
                "<missing>"
            }
            throw "Unexpected tts_manager aggregate status: $detail"
        }
        Write-Ok "TTS aggregate status exposes summary.tts"
    }
    Add-ReadinessCheckpoint 'services.health'

    if ($VerifySandboxRestart) {
        Write-Step "Verifying packaged sandbox_manager crash recovery"
        $before = Invoke-HubJson -BaseUrl $baseUrl -Path "/sandbox-manager/v1/health"
        $oldPid = [int]$before.pid
        $oldInstanceId = [string]$before.instance_id
        if ($RequireSandboxDescendant) {
            $descendantDeadline = (Get-Date).AddSeconds($DescendantTimeoutSec)
            $descendant = $null
            while ((Get-Date) -lt $descendantDeadline) {
                $descendant = Get-CimInstance Win32_Process -Filter "ParentProcessId=$oldPid" |
                    Where-Object {
                        $_.CommandLine -and
                        $_.CommandLine.ToLowerInvariant().Contains("superclaw")
                    } |
                    Select-Object -First 1
                if ($descendant) { break }
                Start-Sleep -Milliseconds 250
            }
            if (-not $descendant) {
                throw "No verified SuperClaw descendant appeared under sandbox_manager pid=$oldPid within ${DescendantTimeoutSec}s"
            }
            Write-Ok "Observed sandbox descendant pid=$($descendant.ProcessId): $($descendant.CommandLine)"
        }
        Write-Warn "Force-killing sandbox_manager pid=$oldPid instance_id=$oldInstanceId"
        Stop-Process -Id $oldPid -Force -ErrorAction Stop

        $deadline = (Get-Date).AddSeconds($RestartTimeoutSec)
        $lastEntry = $null
        $restarted = $false
        while ((Get-Date) -lt $deadline) {
            Start-Sleep -Milliseconds 250
            $aggregate = Invoke-HubJson -BaseUrl $baseUrl -Path "/app/services/health" -Token $handshake.Token
            $lastEntry = @($aggregate.services) |
                Where-Object { $_.name -eq "sandbox_manager" } |
                Select-Object -First 1
            if (
                $lastEntry -and
                $lastEntry.state -eq "running" -and
                $lastEntry.healthy -eq $true -and
                [string]$lastEntry.instance_id -ne $oldInstanceId
            ) {
                $restarted = $true
                break
            }
        }
        if (-not $restarted) {
            $detail = if ($lastEntry) {
                $lastEntry | ConvertTo-Json -Depth 6 -Compress
            } else {
                "<missing>"
            }
            throw "sandbox_manager did not recover within ${RestartTimeoutSec}s; last aggregate entry: $detail"
        }

        $after = Invoke-HubJson -BaseUrl $baseUrl -Path "/sandbox-manager/v1/health"
        if ([string]$after.instance_id -eq $oldInstanceId -or [int]$after.pid -eq $oldPid) {
            throw "sandbox_manager recovery reused stale identity: $($after | ConvertTo-Json -Depth 5 -Compress)"
        }
        Write-Ok "sandbox_manager recovered pid=$($after.pid) instance_id=$($after.instance_id)"

        if ($RequireRuntimeRecovery) {
            # One authority. This used to hand-roll runtime convergence here --
            # OpenWork /health, an OWT fetch, OpenCode /opencode/global/health, and a
            # stability loop -- which is a fourth independent definition of "the app
            # works". ServiceHub now owns that judgement, so this asserts the product
            # verdict instead of recomputing it.
            #
            # The endpoint returns HTTP 200 for every served document, including
            # not-ready ones, which is what makes this readable: Invoke-RestMethod runs
            # with ErrorAction Stop, and a 503 would raise with the component detail
            # unreachable -- exactly the diagnostics needed when a run fails.
            $runtimeDeadline = (Get-Date).AddSeconds($RuntimeRecoveryTimeoutSec)
            $readiness = $null
            while ((Get-Date) -lt $runtimeDeadline) {
                Start-Sleep -Milliseconds 500
                $readiness = Invoke-HubJson -BaseUrl $baseUrl -Path "/app/readiness" -Token $handshake.Token
                if ($readiness.state -eq "ready") { break }
            }
            if ($null -eq $readiness -or $readiness.state -ne "ready") {
                throw "App readiness did not reach ready within ${RuntimeRecoveryTimeoutSec}s after sandbox_manager restart: $(Format-ReadinessBlockers $readiness)"
            }
            Write-Ok "App readiness reached state=ready"

            $stabilityDeadline = (Get-Date).AddSeconds($RuntimeStabilitySec)
            while ((Get-Date) -lt $stabilityDeadline) {
                Start-Sleep -Seconds 1
                $readiness = Invoke-HubJson -BaseUrl $baseUrl -Path "/app/readiness" -Token $handshake.Token
                if ($readiness.state -ne "ready") {
                    throw "App readiness regressed during ${RuntimeStabilitySec}s stability window: $(Format-ReadinessBlockers $readiness)"
                }
            }
            Write-Ok "App readiness remained ready for ${RuntimeStabilitySec}s"
        }
    }

    if (-not $SkipSandboxReadiness) {
        Write-Step "Verifying sandbox readiness through ServiceHub control plane"
        $sandboxStatus = Invoke-HubJson -BaseUrl $baseUrl -Path "/sandbox-manager/v1/system/status" -Token $handshake.Token
        Write-Ok "SandboxManager status: phase=$($sandboxStatus.sandbox.phase)"

        Add-ReadinessCheckpoint 'runtime.converge.begin'
        try {
            $convergence = Invoke-HubJson -BaseUrl $baseUrl -Path "/app/runtime/converge" -Method "POST" -Token $handshake.Token
        } catch {
            $errorCode = Get-ApiErrorCode -ErrorRecord $_
            if (-not $profileActive -and $errorCode -eq "runtime_deployment_required" -and -not $RequireSandboxRunning) {
                Write-Warn "runtime_deployment_required -- Host API and restricted lifecycle adapter are ready, but no Product Profile Runtime Deployment is stored."
                $convergence = $null
            } else {
                throw
            }
        }
        Add-ReadinessCheckpoint 'runtime.converge.end'

        if ($convergence) {
            Write-Ok "Runtime convergence accepted: state=$($convergence.state), operation_id=$($convergence.operation_id)"
            $runtimeStarted = Get-Date
            $runtimeDeadline = $runtimeStarted.AddSeconds($SandboxReadinessTimeoutSec)
            $lastObservation = $null
            $failedSince = $null
            $cumulativeFailedSec = 0
            $previousPollAt = $runtimeStarted
            # This wait ends the warm number G4 gates on, so its poll stays well under
            # /app/readiness's own 1s refresh while the Runtime is not ready.
            $pollIntervalMs = 500
            do {
                $runtimeReadiness = Invoke-HubJson -BaseUrl $baseUrl -Path "/app/readiness" -Token $handshake.Token
                if ($runtimeReadiness.state -eq "ready") { break }
                $runtimeProfile = Get-RuntimeProfileStatus -BaseUrl $baseUrl -Token $handshake.Token
                $polledAt = Get-Date
                $observation = "readiness $(Format-ReadinessBlockers $runtimeReadiness); runtime $(Format-RuntimeProfileStatus $runtimeProfile)"
                if ($observation -ne $lastObservation) {
                    Write-Host "    [WAIT] +$([int]((Get-Date) - $runtimeStarted).TotalSeconds)s $observation"
                    $lastObservation = $observation
                }
                if ($runtimeReadiness.state -eq "failed" -or $runtimeProfile.state -eq "failed") {
                    if ($null -eq $failedSince) { $failedSince = $polledAt }
                    # A failed poll counts the time since the poll before it, so both limits
                    # stay in seconds whatever the poll interval.
                    $cumulativeFailedSec += ($polledAt - $previousPollAt).TotalSeconds
                    # Two independent triggers: a stable failure (continuous) and a retrying
                    # deployment that keeps bouncing applying/failed without ever holding
                    # failed long enough to trip the continuous check on its own. Both are a
                    # real, persistent failure; only the shape of the state machine differs.
                    $continuousFailedSec = ($polledAt - $failedSince).TotalSeconds
                    if ($continuousFailedSec -ge $FailedConfirmSec -or $cumulativeFailedSec -ge $MaxCumulativeFailedSec) {
                        Write-Fail "Runtime reported state=failed (continuous ${continuousFailedSec}s, cumulative ${cumulativeFailedSec}s), $([int]((Get-Date) - $runtimeStarted).TotalSeconds)s after convergence"
                        try {
                            Write-Fail "Product Profile: $((Get-ProductProfileSummary -BaseUrl $baseUrl -Token $handshake.Token).Text)"
                        } catch {
                            Write-Fail "Product Profile: unreadable ($($_.Exception.Message))"
                        }
                        Write-SandboxManagerLogTail
                        throw "Runtime failed to start: $observation"
                    }
                } else {
                    $failedSince = $null
                }
                $previousPollAt = $polledAt
                Start-Sleep -Milliseconds $pollIntervalMs
            } while ((Get-Date) -lt $runtimeDeadline)
            if ($runtimeReadiness.state -ne "ready") {
                Write-SandboxManagerLogTail
                throw "Runtime did not become ready within ${SandboxReadinessTimeoutSec}s: $(Format-ReadinessBlockers $runtimeReadiness)"
            }
            Add-ReadinessCheckpoint 'runtime.readiness'
            $sandboxToken = Invoke-HubJson -BaseUrl $baseUrl -Path "/app/runtime/sandbox-token" -Token $handshake.Token
            if ([string]::IsNullOrWhiteSpace([string]$sandboxToken.token)) {
                throw "ServiceHub returned an empty sandbox token after Runtime convergence."
            }
            Write-Ok "Runtime readiness and ServiceHub sandbox-token broker passed"
            Add-ReadinessCheckpoint 'runtime.token_verified'
        }
        Write-Ok "Sandbox readiness passed"
    }

    Write-Step "SERVICEHUB BACKEND READINESS PASSED"
    $readinessPassed = $true
    Add-ReadinessCheckpoint 'readiness.passed'
}
finally {
    Write-Step "Collecting ServiceHub backend smoke logs"
    Add-ReadinessCheckpoint 'logs.collect.begin'
    Copy-IfPresent -Source (Join-Path $env:LOCALAPPDATA "SuperClaw\servicehub\logs") -Destination (Join-Path $LogDir "servicehub-data-logs")
    Copy-IfPresent -Source (Join-Path $env:LOCALAPPDATA "SuperClaw\sandbox_manager\logs") -Destination (Join-Path $LogDir "sandbox-manager-data-logs")
    Copy-IfPresent -Source (Join-Path $env:LOCALAPPDATA "SuperClaw\tts_manager\logs") -Destination (Join-Path $LogDir "tts-manager-data-logs")
    Add-ReadinessCheckpoint 'logs.collect.end'

    if ($serviceHubProcess -and $ownsProcess -and -not $serviceHubProcess.HasExited -and
        -not ($KeepRunningOnSuccess -and $readinessPassed)) {
        Add-ReadinessCheckpoint 'servicehub.stop.begin'
        Stop-ProcessTreeById -ProcessId $serviceHubProcess.Id -Label "ServiceHub"
        Wait-Process -Id $serviceHubProcess.Id -Timeout 10 -ErrorAction SilentlyContinue
        Add-ReadinessCheckpoint 'servicehub.stop.end'
    }
    $script:ReadinessClock.Stop()
    # Diagnostic breakdown only. The caller's end-to-end budget still includes this whole script.
    [ordered]@{
        schema = 'servicehub-readiness-timing/v1'; started_at = $readinessStartedAt
        servicehub_pid = if ($serviceHubProcess) { $serviceHubProcess.Id } else { $null }
        readiness_passed = $readinessPassed; keep_running_on_success = [bool]$KeepRunningOnSuccess
        elapsed_ms = $script:ReadinessClock.ElapsedMilliseconds; checkpoints = @($script:ReadinessCheckpoints.ToArray())
    } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $LogDir 'readiness-timing.json') -Encoding UTF8
    Write-Host "Logs: $LogDir"
}

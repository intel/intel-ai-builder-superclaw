<#
.SYNOPSIS
    Test sandbox-manager readiness by driving the sandbox startup workflow.

    Scope: SANDBOX ONLY. LLM / model-server status, hardware-eligibility, and
    LOCAL_LLM_* model wiring live in the LLMRouter Manager (LRM) and the
    full-stack ServiceHub integration -- deliberately out of scope here. This
    script exercises only what sandbox-manager owns: the native sandbox backend
    lifecycle and its OpenWork token (OWT).

    Adapted from the legacy host/backend-manager readiness harness. Key
    differences that match the sandbox-manager contract:
      * fixed port 18821 (no self-allocation)
      * UNAUTHENTICATED loopback API (no Bearer token); token and action
        routes need X-SuperClaw-Process-Credential (-ProcessCredential)
      * routes under /sandbox-manager/v1 (not /v1)
      * no inference / model / eligibility / UI-chat steps

    Workflow:
      1. GET  /sandbox-manager/v1/system/status              -- reconnect / boot snapshot
      2. GET  /sandbox-manager/v1/system/preflight           -- native payload / OWT checks
      3. POST /sandbox-manager/v1/agent/sandbox/provisions   -- ensure-ready (adopts the
                                                                manager's auto-boot run) + poll
      4. GET  /sandbox-manager/v1/agent/sandbox              -- wait for phase=running
      5. GET  /sandbox-manager/v1/agent/sandbox/tokens/current -- fetch OWT token
      6. GET  /sandbox-manager/v1/system/status              -- final snapshot + summary

    Product Profile startup note: step 3 legitimately 409s with
    runtime_deployment_required until ServiceHub has selected a Product Profile
    and stored its Runtime Deployment. Since generic CI resets its environment
    and does not select a local or Edge primary Bundle, that response is treated
    as an expected pre-activation outcome by default: steps 4-5 become
    reachability-only checks instead of waiting for a running Runtime / OWT token.
    Pass -RequireSandboxRunning in a SKU-specific lane that activates a Product
    Profile and requires the full Runtime startup.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\test_sandbox_manager_readiness.ps1

.EXAMPLE
  # Longer provisioning budget for a cold first run.
  powershell -ExecutionPolicy Bypass -File .\scripts\test_sandbox_manager_readiness.ps1 -TimeoutSec 2400

.EXAMPLE
  # Exercise sandbox-manager through ServiceHub's authenticated proxy.
  powershell -ExecutionPolicy Bypass -File .\scripts\test_sandbox_manager_readiness.ps1 `
    -BaseUrl http://127.0.0.1:19000 -BearerToken devtoken
#>
param(
    [int]$Port            = 18821,
    [string]$BaseUrl      = "",
    [string]$BearerToken  = "",
    # Standalone: same value the service was launched with; needed for GET/POST /agent/sandbox/tokens*.
    [string]$ProcessCredential = $env:SERVICEHUB_PROCESS_CREDENTIAL,
    [int]$PollIntervalSec = 2,
    [int]$TimeoutSec      = 1200,
    [int]$SandboxPhaseSec = 120,
    [int]$OwtTimeoutSec   = 60,
    # SandboxManager starts a Runtime only after ServiceHub stores the selected
    # Product Profile's Runtime Deployment. Generic CI does not select a SKU, so
    # accept that explicit pre-activation state unless strict Runtime startup is
    # requested by a SKU-specific smoke lane.
    [switch]$RequireSandboxRunning
)

$ErrorActionPreference = "Stop"
$BASE = if ($BaseUrl) { $BaseUrl.TrimEnd('/') } else { "http://127.0.0.1:$Port" }
$API  = "$BASE/sandbox-manager/v1"

# -- helpers ------------------------------------------------------------------

function Write-Step([string]$msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok([string]$msg)   { Write-Host "    [OK]   $msg" -ForegroundColor Green }
function Write-Warn([string]$msg) { Write-Host "    [WARN] $msg" -ForegroundColor Yellow }
function Write-Fail([string]$msg) { Write-Host "    [FAIL] $msg" -ForegroundColor Red }

function Invoke-Api {
    param(
        [string]$Method = "GET",
        [string]$Path,
        [hashtable]$Body = $null
    )
    $params = @{ Method = $Method; Uri = "$API$Path" }
    $headers = @{}
    if ($BearerToken) {
        $headers["Authorization"] = "Bearer $BearerToken"
    }
    if ($ProcessCredential) {
        $headers["X-SuperClaw-Process-Credential"] = $ProcessCredential
    }
    if ($headers.Count) {
        $params["Headers"] = $headers
    }
    if ($Body) {
        $params["Body"]        = ($Body | ConvertTo-Json -Compress)
        $params["ContentType"] = "application/json"
    }
    return Invoke-RestMethod @params
}

function Get-ApiError {
    # Parse the standard { "error": { code, message, retry_after_seconds } }
    # envelope out of a thrown Invoke-RestMethod error record. $null if absent.
    #
    # sandbox_manager's http_error() raises HTTPException(detail=api_error(...)),
    # and FastAPI's default handler wraps that detail under a top-level
    # "detail" key -- so the real wire body is { "detail": { "error": {...} } },
    # not { "error": {...} } directly. Some routes return api_error() via a
    # bare JSONResponse instead (no "detail" wrapper), so accept both shapes.
    param($ErrorRecord)
    try {
        $body = $ErrorRecord.ErrorDetails.Message | ConvertFrom-Json
        if ($body.error) { return $body.error }
        if ($body.detail.error) { return $body.detail.error }
        return $null
    } catch {
        return $null
    }
}

function Poll-Operation {
    param(
        [string]$OperationId,
        [string]$Label,
        [int]$TimeoutSec  = 1200,
        [int]$IntervalSec = 2
    )
    $deadline      = (Get-Date).AddSeconds($TimeoutSec)
    $start         = Get-Date
    $lastLine      = ""
    $lastPrintTime = [datetime]::MinValue

    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds $IntervalSec

        $op      = Invoke-Api -Path "/operations/$OperationId"
        $pct     = [int]([double]($op.pct))
        $bar     = ("#" * [int]($pct / 5)).PadRight(20, '-')
        $elapsed = [int]((Get-Date) - $start).TotalSeconds
        $line    = "[$bar] {0,3}%  {1,-10}  {2}  +{3}s" -f $pct, $op.state, $op.message, $elapsed

        $heartbeat = ((Get-Date) - $lastPrintTime).TotalSeconds -ge 2
        if (($line -ne $lastLine) -or $heartbeat) {
            Write-Host "    $line"
            $lastLine      = $line
            $lastPrintTime = Get-Date
        }

        if ($op.state -eq "done")      { Write-Ok "$Label done."; return $op }
        if ($op.state -eq "error")     { Write-Fail "$Label failed: $($op.last_error_message)"; exit 1 }
        if ($op.state -eq "cancelled") { Write-Fail "$Label cancelled."; exit 1 }
    }

    Write-Fail "Timed out waiting for $Label after ${TimeoutSec}s."
    exit 1
}

# =============================================================================
# Step 1: GET /system/status  -- reconnect / boot snapshot
# =============================================================================

Write-Step "GET /sandbox-manager/v1/system/status"
$status = Invoke-Api -Path "/system/status"
Write-Host ($status | ConvertTo-Json -Depth 6)

$sandboxPhase = $status.sandbox.phase
$bootOpId     = $status.flows.sandbox.active_operation_id
if ($bootOpId) {
    Write-Warn "Sandbox ensure-ready already in flight from manager boot: $bootOpId"
}

# =============================================================================
# Step 2: GET /system/preflight  -- native payload / OWT checks
# =============================================================================

Write-Step "GET /sandbox-manager/v1/system/preflight"
$preflight = Invoke-Api -Path "/system/preflight"
Write-Host "  ready: $($preflight.ready)"
if ($preflight.checks) {
    foreach ($c in $preflight.checks) {
        $color = if ($c.state -eq "pass") { "Green" } elseif ($c.severity -eq "error") { "Red" } else { "Yellow" }
        Write-Host ("    [{0,-8}] {1,-16} {2}" -f $c.state, $c.name, $c.message) -ForegroundColor $color
    }
}

# =============================================================================
# Step 3: Ensure the sandbox is provisioned, then poll to completion
#   ensure_ready is idempotent + re-entrant: if the manager's auto-boot task
#   already started a run, POST provisions adopts it and returns the same
#   operation_id rather than starting a second provisioning pass.
# =============================================================================

$runtimeDeploymentPending = $false
if ($sandboxPhase -eq "running") {
    Write-Step "Sandbox already phase=running -- skipping provisioning."
    Write-Ok "sandbox=running"
} else {
    Write-Step "POST /sandbox-manager/v1/agent/sandbox/provisions  (ensure-ready)"
    try {
        $prov = Invoke-Api -Method "POST" -Path "/agent/sandbox/provisions"
        if ($prov.operation_id) {
            Write-Ok "Provisioning operation: $($prov.operation_id)  (state=$($prov.state))"
            Poll-Operation -OperationId $prov.operation_id -Label "sandbox.ensure_ready" -TimeoutSec $TimeoutSec -IntervalSec $PollIntervalSec | Out-Null
        } elseif ($prov.state -eq "ready") {
            Write-Ok "Sandbox already ready."
        } else {
            Write-Warn "Unexpected provisions response: $($prov | ConvertTo-Json -Compress)"
        }
    } catch {
        $err = Get-ApiError -ErrorRecord $_
        if ($err -and $err.code -eq "runtime_deployment_required") {
            if ($RequireSandboxRunning) {
                Write-Fail "runtime_deployment_required -- no Product Profile Runtime Deployment is stored and -RequireSandboxRunning was set."
                exit 1
            }
            Write-Warn "runtime_deployment_required -- Host API is ready, but no Product Profile Runtime Deployment is stored. Treating this as the expected pre-activation state; skipping Runtime-running and OWT checks."
            $runtimeDeploymentPending = $true
        } else {
            Write-Fail "Unexpected error calling POST /agent/sandbox/provisions: $_"
            exit 1
        }
    }
}

# =============================================================================
# Step 4: GET /agent/sandbox  -- wait for phase=running (skipped when gated)
# =============================================================================

$phase = $null
if ($runtimeDeploymentPending) {
    Write-Step "GET /sandbox-manager/v1/agent/sandbox  (API reachability only -- Runtime not activated)"
    $sb    = Invoke-Api -Path "/agent/sandbox"
    $phase = $sb.phase
    Write-Ok "Endpoint reachable, phase=$phase (Runtime start is withheld until a Product Profile deployment is stored)"
} else {
    Write-Step "GET /sandbox-manager/v1/agent/sandbox  (waiting for phase=running)"
    $phaseDeadline = (Get-Date).AddSeconds($SandboxPhaseSec)
    while ((Get-Date) -lt $phaseDeadline) {
        $sb    = Invoke-Api -Path "/agent/sandbox"
        $phase = $sb.phase
        Write-Host "    phase=$phase"
        if ($phase -eq "running") { break }
        if ($phase -eq "error")   { Write-Fail "Sandbox error: $($sb.message)"; exit 1 }
        Start-Sleep -Seconds 3
    }
    if ($phase -ne "running") {
        Write-Fail "Sandbox did not reach phase=running within ${SandboxPhaseSec}s (last phase=$phase)."
        exit 1
    }
    Write-Ok "Sandbox phase=running"
}

# =============================================================================
# Step 5: GET /agent/sandbox/tokens/current  -- fetch OWT token (skipped when gated)
# =============================================================================

$owt = $null
if ($runtimeDeploymentPending) {
    Write-Step "GET /sandbox-manager/v1/agent/sandbox/tokens/current  (skipped -- Runtime not activated)"
    Write-Warn "Skipping OWT token fetch: no Product Profile Runtime Deployment is stored."
} else {
    Write-Step "GET /sandbox-manager/v1/agent/sandbox/tokens/current"
    $owtDeadline = (Get-Date).AddSeconds($OwtTimeoutSec)
    while ((Get-Date) -lt $owtDeadline) {
        try {
            $owt = Invoke-Api -Path "/agent/sandbox/tokens/current"
            break
        } catch {
            $err  = Get-ApiError -ErrorRecord $_
            $code = if ($err) { [string]$err.code } else { "" }
            if ($code -eq "sandbox_not_ready" -or $code -eq "owt_stale") {
                $retry = if ($err.retry_after_seconds) { [int]$err.retry_after_seconds } else { 5 }
                Write-Warn "$code -- retrying in ${retry}s"
                Start-Sleep -Seconds $retry
            } elseif ($code -eq "owt_unavailable") {
                Write-Warn "owt_unavailable -- reissuing via POST /agent/sandbox/tokens"
                $issue = Invoke-Api -Method "POST" -Path "/agent/sandbox/tokens"
                if ($issue.operation_id) {
                    Poll-Operation -OperationId $issue.operation_id -Label "sandbox.owt_issue" -TimeoutSec 120 -IntervalSec $PollIntervalSec | Out-Null
                }
            } else {
                Write-Fail "Unexpected error fetching OWT token: $_"
                exit 1
            }
        }
    }
    if (-not $owt) {
        Write-Fail "Could not retrieve OWT token within ${OwtTimeoutSec}s."
        exit 1
    }
    Write-Ok "OWT token retrieved"
    Write-Host "    token      : $($owt.token)"
    Write-Host "    scope      : $($owt.scope)"
    Write-Host "    created_at : $($owt.created_at)"
}

# =============================================================================
# Step 6: Final status snapshot + summary
# =============================================================================

Write-Step "GET /sandbox-manager/v1/system/status  (final snapshot)"
$final = Invoke-Api -Path "/system/status"
Write-Host ($final | ConvertTo-Json -Depth 6)

$sep = "=" * 60
Write-Host ""
Write-Host $sep -ForegroundColor Green
if ($runtimeDeploymentPending) {
    Write-Host "  SANDBOX-MANAGER HOST READINESS PASSED (RUNTIME NOT ACTIVATED)" -ForegroundColor Green
    Write-Host $sep -ForegroundColor Green
    Write-Host ""
    Write-Host "  Manager URL : $BASE" -ForegroundColor Cyan
    Write-Host "  Sandbox     : phase=$($final.sandbox.phase)" -ForegroundColor Cyan
    Write-Host "  Note        : no Product Profile Runtime Deployment -- Runtime/OWT checks skipped." -ForegroundColor Yellow
    Write-Host "                Use -RequireSandboxRunning in a SKU-specific activation lane." -ForegroundColor Yellow
} else {
    Write-Host "  SANDBOX-MANAGER READINESS TEST PASSED" -ForegroundColor Green
    Write-Host $sep -ForegroundColor Green
    Write-Host ""
    Write-Host "  Manager URL : $BASE" -ForegroundColor Cyan
    Write-Host "  Sandbox     : phase=$($final.sandbox.phase)" -ForegroundColor Cyan
    Write-Host "  OWT Token   : $($owt.token)" -ForegroundColor Cyan
    Write-Host "  OWT Scope   : $($owt.scope)" -ForegroundColor Cyan
    Write-Host "  OWT Created : $($owt.created_at)" -ForegroundColor Cyan
}
Write-Host ""
Write-Host $sep -ForegroundColor Green

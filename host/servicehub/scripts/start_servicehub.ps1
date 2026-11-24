<#
.SYNOPSIS
    Start ServiceHub in source mode with capability gating enabled.

.DESCRIPTION
    Launches ServiceHub directly from source (no frozen exe required).
    ServiceHub automatically spawns child processes (LRM, SM) via
    "python -m <entrypoint>" using the shared .venv — no separate terminals needed.
    Emits SERVICEHUB_READY <json> on stdout when ready.

.PARAMETER Port
    Requested bind port. The script refuses to replace an existing listener.
    Default: 18880

.PARAMETER HubToken
    Bearer token for authenticated endpoints. Default: "dev-token"

.PARAMETER DataDir
    Override SERVICEHUB_DATA_DIR. Defaults to %LOCALAPPDATA%\SuperClaw\servicehub.

.PARAMETER ReadyFile
    Path for a machine-readable JSON file containing the active port and token.

.EXAMPLE
    .\scripts\start_servicehub.ps1
    .\scripts\start_servicehub.ps1 -Port 18880 -HubToken my-token
#>
[CmdletBinding()]
param(
    [int]$Port        = 18880,
    [string]$HubToken = "dev-token",
    [string]$DataDir  = "",
    [string]$ServiceCfg = "",
    [string]$ReadyFile = "",
    [switch]$SkipSync,
    [switch]$Detach,
    [int]$ReadyTimeoutSeconds = 120
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$SHDir     = Split-Path -Parent $ScriptDir          # host/servicehub
$HostDir   = Split-Path -Parent $SHDir              # host

$VenvPython = Join-Path $HostDir ".venv\Scripts\python.exe"
$Activate   = Join-Path $HostDir ".venv\Scripts\Activate.ps1"

function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }

function Quote-ProcessArgument([string]$Value) {
    if ($Value -notmatch '[\s"]') { return $Value }
    # Start-Process flattens ArgumentList into one Windows command line. Quote
    # values here so source checkouts under paths such as "OneDrive - Intel"
    # arrive at argparse as one value.
    return '"' + ($Value -replace '"', '\"') + '"'
}

function Get-RedactedLogText([string]$Text) {
    # A raced handshake line can be flushed mid-token, so drop the whole payload
    # instead of matching a closing quote that may not have been written yet.
    $redacted = $Text -replace '(?m)^(?<prefix>\s*(?:SERVICEHUB_READY|REUSE))\b.*$',
        '${prefix} <redacted handshake payload>'
    return $redacted -replace '(?<key>"token"\s*:\s*")[^"]*"?', '${key}<redacted>"'
}

function Write-RedactedLog([string]$Path, [string]$Color) {
    $text = Get-Content $Path -Raw -ErrorAction SilentlyContinue
    if (-not $text) { return }
    if ($Color) {
        Write-Host (Get-RedactedLogText $text) -ForegroundColor $Color
    } else {
        Write-Host (Get-RedactedLogText $text)
    }
}

# ----------------------------------------------------------------------
# 1. Venv — must sync from workspace root so all members get editable-installed
# ----------------------------------------------------------------------
if ($SkipSync) {
    Write-Step "uv sync: SKIPPED (-SkipSync)"
} else {
    Write-Step "Syncing workspace (uv sync --all-packages --frozen)"
    Push-Location $HostDir
    $savedPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & uv sync --all-packages --frozen
        $syncExit = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $savedPreference
    }
    if ($syncExit -ne 0) { throw "uv sync --all-packages --frozen failed" }
    Pop-Location
}

. $Activate

# ----------------------------------------------------------------------
# 2. Refuse to kill an unrelated process on the requested port
# ----------------------------------------------------------------------
Write-Step "Pre-flight: checking port $Port"
$conn = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1
if ($conn) {
    $owner = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
    throw "Port $Port is already held by pid $($conn.OwningProcess) ($($owner.ProcessName)). Stop the owning service or choose -Port."
}

# ----------------------------------------------------------------------
# 3. Env
# ----------------------------------------------------------------------
$env:CAPABILITY_GATING_V1 = "1"
$env:SERVICEHUB_TOKEN      = $HubToken
if ($DataDir) { $env:SERVICEHUB_DATA_DIR = $DataDir }

$resolvedServiceCfg = if ($ServiceCfg) {
    (Resolve-Path -LiteralPath $ServiceCfg).Path
} else {
    Join-Path $SHDir "service_cfg.json"
}

$shArgs = @("--port", "$Port", "--hub-token", $HubToken, "--service-cfg", $resolvedServiceCfg)
$argumentLine = ((@("-u", "-m", "servicehub") + $shArgs) |
    ForEach-Object { Quote-ProcessArgument ([string]$_) }) -join " "

Write-Step "Starting ServiceHub"
Write-Host "  Port:              $Port"
$tokenFp = if ($HubToken.Length -ge 4) { $HubToken.Substring(0, 4) } else { $HubToken }
Write-Host "  Token:             <redacted, fp=$tokenFp… len=$($HubToken.Length)>"
Write-Host "  CAPABILITY_GATING_V1=1"
Write-Host "  service_cfg:       $resolvedServiceCfg"
Write-Host "  Child processes:   configured by $([IO.Path]::GetFileName($resolvedServiceCfg))"

# ----------------------------------------------------------------------
# 4. Launch and wait for SERVICEHUB_READY
# ----------------------------------------------------------------------
$logDir = Join-Path $SHDir ".smoke-logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$resolvedReadyFile = if ($ReadyFile) { $ReadyFile } else { Join-Path $logDir "servicehub.ready.json" }
$stdoutLog = Join-Path $logDir "servicehub.stdout.log"
$stderrLog  = Join-Path $logDir "servicehub.stderr.log"
Remove-Item $stdoutLog, $stderrLog -ErrorAction SilentlyContinue
Remove-Item $resolvedReadyFile -ErrorAction SilentlyContinue

$proc = Start-Process -FilePath $VenvPython `
    -ArgumentList $argumentLine `
    -WorkingDirectory $HostDir `
    -NoNewWindow -PassThru `
    -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError  $stderrLog

Write-Host "  pid=$($proc.Id)  logs -> $logDir"

$deadline   = (Get-Date).AddSeconds($ReadyTimeoutSeconds)
$actualPort = $null
$actualToken= $null

while ((Get-Date) -lt $deadline) {
    if (Test-Path $stdoutLog) {
        $lines = Get-Content $stdoutLog -ErrorAction SilentlyContinue
        foreach ($line in $lines) {
            $handshakeLine = ([string]$line).Trim()
            if ($handshakeLine -match '^SERVICEHUB_READY\s+(\{.*\})$') {
                $payload     = $Matches[1] | ConvertFrom-Json
                $actualPort  = [int]$payload.port
                $actualToken = [string]$payload.token
                break
            }
            if ($handshakeLine -match '^REUSE\s+(\{.*\})$') {
                $payload = $Matches[1] | ConvertFrom-Json
                if ($payload.error) {
                    throw "ServiceHub singleton conflict: $($payload.error)"
                }
                throw "An existing ServiceHub singleton is still running on port $($payload.port); requested port $Port cannot start until it fully exits."
            }
        }
    }
    if ($actualPort) { break }
    if ($proc.HasExited) {
        Write-RedactedLog $stdoutLog
        Write-RedactedLog $stderrLog 'Red'
        throw "ServiceHub exited before SERVICEHUB_READY (code $($proc.ExitCode))"
    }
    Start-Sleep -Milliseconds 200
}

if (-not $actualPort) {
    Write-RedactedLog $stderrLog 'Red'
    throw "Timed out waiting for SERVICEHUB_READY"
}

Write-Host ""
$actualTokenFp = if ($actualToken.Length -ge 4) { $actualToken.Substring(0, 4) } else { $actualToken }
Write-Host "  SERVICEHUB_READY port=$actualPort token=<redacted, fp=$actualTokenFp… len=$($actualToken.Length)>" -ForegroundColor Green
Write-Host "  Base URL: http://127.0.0.1:$actualPort"
$readyParent = Split-Path -Parent $resolvedReadyFile
if ($readyParent -and -not (Test-Path $readyParent)) {
    New-Item -ItemType Directory -Force -Path $readyParent | Out-Null
}
@{ port = $actualPort; token = $actualToken; pid = $proc.Id } | ConvertTo-Json -Compress | Set-Content -Path $resolvedReadyFile -Encoding UTF8
Write-Host "  Ready file: $resolvedReadyFile"
if ($Detach) {
    Write-Host "  Detached; use POST /app/system/shutdown for a graceful stop." -ForegroundColor Yellow
    return
}
Write-Host "  Press Ctrl+C to stop." -ForegroundColor Yellow

# Keep the process running until Ctrl+C
try {
    while (-not $proc.HasExited) {
        Start-Sleep -Milliseconds 300
    }
    Write-Host "ServiceHub exited (code $($proc.ExitCode))" -ForegroundColor Yellow
} finally {
    Remove-Item $resolvedReadyFile -ErrorAction SilentlyContinue
    if ($proc -and -not $proc.HasExited) {
        try {
            Invoke-RestMethod -Method POST "http://127.0.0.1:$actualPort/app/system/shutdown" `
                -Headers @{ Authorization = "Bearer $actualToken" } -TimeoutSec 5 | Out-Null
            if (-not $proc.WaitForExit(15000)) {
                Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
            }
        } catch {
            Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        }
    }
}

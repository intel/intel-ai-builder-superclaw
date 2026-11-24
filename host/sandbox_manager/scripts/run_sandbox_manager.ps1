<#
.SYNOPSIS
  Pre-flight checks, then launch sandbox-manager.

.DESCRIPTION
  Frees the sandbox-manager port, ensures the venv, then starts
  `python -m sandbox_manager --port <Port>` and waits for its readiness probe.
  Blocks until Ctrl+C, then stops the child process.

.PARAMETER Port
  Listen port passed to sandbox-manager via --port. Default: 18821

.PARAMETER ShowProcessCredential
  Print the generated process credential for manual reuse. By default it remains in the environment only.
#>
[CmdletBinding()]
param(
  [int]$Port = 18821,
  [switch]$ShowProcessCredential
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($env:SERVICEHUB_PROCESS_CREDENTIAL)) {
  $env:SERVICEHUB_PROCESS_CREDENTIAL = [guid]::NewGuid().ToString('N')

  Write-Host "WARNING: SERVICEHUB_PROCESS_CREDENTIAL was not set; generated one for this session." -ForegroundColor Yellow
  if ($ShowProcessCredential) {
    Write-Host ("         SERVICEHUB_PROCESS_CREDENTIAL = {0}" -f $env:SERVICEHUB_PROCESS_CREDENTIAL) -ForegroundColor Yellow
    Write-Host "         Reuse this value in X-SuperClaw-Process-Credential for protected cleanup requests." -ForegroundColor Yellow
  }
}
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$RootDir   = Split-Path -Parent $ScriptDir
Push-Location $RootDir

function Write-Step($msg) {
  Write-Host ""
  Write-Host "==> $msg" -ForegroundColor Cyan
}

# ----------------------------------------------------------------------
# 1. Pre-flight: detect and kill orphan listeners on required ports
# ----------------------------------------------------------------------
function Test-PortFree {
  param([int[]]$Ports)
  $conflicts = @()
  foreach ($p in $Ports) {
    $conn = Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($conn) {
      $owner = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
      $conflicts += [pscustomobject]@{
        Port = $p
        Pid  = $conn.OwningProcess
        Name = if ($owner) { $owner.ProcessName } else { '<unknown>' }
      }
    }
  }
  return ,$conflicts
}

Write-Step "Pre-flight: checking port $Port"
$conflicts = Test-PortFree -Ports @($Port)
if ($conflicts.Count -gt 0) {
  Write-Host "  Port conflicts detected - killing orphans:" -ForegroundColor Yellow
  foreach ($c in $conflicts) {
    Write-Host ("    port {0,-5} pid {1} ({2}) -> killing" -f $c.Port, $c.Pid, $c.Name) -ForegroundColor Yellow
    try {
      Stop-Process -Id $c.Pid -Force -ErrorAction Stop
    } catch {
      Write-Host "    WARNING: could not kill pid $($c.Pid): $($_.Exception.Message)" -ForegroundColor Red
    }
  }
  Start-Sleep -Milliseconds 800
  $still = Test-PortFree -Ports @($Port)
  if ($still.Count -gt 0) {
    foreach ($s in $still) {
      Write-Host ("    port {0} still held by pid {1} ({2})" -f $s.Port, $s.Pid, $s.Name) -ForegroundColor Red
    }
    throw "Aborting: could not free all required ports."
  }
  Write-Host "  Ports cleared." -ForegroundColor Green
} else {
  Write-Host "  ok"
}

# ----------------------------------------------------------------------
# 2. Ensure venv
# ----------------------------------------------------------------------
$VenvPython = Join-Path $RootDir ".venv\Scripts\python.exe"
$Activate   = Join-Path $RootDir ".venv\Scripts\Activate.ps1"

if (-not (Test-Path $VenvPython)) {
  Write-Step ".venv missing -> running 'uv sync'"
  if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    throw "uv not found in PATH. Install it first: pip install uv"
  }
  & uv sync
  if ($LASTEXITCODE -ne 0) { throw "uv sync failed" }
}

Write-Step "Activating venv"
. $Activate
Write-Host "  Python: $(python -c 'import sys;print(sys.executable)')"

# ----------------------------------------------------------------------
# 3. Env vars
# ----------------------------------------------------------------------
if (-not $env:HF_ENDPOINT) { $env:HF_ENDPOINT = "https://hf-mirror.com" }

Write-Step "Env"
Write-Host "  PORT  = $Port  (passed via --port)"
Write-Host "  HF    = $env:HF_ENDPOINT"
Write-Host "  process credential configured"

# ----------------------------------------------------------------------
# 4. Launch sandbox-manager and wait for the readiness probe
# ----------------------------------------------------------------------
Write-Step "Launching sandbox-manager"

$logDir = Join-Path $RootDir ".smoke-logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$stdout = Join-Path $logDir "sandbox-manager.stdout.log"
$stderr = Join-Path $logDir "sandbox-manager.stderr.log"
Remove-Item $stdout, $stderr -ErrorAction SilentlyContinue

$proc = Start-Process -FilePath $VenvPython `
  -ArgumentList @("-u", "-m", "sandbox_manager", "--port", "$Port") `
  -NoNewWindow -PassThru `
  -RedirectStandardOutput $stdout `
  -RedirectStandardError  $stderr

Write-Host "  pid = $($proc.Id)  logs -> $logDir"

try {
  Write-Step "Waiting for readiness probe (GET /sandbox-manager/v1/health) ..."
  $healthUrl = "http://127.0.0.1:$Port/sandbox-manager/v1/health"
  $deadline = (Get-Date).AddSeconds(30)
  $ready = $false
  while ((Get-Date) -lt $deadline) {
    if ($proc.HasExited) {
      if (Test-Path $stdout) { Get-Content $stdout -Raw | Write-Host }
      if (Test-Path $stderr) { Get-Content $stderr -Raw | Write-Host -ForegroundColor Red }
      throw "sandbox-manager exited early (code $($proc.ExitCode))"
    }
    try {
      $resp = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2 -ErrorAction Stop
      if ($resp.status -eq "ok") {
        Write-Host ("  ready -> service=$($resp.service) pid=$($resp.pid)") -ForegroundColor Green
        $ready = $true
        break
      }
    } catch {
      # Not accepting connections yet — keep polling.
    }
    Start-Sleep -Milliseconds 300
  }
  if (-not $ready) { throw "Timed out waiting for readiness. See $stdout" }

  Write-Host ""
  Write-Host "  Sandbox Manager running at http://127.0.0.1:$Port" -ForegroundColor Green
  Write-Host "  Press Ctrl+C to stop." -ForegroundColor Yellow

  while (-not $proc.HasExited) {
    Start-Sleep -Milliseconds 200
  }
}
finally {
  if ($proc -and -not $proc.HasExited) {
    Write-Step "Stopping sandbox-manager (pid $($proc.Id))"
    try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch {}
    Start-Sleep -Milliseconds 300
  }

  Pop-Location
}

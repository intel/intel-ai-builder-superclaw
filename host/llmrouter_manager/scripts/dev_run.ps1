<#
.SYNOPSIS
    One-click dev runner for llmrouter_manager: check prereqs, sync deps,
    start the LRM service, then seed + verify via dev_bootstrap.py.

.DESCRIPTION
    Steps, in order:
      1. Verify `uv` is on PATH.
      2. Detect LOCAL_LLM_* / CLOUD_LLM_* env vars (with Machine/User scope
         fallback, since setup uses Machine scope which the current shell may
         not have inherited). Fails early if neither edge nor cloud is fully
         configured - dev_bootstrap.py would just exit 2 otherwise.
      3. `uv sync` to create the venv and install all declared deps.
      4. Start the LRM service in the background (logs -> .dev-run/lrm.log).
      5. Run dev_bootstrap.py --verify against it.

    Lifecycle (the important part):
      * On NORMAL completion the LRM service is LEFT RUNNING so you can keep
        poking at it manually (this is the default).
      * If THIS script is killed (Ctrl+C, Stop-Process, taskkill /F, console
        close) the service child is killed SYNCHRONOUSLY with it. This is
        enforced at the OS level via a Windows Job Object with
        KILL_ON_JOB_CLOSE - so it holds even on a hard kill where no
        PowerShell `finally` block would ever run.

.PARAMETER Port
    Port the LRM service binds to. Default 18321.

.PARAMETER StopOnExit
    Stop the LRM service when the script finishes normally too (opposite of
    the default keep-alive behavior).

.PARAMETER NoVerify
    Seed only; skip the --verify alias probes.

.PARAMETER Local
    Enable the llama-cpp local slot: sets LLAMA_ROUTER_PORT
    on the service process, and asks dev_bootstrap.py to select + provision
    (real GGUF download + llama-server spawn) the -LocalModel and wait until the
    chat server is healthy. With -Local, edge/cloud env vars are OPTIONAL (local
    is a configured path on its own).

.PARAMETER LocalModel
    Chat model id to provision when -Local is set. Default 'auto' lets the host
    pick by hardware (GET /system/hardware -> selected_chat_model_id, i.e.
    policy.select_chat_model); pass a catalog id (e.g. qwen3.5-4b) to override.

.EXAMPLE
    ./dev_run.ps1                 # sync, seed+verify, leave service running
    ./dev_run.ps1 -StopOnExit     # ... but stop the service at the end
    ./dev_run.ps1 -NoVerify       # seed only
    ./dev_run.ps1 -Local          # also provision + chat-test local llama-cpp
    ./dev_run.ps1 -Local -LocalModel qwen3.6-35b-a3b
#>
[CmdletBinding()]
param(
    [int]$Port = 18321,
    [switch]$StopOnExit,
    [switch]$NoVerify,
    [switch]$Local,
    [string]$LocalModel = 'auto'
)

$ErrorActionPreference = 'Stop'

# --- Paths -----------------------------------------------------------------
# scripts/ -> package dir (host/llmrouter_manager).
$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$PackageDir = Split-Path -Parent $ScriptDir
$LogDir     = Join-Path $PackageDir '.dev-run'
$LrmLog     = Join-Path $LogDir 'lrm.log'
$LrmErrLog  = Join-Path $LogDir 'lrm.err.log'
$BaseUrl    = "http://127.0.0.1:$Port"

function Write-Step($msg)  { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)    { Write-Host "    $msg" -ForegroundColor Green }
function Write-Warn2($msg) { Write-Host "    $msg" -ForegroundColor Yellow }

# --- Windows Job Object: tie the child's lifetime to this process ----------
# KILL_ON_JOB_CLOSE means the moment our process's job handle closes - normal
# exit, Ctrl+C, or a hard taskkill /F - the OS kills every process in the job.
# We arm it up front and only disarm on a clean keep-alive exit.
if (-not ('DevRunJob' -as [type])) {
    Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class DevRunJob {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr CreateJobObject(IntPtr a, string name);
    [DllImport("kernel32.dll")]
    static extern bool SetInformationJobObject(IntPtr hJob, int infoClass, IntPtr lpInfo, uint cbLen);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    [StructLayout(LayoutKind.Sequential)]
    struct BASIC_LIMIT {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS {
        public ulong r, w, o, rt, wt, ot;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct EXTENDED_LIMIT {
        public BASIC_LIMIT BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    const int JobObjectExtendedLimitInformation = 9;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;

    static bool SetFlags(IntPtr hJob, uint flags) {
        var info = new EXTENDED_LIMIT();
        info.BasicLimitInformation.LimitFlags = flags;
        int len = Marshal.SizeOf(info);
        IntPtr p = Marshal.AllocHGlobal(len);
        try {
            Marshal.StructureToPtr(info, p, false);
            return SetInformationJobObject(hJob, JobObjectExtendedLimitInformation, p, (uint)len);
        } finally {
            Marshal.FreeHGlobal(p);
        }
    }

    // Create an armed (kill-on-close) job. Handle intentionally never closed
    // by us - it closes when the process dies, which is the trigger we want.
    public static IntPtr CreateArmed() {
        IntPtr h = CreateJobObject(IntPtr.Zero, null);
        if (h == IntPtr.Zero) throw new Exception("CreateJobObject failed");
        if (!SetFlags(h, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE))
            throw new Exception("arm SetInformationJobObject failed");
        return h;
    }
    public static void Assign(IntPtr hJob, IntPtr hProcess) {
        if (!AssignProcessToJobObject(hJob, hProcess))
            throw new Exception("AssignProcessToJobObject failed, err=" + Marshal.GetLastWin32Error());
    }
    // Clear the flags so a subsequent handle-close does NOT kill the child.
    public static void Disarm(IntPtr hJob) {
        if (!SetFlags(hJob, 0))
            throw new Exception("disarm SetInformationJobObject failed");
    }
}
'@
}

# --- 1. uv present? --------------------------------------------------------
Write-Step 'Checking for uv'
$uv = Get-Command uv -ErrorAction SilentlyContinue
if (-not $uv) {
    Write-Error @'
uv is not installed or not on PATH.
Install it, then re-run this script:
  PowerShell:  irm https://astral.sh/uv/install.ps1 | iex
  or (winget): winget install --id=astral-sh.uv
Docs: https://docs.astral.sh/uv/
'@
    exit 1
}
Write-Ok "found: $((& uv --version) 2>&1)"

# --- 2. Env vars -----------------------------------------------------------
# Resolve Process -> User -> Machine; import non-Process hits into this process
# so the child service + bootstrap inherit them.
function Resolve-EnvVar([string]$name) {
    $val = [Environment]::GetEnvironmentVariable($name, 'Process')
    if (-not [string]::IsNullOrWhiteSpace($val)) { return $val }
    foreach ($scope in @('User', 'Machine')) {
        $val = [Environment]::GetEnvironmentVariable($name, $scope)
        if (-not [string]::IsNullOrWhiteSpace($val)) {
            [Environment]::SetEnvironmentVariable($name, $val, 'Process')
            return $val
        }
    }
    return $null
}

Write-Step 'Checking LOCAL_LLM_* / CLOUD_LLM_* environment variables'

$localBase  = Resolve-EnvVar 'LOCAL_LLM_API_BASE'
$localKey   = Resolve-EnvVar 'LOCAL_LLM_API_KEY'
# NOT $localModel: PowerShell variable names are case-insensitive, so that
# would alias (and clobber) the -LocalModel parameter with the edge env value.
$edgeModelName = Resolve-EnvVar 'LOCAL_LLM_MODEL_NAME'
[void](Resolve-EnvVar 'LOCAL_LLM_EMBEDDING_MODEL_NAME')

$cloudProv  = Resolve-EnvVar 'CLOUD_LLM_PROVIDER'
$cloudKey   = Resolve-EnvVar 'CLOUD_LLM_APIKEY'
$cloudModel = Resolve-EnvVar 'CLOUD_LLM_MODEL_NAME'
[void](Resolve-EnvVar 'CLOUD_LLM_BASE_URL')

$edgeReady  = $localBase -and $localKey
$cloudReady = $cloudProv -and $cloudKey -and $cloudModel

if ($edgeReady) {
    Write-Ok "edge  (local-model + auto): configured  [base=$localBase, model=$(if($edgeModelName){$edgeModelName}else{'<server default>'})]"
} else {
    Write-Warn2 'edge  (local-model + auto): NOT configured (needs LOCAL_LLM_API_BASE + LOCAL_LLM_API_KEY)'
}
if ($cloudReady) {
    Write-Ok "cloud (cloud-model):        configured  [provider=$cloudProv, model=$cloudModel]"
} else {
    Write-Warn2 'cloud (cloud-model):        NOT configured (needs CLOUD_LLM_PROVIDER + CLOUD_LLM_APIKEY + CLOUD_LLM_MODEL_NAME)'
}
if ($Local) {
    $modelDesc = if ($LocalModel -eq 'auto') { 'auto (hardware-selected)' } else { $LocalModel }
    Write-Ok "local (local-model via llama-cpp): enabled  [model=$modelDesc, provisioned on start]"
}

# With -Local, the llama-cpp slot is a configured path on its own, so edge/cloud
# env vars are optional and the "nothing configured" bail-out below is skipped.
if (-not $edgeReady -and -not $cloudReady -and -not $Local) {
    Write-Host ''
    Write-Warn2 'Neither the edge nor the cloud env-var set is fully configured;'
    Write-Warn2 'dev_bootstrap.py would find nothing to seed (exit 2). Configure at'
    Write-Warn2 'least ONE of the sets below, then re-run this script.'
    Write-Host ''
    Write-Host '  --- Edge (enables local-model + auto latency router) -----------------' -ForegroundColor Cyan
    Write-Host '  Persist for your user account (recommended; survives new shells):'
    Write-Host '    [Environment]::SetEnvironmentVariable("LOCAL_LLM_API_BASE", "https://edge.example.com/v1", "User")'
    Write-Host '    [Environment]::SetEnvironmentVariable("LOCAL_LLM_API_KEY",  "sk-edge-...",                 "User")'
    Write-Host '    # optional: LOCAL_LLM_MODEL_NAME (default Qwen3-Coder-Next),'
    Write-Host '    #           LOCAL_LLM_EMBEDDING_MODEL_NAME (default KaLM-embedding-v2.5)'
    Write-Host ''
    Write-Host '  --- Cloud (enables cloud-model) --------------------------------------' -ForegroundColor Cyan
    Write-Host '    [Environment]::SetEnvironmentVariable("CLOUD_LLM_PROVIDER",   "anthropic",                  "User")'
    Write-Host '    [Environment]::SetEnvironmentVariable("CLOUD_LLM_APIKEY",     "sk-ant-...",                 "User")'
    Write-Host '    [Environment]::SetEnvironmentVariable("CLOUD_LLM_MODEL_NAME", "claude-3-5-sonnet-20241022", "User")'
    Write-Host '    # optional: CLOUD_LLM_BASE_URL (overrides catalog default)'
    Write-Host ''
    Write-Host '  --- Quick, current session only (no persistence) ---------------------' -ForegroundColor Cyan
    Write-Host '    $env:CLOUD_LLM_PROVIDER   = "anthropic"'
    Write-Host '    $env:CLOUD_LLM_APIKEY     = "sk-ant-..."'
    Write-Host '    $env:CLOUD_LLM_MODEL_NAME = "claude-3-5-sonnet-20241022"'
    Write-Host ''
    Write-Host '  Note: variables set with "User"/"Machine" scope only reach NEW shells.' -ForegroundColor DarkGray
    Write-Host '  This script already checks User + Machine scope, so a fresh shell suffices.' -ForegroundColor DarkGray
    exit 2
}

# --- 3. Sync deps (creates .venv) ------------------------------------------
Write-Step 'Syncing dependencies (uv sync)'
& uv sync --directory $PackageDir
if ($LASTEXITCODE -ne 0) { Write-Error "uv sync failed (exit $LASTEXITCODE)"; exit $LASTEXITCODE }
Write-Ok 'dependencies ready'

# --- 3b. Local llama-cpp slot env (only with -Local) -----------------------
# The child LRM service inherits THIS process's environment (Start-Process is
# -NoNewWindow), so the local-slot knobs must be set here, before launch.
# Default (no -Local): no llama selection is pinned and no port override is
# set, so local-model resolves via edge fallback only. 18103 is the documented
# default the proxy and supervisor both read; pinning it keeps a stray ambient
# value from moving the local slot off the known-good port.
if ($Local) {
    Write-Step 'Enabling local llama-cpp slot for the service process'
    $env:LLAMA_ROUTER_PORT = '18103'
    # A stray force-reroute override would silently push local chat to cloud.
    Remove-Item Env:\LRM_FORCE_LOCAL_UNSUPPORTED -ErrorAction SilentlyContinue
    Write-Ok 'LLAMA_ROUTER_PORT=18103 (local-model -> llama-cpp)'
}

# --- 4. Start LRM service in the background, inside the kill-on-close job ---
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

# A prior run may have left a service on this port (default keep-alive mode).
# Kill it first so this run starts clean and we don't hit "address in use".
Write-Step "Checking whether port $Port is already in use"
$stale = @(
    Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -Expand OwningProcess -Unique
)
if ($stale.Count -gt 0) {
    Write-Warn2 "port $Port already in use by PID(s): $($stale -join ', ') - stopping them"
    foreach ($stalePid in $stale) {
        Stop-Process -Id $stalePid -Force -ErrorAction SilentlyContinue
    }
    # Give the OS a moment to release the socket before we rebind.
    Start-Sleep -Seconds 1
} else {
    Write-Ok "port $Port is free"
}

Write-Step "Starting LRM service on port $Port (logs: $LrmLog)"
# dev_bootstrap.py inherits this to pass the management-route gate.
$env:SERVICEHUB_PROCESS_CREDENTIAL = [guid]::NewGuid().ToString('N')
$job = [DevRunJob]::CreateArmed()
$svc = Start-Process -FilePath 'uv' `
    -ArgumentList @(
        'run', '--directory', $PackageDir,
        'python', '-u', '-m', 'llmrouter_manager', '--port', "$Port"
    ) `
    -RedirectStandardOutput $LrmLog `
    -RedirectStandardError  $LrmErrLog `
    -PassThru -NoNewWindow

# Assign ASAP so even an immediate Ctrl+C tears the child down. AssignProcess
# covers descendants too (uv -> python), so the whole tree is in the job.
try { [DevRunJob]::Assign($job, $svc.Handle) }
catch { Write-Warn2 "job assign failed (child may not auto-die on kill): $_" }

Write-Ok "service PID: $($svc.Id)"

$keepAlive = $false
$bootExit  = 1
try {
    # If it died on startup, surface the log and bail.
    Start-Sleep -Seconds 2
    if ($svc.HasExited) {
        Write-Warn2 "service exited early (code $($svc.ExitCode)). Last log lines:"
        if (Test-Path $LrmErrLog) { Get-Content $LrmErrLog -Tail 30 }
        if (Test-Path $LrmLog)    { Get-Content $LrmLog    -Tail 30 }
        Write-Error 'LRM service failed to start.'
        exit 3
    }

    # --- 5. Seed + verify via dev_bootstrap.py (it polls /health itself) ---
    Write-Step 'Running dev_bootstrap.py'
    $bootstrapArgs = @(
        'run', '--directory', $PackageDir,
        'python', 'scripts/dev_bootstrap.py', '--url', $BaseUrl
    )
    if (-not $NoVerify) { $bootstrapArgs += '--verify' }
    if ($Local)         { $bootstrapArgs += @('--provision-local', $LocalModel) }

    & uv @bootstrapArgs
    $bootExit = $LASTEXITCODE

    Write-Host ''
    switch ($bootExit) {
        0 { Write-Ok    'dev_bootstrap: success (exit 0)' }
        2 { Write-Warn2 'dev_bootstrap: nothing configured (exit 2)' }
        3 { Write-Warn2 'dev_bootstrap: LRM not reachable (exit 3) - see log above' }
        4 { Write-Warn2 'dev_bootstrap: one or more alias probes FAILED (exit 4)' }
        5 { Write-Warn2 'dev_bootstrap: local llama-cpp provisioning FAILED (exit 5) - see log above' }
        default { Write-Warn2 "dev_bootstrap: exit $bootExit" }
    }

    # Reached the end cleanly. Default = keep the service alive: disarm the job
    # so our process exit won't take the child with it.
    if (-not $StopOnExit) {
        [DevRunJob]::Disarm($job)
        $keepAlive = $true
    }
}
finally {
    # We only get here on the normal path or on Ctrl+C. On Ctrl+C $keepAlive is
    # still false (we never reached disarm), so we stop the child now for an
    # immediate, synchronous teardown. On a hard kill this block never runs -
    # the still-armed job object handles it at the OS level.
    if (-not $keepAlive -and $svc -and -not $svc.HasExited) {
        Write-Step "Stopping LRM service (launcher PID $($svc.Id))"
        # Kill the actual port listener first: uv spawns a python child, so the
        # launcher PID may not be the process holding the port.
        try {
            Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
                Select-Object -Expand OwningProcess -Unique |
                ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }
        } catch {}
        Stop-Process -Id $svc.Id -Force -ErrorAction SilentlyContinue
    }
}

if ($keepAlive -and $svc -and -not $svc.HasExited) {
    Write-Host ''
    Write-Host "LRM service left running on $BaseUrl (launcher PID $($svc.Id))." -ForegroundColor Red
    Write-Host ''
    Write-Host '  To stop it later, kill whatever is listening on the port (most' -ForegroundColor DarkGray
    Write-Host '  reliable - uv spawns a python child, so the launcher PID alone' -ForegroundColor DarkGray
    Write-Host '  may not be the process holding the port):' -ForegroundColor DarkGray
    Write-Host "    Get-NetTCPConnection -LocalPort $Port -State Listen |" -ForegroundColor Cyan
    Write-Host '      Select-Object -Expand OwningProcess -Unique |' -ForegroundColor Cyan
    Write-Host '      ForEach-Object { Stop-Process -Id $_ -Force }' -ForegroundColor Cyan
    Write-Host '  Or, as a fallback, the launcher process tree:' -ForegroundColor DarkGray
    Write-Host "    Stop-Process -Id $($svc.Id) -Force" -ForegroundColor Red
}

exit $bootExit

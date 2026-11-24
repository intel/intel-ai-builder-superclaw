# P0 spike launch - hand-launch the Windows-native backend tree.
#
# What it does:
#   1. Verifies LRM :18321 is up (start the SuperClaw app or ServiceHub first - the model
#      plane stays exactly where it is; this script only replaces the container tree).
#   2. Optionally ensures the LRM edge connection from a dotenv file (-ConfigureEdge,
#      default <repo>\.env, override with -EdgeEnvFile).
#      Key VALUES are never printed.
#   3. Seeds a native opencode config dir from sandbox\agent_config\profiles\<id>
#      (same Product Profile tree the runtime seeds after a committed deployment),
#      installs plugin deps with bun, and creates the tools\ JUNCTION (no admin needed,
#      unlike symlinks - see design section 6.3).
#   4. Launches openwork.exe (orchestrator) with external windows binaries; it spawns
#      opencode :4096 and openwork-server :<Port> exactly as in the container.
#   5. Polls /health, reports launch-to-ready seconds (section 8 target: <30 s), mints an owner
#      token, and prints the curl-able summary.
#
# Another backend must not hold the port: stop it first or pass -Port 8788.

param(
  [int]$Port = 8787,
  [string]$Workspace = "$env:USERPROFILE\SuperClawProjects",
  [string]$BinDir = "",
  [string]$StateDir = "$env:LOCALAPPDATA\SuperClaw\backend-native",
  [ValidateSet("lite", "standard", "pro")]
  [string]$ProductProfileId = "standard",
  [switch]$ConfigureEdge,
  [string]$EdgeEnvFile = "",
  [switch]$FreshConfig
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
if (-not $BinDir) { $BinDir = Join-Path $repoRoot "build\native-backend\bin" }
$lrmBase = "http://127.0.0.1:18321"
if (-not $EdgeEnvFile) { $EdgeEnvFile = Join-Path $repoRoot ".env" }

foreach ($exe in @("openwork.exe", "openwork-server.exe", "opencode.exe")) {
  if (-not (Test-Path (Join-Path $BinDir $exe))) { throw "missing $exe in $BinDir - run build-native-backend.ps1 first" }
}

# ---- 1. model plane must be up (unchanged by this design) ----
try {
  $h = Invoke-RestMethod "$lrmBase/llm-router/v1/health" -TimeoutSec 3
  Write-Host "LRM healthy on :18321 (service=$($h.service))"
} catch {
  throw "LRM not reachable on :18321. Start SuperClaw (or ServiceHub) first; the native spike reuses the host model plane."
}

# ---- 2. edge connection (values never printed) ----
function Read-DotEnv([string]$path) {
  $map = @{}
  if (-not (Test-Path $path)) { return $map }
  foreach ($line in Get-Content $path) {
    $t = $line.Trim()
    if ($t -eq "" -or $t.StartsWith("#")) { continue }
    $i = $t.IndexOf("=")
    if ($i -lt 1) { continue }
    $map[$t.Substring(0, $i).Trim()] = $t.Substring($i + 1).Trim().Trim('"')
  }
  return $map
}

function Get-ServiceHubAuth {
  # PUT /llm-router/v1/edge is a gated management route: only ServiceHub holds the
  # per-process LRM credential, in memory, and only its own proxy attaches it. Read
  # ServiceHub's per-boot lockfile (same {pid, port, token} shape written by
  # singleton.write_lockfile) and call LRM *through* ServiceHub's proxy instead of
  # hitting LRM's port directly.
  $hubDataDir = if ($env:SERVICEHUB_DATA_DIR) { $env:SERVICEHUB_DATA_DIR } else { Join-Path $env:LOCALAPPDATA "SuperClaw\servicehub" }
  $lockPath = Join-Path $hubDataDir "servicehub.lock"
  if (-not (Test-Path $lockPath)) {
    throw "ServiceHub lockfile not found at $lockPath - start SuperClaw (or ServiceHub) first"
  }
  $lock = Get-Content $lockPath -Raw | ConvertFrom-Json
  return @{
    BaseUrl = "http://127.0.0.1:$($lock.port)"
    Headers = @{ Authorization = "Bearer $($lock.token)" }
  }
}

if ($ConfigureEdge) {
  $envMap = Read-DotEnv $EdgeEnvFile
  $edgeUrl = $null; $edgeKey = ""
  foreach ($k in @("EDGE_SERVER_URL", "EDGE_BASE_URL", "EDGE_URL")) {
    if ($envMap.ContainsKey($k) -and $envMap[$k]) { $edgeUrl = $envMap[$k]; $edgeUrlKey = $k; break }
  }
  foreach ($k in @("EDGE_SERVER_KEY", "EDGE_API_KEY", "EDGE_KEY")) {
    if ($envMap.ContainsKey($k) -and $envMap[$k]) { $edgeKey = $envMap[$k]; break }
  }
  $hub = Get-ServiceHubAuth
  $existing = $null
  try { $existing = Invoke-RestMethod "$($hub.BaseUrl)/llm-router/v1/edge" -Headers $hub.Headers -TimeoutSec 5 } catch {}
  if ($existing -and $existing.base_url) {
    Write-Host "edge already configured in LRM (leaving as-is)"
  } elseif ($edgeUrl) {
    Write-Host "configuring LRM edge from .env key '$edgeUrlKey' (value not shown)"
    $body = @{ base_url = $edgeUrl; api_key = $edgeKey } | ConvertTo-Json
    Invoke-RestMethod -Method Put "$($hub.BaseUrl)/llm-router/v1/edge?probe=true" -Headers $hub.Headers -ContentType "application/json" -Body $body -TimeoutSec 60 | Out-Null
    Write-Host "edge configured + probed ok"
  } else {
    Write-Warning "no edge-looking keys found in $EdgeEnvFile; skipping"
  }
}

# what can LRM actually serve right now?
try {
  $models = Invoke-RestMethod "$lrmBase/v1/models" -TimeoutSec 5
  $ids = @($models.data | ForEach-Object { $_.id })
  Write-Host "LRM /v1/models advertises: $($ids -join ', ')"
  if ($ids -notcontains "local-model") {
    Write-Warning "local-model not advertised - no committed primary bundle. auto/cloud paths still work; commit the edge bundle via the app for full parity."
  }
} catch { Write-Warning "could not list LRM models: $($_.Exception.Message)" }

# ---- 3. seed native config dir ----
$configDir = Join-Path $StateDir "config\opencode"
$dataDir = Join-Path $StateDir "data"
$logDir = Join-Path $dataDir "opencode\logs"
$srcConfig = Join-Path (Join-Path $repoRoot "sandbox\agent_config\profiles") $ProductProfileId
if (-not (Test-Path (Join-Path $srcConfig "opencode.jsonc"))) {
  throw "Product Profile '$ProductProfileId' is incomplete at $srcConfig (missing opencode.jsonc)"
}
if ($FreshConfig -and (Test-Path $configDir)) { Remove-Item $configDir -Recurse -Force }
New-Item -ItemType Directory -Force $configDir, $dataDir, $logDir, (Join-Path $StateDir "logs") | Out-Null
if (-not (Test-Path $Workspace)) { New-Item -ItemType Directory -Force $Workspace | Out-Null }

Write-Host "seeding config from Product Profile $ProductProfileId ($srcConfig)"
robocopy $srcConfig $configDir /E /XD node_modules /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy config seed failed ($LASTEXITCODE)" }

Push-Location $configDir
try {
  cmd /c "bun install --production > bun-install.log 2>&1"
  if ($LASTEXITCODE -ne 0) { Get-Content bun-install.log -Tail 10; throw "bun install in config dir failed" }
} finally { Pop-Location }

# tools\ needs module resolution: junction (not symlink - no admin/dev-mode needed on Windows)
$toolsDir = Join-Path $configDir "tools"
New-Item -ItemType Directory -Force $toolsDir | Out-Null
$junction = Join-Path $toolsDir "node_modules"
if (-not (Test-Path $junction)) {
  New-Item -ItemType Junction -Path $junction -Target (Join-Path $configDir "node_modules") | Out-Null
}
Copy-Item (Join-Path $configDir "package.json") (Join-Path $toolsDir "package.json") -Force

# ---- 4. launch ----
$portBusy = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($portBusy) { throw "port $Port already has a listener (another backend?). Stop it or pass -Port 8788." }

$hostToken = [guid]::NewGuid().ToString("N") + [guid]::NewGuid().ToString("N")
$spawnEnv = @{
  OPENWORK_ALLOW_EXTERNAL = "1"
  OPENWORK_HOST_TOKEN     = $hostToken
  OPENCODE_CONFIG_DIR     = $configDir
  SC_RUNTIME_CONFIG_DIR   = $configDir
  OPENWORK_OPENCODE_CONFIG_SOURCE_DIR = $configDir
  OPENWORK_DATA_DIR       = (Join-Path $dataDir "openwork-orchestrator")
  LOGDIR                  = $logDir
  LRM_API_BASE_URL        = $lrmBase
  LRM_API_KEY             = "unused"
  LRM_LOCAL_MODEL         = "local-model"
  LRM_CLOUD_MODEL         = "cloud-model"
  LRM_AUTO_MODEL          = "auto"
  LRM_EMBEDDING_API_BASE  = "$lrmBase/v1"
  LRM_EMBEDDING_MODEL     = "KaLM-embedding-v2.5"
  SUPERCLAW_PATH          = $Workspace
  OPENCODE_DIRECTORY      = $Workspace
  NO_PROXY                = "localhost,127.0.0.1,::1"
}
foreach ($k in $spawnEnv.Keys) { Set-Item -Path "Env:$k" -Value $spawnEnv[$k] }

$ts = Get-Date -Format "yyyyMMdd-HHmmss"
$log = Join-Path $StateDir "logs\native-backend-$ts.log"
$spawnArgs = @(
  "serve",
  "--workspace", $Workspace,
  "--opencode-directory", $Workspace,
  "--openwork-host", "127.0.0.1",
  "--openwork-port", "$Port",
  "--opencode-host", "127.0.0.1",
  "--opencode-port", "4096",
  "--connect-host", "127.0.0.1",
  "--approval", "auto",
  "--allow-external",
  "--opencode-bin", (Join-Path $BinDir "opencode.exe"),
  "--openwork-server-bin", (Join-Path $BinDir "openwork-server.exe")
)
$routerBin = Join-Path $BinDir "opencode-router.exe"
if (Test-Path $routerBin) { $spawnArgs += @("--opencode-router-bin", $routerBin) }

Write-Host "`nlaunching native backend (log: $log)" -ForegroundColor Cyan
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$proc = Start-Process -FilePath (Join-Path $BinDir "openwork.exe") -ArgumentList $spawnArgs `
  -RedirectStandardOutput $log -RedirectStandardError "$log.err" -PassThru -NoNewWindow

# ---- 5. readiness + owner token ----
# NOTE: use curl.exe for loopback probes - PS 5.1 Invoke-WebRequest ignores NO_PROXY
# and can route 127.0.0.1 through a corporate proxy.
$base = "http://127.0.0.1:$Port"
$curl = "$env:SystemRoot\System32\curl.exe"
$ready = $false
while ($sw.Elapsed.TotalSeconds -lt 120) {
  if ($proc.HasExited) { break }
  $code = (& $curl -s -o NUL -w "%{http_code}" --noproxy "*" -m 2 "$base/health" 2>$null | Out-String).Trim()
  if ($code -eq "200") {
    # confirm it is really OWS (a startup race can bounce): require a second 200
    Start-Sleep -Milliseconds 300
    $code2 = (& $curl -s -o NUL -w "%{http_code}" --noproxy "*" -m 2 "$base/health" 2>$null | Out-String).Trim()
    if ($code2 -eq "200") { $ready = $true; break }
  }
  Start-Sleep -Milliseconds 500
}
$sw.Stop()

if (-not $ready) {
  Write-Host "`n--- last stderr ---"; if (Test-Path "$log.err") { Get-Content "$log.err" -Tail 25 }
  Write-Host "--- last stdout ---"; if (Test-Path $log) { Get-Content $log -Tail 25 }
  if ($proc.HasExited) { throw "backend exited (code $($proc.ExitCode)) before becoming healthy" }
  throw "no 200 from $base/health within 120 s (pid $($proc.Id) still running - see logs)"
}

Write-Host ("`nREADY in {0:N1} s (target <30 s)  pid={1}" -f $sw.Elapsed.TotalSeconds, $proc.Id) -ForegroundColor Green

# JSON body via a temp file: PS 5.1 mangles quoted JSON handed to native exes.
$bodyFile = Join-Path $StateDir "mint-body.json"
[IO.File]::WriteAllText($bodyFile, '{"scope":"owner","label":"native-spike"}')
$owt = $null
for ($i = 0; $i -lt 10 -and -not $owt; $i++) {
  try {
    $tokJson = & $curl -s --noproxy "*" -m 10 -X POST "$base/tokens" `
      -H "X-OpenWork-Host-Token: $hostToken" -H "Content-Type: application/json" `
      -d "@$bodyFile" 2>$null
    if ($tokJson) { $owt = (ConvertFrom-Json ($tokJson | Out-String)).token }
  } catch {}
  if (-not $owt) { Start-Sleep -Seconds 1 }
}
Remove-Item $bodyFile -Force -EA SilentlyContinue
if (-not $owt) { Write-Warning "owner-token mint failed after retries" }

# machine-readable summary (wrapper pipes can be held open by the child console handles).
# host_token persisted deliberately - same trust model as servicehub.lock {token}: loopback-only
# service, per-boot secret, current-user-readable file.
@{ port = $Port; pid = $proc.Id; ready_seconds = [math]::Round($sw.Elapsed.TotalSeconds, 1);
   owt = $owt; host_token = $hostToken; log = $log } |
  ConvertTo-Json | Out-File (Join-Path $StateDir "summary.json") -Encoding ascii

Write-Host "openwork-server : $base  (opencode :4096 internal)"
if ($owt) {
  Write-Host "owner token     : $owt"
  Write-Host "smoke           : curl -H `"Authorization: Bearer $owt`" $base/opencode/app"
}
Write-Host "stop            : Stop-Process -Id $($proc.Id)  (Job-Object supervision arrives in P1)"

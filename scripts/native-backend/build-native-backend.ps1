# P0 spike build - Windows-native backend binaries (see docs/design/2026-08-03_Next_Update_Note_remove_wsl.md in the internal design repo)
#
# Builds the four backend binaries for windows-x64:
#   openwork.exe          (orchestrator,   sandbox/orchestrator)
#   openwork-server.exe   (OWS :8787,      sandbox/server)
#   opencode-router.exe   (channels :3005, sandbox/channels)
#   opencode.exe          (agent engine,   the SuperClaw runtime pinned in patches/upstream.lock.json's 'opencode' entry)
#
# and stages the pinned GitHub CLI (gh\bin\gh.exe) beside them.
#
# Output: build\native-backend\bin\
#
# Prereqs: bun on PATH; repo pnpm-installed (`pnpm install`); Git LFS content pulled
# for packaging\docker\superclaw-runtime-bin\ (otherwise the runtime is rebuilt from
# the private fork, which needs git access to it).

param(
  [string]$OutDir = "",
  [string]$PayloadVersion = "",
  [switch]$SkipOpencode,
  [switch]$SkipServices,
  [switch]$SkipShell,
  [switch]$SkipResourceSync,
  [switch]$SkipReleaseStage,
  # Debug/local builds may include uncommitted source. Give every such build a
  # unique payload identity so such builds stay distinguishable in the manifest and
  # logs. The host decides whether payload\current is up to date by content
  # fingerprint, not by this identity.
  [switch]$DevelopmentPayloadIdentity,
  # Hash every payload file and stage the config tree in full, using neither build
  # cache (see the limitation documented in payload-manifest-policy.ps1). Release
  # (no -DevelopmentPayloadIdentity) and -Sign builds always behave this way.
  [switch]$FullManifestHash,
  # Authenticode-sign the payload executables before the manifest is written.
  # Required for anything Advanced Installer will package: it signs unsigned
  # executables itself, which would invalidate a manifest written first.
  [switch]$Sign,
  # Which certificate to sign with. Cert:\CurrentUser\My commonly holds more than
  # one code-signing certificate on a developer or CI machine, and the signing
  # policy refuses to pick for you rather than silently shipping the wrong signer.
  # Either selector is enough; the thumbprint wins if both are given.
  [string]$SigningCertificateThumbprint,
  [string]$SigningCertificateSubject
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
if (-not $OutDir) { $OutDir = Join-Path $repoRoot "build\native-backend\bin" }
$OutDir = [System.IO.Path]::GetFullPath($OutDir)
$repoBuildRoot = [System.IO.Path]::GetFullPath((Join-Path $repoRoot "build"))
# Build-to-build state for the payload (manifest hash cache, verified config-source
# snapshot). It cannot sit beside the payload: build\<Cfg>\servicehub is deleted and
# recreated by the ServiceHub PyInstaller step on every build. Under `build\` for the
# same reason `_toolchain` is - it survives builds, is not git-tracked, and a clean of
# `build\` clears it.
$payloadCacheRoot = Join-Path $repoBuildRoot "_payload-cache"
# Enforced here, not left to whoever runs the build: an installer payload never rests on
# what a cache on disk says, whatever it holds.
$reuseBuildCaches = $DevelopmentPayloadIdentity -and -not $Sign -and -not $FullManifestHash
. (Join-Path $PSScriptRoot "payload-manifest-policy.ps1")
. (Join-Path $PSScriptRoot "payload-identity-policy.ps1")
. (Join-Path $PSScriptRoot "config-staging-policy.ps1")
. (Join-Path $PSScriptRoot "payload-signing-policy.ps1")
. (Join-Path $PSScriptRoot "build-step-timing.ps1")
$timingHelper = Join-Path $repoRoot "packaging\installer\build-timing.ps1"
if (Test-Path -LiteralPath $timingHelper -PathType Leaf) {
  . $timingHelper
}
if (-not $SkipServices) {
  . (Join-Path $PSScriptRoot "python-runtime-policy.ps1")
  . (Join-Path $PSScriptRoot "uv-toolchain-policy.ps1")
  . (Join-Path $PSScriptRoot "node-toolchain-policy.ps1")
  . (Join-Path $PSScriptRoot "gh-toolchain-policy.ps1")
  . (Join-Path $PSScriptRoot "venv-launcher-policy.ps1")
}
if (-not $SkipShell) {
  . (Join-Path $PSScriptRoot "shell-toolchain-policy.ps1")
}

# Capture invocation intent. Only an invocation that requested every payload component may
# wipe and mirror the payload trees or publish the installer tree's manifest; a
# partial one updates them in place.
$completePayload = Test-CompletePayloadInvocation `
  -SkipOpencode:$SkipOpencode `
  -SkipServices:$SkipServices `
  -SkipShell:$SkipShell

$defaultPayloadRoot = Join-Path $repoRoot "build\native-backend\bin"
$releasePayloadRoot = Join-Path $repoRoot "build\Release\servicehub\native-backend"
$debugPayloadRoot = Join-Path $repoRoot "build\Debug\servicehub\native-backend"
$OutDir = Assert-SafePayloadOutDir `
  -OutDir $OutDir `
  -RepoRoot $repoRoot `
  -RepoBuildRoot $repoBuildRoot `
  -AllowedRoots @($defaultPayloadRoot, $releasePayloadRoot, $debugPayloadRoot)

$resources = Join-Path $env:LOCALAPPDATA "SuperClaw\sandbox_manager\resources\native-backend"
$releaseServiceHub = Join-Path $repoRoot "build\Release\servicehub"
if (-not $SkipResourceSync) {
  Assert-ManagedPayloadCopyRootsDoNotOverlap `
    -Source $OutDir `
    -Destination $resources `
    -Description "resource sync"
}
if (-not $SkipReleaseStage) {
  Assert-ManagedPayloadCopyRootsDoNotOverlap `
    -Source $OutDir `
    -Destination $releasePayloadRoot `
    -Description "release-stage copy"
}

$managedPayloadRoots = @($OutDir)
if (-not $SkipResourceSync) {
  Assert-NoReparsePathComponents -Path $resources
  $managedPayloadRoots += $resources
}
if (-not $SkipReleaseStage -and (Test-Path -LiteralPath $releaseServiceHub -PathType Container)) {
  Assert-NoReparsePathComponents -Path $releasePayloadRoot
  $managedPayloadRoots += $releasePayloadRoot
}
. (Join-Path $PSScriptRoot "payload-verification.ps1")

$pythonArchive = $null
$uv = $null
$ghArchive = $null
if (-not $SkipServices) {
  $payloadContractPath = Join-Path $PSScriptRoot "native-payload-contract.json"
  $payloadContract = Get-Content $payloadContractPath -Raw | ConvertFrom-Json
  $uvToolchain = $payloadContract.toolchain.uv
  $pythonToolchain = $payloadContract.toolchain.python
  $pythonArchiveCache = Join-Path $repoBuildRoot "_toolchain\python-archives"
  $pythonArchive = Invoke-NativeTimedStep -Label "python archive prepare" -Action {
    Get-VerifiedPythonArchive `
      -PythonSpec $pythonToolchain `
      -CacheRoot $pythonArchiveCache
  }
  # Acquire both pinned toolchains before the payload tree is touched: a missing
  # or unpinned tool must fail while the previous payload is still intact.
  $uvCache = Join-Path $repoBuildRoot "_toolchain\uv"
  $uv = Invoke-NativeTimedStep -Label "uv toolchain prepare" -Action {
    Get-PinnedUv -UvSpec $uvToolchain -CacheRoot $uvCache
  }
  $mcpToolchain = Invoke-NativeTimedStep -Label "stdio MCP toolchain prepare" -Action {
    Get-PinnedMcpToolchain -NodeSpec $payloadContract.toolchain.node `
      -NodeCacheRoot (Join-Path $repoBuildRoot "_toolchain\node") -UvSpec $uvToolchain -UvCacheRoot $uvCache
  }
  # The GitHub CLI the payload ships (EG1-11), acquired here for the same reason.
  $ghToolchain = $payloadContract.toolchain.gh
  $ghArchive = Invoke-NativeTimedStep -Label "gh archive prepare" -Action {
    Get-VerifiedGhArchive -GhSpec $ghToolchain -CacheRoot (Join-Path $repoBuildRoot "_toolchain\gh")
  }
  # py/venv-launcher (#3897's fix for #3876), built from repo source for the same reason the
  # shell's awk shim is: a build failure must surface before the previous good payload is touched.
  $venvLauncherShim = Invoke-NativeTimedStep -Label "venv launcher shim build" -Action {
    Build-VenvLauncherShim -CacheRoot (Join-Path $repoBuildRoot "_toolchain\venv-launcher")
  }
}

# The pinned POSIX shell (issue #3676), acquired before the payload tree is touched for the same
# reason: a tool that cannot be fetched or built must fail while the previous payload is intact.
$shellToolchain = $null
$shellArchives = $null
$brushExe = $null
$awkShimExe = $null
if (-not $SkipShell) {
  $shellToolchain = (Get-Content (Join-Path $PSScriptRoot "native-payload-contract.json") -Raw | ConvertFrom-Json).toolchain.shell
  $shellCache = Join-Path $repoBuildRoot "_toolchain\shell"
  $shellArchives = Invoke-NativeTimedStep -Label "shell tool archives prepare" -Action {
    Get-VerifiedShellToolArchives -ShellSpec $shellToolchain -CacheRoot (Join-Path $shellCache "archives")
  }
  $brushExe = Invoke-NativeTimedStep -Label "brush build" -Action {
    Build-PinnedBrush -BrushSpec $shellToolchain.brush -CacheRoot (Join-Path $shellCache "brush")
  }
  $awkShimExe = Invoke-NativeTimedStep -Label "awk shim build" -Action {
    Build-AwkShim -CacheRoot $shellCache
  }
}

Invoke-ManagedPayloadMutation `
  -PayloadRoots $managedPayloadRoots `
  -Mutation {
    [void](Assert-PinnedConfigPackageManager -RepoRoot $repoRoot)
    Invoke-NativeTimedStep -Label "initialize payload build tree" -Action {
      Initialize-PayloadBuildTree `
        -PayloadRoot $OutDir `
        -CompletePayload $completePayload
    }

function Assert-Tool($name) {
  $cmd = Get-Command $name -ErrorAction SilentlyContinue
  if (-not $cmd) { throw "$name not found on PATH" }
  Write-Host "using $name = $($cmd.Source)"
}
Assert-Tool bun

function Install-PortablePythonRuntime {
  param(
    [Parameter(Mandatory = $true)][string]$Archive,
    [Parameter(Mandatory = $true)][string]$PythonRoot
  )

  $runtime = Join-Path $PythonRoot "runtime"
  Assert-PythonArchiveSha256 `
    -Archive $Archive `
    -ExpectedSha256 $pythonToolchain.sha256
  Expand-VerifiedPythonArchive -Archive $Archive -Destination $runtime
  # The upstream install-only archive has no BUILD file. Record the release
  # already enforced by its exact URL and SHA for offline payload verification.
  $pythonToolchain.build | Set-Content (Join-Path $runtime "BUILD") -Encoding ascii
  $runtimePython = Join-Path $runtime "python.exe"
  $runtimeDll = Join-Path $runtime "python312.dll"
  if (-not (Test-Path $runtimeDll -PathType Leaf)) {
    throw "pinned portable CPython is missing python312.dll: $runtimeDll"
  }
  $actualBuild = (Get-Content (Join-Path $runtime "BUILD") -Raw).Trim()
  if ($actualBuild -ne $pythonToolchain.build) {
    throw "portable CPython build mismatch: expected $($pythonToolchain.build), got '$actualBuild'"
  }
  $actualVersion = (& $runtimePython -I -B -c "import sys; print(sys.version.split()[0])" |
      Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $actualVersion -ne $pythonToolchain.version) {
    throw "portable CPython mismatch: expected $($pythonToolchain.version), got '$actualVersion'"
  }

  $provenance = [ordered]@{
    implementation = $pythonToolchain.implementation
    version = $pythonToolchain.version
    distribution = $pythonToolchain.distribution
    provider = $pythonToolchain.provider
    build = $pythonToolchain.build
    url = $pythonToolchain.url
    sha256 = $pythonToolchain.sha256
    uv_version = $uvToolchain.version
    uv_commit = $uvToolchain.commit
  }
  $provenance | ConvertTo-Json | Set-Content `
    (Join-Path $PythonRoot "runtime-provenance.json") -Encoding utf8
  return $runtime
}

function Stage-LockedPythonComponent {
  param(
    [Parameter(Mandatory = $true)][string]$Uv,
    [Parameter(Mandatory = $true)][string]$Runtime,
    [Parameter(Mandatory = $true)][string]$ProjectDir,
    [Parameter(Mandatory = $true)][string]$ComponentPath,
    [Parameter(Mandatory = $true)][string]$Description,
    [string]$Extra = "",
    [switch]$InstallProject,
    [string]$ProjectPackage = ""
  )

  if ($InstallProject -and -not $ProjectPackage) {
    throw "$Description requires an explicit ProjectPackage for non-editable installation"
  }
  if ($ProjectPackage -and -not $InstallProject) {
    throw "$Description ProjectPackage requires InstallProject"
  }
  if (-not (Test-Path (Join-Path $ProjectDir "pyproject.toml") -PathType Leaf)) {
    throw "$Description project metadata missing at $ProjectDir"
  }
  if (-not (Test-Path (Join-Path $ProjectDir "uv.lock") -PathType Leaf)) {
    throw "$Description lockfile missing at $ProjectDir"
  }

  $stagingEnvironment = "$ComponentPath.staging"
  if (Test-Path $stagingEnvironment) { Remove-Item $stagingEnvironment -Recurse -Force }
  if (Test-Path $ComponentPath) { Remove-Item $ComponentPath -Recurse -Force }
  New-Item -ItemType Directory -Force $ComponentPath | Out-Null

  $previousProjectEnvironment = $env:UV_PROJECT_ENVIRONMENT
  $env:UV_PROJECT_ENVIRONMENT = $stagingEnvironment
  $runtimePython = Join-Path $Runtime "python.exe"
  $syncArgs = @(
    "sync",
    "--locked",
    "--no-dev",
    "--link-mode", "copy",
    "--python", $runtimePython,
    "--python-preference", "only-system",
    "--no-python-downloads",
    "--project", $ProjectDir
  )
  if ($InstallProject) {
    # uv's local wheel cache does not track every source/resource change when
    # pyproject.toml is unchanged. Refresh only this project, not its locked deps.
    $syncArgs += @("--no-editable", "--reinstall-package", $ProjectPackage)
  } else {
    $syncArgs += "--no-install-project"
  }
  if ($Extra) {
    $syncArgs += @("--extra", $Extra)
  }
  try {
    & $Uv @syncArgs
    if ($LASTEXITCODE -ne 0) {
      throw "locked sync failed for $Description (exit $LASTEXITCODE)"
    }
  } finally {
    if ($null -eq $previousProjectEnvironment) {
      Remove-Item Env:UV_PROJECT_ENVIRONMENT -ErrorAction SilentlyContinue
    } else {
      $env:UV_PROJECT_ENVIRONMENT = $previousProjectEnvironment
    }
  }

  $sourceSitePackages = Join-Path $stagingEnvironment "Lib\site-packages"
  $targetSitePackages = Join-Path $ComponentPath "Lib\site-packages"
  if (-not (Test-Path $sourceSitePackages -PathType Container)) {
    throw "$Description site-packages missing after locked sync: $sourceSitePackages"
  }
  New-Item -ItemType Directory -Force $targetSitePackages | Out-Null
  Invoke-Robocopy $sourceSitePackages $targetSitePackages @("/MIR") "$Description site-packages copy"

  $scripts = Join-Path $ComponentPath "Scripts"
  New-Item -ItemType Directory -Force $scripts | Out-Null
  Copy-Item (Join-Path $Runtime "python.exe") $scripts -Force
  # `python3.exe` as well, because the agent-python component's Scripts directory is on the
  # runtime role's PATH (catalog_roles::runtime) and every model, prompt and skill in this repo
  # spells the interpreter `python3`. A same-directory copy is the whole mechanism: CPython
  # locates its path file by the DLL name (`python312._pth`), not the executable name, so the
  # copy stays as isolated as the original. Done in this shared helper rather than for one
  # component, because branching it would be more code than the three unused copies cost.
  Copy-Item (Join-Path $Runtime "python.exe") (Join-Path $scripts "python3.exe") -Force
  Get-ChildItem $Runtime -Filter "*.dll" -File | Copy-Item -Destination $scripts -Force
  @(
    "..\..\runtime\Lib",
    "..\..\runtime\DLLs",
    "..\Lib\site-packages"
  ) | Set-Content (Join-Path $scripts "python312._pth") -Encoding ascii

  Remove-Item $stagingEnvironment -Recurse -Force
}

# Every robocopy call goes through here, for two reasons that both cost real time:
#   * Retry caps. The default is /R:1000000 /W:30, so ONE locked file - and a
#     running backend holds the payload exes it is executing from - retries for
#     days instead of failing. /R:2 /W:2 gives up in seconds.
#   * Honest failure. robocopy's convention is 0-7 = success, 8+ = failure, but
#     an abnormally terminated robocopy returns a NEGATIVE code, which a plain
#     `-ge 8` test reads as success. That reported a payload sync that had copied
#     nothing - the worst outcome here, since dev loads the payload from the
#     destination and would silently keep running stale binaries.
function Invoke-Robocopy($src, $dst, [string[]]$options, $what) {
  robocopy $src $dst @options /R:2 /W:2 /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -lt 0 -or $LASTEXITCODE -ge 8) {
    throw "$what failed (robocopy exit $LASTEXITCODE); is the app still running?"
  }
  $global:LASTEXITCODE = 0
}

$target = "bun-windows-x64"
$services = @(
  @{ dir = "sandbox\server";       name = "openwork-server" },
  @{ dir = "sandbox\orchestrator"; name = "openwork" },
  @{ dir = "sandbox\channels";     name = "opencode-router" }
)

if (-not $SkipServices) {
  # The orchestrator bundle imports @different-ai/openwork-contracts subpath
  # exports, which exist only as that package's tsc output under dist/.
  # `pnpm install` does not produce them, so build it first - the same chaining
  # the root build:ui / dev:ui scripts and tauri-before-dev.mjs already do -
  # rather than failing mid-bundle on an unresolved import.
  Assert-Tool pnpm
  Write-Host "`n=== building shared contracts ===" -ForegroundColor Cyan
  Invoke-NativeTimedStep -Label "contracts build" -Action {
    Push-Location $repoRoot
    try {
      pnpm --filter @different-ai/openwork-contracts build
      if ($LASTEXITCODE -ne 0) { throw "contracts build failed (exit $LASTEXITCODE)" }
    } finally { Pop-Location }
  }

  # openwork-server and opencode-router import this package's built dist/ too.
  Write-Host "`n=== building shared mcp-policy ===" -ForegroundColor Cyan
  Invoke-NativeTimedStep -Label "mcp-policy build" -Action {
    Push-Location $repoRoot
    try {
      pnpm --filter @different-ai/openwork-mcp-policy build
      if ($LASTEXITCODE -ne 0) { throw "mcp-policy build failed (exit $LASTEXITCODE)" }
    } finally { Pop-Location }
  }

  foreach ($svc in $services) {
    $pkgDir = Join-Path $repoRoot $svc.dir
    Write-Host "`n=== building $($svc.name) ($target) ===" -ForegroundColor Cyan
    Invoke-NativeTimedStep -Label "$($svc.name) bun build" -Action {
      Push-Location $pkgDir
      try {
        bun script/build.ts --target $target --outdir $OutDir
        if ($LASTEXITCODE -ne 0) { throw "$($svc.name) build failed (exit $LASTEXITCODE)" }
      } finally { Pop-Location }
    }
    # build.ts names output <filename>-<target>.exe - normalize to <filename>.exe.
    # MOVE, don't copy: each binary is ~115 MB, so leaving the suffixed original
    # behind doubled the payload (831 MB -> 487 MB after this fix).
    $suffixed = Join-Path $OutDir "$($svc.name)-$target.exe"
    $clean = Join-Path $OutDir "$($svc.name).exe"
    if (Test-Path $suffixed) { Move-Item $suffixed $clean -Force }
    if (-not (Test-Path $clean)) { throw "expected output missing: $clean" }
    Write-Host "ok: $clean"
  }

  # The installed payload is a universal dependency superset. Capability grade
  # controls activation and roster projection; packaging never deletes a Python
  # environment by grade. Every environment is rebuilt from a committed uv lock
  # so stale or ad-hoc packages cannot survive into the release manifest.
  $pythonRoot = Join-Path $OutDir "py"
  if (Test-Path $pythonRoot) {
    Remove-Item $pythonRoot -Recurse -Force
  }
  New-Item -ItemType Directory -Force $pythonRoot | Out-Null
  if (-not $uv) {
    throw "pinned uv was not prepared before payload construction"
  }
  Write-Host "`n=== pinned portable CPython runtime ===" -ForegroundColor Cyan
  if (-not $pythonArchive) {
    throw "verified CPython archive was not prepared before payload construction"
  }
  $portableRuntime = Invoke-NativeTimedStep -Label "portable CPython materialize" -Action {
    Install-PortablePythonRuntime `
      -Archive $pythonArchive `
      -PythonRoot $pythonRoot
  }
  Write-Host "ok: $portableRuntime ($($pythonToolchain.distribution))"

  $nativePythonProject = Join-Path $repoRoot "scripts\native-backend\python-payload"

  $agentVenv = Join-Path $OutDir "py\agent-python-venv"
  $agentPy = Join-Path $agentVenv "Scripts\python.exe"
  Write-Host "`n=== locked agent-python component ===" -ForegroundColor Cyan
  Invoke-NativeTimedStep -Label "python agent-python-venv total" -Action {
    Stage-LockedPythonComponent `
      -Uv $uv `
      -Runtime $portableRuntime `
      -ProjectDir $nativePythonProject `
      -ComponentPath $agentVenv `
      -Description "agent-python-venv" `
      -Extra "agent-python"
  }
  if (-not (Test-Path $agentPy -PathType Leaf)) { throw "agent Python missing after staging: $agentPy" }
  # The Gmail tools (EG1-8) build only these Google APIs, from googleapiclient's static
  # discovery documents. The package ships every API's: ~110 MB and hundreds of files that each
  # boot's payload inventory would stat for nothing. A missing one fails here, not in a send.
  $discoveryDocuments = Join-Path $agentVenv "Lib/site-packages/googleapiclient/discovery_cache/documents"
  $keptDiscovery = @("gmail.v1.json", "calendar.v3.json", "people.v1.json")
  foreach ($name in $keptDiscovery) {
    if (-not (Test-Path -LiteralPath (Join-Path $discoveryDocuments $name) -PathType Leaf)) {
      throw "Google discovery document missing after staging: $name"
    }
  }
  Get-ChildItem -LiteralPath $discoveryDocuments -File |
    Where-Object { $keptDiscovery -notcontains $_.Name } |
    Remove-Item -Force
  # python312._pth disables cwd/site discovery by design. Admit exactly the staged Connector package,
  # not an arbitrary working directory or PYTHONPATH supplied by a caller.
  Add-Content `
    -LiteralPath (Join-Path $agentVenv "Scripts\python312._pth") `
    -Value "..\..\..\connector-service" `
    -Encoding ascii
  Write-Host "ok: $agentPy"

  if (-not $venvLauncherShim) {
    throw "venv launcher shim was not built before payload construction"
  }
  $venvLauncherDir = Install-VenvLauncherShim -Binaries $venvLauncherShim -PythonRoot $pythonRoot
  Write-Host "ok: $venvLauncherDir"

  # The Connector runs from the self-contained agent Python runtime in the network_connector tier. Stage only
  # its fixed-purpose stdlib service package; the web provider dependencies stay in
  # provider packages there; secrets are supplied by the launcher over stdin.
  $connectorPackage = Join-Path $OutDir "connector-service\sandbox_manager"
  New-Item -ItemType Directory -Force $connectorPackage | Out-Null
  foreach ($module in @(
    "__init__.py",
    "connector.py",
    "connector_fetch.py",
    "connector_audit.py",
    "connector_approval.py",
    "dpapi_secret_file.py",
    "dpapi_connector_reader.py",
    "egress_audit.py",
    "egress_allowlist_match.py",
    "egress_guard.py",
    "egress_chat_grants.py",
    "egress_http.py",
    "egress_proxy.py",
    "egress_proxy_approval.py",
    "pac_resolver.py",
    "pac_winhttp.py"
  )) {
    Copy-Item `
      (Join-Path $repoRoot "host\sandbox_manager\src\sandbox_manager\$module") `
      (Join-Path $connectorPackage $module) `
      -Force
  }
  $connectorContracts = Join-Path $OutDir "connector-service\contracts"
  New-Item -ItemType Directory -Force $connectorContracts | Out-Null
  foreach ($module in @("__init__.py", "broker_connector_client_config.py", "connector_ipc_data.py", "egress_approval_grant_data.py")) {
    Copy-Item `
      (Join-Path $repoRoot "shared\contracts\generated\python\contracts\$module") `
      (Join-Path $connectorContracts $module) `
      -Force
  }
  Write-Host "ok: Connector service staged ($connectorPackage)"

  $readersVenv = Join-Path $OutDir "py\readers-venv"
  $readersPy = Join-Path $readersVenv "Scripts\python.exe"
  Write-Host "`n=== locked readers/OCR component ===" -ForegroundColor Cyan
  Invoke-NativeTimedStep -Label "python readers-venv total" -Action {
    Stage-LockedPythonComponent `
      -Uv $uv `
      -Runtime $portableRuntime `
      -ProjectDir $nativePythonProject `
      -ComponentPath $readersVenv `
      -Description "readers-venv" `
      -Extra "readers"
  }
  if (-not (Test-Path $readersPy -PathType Leaf)) { throw "readers Python missing after staging: $readersPy" }
  Write-Host "ok: $readersPy"

  # The reader scripts the Profiles' parse_pdf tool and document skills run with
  # that interpreter. The broker names this tree to
  # the runtime as READERS_DIR. Replaced, not merged, so a reader deleted from the
  # repo does not survive in an incremental payload.
  $readersSrc = Join-Path $repoRoot "packaging\docker\readers"
  $readersDst = Join-Path $OutDir "readers"
  if (-not (Test-Path (Join-Path $readersSrc "extract_text.py") -PathType Leaf)) {
    throw "reader scripts missing at $readersSrc"
  }
  if (Test-Path -LiteralPath $readersDst) { Remove-Item -LiteralPath $readersDst -Recurse -Force }
  New-Item -ItemType Directory -Force $readersDst | Out-Null
  Copy-Item (Join-Path $readersSrc "*.py") $readersDst -Force
  Write-Host "ok: reader scripts staged in $readersDst"

  $hdrSrc = Join-Path $repoRoot "packaging\installer\resources\hdr-sidecar"
  $hybridVenv = Join-Path $OutDir "py\hybrid-dr-venv"
  $hybridPy = Join-Path $hybridVenv "Scripts\python.exe"
  Write-Host "`n=== locked hybrid-dr sidecar component ===" -ForegroundColor Cyan
  Invoke-NativeTimedStep -Label "python hybrid-dr-venv total" -Action {
    Stage-LockedPythonComponent `
      -Uv $uv `
      -Runtime $portableRuntime `
      -ProjectDir $hdrSrc `
      -ComponentPath $hybridVenv `
      -Description "hybrid-dr-venv" `
      -InstallProject `
      -ProjectPackage "hybrid-dr-orchestrator"
  }
  if (-not (Test-Path $hybridPy -PathType Leaf)) { throw "Hybrid DR Python missing after staging: $hybridPy" }
  # Verify the copied package, not just the wheel or staging environment. Fail
  # before signing, manifest publication, or resource/release copies can run.
  & (Join-Path $portableRuntime "python.exe") -I -B `
    (Join-Path $PSScriptRoot "verify_python_source_parity.py") `
    --source (Join-Path $hdrSrc "src\hybrid_dr_orchestrator") `
    --installed (Join-Path $hybridVenv "Lib\site-packages\hybrid_dr_orchestrator")
  if ($LASTEXITCODE -ne 0) {
    throw "Hybrid DR source parity failed (exit $LASTEXITCODE); refusing to publish stale package bytes"
  }
  Write-Host "ok: $hybridPy"

  $classifierVenv = Join-Path $OutDir "py\classifier-venv"
  $classifierPy = Join-Path $classifierVenv "Scripts\python.exe"
  Write-Host "`n=== locked intent-classifier component ===" -ForegroundColor Cyan
  Invoke-NativeTimedStep -Label "python classifier-venv total" -Action {
    Stage-LockedPythonComponent `
      -Uv $uv `
      -Runtime $portableRuntime `
      -ProjectDir $nativePythonProject `
      -ComponentPath $classifierVenv `
      -Description "classifier-venv" `
      -Extra "classifier"
  }
  if (-not (Test-Path $classifierPy -PathType Leaf)) { throw "classifier Python missing after staging: $classifierPy" }
  Write-Host "ok: $classifierPy"

  $icSrc = Join-Path $repoRoot "sandbox\intent_classifier\intent_classifier_server.py"
  $icDstDir = Join-Path $OutDir "intent-classifier"
  $icDst = Join-Path $icDstDir "intent_classifier_server.py"
  if (-not (Test-Path $icSrc)) { throw "intent classifier script missing at $icSrc" }
  New-Item -ItemType Directory -Force $icDstDir | Out-Null
  Copy-Item $icSrc $icDst -Force
  Write-Host "ok: $icDst"

  Invoke-NativeTimedStep -Label "python payload prune" -Action {
    & (Join-Path $portableRuntime "python.exe") -I -B `
      (Join-Path $PSScriptRoot "prune_python_payload.py") $pythonRoot
    if ($LASTEXITCODE -ne 0) { throw "python payload prune failed (exit $LASTEXITCODE)" }
  }

  $locksRoot = Join-Path $OutDir "python-locks"
  if (Test-Path $locksRoot) { Remove-Item $locksRoot -Recurse -Force }
  $nativeLocks = Join-Path $locksRoot "native-python-payload"
  $hdrLocks = Join-Path $locksRoot "hybrid-dr"
  New-Item -ItemType Directory -Force $nativeLocks, $hdrLocks | Out-Null
  Copy-Item (Join-Path $nativePythonProject "pyproject.toml") $nativeLocks -Force
  Copy-Item (Join-Path $nativePythonProject "uv.lock") $nativeLocks -Force
  Copy-Item (Join-Path $hdrSrc "pyproject.toml") $hdrLocks -Force
  Copy-Item (Join-Path $hdrSrc "uv.lock") $hdrLocks -Force
  Write-Host "ok: dependency lock provenance staged in $locksRoot"

  Invoke-NativeTimedStep -Label "stdio MCP toolchain stage" -Action {
    Install-PayloadMcpToolchain -PayloadRoot $OutDir -Toolchain $mcpToolchain
  }
}

# ---- opencode.exe = the SuperClaw runtime pinned in upstream.lock.json -------
# The desktop sidecar (prepare-sidecar.mjs) consumes this same committed Windows
# artifact, so both surfaces run one engine.
# fetch-runtime-bin.ps1 refuses an LFS pointer or a stamp that is not the pin and
# rebuilds from the pinned commit.
if (-not $SkipOpencode) {
  & (Join-Path $repoRoot "packaging\docker\fetch-runtime-bin.ps1")
  if ($LASTEXITCODE -ne 0) { throw "SuperClaw runtime resolve failed (exit $LASTEXITCODE)" }
  $runtimeBin = Join-Path $repoRoot "packaging\docker\superclaw-runtime-bin\superclaw-windows-x64.exe"
  $ocExe = Join-Path $OutDir "opencode.exe"
  # A -Sign build signs this copy in place, so a staged file that no longer hashes
  # to the runtime is restaged, not trusted or refused.
  if (-not (Test-Path $ocExe) -or (Get-FileHash $ocExe).Hash -ne (Get-FileHash $runtimeBin).Hash) {
    Copy-Item $runtimeBin $ocExe -Force
  }
  Write-Host "ok: $ocExe (SuperClaw runtime $((Get-Content "$runtimeBin.head" -Raw).Trim()))"
}

# ---- native isolation broker + unelevated launcher ---------------------------
if (-not $SkipServices) {
  Assert-Tool cargo
  $nativeIsolationManifest = Join-Path $repoRoot "host\native_isolation_broker\Cargo.toml"
  # Pin the target dir: the copy below (and reset-windows-sandbox-accounts.ps1) read the
  # executables from here, but an inherited CARGO_TARGET_DIR (CI sets one for the Tauri
  # build) would send the cargo output somewhere else.
  $nativeIsolationTargetRoot = Join-Path $repoRoot "host\native_isolation_broker\target"
  # build.rs stamps SUPERCLAW_BUILD_VERSION into the broker's and launcher's version resource,
  # which is the version the broker's UAC dialog shows. Only build-superclaw.ps1 and the
  # credential-gated CI step export it, so when it is unset compute it the way
  # build-sandbox-manager.ps1 does (x.y.z from pyproject.toml, plus Mdd); otherwise the
  # binaries carry the crate version 0.1.0.0.
  $baseVersion = '0.1.0'
  $pyproject = Join-Path $repoRoot 'host\sandbox_manager\pyproject.toml'
  if (Test-Path -LiteralPath $pyproject) {
    $projectBlock = [regex]::Match((Get-Content -LiteralPath $pyproject -Raw), '(?ms)^\[project\]\s*(?<body>.*?)(?=^\[|\z)')
    $versionMatch = [regex]::Match($projectBlock.Groups['body'].Value, '(?m)^\s*version\s*=\s*["''](?<version>\d+\.\d+\.\d+)')
    if ($versionMatch.Success) { $baseVersion = $versionMatch.Groups['version'].Value }
  }
  $inheritedBuildVersion = $env:SUPERCLAW_BUILD_VERSION
  if ($inheritedBuildVersion -and $inheritedBuildVersion.Trim()) {
    $buildVersion = $inheritedBuildVersion.Trim()
    if ($buildVersion -notmatch '^\d+\.\d+\.\d+\.\d+$') {
      throw "SUPERCLAW_BUILD_VERSION must be a four-part numeric version."
    }
    if (-not $buildVersion.StartsWith("$baseVersion.")) {
      throw "SUPERCLAW_BUILD_VERSION '$buildVersion' does not match pyproject base '$baseVersion'."
    }
  } else {
    $today = Get-Date
    $buildVersion = "$baseVersion.$([int]('{0}{1:00}' -f $today.Month, $today.Day))"
  }
  Write-Host "`n=== building native isolation executables (release, version $buildVersion) ===" -ForegroundColor Cyan
  # Set for cargo only, so a standalone run does not leave today's version in the caller's shell.
  $env:SUPERCLAW_BUILD_VERSION = $buildVersion
  try {
    Invoke-NativeTimedStep -Label "native isolation cargo build" -Action {
      & cargo build --manifest-path $nativeIsolationManifest --target-dir $nativeIsolationTargetRoot --release --bins --locked
      if ($LASTEXITCODE -ne 0) {
        throw "native isolation cargo build failed (exit $LASTEXITCODE)"
      }
    }
  } finally {
    $env:SUPERCLAW_BUILD_VERSION = $inheritedBuildVersion
  }
  $nativeIsolationTarget = Join-Path $nativeIsolationTargetRoot "release"
  $nativeIsolationPayload = Join-Path $OutDir "native-isolation"
  New-Item -ItemType Directory -Force $nativeIsolationPayload | Out-Null
  # The broker's FileDescription is the program name its UAC consent dialog shows, and a missing
  # version resource fails silently (the dialog falls back to the bare file name), so assert it
  # on the copies that ship rather than discovering it in a screenshot.
  $expectedFileDescriptions = [ordered]@{
    "native_isolation_broker.exe"         = "SuperClaw"
    "native_isolation_launcher.exe"       = "SuperClaw Isolation Launcher"
    "native_isolation_tier_bootstrap.exe" = "SuperClaw Tier Bootstrap"
  }
  foreach ($name in $expectedFileDescriptions.Keys) {
    $source = Join-Path $nativeIsolationTarget $name
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
      throw "native isolation build output is missing: $source"
    }
    $staged = Join-Path $nativeIsolationPayload $name
    Copy-Item -LiteralPath $source -Destination $staged -Force
    $versionInfo = (Get-Item -LiteralPath $staged).VersionInfo
    if ($versionInfo.FileDescription -ne $expectedFileDescriptions[$name]) {
      throw "Version resource missing or wrong on ${name}: FileDescription is '$($versionInfo.FileDescription)', expected '$($expectedFileDescriptions[$name])'. Check host\native_isolation_broker\build.rs."
    }
    if ($versionInfo.FileVersion -ne $buildVersion) {
      throw "Version resource on ${name} carries FileVersion '$($versionInfo.FileVersion)', expected the build version '$buildVersion'."
    }
    Write-Host "ok: $name version resource FileDescription='$($versionInfo.FileDescription)', FileVersion=$($versionInfo.FileVersion)"
  }
  Write-Host "ok: native isolation executables in $nativeIsolationPayload"
}

# ---- pinned GitHub CLI (egress EG1-11) ----------------------------------------
# GitHub sign-in in openwork-server and the agent's gh both run this one; see
# gh-toolchain-policy.ps1.
if (-not $SkipServices) {
  $ghPayload = Join-Path $OutDir "gh"
  Invoke-NativeTimedStep -Label "gh stage" -Action {
    Install-VerifiedGh -Archive $ghArchive -ExpectedSha256 $ghToolchain.sha256 -Destination $ghPayload
  }
  Write-Host "ok: pinned gh $($ghToolchain.version) in $ghPayload (sha256 verified)"
}

# ---- pinned POSIX shell (design section 6.3, issue #3676) ----------------------
# The agent's bash tool needs a shell that (a) is version-pinned rather than
# "whatever is on the user's PATH", and (b) STARTS UNDER A CONSTRAINED TOKEN.
# Git-Bash fails (b): MSYS2 aborts with NtCreateDirectoryObject(\BaseNamedObjects\msys-...)
# ACCESS_DENIED. brush and the uutils/goawk tools are native executables with no
# MSYS shared memory. See shell-toolchain-policy.ps1 for what is built and what is
# fetched, and native-payload-contract.json (toolchain.shell) for the pins.
if (-not $SkipShell) {
  $shellDir = Join-Path $OutDir "shell"
  # Replaced whole every build: a -Sign build signs this tree in place, so a kept
  # copy no longer hashes to its pin, and a partial build must not keep a stale tool.
  Invoke-NativeTimedStep -Label "shell stage" -Action {
    Install-PinnedShell -BrushExe $brushExe -BrushLicense (Join-Path $PSScriptRoot $shellToolchain.brush.license_file) `
      -AwkShim $awkShimExe -ToolArchives $shellArchives -ShellSpec $shellToolchain -Destination $shellDir
  }
  Write-Host "ok: pinned shell in $shellDir (brush $($shellToolchain.brush.version) built from crate, tools sha256 verified)"
}

# ---- config source (offline OpenCode dependency tree) -------------------------
# The configuration tree itself ships as a Product Profile. What the payload owes
# the runtime is the dependency tree the Profiles only declare, so that an
# installed host never reaches npm; resolve_config_source() finds it at
# <payload>\config-source.
if (-not $SkipServices) {
  Invoke-NativeTimedStep -Label "config source stage" -Action {
    Stage-DeterministicConfigSource `
      -RepoRoot $repoRoot `
      -PayloadRoot $OutDir `
      -CompletePayload $completePayload `
      -StageCacheRoot $(if ($reuseBuildCaches) { $payloadCacheRoot } else { "" })
  }
}

if (-not $PayloadVersion) {
  # Identity comes from git HEAD plus a `.dirty.<nonce>` suffix for development
  # builds over an uncommitted tree, or `.partial.<nonce>` for a partial one. See
  # payload-identity-policy.ps1 for why the scan tolerates parts of the repo it
  # cannot read.
  $PayloadVersion = Get-NativePayloadVersion `
    -RepoRoot $repoRoot `
    -DevelopmentPayloadIdentity ([bool]$DevelopmentPayloadIdentity) `
    -PartialPayload (-not $completePayload)
} elseif (-not $completePayload) {
  $PayloadVersion = Add-PartialPayloadSuffix -Version $PayloadVersion
}
# ---- sign before any manifest is written ---------------------------------------
# Advanced Installer signs the executables it packages, and a signature appended
# after the manifest is written leaves the shipped payload failing its own
# integrity check at startup. Signing the source tree here means all three
# manifests below (OutDir, resources, release stage) hash the shipped bytes; the
# resource and release copies inherit the signed files.
if ($Sign) {
  Write-Host "`n=== signing payload executables (before manifest) ===" -ForegroundColor Cyan
  Invoke-NativeTimedStep -Label "payload Authenticode signing" -Action {
    Set-PayloadAuthenticodeSignature -PayloadRoot $OutDir `
      -CertificateThumbprint $SigningCertificateThumbprint `
      -CertificateSubject $SigningCertificateSubject
  }
}

# One cache per payload root, named after where it sits under build\, so the default,
# Debug and Release payloads do not evict each other's entries.
$manifestHashCache = Join-Path $payloadCacheRoot (
  "manifest-hash-" +
  $OutDir.Substring($repoBuildRoot.Length).Trim("\", "/").Replace("\", "-").Replace("/", "-") +
  ".tsv"
)
# Timestamps carried over from a build made from different toolchain pins or locks
# prove nothing about the bytes, so those inputs are the cache's epoch.
$manifestHashEpoch = Get-PayloadHashCacheEpoch -Path @(
  (Join-Path $PSScriptRoot "native-payload-contract.json"),
  (Join-Path $PSScriptRoot "python-payload\uv.lock"),
  (Join-Path $repoRoot "packaging\installer\resources\hdr-sidecar\uv.lock"),
  (Join-Path $repoRoot "pnpm-lock.yaml"),
  (Join-Path $repoRoot "sandbox\agent_config\profiles\lite\package-lock.json"),
  (Join-Path $PSScriptRoot "payload-manifest-policy.ps1"),
  $PSCommandPath,
  (Join-Path $PSScriptRoot "python-runtime-policy.ps1"),
  (Join-Path $PSScriptRoot "node-toolchain-policy.ps1"),
  (Join-Path $PSScriptRoot "pinned-archive-policy.ps1"),
  (Join-Path $PSScriptRoot "gh-toolchain-policy.ps1"),
  (Join-Path $PSScriptRoot "shell-toolchain-policy.ps1")
)
$manifestWriter = {
  param([string]$root, [string]$version)
  Write-CanonicalPayloadManifest `
    -PayloadRoot $root `
    -PayloadVersion $version `
    -HashCachePath $manifestHashCache `
    -HashCacheEpoch $manifestHashEpoch `
    -FullHash:(-not $reuseBuildCaches)
}
Invoke-NativeTimedStep -Label "source payload manifest" -Action {
  Set-CanonicalPayloadManifest `
    -PayloadRoot $OutDir `
    -CompletePayload $completePayload `
    -PayloadVersion $PayloadVersion `
    -ManifestWriter $manifestWriter
}

# ---- sync payload to the app's resources dir ----------------------------------
# resolve_bin_dir()'s packaged candidate is <resources>\native-backend, the same
# resources dir build-superclaw.ps1 syncs. Copying here lets the INSTALLED app
# find the native payload with no env overrides.
if (-not $SkipResourceSync) {
  Invoke-NativeTimedStep -Label "runtime resource payload copy" -Action {
    Copy-ManagedPayloadTree `
      -Source $OutDir `
      -Destination $resources `
      -CompletePayload $completePayload `
      -Description "resource sync"
  }
  Invoke-NativeTimedStep -Label "runtime resource manifest publish and verify" -Action {
    $resourceVerifier = {
      param([string]$root)
      Assert-NativeBackendPayload `
        -PayloadRoot $root `
        -Label "runtime resource sync" `
        -UvPath $uv
    }
    Copy-CanonicalPayloadManifest `
      -SourceRoot $OutDir `
      -DestinationRoot $resources `
      -Verifier $resourceVerifier
  }
  Write-Host "ok: payload synced to $resources"
}

# ---- stage into the Release tree so the INSTALLER carries it ------------------
# SuperClaw.aip packages `build\Release\servicehub` as a folder, so a payload at
# `build\Release\servicehub\native-backend` ships with the installer with no
# installer-config change. resolve_bin_dir() looks beside sandbox_manager.exe and
# one level up, which is exactly where this lands after install. Without this a
# clean-machine install has no native backend at all (the %LOCALAPPDATA% sync is
# dev-only).
if (-not $SkipReleaseStage) {
  if (Test-Path -LiteralPath $releaseServiceHub -PathType Container) {
    $dest = $releasePayloadRoot
    Write-Host "`n=== staging payload into the Release tree (installer input) ===" -ForegroundColor Cyan
    # Mirror the complete universal payload, including every locked Python tree.
    # The foundation copy helper excludes the root manifest. Publish the source
    # roster only after the destination bytes exist, then verify those bytes with
    # the runtime's own consumer before the installer can observe the tree.
    Invoke-NativeTimedStep -Label "release payload copy" -Action {
      Copy-ManagedPayloadTree `
        -Source $OutDir `
        -Destination $dest `
        -CompletePayload $completePayload `
        -Description "release-stage copy"
    }
    Invoke-NativeTimedStep -Label "release payload manifest publish and verify" -Action {
      $releaseVerifier = {
        param([string]$root)
        Assert-NativeBackendPayload `
          -PayloadRoot $root `
          -Label "release-stage copy" `
          -UvPath $uv
      }
      # The installer packages this tree, and a partial build carries members no
      # build of this commit produced.
      Copy-CanonicalPayloadManifest `
        -SourceRoot $OutDir `
        -DestinationRoot $dest `
        -Verifier $releaseVerifier `
        -Publish $completePayload
    }
    if (-not $completePayload) {
      Write-Host "note: partial payload; installer tree has no manifest until a complete build" -ForegroundColor Yellow
    }
    $mb = [math]::Round(((Get-ChildItem $dest -Recurse -File | Measure-Object Length -Sum).Sum)/1MB)
    Write-Host "ok: $dest ($mb MB) - will be packaged by the installer"
  } else {
    Write-Host "note: build\Release\servicehub not present; skipping installer staging" -ForegroundColor Yellow
  }
}

Write-Host "`nDone. Binaries and canonical manifest in $OutDir" -ForegroundColor Green
  }

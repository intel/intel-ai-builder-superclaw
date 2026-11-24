# Native backend payload

The **native backend payload** is the directory of executables, Python
environments and pinned tools that runs SuperClaw's agent stack directly on the
Windows host. This folder builds it, verifies it, and can launch it by hand.

Terms used below:

| Term | Meaning |
|---|---|
| Supervisor (`openwork.exe`) | Orchestrator that starts and watches the other backend processes (`openwork.exe serve`). |
| OpenWork Server, OWS (`openwork-server.exe`) | The chat/API server the UI talks to, on `127.0.0.1:8787` by default. |
| OpenCode runtime (`opencode.exe`) | The agent engine, built from `third_party/opencode` plus `patches/opencode/`. It listens on a loopback port chosen per start. |
| `opencode-router.exe` | Slack/Telegram channel bridge. Its health port is chosen per start. |
| LRM | LLMRouter Manager, the host-side model router on `127.0.0.1:18321`. It is not part of the payload. |
| Sandbox Manager | The host service (`host/sandbox_manager`) that verifies the payload and starts the backend. |
| Broker | The native isolation broker (`host/native_isolation_broker`). It provisions per-user **tier** accounts (`bootstrap`, `file_tool`, `network_connector`, `channel`) and starts each backend role inside one. |
| Product Profile | The packaged `lite`, `standard` or `pro` configuration under `sandbox/agent_config/profiles/`. It decides which agents and features exist. |

**Owner:** native backend / sandbox maintainers. **Contract:**
`native-payload-contract.json` (toolchain pins, components and verification
grades) and the canonical `manifest.json` that Sandbox Manager's
`payload_integrity` checks before every start. **Allowed dependencies:** the
repository's own packages plus the pinned toolchains declared in the contract.
**Tests:** `scripts/native-backend/tests/` (run by hand with `pytest`).

## Prerequisites

| Tool | Used for |
|---|---|
| Windows 11 x64 | The only supported host. |
| pnpm 10.34.3 (the root `packageManager` pin) and `pnpm install` | Shared packages and the offline OpenCode dependency tree. Any other pnpm version is rejected. |
| Bun | Compiling `openwork.exe`, `openwork-server.exe` and `opencode-router.exe`. Rebuilding `opencode.exe` additionally requires exactly Bun 1.3.14 (`scripts/ci/install-bun.sh`). |
| Rust/Cargo (MSVC toolchain) with the Windows SDK (`rc.exe`) | The broker and launcher, the brush shell, and the `awk` and `venv-launcher` shims. |
| Git | Payload identity and the OpenCode patch scripts. |
| uv (optional) | Running the payload verifier. If uv is not on `PATH`, the build uses the pinned uv it downloads. |

The build downloads and SHA-256-verifies its own pinned uv, portable CPython,
Node.js, GitHub CLI and shell tools into `build\_toolchain\` (see
[How the build works](#how-the-build-works)); you do not install those.

## Build the payload

The usual path is the unified build, which builds the payload into
`build\<Configuration>\servicehub\native-backend` beside ServiceHub:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File packaging\installer\build-superclaw.ps1 -Configuration Debug -SkipLocalSync
```

To build only the payload, run this folder's script directly:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\native-backend\build-native-backend.ps1 -SkipResourceSync -DevelopmentPayloadIdentity
```

Stop SuperClaw and any hand-launched backend first: the copy steps cannot replace
executables that are running.

Without `-OutDir` the payload goes to `build\native-backend\bin\`. A standalone run
also, by default:

- copies it to `%LOCALAPPDATA%\SuperClaw\sandbox_manager\resources\native-backend\`.
  Sandbox Manager checks that location last, after every repository build
  location, so pass `-SkipResourceSync` unless you need it.
- mirrors it into `build\Release\servicehub\native-backend\` (the installer input)
  if `build\Release\servicehub` exists.

| Option | Effect |
|---|---|
| `-OutDir <path>` | Output directory. Must be `build\native-backend\bin`, `build\Debug\servicehub\native-backend` or `build\Release\servicehub\native-backend`. |
| `-SkipResourceSync` | Do not copy to `%LOCALAPPDATA%`. |
| `-SkipReleaseStage` | Do not mirror into `build\Release\servicehub\native-backend`. |
| `-DevelopmentPayloadIdentity` | Allow a complete build from a worktree with uncommitted changes. The payload version becomes `<HEAD>.dirty.<timestamp>`; without the flag such a build is refused. Also enables the build caches. |
| `-PayloadVersion <text>` | Use this payload version instead of the Git-derived one. |
| `-SkipOpencode`, `-SkipServices`, `-SkipShell` | Partial build: skip `opencode.exe`, everything else from source (services, Python, broker, toolchains, config source), or the shell. See [Partial builds](#partial-builds). |
| `-FullManifestHash` | Hash every file and stage the config tree in full, ignoring the build caches. |
| `-Sign` | Authenticode-sign the payload executables before any manifest is written. Required for a signed installer build, because the installer would otherwise sign them after the manifest and break it. |
| `-SigningCertificateThumbprint`, `-SigningCertificateSubject` | Select the signing certificate when `Cert:\CurrentUser\My` holds more than one; the script will not guess. |

There is no Debug or Release flavor of the payload executables. The
`-Configuration` of `build-superclaw.ps1` only chooses the output location and
whether the installer is built.

## Payload contents

| Path | Contents |
|---|---|
| `openwork.exe`, `openwork-server.exe`, `opencode-router.exe` | Bun-compiled from `sandbox/orchestrator`, `sandbox/server` and `sandbox/channels`. |
| `opencode.exe` | Copy of `packaging\docker\superclaw-runtime-bin\superclaw-windows-x64.exe`, resolved (and rebuilt if stale) by `packaging\docker\fetch-runtime-bin.ps1`. The desktop sidecar uses the same binary. |
| `native-isolation\` | `native_isolation_broker.exe`, `native_isolation_launcher.exe` and `native_isolation_tier_bootstrap.exe`, built with `cargo --release --locked`. None needs signing. |
| `config-source\` | Offline OpenCode dependency tree: production `node_modules` plus the Product Profiles' dependency manifests. The configuration itself comes from the Product Profile. |
| `shell\` | The pinned POSIX shell; see [Pinned shell](#pinned-shell). |
| `tools\node\` | Node.js 24.21.0 (`node`, `npm`, `npx`) for catalog MCP servers started through `npx`. |
| `tools\uv\` | uv 0.9.16 (`uv.exe`, `uvx.exe`): the payload's only uv, used for agent-installed Python tools and MCP servers started through `uvx`. |
| `gh\` | GitHub CLI 2.102.0, used by GitHub sign-in and the agent. |
| `py\runtime\` | Portable CPython 3.12.10, the base for every environment below. |
| `py\agent-python-venv\` | Python for the agent's tools and Connector search (`tavily-python`, `ddgs`, ...). |
| `py\venv-launcher\` | `python.exe`, `python3.exe` and `pip.exe` shims; see [Python for agent tasks](#python-for-agent-tasks). |
| `connector-service\` | The loopback Connector service, started as the `connector_service` role in the `network_connector` tier. |
| `py\hybrid-dr-venv\` | Hybrid Deep Research (HDR) sidecar, started as the `hdr_sidecar` role in the `file_tool` tier when the Product Profile requires it. |
| `py\readers-venv\`, `readers\` | Document readers and OCR for `parse_pdf` and the document skills; scripts copied from `packaging/docker/readers`. Passed to the runtime as `READERS_VENV` and `READERS_DIR`. |
| `py\classifier-venv\`, `intent-classifier\` | Intent classifier for channel routing, started by the Supervisor on port 18791. |
| `manifest.json` | Canonical manifest: payload version plus the size and SHA-256 of every file. |

Every Python environment is synced from a committed `uv.lock`
(`python-payload/uv.lock`, and `packaging/installer/resources/hdr-sidecar/uv.lock`
for HDR) and then pruned by `prune_python_payload.py`.

### Pinned shell

The agent's shell must start under a restricted tier token, which Git Bash
(MSYS2) cannot do. `shell\` therefore ships:

- `sh.exe` and `bash.exe`: [brush](https://github.com/reubeno/brush) 0.4.0, built
  from its SHA-256-pinned crate with uutils coreutils compiled in as builtins. One
  patch from `shell-patches\` fixes a hang on here-documents over 4 KiB.
- Standalone tools for child processes, because builtins are invisible to `xargs`
  and `find -exec`: uutils `grep`, `sed`, `find`, `xargs` and 11 coreutils, GoAWK
  as `awk.exe` (through the shim in `shell-shims\awk`), and ripgrep 15.2.0 as
  `rg.exe` for OpenCode's code search.
- `licenses\` with each tool's licence text.

The tool archives come from GitHub releases and are pinned in
`native-payload-contract.json` (`toolchain.shell`).

The runtime `PATH` is, in order: `shell`, `tools\node`, `tools\uv`, `gh\bin`,
`py\venv-launcher`, `py\agent-python-venv\Scripts`, the machine `PATH`, then the
tier's writable `.local\python\Scripts` and `.local\bin`. Payload tools therefore
win over same-named machine tools for every process the runtime starts.
Differences from a typical Unix shell:

- `find.exe` is the uutils one, not `C:\Windows\System32\find.exe`.
- `sort` is not shipped as an executable, so under `xargs` or `find -exec` it
  resolves to `C:\Windows\System32\sort.exe`.
- `find` and `grep -r` print backslash paths; use `find -print0 | xargs -0` or
  `find -exec ... {} +`.
- There is no `which` (use `command -v`), `unzip` or `wget`; `pwd` returns
  `C:\...`; `tar` is Windows bsdtar.

### Python for agent tasks

Before the runtime starts, Sandbox Manager prepares a writable venv at
`<file_tool home>\.local\python` from `py\runtime\python.exe`. It is shared by all
of the owner's chats and survives restarts. Bare `python`, `python3` and `pip`
resolve to the read-only shims in `py\venv-launcher`, which forward into that venv
(`VIRTUAL_ENV`) and fall back to the payload interpreter if it is missing. So
`pip install cowsay` followed by `python -c "import cowsay"` works, while the tier
cannot replace the shims. The venv's `Scripts` directory comes after the machine
`PATH`, so nothing installed there can shadow a system command. A path file puts
the product's preinstalled libraries ahead of task-installed packages, so a task
can add packages but not replace a preinstalled one. Never install into the
payload environments (`OPENCODE_PYTHON`, `GMAIL_PYTHON`, `UV_PYTHON`) or edit
their `python312._pth`.

Agent-added command-line tools are supported as **Python wheels installed with
`uv tool install`**, run from the agent's shell in the `file_tool` account. The
broker sets `UV_TOOL_DIR`, `UV_TOOL_BIN_DIR` and `UV_CACHE_DIR` under
`<file_tool home>\.local`, `UV_PYTHON` to the payload Python, and `UV_OFFLINE=1`,
`UV_NO_BUILD=1`, `UV_NO_CONFIG=1`, `UV_PYTHON_DOWNLOADS=never`. Put reviewed wheels,
including dependencies, under `$HOME/.local/wheels`, then:

```sh
uv tool install --offline --no-index --no-build --find-links "$HOME/.local/wheels" 'example-cli==1.2.3'
uv tool list
uv tool uninstall example-cli
```

Missing wheels fail instead of triggering a download or source build. Catalog MCP
servers started through `uvx` set `UV_OFFLINE=0` for their own launch only. These
defaults are routing, not a security boundary; shell approvals, audit and tier
restrictions still apply. Tools persist across restarts and payload updates, and
are deleted with the runtime state (`build-superclaw.ps1 -Clean` or
`-CleanRuntimeOnly`, or an uninstall that removes data).

To check this on an installed app, copy `verify_agent_tools.py` into a test
workspace and run it through the app's shell tool:
`python -B verify_agent_tools.py install`, restart the app, run it with `restart`,
then with `cleanup`. It refuses to run outside the `file_tool` account.

## How the build works

**Pinned toolchains.** Before touching the output directory, the script downloads
and verifies uv, CPython, Node.js and gh into `build\_toolchain\`, and builds
brush and both shims with Cargo. A failure there leaves the previous payload
intact. A uv on `PATH` is used only if it reports the pinned version and commit.

**Offline OpenCode dependencies.** `config-source\` is produced with
`pnpm deploy` from the `config-deps` workspace importer, using the committed lock
in frozen offline mode with lifecycle scripts disabled. Staging requires all three
Product Profiles to declare a byte-identical `package.json` and the importer to pin
the same `@opencode-ai/plugin` version. Every install script fails the build
except the audited `msgpackr-extract@3.0.4` one, whose prebuilt Windows binaries
must be present and load under Node. At runtime the tree is copied into the
runtime config without Bun, network access or a package manager.

**Manifest and identity.** The payload version is the Git `HEAD` commit, with a
`.dirty.<timestamp>` suffix (needs `-DevelopmentPayloadIdentity`) or a
`.partial.<timestamp>` suffix for partial builds. `manifest.json` is written after
signing, and each copy (`%LOCALAPPDATA%`, Release stage) gets its manifest only
after its files are in place and pass `Assert-NativeBackendPayload`. At start-up
Sandbox Manager stages the payload into
`%LOCALAPPDATA%\SuperClaw\backend\payload\current` and verifies it against its
manifest before seeding the config and again just before starting the backend; a
payload without a valid manifest is refused.

**Build caches.** Development builds (`-DevelopmentPayloadIdentity` without `-Sign`
or `-FullManifestHash`) reuse two caches in `build\_payload-cache\`:

- a manifest hash cache, which rehashes only files whose path, size or last-write
  time changed. Files stamped within 2 s of the scan are never cached, and the
  cache is discarded when the contract, the locks or the build scripts change.
  Content rewritten in place with the same size and timestamp is not detected.
- a `config-source` snapshot keyed by every input of the deploy (root
  `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.npmrc`, `.pnpmfile.cjs`,
  the importer manifest, the pnpm version, the architecture and the staging
  scripts). It is checked by path, size and timestamp, not by content.

Copies to `%LOCALAPPDATA%` and the Release stage are skipped when the destination
manifest already lists the same files. The published manifest is then checked
against the destination's file list and sizes, not its contents, so a same-size
file changed in the destination is not detected. Delete the destination
`manifest.json` to force a recopy, and `build\_payload-cache\` to force a full
rehash. Each stage prints
`  [step] <label>: <seconds>s`.

### Partial builds

A build with `-SkipOpencode`, `-SkipServices` or `-SkipShell` updates the output
in place and keeps the members an earlier complete build produced.
`-SkipResourceSync` and `-SkipReleaseStage` only skip copies; they do not make a
build partial. It still publishes manifests for the output
and `%LOCALAPPDATA%` under a `.partial` identity, but removes the manifest from the
Release stage, which only a complete build may publish. If a kept member is
missing, it fails with `partial payload cannot publish a canonical manifest`; run
one complete build first. A partial build without `-SkipServices` rebuilds the
broker and launcher, so pass `-Sign` again if they must be signed.

## Run it

### Full app from source (`pnpm dev`)

```powershell
$env:OPENWORK_SIDECAR_FORCE_BUILD = "0"   # skip recompiling sidecars on every start
pnpm install
pnpm dev
```

`pnpm dev` starts the Tauri shell, ServiceHub and its host services, and the Vite
UI on `http://localhost:5173`. It does not build a payload: Sandbox Manager uses
the first payload it finds, in this order:

1. `SUPERCLAW_NATIVE_BACKEND_BIN_DIR`, if set
2. the installed `native-backend.zip` or `native-backend\` beside its own executable
3. `build\Debug\servicehub\native-backend`
4. `build\Release\servicehub\native-backend`
5. `build\native-backend\bin`
6. `%LOCALAPPDATA%\SuperClaw\sandbox_manager\resources\native-backend`

Set environment variables in the same shell before `pnpm dev`, because the
processes inherit them. `SUPERCLAW_NATIVE_BACKEND_BIN_DIR`,
`SUPERCLAW_NATIVE_BACKEND_CONFIG_SOURCE` and `SUPERCLAW_NATIVE_BACKEND_PROFILES_ROOT`
are honored only when Sandbox Manager runs from this source checkout; an installed
build ignores them. `SUPERCLAW_NATIVE_BACKEND_STATE_DIR` moves the backend state
from its default `%LOCALAPPDATA%\SuperClaw\backend`.

The first start can take minutes while ServiceHub's services initialize and the
first UAC prompt provisions the tier accounts.

### Debug `SuperClaw.exe`

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File packaging\installer\build-superclaw.ps1 -Configuration Debug -SkipLocalSync
& .\build\Debug\SuperClaw.exe
```

The unified build creates the payload itself, so no separate
`build-native-backend.ps1` run is needed.

### Backend only, by hand (`start-native-backend.ps1`)

For backend work without the desktop UI. This launch does **not** use the broker:
every process runs as your own user, and the config is seeded with
`bun install`. It is a development aid, not the product's isolation model.

1. Start the model plane. The script needs LRM on `127.0.0.1:18321`; run the app
   (or ServiceHub), or start LRM alone in another window:

   ```powershell
   uv run --directory host\llmrouter_manager python -u -m llmrouter_manager --port 18321
   ```

   Without a reachable model, requests with `model=auto` can wait about 40 s.

2. Make sure port 8787 is free
   (`Get-NetTCPConnection -State Listen -LocalPort 8787`), or pass `-Port`.

3. Launch:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\native-backend\start-native-backend.ps1 `
     -BinDir build\Debug\servicehub\native-backend
   ```

   `-BinDir` points at the payload the unified Debug build writes. Leave it out
   only after a standalone `build-native-backend.ps1` run, which writes to the
   default `build\native-backend\bin`.

   | Parameter | Default | Notes |
   |---|---|---|
   | `-Port` | `8787` | OpenWork Server port. |
   | `-ProductProfileId` | `standard` | `lite`, `standard` or `pro`. |
   | `-Workspace` | `%USERPROFILE%\SuperClawProjects` | Agent workspace. |
   | `-BinDir` | `build\native-backend\bin` | Payload to run. |
   | `-StateDir` | `%LOCALAPPDATA%\SuperClaw\backend-native` | Separate from the product's `backend` state. |
   | `-FreshConfig` | Off | Delete and re-seed the config under `-StateDir`. |
   | `-ConfigureEdge` | Off | Send the edge-server URL and key from `-EdgeEnvFile` to LRM (keys `EDGE_SERVER_URL`/`EDGE_BASE_URL`/`EDGE_URL` and `EDGE_SERVER_KEY`/`EDGE_API_KEY`/`EDGE_KEY`). Goes through ServiceHub, so it needs a running ServiceHub, not standalone LRM. |
   | `-EdgeEnvFile` | `<repo>\.env` | Dotenv file for `-ConfigureEdge`. |

   On success it prints `READY in X.X s`, the process ID and an owner token (OWT),
   and writes them to `<StateDir>\summary.json`. OpenCode listens on port 4096 in
   this mode.

4. Check it:

   ```powershell
   curl.exe -s --noproxy "*" http://127.0.0.1:8787/health
   curl.exe -s --noproxy "*" -H "Authorization: Bearer <owt>" http://127.0.0.1:8787/opencode/app
   ```

5. Optional UI against this backend: keep LRM and the backend running and start
   `pnpm dev:ui`, then open `http://localhost:5173`.

### Iterate on Sandbox Manager or the broker

`pnpm dev` never rebuilds or restarts either one. Run Sandbox Manager from source
with `--reload`, and point it at a locally built broker with
`SUPERCLAW_NATIVE_ISOLATION_BROKER` and `SUPERCLAW_NATIVE_ISOLATION_LAUNCHER`; the
full recipe is in
the inner-loop (`--reload`) section of the [Sandbox Manager README](../../host/sandbox_manager/README.md).
The broker, launcher and tier bootstrap need no signing in any configuration; see
the "Contract" section of the
[broker client README](../../host/sandbox_manager/src/sandbox_manager/broker_client/README.md).

### Inspect a source-run Sandbox Manager

Its status endpoints answer only requests that carry ServiceHub's forwarding
header, derived from `SERVICEHUB_PROCESS_CREDENTIAL`:

```powershell
$env:SANDBOX_MANAGER_DATA_DIR = "$env:TEMP\sbm-native-verify"
$env:SERVICEHUB_PROCESS_CREDENTIAL = [guid]::NewGuid().ToString("N")
uv run --directory host\sandbox_manager python -m sandbox_manager --port 18899
```

In a second shell with the same `SERVICEHUB_PROCESS_CREDENTIAL`:

```powershell
$base = "http://127.0.0.1:18899"
$hmac = [System.Security.Cryptography.HMACSHA256]::new([Text.Encoding]::UTF8.GetBytes($env:SERVICEHUB_PROCESS_CREDENTIAL))
$F = @{ "X-SuperClaw-Forwarded-Credential" = ([BitConverter]::ToString($hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes("superclaw/servicehub-forwarded-request/v1"))) -replace '-', '').ToLower() }
@(
  "/health"
  "/sandbox-manager/v1/system/status"
  "/sandbox-manager/v1/system/preflight"
  "/sandbox-manager/v1/agent/sandbox"
  "/sandbox-manager/v1/agent/sandbox/config"
  "/sandbox-manager/v1/agent/sandbox/diagnostics"
) | ForEach-Object { Invoke-RestMethod "$base$_" -Headers $F -TimeoutSec 20 | ConvertTo-Json -Depth 4 -Compress }
```

`system/preflight` reports the `native_backend_payload` and `owt_cache` checks, and
`agent/sandbox/diagnostics` carries `backend_status` and the `isolation_report`.

## Ports

| Port | Service |
|---|---|
| `8787` | OpenWork Server |
| `18321` | LLMRouter Manager |
| `18791` | Intent classifier, when the Profile runs it |
| `18821` | Sandbox Manager control API (under ServiceHub) |
| `5173` | Vite UI (`pnpm dev`, `pnpm dev:ui`) |
| Chosen per start | OpenCode (`4096` under `start-native-backend.ps1`), `opencode-router` health, HDR sidecar |

## Logs and state

| What | Where |
|---|---|
| Sandbox Manager | `%LOCALAPPDATA%\SuperClaw\sandbox_manager\logs\manager\sbms-*.log` |
| Backend roles | `%LOCALAPPDATA%\SuperClaw\backend\logs\<tier>\` (Supervisor and intent classifier under `bootstrap`, HDR under `file_tool`) |
| Backend config and data | `%LOCALAPPDATA%\SuperClaw\backend\` (`config`, `data`) |
| Staged payload | `%LOCALAPPDATA%\SuperClaw\backend\payload\current\` |
| Hand launch | `%LOCALAPPDATA%\SuperClaw\backend-native\` (`logs\native-backend-<time>.log`, `summary.json`) |

## Stop and reset

```powershell
# A hand-launched backend (its process ID is in summary.json)
$summary = Get-Content "$env:LOCALAPPDATA\SuperClaw\backend-native\summary.json" -Raw | ConvertFrom-Json
Stop-Process -Id $summary.pid -Force

# The whole dev stack
Get-Process SuperClaw, superclaw-services, llama-server, superclaw-trajectory, openwork -EA SilentlyContinue |
  Stop-Process -Force

# A stale ServiceHub lock
Remove-Item "$env:LOCALAPPDATA\SuperClaw\servicehub\servicehub.lock" -Force -EA SilentlyContinue

# Hand-launch state only
Remove-Item "$env:LOCALAPPDATA\SuperClaw\backend-native" -Recurse -Force -EA SilentlyContinue
```

To reset the product's runtime state, including the tier accounts, use
`packaging\installer\clean-superclaw.ps1` (add `-KM` to keep downloaded models). It
revokes the tier accounts through
`host\native_isolation_broker\target\release\native_isolation_broker.exe`, so build
the broker first on a fresh checkout. Repository build output is not touched.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `payload integrity failure ... reason=manifest_missing_or_unsafe` | The payload has no valid manifest. Run a complete build (no `-SkipOpencode`, `-SkipServices` or `-SkipShell`). |
| `partial payload cannot publish a canonical manifest` | A partial build (`-SkipOpencode`, `-SkipServices` or `-SkipShell`) found a member missing. Run one complete build first. |
| `refusing to assign a release payload identity to a dirty worktree` | Add `-DevelopmentPayloadIdentity`, or commit your changes. |
| `pnpm version mismatch` | Install pnpm 10.34.3. |
| `... failed (robocopy exit N); is the app still running?` | Stop SuperClaw or the hand-launched backend and rebuild. |
| `missing openwork.exe ... run build-native-backend.ps1 first` | Build the payload, or pass `-BinDir`. |
| `LRM not reachable on :18321` | Start LRM, ServiceHub or the app first. |
| `port 8787 already has a listener` | Stop the holder or pass `-Port 8788`. |
| `unauthorized` from `/v1/runtime/status` | The server is up; that endpoint needs a bearer token. |
| `error sending request` to `:8787` | The backend did not start. Check `backend\logs\<tier>\` and the latest `sbms-*.log`. |
| `pnpm dev` takes many minutes on every start | Set `OPENWORK_SIDECAR_FORCE_BUILD=0`. |
| Agent or plugins fail to load | Rebuild a complete payload; the packaged dependency tree fails closed before the runtime starts. |
| HDR unreachable or failing | Rebuild a complete payload (it stages `py\hybrid-dr-venv`), restart, and check `backend\logs\file_tool\`. The broker allows a whole HDR run 3600 s (`HYBRID_DR_RUN_BUDGET_S`). |
| Intent classifier missing or channel routing degraded | Rebuild a complete payload (it stages `py\classifier-venv` and `intent-classifier\`) and look for the classifier's `Healthy` line in `backend\logs\bootstrap\`. |
| PDF or OCR tools fail | `py\readers-venv` or `readers\` is missing or broken. Rebuild a complete payload, then check the manifest verification error in `sbms-*.log`. |
| Loopback calls go through a corporate proxy | Make sure `NO_PROXY` includes `127.0.0.1,localhost,::1`, and use `curl.exe --noproxy "*"`. |

## Scripts in this folder

| Script | Purpose |
|---|---|
| `build-native-backend.ps1` | Build the payload, then optionally sync and stage it. |
| `start-native-backend.ps1` | Hand-launch the backend without the broker (development only). |
| `verify_native_payload.py` | Check a payload root against `native-payload-contract.json` for a `--grade` (`minimal`, `full` or `full-hdr`). |
| `payload-verification.ps1` | `Assert-NativeBackendPayload`, the packaging gate used by `build-superclaw.ps1`, the installer build and CI. It runs `verify_native_payload.py --verify-manifest` through `host\sandbox_manager`'s uv environment. |
| `New-NativeBackendArchive.ps1` | Pack a verified payload into `native-backend.zip` plus a `native-backend.json` sidecar for the installer. Each member is a stored zstd frame (`pack_native_backend_archive.py`), so a plain unzip yields frames, not files. The broker stays outside the archive, in `native-isolation\`. |
| `prune_python_payload.py` | Remove files the payload's Python never loads (tests, headers, stubs, unused tools) before signing and the manifest. Import probes in `verify_native_payload.py` catch over-pruning. |
| `payload-signing-policy.ps1` | Payload Authenticode signing. |
| `*-policy.ps1`, `build-step-timing.ps1` | Helpers dot-sourced by the build: toolchains, config staging, manifest, identity, signing and timing. |
| `python_payload_probe.py`, `verify_python_source_parity.py` | Build-time checks for the Python environments. |
| `verify_agent_tools.py` | Installed-app check for agent-installed tools (see above). |
| `summarize-startup-timing.py`, `startup_phases.py` | Per-stage start-up timing from the Sandbox Manager and bootstrap logs. |
| `config-deps/`, `python-payload/` | Locked dependency manifests for `config-source\` and the Python environments. |
| `shell-patches/`, `shell-shims/`, `shell-licenses/` | Inputs for the pinned shell. |

## Related docs

- [Repository README](../../README.md)
- [LLMRouter Manager](../../host/llmrouter_manager/README.md)
- [Sandbox Manager](../../host/sandbox_manager/README.md) and its
  [API](../../host/sandbox_manager/doc/api.md)
- [Native isolation broker](../../host/native_isolation_broker/README.md)

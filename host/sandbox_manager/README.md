# SuperClaw Sandbox Manager

Windows-host control plane for the **native agent sandbox**: it provisions the owner's tier
identities and folder permissions through the isolation broker, starts the backend roles in their
tier accounts (the OpenWork server listens on `127.0.0.1:8787`), and issues the OpenWork token (OWT)
the app uses to talk to it. It is a ServiceHub child with a REST API on `127.0.0.1:18821`.

LLM and model-server work belongs to the LLMRouter Manager; this service never downloads weights or
starts `llama-server`.

- **Ownership:** Sandbox lifecycle. Sandbox Manager is the only lifecycle owner of the native backend
  roles; the broker and launcher in `host/native_isolation_broker` are leaf adapters it drives.
- **Contracts:** `RuntimeDeploymentSpec` → `RuntimeInstanceEvidence` (`native_deployment.py`), the
  isolation report in `RuntimeStatus` (`GET .../agent/sandbox/diagnostics`), and the host API in
  `shared/contracts/src/sandbox-manager-host-api.ts` and `sandbox-manager-channel-messaging.ts`.
  Request/response shapes are in [`doc/api.md`](doc/api.md).
- **Allowed dependencies:** those in `pyproject.toml` (FastAPI/uvicorn, httpx, loguru,
  `cryptography`, pywin32, the generated `contracts` package, `sandbox_policy`,
  `superclaw_host_observability`), and the broker executables through `broker_client/` only. No UI,
  Tauri or LLMRouter internals.
- **Platform:** Windows only; Python ≥ 3.11.
- **Tests:** see [Tests](#tests).

Package internals are described in [`src/sandbox_manager/README.md`](src/sandbox_manager/README.md),
[`broker_client/`](src/sandbox_manager/broker_client/README.md),
[`native_isolation/`](src/sandbox_manager/native_isolation/README.md) and
[`v1_import/`](src/sandbox_manager/v1_import/README.md).

## Architecture

```
ServiceHub
  │  launches the sandbox_manager role of superclaw-services.exe with --host 127.0.0.1 --port 18821
  │  (host/servicehub/service_cfg.json); injects SERVICEHUB_* env; polls GET /sandbox-manager/v1/health
  ▼
sandbox-manager (FastAPI on 127.0.0.1:18821)
  ├─ NativeBackendLifecycle   provisions and supervises the native backend roles
  ├─ OwtCache                 issues / reads the current OpenWork token
  └─ Store (SQLite WAL, sbms.db)   run ledger + config KV
  │
  │  broker_client/: elevated broker for provisioning, unelevated launcher for each role
  ▼
native backend roles, each in its tier account and in a Job held by the owner-side launcher
```

### Authentication boundary

Every route except `GET /sandbox-manager/v1/health` is refused with
`401 servicehub_forwarding_required` unless the request carries exactly one of:

- `X-SuperClaw-Process-Credential`: the `SERVICEHUB_PROCESS_CREDENTIAL` this process was started with
  (ServiceHub's own direct calls), or
- `X-SuperClaw-Forwarded-Credential`: HMAC-SHA256 of that credential over the label
  `superclaw/servicehub-forwarded-request/v1` (requests ServiceHub forwards from the app).

A process started without `SERVICEHUB_PROCESS_CREDENTIAL` refuses every guarded request
(`api/forwarded_auth.py`). Routes that check the process credential itself (`tokens/current`,
`actions`, `tokens`, `shutdown` and everything under `/internal`) answer a forwarded-only request
with `403 process_credential_forbidden`.

Under ServiceHub (`SERVICEHUB_MANAGED=1`) the public lifecycle mutations answer
`409 restricted_lifecycle_required`; ServiceHub uses the `/sandbox-manager/v1/internal/*` routes with
its process credential instead. The app fetches the OWT through ServiceHub's
`GET /app/runtime/sandbox-token`, which calls `GET /sandbox-manager/v1/internal/agent/sandbox/tokens/current`.

### Provisioning

Bring-up is driven by the committed Runtime Deployment
(`PUT /sandbox-manager/v1/capability/runtime-deployment`). The `runtime_deployment.ensure` run verifies
the native payload against its manifest, provisions the owner's tier identities and folder ACLs
through the broker, stages the payload, seeds the selected Product Profile, starts the roles and waits
for health. On startup an already-stored deployment is resumed. Re-posting the provisions endpoint is
the safe retry: an in-flight run is reused.

- **Product Profile.** Profile publication writes only the product-owned `/config/opencode` copied
  from the selected Profile under `sandbox/agent_config/profiles`. A workspace's `.opencode/` and
  `.opencode.jsonc` belong to the agent and user and are never touched. If the installed Profile digest
  is ahead of the stored deployment, the lifecycle waits up to 30 s (polling every 500 ms) for
  ServiceHub to commit a matching deployment, then fails closed.
- **Network egress is not enforced in v2.0.** The WFP plan sent with a provision is the shipped
  permissive one: the broker installs its sublayer as a presence anchor with no filters, and refuses a
  plan that holds filters. The enforcing reference plan can be selected for development with
  `SUPERCLAW_NATIVE_EGRESS_WFP_PLAN=enforcing` (`broker_client/egress_wfp_inputs.py`); it is refused by
  the broker until enforcement lands (#3355). See "Network egress (WFP)" in
  [`host/native_isolation_broker/README.md`](../native_isolation_broker/README.md).
- **Offline file search.** The payload ships pinned ripgrep at `shell/rg.exe` with its licence at
  `shell/licenses/ripgrep.LICENSE`, verified by the payload integrity check. The broker grants the
  file_tool tier read/execute on it and puts `shell` first on OpenCode's `PATH`, so search needs no
  download.
- **Reinstall with kept data.** Recreated tier accounts get new SIDs, so the elevated provision
  rewrites the ACL of every file under `data\file_tool`. Before that elevation, the uv/npm/bun caches
  and the file_tool `TEMP` directory are renamed into `data\.cache-quarantine` and deleted in the
  background afterwards (`broker_client/cache_quarantine.py`). This only happens when tier accounts are
  being recreated; uv runs with `UV_OFFLINE=1`, so lost packages are not refetched until resolved
  online again.
- **Task Python.** `runtime_python.py` prepares the file_tool tier's shared writable venv before the
  runtime starts; product interpreters stay immutable. See "Task Python packages" in
  [`scripts/native-backend/README.md`](../../scripts/native-backend/README.md).

## Run locally

### Prerequisites

- The native backend payload. A source checkout resolves it from
  `build\Debug\servicehub\native-backend` (where `packaging\installer\build-superclaw.ps1` puts it),
  then `build\Release\servicehub\native-backend`, then `build\native-backend\bin`
  (`scripts\native-backend\build-native-backend.ps1`). `SUPERCLAW_NATIVE_BACKEND_BIN_DIR` overrides
  these in a source checkout.
- [`uv`](https://docs.astral.sh/uv/). This package is a member of the `host/` uv workspace, which has
  one lockfile (`host\uv.lock`) and one virtualenv (`host\.venv`). `uv run` from
  `host\sandbox_manager` syncs and uses it.

### Launch

`--port` is required (ServiceHub assigns it; there is no env fallback and no self-allocation). The bind
address is `--host` > `SANDBOX_MANAGER_HOST` > `127.0.0.1`.

```powershell
cd host\sandbox_manager
# Every route but health needs this credential; send the same value as X-SuperClaw-Process-Credential.
$env:SERVICEHUB_PROCESS_CREDENTIAL = [guid]::NewGuid().ToString("N")
uv run python -m sandbox_manager --port 18821
```

The process prints no readiness line; poll `GET /sandbox-manager/v1/health`. If the port is taken,
startup fails rather than picking another. `scripts\run_sandbox_manager.ps1 [-Port 18821]
[-ShowProcessCredential]` wraps the same launch: it kills whatever holds the port, generates a
credential if none is set, writes `.smoke-logs\sandbox-manager.{stdout,stderr}.log`, and stops the
child on `Ctrl+C`. It currently looks for a virtualenv at `host\sandbox_manager\.venv`, which the
shared workspace does not create, so prefer the command above.

### Readiness check

With the manager running (and the same credential in the environment):

```powershell
powershell -ExecutionPolicy Bypass -File host\sandbox_manager\scripts\test_sandbox_manager_readiness.ps1
```

It walks `system/status` → `system/preflight` → `agent/sandbox/provisions` (polling the operation) →
`agent/sandbox` until `phase=running` → `agent/sandbox/tokens/current`, sending
`-ProcessCredential` (default `$env:SERVICEHUB_PROCESS_CREDENTIAL`). Parameters: `-Port` (18821),
`-TimeoutSec` (1200, raise for a cold first run), `-SandboxPhaseSec` (120), `-OwtTimeoutSec` (60).

### Inner loop (`--reload`)

`pnpm dev` never restarts this service, and `build-superclaw.ps1` is a multi-minute packaging build.
For iterating on the native backend:

```powershell
cd host\sandbox_manager
uv run python -m sandbox_manager --port 18821 --host 127.0.0.1 --reload
```

`--reload` turns the process into a supervisor (`dev_reload.py`) that watches
`src\sandbox_manager\**\*.py` and restarts a fresh worker on change (graceful `CTRL_BREAK_EVENT`, then
kill). A frozen build refuses the flag. Each restart re-runs the lifespan, so the worker's shutdown
tears down the manager-owned backend and the next worker re-provisions it. The supervisor clears the
environment after loading config and hands the captured credential to each worker, so set it before
starting. Do not use `uvicorn --reload` here: on Windows its reloader logs "Reloading…" but never
restarts the worker.

To test a locally built broker without a packaging build:

```powershell
cargo build --manifest-path host\native_isolation_broker\Cargo.toml --release
$env:SUPERCLAW_NATIVE_ISOLATION_BROKER   = "$(Resolve-Path host\native_isolation_broker\target\release\native_isolation_broker.exe)"
$env:SUPERCLAW_NATIVE_ISOLATION_LAUNCHER = "$(Resolve-Path host\native_isolation_broker\target\release\native_isolation_launcher.exe)"
```

These overrides, and the other `SUPERCLAW_NATIVE_BACKEND_*` path overrides below, are honoured only by
a non-frozen process running from this exact source checkout; installed builds log and ignore them.
Without an override, a source checkout falls back to the payload, then to that same `target\release\`
path (`broker_client\paths.py`). An installed build resolves the elevated broker only from its install
directory. Nothing checks the broker's or launcher's signature, so no signing step is needed. Both are
run on demand, so a rebuild is picked up without restarting this service.

### Packaged build

The installer bundles this service as the `sandbox_manager` role of
`build\<Configuration>\servicehub\superclaw-services.exe` (`packaging\installer\build-servicehub.ps1`).
A frozen build reads its bundled `data\sandbox.default.json` from `sys._MEIPASS` (`_internal\`).

## Using the API

Set up a second PowerShell window with the same credential:

```powershell
$BASE = "http://127.0.0.1:18821"
$H = @{ "X-SuperClaw-Process-Credential" = $env:SERVICEHUB_PROCESS_CREDENTIAL }
```

**Provision** (idempotent; `409 runtime_deployment_required` without a stored deployment):

```powershell
$run = Invoke-RestMethod -Method Post -Uri "$BASE/sandbox-manager/v1/agent/sandbox/provisions" -Headers $H
# 200 { state: "ready" } when already up; otherwise 202 { operation_id, state }
while ($run.operation_id) {
  $s = Invoke-RestMethod -Uri "$BASE/sandbox-manager/v1/operations/$($run.operation_id)" -Headers $H
  Write-Host "$($s.state) - $($s.pct)% - $($s.message)"
  if ($s.state -in 'done','error','cancelled') { break }
  Start-Sleep 2
}
```

`POST /sandbox-manager/v1/system/provisions` wraps the same flow and returns
`{ sandbox: { state, operation_id } }`.

**Status:** `GET .../system/status` (boot/reconnect snapshot; if it reports
`flows.sandbox.active_operation_id`, poll that instead of re-provisioning), `GET .../system/preflight`
(payload and OWT checks), `GET .../agent/sandbox` (`phase`).

**Token:** after `phase` is `running`, `GET .../agent/sandbox/tokens/current` returns
`{ token, scope, created_at }`. `503 sandbox_not_ready` means wait `retry_after_seconds`;
`404 owt_unavailable` means reissue with `POST .../agent/sandbox/tokens` (which restarts the backend).

**Control:** `POST .../agent/sandbox/actions` with `{"action": "start"|"stop"|"restart"|"reset"}`.
`reset` is destructive: it stops the roles and deletes the backend's `config\` and `data\`.

| Mode | Request | Result for `tokens/current`, `actions`, `tokens` |
|---|---|---|
| Any | no valid credential header | `401 servicehub_forwarding_required` |
| Any | forwarded credential only | `403 process_credential_forbidden` |
| Managed (ServiceHub) | process credential | `409 restricted_lifecycle_required` |
| Standalone | process credential | `200` |

**Cancel:** `POST .../operations/<operation_id>/cancellations` (managed instances answer `409`;
ServiceHub uses `/sandbox-manager/v1/internal/operations/<id>/cancellations`).

**Logs and diagnostics:** `GET .../agent/sandbox/logs?source=install&tail=200` (`source` is
`install` or `container`; `tail` ≤ 1000) and `GET .../agent/sandbox/diagnostics` (backend status,
recent operations, isolation report). An operation's `last_error_message` usually names the first
failure.

### Channel credentials, messaging and Slack senders

The router's control token is held only by this process (and the router's own `channel` tier);
openwork-server runs in the `file_tool` tier with the router's scoped token only. So the app saves and
uses channel credentials through these routes (`api/v1/channel_secrets.py`, `channel_credentials.py`).
Every route fails closed when no router is attached, and audits by name only.

| Route | What it does |
|---|---|
| `PUT .../channels/{slack,telegram}/identities/{id}`, `DELETE .../channels/{channel}/identities/{id}` | Save or delete a channel token |
| `PUT .../channels/slack/identities/{id}/enabled` | Switch one saved Slack bot off or on (on re-checks its tokens with Slack); audit `channel.identity_enabled_changed` |
| `PUT .../channels/{channel}/enabled` | Channel-wide switch |
| `POST .../channels/{channel}/send` | The operator's own send (never held for approval) |
| `PUT .../channels/{channel}/bindings` | Bind or unbind a conversation to a directory |
| `GET .../channels/slack/senders` | Who the Slack bot answers: `{ allowed, pending }` |
| `PUT .../channels/slack/senders/{user_id}` | Approve (`{"allowed": true}`) or remove a member; audit `channel.sender_changed` (decision only) |
| `POST .../channels/slack/install` | Create SuperClaw's Slack app from its manifest with the user's app configuration token and listen on a loopback port for the install redirect; audit `channel.slack_install_started` |
| `GET` / `DELETE .../channels/slack/install` | Install state; cancel (deletes the created app) |
| `POST .../channels/slack/install/complete` | Enable Socket Mode and events (`apps.manifest.update`; `slack_app_not_finished` if Slack refuses), save the bot token with the pasted app-level token, then delete the identity's previous app |

`slack_install.py` is the one place this service calls slack.com directly (`apps.manifest.create`,
`oauth.v2.access`, `apps.manifest.update`, `apps.manifest.delete`) using `httpx`'s proxy handling
(`HTTPS_PROXY` and the Windows manual proxy; PAC scripts are not followed). The configuration token,
client secret and bot token stay in memory for one install and are never logged or written. Because
Slack returns a client secret only at creation, a reconnect creates a new app and deletes the old one
after answering. App ids (not secrets) are kept in `sbms.db` under
`channels.slack.manifest_app_id.<identity>` and `channels.slack.leftover_app_ids.<identity>` so a
failed delete is retried on the next connect.

## API reference

All paths are under `/sandbox-manager/v1` unless noted. Full shapes: [`doc/api.md`](doc/api.md).

| Group | Endpoints |
|---|---|
| Meta (root, guarded) | `GET /health` · `GET /version` |
| ServiceHub | `GET /health` (open) · `GET /version` · `GET /status` · `GET /readiness` · `POST /shutdown` |
| Capability | `POST /capability/runtime-infrastructure/preparations` · `PUT`/`GET`/`DELETE /capability/runtime-deployment` · `GET /capability/runtime-instance` · `GET /capability/runtime-profile` |
| System | `GET /system/status` · `GET /system/preflight` · `POST /system/provisions` |
| Sandbox | `GET /agent/sandbox` · `GET …/config` · `POST …/provisions` · `POST …/actions` · `GET …/tokens/current` · `POST …/tokens` · `GET …/logs` · `GET …/diagnostics` |
| Operations | `GET /operations/{id}` · `POST /operations/{id}/cancellations` |
| Egress approvals | `GET /egress/approvals` · `POST /egress/approvals/{id}/decision` · `GET`/`PUT /egress/chat-grants/{root_session_id}` |
| Secrets | `GET`/`PUT`/`DELETE /secrets/tavily-api-key` |
| Channels | see the table above |
| Optional packages | `GET /optional-packages/{id}` · `POST /optional-packages/{id}/install` (LibreOffice for the Office preview via `winget`, after the user agrees; `libreoffice_install.py`) |
| Workspace cleanup | `GET`/`POST /workspace/cleanup/settings` · `POST …/run-now` · `POST …/preview` · `GET …/status` · `GET …/policy` |
| Components (stub) | `GET /components` · `GET /components/{name}` return a static catalog; `POST …/actions` and `GET …/logs` return `501` |
| Internal (process credential) | `POST /internal/agent/sandbox/provisions` · `GET /internal/agent/sandbox/tokens/current` · `POST /internal/operations/{id}/cancellations` · `POST`/`PUT`/`DELETE /internal/capability/…` · `POST /internal/workspace/cleanup/{settings,run-now}` |

## Logs and on-disk layout

`<DATA_DIR>` defaults to `%LOCALAPPDATA%\SuperClaw\sandbox_manager`:

```
sandbox_manager\
├── sbms.db                         SQLite: run ledger, config KV
├── sandbox.json                    optional user override (see Configuration)
├── resources\                      bundled tools (e.g. superclaw-trajectory.exe)
├── secrets\tavily-api-key.bin      sealed with the owner's DPAPI scope; no tier account is granted it
└── logs\
    ├── manager\sbms-<YYYYMMDDTHHMMSS>.log    this service (10 MB × 5 rotations)
    ├── manager\control-audit.jsonl           user decisions via the control plane (ids and outcomes only)
    └── sandbox\install\install-attempt-<YYYYMMDDTHHMMSS>.log   OWT issuance lines
```

Each start deletes earlier starts' `sbms-*` and `install-attempt-*` files, keeping the newest 10 starts
and any start from the last 3 days, so collect logs before retrying a failing install.
`SANDBOX_MANAGER_LOG_DIR` relocates `logs\`.

The native backend keeps its own state under `%LOCALAPPDATA%\SuperClaw\backend\`
(`SUPERCLAW_NATIVE_BACKEND_STATE_DIR`): `config\`, `data\`, `payload\current\`, `tmp\`, per-tier role
logs under `logs\<tier>\<launch-id>.log`, and the one-time SuperClaw 1.x import ledger under
`migrations\`.

```powershell
# Latest sandbox-manager log
Get-Content (Get-ChildItem "$env:LOCALAPPDATA\SuperClaw\sandbox_manager\logs\manager\sbms-*.log" |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName -Tail 80
# Newest role logs
Get-ChildItem "$env:LOCALAPPDATA\SuperClaw\backend\logs" -Recurse -File |
  Sort-Object LastWriteTime -Descending | Select-Object -First 20 FullName, LastWriteTime
```

## Configuration

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `SERVICEHUB_PROCESS_CREDENTIAL` | _unset_ | Shared secret for the auth boundary above. Set per spawn by ServiceHub; set it yourself standalone. Removed from the environment after load. |
| `SERVICEHUB_MANAGED` | _unset_ | `1` under ServiceHub: public lifecycle mutations answer `409`, and a missing credential fails startup. |
| `SERVICEHUB_SERVICE_NAME` / `SERVICEHUB_INSTANCE_ID` | `sandbox_manager` / `dev-instance` | Echoed by `GET /sandbox-manager/v1/{health,version}`. |
| `SANDBOX_MANAGER_HOST` | `127.0.0.1` | Bind address; `--host` overrides it. Keep it loopback. |
| `SANDBOX_MANAGER_DATA_DIR` | `%LOCALAPPDATA%\SuperClaw\sandbox_manager` | DB, resources, secrets, logs root. |
| `SANDBOX_MANAGER_LOG_DIR` | `<DATA_DIR>\logs` | Log root. |
| `SANDBOX_CONFIG` | _unset_ | Path to a JSON file overriding `data/sandbox.default.json`. |
| `HF_ENDPOINT` | `https://huggingface.co` | Re-exported for child processes; this service downloads no models. |
| `WINDOWS_SUPERCLAW_PATH` | `%USERPROFILE%\SuperClawProjects` | Workspace root. |
| `SUPERCLAW_NATIVE_BACKEND_STATE_DIR` | `%LOCALAPPDATA%\SuperClaw\backend` | Native backend root. |
| `SUPERCLAW_NATIVE_BOOTSTRAP_TIER` | `1` | `0` skips tier identity provisioning (and its UAC prompt) on a machine already provisioned. Roles still start in tier accounts. |
| `SUPERCLAW_NATIVE_BACKEND_BIN_DIR` | _unset_ | Source checkout only: directory with `openwork.exe` to use instead of the payload. |
| `SUPERCLAW_NATIVE_BACKEND_PROFILES_ROOT` / `SUPERCLAW_NATIVE_BACKEND_CONFIG_SOURCE` | _unset_ | Source checkout only: Product Profile root / offline OpenCode dependency tree. |
| `SUPERCLAW_NATIVE_ISOLATION_BROKER` / `SUPERCLAW_NATIVE_ISOLATION_LAUNCHER` | _unset_ | Source checkout only: broker / launcher executable; ignored if the file is missing. |
| `SUPERCLAW_NATIVE_EGRESS_PROXY_MODE` | `log_only` | Development only: `enforce` seals the egress proxy in enforce mode. Not a shipped setting. |
| `SUPERCLAW_NATIVE_EGRESS_WFP_PLAN` | permissive | Development only: `enforcing` builds the enforcing WFP reference plan (refused by the broker today). |
| `SUPERCLAW_BACKEND_MODE` | _retired_ | Selected the removed WSL/Docker backend; ignored, and named once in the log if set. |

### `sandbox.json`

Sandbox settings come from one JSON document, first found of: `SANDBOX_CONFIG`,
`<DATA_DIR>\sandbox.json`, the bundled `data/sandbox.default.json`:

```json
{ "sandbox_port": 8787, "workspace_container_path": "/workspace" }
```

| Key | Meaning |
|---|---|
| `sandbox_port` | The native OpenWork server's loopback port |
| `workspace_container_path` | Runtime-side workspace path reported by `GET .../agent/sandbox/config` (default `/workspace`) |

Unknown keys are ignored, so an older override file still loads.

## Tests

From `host\sandbox_manager` (default addopts exclude the `integration`, `windows_only` and `gpu`
markers):

```powershell
uv run pytest                                                   # full unit suite
uv run pytest tests/unit/test_api_sandbox_provisions.py -k "standalone or managed_public or owt"
uv run pytest tests/unit/test_runtime_python.py tests/unit/test_native_backend.py
uv run pytest tests/unit/test_api_channel_secrets.py tests/unit/test_api_channel_messaging.py `
  tests/unit/test_api_slack_senders.py tests/unit/test_api_slack_install.py tests/unit/test_slack_install.py
uv run pytest -m windows_only tests/unit                         # real Windows primitives, run by hand
```

## File-size exceptions

`src/sandbox_manager/native_backend.py` (about 2,640 lines) is above the repository's 1,500-line
guideline. It owns payload trust, deployment convergence, process supervision and Profile selection as
one lifecycle; new responsibilities go into leaf modules it calls (for example `runtime_python.py`,
`runtime_global_config.py`, `native_egress_wiring.py`, `v1_import/`). `egress_proxy.py` (about 830
lines) has one responsibility, the proxy's request path.

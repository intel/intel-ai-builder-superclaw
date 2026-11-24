# ServiceHub

The Windows-host process supervisor and control-plane gateway. ServiceHub starts the child services
declared in [`service_cfg.json`](service_cfg.json), health-gates boot on the required ones, restarts
them on failure, reverse-proxies `/<proxy_prefix>/*` to them, and owns the `/app/*` control-plane
API: aggregate status, readiness, fan-out operations, events, the Product Profile, and Model Binding
activation.

- **Contracts:** the `service_cfg.json` process-lifecycle contract
  ([`service_cfg.schema.json`](service_cfg.schema.json)), the `/app/*` HTTP API, and the generated
  `contracts` package (`shared/contracts`) for Profile and Bundle types.
- **Allowed dependencies:** FastAPI/uvicorn/httpx, `superclaw-contracts`,
  `superclaw-host-observability`, and the `llmrouter-manager` and `llm-pipeline` workspace packages
  only for two read-only key readers (`llmrouter_manager.common.inference_key`,
  `protection_service.data_plane_key`). Everything else goes over HTTP to the child.
- **Not a plugin system.** Services ship with the app. To add one, follow
  [`ADDING_A_SERVICE.md`](ADDING_A_SERVICE.md).

## Run and test

```powershell
cd host/servicehub
uv run pytest -q                                   # full suite
uv run python -m servicehub --port 19000 --hub-token test123 --no-spawn   # hub only, no children
```

To run the hub with its children, use `scripts/start_servicehub.ps1` (see [`../README.md`](../README.md)).

| Flag | Env fallback | Default |
|---|---|---|
| `--port` | `SERVICEHUB_PORT` | `0` (dynamic). A requested port is used exactly or startup fails. |
| `--hub-token` | `SERVICEHUB_TOKEN` | random 32-byte token |
| `--data-dir` | `SERVICEHUB_DATA_DIR` | `%LOCALAPPDATA%\SuperClaw\servicehub` |
| `--service-cfg` | `SERVICEHUB_CFG`, `SERVICEHUB_SERVICE_CFG` | `service_cfg.json` next to the package (frozen: next to the exe) |
| `--no-spawn` | — | spawn children |

| Env var | Effect |
|---|---|
| `CAPABILITY_GATING_V1` | `1`/`true` mounts `GET /app/capability-profile` and reconciles the active Profile at startup. |
| `SUPERCLAW_BOOT_SPAWN_CONCURRENCY` | `1` disables the early SandboxManager spawn (strictly serial boot). |
| `SUPERCLAW_ORPHAN_MARKERS` | Extra install-path markers for reaping orphaned SuperClaw children on fixed ports. |
| `SUPERCLAW_BOOT_ID` | Boot correlation id stamped on log lines. |

`SERVICEHUB_READY {"port","token"}` is printed to stdout only after uvicorn has started and, unless
`--no-spawn`, every required child has passed `GET /<proxy_prefix>/v1/health` with the
ServiceHub-injected `SERVICEHUB_INSTANCE_ID`. Children do not print READY lines.

## Child lifecycle contract

A child must:

1. Run as `python -m <entrypoint> --host ... --port ...`.
2. Serve unauthenticated `GET /<prefix>/v1/health` and graceful
   `POST /<prefix>/v1/shutdown` (process credential required).
3. Have one `service_cfg.json` entry. `startup: "required"` (the default) gates App boot;
   `startup: "on_demand"` stays dormant until the first authenticated business request.

ServiceHub injects `SERVICEHUB_SERVICE_NAME`, `SERVICEHUB_INSTANCE_ID`, `SERVICEHUB_CFG_PATH`,
`SERVICEHUB_MANAGED=1` and a fresh `SERVICEHUB_PROCESS_CREDENTIAL` into every spawn. Source runs use
`python -m <entrypoint>`; packaged builds re-execute `superclaw-services.exe --service <name>`
(`launch.kind = "role"`). The Release installer places `build\Release\servicehub` under
`APPDIR\servicehub`.

On-demand startup is idempotent: concurrent first requests share one attempt, and it uses the same
fixed-port check, readiness, watchdog, restart and shutdown paths as required services. Health and
version requests never start a dormant service (they return `service_dormant`). ServiceHub does
not stop an idle on-demand child; the child releases its own models.

The App discovers optional services with `GET /app/services/catalog` and calls them through the
ServiceHub URL plus `proxy_prefix`, never on the child's fixed port.

## API

All routes need `Authorization: Bearer <hub token>` except `/health`, `/version`, and
`/<prefix>/v1/health|version` probes.

| Route | Purpose |
|---|---|
| `GET /health`, `GET /version` | Hub liveness and version. |
| `GET /app/services/catalog`, `/health`, `/status` | Declared services, child health, aggregate status. |
| `GET /app/readiness` | I/O-free readiness snapshot (see below). |
| `GET /app/system/preflight` | Aggregate preflight. |
| `GET /llm-router/v1/system/preflight` | Hub-owned LRM preflight gate. |
| `POST /app/system/provisions` | Fan out `POST /v1/system/provisions` to running children except SandboxManager; a child `404` is recorded as skipped. Returns a `hub:provisions_*` operation. |
| `POST /app/system/restart` | Restart every child. Returns a `hub:restart_*` operation. |
| `POST /app/system/shutdown` | Two-phase child shutdown, then the hub exits. Returns a `hub:shutdown_*` operation. |
| `GET /app/operations/{id}`, `POST /app/operations/{id}/cancellations` | Read or cancel an operation (hub operations are in-memory). |
| `GET /app/events[?since=<cursor>]` | SSE stream of hub operation progress, with best-effort replay from an in-memory ring buffer. Payloads carry only `operation_id`, `state`, `pct`, `message`. |
| `POST /app/events/tickets` | Single-use 15 s ticket for `EventSource` clients that cannot send headers (`/app/events?ticket=`). Hub tokens are never accepted in query strings. |
| `GET /app/capability-profile` | Active Product Profile (only when `CAPABILITY_GATING_V1`). |
| `POST /app/model-binding/activations`, `POST .../{id}/resume`, `GET .../active` | Model Binding activation. |
| `GET /app/runtime/sandbox-token` | → SandboxManager `GET /v1/internal/agent/sandbox/tokens/current` |
| `POST /app/runtime/converge` | → SandboxManager `POST /v1/internal/agent/sandbox/provisions` |
| `POST /app/workspace/cleanup/run-now`, `/settings` | → SandboxManager `POST /v1/internal/workspace/cleanup/run-now`, `/settings` |
| `/<proxy_prefix>/*` | Reverse proxy to the child (10 MiB body limit). |

The `/sandbox-manager/v1/internal/*` and `/data-protection/v1/internal/*` namespaces are private
child contracts: the proxy answers `404` for them, and only ServiceHub's own fixed adapters call
them with the process credential.

## Credentials

- **Process credential.** Generated per spawn, passed by environment only, rotated on restart, and
  never exposed in health, version, catalog, status, argv or logs. ServiceHub sends it in
  `X-SuperClaw-Process-Credential` for `/v1/shutdown` and its internal calls.
- **Proxy.** The proxy strips any client-supplied `Authorization`, process-credential and
  forwarded-credential headers. It adds an HMAC of the child's credential (the forwarded-credential
  header) to every forwarded request, and the raw credential only for management paths
  (`is_management_path` in [`proxy/forwarder.py`](src/servicehub/proxy/forwarder.py)):
  LRM `/v1/cloud|capability|edge|telemetry|oauth/`, writes under LRM's mutation-gated prefixes and
  `/v1/data-protection/` (except open `GET`s), every ASR/TTS `/v1/` route except health, version
  and shutdown, and Privacy Manager `/v1/models/` plus writes to `/v1/file/local-read/grant`. The
  LRM lists mirror `llmrouter_manager.common.management_auth`.
- **Inference and data-plane keys.** After LRM and Privacy Manager are ready, ServiceHub fetches
  `/<prefix>/v1/internal/inference-key` and `/data-protection/v1/internal/data-plane-key` and keeps
  them in memory. Dependents of LRM get `LRM_API_KEY` (SandboxManager gets
  `SERVICEHUB_MANAGED_LRM_API_KEY` instead, and never the host key `LRM_HOST_API_KEY`). SandboxManager
  gets the privacy key as `SERVICEHUB_MANAGED_PRIVACY_API_KEY`; inherited values of these variables,
  `DATA_PROTECTION_API_KEY` and `PRIVACY_API_KEY` are discarded. A provider restart must return the
  same key, or readiness fails closed.
- **Early SandboxManager spawn.** On a warm start ServiceHub reads both keys from the records the
  providers persist ([`supervisor/persisted_credentials.py`](src/servicehub/supervisor/persisted_credentials.py))
  and starts SandboxManager (`EARLY_SPAWN_SERVICES`) without waiting for its dependencies. A missing
  or unreadable record keeps the declared order. When each provider becomes ready, its handoff is
  compared with the record; a mismatch fails boot and tears down the early SandboxManager.

## Single instance and recovery

- A hardened named mutex (`hardened_mutex.py`: owner-only DACL, medium integrity label) makes the
  hub single-instance. A pre-existing mutex with any other owner, DACL or label fails startup at the
  `singleton` stage. The one accepted exception is the default-security mutex of a pre-hardening hub
  still running after an upgrade (current-user owner; DACL of only the user, SYSTEM and the logon
  SID; no label), which a Low-integrity squatter cannot reproduce.
- The primary hub writes `servicehub.lock` (port, token, pid) in the data dir with an owner-only DACL
  (`owner_only_acl.py`); a volume without ACLs is refused. A second launch prints
  `REUSE {"pid","port","token"}` and exits, so the desktop app (with `keepBackendOnExit=true`)
  reattaches instead of colliding on child ports.
- If the mutex is held but the lockfile is missing, the desktop verifies the stale process's image
  path (`superclaw-services.exe`, or the older `servicehub.exe`) or its `-m servicehub` command line,
  kills that tree and retries. An unverifiable process is never killed.
- During shutdown every child is marked stopping and restarts are disabled before any child is
  terminated. At startup an orphaned child holding a fixed port is reaped only if its executable or
  command line matches the configured `launch.exe_name`/entrypoint and a SuperClaw ownership marker;
  unrelated listeners produce a startup error.

## Readiness

`GET /app/readiness` never does I/O. `RuntimeEvidenceRefresher` reads SandboxManager's public
`/v1/readiness` with an 8 s ceiling every 5 s, or every 1 s for up to 120 s while a new
SandboxManager instance's Runtime is still starting. ServiceHub stamps each projection on its own
monotonic clock and expires it after 20 s (`EVIDENCE_TTL_S`). The snapshot is bounded-age UI
evidence, not a security check; the native-sandbox probe budgets behind `/v1/readiness` are
documented in [`../sandbox_manager/README.md`](../sandbox_manager/README.md).

## Logs

| File (under `<data_dir>/logs/`) | Content |
|---|---|
| `servicehub-<UTC timestamp>.log` | One launch's hub lifecycle and control-plane audit log. Absolute paths only at debug level or on failure. |
| `<service>-stdout-*.log`, `<service>-stderr-*.log` | Raw child output, the latest 5 per stream. **Not redacted**: may contain prompts, paths and user content. |

The `SERVICEHUB_READY` and `REUSE` lines carry the hub token. They go to stdout only, never to
`servicehub-*.log`; the desktop stores them redacted.

## File-size exceptions

- `model_binding_activation/coordinator.py` is above the 1500-line maximum. It delegates the
  `disconnect` intent to `model_binding_activation/disconnect.py`; splitting the coordinator is
  out of scope.
- `supervisor/process_manager.py` (about 2100 lines) holds the early SandboxManager spawn: the
  allow-list, the key pre-read, the record-versus-handoff check and dependents-first shutdown. The
  record reads live in `supervisor/persisted_credentials.py`; splitting the process manager is out
  of scope.

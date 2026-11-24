# Sandbox Manager API Reference

**Base URL:** `http://127.0.0.1:<port>` — loopback only. ServiceHub assigns `<port>` (default `18821`) via the required `--port` flag; the service never self-allocates a port.

**Authentication:** Generic routes remain tokenless for standalone development,
except `GET .../agent/sandbox/tokens/current`, `POST .../agent/sandbox/actions`
and `POST .../agent/sandbox/tokens`, which require `X-SuperClaw-Process-Credential` matching `SERVICEHUB_PROCESS_CREDENTIAL`.
The historical v1.2 managed lifecycle contract
uses `/sandbox-manager/v1/internal/*` lifecycle routes authenticated with a
restricted per-spawn ServiceHub credential. Those routes are unreachable through
generic proxying. Public privileged operations return `409
restricted_lifecycle_required` in managed mode. This reference otherwise
documents the standalone API.

Product callers use bearer-protected ServiceHub-owned `/app/*` endpoints rather
than internal child routes. In particular, use `GET
/app/runtime/sandbox-token`; ServiceHub maps it to `GET
/sandbox-manager/v1/internal/agent/sandbox/tokens/current` with the current child
process credential.

**Scope:** This service manages the **Windows-native sandbox backend** only. LLM / model-server status and provisioning live in the LLMRouter Manager (LRM), not here.

---

## Standalone Development Startup Workflow

The standalone development harness follows this sequence. It is not the v1.2
installed managed-product startup path.

```
App start
│
├─► GET /sandbox-manager/v1/system/status        ← reconnect / boot snapshot
│     │
│     ├─ sandbox.phase==running
│     │     → skip provisioning, go to
│     │       GET /sandbox-manager/v1/agent/sandbox/tokens/current
│     │
│     └─ flows.sandbox.active_operation_id present
│           → resume polling that operation_id (skip the POST below)
│
├─► GET /sandbox-manager/v1/system/preflight     ← optional: is the native payload present?
│
├─► POST /sandbox-manager/v1/agent/sandbox/provisions
│       ├─ 409 runtime_deployment_required       → store a Runtime Deployment first
│       ├─ 200 { state: "ready" }                → done
│       └─ 202 { operation_id, state }
│            └─ poll GET /sandbox-manager/v1/operations/{operation_id}  every 1-2s
│                  kind=runtime_deployment.ensure
│                  on error: re-POST provisions to retry
│
└─► (after sandbox operation state=done AND
      GET /sandbox-manager/v1/agent/sandbox phase=running)
      GET /sandbox-manager/v1/agent/sandbox/tokens/current   ← fetch OWT token
        on 503 sandbox_not_ready
            → wait error.retry_after_seconds, retry
```

---

## Response Conventions

**Reads (`GET`):** Return the resource directly. No wrapper.

**Synchronous mutations:** Return `{ success: true, ... }`.

**Async workflows:** Return `{ operation_id, state }` with `202 Accepted` when work is queued/running, or `{ state: "ready" }` with `200 OK` when already satisfied. `operation_id` is omitted (never `null`) when no work was started.

**Operation ids:** Every `operation_id` this service emits carries the `sm:` transport prefix (e.g. `sm:run_<hex16>`). ServiceHub routes `/app/operations/{operation_id}` to the owning service by this prefix (`sm:` → `/sandbox-manager`) and rejects un-prefixed ids, so callers can poll a returned id through the Hub unchanged. Inbound ids on `GET/POST /sandbox-manager/v1/operations/{operation_id}` are accepted with or without the prefix (the `sm:` is stripped back to the bare DB `run_id` before lookup).

**Operation rows:**
```json
{
  "operation_id": "sm:run_<hex16>",
  "kind": "<string>",
  "state": "pending | running | done | error | cancelled",
  "pct": 0.0,
  "message": "<string>",
  "last_error_message": "<string>",
  "started_at": "<ISO8601>",
  "finished_at": "<ISO8601>",
  "metadata": {},
  "children": [ /* same shape, one level deep, no nested children */ ]
}
```
When a child row includes `metadata.weight`, the weight is stored as an integer budget value, not a normalized fraction.

**Error envelope (all `/sandbox-manager/v1/*` errors):**
```json
{
  "error": {
    "code": "machine_readable_code",
    "message": "Human-readable description.",
    "details": {},
    "retry_after_seconds": 5
  }
}
```
`details` and `retry_after_seconds` are optional.

**Common HTTP status codes:** `400` invalid request, `404` not found, `409` state conflict, `503` dependency not ready.

---

## State Enums

| Enum | Values | Used by |
|------|--------|---------|
| `operation_state` | `pending`, `running`, `done`, `error`, `cancelled` | All operation rows, `flows.*.state`, async response `{ state }` from provisions/action endpoints. `"ready"` in a synchronous `200` body is a synonym for `done`, used only in sync responses. |
| `sandbox_phase` | `starting`, `installing`, `running`, `missing`, `error`, `stopped` | `GET /sandbox-manager/v1/agent/sandbox.phase`, `GET /sandbox-manager/v1/system/status.sandbox.phase` |
| `check_severity` | `error`, `warning`, `info` | `GET /sandbox-manager/v1/system/preflight.checks[].severity` |

---

## Operation Kinds

Only sandbox-related kinds are produced by this service.

| Kind | Description |
|------|-------------|
| `runtime_infrastructure.prepare` | Target-independent Runtime preparation |
| `runtime_deployment.ensure` | Native backend bring-up for the committed Runtime Deployment |
| `sandbox.control` | Sandbox start/stop/restart/reset actions |

---

## Endpoints

### Meta

#### `GET /health`
Liveness check with a small sandbox snapshot. Does not expose typed lifecycle state. Distinct from the ServiceHub readiness probe `GET /sandbox-manager/v1/health` below.

**Response `200`:**
```json
{
  "status": "ok",
  "version": "<string>",
  "model_servers": [],
  "sandbox": {
    "port": 8787,
    "pid": 99
  }
}
```
`model_servers` is always an empty array in sandbox-manager (inference lives in the LLMRouter Manager). `pid` is the native backend Supervisor's process id and is omitted when the backend is not running.

---

#### `GET /version`
Returns the sandbox-manager version string.

**Response `200`:**
```json
{ "version": "<string>" }
```

---

### ServiceHub

Endpoints that implement the current generic ServiceHub sub-service contract are
tokenless and bound to loopback. The future restricted internal lifecycle
namespace is excluded from this statement.

#### `GET /sandbox-manager/v1/health`
ServiceHub readiness probe, polled after the Hub spawns `python -m sandbox_manager --port <port>`. Unlike the root `GET /health` liveness dump, this returns the contract readiness shape and echoes the ServiceHub-injected identity so the Hub can reject a stale process squatting on the fixed port.

**Response `200`:**
```json
{
  "service": "sandbox_manager",
  "status": "ok",
  "pid": 12345,
  "instance_id": "<SERVICEHUB_INSTANCE_ID>"
}
```
`service` / `instance_id` are read from `SERVICEHUB_SERVICE_NAME` / `SERVICEHUB_INSTANCE_ID`, falling back to tolerant dev defaults (`sandbox_manager` / `dev-instance`) when the Hub env is absent.

---

#### `GET /sandbox-manager/v1/version`
Reports the running sub-service build. Uses the same version resolver as `GET /sandbox-manager/v1/system/status`, so a frozen installer build reports the full product version (`x.y.z.<Mdd>`, e.g. `1.0.0.701`) from the `VERSION` file rather than the static `__version__` base. Whitelisted on the Hub auth edge (`*/v1/version`), so it is reachable without a token.

**Response `200`:**
```json
{
  "service": "sandbox_manager",
  "version": "<string>",
  "instance_id": "<SERVICEHUB_INSTANCE_ID>"
}
```

---

#### `POST /sandbox-manager/v1/shutdown`
Graceful drain + exit, called by ServiceHub before stopping the service. Signals uvicorn to stop accepting new connections, lets in-flight requests (including this one) finish, then runs lifespan shutdown — native backend teardown + store close.

**Response `200`:**
```json
{ "state": "stopping" }
```

---

### Operations

#### `GET /sandbox-manager/v1/operations/{operation_id}`
Poll an async operation.

**Response `200`:** Operation row (see conventions above). `children` contains per-step progress one level deep.

**Errors:** `404` `operation_not_found`

---

#### `POST /sandbox-manager/v1/operations/{operation_id}/cancellations`
Request cooperative cancellation of a running operation. Propagates to all children; already-`done` children retain `state=done`.

**Response `200`:**
```json
{ "success": true, "operation_id": "<string>" }
```

**Errors:** `404` `operation_not_found`, `409` `operation_not_cancellable`, `409` `restricted_lifecycle_required` (managed mode; ServiceHub cancels through `POST /sandbox-manager/v1/internal/operations/{operation_id}/cancellations` with its process credential)

---

### Sandbox

#### `GET /sandbox-manager/v1/agent/sandbox`
Get the current sandbox phase. Use this to gate calls to `/tokens/current`.

**Response `200`:**
```json
{ "phase": "missing | installing | stopped | starting | running | error", "message": "<string>" }
```
`message` accompanies `missing`, `error` and some `starting` and `stopped` phases.

---

#### `GET /sandbox-manager/v1/agent/sandbox/config`
Static sandbox configuration, safe to cache.

**Response `200`:**
```json
{ "workspace_container_path": "/workspace" }
```

---

#### `POST /sandbox-manager/v1/agent/sandbox/provisions`
Idempotent bring-up of the native backend for the committed Runtime Deployment: verify and stage the native payload, provision the owner's tier identities, seed the selected Product Profile, start the roles and wait for health.

**Response `200`** (already ready):
```json
{ "state": "ready" }
```

**Response `202`** (work started):
```json
{ "operation_id": "<string>", "state": "running" }
```
The operation is a `runtime_deployment.ensure` run. A concurrent call while it is in flight returns the same `operation_id`.

**Errors:** `409` `runtime_deployment_required` (no Runtime Deployment is stored), `409` `runtime_deployment_invalid`

---

#### `POST /sandbox-manager/v1/agent/sandbox/actions`
Control the native backend.

**Request body:**
```json
{ "action": "start | stop | restart | reset" }
```
- `start` — resumes the committed Runtime Deployment and brings the roles up
- `stop` — stops every role
- `restart` — stops the roles and brings them back up, which re-issues the OWT
- `reset` — stops the roles and deletes the backend state's `config\` and `data\` directories (destructive)

**Auth:** Standalone requires header `X-SuperClaw-Process-Credential` matching
`SERVICEHUB_PROCESS_CREDENTIAL`; otherwise `403 process_credential_forbidden`
(also when no credential is configured). Managed mode: `409 restricted_lifecycle_required`.

**Response `200`:**
```json
{ "operation_id": "<string>", "state": "running" }
```

---

#### `GET /sandbox-manager/v1/agent/sandbox/tokens/current`
Get the cached OWT token in standalone development. Only call after `GET /sandbox-manager/v1/agent/sandbox` returns `phase: "running"`.

In managed mode this public endpoint returns `409
restricted_lifecycle_required` before accessing the token. Product clients must
call ServiceHub's `GET /app/runtime/sandbox-token` endpoint instead; the
process-authenticated internal child endpoint is reserved for ServiceHub.

**Auth:** Same as `POST /sandbox-manager/v1/agent/sandbox/actions`.

**Response `200`:**
```json
{ "token": "<string>", "scope": "<string>", "created_at": "<ISO8601>" }
```

**Errors:**
- `503` `sandbox_not_ready` (with `retry_after_seconds: 5`) — native backend not running
- `503` `payload_preparing` (with `retry_after_seconds: 2`) — the installed payload archive is being extracted into `payload/current`; retry
- `503` `payload_in_use` (with `retry_after_seconds: 5`) — the payload update was refused because the previous backend still holds its files; `details` is `{ "reason": "payload_in_use", "remedy": "<user action>" }` and `message` ends with the remedy. Retry; it clears once that backend exits and the backend is started again.
- `500` `payload_failed` — reading or staging the installed payload failed and a retry repeats it; `details` is `{ "reason": "<bounded code>", "remedy": "<user action>" }` and `message` ends with the remedy. Do not retry.

Both read `payload_failure` (`{ "reason", "remedy", "retryable" }`) from the native lifecycle status, which `GET /sandbox-manager/v1/agent/sandbox` also returns while `phase` is `error`.
- `503` `owt_stale` (with `retry_after_seconds: 5`) — the cached token no longer verifies; it is cleared
- `404` `owt_unavailable` — no cached token; use `POST /sandbox-manager/v1/agent/sandbox/tokens` to reissue. While a Runtime Deployment start is in flight the request first waits up to 2 s for that start to issue its token, and answers `200` as soon as it does. The wait and the verification of the issued token together take at most 3.5 s; past that the answer is this `404` and the issued token stays cached for the next request. A start that fails during the wait gets this `404` at once.

---

#### `POST /sandbox-manager/v1/agent/sandbox/tokens`
Re-issue the OWT by restarting the native backend. The backend must already be running. Causes a brief downtime while the roles come back up.

**Auth:** Same as `POST /sandbox-manager/v1/agent/sandbox/actions`.

**Request body (optional):**
```json
{ "force": false }
```

**Response `200`:**
```json
{ "operation_id": "<string>", "state": "running" }
```

**Errors:** `409` `sandbox_not_ready`

---

#### `GET /sandbox-manager/v1/agent/sandbox/logs`
Get sandbox logs. Answers only requests ServiceHub forwarded (`X-SuperClaw-Forwarded-Credential`); a direct request gets `401` `servicehub_forwarding_required`.

**Query:**
- `source` (optional) — `container` (the latest `runtime-*.log` under `<DATA_DIR>\logs\sandbox\runtime\`; the native backend writes its role logs under its own state directory instead, so this is usually empty) or `install` (the latest install log). Default: `container`
- `tail` (optional, default `200`, max `1000`)

**Response `200`:**
```json
{ "source": "container | install", "lines": "<multiline string>" }
```

**Errors:** `400` `invalid_param`

---

#### `GET /sandbox-manager/v1/agent/sandbox/diagnostics`
Debugging dump for operators. Answers only requests ServiceHub forwarded, like `.../sandbox/logs`.

**Response `200`:**
```json
{
  "backend_status": { "phase": "<sandbox_phase>", "mode": "native" },
  "last_install_log_tail": "<string>",
  "recent_operations": [
    {
      "run_id": "<string>",
      "kind": "<string>",
      "state": "<string>",
      "pct": 0.0,
      "started_at": "<ISO8601>",
      "finished_at": "<ISO8601>",
      "error": null
    }
  ],
  "isolation_report": {}
}
```
`backend_status` is the native lifecycle's own status. `isolation_report` is the native backend's fail-closed isolation report (`shared/contracts`, isolation reporting).

---

### System

#### `GET /sandbox-manager/v1/system/status`
Single compact snapshot for UI boot/reconnect. Use `flows.sandbox.active_operation_id` to resume polling an in-flight operation after a reconnect without storing operation IDs.

**Response `200`:**
```json
{
  "status": "ok",
  "version": "<string>",
  "flows": {
    "sandbox": {
      "state": "pending | running | done | error | cancelled",
      "pct": 0.0,
      "active_operation_id": "<string>"
    }
  },
  "sandbox": {
    "phase": "missing | installing | stopped | starting | running | error",
    "last_error": "<string>"
  },
  "active_operations": [
    { "operation_id": "<string>", "kind": "<string>", "state": "<string>", "pct": 0.0, "message": "<string>" }
  ]
}
```
`flows.sandbox.active_operation_id` is omitted when no operation is in flight. `active_operations` contains only top-level, non-terminal operations. `sandbox.last_error` is present only when `phase` is `missing` or `error`. `flows.sandbox.state` is derived only from an in-flight sandbox provisioning operation and falls back to `pending` after completion; `sandbox.phase` is the authoritative gate for `/tokens/current`.

---

#### `GET /sandbox-manager/v1/system/preflight`
Non-mutating native backend checks. Safe to call at any time.

**Response `200`:**
```json
{
  "ready": true,
  "missing_resources": [],
  "checks": [
    {
      "name": "native_backend_payload | owt_cache",
      "state": "pass | fail | skipped",
      "severity": "error | warning | info",
      "message": "<string>",
      "details": {}
    }
  ]
}
```
`ready` is `true` when no check has both `state=fail` and `severity=error`. `message` and `details` are optional. `missing_resources` is always empty; it stays in the shape for ServiceHub's preflight fan-out.

---

#### `POST /sandbox-manager/v1/system/provisions`
Ensure the native sandbox backend is ready. This is a thin wrapper over `POST /sandbox-manager/v1/agent/sandbox/provisions`.

**Response `200`:**
```json
{
  "state": "pending | running | error | cancelled | ready | unavailable",
  "operation_id": "<string>",
  "pct": 0,
  "sandbox": {
    "state": "pending | running | error | cancelled | ready | unavailable",
    "operation_id": "<string>"
  }
}
```
Top-level `state` / `operation_id` / `pct` are a **flattened projection** for the ServiceHub fan-out aggregator, which reads these fields from the top level and then polls `GET /sandbox-manager/v1/operations/{operation_id}`. `operation_id` is omitted (and `pct=100`) when the sandbox is already ready (`state=ready`) or no sandbox lifecycle is available (`state=unavailable`); otherwise `operation_id` is present and `pct=0` (live progress comes from polling the operation).

The nested `sandbox` object is retained for **back-compat** with direct callers (frontend / Rust relay). It mirrors the top-level `state` and `operation_id` (there is no `sandbox.pct`; `pct` is top-level only); `sandbox.operation_id` follows the same omission rule.

---

## Usage Notes

### Progress Polling

Poll `GET /sandbox-manager/v1/operations/{operation_id}` at 1–2s intervals. Read `children` for per-step progress; use the parent `pct` for the overall progress bar. Stop polling when `state` is `done`, `error`, or `cancelled`.

### Retry and Partial Failure

Re-`POST` the same provisions endpoint to retry after a failure. Do not attempt to retry part of an operation — the operation is the unit of retry.

### OWT Token

For standalone development, only call `GET /sandbox-manager/v1/agent/sandbox/tokens/current` after `GET /sandbox-manager/v1/agent/sandbox` returns `phase: "running"`. On `503`, wait `retry_after_seconds` and retry. On `404` `owt_unavailable`, call `POST /sandbox-manager/v1/agent/sandbox/tokens` to reissue. In managed mode, use ServiceHub's `GET /app/runtime/sandbox-token` instead.

### Reconnect

For standalone development, call `GET /sandbox-manager/v1/system/status` on every launch and reconnect. If `flows.sandbox.active_operation_id` is present, resume polling that operation ID. If `sandbox.phase==running`, skip provisions and go directly to `GET /sandbox-manager/v1/agent/sandbox/tokens/current`. Managed product clients use the corresponding ServiceHub-owned control-plane APIs.

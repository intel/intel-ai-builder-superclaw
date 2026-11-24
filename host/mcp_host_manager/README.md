# mcp_host_manager

The host MCP gateway. It runs MCP servers the user chose to run **outside the sandbox**, as the
signed-in user, holds every tool call for policy and user approval, and drives a visible, dedicated Edge
for browser automation through a filtered CDP relay. A ServiceHub child: proxy prefix `/mcp-host`, port
`18831`, `startup: on_demand` (started by the first request ServiceHub forwards to it).

- **Ownership:** host MCP execution lane (computer use and the visible browser).
- **Contract:** `shared/contracts/src/host-mcp-api.ts` (management API, runtime data plane, CDP relay,
  approval vectors, error table, `HOST_MCP_RULES`). It also touches `mcp.ts` (`execution` on the server
  view, `mcp_host_execution_disabled`), the Product Profile flags `mcp_host_execution` and
  `host_browser` (both `true` in every shipped Profile), and the isolation report warning
  `host_mcp_execution_enabled`.
- **Allowed dependencies:** the standard library, `fastapi`, `uvicorn` (and `websockets` through it),
  `pydantic`, `loguru`, the generated `contracts` package, and `superclaw_host_observability`. No
  `sandbox_manager`, broker, OpenCode or UI.
- **UI adapter:** `apps/ui/src/shared/platform/transport/host-mcp-api.ts`, through ServiceHub with the
  hub token.
- **Tests:** `uv run pytest` from `host/mcp_host_manager`. Process and Job tests are marked
  `windows_only` and skip elsewhere. Browser tests: see [`browser/README.md`](src/mcp_host_manager/browser/README.md).

## Why host execution

- windows-mcp needs input injection, screen capture and UI Automation on `WinSta0\Default`. A tier role
  starts on its private desktop, but that is placement, not a boundary against reopening
  `WinSta0\Default`, and Job UI limits do not cover `SendInput` or screen capture; the role-level
  boundary is unresolved (#3838). The host lane is the supported path.
- A headed Playwright Chromium fails inside a tier, because Chromium's sandbox nests a Job and Windows
  refuses to nest under a Job with UI limits; and its window would be on the tier's invisible desktop.

The model follows OpenAI Codex: local stdio MCP servers run as the user in a lifecycle-only Job, made
safe by per-call approvals driven by MCP tool annotations, per-origin browser policy, and a lock-screen
rule.

## Run

ServiceHub starts it as the `mcp_host_manager` role of `superclaw-services.exe`. Standalone:

```powershell
cd host\mcp_host_manager
$env:SERVICEHUB_PROCESS_CREDENTIAL = [guid]::NewGuid().ToString("N")   # unset = every guarded route refuses
uv run python -m mcp_host_manager --host 127.0.0.1 --port 18831
```

| Variable | Default | Description |
|---|---|---|
| `SERVICEHUB_PROCESS_CREDENTIAL` | _unset_ | Keys the forwarded-credential check and authorizes `shutdown`. Removed from the environment after load, so no host server inherits it. |
| `SERVICEHUB_MANAGED` | _unset_ | `1` under ServiceHub; a missing credential is then a startup error. |
| `SERVICEHUB_SERVICE_NAME` / `SERVICEHUB_INSTANCE_ID` | `mcp_host_manager` / `dev-instance` | Echoed by `health`. |
| `MCP_HOST_MANAGER_STATE_DIR` | `%LOCALAPPDATA%\SuperClaw\mcp_host_manager` | Registry (`servers.json`) and browser configuration (`browser.json`). Never under a workspace. |

## API

```
UI ──hub token──▶ ServiceHub ──forwarded HMAC──▶ /mcp-host/v1/*          management
runtime (tier) ──Bearer runtime token──▶ /mcp-host/mcp/{name}            MCP streamable HTTP
@playwright/mcp (tier) ──relay token in path──▶ /mcp-host/cdp/{token}    filtered CDP WebSocket
```

| Route | Auth | Purpose |
|---|---|---|
| `GET /mcp-host/v1/health` | open | ServiceHub probe |
| `GET /mcp-host/v1/summary` | open | `host_server_count`, `host_browser_active`; read by Sandbox Manager for the isolation report |
| `GET /mcp-host/v1/status` | open | Server and running counts, browser state, `session_locked`, `paused`, `active_calls` |
| `POST /mcp-host/v1/shutdown` | process credential | Graceful stop |
| `GET /mcp-host/v1/servers` · `PUT`/`DELETE /mcp-host/v1/servers/{name}` · `DELETE …/{name}/grants` | forwarded | Register (returns the runtime URL and bearer header), delete, clear standing grants |
| `GET /mcp-host/v1/approvals?wait_ms=` · `POST …/approvals/{id}/decision` | forwarded | Pending approvals; approve (with a grant scope) or deny |
| `POST /mcp-host/v1/stop-all` · `POST /mcp-host/v1/resume` · `POST /mcp-host/v1/calls/{call_id}/cancel` | forwarded | Stop and pause, resume, cancel one call |
| `PUT`/`GET`/`DELETE /mcp-host/v1/browser` · `POST …/browser/stop` | forwarded | Configure (returns `cdp_endpoint`), view, unconfigure, stop Edge |
| `POST /mcp-host/mcp/{name}` | runtime bearer | MCP JSON-RPC (`GET`/`DELETE` answer 405) |
| `GET /mcp-host/cdp/{token}/json/version` · WebSocket `/mcp-host/cdp/{token}` | relay token | CDP discovery and relay |

## How it works

1. **Registration is host-anchored.** The UI registers a server through ServiceHub
   (`PUT /mcp-host/v1/servers/{name}`). The registry lives in the gateway's state directory, never in the
   workspace, so openwork-server (which runs in the tier) cannot decide what the host executes. The
   workspace gets a `remote` MCP entry pointing at the returned runtime endpoint; openwork-server marks it
   `execution: "host"` and refuses it when the active Profile lacks `mcp_host_execution`. Registered
   environment values are stored only in the registry; no API answer carries them, only their names.
   Browser-automation commands (the contract's `browser_automation_commands`, e.g. `@playwright/mcp`) are
   refused with `host_mcp_browser_automation_refused` and skipped if found at load: on the host they would
   bypass the relay filter and drive the user's own browser.
2. **Each server runs in a gateway-held Job:** created suspended-first, kill-on-close, no breakaway, an
   active-process and a Job memory limit, and **no UI limits**. The server gets an explicit environment
   (the user's own minus SuperClaw's credentials) and the gateway's stdio pipes only.
3. **On-demand lifetime.** The gateway caches each server's last good tool list (with annotations and
   instructions, at most 512 KB) and answers `initialize` and `tools/list` from it, so OpenCode
   connecting at start-up starts nothing. A `tools/call` starts the server, which lists its tools afresh,
   and the call is decided on those current annotations. After 3 minutes with no call in flight the server
   is stopped (`server_idle_stopped`). A server with no cached list is started once to learn its tools.
4. **Every tool call is decided at the gateway.** Each `tools/call` is held until the policy
   (`policy.py`) and, if needed, the user (`approval_broker.py`) allow it. Approval mode is `prompt` (ask
   every call, the default) or `auto` (ask unless the tool says `readOnlyHint: true` without
   `destructiveHint: true`). A denied, expired, cancelled or locked-screen call returns a tool result with
   `isError: true` and a fixed sentence telling the agent to ask the user rather than retry.
5. **Call timing.** The runtime's MCP client gives up after 60 s unless a progress notification resets
   its timer. A `tools/call` with a progress token from a client accepting `text/event-stream` is answered
   as SSE with `notifications/progress` every 15 s; it may wait 10 minutes for the user and then run for
   10 minutes. Any other `tools/call` is answered as JSON and expires after 50 s.
6. **Cancellation.** A dropped stream or `notifications/cancelled` for the call's id cancels it: a pending
   approval is withdrawn (a late decision gets `approval_not_pending`) and a forwarded call is cancelled at
   the server. `POST /v1/calls/{call_id}/cancel` does the same from the UI and answers the runtime
   `cancelled_by_user`. A JSON-RPC id already in flight for that server is refused (`-32600`).
7. **windows-mcp yields to the user** for about 10 s after physical input, failing calls with
   `USER_CONTROL` or `TAKEOVER_PENDING`. When a forwarded call fails that way with `wait_seconds` ≤ 15,
   the gateway waits and resends it, up to 3 times, within the call's budget, re-running the registration,
   lock and pause checks and re-checking any standing grant or `auto` policy against current annotations.
   Each retry is a `tool_call_retried` audit line. `GET /v1/status` lists calls in flight
   (`awaiting_approval`, `running`, or `waiting_for_user` with `resume_in_ms`, newest first, at most 16).
8. **Audit.** Each call has exactly one `tool_call` line (its decision); an allowed call ended by a
   cancel, stop or unavailable server adds a `tool_call_ended` line. Audit lines carry names, ids, counts
   and decisions, never argument values, environment values or tokens.
9. **The visible browser.** `PUT /mcp-host/v1/browser` returns a stable `cdp_endpoint` whose path carries
   a relay token that stays the same until `DELETE /mcp-host/v1/browser`. Edge starts on the first CDP
   connection, as the user, with a dedicated `--user-data-dir` and `--remote-debugging-pipe` (no DevTools
   TCP port), and keeps Chromium's own sandbox. The relay filters every CDP message and confines a client
   to the off-the-record (InPrivate) contexts it creates. `@playwright/mcp` stays in the tier and connects
   with `--cdp-endpoint <relay> --isolated`, so its screenshots and traces stay sandboxed. Details:
   [`browser/README.md`](src/mcp_host_manager/browser/README.md).

**Lock screen.** A host tool call while the session is locked is refused (`session_guard.py`) unless the
server was registered with `allow_when_locked`.

**Stop.** `POST /mcp-host/v1/stop-all` terminates every host Job and the browser and pauses the gateway
until `POST /mcp-host/v1/resume` or a gateway restart (`GET /v1/status` reports `paused`). Calls waiting
for approval, waiting to retry, or running on a killed server end with the `stopped_by_user` refusal.
While paused no server starts: `tools/call` is refused at once, `initialize` and `tools/list` are answered
from the cache, and the browser relay closes new connections with 1013. Registering or deleting a server
does not end the pause.

## Threat model

**Assets:** the user's desktop session (input, screen, clipboard, open apps), files, and browser
identity.

**Trust anchor:** the UI, reached only through ServiceHub. The tier is untrusted: the runtime, the agent's
shell and any prompt-injected tool run as the same tier account, and in v2.0 network egress is not
enforced, so the tier can reach any loopback port, including this gateway's.

**What the tier can do, and what stops it:**

- *Register or change a host command:* refused. Every `/mcp-host/v1/*` route except `health`, `summary`,
  `status` and `shutdown` requires ServiceHub's forwarded credential (`auth.py`); `shutdown` checks the
  process credential itself. The open routes expose counts and state only, but `status` does include the
  names of servers and tools in flight and whether the session is locked.
- *Call a host tool directly, bypassing OpenCode's permission prompt:* the call reaches the gateway and is
  held for the user like any other. The runtime token is in the workspace MCP config, which the tier can
  read, so **security does not depend on that token being secret**; it only keeps out processes outside
  SuperClaw's tier.
- *Approve its own call:* refused; decisions require the forwarded credential. Approval cards are
  rendered from what the gateway saw (server, tool, annotations, arguments), never from runtime-supplied
  prose.
- *Reuse a standing grant:* possible by design within its scope: `once`, `until_restart`, or `always`.
  `always` is offered only for tools annotated `readOnlyHint: true`; a write-capable tool gets at most
  `until_restart`.
- *Run a browser-automation MCP on the host:* refused at registration (above).
- *Drive the browser:* possible for any tier process holding the relay token, and only in off-the-record
  contexts it created. On an Entra-joined device Edge's default context signs in to Microsoft 365 from
  the device's Primary Refresh Token even with an empty profile, and implicit sign-in can sign the
  profile in; an off-the-record context carries neither (measured on Edge 156). So the relay serves only
  contexts the client created with `Target.createBrowserContext` on its own connection and refuses,
  filters or drops everything naming any other context, target, session, window or download.
  openwork-server accepts the relay-attached `@playwright/mcp` only with `--isolated`. Edge launches with
  implicit sign-in off, and the identity guard refuses the browser if an account appears in the profile.
  Every client-named destination must be `http`, `https` or exactly `about:blank`; private-network
  destinations are refused unless allow-listed; browser-UI and extension targets are detached; clipboard
  paste keys, permission grants and dangerous browser-wide methods are refused; downloads are forced into
  the workspace `downloads` folder; uploads are limited to declared roots; Edge must carry Microsoft's
  Authenticode signature and starts with ambient Windows authentication restricted.

**Accepted residuals:**

- A host server runs with the user's full rights. Approval is per call, not per side effect.
- Read-only is the server's own claim: a screenshot tool annotated `readOnlyHint: true` can be granted
  `always`.
- Host servers and the browser are outside the tier's network policy, and will stay outside it when WFP
  enforcement lands (#3355). The isolation report says so with `host_mcp_execution_enabled`.
- Chat-scoped grants are impossible: OpenCode's MCP client sends no session identity, so `until_restart`
  replaces `all_for_chat`.
- Per-app allow/deny cannot be enforced for a third-party server such as windows-mcp; the gateway cannot
  see which window a click lands on.
- The browser checks cover only destinations the client names. Page-initiated navigations, redirects and
  subresources are not checked, and Edge re-resolves DNS (rebinding remains possible). A filtering proxy
  in front of Edge would close this.
- An upload path is checked, then Edge opens it; a tier process could swap in a junction in between.
- The identity guard reads Edge's profile files, written a few seconds after sign-in, so a late sign-in
  is visible for up to one 2 s check interval plus that delay before Edge is killed. A refused profile
  keeps the account's data under the user's `%LOCALAPPDATA%`.
- `msImplicitSignin` is an undocumented Edge feature name; a later Edge may rename it (the guard then
  refuses the browser).
- The default context still signs in to Microsoft 365. Edge opens no window in it and no client can reach
  it, but a user who opens a normal window from that Edge browses there as themselves. That
  off-the-record contexts get no device SSO is measured behaviour of Edge 156, not a documented
  guarantee; re-run `tests/browser/e2e_playwright_relay.py` on new Edge builds.

## Notes

- windows-mcp 0.8.x needs a subcommand: register it as `uvx windows-mcp serve --transport stdio`. It
  refuses to start while the session is locked.

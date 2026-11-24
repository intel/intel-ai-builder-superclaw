# `sandbox_manager` package

The Windows-host control plane for the native sandbox backend. How to run, configure and call the
service is in the [service README](../../README.md); this file covers the modules whose boundaries are
not obvious from their names. Run the commands below from `host\sandbox_manager`.

## Runtime deployment (`native_deployment.py`)

Implements the `RuntimeDeploymentSpec` → `RuntimeInstanceEvidence` boundary: it stores the desired
state durably, schedules the native role set for that snapshot, and binds runtime-reported evidence
to the running generation. Writing a deployment wakes convergence at once; on startup a stored
deployment resumes on its own.

Allowed dependencies: the SQLite `Store`, the operation run/ensure lock, `broker_client`,
authenticated runtime HTTP endpoints, generated contracts, and the `NativeBackendLifecycle`
provisioning primitives. It must not become an autonomous loop, runtime catalog, model router, or a
second operation framework.

Tests: `uv run pytest tests/unit/test_runtime_deployment_store.py tests/unit/test_native_deployment_api.py`.

## HDR supervision (`native_supervision.py`)

The one deliberate watch loop in this package, used only for the `pro` generation's HDR sidecar. It
watches the sidecar's broker launch and its authenticated `/readyz`. On exit or sustained loss it
fences the generation (evidence stops reporting ready, HDR tokens are dropped, a durable cleanup intent
is written to `sbms.db`, and every role is stopped in reverse with Job-drain proof) and restarts the
whole role set through `NativeDeployment.schedule` under the adapter lock. Restarts are bounded to 3 per
15 minutes; past that the state is `recovery_required` until an explicit `control("start"|"restart")`.
An outstanding cleanup intent is completed before any start.

It carries no credential and adds no route. Contract: Sandbox lifecycle. Tests:
`uv run pytest tests/unit/test_native_supervision.py`.

## SuperClaw 1.x session import (`v1_import/`)

The first native start that finds a SuperClaw 1.x WSL install imports its OpenCode sessions once,
before the runtime role starts. See [`v1_import/README.md`](v1_import/README.md).

## Chat grants (`egress_chat_grants.py`)

"Allow all sites for this chat": `session_ref()` names a chat (its root session) as `sref_` plus 16 hex
characters of a labelled SHA-256, and `ChatGrants` remembers in memory, for at most 256 chats, which
chats the user allowed every web page for. Three owners each hold one:

- the Connector's approval desk, consulted before it holds a `connector.fetch_result`;
- the egress proxy's shell approvals (`egress_proxy_approval.py`), for `proxy.connect_unlisted`;
- the approval broker here (`egress_approval_broker.py`), behind the "Allowed for this chat" switch
  served at `GET`/`PUT /sandbox-manager/v1/egress/chat-grants/{root_session_id}`
  (`api/v1/egress_chat_grants.py`).

The broker answers a held Connector request from an allowed chat with `all_for_chat` itself, audited
with `via: "chat_grant"`. The switch applies to the Connector only. The broker persists its set in
`sbms.db` (config key `egress_chat_grants`, `session_ref`s only, never raw session ids), so a chat stays
allowed across restarts until the user switches it off or deletes the chat. Switching off is saved
first (and refused if it cannot be saved), then posted to the Connector's
`/v1/admin/chat-grants/forget`. The other two owners' grants end when their process restarts.

`egress_chat_grants.py` depends only on the standard library and `contracts.egress_approval_grant_data`,
because it also ships in the Connector's payload, which has no Pydantic. Contract:
`shared/contracts/src/egress-approval-grant.ts` (the label and its golden vector) and the
`all_for_chat` grant scope.

Tests: `uv run pytest tests/unit/test_egress_chat_grants.py tests/unit/test_connector_approval_chat.py
tests/unit/test_egress_approval_broker_chat_grants.py tests/unit/test_api_egress_chat_grants.py`.

## Egress proxy (`egress_proxy.py`, `egress_http.py`, `egress_allowlist_match.py`)

The proxy runs as the `egress_proxy` role in the network_connector tier. Shell traffic (file_tool) and
router traffic (channel) each have their own loopback port, and the port identifies the caller. It
carries `CONNECT` tunnels and plain-HTTP absolute-form requests through one decision: SSRF screen,
allowlist, then route (upstream proxy, PAC, or direct). Plain HTTP is canonicalised before forwarding
(hop-by-hop and `Proxy-*` headers dropped, ambiguous `Content-Length`/`Transfer-Encoding` refused,
`https://` in absolute form answered 400, bodies streamed). Roles are given `HTTPS_PROXY` only, so
`http://` requests still go direct.

The mode is sealed into the proxy's configuration (`EgressProxyConfig`,
`shared/contracts/src/egress-proxy-config.ts`) by `native_egress_wiring.egress_proxy_config`:

- **`log_only` is the shipped mode.** Everything reachable is tunnelled or forwarded and audited;
  `enforce_would_refuse` records what enforce would have refused, including `not_allowlisted`.
  Loopback, link-local, metadata and this host's own addresses are refused in every mode.
- **`enforce`** (development only, `SUPERCLAW_NATIVE_EGRESS_PROXY_MODE=enforce`) admits only a listed
  host (exact or `*.suffix` on a label boundary, never an IP literal) on a listed port and answers
  anything else `403` (`result=refused reason=not_allowlisted`). Unlisted shell traffic is held for
  the user's approval; the channel listener refuses it.

Because WFP enforcement is not on in v2.0, a tier process can bypass the proxy by connecting directly.
The proxy is an audit point today, not a boundary.

**Approving an unlisted shell destination (`egress_proxy_approval.py`, enforce only).** The proxy is a
verifier of the approval broker (audience `egress_proxy`, action `proxy.connect_unlisted`). It holds the
request in a `ProxyApprovalDesk`, serves the broker's admin routes on the shell listener (`/v1/admin/*`,
admin secret) and `GET /v1/approvals/state`, and releases the request on a signed one-time grant scoped
`once` or `all_for_chat`. The chat is identified by the `sc1.<d|c>.<root session>` proxy credential the
agent plugin puts in `HTTPS_PROXY`, whose MAC the proxy verifies under the sealed `session_key`. No valid
credential means an unknown chat (allow once only); a channel-owned session is refused; grants live in
memory. `Proxy-Authorization` is never forwarded.

Allowed dependencies: the standard library, `egress_guard`, `pac_resolver`, and for approvals
`connector_approval` (the proxy ships in the Connector's payload).

Tests: `uv run pytest tests/unit/test_egress_proxy.py tests/unit/test_egress_proxy_http.py
tests/unit/test_egress_proxy_enforce.py tests/unit/test_egress_proxy_pac.py
tests/unit/test_native_egress_wiring.py tests/unit/test_egress_proxy_approvals.py
tests/unit/test_egress_approval_broker_proxy.py tests/unit/test_api_egress_approvals_scope.py
tests/unit/test_native_egress_wiring_approvals.py`.

## OpenCode global config dependencies (`runtime_global_config.py`)

A leaf of the Sandbox lifecycle adapter. The payload build installs and audits OpenCode's pinned plugin
dependencies in `config-source/node_modules`. Before any role launches, the host copies that tree and
its package manifests into `data/file_tool/config/opencode` (the runtime's `XDG_CONFIG_HOME/opencode`).
It does not change Profile contents or run npm on the installed host. The copied files inherit the
provisioned tier subtree's ACL, so no ACL is widened. Matching manifests reuse the tree; a missing
plugin or changed lockfile reseeds it, and the lockfile is written last so an interrupted copy retries.
User OpenCode configuration files are preserved.

Before reading or writing, every existing path component from `data_dir` down is checked with `lstat`;
symlinks and reparse points are refused. This rejects pre-existing junctions, not a substitution that
happens after the check.

Tests: `uv run pytest tests/unit/test_native_backend.py -k TestRuntimeWritableLayout` and
`uv run pytest tests/unit/test_runtime_global_config.py`. Add `-m windows_only` on Windows for the real
DACL-inheritance and junction cases (the inheritance test checks that copied files grant the tier
read/write without `WRITE_DAC` or `WRITE_OWNER`; it does not create a tier account).

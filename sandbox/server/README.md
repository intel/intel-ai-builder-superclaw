# OpenWork Server (`openwork-server`)

Filesystem-backed HTTP API for a SuperClaw workspace. It serves workspace config, skills, plugins,
commands, MCP servers, files and automations, and proxies OpenCode and OpenCode Router for the UI.
In the installed app it listens on `127.0.0.1:8787`, runs in the `file_tool` isolation tier, and is
started as its own role next to the orchestrator (`sandbox/orchestrator`).

- **Contracts:** request and response shapes come from `@different-ai/openwork-contracts`
  (`shared/contracts`), for example `mcp`, `config-patch` and `runtime-status`.
- **Dependencies:** `@different-ai/openwork-contracts`, `@different-ai/openwork-mcp-policy`
  (`shared/mcp-policy`), Bun at runtime. MCP routes live in [`src/mcp/`](src/mcp/README.md).
- **Sandbox:** the server has no sandbox backend of its own; `GET /capabilities` always reports
  `sandbox: { enabled: false, backend: "none" }`.

## Run from source

Requires Bun 1.3+ and a repository-root `pnpm install`. The server imports the built `dist/` of
the two shared packages, so build them first:

```powershell
pnpm --filter @different-ai/openwork-contracts build
pnpm --filter @different-ai/openwork-mcp-policy build
cd sandbox/server
bun src/cli.ts --workspace C:\path\to\workspace --approval auto --verbose
```

The client and host tokens are printed on start when they are generated. `--verbose` prints the
resolved config; `--version` prints the version; `--help` lists every flag. `pnpm --filter
openwork-server dev` does the same with `OPENWORK_DEV_MODE=1`, but its script uses POSIX
`VAR=value` syntax and needs a POSIX shell. `pnpm --filter openwork-server build:bin` compiles a
standalone binary to `dist/bin/openwork-server`.

## Configuration

Precedence is flag, then environment, then the config file
(`~/.config/openwork/server.json`, or `--config` / `OPENWORK_SERVER_CONFIG`).

| Setting | Flag | Environment | `server.json` | Default |
|---|---|---|---|---|
| Bind host | `--host` | `OPENWORK_HOST` | `host` | `127.0.0.1` |
| Port | `--port` | `OPENWORK_PORT` | `port` | `8787` |
| Client bearer token | `--token` | `OPENWORK_TOKEN` | `token` | generated |
| Host token | `--host-token` | `OPENWORK_HOST_TOKEN` | `hostToken` | generated |
| Host token as SHA-256 (64 lowercase hex; replaces the host token) | | `OPENWORK_HOST_TOKEN_HASH` | | |
| Approval mode (`manual` \| `auto`) | `--approval` | `OPENWORK_APPROVAL_MODE` | `approval.mode` | `manual` |
| Approval timeout (ms) | `--approval-timeout` | `OPENWORK_APPROVAL_TIMEOUT_MS` | `approval.timeoutMs` | `30000` |
| Workspaces | `--workspace` (repeatable) | `OPENWORK_WORKSPACES` (JSON array or comma list) | `workspaces[]` | none |
| CORS origins | `--cors` | `OPENWORK_CORS_ORIGINS` (comma list or `*`) | `corsOrigins` | `*` |
| Read-only | `--read-only` | `OPENWORK_READONLY` | `readOnly` | `false` |
| OpenCode URL | `--opencode-base-url` | `OPENWORK_OPENCODE_BASE_URL` | `workspaces[].baseUrl` | |
| OpenCode directory | `--opencode-directory` | `OPENWORK_OPENCODE_DIRECTORY` | `workspaces[].directory` | |
| OpenCode basic auth | `--opencode-username`, `--opencode-password` | `OPENWORK_OPENCODE_USERNAME`, `OPENWORK_OPENCODE_PASSWORD` | `opencodeUsername`, `opencodePassword` | |
| Log format (`pretty` \| `json`) | `--log-format` | `OPENWORK_LOG_FORMAT` | `logFormat` | `pretty` |
| Request logging | `--log-requests`, `--no-log-requests` | `OPENWORK_LOG_REQUESTS` | `logRequests` | on |

Environment only:

| Variable | Effect |
|---|---|
| `OPENWORK_TOKEN_STORE` | Scoped-token store; default `tokens.json` next to `server.json`. |
| `OPENWORK_INBOX_ENABLED`, `OPENWORK_OUTBOX_ENABLED` | Turn file upload / artifact download off with `0`. Both default on. |
| `OPENWORK_INBOX_MAX_BYTES` | Upload limit; default 50 MB, capped at 250 MB. |
| `OPENWORK_TOY_UI` | Serve the static `/ui` pages; default on. |
| `OPENWORK_TELEMETRY_TOKEN` | Bearer accepted by `POST /v1/runtime/opencode-telemetry`. |
| `OPENCODE_ROUTER_HEALTH_PORT` | Where `/opencode-router/*` is proxied (`127.0.0.1:<port>`). Unset: those routes answer `404 opencodeRouter_unconfigured`. |

Example `server.json`:

```json
{
  "port": 8787,
  "approval": { "mode": "manual", "timeoutMs": 30000 },
  "workspaces": [
    { "path": "C:\\Users\\me\\Finance", "name": "Finance", "baseUrl": "http://127.0.0.1:<opencode-port>" }
  ]
}
```

## Authentication and approvals

| Auth | Accepted credential |
|---|---|
| client | `Authorization: Bearer <token>` with scope `owner`, `collaborator` or `viewer` |
| host | `X-OpenWork-Host-Token: <host token>`, or a bearer token with scope `owner` |
| telemetry | bearer token with scope `telemetry` (only the telemetry route) |

Workspace writes (config, plugins, skills, commands, MCP servers, file writes, inbox, import) wait
for host approval in `manual` mode and answer `403 write_denied` when denied or timed out. List and
answer them with `GET /approvals` and `POST /approvals/:id` `{ "reply": "allow" | "deny" }` (host
auth). `--approval auto` approves everything; use it only for local development.

## Endpoints

Every `/workspace/:id/*` and `/v1/workspaces/:id/*` route can also be called under a mounted base,
`/w/:id/...`; the nested id must match the mount id.

| Area | Routes | Auth |
|---|---|---|
| Health and UI | `GET /health`, `GET /ui`, `GET /w/:id/ui`, `GET /ui/assets/*` | none |
| Status | `GET /status`, `GET /capabilities`, `GET /whoami`, `GET /workspaces`, `GET /v1/runtime/status` (unified status, `runtime-status` contract), `GET /v1/debug/intent` | client |
| Runtime control | `GET /runtime/versions`; `POST /runtime/upgrade`, `GET /runtime/profile`, `GET /runtime/instance` | client; host |
| Edge model | `GET\|POST\|DELETE /v1/edge-model`, `POST /v1/edge-model/validate` | client |
| Tokens | `GET /tokens`, `POST /tokens` `{ "scope": "owner"\|"collaborator"\|"viewer", "label"? }`, `DELETE /tokens/:id` | host |
| Workspaces | `POST /workspaces/:id/activate`, `DELETE /workspaces/:id` | host |
| Workspace config | `GET\|PATCH /workspace/:id/config`, `GET\|PATCH /workspace/:id/runtime-settings`, `GET /workspace/:id/events`, `POST /workspace/:id/engine/reload`, `GET /workspace/:id/audit`, `GET /workspace/:id/export`, `POST /workspace/:id/import`, `DELETE /workspace/:id/sessions/:sessionId` | client |
| Extensions | `/workspace/:id/plugins`, `/workspace/:id/skills` (+ `/skills/:name`, `/skills/hub/:name`, `/skill-imports/*`), `GET /hub/skills`, `/workspace/:id/commands`, `GET /workspace/:id/agents`, `GET /workspace/:id/agent-tools-skills` | client |
| MCP servers | `/v1/workspaces/:id/mcp` — see [`src/mcp/`](src/mcp/README.md) | client |
| Files | `/workspace/:id/inbox` (+ `/:inboxId`, `/content`, `/preview-pdf`), `/workspace/:id/artifacts`, `GET\|POST\|DELETE /workspace/:id/files/content`, `/workspace/:id/projects`, `/workspace/:id/workspace/:itemId` (+ `/content`, `/preview-pdf`) | client |
| File sessions | `POST /workspace/:id/files/sessions`; `/files/sessions/:sessionId` `renew`, `catalog/snapshot`, `catalog/events`, `read-batch`, `write-batch`, `ops`, `DELETE` | client |
| Automations | `/workspace/:id/agentlab/automations` (+ `/:automationId`, `/:automationId/run`, `/logs`), `/workspace/:id/scheduler/jobs` | client |
| Accounts | `/workspace/:id/github/*`, `/workspace/:id/gmail/*`; `GET /api/gmail/oauth/callback` (no auth) | client |
| Privacy | `POST /workspace/:id/privacy/masked-review`, `POST /workspace/:id/privacy/masked-extra-terms` | client |
| Channels | `GET /workspace/:id/opencode-router/identities/{telegram,slack}`, `GET .../bindings`, `POST .../send` | client |
| Approvals | `GET /approvals`, `POST /approvals/:id` | host |
| OpenCode proxy | `/opencode/*`, `/w/:id/opencode/*` | client |
| OpenCode Router proxy | `/opencode-router/*`, `/w/:id/opencode-router/*` | see below |

Uploads go to the workspace root; artifacts are read from `.opencode/openwork/outbox/`.

The OpenCode proxy refuses MCP writes, including a config write with an `mcp` section (`403`).
`PATCH /workspace/:id/config` and import put any `mcp` entries through the same local-command gate
as an MCP add.

OpenCode Router proxy auth: `GET /opencode-router` and `GET /opencode-router/health` need client
auth; `GET /opencode-router/bindings` and `GET /opencode-router/identities/{telegram,slack}` need a
`collaborator` or `owner` client token; everything else needs host auth. Any non-`GET` request to
`/opencode-router/identities/*` is refused with `405 channel_identities_are_host_owned`: the host
(Sandbox Manager) saves channel tokens, not this server.

### Legacy scheduler

`GET /workspace/:id/scheduler/jobs` returns `{ items, supported }`. `supported` describes only the
legacy launchd/systemd scheduler, not AgentLab automations; on Windows it is
`{ "items": [], "supported": false }`, and deletion answers `scheduler_unsupported`. Clients must
treat a missing `supported` field as unknown. AgentLab automations use the separate
`/workspace/:id/agentlab/automations` API and an in-process scheduler, so they run only while the
server is running.

### Protected-file PII restore

When a `protected-file-agent` task ran in a session, `/message` results served through the
OpenCode proxy are not the raw transcript. The server finds `protected_pipeline_result` envelopes
(or follows a task wrapper's child session to its pipeline operation) and calls the Privacy
Manager's `POST /v1/session/response/restore`, chained across every masking operation the response
touches, to swap placeholders such as `<PERSON_1>` back for display. The OpenCode transcript on disk
stays masked. `GET /workspace/:id/workspace/:itemId/content` and `GET /workspace/:id/files/content`
apply the same restore to file content without rewriting the file. The Privacy Manager credential
reaches this role through its declared broker binding, not the host environment.

## Test

```powershell
cd sandbox/server
bun test
pnpm --filter openwork-server typecheck
```

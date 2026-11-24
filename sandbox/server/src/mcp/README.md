# `src/mcp/`

The workspace MCP servers API of openwork-server: the routes, the OpenCode config `mcp` section
they read and write, hot sync with the engine, and the per-message tool gate.

**Owner:** openwork-server MCP.

**Contract implemented:** `shared/contracts` `mcp` (`@different-ai/openwork-contracts/mcp`). Every
route body parses against that module; `test/mcp-routes.test.ts` holds the routes to it.

**Allowed imports:** `../` server modules (errors, jsonc, types, validators, workspace-files,
audit, utils, mcp-local-command-gate), `@different-ai/openwork-contracts/mcp` and `/host-mcp-api`,
`@different-ai/openwork-mcp-policy`, and type-only imports from `../server.js`. Never a runtime
import of `../server.js`: its plumbing arrives as `McpRouteDeps`.

The engine is reached only through upstream OpenCode v1.18.25 routes (`GET|POST /mcp`,
`POST /mcp/:name/connect|disconnect`, `DELETE /mcp/:name/auth`), with one exception:
`engine-tools.ts` calls the fork-only `GET /mcp/:name/tools`, which only the tools route reaches.

## Files

| File | Owns |
|---|---|
| `routes.ts` | `registerMcpRoutes`: `/v1/workspaces/:id/mcp` CRUD, OAuth, tool listing, and atomic per-tool policy updates. |
| `config-store.ts` | Project-entry read, PATCH merge, mapping config entries to contract `McpServer`s, the auth store path. |
| `engine-sync.ts` | Hot add, connect, disconnect, auth removal and the status read against the engine. |
| `liveness.ts` | For a `connected` loopback project server whose URL answers no `HEAD` within 5 s on two list reads in a row, writes `enabled: false` and disconnects it. A read-only server or a global entry is only disconnected; non-loopback URLs are never probed. |
| `engine-tools.ts` | One server's tool list from the fork's `GET /mcp/:name/tools`. A tagged 404 is `not_connected`; any other 404 or a non-list body is `engine_update_required`. |
| `mcp.ts` | List/add/remove over project and global OpenCode config, with validation. Reads both through the server's config-access queue and merges them with `resolveMcpServers` from `@different-ai/openwork-mcp-policy`. |
| `mcp-tool-gate.ts` | Per-message `tools` map that keeps agents to their MCP grants. Policy reading, deny keys and the session-ruleset projection come from the shared package; only agent-grant resolution is server-specific. |
| `mcp-policy-store.ts` | Per-workspace per-tool deny policy. Re-exports the shared read/validate logic; only `setToolPolicy` and its write serialization live here. The policy is removed with its server. |
| `mcp-permission-migration.ts` | One-time move of legacy MCP permissions out of agent config. |
| `mcp-operation-outcomes.ts` | Sanitised per-step outcomes returned with each mutation. |
| `write-gate.ts` | Keeps other write paths from bypassing this API: the OpenCode proxy refuses MCP writes (`403`), config PATCH and import put `mcp` entries through the MCP-add gate, and updates carrying the redaction placeholder are refused. |
| `host-gateway-url.ts` | `isHostGatewayUrl`: whether a URL reaches the host MCP gateway in any loopback spelling. |
| `browser-sandbox-support.ts` | Detects browser-automation MCP servers and a UI-restricted Windows Job (`bun:ffi` `QueryInformationJobObject`). Add/enable refuse with `mcp_browser_unsupported_in_sandbox`, the list reports `failed`, and the tool gate turns them off. |

Status is read from the engine's `GET /mcp` on every list: OpenCode publishes no MCP status event.

**Tests:** `cd sandbox/server; bun test test/mcp-`.

## Two ingress paths, one policy

The per-tool deny policy (`<workspaceRoot>/.opencode/superclaw-mcp-policy.json`) is read by two
gates that must agree on what it means:

- **UI**, through this server: `resolveToolGateForPrompt` in `../server.ts` calls `buildToolGate`
  (`mcp-tool-gate.ts`) on every `POST /opencode/session/:id/prompt_async` and injects the resulting
  `tools` map into the forwarded body.
- **Slack/Telegram**, through the channel router: `resolveChannelMcpToolGate`
  (`sandbox/channels/src/mcp-tool-gate.ts`) runs in the `gatedPrompt` choke point in
  `sandbox/channels/src/bridge.ts` before every `session.prompt` call, including retries,
  recovery, session recreation and timeout continuation.

Both use `@different-ai/openwork-mcp-policy` ([`shared/mcp-policy`](../../../../shared/mcp-policy/README.md))
for policy types, validation and reading, deny-key derivation, and the session-ruleset projection
(`buildPolicyDenyOverlay`, `reexpressRuleset`, `withholdMcp`). Agent-grant resolution (asking the
engine via `GET /agent` which servers an agent's permission block allows) stays in this server;
channels has no agent-grant concept.

### Fail-closed behaviour

- **Malformed policy file:** both paths turn every MCP server off (`withholdMcp`) but still send the
  turn, with every `<server>_*` key mapped to `false`.
- **Malformed MCP config, or a failed session/agent lookup:** both block the turn. The server
  returns `502 mcp_tool_gate_failed`; channels logs the error, replies with
  `MCP_TOOL_GATE_ERROR_MESSAGE` (`McpToolGateError`), and does not send the prompt.
- **Empty or undefined session permission ruleset** (the one intended divergence): the server falls
  through to agent-grant resolution, so an unrestricted default agent gets every configured server;
  channels always applies the shared overlay. `test/mcp-tool-gate-contract.test.ts` pins this.

### A denied tool stays denied for the session

Neither path ever sends `true` to clear an earlier deny. Allowing a tool again, removing a deny, or
deleting the policy file does not re-open a tool the engine was already told to deny in that
session: `PATCH /session` only appends, and a per-message `tools` map replaces the ruleset. **Start a
new session to regain a previously denied tool.**

### Real-OpenCode verification

`tests/real-opencode-support/run-verification.mjs` (internal test tree) drives a real OpenCode
binary, a fake `arxiv` MCP server and a scripted OpenAI-compatible model through the UI path and the
Slack path, and asserts tool filtering at the model-request boundary:

```sh
OPENCODE_BIN=/path/to/opencode bun tests/real-opencode-support/run-verification.mjs
```

Without `OPENCODE_BIN` it tries the desktop sidecar (`apps/desktop/src-tauri/sidecars/`),
`~/.opencode/bin/`, then `opencode` on `PATH`, and exits non-zero if none works; it never uses a
mock engine. Model-request captures (without `authorization`/`x-api-key`) go to
`MCP_GATE_CAPTURE_DIR`, or by default `os.tmpdir()/mcp-gate-real-opencode-captures/<run>/<ui|slack>/`.
The generated `opencode.jsonc` sets `agent.superclaw-default` and
`default_agent: "superclaw-default"`, as every Product Profile does, so turns run as the agent that
`MCP_UNRESTRICTED_AGENT` in `mcp-tool-gate.ts` grants every configured server.

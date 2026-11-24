# `features/mcp/`

Connecting, authorising and monitoring MCP servers: the Extensions page, the OAuth, credentials
and tool-policy modals, and the hook that owns the state all of them share. Persisting and
engine sync live in openwork-server (`sandbox/server/src/mcp/`); this slice only calls its
routes.

**Public surface:** `index.ts` — `McpView` (and `McpViewProps`), `McpAuthModal`,
`useMcpServers`.

**Depends on:** `shared/` (UI primitives, the capability gate, `~/shared/types/mcp`, the
instance-API and host-MCP transports, the Tauri adapters), `src/i18n`,
`@different-ai/openwork-contracts/mcp` and `@different-ai/openwork-contracts/host-mcp-api`.

**Contract:** leaf UI slice ([`../README.md`](../README.md)); consumes the `shared/contracts`
`mcp` schema (`@different-ai/openwork-contracts/mcp`), implemented by openwork-server in
`sandbox/server`, and the host MCP gateway's `host-mcp-api` schema through
`~/shared/platform/transport/host-mcp-api`.

**Still in `app/`:** nothing of this domain.

**Verify:** from `apps/ui`, `pnpm test src/features/mcp && pnpm test:mcp-ui`. The second
command runs the `mcp-ui*.test.tsx` and `mcp-form-fields.test.tsx` specs, which need
`happy-dom` and `@solidjs/testing-library` and are skipped by `pnpm test`.

## Files

| File | Owns |
|---|---|
| `mcp.client.ts` | Typed calls to `/v1/workspaces/:id/mcp` (CRUD, OAuth, tool listing, tool policy); every response is parsed with the contract. |
| `useMcpServers.ts` | Signals over the client: servers, statuses, busy name, OAuth modal state, host placement, and `useMcpStatusRefresh`. |
| `mcp-view.tsx` | Composes the page: servers list, catalog grid and the two forms. Runs the status refresh while mounted. Hides command presets and Local command when the Profile's `mcp_local_command` flag is off (`useCapabilityGate().mcpLocalCommandEnabled()`). |
| `mcp-servers-list.tsx` | Configured servers: status, stdio/HTTP transport chip, enable/disable switch, expandable details row, remove confirm. |
| `mcp-catalog-grid.tsx` | Catalog cards for presets that are not configured yet. |
| `add-mcp-modal.tsx` | Custom Add form: one input for a URL or command, with a Remote URL / Local command switch; says why when only URL is offered. |
| `mcp-catalog-form.tsx` | Catalog short form: a preset's required inputs, its command pinned until Advanced is opened. |
| `mcp-form-fields.tsx` | Field components both forms share: secret input, key/value rows, command line, local options. |
| `mcp-tool-policy-modal.tsx` | Per-tool allow/deny modal opened by clicking a server row. |
| `mcp-auth-modal.tsx`, `mcp-auth-modal.types.ts`, `mcp-auth-modal.oauth-callback.ts` | OAuth flow over the instance API: opens the returned authorization URL and submits the callback code from the loopback listener, without the engine SDK. |
| `mcp-config.ts` | Builds the engine server config from a catalog or form entry (including the npx/uvx cold-start timeout). |
| `mcp.ts` | Server name slug and configured key. |
| `mcp-input-parse.ts` | Pure parsing: mode detection, quote-aware command split/join, name suggestion. |
| `mcp-host-placement.ts` | Pure host placements: the `@playwright/mcp` check, `--cdp-endpoint` argv rewrite, and the register request and remote config of a host server. |
| `mcp-host-browser-cases.ts` | Test data: the "Use SuperClaw browser" case table shared with openwork-server's predicate. |
| `mcp-view-status.ts` | Status dot/badge/label helpers shared by the list and the grid. |
| `mcp-diagnostics.ts` | Structured diagnostic lines for MCP operations, written through the desktop shell's `mcp_diagnostic_line` command. |

Both forms produce a `McpDirectoryInfo` and save through `connectMcp`, so a hand-entered local
server gets the same `{ type: "local", command, environment }` config as a catalog stdio entry.

## Behaviour

**Status.** The engine publishes no MCP status event, so status is a read. The list route
returns each server's engine status; the hook refetches after every mutation and every 5 s
while `McpView` is mounted and the document is visible. When the engine is unreachable the
last known statuses are kept. There is no client-side endpoint probe: an unreachable server
shows as the engine's `failed` status, or switched off once openwork-server's localhost check
(`sandbox/server/src/mcp/liveness.ts`) finds nothing answering.

**Run on this computer.** A local command can run outside the sandbox through the host MCP
gateway. The Add form offers "Run on this computer" only when the Profile sets
`mcp_host_execution` (`mcpHostExecutionEnabled()`) and `McpView` receives `connectMcpPlaced`,
which `app.tsx` passes only while `useHostMcp` reports the gateway available. Nothing reaches
the gateway unless the workspace can be written. On save, `connectMcpPlaced` PUTs the command to `/mcp-host/v1/servers/{name}` with the chosen
approval mode, then adds the returned endpoint through the usual add route as
`{ type: "remote", url, headers, oauth: false }`. If that add fails, a registration this save
created is deleted again and the form shows why. Removing a host server, or saving its name
again as anything else, also deletes its host registration (best effort). The host registry
is global while workspace config is per workspace, so a second workspace adding the same name
re-registers it. A `403 mcp_host_execution_disabled` shows a dismissible notice.

**Browser automation.** A browser-automation command (`isBrowserAutomationCommand` in the
`host-mcp-api` contract) keeps "Run on this computer" off, because on the host it would skip
the relay's filter and could drive the user's own signed-in browser; a muted line says why.
With `host_browser` (`hostBrowserEnabled()`), an `@playwright/mcp` command instead gets "Use
SuperClaw browser": `PUT /mcp-host/v1/browser`, then the same sandboxed local command with
`--cdp-endpoint <relay> --isolated` replacing any `--cdp-endpoint`, `--browser`, `--headless`,
`--extension` or `--isolated`. It is offered only for shapes openwork-server's
`isHostBrowserRelayMcp` accepts; `mcp-host-browser-cases.ts` is the case table both sides
are tested against.

**Tool policy.** Listing a server's tools needs an engine route only the SuperClaw OpenCode
build serves. Clicking a configured server's row opens `McpToolPolicyModal` only when the
Profile sets `mcp_tool_permissions` (`mcpToolPermissionsEnabled()`) and `McpView` receives the
tool methods from `useMcpServers`; otherwise the row click does nothing. The chevron still
shows connection details either way.

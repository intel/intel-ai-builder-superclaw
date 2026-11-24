# `features/host-mcp/`

The app shell's side of the host MCP gateway (`mcp_host_manager`, see
[`host/mcp_host_manager/README.md`](../../../../../host/mcp_host_manager/README.md)): the
approval dialog for tool calls and browser navigations that run on this computer, outside the
sandbox, and the bar with Stop all while anything does.

**Public surface:** `index.ts` — `useHostMcp`, `useHostMcpApprovals` and their `HostMcp` /
`HostMcpApprovals` types, `HostMcpApprovalDialog`, `HostMcpInfobar`, `HostMcpProvider`,
`HostMcpEarlyWake`.

**Depends on:** `solid-js`, `lucide-solid`, `src/i18n`, `~/shared/ui/button`,
`~/shared/platform/log`, `~/shared/platform/runtime-env`, the capability gate,
`~/shared/platform/transport/host-mcp-api` and `~/shared/platform/transport/servicehub`, plus
`@tauri-apps/plugin-notification` (loaded on demand). No `fetch`, no openwork-server client.

**Contract:** leaf UI slice ([`../README.md`](../README.md)); consumes
`shared/contracts/src/host-mcp-api.ts` (pending approvals, decisions, status, stop-all, error
table) only through `~/shared/platform/transport/host-mcp-api`.

**Still in `app/`:** mounting only. `app.tsx` wraps the pages in `HostMcpProvider` and mounts
`HostMcpApprovalDialog` next to the egress approval dialog; `app/components/titlebar.tsx`
renders `HostMcpInfobar` under the title bar; `app/entry.tsx` mounts `HostMcpEarlyWake`.

**Verify:** from `apps/ui`, `pnpm test src/features/host-mcp` and
`pnpm test:workspace-files-panel src/features/host-mcp`.

## Behaviour

- **Gating.** `useHostMcp` does nothing unless the active Product Profile sets
  `mcp_host_execution` or `host_browser` (`useCapabilityGate()`) and ServiceHub's catalog
  lists `mcp_host_manager`. It then makes one `GET /mcp-host/v1/servers` to start the
  `on_demand` gateway, long-polls approvals, and reads status every 3 s only while the gateway
  is known to be running, so a status read never starts it. `awake` tells `useMcpServers` to
  reconnect failed host servers once per workspace per app start.
- **Early wake.** `HostMcpEarlyWake`, mounted beside (not inside) the startup resolver, makes
  that first `GET /mcp-host/v1/servers` as soon as ServiceHub is ready, without waiting for
  the workspace token, the runtime or the MCP list, because OpenCode connects to host servers
  before the resolver lets the app through.
- **Polling.** The approvals long-poll may start the gateway, as any business request through
  ServiceHub does. When ServiceHub answers that the gateway is not running
  (`service_absent`, `service_start_failed`, `service_unavailable`), the poll waits 60 s
  instead of backing off from 2 s. Constants are in `HOST_MCP_POLL` (`host-mcp.ts`).
- **Approval dialog.** It takes focus on itself, not on Deny, and returns focus when the last
  approval goes. The countdown comes from each approval's `expires_at`, never a fixed timeout.
  For a tool approval it names up to five of that server's other `always_grants` (server list
  cached 10 s, re-read after an Always allow). It has its own de-emphasized Stop all, because
  its overlay covers the bar.
- **Unanswered approvals.** An approval that passes `expires_at` (2 s skew allowed) or leaves
  the gateway's list without an answer gets a dismissible `expired` / `cancelled` notice under
  the bar; the latest 3 stay, each for 60 s. Nothing is shown for approvals the user answered,
  or that Stop all dropped.
- **The bar.** `HostMcpInfobar` is a full-width infobar in the page flow (the `dls-infobar-*`
  colour roles), so content moves down instead of being covered. While servers run it names
  them, adds the SuperClaw browser when open, and offers Stop all; while `status.paused` it
  offers Resume (`POST /mcp-host/v1/resume`).
- **Active calls.** Each `status.active_calls` entry that is `running` or `waiting_for_user`
  gets a row with its own Cancel (`POST /mcp-host/v1/calls/{id}/cancel`); status is then read
  every second. A computer-use call asks the user to keep off the mouse and keyboard. The
  first time a call waits for the user, `host-mcp-notify.ts` sends one Windows notification,
  never while a SuperClaw window has focus.

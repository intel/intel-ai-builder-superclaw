# `features/workspace-sidebar/`

The sidebar's view of workspaces and their sessions: grouping sessions under the workspace
they belong to, resolving each workspace's directory and connection state, and the pinned
sessions that sort above the rest. `session-pins.ts` owns the pin storage and the split
between pinned and unpinned.

**Public surface:** `index.ts` — `createWorkspaceSidebarFeature`, and the session-pin helpers
`getPinnedSessionIds`, `getSessionPinStorage`, `splitPinnedSessions`, `togglePinnedSessionId`.

**Depends on:** `@opencode-ai/sdk/v2/client`, `~/shared/platform/transport/opencode` and
`openwork-server`, `~/shared/platform/workspace-directory`, `~/shared/platform/directory-path`,
`~/shared/platform/tauri`, `~/shared/types/` (session, workspace) and `~/shared/util/`
(format, model ref).

**Contract:** leaf UI slice ([`../README.md`](../README.md)).

**Still in `app/`:** the sidebar components in `app/components/`.

**Verify:** from `apps/ui`, `pnpm test:workspace-files-panel src/features/workspace-sidebar`.
Both specs here are `.vitest.ts` files, so `pnpm test` finds none.

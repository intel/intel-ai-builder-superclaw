# `features/openwork-connection/`

The connection to an OpenWork server: normalising the URL the user typed, persisting and
clearing the settings, building the client, and deriving the connected / limited /
disconnected status the rest of the UI reads.

**Public surface:** `index.ts` — `useOpenworkConnection`.

**Depends on:** `~/shared/platform/transport/openwork-server` (the client and its settings
shapes), `~/shared/platform/tauri` (the host-side server info) and
`~/shared/types/preferences`.

**Contract:** leaf UI slice ([`../README.md`](../README.md)).

**Still in `app/`:** the pages where a user enters a server address, and the connection
banners that report the status; `app/app.openwork-connection.ts` wires the hook.

**Verify:** from `apps/ui`, `pnpm test src/features/openwork-connection`.

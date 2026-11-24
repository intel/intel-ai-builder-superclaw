# `features/openwork-runtime-settings/`

Reading and patching a remote workspace's runtime settings through the OpenWork server, and
re-reading them when the active workspace changes.

**Public surface:** `index.ts` — `useOpenworkRuntimeSettings`.

**Depends on:** the settings and patch shapes from
`~/shared/platform/transport/openwork-server`. The client is injected rather than constructed
here, which keeps the hook testable without a server.

**Contract:** leaf UI slice ([`../README.md`](../README.md)).

**Still in `app/`:** the settings UI that edits these values.

**Verify:** from `apps/ui`, `pnpm test src/features/openwork-runtime-settings`.

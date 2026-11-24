# `features/runtime/`

The backend boot: the stage, message, percentage and error the startup overlay shows, when
the runtime counts as ready, and the recoverable-snapshot policy that decides whether a
failed boot can be retried or has to be surfaced. `runtimeBootService` holds the snapshot
handling so the hook (`useBackendBoot.ts`) stays reactive state only.

**Public surface:** `index.ts` — `useBackendBootOverlay`, `useRuntimeBoot`,
`useRuntimeBootLifecycle`.

**Depends on:** `~/shared/platform/tauri` (the ServiceHub boot snapshot and ready payload),
`~/shared/platform/transport/servicehub` (the owner-token result),
`~/shared/platform/transport/openwork-server`, `~/shared/platform/capability/` (startup
signal, activation error text), `~/shared/platform/log`, and the pure retry decision in
`~/shared/util/backend-boot-policy`.

**Contract:** leaf UI slice ([`../README.md`](../README.md)).

**Still in `app/`:** the startup overlay and the capability-startup resolver
(`app/capability/`) that read this state.

**Verify:** from `apps/ui`, `pnpm test src/features/runtime`.

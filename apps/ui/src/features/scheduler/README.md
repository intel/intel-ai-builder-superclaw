# `features/scheduler/`

The scheduled jobs of the active workspace: listing and deleting them against whichever
source the workspace uses — the Tauri host for a local workspace, the OpenWork server for a
remote one — and reporting when the scheduler plugin is not installed.

**Public surface:** `index.ts` — `useScheduler`.

**Depends on:** `ScheduledJob` from `~/shared/platform/tauri`. The remote client is injected,
declared by the shape the slice needs, so neither source is imported directly.

**Contract:** leaf UI slice ([`../README.md`](../README.md)).

**Still in `app/`:** the scheduled-jobs page (`app/pages/scheduled.tsx`).

**Verify:** from `apps/ui`, `pnpm test src/features/scheduler`.

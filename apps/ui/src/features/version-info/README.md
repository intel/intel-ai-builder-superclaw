# `features/version-info/`

One shared read of the app version and debug build commit, created once in `app/app.tsx` and
passed to both the session and dashboard sidebars so they show the same values instead of
each racing its own fetch. Also owns the retry backoff and the copy-to-clipboard
acknowledgement.

**Public surface:** `index.ts` — `useVersionInfo`.

**Depends on:** `~/shared/platform/tauri` (status and commit reads) and
`~/shared/platform/runtime-env`.

**Contract:** leaf UI slice ([`../README.md`](../README.md)).

**Still in `app/`:** the panel that renders this state, `app/components/version-info-panel.tsx`.

**Verify:** nothing exercises this slice. It has no spec of its own, and
`app/components/version-info-panel.vitest.tsx` renders the panel from static props without
calling `useVersionInfo`, so the Tauri reads, the retry backoff and the clipboard
acknowledgement are uncovered.

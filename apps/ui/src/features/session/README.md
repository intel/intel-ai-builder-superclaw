# `features/session/`

The session store: the list of sessions, the messages and parts inside each one, the
streaming event stream that updates them, and the synthetic turns the UI adds on top
(pending user messages, classifier turns, error turns). It owns the OpenCode event
subscription and the reload detection that follows from it.

**Public surface:** `index.ts` — `createSessionStore` and the `SessionStore` type it returns.
`app/app.tsx` constructs the store once and passes the handle down.

**Depends on:** `@opencode-ai/sdk/v2/client`, `~/shared/platform/transport/opencode`,
`~/shared/platform/log`, `~/shared/platform/directory-path`, `~/shared/types/` (session,
models, opencode connection) and `~/shared/util/` (format, model ref, pending user message,
session collections).

**Contract:** leaf UI slice ([`../README.md`](../README.md)).

**Still in `app/`:** the session pages and components that render the store. `session.ts` is
still larger than one module should be; the smaller modules beside it
(`session-errors.ts`, `session-pending-parts.ts`, `session-reload-detection.ts`,
`session-store-collections.ts`) are where new pieces go.

**Verify:** from `apps/ui`, `pnpm test src/features/session` and
`pnpm test:workspace-files-panel src/features/session`.

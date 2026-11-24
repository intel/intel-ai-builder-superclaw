# `features/session-global-search/`

Two pieces of shared state for searching across sessions: whether the search surface is
open, and which session/message a result picked so the message list can scroll to it. Both
are Solid contexts rather than hooks, because the opener and the consumer sit in different
parts of the tree.

**Public surface:** `index.ts` — `SessionGlobalSearchProvider` and
`useSessionGlobalSearchOpen`, `GlobalSessionSearchScrollProvider` and
`useGlobalSessionSearchScroll`, and the `GlobalSessionSearchScrollTarget` type.

**Depends on:** `solid-js` only.

**Contract:** leaf UI slice ([`../README.md`](../README.md)).

**Still in `app/`:** the search input, the result list, and the scroll handler that consumes
the target (`app/components/session/use-global-search-message-target.ts`).

**Verify:** the slice has no spec of its own. The scroll-target context is covered by
`app/components/session/use-global-search-message-target.vitest.tsx` (from `apps/ui`,
`pnpm test:workspace-files-panel`); the open-state context has no direct coverage.

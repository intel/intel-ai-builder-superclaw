# `features/workspace-import/`

Importing a shared bundle — a workspace or a set of skills someone exported — and parsing
the deep links that start the flow, including the remote-connect and Den auth links that
arrive on the same scheme.

**Public surface:** `index.ts` — `createSharedBundleImportFlow` and its bundle/target types,
the deep-link parsers (`parseSharedBundleDeepLink`, `parseRemoteConnectDeepLink`,
`parseDenAuthDeepLink`, `normalizeSharedBundleImportIntent`) and the query-stripping helpers
that clean the URL afterwards.

**Depends on:** `@tauri-apps/plugin-http` (called directly), `~/shared/platform/tauri`,
`~/shared/platform/runtime-env`, `~/shared/platform/transport/den`,
`~/shared/platform/transport/openwork-server` and its `.types`, `~/shared/types/workspace`,
`~/shared/types/opencode-connection` and `~/shared/util/format`.

**Contract:** leaf UI slice ([`../README.md`](../README.md)).

**Still in `app/`:** the import modals and the dashboard tab that launch the flow;
`app/app.shared-bundle-actions.ts` wires it.

**Verify:** from `apps/ui`, `pnpm test src/features/workspace-import`.

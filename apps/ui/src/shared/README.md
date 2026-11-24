# `shared/` — the leaf layer

The bottom of `apps/ui/src`. Everything here is reachable from `app/` and from every slice in
`features/`, which is the whole reason it exists: a module two slices both need cannot live in
either of them, because `features/a -> features/b` is forbidden.

## Allowed dependencies

`shared/` may import `shared/`, `src/i18n` and npm packages. Nothing else. The full table for
all three layers is in [`../features/README.md`](../features/README.md).

The rule is absolute: `node scripts/ui-slice-boundary.mjs` (from the repository root) fails on
a single import of `~/app/...` or `~/features/...` from a file in here. That is what makes the
layer a leaf, so it is populated bottom-up — a module moves down only once everything it
imports is already down.

`src/i18n` is the one exception because it is a second leaf rather than a layer above: it
imports no other source layer, only npm packages and its own locale shards, which is what lets
a module in here call `t()`. The `i18nUpward` rule keeps it that way.

## Buckets

| Directory | Holds |
|---|---|
| `shared/ui/` | presentational components that render from their props — see [`ui/README.md`](ui/README.md) |
| `shared/platform/` | modules that talk to something outside the module: Tauri, HTTP transports, Product Profile policy, logging, `localStorage`, Web Audio |
| `shared/util/` | pure functions |
| `shared/types/` | data shapes more than one layer names |

`platform/` has sub-folders for the families large enough to need one —
[`tauri/`](platform/tauri/README.md), [`transport/`](platform/transport/README.md),
[`log/`](platform/log/README.md) and [`capability/`](platform/capability/README.md). Single
modules stay flat beside them. The folders are named after the boundary they cross, not the
feature that calls them, so a reader can tell what a module talks to before opening it.

The `util/` and `platform/` split is decided by reachability, not subject matter: a `util/`
module computes its answer from its arguments, while a `platform/` module reads the window,
the filesystem or `localStorage`. Calling `t()` does not tip a module into `platform/` —
`formatRelativeTime` reads the active locale and still belongs beside the other `format`
helpers — but reading `localStorage` for the locale would. That is why `runtime-env`,
`persist-to-local-storage` and `artifact-deletion-store` sit in `platform/`.

A file fitting none of these does not belong here. `shared/` must not become a grab-bag where
`button.tsx` sits beside `mcp-status.ts`.

## Types with domain names

`shared/types/mcp.ts` knows what an MCP server is, which sits awkwardly against "the leaf layer
knows no domain". It is here because `McpServerEntry` is named by the `mcp` slice and by page
prop types in `app/pages/`, and a type in `features/mcp/` that other places import would be an
import of slice internals. When a slice owns its type outright, the type moves into it.

No barrel. Import the module you mean — `~/shared/types/session`, not `~/shared/types`. A
barrel would hide the coupling the boundary report is meant to show.

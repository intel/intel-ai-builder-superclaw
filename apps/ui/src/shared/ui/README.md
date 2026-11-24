# `shared/ui/`

Presentational components: one belongs here when it renders from its props and nothing else.
No store reads, no transport calls. `t()` is allowed — `src/i18n` is a leaf too — but a
component whose copy belongs to one slice is better off taking the string as a prop.

Most are primitives with no source dependency of their own (`button`, `text-input`, `card`,
`tooltip`, `listbox`, `toggle-switch`). A composite qualifies too, as long as everything it
reaches for is already down here: `confirm-modal` composes `button`, `dropdown` composes
`listbox`, and `restart-required-dialog` composes `button`,
the pure `restart-required-dialog-notice` resolver and `~/shared/util/bundle-switch-step-progress`.
`workspace-chip` takes the `WorkspaceInfo` type from `~/shared/platform/tauri`; a type is not a
call, so it still renders from its props alone.

**Allowed imports:** `shared/`, `src/i18n` and npm only.

**Contract:** leaf presentational layer (no architecture contract).

**Verify:** `node scripts/ui-slice-boundary.mjs` from the repository root, then
`pnpm --dir apps/ui typecheck` and `pnpm --dir apps/ui test src/shared/ui`.

`button`, `text-input` and `confirm-modal` still have re-export barrels at their old
`app/components/` paths so existing `app/` importers keep working. New code imports
`~/shared/ui/<name>` directly; a barrel goes away when its last importer does.

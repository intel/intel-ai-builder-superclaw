# `shared/platform/log/`

UI logging (`log.ts`) and performance marks (`perf-log.ts`). In the desktop shell, records are
flushed best-effort in batches to the Tauri `ingest_ui_log` command.

**Allowed imports:** `shared/` and npm only.

**Verify:** from `apps/ui`, `pnpm test src/shared/platform/log/`.

**Contract:** leaf platform adapter (no architecture contract).

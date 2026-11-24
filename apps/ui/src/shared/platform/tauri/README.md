# `shared/platform/tauri/`

Tauri IPC adapters for the desktop shell: engine and workspace lifecycle (`tauri.engine.ts`),
sandbox (`tauri.sandbox.ts`), ServiceHub (`tauri.servicehub.ts`), OpenCode config and app
updates (`tauri.config.ts`), the OpenCode router, scheduler, MCP OAuth listener and log
collection (`tauri.router.ts`), skills, local files, Obsidian and window. `index.ts`
re-exports them; import from `~/shared/platform/tauri`.

**Allowed imports:** `shared/`, npm (`@tauri-apps/*`) and `@different-ai/openwork-contracts/*`.

**Verify:** `pnpm --dir apps/ui typecheck`. These modules have no specs of their own;
their callers exercise them in the installed app.

**Contract:** leaf platform adapter (no architecture contract).

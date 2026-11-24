# Desktop telemetry adapter

Consent-gated crash and usage export for the Tauri shell and the webview, over OTLP/HTTP JSON.

- `mod.rs` — crash records (`crash_reported`) from the webview (`emit_telemetry` command) and
  the Rust panic hook (`install_panic_hook`), the consent gates, and the OTLP POST. Event fields
  are allowlisted, text is scrubbed of URL secrets and user paths and length-bounded, and the
  Rust-owned install identifier is added only when full telemetry is on.
- `usage.rs` — low-cardinality lifecycle counters (`emit_app_start`, `emit_app_ready`,
  `emit_sandbox_ready`, `emit_startup_phase`) and their structured logs. The `active_install`
  heartbeat is logs-only, and its 24-hour cursor advances only after a successful export.
  `install_id` must never be added to metric attributes.
- `otlp_env.rs` — OTLP endpoint and edge-auth headers. They come only from the process
  environment or the installer build's baked values; there is no in-source default, so
  without either, export stays unconfigured (fail closed). Debug builds also read a gitignored
  `.env`. `ensure_process_otlp_env_for_export` applies them just before an export or a child
  spawn, never at app startup.

**Consent.** Both gates (`baseline_telemetry_enabled`, `full_telemetry_enabled`) require
install consent, and follow the same rules in every build. First launch sets
`installTelemetryConsentCompleted` in Tauri setup when still pending. After that, baseline
telemetry is on until the user turns off `baselineTelemetryEnabled` in Settings; full (crash)
telemetry needs the user's opt-in. When the shell spawns ServiceHub it passes the same
decisions as `SUPERCLAW_BASELINE_TELEMETRY` / `SUPERCLAW_FULL_TELEMETRY`, which ServiceHub's
children read.

**Allowed dependencies:** the Tauri app preferences (`commands/app_prefs.rs`), package
metadata, `serde_json`, `tracing` and the existing `ureq` HTTP client. UI code must go through
the `emit_telemetry` command rather than read preferences or telemetry environment variables.

**Contract:** leaf adapter at the desktop boundary; there is no `shared/contracts` schema for
these records.

**Verify:**

```powershell
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml telemetry::
pnpm --dir apps/ui exec bun test src/app/lib/telemetry.test.ts
pnpm --dir apps/ui typecheck
```

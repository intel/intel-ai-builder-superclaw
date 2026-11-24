// Pure decision logic for telemetry prefs (restart hint, patch merge).
//
// Kept free of SolidJS / Tauri so it is unit-testable in isolation.

import type { AppPrefs, AppPrefsUserPatch } from "./lib/tauri";

export const DEFAULT_APP_PREFS: AppPrefs = {
  keepBackendOnExit: false,
  fullTelemetryEnabled: false,
  baselineTelemetryEnabled: true,
  installTelemetryConsentCompleted: false,
  installTelemetryConsentRevision: null,
  installId: null,
  lastHeartbeatAt: null,
};

/**
 * Merge a partial patch of user-facing flags over the currently-held prefs.
 *
 * Mirrors the Rust `write_app_prefs` contract from the frontend's side: the UI
 * always sends the full user-facing flag set, while the Rust-managed
 * `installId` / `lastHeartbeatAt` / `installTelemetryConsentCompleted` are
 * carried through unchanged here so the object handed to `writeAppPrefs` never
 * nulls them by omission. The patch type is restricted to Settings toggles so
 * a caller cannot author managed fields and diverge from what Rust will persist.
 */
export function applyPrefsPatch(current: AppPrefs, patch: AppPrefsUserPatch): AppPrefs {
  return { ...current, ...patch };
}

/**
 * Whether flipping telemetry from `prev` to `next` requires a local-runtime
 * restart to take effect. Enabling or disabling both need the next ServiceHub
 * spawn to pick up the changed env (next-spawn-only reconciliation); a no-op
 * change needs nothing.
 */
export function telemetryChangeNeedsRestart(prev: boolean, next: boolean): boolean {
  return prev !== next;
}

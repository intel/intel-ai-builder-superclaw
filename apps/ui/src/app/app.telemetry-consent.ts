import { createSignal, type Accessor } from "solid-js";

import { uiLogError } from "./lib/log";
import type { AppPrefs, AppPrefsUserPatch } from "./lib/tauri";
import { telemetryChangeNeedsRestart } from "./telemetry-consent-policy";

/**
 * The telemetry consent toggles and the restart they can ask for.
 *
 * Both flags are next-spawn-only: flipping one changes what the next
 * ServiceHub is launched with, never the process already running. So a
 * successful write raises a hint rather than restarting anything, and the
 * user decides when to take the restart.
 *
 * Three signals report to the toast tail: a write failure, a restart
 * failure, and the restart hint itself. `telemetry-consent-policy` decides
 * whether a given transition needs a restart at all; this owns the
 * sequencing and the error handling around that decision.
 */

type TelemetryConsentDeps = {
  appPrefs: Accessor<AppPrefs>;
  /** Accepts the updater form; failures roll the flag back through it. */
  setAppPrefs: (updater: (current: AppPrefs) => AppPrefs) => void;
  persistAppPrefs: (patch: AppPrefsUserPatch) => Promise<void>;
  /** Resolves once prefs have been read; rejects if the read failed. */
  appPrefsReady: Promise<void>;
  /** Reads the latest write, which is reassigned on every persist. */
  appPrefsWriteTail: () => Promise<void>;
  isTauriRuntime: () => boolean;
  /**
   * Stops the running backend so the relaunch re-reads consent prefs. Injected
   * rather than imported so this stays a leaf controller: which provider gets
   * stopped is the composition root's business, not this module's. Only called
   * when `isTauriRuntime()` holds.
   */
  stopBackend: () => Promise<void>;
  restartApp: () => Promise<void>;
};

export function createTelemetryConsent(deps: TelemetryConsentDeps) {
  const [writeError, setWriteError] = createSignal(false);
  const [restartError, setRestartError] = createSignal(false);
  const [restartHint, setRestartHint] = createSignal(false);

  /**
   * A write can fail after the UI has already shown the new value, so put the
   * flag back — but only if nothing else changed it in the meantime.
   */
  const reportWriteFailure = (
    key: "fullTelemetryEnabled" | "baselineTelemetryEnabled",
    previous: boolean,
    requested: boolean,
    error: unknown,
  ) => {
    console.warn("[app] telemetry preference write failed:", error);
    deps.setAppPrefs((current) =>
      current[key] === requested ? { ...current, [key]: previous } : current,
    );
    setWriteError(true);
  };

  const setFlag = (
    key: "fullTelemetryEnabled" | "baselineTelemetryEnabled",
    next: boolean,
  ) => {
    const wasEnabled = deps.appPrefs()[key];
    setWriteError(false);
    setRestartError(false);
    const write = deps.persistAppPrefs({ [key]: next });
    if (telemetryChangeNeedsRestart(wasEnabled, next)) {
      void write
        .then(() => setRestartHint(true))
        .catch((error) => reportWriteFailure(key, wasEnabled, next, error));
    }
  };

  /**
   * Drain the pending write, stop the running backend, then relaunch.
   *
   * The stop matters even though a restart follows: a primary backend may
   * still be running from an earlier launch under keepBackendOnExit REUSE,
   * and relaunching would reuse its stale SUPERCLAW_BASELINE_TELEMETRY and
   * SUPERCLAW_FULL_TELEMETRY rather than re-reading prefs. Each failure stops
   * the sequence, because restarting on a half-applied change would announce
   * a consent state the next spawn does not actually have.
   */
  const confirmRestart = async (): Promise<void> => {
    try {
      await deps.appPrefsReady;
      await deps.appPrefsWriteTail();
    } catch (e) {
      setWriteError(true);
      uiLogError(
        "telemetry.preferences",
        "App preference write failed before restart",
        { error: e instanceof Error ? e.message : String(e) },
      );
      return;
    }

    if (deps.isTauriRuntime()) {
      try {
        await deps.stopBackend();
      } catch (e) {
        setRestartError(true);
        uiLogError(
          "telemetry.restart",
          "Failed to stop the backend before consent restart",
          { error: e instanceof Error ? e.message : String(e) },
        );
        return;
      }
    }

    setRestartHint(false);
    // Deliberately not awaited: the relaunch replaces the process (and unloads
    // the page on web), so the promise only ever settles by rejecting. Awaiting
    // it would leave confirmRestart pending until the process dies.
    void (async () => {
      try {
        await deps.restartApp();
      } catch (e) {
        uiLogError("telemetry.restart", "App restart failed after consent change", {
          error: e instanceof Error ? e.message : String(e),
        });
      }
    })();
  };

  return {
    writeError,
    setWriteError,
    restartError,
    setRestartError,
    restartHint,
    setRestartHint,
    fullEnabled: () => deps.appPrefs().fullTelemetryEnabled,
    setFullEnabled: (next: boolean) => setFlag("fullTelemetryEnabled", next),
    baselineEnabled: () => deps.appPrefs().baselineTelemetryEnabled,
    setBaselineEnabled: (next: boolean) =>
      setFlag("baselineTelemetryEnabled", next),
    confirmRestart,
  };
}

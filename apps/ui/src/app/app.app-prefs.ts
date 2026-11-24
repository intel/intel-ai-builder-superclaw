/**
 * The preferences the app keeps in a Rust-readable file
 * (`<app_config_dir>/app_prefs.json`), and the write queue that keeps them
 * consistent.
 *
 * The Tauri shutdown handler reads this file synchronously on exit, so
 * localStorage is not an option — everything round-trips through Tauri
 * commands. The signal holds the *full* `AppPrefs` because every write sends
 * a complete set of user-facing flags: Rust's `write_app_prefs` preserves
 * only its own fields (`installId`, `lastHeartbeatAt`), so omitting a user
 * flag would reset it to its serde default.
 *
 * Writes are serialized through a queue rather than fired in parallel,
 * because each one sends the whole object and two in flight at once would
 * race to decide the final contents. The queue has two tails on purpose:
 * `writeTail` rejects so callers can await a specific write and know whether
 * it landed, while the internal chain swallows the rejection so one failed
 * write does not poison every write after it.
 *
 * Outside Tauri there is nothing to write to, so the signal is updated in
 * memory and the promise resolves immediately.
 */
import { createSignal } from "solid-js";

import { uiLogWarn } from "~/shared/platform/log/log";
import { isTauriRuntime } from "~/shared/platform/runtime-env";

import {
  readAppPrefs,
  resetInstallId,
  writeAppPrefs,
  type AppPrefs,
  type AppPrefsUserPatch,
} from "~/shared/platform/tauri";
import {
  applyPrefsPatch,
  DEFAULT_APP_PREFS,
} from "./telemetry-consent-policy";

export type ResetInstallIdFeedback = "idle" | "success" | "error";

export type AppPrefsDeps = {
  /**
   * Raised after the install ID changes, so ServiceHub restarts and the new
   * ID reaches the children before any further telemetry emits. A thunk
   * because the telemetry signals are declared after this factory runs.
   */
  onInstallIdReset: () => void;
};

export const createAppPrefs = (deps: AppPrefsDeps) => {
  const { onInstallIdReset } = deps;

  const [appPrefs, setAppPrefs] = createSignal<AppPrefs>(DEFAULT_APP_PREFS);

  const appPrefsReady = isTauriRuntime()
    ? readAppPrefs().then((prefs) => {
        setAppPrefs(prefs);
      })
    : Promise.resolve();
  appPrefsReady.catch((e) =>
    uiLogWarn("app.prefs", "readAppPrefs failed; preference writes are blocked", {
      error: e instanceof Error ? e.message : String(e),
    }),
  );

  let writeQueue: Promise<void> = Promise.resolve();
  let writeTail: Promise<void> = Promise.resolve();

  /**
   * Persist a partial patch over the currently-held prefs, sending the full
   * user-facing flag set to Rust. Managed fields ride along unchanged.
   */
  const persistAppPrefs = (patch: AppPrefsUserPatch): Promise<void> => {
    if (!isTauriRuntime()) {
      setAppPrefs(applyPrefsPatch(appPrefs(), patch));
      return Promise.resolve();
    }
    const write = writeQueue
      .then(() => appPrefsReady)
      .then(() => {
        const next = applyPrefsPatch(appPrefs(), patch);
        setAppPrefs(next);
        return writeAppPrefs(next);
      });
    writeTail = write;
    writeQueue = write.catch((e) => {
      uiLogWarn("app.prefs", "writeAppPrefs failed", {
        error: e instanceof Error ? e.message : String(e),
      });
    });
    return write;
  };

  const keepBackendOnExit = () => appPrefs().keepBackendOnExit;

  const setKeepBackendOnExit = (next: boolean) => {
    void persistAppPrefs({ keepBackendOnExit: next }).catch((e) =>
      uiLogWarn("app.prefs", "keepBackendOnExit write failed", {
        error: e instanceof Error ? e.message : String(e),
      }),
    );
  };

  const [resetInstallIdFeedback, setResetInstallIdFeedback] =
    createSignal<ResetInstallIdFeedback>("idle");
  let feedbackTimer: number | null = null;

  const scheduleFeedbackClear = () => {
    if (feedbackTimer != null) {
      window.clearTimeout(feedbackTimer);
    }
    feedbackTimer = window.setTimeout(() => {
      setResetInstallIdFeedback("idle");
      feedbackTimer = null;
    }, 3000);
  };

  /**
   * Reset the pseudonymous install ID (a GDPR control). The Rust command
   * mints and persists a fresh UUID; mirror it into the held prefs so the UI
   * reflects it.
   */
  const resetInstallIdHandler = () => {
    if (!isTauriRuntime()) return;
    setResetInstallIdFeedback("idle");
    resetInstallId()
      .then((newId) => {
        setAppPrefs((p) => ({ ...p, installId: newId }));
        setResetInstallIdFeedback("success");
        scheduleFeedbackClear();
        onInstallIdReset();
      })
      .catch((e) => {
        uiLogWarn("app.prefs", "resetInstallId failed", {
          error: e instanceof Error ? e.message : String(e),
        });
        setResetInstallIdFeedback("error");
        scheduleFeedbackClear();
      });
  };

  return {
    appPrefs,
    appPrefsReady,
    /** The last write, which rejects on failure. Await it to drain before
     * a restart or shutdown decision. */
    appPrefsWriteTail: () => writeTail,
    keepBackendOnExit,
    persistAppPrefs,
    resetInstallIdFeedback,
    resetInstallIdHandler,
    setAppPrefs,
    setKeepBackendOnExit,
  };
};

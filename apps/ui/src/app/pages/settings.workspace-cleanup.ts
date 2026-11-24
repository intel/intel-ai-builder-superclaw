import { createEffect, createSignal, onCleanup, onMount } from "solid-js";

import { t } from "../../i18n";
import {
  getWorkspaceCleanupPolicy,
  getWorkspaceCleanupSettings,
  getWorkspaceCleanupStatus,
  previewWorkspaceCleanup,
  runWorkspaceCleanupNow,
  setWorkspaceCleanupSettings,
  type WorkspaceCleanupPolicy,
  type WorkspaceCleanupSettings,
  type WorkspaceCleanupStatus,
} from "../lib/tauri";
import { formatBytes, isTauriRuntime } from "../utils";

export const CLEANUP_RETENTION_PRESETS = [7, 14, 30] as const;

/** Status text auto-dismisses after this long. */
const RUN_NOW_RESULT_TTL_MS = 6000;
/** A status refresh triggered by tab focus is skipped if one is this fresh. */
const STATUS_STALE_AFTER_MS = 30_000;

type CleanupConfirmContext = "run-now" | "enable" | "retention";

type CleanupConfirmPreview = {
  dirs: number;
  files: number;
  freed: number;
  context: CleanupConfirmContext;
  retentionDays?: number;
};

type CleanupRunNowResult = {
  kind: "success" | "info" | "error";
  text: string;
};

/**
 * The Tauri bridge this controller calls. Injected rather than imported at the
 * call sites so tests can pass stubs directly: Bun's `mock.module` is
 * process-global and permanent, so mocking these here leaks into every test
 * file loaded afterwards.
 */
export type WorkspaceCleanupApi = {
  isTauri: typeof isTauriRuntime;
  /** Nullable: the controller holds policy/status as "absent until known". */
  getPolicy: () => Promise<WorkspaceCleanupPolicy | null>;
  getSettings: typeof getWorkspaceCleanupSettings;
  getStatus: (enabled?: boolean) => Promise<WorkspaceCleanupStatus | null>;
  preview: typeof previewWorkspaceCleanup;
  runNow: typeof runWorkspaceCleanupNow;
  setSettings: typeof setWorkspaceCleanupSettings;
};

const TAURI_API: WorkspaceCleanupApi = {
  isTauri: isTauriRuntime,
  getPolicy: getWorkspaceCleanupPolicy,
  getSettings: getWorkspaceCleanupSettings,
  getStatus: getWorkspaceCleanupStatus,
  preview: previewWorkspaceCleanup,
  runNow: runWorkspaceCleanupNow,
  setSettings: setWorkspaceCleanupSettings,
};

type WorkspaceCleanupDeps = {
  anyActiveRuns: () => boolean;
  api?: WorkspaceCleanupApi;
};

export type WorkspaceCleanup = ReturnType<typeof createWorkspaceCleanup>;

// The last loaded `enabled`, kept past unmount so the Settings search knows
// whether the retention choice is drawn. Unloaded settings read as enabled,
// as `currentSettings` does.
const [lastCleanupEnabled, setLastCleanupEnabled] = createSignal(true);

/** Whether the retention choice is on screen: it shows only while automatic cleanup is on. */
export const cleanupRetentionShown = (): boolean => lastCleanupEnabled();

/**
 * Workspace file-cleanup settings, the dry-run preview/confirm handshake, and
 * the Run Now action. Every mutating path previews first, so the confirmation
 * dialog is part of the contract rather than a decoration.
 */
export function createWorkspaceCleanup(deps: WorkspaceCleanupDeps) {
  const api = deps.api ?? TAURI_API;
  const [runNowBusy, setRunNowBusy] = createSignal(false);
  const [runNowResult, setRunNowResult] = createSignal<CleanupRunNowResult | null>(null);
  let runNowResultTimer: ReturnType<typeof setTimeout> | undefined;
  const showRunNowResult = (result: CleanupRunNowResult | null) => {
    clearTimeout(runNowResultTimer);
    setRunNowResult(result);
    if (result) {
      runNowResultTimer = setTimeout(
        () => setRunNowResult(null),
        RUN_NOW_RESULT_TTL_MS,
      );
    }
  };
  onCleanup(() => clearTimeout(runNowResultTimer));

  const [enableCheckBusy, setEnableCheckBusy] = createSignal(false);
  const [retentionCheckBusy, setRetentionCheckBusy] = createSignal(false);
  const [status, setStatus] = createSignal<WorkspaceCleanupStatus | null>(null);
  const [policy, setPolicy] = createSignal<WorkspaceCleanupPolicy | null>(null);
  const [settings, setSettingsSignal] = createSignal<WorkspaceCleanupSettings | null>(null);
  const setSettings = (next: WorkspaceCleanupSettings) => {
    setSettingsSignal(next);
    setLastCleanupEnabled(next.enabled);
  };
  const [settingsBusy, setSettingsBusy] = createSignal(false);
  const [settingsUnavailable, setSettingsUnavailable] = createSignal(true);
  const [settingsError, setSettingsError] = createSignal<string | null>(null);
  const currentSettings = () =>
    settings() ?? {
      enabled: true,
      retentionDays: 7,
    };
  const [confirmOpen, setConfirmOpen] = createSignal(false);
  const [confirmPreview, setConfirmPreview] = createSignal<CleanupConfirmPreview | null>(null);
  let confirmResolve: ((confirmed: boolean) => void) | null = null;
  let statusRequest: Promise<void> | null = null;
  let statusRequestEnabled: boolean | undefined;
  let lastStatusRefreshAt = 0;

  const loadStatus = (enabled?: boolean, force = false): Promise<void> => {
    if (!api.isTauri()) return Promise.resolve();
    if (statusRequest) {
      if (force) return statusRequest.then(() => loadStatus(enabled));
      if (statusRequestEnabled === enabled) return statusRequest;
    }

    lastStatusRefreshAt = Date.now();
    const request = api.getStatus(enabled)
      .then((next) => {
        if (statusRequest === request) setStatus(next);
      })
      .catch(() => {})
      .finally(() => {
        if (statusRequest === request) {
          statusRequest = null;
          statusRequestEnabled = undefined;
        }
      });
    statusRequest = request;
    statusRequestEnabled = enabled;
    return request;
  };

  const refreshStatusIfStale = () => {
    if (Date.now() - lastStatusRefreshAt < STATUS_STALE_AFTER_MS) return;
    void loadStatus(currentSettings().enabled);
  };

  const loadPolicy = () => {
    if (!api.isTauri()) return;
    api.getPolicy()
      .then(setPolicy)
      .catch(() => {});
  };

  const reloadSettings = async () => {
    if (!api.isTauri()) return;
    setSettingsBusy(true);
    try {
      setSettings(await api.getSettings());
      setSettingsUnavailable(false);
      setSettingsError(null);
    } catch (err) {
      setSettingsUnavailable(true);
      setSettingsError(err instanceof Error ? err.message : String(err));
    } finally {
      setSettingsBusy(false);
    }
  };

  const saveSettings = async (patch: {
    enabled?: boolean;
    retentionDays?: number;
  }) => {
    setSettingsBusy(true);
    try {
      const updated = await api.setSettings(patch);
      setSettings(updated);
      setSettingsError(null);
      void loadStatus(updated.enabled, true);
    } catch (err: unknown) {
      setSettingsError(err instanceof Error ? err.message : String(err));
    } finally {
      setSettingsBusy(false);
    }
  };

  onMount(() => {
    loadPolicy();
    void reloadSettings();

    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") refreshStatusIfStale();
    };
    document.addEventListener("visibilitychange", refreshWhenVisible);
    onCleanup(() =>
      document.removeEventListener("visibilitychange", refreshWhenVisible),
    );
  });

  let hadActiveRuns = deps.anyActiveRuns();
  createEffect(() => {
    const hasActiveRuns = deps.anyActiveRuns();
    if (hadActiveRuns && !hasActiveRuns) {
      void loadStatus(currentSettings().enabled);
    }
    hadActiveRuns = hasActiveRuns;
  });

  const requestConfirmation = (preview: CleanupConfirmPreview) => {
    setConfirmPreview(preview);
    setConfirmOpen(true);
    return new Promise<boolean>((resolve) => {
      confirmResolve = resolve;
    });
  };

  const closeConfirm = (confirmed: boolean) => {
    setConfirmOpen(false);
    setConfirmPreview(null);
    const resolve = confirmResolve;
    confirmResolve = null;
    resolve?.(confirmed);
  };

  /**
   * Fetches the current cleanup-eligible candidate preview (dry-run, respects
   * the allowlist -- never invents paths)
   **/
  const previewBeforeApplying = async (
    context: CleanupConfirmContext,
    retentionDays: number,
  ): Promise<boolean> => {
    const preview = (await api.preview(retentionDays)) as Record<
      string,
      unknown
    >;
    const dirs = Number(preview?.dirs_removed ?? 0);
    const files = Number(preview?.files_removed ?? 0);
    if (dirs === 0 && files === 0) return true;
    const freed = Number(preview?.bytes_freed ?? 0);
    return requestConfirmation({
      dirs,
      files,
      freed,
      context,
      retentionDays,
    });
  };

  const setEnabled = async (next: boolean) => {
    if (!next) {
      await saveSettings({ enabled: false });
      return;
    }
    const currentDays = currentSettings().retentionDays;
    setEnableCheckBusy(true);
    try {
      const confirmed = await previewBeforeApplying("enable", currentDays);
      if (!confirmed) return;
      await saveSettings({ enabled: true });
    } finally {
      setEnableCheckBusy(false);
    }
  };

  // Re-fetch status whenever the user toggles auto-cleanup so next_run_at updates.
  createEffect(() => {
    const enabledNow = currentSettings().enabled;
    loadStatus(enabledNow);
  });

  const [retentionCustomOpen, setRetentionCustomOpen] = createSignal(false);
  const [retentionCustomValue, setRetentionCustomValue] = createSignal("");
  const isRetentionPreset = () =>
    (CLEANUP_RETENTION_PRESETS as readonly number[]).includes(
      currentSettings().retentionDays,
    );

  const selectRetention = async (days: number) => {
    const savedDays = currentSettings().retentionDays;
    const enabled = currentSettings().enabled;
    if (days === savedDays) return;
    if (days < savedDays && enabled) {
      setRetentionCheckBusy(true);
      let confirmed: boolean;
      try {
        confirmed = await previewBeforeApplying("retention", days);
      } finally {
        setRetentionCheckBusy(false);
      }
      if (!confirmed) return;
    }

    await saveSettings({ retentionDays: days });
  };

  const submitCustomRetention = async () => {
    const v = Number(retentionCustomValue());
    if (!Number.isFinite(v)) return;
    const days = Math.min(30, Math.max(1, Math.floor(v)));
    setRetentionCustomOpen(false);
    setRetentionCustomValue("");
    await selectRetention(days);
  };

  const runNow = async () => {
    setRunNowBusy(true);
    showRunNowResult(null);
    try {
      const preview = (await api.preview()) as Record<
        string,
        unknown
      >;
      const pDirs = Number(preview?.dirs_removed ?? 0);
      const pFiles = Number(preview?.files_removed ?? 0);
      const pFreed = Number(preview?.bytes_freed ?? 0);

      if (pDirs === 0 && pFiles === 0) {
        showRunNowResult({
          kind: "info",
          text: t("settings.cleanup_run_now_nothing"),
        });
        return;
      }

      const confirmed = await requestConfirmation({
        dirs: pDirs,
        files: pFiles,
        freed: pFreed,
        context: "run-now",
      });
      if (!confirmed) {
        return;
      }

      const result = (await api.runNow()) as Record<
        string,
        unknown
      >;
      const freed = Number(result?.bytes_freed ?? 0);
      const dirs = Number(result?.dirs_removed ?? 0);
      const files = Number(result?.files_removed ?? 0);
      const dryRun = result?.dry_run === true;
      showRunNowResult({
        kind: dryRun ? "info" : "success",
        text: t(
          dryRun
            ? "settings.cleanup_run_now_dry_run"
            : "settings.cleanup_run_now_done",
        )
          .replace("{dirs}", String(dirs))
          .replace("{files}", String(files))
          .replace("{freed}", formatBytes(freed)),
      });
      loadStatus();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showRunNowResult({
        kind: "error",
        text:
          msg.includes("agent_task_active") || msg.includes("agent task")
            ? t("settings.cleanup_run_now_blocked")
            : msg.includes("cleanup_already_running")
              ? t("settings.cleanup_run_now_busy_conflict")
              : t("settings.cleanup_run_now_error"),
      });
    } finally {
      setRunNowBusy(false);
    }
  };

  return {
    status,
    policy,
    settings,
    settingsBusy,
    settingsUnavailable,
    settingsError,
    currentSettings,
    runNowBusy,
    runNowResult,
    enableCheckBusy,
    retentionCheckBusy,
    confirmOpen,
    confirmPreview,
    retentionCustomOpen,
    setRetentionCustomOpen,
    retentionCustomValue,
    setRetentionCustomValue,
    isRetentionPreset,
    reloadSettings,
    setEnabled,
    selectRetention,
    submitCustomRetention,
    runNow,
    closeConfirm,
  };
}

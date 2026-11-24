import { createEffect, createSignal, onCleanup, onMount, type Accessor } from "solid-js";
import { getVersion } from "@tauri-apps/api/app";

import { holdsUpdateCheck, type UpdateStatus } from "./updater";
import {
  applyAppUpdateProgress,
  subscribeAppUpdateProgress,
} from "../lib/app-update-progress";
import { getBackendSystemStatus, updaterEnvironment, type UpdaterEnvironment } from "../lib/tauri";
import { isTauriRuntime } from "../utils";

const UPDATE_AUTO_CHECK_EVERY_MS = 30 * 60_000;
const UPDATE_AUTO_CHECK_POLL_MS = 60_000;

export type AppUpdaterVersionSignals = {
  appVersion: Accessor<string | null>;
  setAppVersion: (value: string | null) => void;
  productVersion: Accessor<string | null>;
  setProductVersion: (value: string | null) => void;
  effectiveVersion: Accessor<string | null>;
};

export function createAppUpdaterVersionSignals(): AppUpdaterVersionSignals {
  const [appVersion, setAppVersion] = createSignal<string | null>(null);
  const [productVersion, setProductVersion] = createSignal<string | null>(null);
  const effectiveVersion = () =>
    productVersion()?.trim() || appVersion()?.trim() || null;

  return {
    appVersion,
    setAppVersion,
    productVersion,
    setProductVersion,
    effectiveVersion,
  };
}

export function restoreUpdaterLocalStoragePrefs(options: {
  setUpdateAutoCheck: (value: boolean) => void;
  setUpdateStatus: (value: UpdateStatus) => void;
}) {
  if (typeof window === "undefined") return;

  const storedUpdateAutoCheck = window.localStorage.getItem("openwork.updateAutoCheck");
  if (storedUpdateAutoCheck === "0" || storedUpdateAutoCheck === "1") {
    options.setUpdateAutoCheck(storedUpdateAutoCheck === "1");
  }

  const storedUpdateCheckedAt = window.localStorage.getItem("openwork.updateLastCheckedAt");
  if (!storedUpdateCheckedAt) return;

  const parsed = Number(storedUpdateCheckedAt);
  if (Number.isFinite(parsed) && parsed > 0) {
    options.setUpdateStatus({ state: "idle", lastCheckedAt: parsed });
  }
}

export function resetUpdaterPrefsOnConfigReset(options: {
  setUpdateAutoCheck: (value: boolean) => void;
  setUpdateStatus: (value: UpdateStatus) => void;
}) {
  options.setUpdateAutoCheck(true);
  options.setUpdateStatus({ state: "idle", lastCheckedAt: null });
}

export type InstallAppUpdaterRuntimeOptions = {
  booting: Accessor<boolean>;
  updateAutoCheck: Accessor<boolean>;
  updateStatus: Accessor<UpdateStatus>;
  setUpdateAutoCheck: (value: boolean) => void;
  setUpdateStatus: (value: UpdateStatus | ((prev: UpdateStatus) => UpdateStatus)) => void;
  setUpdateEnv: (value: UpdaterEnvironment | null) => void;
  checkForUpdates: (options?: { quiet?: boolean }) => Promise<void>;
  setAppVersion: (value: string | null) => void;
  setProductVersion: (value: string | null) => void;
};

function getUpdateLastCheckedAt(state: UpdateStatus): number | null {
  if (state.state === "checking") return null;
  return state.lastCheckedAt ?? null;
}

export function shouldAutoCheckForUpdates(
  state: UpdateStatus,
  now = Date.now(),
): boolean {
  if (holdsUpdateCheck(state)) return false;
  const lastCheckedAt = getUpdateLastCheckedAt(state);
  // A time in the future (the clock moved back) would otherwise hold checks off until then.
  if (!lastCheckedAt || lastCheckedAt > now) return true;
  return now - lastCheckedAt >= UPDATE_AUTO_CHECK_EVERY_MS;
}

/** For display and telemetry only; the update check compares against the shell's own version. */
async function resolveProductVersionWithRetries(setProductVersion: (value: string | null) => void) {
  const maxAttempts = 5;
  const baseDelayMs = 3_000;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const raw = (await getBackendSystemStatus()) as Record<string, unknown>;
      const ver = typeof raw?.version === "string" ? raw.version.trim() : null;
      if (ver) {
        setProductVersion(ver);
        return;
      }
    } catch {
      // backend not ready yet
    }
    if (attempt < maxAttempts - 1) {
      await new Promise((resolve) =>
        setTimeout(resolve, baseDelayMs * (attempt + 1)),
      );
    }
  }
}

/** Tauri-only startup: version probes, env, and first update check. */
export async function runTauriUpdaterStartup(options: {
  setAppVersion: (value: string | null) => void;
  setProductVersion: (value: string | null) => void;
  setUpdateEnv: (value: UpdaterEnvironment | null) => void;
  triggerInitialCheck: () => void;
}) {
  if (!isTauriRuntime()) return;

  try {
    options.setAppVersion(await getVersion());
  } catch {
    // ignore
  }

  void resolveProductVersionWithRetries(options.setProductVersion);

  try {
    options.setUpdateEnv(await updaterEnvironment());
  } catch {
    // ignore
  }

  options.triggerInitialCheck();
}

export function installAppUpdaterRuntime(options: InstallAppUpdaterRuntimeOptions) {
  const [launchUpdateCheckTriggered, setLaunchUpdateCheckTriggered] =
    createSignal(false);

  const triggerInitialCheck = () => {
    if (launchUpdateCheckTriggered()) return;
    setLaunchUpdateCheckTriggered(true);
    void options.checkForUpdates({ quiet: true }).catch(() => undefined);
  };

  onMount(() => {
    if (!isTauriRuntime()) return;
    let unlisten: (() => void) | undefined;
    void subscribeAppUpdateProgress((payload) => {
      const current = options.updateStatus();
      const next = applyAppUpdateProgress(current, payload);
      if (next !== current) {
        options.setUpdateStatus(next);
      }
    }).then((stop) => {
      unlisten = stop;
    });
    onCleanup(() => {
      unlisten?.();
    });
  });

  // openwork.updateAutoCheck is persisted in app.tsx via persistToLocalStorage
  // after preference hydration in onMount — do not duplicate here (registration
  // order would clobber a stored "0" with the default true on boot).

  createEffect(() => {
    const state = options.updateStatus();
    if (typeof window === "undefined") return;
    if (state.state === "idle" && state.lastCheckedAt) {
      try {
        window.localStorage.setItem(
          "openwork.updateLastCheckedAt",
          String(state.lastCheckedAt),
        );
      } catch {
        // ignore
      }
    }
  });

  createEffect(() => {
    if (options.booting()) return;
    if (!isTauriRuntime()) return;
    if (launchUpdateCheckTriggered()) return;

    const state = options.updateStatus();
    if (state.state === "checking") return;

    triggerInitialCheck();
  });

  createEffect(() => {
    if (options.booting()) return;
    if (typeof window === "undefined") return;
    if (!isTauriRuntime()) return;
    if (!launchUpdateCheckTriggered()) return;
    if (!options.updateAutoCheck()) return;

    const maybeRunAutoUpdateCheck = () => {
      if (!options.updateAutoCheck()) return;
      const state = options.updateStatus();
      if (state.state === "checking") return;
      if (!shouldAutoCheckForUpdates(state)) return;
      void options.checkForUpdates({ quiet: true }).catch(() => undefined);
    };

    const interval = window.setInterval(
      maybeRunAutoUpdateCheck,
      UPDATE_AUTO_CHECK_POLL_MS,
    );
    onCleanup(() => window.clearInterval(interval));
  });

  return { triggerInitialCheck };
}

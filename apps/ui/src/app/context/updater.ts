import { createSignal } from "solid-js";

import type { UpdaterEnvironment } from "../lib/tauri";

// Stage 2: in-app download + launch of the signed installer `.exe` when `installUrl`
// is present; otherwise the UI falls back to opening the release page (`homepage`).
export type UpdateInstallProgress = {
  phase: "download" | "verifying" | "launching";
  pct: number | null;
  bytesDownloaded?: number;
  bytesTotal?: number;
};

export type UpdateStatus =
  | {
      state: "idle";
      lastCheckedAt: number | null;
      /** A failed quiet attempt updates lastCheckedAt without confirming no update. */
      lastSuccessfulNoUpdateAt?: number;
    }
  | { state: "checking"; startedAt: number }
  | {
      state: "available";
      lastCheckedAt: number;
      version: string;
      notes?: string;
      homepage: string | null;
      forceUpdate: boolean;
      installUrl: string | null;
      installParameters: string | null;
    }
  | {
      state: "downloading";
      startedAt: number;
      lastCheckedAt: number | null;
      version: string;
      progress?: UpdateInstallProgress | null;
    }
  | {
      /** Downloaded and signature-verified; waits for the user to restart and install. */
      state: "ready";
      lastCheckedAt: number | null;
      version: string;
      installParameters: string | null;
    }
  | {
      state: "launching";
      lastCheckedAt: number | null;
      version: string;
      progress?: UpdateInstallProgress | null;
    }
  | {
      state: "error";
      lastCheckedAt: number | null;
      message: string;
      /** Distinguishes manifest check failures from in-app install failures. */
      context?: "check" | "install";
      version?: string;
    };

export function canInstallUpdateInApp(status: UpdateStatus): boolean {
  return status.state === "available" && Boolean(status.installUrl?.trim());
}

/**
 * Whether no update check may run now. A check replaces the status, which would drop the
 * download in progress, the verified installer waiting for Restart and install, or the hand-off.
 * The install confirmation only opens in `ready`, so it is covered too.
 */
export function holdsUpdateCheck(status: UpdateStatus): boolean {
  return status.state === "downloading" || status.state === "ready" || status.state === "launching";
}

/** The status a failed quiet check restores: unchanged, except that it counts as the last check. */
export function afterFailedQuietCheck(prev: UpdateStatus, attemptedAt: number): UpdateStatus {
  return prev.state === "checking"
    ? { state: "idle", lastCheckedAt: attemptedAt }
    : { ...prev, lastCheckedAt: attemptedAt };
}

export function createUpdaterState() {
  const [updateAutoCheck, setUpdateAutoCheck] = createSignal(true);
  const [updateStatus, setUpdateStatus] = createSignal<UpdateStatus>({ state: "idle", lastCheckedAt: null });
  const [updateEnv, setUpdateEnv] = createSignal<UpdaterEnvironment | null>(null);

  return {
    updateAutoCheck,
    setUpdateAutoCheck,
    updateStatus,
    setUpdateStatus,
    updateEnv,
    setUpdateEnv,
  } as const;
}

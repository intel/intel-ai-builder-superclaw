import { listen } from "@tauri-apps/api/event";

import type { UpdateInstallProgress, UpdateStatus } from "../context/updater";
import type { AppUpdateProgressPayload as TauriAppUpdateProgressPayload } from "~/shared/platform/tauri/tauri.config";

export const APP_UPDATE_PROGRESS_EVENT = "superclaw://app-update-progress";

export type AppUpdateProgressPayload = TauriAppUpdateProgressPayload;

type RawProgressPayload = AppUpdateProgressPayload & {
  bytes_downloaded?: number;
  bytes_total?: number;
};

export function normalizeAppUpdateProgressPayload(
  raw: RawProgressPayload,
): AppUpdateProgressPayload {
  return {
    phase: raw.phase,
    bytesDownloaded: raw.bytesDownloaded ?? raw.bytes_downloaded,
    bytesTotal: raw.bytesTotal ?? raw.bytes_total,
    pct: raw.pct ?? null,
  };
}

function mapPayload(payload: AppUpdateProgressPayload): UpdateInstallProgress {
  const normalized = normalizeAppUpdateProgressPayload(payload);
  const phase =
    normalized.phase === "verifying" || normalized.phase === "launching"
      ? normalized.phase
      : "download";
  return {
    phase,
    pct: normalized.pct ?? null,
    bytesDownloaded: normalized.bytesDownloaded,
    bytesTotal: normalized.bytesTotal,
  };
}

export function progressPercent(progress: UpdateInstallProgress | null | undefined): number | null {
  if (!progress) return null;
  const downloaded = progress.bytesDownloaded;
  const total = progress.bytesTotal;
  if (downloaded != null && total != null && total > 0) {
    return Math.min(100, Math.max(0, (downloaded / total) * 100));
  }
  const pctField = progress.pct;
  if (pctField != null && Number.isFinite(pctField)) {
    return Math.min(100, Math.max(0, pctField));
  }
  return null;
}

export function applyAppUpdateProgress(
  prev: UpdateStatus,
  payload: AppUpdateProgressPayload,
): UpdateStatus {
  if (prev.state !== "downloading" && prev.state !== "launching") {
    return prev;
  }

  const normalized = normalizeAppUpdateProgressPayload(payload);
  const progress = mapPayload(normalized);

  if (prev.state === "downloading" && normalized.phase === "launching") {
    return {
      state: "launching",
      version: prev.version,
      lastCheckedAt: prev.lastCheckedAt,
      progress,
    };
  }

  return { ...prev, progress };
}

export function mergeAppUpdateProgressIntoStatus(
  status: UpdateStatus,
  payload: AppUpdateProgressPayload | null,
): UpdateStatus {
  if (!payload) return status;
  return applyAppUpdateProgress(status, payload);
}

export async function subscribeAppUpdateProgress(
  handler: (payload: AppUpdateProgressPayload) => void,
): Promise<() => void> {
  const unlisten = await listen<RawProgressPayload>(
    APP_UPDATE_PROGRESS_EVENT,
    (event) => handler(normalizeAppUpdateProgressPayload(event.payload)),
  );
  return () => {
    unlisten();
  };
}

export function formatUpdateByteCount(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * DownloadConfirmDialog — first-launch model-download consent + live progress.
 *
 * Two phases in one centered modal (dimmed, non-dismissive backdrop):
 *   consent     → list the model + per-asset (chat / embedding) + total sizes.
 *                 Confirm starts the download; Cancel exits the app.
 *   downloading → after Confirm the dialog stays open and shows live per-asset
 *                 progress: a circular percentage ring + "done MB / total MB"
 *                 under each asset. A finished asset's ring becomes a green
 *                 check. On failure an error + Retry is shown.
 *
 * All sizes are rendered in MB (per product decision). Progress data is driven
 * by the parent (the startup resolver polls LRM's per-asset operation files).
 */
import { Show, For } from "solid-js";
import { Download, CheckCircle2, AlertTriangle, Loader2 } from "lucide-solid";
import { t } from "../../i18n";
import Button from "./button";
import {
  resolveDownloadActivity,
  showsAssetByteProgress,
  type DownloadActivity,
} from "~/shared/util/download-dialog-activity";
import { type BundleSwitchStepState } from "~/shared/util/bundle-switch-step-progress";

/** One downloadable asset row + its live progress. */
export type DownloadAsset = {
  id: string;
  role: "chat" | "embedding";
  label: string;
  /** Total bytes to download for this asset. */
  totalBytes: number;
  /** Bytes downloaded so far (0 until progress arrives). */
  doneBytes: number;
  /** True once this asset is fully downloaded/verified. */
  complete: boolean;
  /**
   * Mapped `metadata.files[].state`. Absent until the first progress poll lands;
   * `downloading` is what marks a row as actually transferring.
   */
  state?: BundleSwitchStepState;
};

export type DownloadConfirmDialogProps = {
  open: boolean;
  /**
   * "consent" before Confirm, "downloading" after, "ready" once every asset is
   * settled (held briefly by the caller so the completion is perceivable).
   */
  phase: "consent" | "downloading" | "ready";
  /** Human-readable model/bundle name (SupportedBundle.display_name). */
  modelName: string;
  /** Per-asset rows (chat + embedding) with live progress. */
  assets: DownloadAsset[];
  /** Total bytes to download (SupportedBundle.total_download_bytes). */
  totalBytes: number;
  /** Non-null while a download error is shown (enables Retry). */
  error?: string | null;
  /** Confirm — start the download (consent phase). */
  onConfirm: () => void;
  /** Cancel — the caller exits the app (consent phase). */
  onCancel: () => void;
  /** Retry a failed download (downloading phase, error shown). */
  onRetry: () => void;
  /** Cancel a failed download (downloading phase, error shown) — exits the app. */
  onCancelDownload: () => void;
};

/** Format a byte count as MB (all download sizes are shown in MB). */
function formatMB(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/** Circular percentage ring; renders a green check once done. */
function CircularProgress(props: { pct: number; done: boolean }) {
  const size = 34;
  const stroke = 3;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = () => circumference - (Math.max(0, Math.min(100, props.pct)) / 100) * circumference;
  return (
    <div class="relative flex items-center justify-center shrink-0" style={{ width: `${size}px`, height: `${size}px` }}>
      <Show when={!props.done} fallback={<CheckCircle2 size={size * 0.6} class="text-dls-success-text" />}>
        <svg class="absolute inset-0" viewBox={`0 0 ${size} ${size}`}>
          <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="currentColor" stroke-width={stroke} class="text-dls-faint" />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="currentColor"
            stroke-width={stroke}
            stroke-linecap="round"
            stroke-dasharray={`${circumference}`}
            stroke-dashoffset={offset()}
            class="text-[rgb(var(--dls-accent-rgb)/1)] transition-[stroke-dashoffset] duration-300"
            style={{ transform: "rotate(-90deg)", "transform-origin": "50% 50%" }}
          />
        </svg>
        <span class="text-tiny font-medium text-dls-secondary tabular-nums">
          {props.pct > 0 ? `${Math.round(props.pct)}%` : ""}
        </span>
      </Show>
    </div>
  );
}

export default function DownloadConfirmDialog(props: DownloadConfirmDialogProps) {
  const assetPct = (a: DownloadAsset): number => {
    if (a.complete) return 100;
    if (a.totalBytes <= 0) return 0;
    return (a.doneBytes / a.totalBytes) * 100;
  };
  const isReady = () => props.phase === "ready";
  /** Progress view: rings + "done / total". Covers `ready` too — every row is a tick. */
  const isDownloading = () => props.phase === "downloading" || isReady();
  /**
   * What the post-consent phase is really doing. Derived from the byte counters so a
   * verify pass is not announced as a download — see `download-dialog-activity`.
   */
  const activity = (): DownloadActivity =>
    resolveDownloadActivity(props.assets, {
      hasError: !!props.error,
      isReady: isReady(),
    });
  const progressTitle = () =>
    ({
      failed: t("capability.download_failed_title"),
      ready: t("capability.download_ready_title"),
      verifying: t("capability.download_verifying_title"),
      downloading: t("capability.download_progress_title"),
    })[activity()];
  const progressBody = () =>
    ({
      failed: t("capability.download_failed_body"),
      ready: t("capability.download_ready_body"),
      verifying: t("capability.download_verifying_body"),
      downloading: t("capability.download_progress_body"),
    })[activity()];

  return (
    <Show when={props.open}>
      {/* Non-dismissive backdrop: require an explicit Confirm / Cancel.
          Semi-transparent + blurred rather than solid black. */}
      <div
        data-testid="model-download-dialog"
        class="fixed inset-0 z-[100000] flex items-center justify-center dls-modal-backdrop p-4"
      >
        <div class="w-[min(460px,92vw)] border p-5 space-y-4 dls-modal-surface">
          <div class="flex items-center gap-2">
            <Show
              when={isDownloading() && (activity() === "ready" || activity() === "failed")}
              fallback={<Download size={16} class="text-dls-text" />}
            >
              <Show
                when={activity() === "failed"}
                fallback={<CheckCircle2 size={16} class="text-dls-success-text" />}
              >
                <AlertTriangle size={16} class="text-dls-danger-text" />
              </Show>
            </Show>
            <div class="text-body-lg font-semibold text-dls-text">
              {isDownloading() ? progressTitle() : t("capability.download_confirm_title")}
            </div>
          </div>

          <div class="text-caption text-dls-secondary leading-relaxed">
            {isDownloading() ? progressBody() : t("capability.download_confirm_body")}
          </div>

          {/* Model + per-asset rows */}
          <div class="rounded-inset border border-dls-border/50 bg-dls-panel-bg p-3 space-y-3">
            <div class="space-y-1">
              <div class="text-body-lg font-medium text-dls-text">{props.modelName}</div>
            </div>
            <For each={props.assets}>
              {(asset) => (
                <div class="flex items-center gap-3">
                  <Show
                    when={isDownloading()}
                    fallback={
                      <span class="shrink-0">
                        <Download size={15} class="text-dls-secondary" />
                      </span>
                    }
                  >
                    <CircularProgress pct={assetPct(asset)} done={asset.complete} />
                  </Show>
                  <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-1.5 text-caption">
                      <span class="truncate text-dls-text">{asset.label}</span>
                      <span class="text-dls-secondary shrink-0">
                        {asset.role === "chat" ? t("capability.download_role_chat") : t("capability.download_role_embedding")}
                      </span>
                    </div>
                    <Show
                      when={isDownloading() && showsAssetByteProgress(asset)}
                      fallback={<div class="text-caption text-dls-secondary tabular-nums">{formatMB(asset.totalBytes)}</div>}
                    >
                      <div class="text-label text-dls-secondary tabular-nums">
                        {formatMB(asset.complete ? asset.totalBytes : asset.doneBytes)} / {formatMB(asset.totalBytes)}
                      </div>
                    </Show>
                  </div>
                </div>
              )}
            </For>
            <div class="flex items-center justify-between gap-3 border-t border-dls-border/40 pt-2 text-caption font-medium text-dls-text">
              <span>{t("capability.download_total")}</span>
              <span class="tabular-nums">{formatMB(props.totalBytes)}</span>
            </div>
          </div>

          <Show when={props.error}>
            <div class="flex items-start gap-2 rounded-inset border border-dls-danger-border bg-dls-danger-bg p-3 text-caption text-dls-danger-text">
              <AlertTriangle size={14} class="mt-0.5 shrink-0" />
              <span>{props.error}</span>
            </div>
          </Show>

          <div class="flex items-center justify-end gap-2 pt-1">
            <Show
              when={isDownloading()}
              fallback={
                <>
                  {/* Cancel exits the app — styled red (destructive). */}
                  <Button
                    variant="outline"
                    class="text-caption h-8 py-0 px-4 border-dls-danger-border text-dls-danger-text hover:bg-dls-danger-bg"
                    data-testid="model-download-cancel-btn"
                    onClick={props.onCancel}
                  >
                    {t("capability.download_cancel")}
                  </Button>
                  <Button
                    variant="secondary"
                    class="text-caption h-8 py-0 px-4"
                    data-testid="model-download-confirm-btn"
                    onClick={props.onConfirm}
                  >
                    {t("capability.download_confirm")}
                  </Button>
                </>
              }
            >
              {/* Downloading: show Retry + Cancel on error, else a status hint. */}
              <Show
                when={props.error}
                fallback={
                  <Show
                    when={isReady()}
                    fallback={
                      <span class="flex items-center gap-1.5 text-caption text-dls-secondary">
                        <Loader2 size={12} class="animate-spin" />
                        {activity() === "verifying"
                          ? t("capability.download_verifying_hint")
                          : t("capability.download_in_progress")}
                      </span>
                    }
                  >
                    {/* No spinner: the work is done, this beat only lets it register. */}
                    <span class="flex items-center gap-1.5 text-caption text-dls-success-text">
                      <CheckCircle2 size={12} />
                      {t("capability.download_ready_hint")}
                    </span>
                  </Show>
                }
              >
                <Button
                  variant="outline"
                  class="text-caption h-8 py-0 px-4 border-dls-danger-border text-dls-danger-text hover:bg-dls-danger-bg"
                  onClick={props.onCancelDownload}
                >
                  {t("capability.download_cancel_download")}
                </Button>
                <Button variant="secondary" class="text-caption h-8 py-0 px-4" onClick={props.onRetry}>
                  {t("capability.download_retry")}
                </Button>
              </Show>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  );
}

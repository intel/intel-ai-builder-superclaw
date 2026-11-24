/**
 * TtsDownloadConfirmDialog — consent + live progress for the on-demand Kokoro
 * TTS voice-model download (~350 MB ONNX model: kokoro-v1.0.onnx + voices-v1.0.bin),
 * shown the first time the user clicks the 🔊 "Speak" icon while the model is not
 * yet on the persistent volume.
 *
 * Mirrors DownloadConfirmDialog (same dimmed non-dismissive backdrop, card
 * style, MB formatting, and CircularProgress ring) but for the Kokoro model
 * rather than the chat + embedding bundle, and Cancel simply dismisses the
 * dialog (narration stays off) instead of exiting the app. The progress ring
 * tracks the combined byte total of both files (the service reports one merged
 * done/total), so the UI still shows a single percentage.
 *
 * Phases (one centered modal):
 *   consent     → show the model + ~total size. Confirm starts the download;
 *                 Cancel dismisses (does not enable narration).
 *   downloading → live "done MB / total MB" under a percentage ring.
 *   ready       → ring becomes a green check, held briefly, then narration is
 *                 enabled by the caller.
 * On failure an error + Retry / Cancel is shown.
 */
import { Show } from "solid-js";
import { Download, CheckCircle2, AlertTriangle, Loader2, Languages } from "lucide-solid";
import { t } from "../../i18n";
import Button from "./button";

export type TtsDownloadConfirmDialogProps = {
  open: boolean;
  /** "consent" before Confirm, "downloading" after, "ready" once verified+loaded. */
  phase: "consent" | "downloading" | "ready";
  /** Human-readable model name, e.g. "Kokoro-82M (English voice)". */
  modelName: string;
  /** Bytes downloaded so far (0 until progress arrives). */
  doneBytes: number;
  /** Total bytes to download (combined for both files; falls back to the ~350 MB estimate). */
  totalBytes: number;
  /** Non-null while a download error is shown (enables Retry). */
  error?: string | null;
  /** Confirm — start the download (consent phase). */
  onConfirm: () => void;
  /** Cancel — dismiss the dialog; narration stays off (consent phase). */
  onCancel: () => void;
  /** Retry a failed download (downloading phase, error shown). */
  onRetry: () => void;
  /** Cancel a failed/in-flight download — dismiss the dialog. */
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

export default function TtsDownloadConfirmDialog(props: TtsDownloadConfirmDialogProps) {
  const pct = (): number => {
    if (props.phase === "ready") return 100;
    if (props.totalBytes <= 0) return 0;
    return (props.doneBytes / props.totalBytes) * 100;
  };
  const isReady = () => props.phase === "ready";
  const isDownloading = () => props.phase === "downloading" || isReady();

  return (
    <Show when={props.open}>
      {/* Non-dismissive backdrop: require an explicit Confirm / Cancel. */}
      <div class="fixed inset-0 z-[100000] flex items-center justify-center dls-modal-backdrop p-4">
        <div class="w-[min(460px,92vw)] border p-5 space-y-4 dls-modal-surface">
          <div class="flex items-center gap-2">
            <Show when={isReady()} fallback={<Download size={16} class="text-dls-text" />}>
              <CheckCircle2 size={16} class="text-dls-success-text" />
            </Show>
            <div class="text-body-lg font-semibold text-dls-text">
              {isReady()
                ? t("capability.tts_download_ready_title")
                : isDownloading()
                  ? t("capability.tts_download_progress_title")
                  : t("capability.tts_download_confirm_title")}
            </div>
          </div>

          <div class="text-caption text-dls-secondary leading-relaxed">
            {isReady()
              ? t("capability.tts_download_ready_body")
              : isDownloading()
                ? t("capability.tts_download_progress_body")
                : t("capability.tts_download_confirm_body")}
          </div>

          {/* English-only advisory (consent phase only) so users know the
              voice model speaks English before they commit to the download. */}
          <Show when={props.phase === "consent"}>
            <div class="flex items-start gap-2 rounded-inset border border-[rgb(var(--dls-accent-rgb)/0.3)] bg-[rgb(var(--dls-accent-rgb)/0.06)] p-3 text-caption text-dls-secondary leading-relaxed">
              <Languages size={14} class="mt-0.5 shrink-0 text-[rgb(var(--dls-accent-rgb)/1)]" />
              <span>{t("capability.tts_download_lang_note")}</span>
            </div>
          </Show>

          {/* Model + size row */}
          <div class="rounded-inset border border-dls-border/50 bg-dls-panel-bg p-3 space-y-3">
            <div class="flex items-center gap-3">
              <Show
                when={isDownloading()}
                fallback={
                  <span class="shrink-0">
                    <Download size={15} class="text-dls-secondary" />
                  </span>
                }
              >
                <CircularProgress pct={pct()} done={isReady()} />
              </Show>
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-1.5">
                  <div class="text-caption text-dls-text truncate">{props.modelName}</div>
                  {/* Language chip: narration is English-only for now. */}
                  <span class="shrink-0 rounded-pill border border-dls-panel-border bg-dls-surface-tint/50 px-1.5 py-px text-tiny font-medium text-dls-secondary">
                    English
                  </span>
                </div>
                <Show
                  when={isDownloading()}
                  fallback={<div class="text-caption text-dls-secondary tabular-nums">{formatMB(props.totalBytes)}</div>}
                >
                  <div class="text-label text-dls-secondary tabular-nums">
                    {formatMB(isReady() ? props.totalBytes : props.doneBytes)} / {formatMB(props.totalBytes)}
                  </div>
                </Show>
              </div>
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
                  <Button variant="outline" class="text-caption h-8 py-0 px-4" onClick={props.onCancel}>
                    {t("capability.download_cancel")}
                  </Button>
                  <Button variant="secondary" class="text-caption h-8 py-0 px-4" onClick={props.onConfirm}>
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
                        {t("capability.download_in_progress")}
                      </span>
                    }
                  >
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

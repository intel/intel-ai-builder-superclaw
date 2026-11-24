/**
 * VoiceDownloadConfirmDialog — consent + live progress for the on-demand local
 * speech model (~630 MB), shown the first time the microphone is pressed while
 * local mode is selected and the weights are not on disk.
 *
 * Deliberately built like `TtsDownloadConfirmDialog`: users who already accepted
 * the Kokoro download recognise the shape, and the plan calls for the same flow.
 * Two differences, both required:
 *
 *  * The second button is **"Use cloud instead"**, not "Cancel". It switches the
 *    mode and starts recording immediately, i.e. the pre-upgrade behaviour, so a
 *    user who does not want a 630 MB download is not left with a dead button.
 *  * The **English-only** advisory is part of the consent phase, next to the
 *    size. Both facts have to be readable before the download starts, not after.
 *
 * The **consent phase** is the only screen-blocking step in the whole
 * voice-input flow, and it blocks on purpose: the user is deciding between
 * 630 MB of disk and sending their audio to a cloud service. What follows is
 * not that decision — a 630 MB download takes minutes — so every later phase can
 * be closed, by its own button or by Escape, and the download carries on in the
 * background; another microphone click reopens its progress. Without that, the only exit
 * from a minutes-long modal was [Use cloud instead], i.e. changing the engine
 * the user deliberately chose in order to get their screen back.
 */
import { AlertTriangle, CheckCircle2, Download, Languages, Loader2, Mic } from "lucide-solid";
import { Show, createEffect, onCleanup } from "solid-js";

import { ASR_MODEL_BYTES, ASR_MODEL_NAME } from "~/features/voice-input";

import { t } from "../../i18n";
import Button from "./button";

export type VoiceDownloadConfirmDialogProps = {
  open: boolean;
  /** "consent" before Download, then progress, "ready" once usable, "error" on failure. */
  phase: "consent" | "downloading" | "ready" | "error";
  /** Bytes fetched so far, from the service snapshot. */
  doneBytes: number;
  /** Total bytes reported by the service; falls back to the advertised size. */
  totalBytes: number;
  /** Service-provided failure detail, shown verbatim under the progress row. */
  error?: string | null;
  /** Start the ~630 MB download. */
  onConfirm: () => void;
  /** Switch to the cloud engine and start recording right away. */
  onUseCloud: () => void;
  /** Retry after a failed download. */
  onRetry: () => void;
  /**
   * Close without downloading and without changing the mode. During the
   * download phase the caller keeps the fetch and its polling alive — only the
   * window goes away.
   */
  onCancel: () => void;
};

/** Format a byte count as MB, matching the other download dialogs. */
function formatMB(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/** Circular percentage ring; renders a green check once done. */
function CircularProgress(props: { pct: number; done: boolean }) {
  const size = 34;
  const stroke = 3;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = () =>
    circumference - (Math.max(0, Math.min(100, props.pct)) / 100) * circumference;
  return (
    <div
      class="relative flex items-center justify-center shrink-0"
      style={{ width: `${size}px`, height: `${size}px` }}
    >
      <Show when={!props.done} fallback={<CheckCircle2 size={size * 0.6} class="text-dls-success-text" />}>
        <svg class="absolute inset-0" viewBox={`0 0 ${size} ${size}`}>
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="currentColor"
            stroke-width={stroke}
            class="text-dls-faint"
          />
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

export default function VoiceDownloadConfirmDialog(props: VoiceDownloadConfirmDialogProps) {
  // Until the service reports byte totals, the advertised 630 MB is the
  // denominator, so the ring never divides by zero or jumps once it arrives.
  const total = () => (props.totalBytes > 0 ? props.totalBytes : ASR_MODEL_BYTES);
  const isReady = () => props.phase === "ready";
  const isError = () => props.phase === "error";
  const showsProgress = () => props.phase === "downloading" || isReady() || isError();
  const pct = () => {
    if (isReady()) return 100;
    return (props.doneBytes / total()) * 100;
  };

  const title = () => {
    if (isReady()) return t("voice.download_ready_title");
    if (isError()) return t("voice.download_failed_title");
    if (props.phase === "downloading") return t("voice.download_progress_title");
    return t("voice.download_title");
  };

  const body = () => {
    if (isReady()) return t("voice.download_ready_body");
    if (props.phase === "downloading") return t("voice.download_progress_body");
    return t("voice.download_body");
  };

  /**
   * Escape closes everything except the consent question, which has to be
   * answered. A keyboard exit matters most in the download phase: that is the
   * phase that lasts minutes.
   */
  createEffect(() => {
    if (!props.open || props.phase === "consent") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      props.onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    onCleanup(() => window.removeEventListener("keydown", onKeyDown));
  });

  return (
    <Show when={props.open}>
      {/* The backdrop swallows clicks on purpose, in every phase: a stray click
          must not answer the consent question, and must not look like it
          cancelled a download that is in fact still running. Leaving is done
          through a labelled button (or Escape), so what happens to the download
          is written down. */}
      <div
        class="fixed inset-0 z-[100000] flex items-center justify-center dls-modal-backdrop p-4"
        data-testid="voice-download-dialog"
      >
        <div class="w-[min(460px,92vw)] border p-5 space-y-4 dls-modal-surface">
          <div class="flex items-center gap-2">
            <Show
              when={isReady()}
              fallback={
                <Show when={isError()} fallback={<Mic size={16} class="text-dls-text" />}>
                  <AlertTriangle size={16} class="text-dls-danger-text" />
                </Show>
              }
            >
              <CheckCircle2 size={16} class="text-dls-success-text" />
            </Show>
            <div class="text-body-lg font-semibold text-dls-text">{title()}</div>
          </div>

          <div class="text-caption text-dls-secondary leading-relaxed">{body()}</div>

          {/* English-only advisory, shown before the download is committed to. */}
          <Show when={props.phase === "consent"}>
            <div class="flex items-start gap-2 rounded-inset border border-[rgb(var(--dls-accent-rgb)/0.3)] bg-[rgb(var(--dls-accent-rgb)/0.06)] p-3 text-caption text-dls-secondary leading-relaxed">
              <Languages size={14} class="mt-0.5 shrink-0 text-[rgb(var(--dls-accent-rgb)/1)]" />
              <span data-testid="voice-download-english-only">
                {t("voice.download_english_only")}
              </span>
            </div>
          </Show>

          <div class="rounded-inset border border-dls-border/50 bg-dls-panel-bg p-3">
            <div class="flex items-center gap-3">
              <Show
                when={showsProgress()}
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
                  <div class="text-caption text-dls-secondary truncate">{ASR_MODEL_NAME}</div>
                  <span class="shrink-0 rounded-pill border border-dls-panel-border bg-dls-surface-tint/50 px-1.5 py-px text-tiny font-medium text-dls-secondary">
                    {t("voice.mode_local_badge")}
                  </span>
                </div>
                <Show
                  when={showsProgress()}
                  fallback={
                    <div class="text-caption text-dls-secondary tabular-nums">{formatMB(total())}</div>
                  }
                >
                  <div class="text-label text-dls-secondary tabular-nums">
                    {formatMB(isReady() ? total() : props.doneBytes)} / {formatMB(total())}
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
              when={props.phase === "consent"}
              fallback={
                <Show
                  when={isError()}
                  fallback={
                    <Show
                      when={isReady()}
                      fallback={
                        <>
                          <span class="mr-auto flex items-center gap-1.5 text-caption text-dls-secondary">
                            <Loader2 size={12} class="animate-spin" />
                            {t("voice.download_in_progress")}
                          </span>
                          {/* Still available mid-download: a user who changes
                              their mind should not have to wait it out. */}
                          <Button
                            variant="outline"
                            class="text-caption h-8 py-0 px-4"
                            onClick={props.onUseCloud}
                          >
                            {t("voice.download_use_cloud")}
                          </Button>
                          {/* The exit that does NOT change the engine: the
                              download keeps running, and another microphone
                              click reopens this progress view. Without this the
                              only way out of a minutes-long modal was switching
                              to cloud. */}
                          <Button
                            variant="secondary"
                            class="text-caption h-8 py-0 px-4"
                            onClick={props.onCancel}
                            data-testid="voice-download-background"
                          >
                            {t("voice.download_background")}
                          </Button>
                        </>
                      }
                    >
                      <span class="mr-auto flex items-center gap-1.5 text-caption text-dls-success-text">
                        <CheckCircle2 size={12} />
                        {t("voice.download_ready_title")}
                      </span>
                      <Button
                        variant="secondary"
                        class="text-caption h-8 py-0 px-4"
                        onClick={props.onCancel}
                      >
                        {t("voice.download_cancel")}
                      </Button>
                    </Show>
                  }
                >
                  {/* A failure must be dismissable without picking either
                      remedy: the composer's hint bubble offers the same
                      redownload-or-cloud choice afterwards. */}
                  <button
                    type="button"
                    class="mr-auto text-caption text-dls-secondary underline underline-offset-2 hover:opacity-80"
                    onClick={props.onCancel}
                    data-testid="voice-download-close"
                  >
                    {t("voice.download_close")}
                  </button>
                  <Button variant="outline" class="text-caption h-8 py-0 px-4" onClick={props.onUseCloud}>
                    {t("voice.download_use_cloud")}
                  </Button>
                  <Button variant="secondary" class="text-caption h-8 py-0 px-4" onClick={props.onRetry}>
                    {t("voice.download_retry")}
                  </Button>
                </Show>
              }
            >
              <Button
                variant="outline"
                class="text-caption h-8 py-0 px-4"
                onClick={props.onUseCloud}
                data-testid="voice-download-use-cloud"
              >
                {t("voice.download_use_cloud")}
              </Button>
              <Button
                variant="secondary"
                class="text-caption h-8 py-0 px-4"
                onClick={props.onConfirm}
                data-testid="voice-download-confirm"
              >
                {t("voice.download_confirm")}
              </Button>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  );
}

import { Show } from "solid-js";
import { AlertTriangle, CheckCircle2, Download, Loader2 } from "lucide-solid";
import { t } from "../../i18n";
import Button from "./button";

export type PrivacyModelDownloadDialogProps = {
  open: boolean;
  phase: "consent" | "downloading" | "ready";
  doneBytes: number;
  totalBytes: number;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
};

function formatMB(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

function CircularProgress(props: { pct: number; done: boolean }) {
  const size = 34;
  const stroke = 3;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = () => circumference - (Math.max(0, Math.min(100, props.pct)) / 100) * circumference;

  return (
    <div class="relative flex shrink-0 items-center justify-center" style={`width: ${size}px; height: ${size}px`}>
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
            style="transform: rotate(-90deg); transform-origin: 50% 50%"
          />
        </svg>
        <span class="text-tiny font-medium text-dls-secondary tabular-nums">
          {props.pct > 0 ? `${Math.round(props.pct)}%` : ""}
        </span>
      </Show>
    </div>
  );
}

export default function PrivacyModelDownloadDialog(props: PrivacyModelDownloadDialogProps) {
  const isDownloading = () => props.phase === "downloading" || props.phase === "ready";
  const hasError = () => Boolean(props.error);
  const title = () => {
    if (hasError()) return t("security.model_download_failed_title");
    if (props.phase === "ready") return t("security.model_download_ready_title");
    if (props.phase === "downloading") return t("security.model_download_downloading_title");
    return t("security.model_download_consent_title");
  };
  const body = () => {
    if (props.phase === "ready") return t("security.model_download_ready_body");
    if (props.phase === "downloading") return t("security.model_download_downloading_body");
    return t("security.model_download_consent_body");
  };
  const pct = () => {
    if (props.phase === "ready") return 100;
    if (props.totalBytes <= 0) return 0;
    return (props.doneBytes / props.totalBytes) * 100;
  };

  return (
    <Show when={props.open}>
      <div class="fixed inset-0 z-[100000] flex items-center justify-center dls-modal-backdrop p-4 [font-family:'Intel_One_Mono',ui-monospace,monospace]">
        <div
          data-testid="privacy-model-download-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="privacy-model-download-title"
          aria-describedby="privacy-model-download-description"
          class="w-[min(460px,92vw)] border p-5 space-y-4 dls-modal-surface"
        >
          <div class="flex items-center gap-2">
            <Show when={props.phase === "ready"} fallback={<Show when={hasError()} fallback={<Download size={16} class="text-dls-text" />}>
              <AlertTriangle size={16} class="text-dls-danger-text" />
            </Show>}>
              <CheckCircle2 size={16} class="text-dls-success-text" />
            </Show>
            <div id="privacy-model-download-title" class="text-body-lg font-semibold text-dls-text">{title()}</div>
          </div>

          <div id="privacy-model-download-description" class="text-caption text-dls-secondary leading-relaxed">{body()}</div>

          <Show when={props.phase === "consent"}>
            <div class="text-caption text-dls-secondary">
              <div class="font-medium">{t("security.model_download_models_heading")}</div>
              <ul class="mt-1 list-disc pl-5">
                <li>{t("security.model_download_pii_model")}</li>
              </ul>
            </div>
          </Show>

          <div class="rounded-inset border border-dls-border/50 bg-dls-panel-bg p-3">
            <div class="flex items-center gap-3">
              <Show when={isDownloading()} fallback={<Download size={15} class="shrink-0 text-dls-secondary" />}>
                <CircularProgress pct={pct()} done={props.phase === "ready"} />
              </Show>
              <div class="min-w-0 flex-1">
                <div class="text-caption text-dls-text">{t("security.model_download_name")}</div>
                <Show
                  when={isDownloading() && props.totalBytes > 0}
                  fallback={<div class="text-caption text-dls-secondary tabular-nums">{t("security.model_download_estimate")}</div>}
                >
                  <div class="text-label text-dls-secondary tabular-nums">
                    {formatMB(props.phase === "ready" ? props.totalBytes : props.doneBytes)} / {formatMB(props.totalBytes)}
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
            <Show when={hasError()} fallback={
              <Show when={props.phase === "consent"} fallback={
                <Show when={props.phase === "downloading"} fallback={
                  <span class="flex items-center gap-1.5 text-caption text-dls-success-text">
                    <CheckCircle2 size={12} />
                    {t("security.model_download_ready_hint")}
                  </span>
                }>
                  <span class="flex items-center gap-1.5 text-caption text-dls-secondary">
                    <Loader2 size={12} class="animate-spin" />
                    {t("security.model_download_in_progress")}
                  </span>
                </Show>
              }>
                <>
                  <Button variant="outline" class="text-caption h-8 py-0 px-4" onClick={props.onCancel}>
                    {t("security.model_download_cancel")}
                  </Button>
                  <Button variant="secondary" class="text-caption h-8 py-0 px-4" onClick={props.onConfirm}>
                    {t("security.model_download_confirm")}
                  </Button>
                </>
              </Show>
            }>
              <Button variant="outline" class="text-caption h-8 py-0 px-4" onClick={props.onCancel}>
                {t("security.model_download_cancel")}
              </Button>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  );
}
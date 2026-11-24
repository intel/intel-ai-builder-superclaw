/**
 * Shared confirmation dialog for model bundle switches.
 *
 * The real bundle switch runs when the user clicks "Apply model change". The
 * same dialog remains open for progress and resumable failures.
 */
import { createEffect, createUniqueId, For, onCleanup, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { Loader2, Check, X, Circle } from "lucide-solid";
import { t } from "~/i18n";
import Button from "./button";
import { resolveRestartDialogNotice } from "./restart-required-dialog-notice";
import {
  showsStepByteProgress,
  stepIsActive,
  type BundleSwitchStepState,
} from "~/shared/util/bundle-switch-step-progress";

export type BundleSwitchStep = {
  id: string;
  label: string;
  state: BundleSwitchStepState;
  role?: string;
  error_code?: string;
  error_detail?: string;
  /** Live byte counters, present only while the row is transferring. */
  doneBytes?: number;
  totalBytes?: number;
};

export type RestartRequiredDialogProps = {
  open: boolean;
  bundleLabel?: string;
  onNotNow: () => void;
  onApply?: () => void | Promise<void>;
  applying?: boolean;
  progressMessage?: string | null;
  progressError?: string | null;
  steps?: BundleSwitchStep[];
  resume?: boolean;
};

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

function stepIcon(state: BundleSwitchStepState) {
  switch (state) {
    case "complete":
      return <Check size={12} class="text-dls-success-text" />;
    case "error":
      return <X size={12} class="text-dls-danger-text" />;
    default:
      return stepIsActive(state) ? (
        <Loader2 size={12} class="animate-spin text-dls-warning-text" />
      ) : (
        <Circle size={12} class="text-dls-muted" />
      );
  }
}

/** `done / total` for a transferring row. All switch sizes are shown in MB. */
function stepBytes(step: BundleSwitchStep): string | null {
  if (!showsStepByteProgress(step.state)) return null;
  const total = step.totalBytes;
  if (total === undefined || total <= 0) return null;
  const done = step.doneBytes ?? 0;
  return `${(done / 1_000_000).toFixed(1)} MB / ${(total / 1_000_000).toFixed(1)} MB`;
}

function stepLabel(step: BundleSwitchStep): string {
  if (step.id.startsWith("step:")) {
    const key = `capability.probe_step.${step.id.slice(5)}`;
    const translated = t(key);
    if (translated && translated !== key) return translated;
  }
  if (step.role) {
    const key = `capability.bundle_step.${step.role}`;
    const translated = t(key);
    if (translated && translated !== key) {
      return step.label ? `${translated} — ${step.label}` : translated;
    }
  }
  return step.label || step.id;
}

function stepErrorMessage(step: BundleSwitchStep): string | null {
  if (step.state !== "error") return null;
  if (step.error_code) {
    const key = `capability.probe_error.${step.error_code}`;
    const translated = t(key);
    if (translated && translated !== key) return translated;
  }
  return step.error_detail || step.error_code || null;
}

export default function RestartRequiredDialog(props: RestartRequiredDialogProps) {
  const titleId = createUniqueId();
  const bodyId = createUniqueId();
  let dialogRef: HTMLDivElement | undefined;
  createEffect(() => {
    if (!props.open) return;
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    onCleanup(() => {
      if (returnFocus?.isConnected) returnFocus.focus();
    });
  });
  const applyEnabled = () => Boolean(props.onApply) && !props.applying;
  const hasSteps = () => (props.steps?.length ?? 0) > 0;
  // The checklist covers only the prepare probes, so a later-stage failure has no
  // row of its own; `resolveRestartDialogNotice` is what stops it being silently
  // swallowed (see that module for the #1682 detail).
  const notice = () =>
    resolveRestartDialogNotice({
      steps: props.steps,
      progressError: props.progressError,
      progressMessage: props.progressMessage,
    });
  const noticeError = () => {
    const current = notice();
    return current.kind === "error" ? current.text : null;
  };
  const noticeProgress = () => {
    const current = notice();
    return current.kind === "progress" ? current.text : null;
  };

  return (
    <Show when={props.open}>
      <Portal>
            {/* Backdrop is intentionally non-dismissive: outside-click must not
                silently abort a pending model-change decision. Do not add onClick
                here; require an explicit Cancel or Apply click. */}
            <div
              class="fixed inset-0 z-[100000] dls-modal-backdrop flex items-center justify-center font-sans"
              role="dialog"
              aria-modal="true"
              aria-labelledby={titleId}
              aria-describedby={bodyId}
              onKeyDown={(event) => {
                if (event.key === "Escape" && !props.applying) {
                  event.preventDefault();
                  event.stopPropagation();
                  props.onNotNow();
                  return;
                }
                if (event.key !== "Tab" || !dialogRef) return;
                const focusable = dialogRef.querySelectorAll<HTMLElement>(FOCUSABLE);
                if (focusable.length === 0) return;
                const first = focusable[0];
                const last = focusable[focusable.length - 1];
                if (event.shiftKey && document.activeElement === first) {
                  event.preventDefault();
                  last.focus();
                } else if (!event.shiftKey && document.activeElement === last) {
                  event.preventDefault();
                  first.focus();
                }
              }}
            >
              <div
                ref={(el) => {
                  dialogRef = el;
                  queueMicrotask(() => el.querySelector<HTMLElement>("button")?.focus());
                }}
                class="w-[min(460px,92vw)] border p-5 space-y-3 dls-modal-surface"
              >
          <h3 id={titleId} class="text-body-lg font-semibold text-dls-warning-text">
            {t("capability.model_change_title")}
          </h3>
          <div id={bodyId} class="text-caption text-dls-secondary leading-relaxed">
            {t("capability.model_change_body")}
          </div>
          <Show when={hasSteps()}>
            <div class="rounded-inset border border-dls-border/40 bg-dls-hover/30 p-3 space-y-1.5">
              <For each={props.steps}>
                {(step) => (
                  <div class="space-y-0.5">
                    <div class="flex items-center gap-2 text-caption">
                      <span class="w-3.5 h-3.5 flex items-center justify-center">
                        {stepIcon(step.state)}
                      </span>
                      <span
                        class={
                          step.state === "error"
                            ? "text-dls-danger-text"
                            : step.state === "complete"
                              ? "text-dls-text"
                              : stepIsActive(step.state)
                                ? "text-dls-warning-text"
                                : "text-dls-secondary"
                        }
                      >
                        {stepLabel(step)}
                      </span>
                      <Show when={stepBytes(step)}>
                        <span class="ml-auto shrink-0 text-label text-dls-secondary tabular-nums">
                          {stepBytes(step)}
                        </span>
                      </Show>
                    </div>
                    <Show when={stepErrorMessage(step)}>
                      <div class="pl-5 text-label leading-snug text-dls-danger-text/80">
                        └ {stepErrorMessage(step)}
                      </div>
                    </Show>
                  </div>
                )}
              </For>
            </div>
          </Show>
          <Show when={noticeError()}>
            <div class="text-caption text-dls-danger-text">{noticeError()}</div>
          </Show>
          <Show when={noticeProgress()}>
            <div class="text-caption text-dls-secondary">{noticeProgress()}</div>
          </Show>
          <div class="flex items-center justify-end gap-2 pt-1">
            <Button
              variant="outline"
              class="text-caption h-8 py-0 px-4"
              onClick={props.onNotNow}
              disabled={props.applying}
            >
              {t("capability.model_change_cancel")}
            </Button>
            <Button
              variant="secondary"
              class={`text-caption h-8 py-0 px-4 ${applyEnabled() ? "" : "opacity-40 cursor-not-allowed"}`}
              disabled={!applyEnabled()}
              onClick={() => void props.onApply?.()}
            >
              <Show
                when={props.applying}
                fallback={props.resume ? t("capability.model_change_resume") : t("capability.model_change_apply")}
              >
                <Loader2 size={12} class="animate-spin" />
              </Show>
            </Button>
          </div>
              </div>
            </div>
      </Portal>
    </Show>
  );
}

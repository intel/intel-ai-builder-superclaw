import { Show } from "solid-js";

import { AlertCircle, CheckCircle2, Info, X } from "lucide-solid";

import Button from "./button";

export type StatusToastProps = {
  open: boolean;
  title: string;
  description?: string | null;
  tone?: "success" | "info" | "error";
  actionLabel?: string;
  onAction?: () => void;
  dismissLabel?: string;
  onDismiss: () => void;
  "data-testid"?: string;
};

export default function StatusToast(props: StatusToastProps) {
  const tone = () => props.tone ?? "info";

  return (
    <Show when={props.open}>
      <div
        data-testid={props["data-testid"]}
        class="w-full max-w-[24rem] overflow-hidden rounded-shell border border-dls-border bg-dls-surface-solid font-sans shadow-[var(--dls-card-shadow)] backdrop-blur-xl"
      >
        <div class="flex items-start gap-3 px-4 py-4">
          <div
            class={`mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-card border ${
              tone() === "success"
                ? "border-dls-success-border bg-dls-success-bg text-dls-success-text"
                : tone() === "error"
                  ? "border-dls-danger-border bg-dls-danger-bg text-dls-danger-text"
                  : "border-dls-info-border bg-dls-info-bg text-dls-info-text"
            }`.trim()}
          >
            <Show
              when={tone() === "success"}
              fallback={
                <Show when={tone() === "error"} fallback={<Info size={18} />}>
                  <AlertCircle size={18} />
                </Show>
              }
            >
              <CheckCircle2 size={18} />
            </Show>
          </div>

          <div class="min-w-0 flex-1">
            <div class="flex items-start justify-between gap-3">
              <div>
                <div class="text-body text-dls-text">{props.title}</div>
                <Show when={props.description?.trim()}>
                  <p class="mt-1 text-body leading-relaxed text-dls-secondary">{props.description}</p>
                </Show>
              </div>

              <button
                type="button"
                onClick={props.onDismiss}
                data-testid={props["data-testid"] ? `${props["data-testid"]}-dismiss-btn` : undefined}
                class="rounded-pill p-1 text-dls-secondary transition hover:bg-dls-hover hover:text-dls-text"
                aria-label={props.dismissLabel ?? "Dismiss"}
              >
                <X size={16} />
              </button>
            </div>

            <Show when={props.actionLabel && props.onAction}>
              <div class="mt-3 flex items-center gap-2">
                <Button variant="primary" class="rounded-pill px-3 py-1.5 text-caption" onClick={() => props.onAction?.()}>
                  {props.actionLabel}
                </Button>
                <Button variant="ghost" class="rounded-pill px-3 py-1.5 text-caption" onClick={props.onDismiss}>
                  {props.dismissLabel ?? "Dismiss"}
                </Button>
              </div>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  );
}

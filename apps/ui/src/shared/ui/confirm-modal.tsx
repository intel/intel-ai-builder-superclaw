import { Show, createEffect, createUniqueId, onCleanup, type JSX } from "solid-js";

import { AlertTriangle } from "lucide-solid";

import Button from "./button";

export type ConfirmModalProps = {
  open: boolean;
  title: string;
  message: string | JSX.Element;
  confirmLabel: string;
  cancelLabel?: string;
  variant?: "danger" | "warning";
  confirmVariant?: "primary" | "danger";
  size?: "md" | "lg";
  hideIcon?: boolean;
  "data-testid"?: string;
  onConfirm: () => void;
  onCancel?: () => void;
};

const FOCUSABLE = 'button, [href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])';

/**
 * Takes focus on open (its first button, Cancel when there is one), keeps Tab inside the modal, cancels on
 * Escape when it can be cancelled, and gives focus back to whatever held it on close. Escape and Tab stop here, so
 * an overlay underneath does not act on them too.
 */
export default function ConfirmModal(props: ConfirmModalProps) {
  const variant = () => props.variant ?? "warning";
  const size = () => props.size ?? "md";
  const baseId = createUniqueId();
  let dialogEl: HTMLDivElement | undefined;

  createEffect(() => {
    if (!props.open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogEl?.querySelector<HTMLElement>("button:not([disabled])")?.focus();
    onCleanup(() => {
      if (opener?.isConnected && opener !== document.body) opener.focus({ preventScroll: true });
    });
  });

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape" && props.onCancel && !event.isComposing) {
      event.preventDefault();
      event.stopPropagation();
      props.onCancel();
      return;
    }
    if (event.key !== "Tab" || !dialogEl) return;
    const focusable = Array.from(dialogEl.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (el) => !el.hasAttribute("disabled") && el.getClientRects().length > 0,
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey ? active === first || !dialogEl.contains(active) : active === last) {
      event.preventDefault();
      event.stopPropagation();
      (event.shiftKey ? last : first).focus();
    }
  };

  return (
    <Show when={props.open}>
      <div class="fixed inset-0 z-[60] dls-modal-backdrop flex items-center justify-center p-4 font-sans">
        <div
          ref={dialogEl}
          role="alertdialog"
          aria-modal="true"
          aria-labelledby={`${baseId}-title`}
          aria-describedby={`${baseId}-message`}
          onKeyDown={onKeyDown}
          class="border w-full overflow-hidden dls-modal-surface"
          classList={{
            "max-w-md": size() === "md",
            "max-w-lg": size() === "lg",
          }}
        >
          <div class="p-6">
            <div class="flex items-start gap-4">
              <Show when={!props.hideIcon}>
                <div
                  class="shrink-0 w-10 h-10 rounded-pill flex items-center justify-center"
                  classList={{
                    "bg-dls-warning-bg text-dls-warning-text": variant() === "warning",
                    "bg-dls-danger-bg text-dls-danger-text": variant() === "danger",
                  }}
                >
                  <AlertTriangle size={20} />
                </div>
              </Show>
              <div class="min-w-0">
                <h3 id={`${baseId}-title`} class="text-title leading-title font-semibold text-dls-text">{props.title}</h3>
                <div id={`${baseId}-message`} class="mt-2 text-body-lg text-dls-secondary">
                  {typeof props.message === "string" ? <p>{props.message}</p> : props.message}
                </div>
              </div>
            </div>

            <div class="mt-6 flex justify-end gap-2">
              <Show when={props.cancelLabel && props.onCancel}>
                <Button variant="outline" onClick={props.onCancel} data-testid="modal-dismiss-btn">
                  {props.cancelLabel}
                </Button>
              </Show>
              <Button
                variant={
                  props.confirmVariant ??
                  (variant() === "danger" ? "danger" : "primary")
                }
                onClick={props.onConfirm}
                data-testid={props["data-testid"]}
              >
                {props.confirmLabel}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </Show>
  );
}

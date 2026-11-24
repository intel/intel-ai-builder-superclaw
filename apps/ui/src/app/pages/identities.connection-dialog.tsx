import { Show, createEffect, onCleanup, type JSX } from "solid-js";
import { X } from "lucide-solid";

import Button from "~/shared/ui/button";
import { t } from "../../i18n";
import { hasInnerLayer } from "./settings-dialog.layers";

/**
 * The in-app dialog a Connections row opens. Stacks under ConfirmModal and the GitHub device-login modal (z-60),
 * which its content may open.
 *
 * It takes focus on open and gives it back to the row on close. Settings keeps Tab inside the overlay that holds
 * focus and leaves Escape to it; this one closes on Escape unless an overlay its content opened is above it.
 */
export default function ConnectionDialog(props: {
  open: boolean;
  title: string;
  onClose: () => void;
  "data-testid"?: string;
  children: JSX.Element;
}) {
  let dialogEl: HTMLDivElement | undefined;

  createEffect(() => {
    if (!props.open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogEl?.focus();

    let escapeForInnerLayer = false;
    const onKeyDownCapture = (event: KeyboardEvent) => {
      if (event.key === "Escape" && dialogEl) escapeForInnerLayer = hasInnerLayer(dialogEl);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || event.defaultPrevented || escapeForInnerLayer) return;
      event.preventDefault();
      props.onClose();
    };
    window.addEventListener("keydown", onKeyDownCapture, true);
    window.addEventListener("keydown", onKeyDown);
    onCleanup(() => {
      window.removeEventListener("keydown", onKeyDownCapture, true);
      window.removeEventListener("keydown", onKeyDown);
      if (opener?.isConnected && opener !== document.body) opener.focus({ preventScroll: true });
    });
  });

  return (
    <Show when={props.open}>
      <div
        class="fixed inset-0 z-50 dls-modal-backdrop flex items-center justify-center p-4"
        onClick={(event) => {
          if (event.target === event.currentTarget) props.onClose();
        }}
      >
        <div
          ref={dialogEl}
          role="dialog"
          aria-modal="true"
          aria-label={props.title}
          tabIndex={-1}
          data-testid={props["data-testid"]}
          class="border w-full max-w-2xl overflow-hidden max-h-[calc(100vh-2rem)] flex flex-col dls-modal-surface outline-none"
        >
          <div class="px-6 pt-5 pb-4 border-b border-dls-border/50 flex items-center justify-between gap-4">
            <h3 class="text-heading font-semibold text-dls-text">{props.title}</h3>
            <Button
              variant="ghost"
              class="!p-2 rounded-pill"
              onClick={() => props.onClose()}
              aria-label={t("common.close")}
              data-testid="connection-dialog-close"
            >
              <X size={16} />
            </Button>
          </div>
          <div class="px-6 py-5 overflow-y-auto min-h-0 space-y-4">{props.children}</div>
        </div>
      </div>
    </Show>
  );
}

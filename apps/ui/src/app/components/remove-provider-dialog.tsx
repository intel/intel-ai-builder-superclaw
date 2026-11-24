/**
 * Asks before a cloud provider is removed. Removing signs the provider out, so
 * getting it back means going through sign-in again.
 *
 * Same look as the model-change dialog (`restart-required-dialog`), and like
 * it, rendered through a Portal so the backdrop covers the whole window rather
 * than only the Settings panel it is opened from. Keyboard and screen-reader
 * handling follows `settings.workspace-cleanup-confirm`: a labelled modal
 * dialog, focus on Cancel when it opens, Tab kept inside, Escape cancels, and
 * focus handed back to the caller's target when it closes.
 */
import { createUniqueId, onCleanup, Show } from "solid-js";
import { Portal } from "solid-js/web";

import Button from "./button";
import { t } from "../../i18n";

export type RemoveProviderDialogProps = {
  /** The provider's display name, or null when the dialog is closed. */
  providerName: string | null;
  /** The model removed with the provider, or null when it has none. */
  modelName: string | null;
  onConfirm: () => void;
  onCancel: () => void;
  /** Where focus goes on close. The dustbin that opened the dialog lives in a
   *  menu that closes as focus moves into the dialog, so the caller names
   *  something that stays on the page. */
  returnFocusTo?: () => HTMLElement | undefined;
};

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export default function RemoveProviderDialog(props: RemoveProviderDialogProps) {
  const titleId = createUniqueId();
  const bodyId = createUniqueId();
  const fill = (text: string) =>
    text.replaceAll("{provider}", props.providerName ?? "").replaceAll("{model}", props.modelName ?? "");

  return (
    <Show when={props.providerName !== null}>
      {(_open) => {
        let dialogRef: HTMLDivElement | undefined;
        onCleanup(() => {
          const target = props.returnFocusTo?.();
          if (target?.isConnected) target.focus();
        });

        return (
          <Portal>
            {/* Backdrop is intentionally non-dismissive, as in the model-change
                dialog: removing needs an explicit Cancel or Remove. */}
            <div
              class="fixed inset-0 z-[100000] flex items-center justify-center bg-black/55 font-sans"
              role="dialog"
              aria-modal="true"
              aria-labelledby={titleId}
              aria-describedby={bodyId}
              data-testid="remove-provider-dialog"
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  props.onCancel();
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
                  // Cancel first: Enter on a freshly opened destructive dialog must not remove.
                  queueMicrotask(() => el.querySelector<HTMLElement>("button")?.focus());
                }}
                class="w-[min(460px,92vw)] rounded-dialog border border-dls-panel-border bg-dls-surface-solid p-5 shadow-[var(--dls-card-shadow)] space-y-3"
              >
                <h3 id={titleId} class="text-body-lg font-semibold text-dls-warning-text">
                  {t("model.remove_provider_confirm_title")}
                </h3>
                {/* Two lines: what is removed, then what it takes to get it back. */}
                <div id={bodyId} class="text-caption text-dls-secondary leading-relaxed">
                  <p>
                    {fill(
                      props.modelName
                        ? t("model.remove_provider_confirm_removed")
                        : t("model.remove_provider_confirm_removed_no_model"),
                    )}
                  </p>
                  <p>{fill(t("model.remove_provider_confirm_sign_in"))}</p>
                </div>
                <div class="flex items-center justify-end gap-2 pt-1">
                  <Button
                    variant="outline"
                    class="text-caption h-8 py-0 px-4"
                    data-testid="remove-provider-cancel"
                    onClick={props.onCancel}
                  >
                    {t("common.cancel")}
                  </Button>
                  <Button
                    variant="secondary"
                    class="text-caption h-8 py-0 px-4"
                    data-testid="remove-provider-confirm"
                    onClick={props.onConfirm}
                  >
                    {t("model.remove_provider")}
                  </Button>
                </div>
              </div>
            </div>
          </Portal>
        );
      }}
    </Show>
  );
}

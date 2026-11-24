import { Show } from "solid-js";

import { t } from "../../i18n";
import Button from "../components/button";
import { formatBytes } from "../utils";
import type { WorkspaceCleanup } from "./settings.workspace-cleanup";

/** Accessible confirmation for every destructive cleanup path. */
export default function WorkspaceCleanupConfirmDialog(props: {
  cleanup: WorkspaceCleanup;
}) {
  let dialogRef: HTMLDivElement | undefined;
  return (
    <Show when={props.cleanup.confirmOpen()}>
      <div
        class="fixed inset-0 z-[80] dls-modal-backdrop flex items-center justify-center p-4"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cleanup-confirm-title"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            props.cleanup.closeConfirm(false);
            return;
          }
          if (e.key === "Tab" && dialogRef) {
            const focusable =
              dialogRef.querySelectorAll<HTMLElement>(
                'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
              );
            if (focusable.length === 0) return;
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (e.shiftKey && document.activeElement === first) {
              e.preventDefault();
              last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
              e.preventDefault();
              first.focus();
            }
          }
        }}
      >
        <div
          ref={(el) => {
            dialogRef = el;
            queueMicrotask(() =>
              el.querySelector<HTMLElement>("button")?.focus(),
            );
          }}
          class="border w-full max-w-md overflow-hidden p-5 space-y-3 dls-modal-surface"
        >
          <h3
            id="cleanup-confirm-title"
            class="text-body-lg font-semibold text-dls-text"
          >
            {props.cleanup.confirmPreview()?.context === "enable"
              ? t("settings.cleanup_confirm_enable_title")
              : props.cleanup.confirmPreview()?.context === "retention"
                ? t("settings.cleanup_confirm_retention_title")
                : t("settings.cleanup_confirm_title")}
          </h3>
          <Show when={props.cleanup.confirmPreview()}>
            {(preview) => (
              <p class="text-caption text-dls-secondary">
                {preview().dirs === 0 && preview().files === 0
                  ? t("settings.cleanup_confirm_nothing_left")
                  : (preview().context === "enable"
                      ? t("settings.cleanup_confirm_body_enable")
                      : preview().context === "retention"
                        ? t("settings.cleanup_confirm_body_retention")
                        : t("settings.cleanup_confirm_body_run_now")
                    ).replace("{freed}", formatBytes(preview().freed))}
              </p>
            )}
          </Show>

          <div class="flex items-center justify-end gap-2 pt-1">
            <Button
              variant="outline"
              class="text-caption h-8 px-3"
              onClick={() => props.cleanup.closeConfirm(false)}
            >
              {t("settings.cleanup_confirm_close")}
            </Button>
            <Button
              variant="secondary"
              class="text-caption h-8 px-3"
              onClick={() => props.cleanup.closeConfirm(true)}
            >
              {props.cleanup.confirmPreview()?.context === "run-now"
                ? t("settings.cleanup_confirm_confirm")
                : t("settings.cleanup_confirm_proceed")}
            </Button>
          </div>
        </div>
      </div>
    </Show>
  );
}

/** Exit-only dialog shown when SuperClaw runs with an elevated administrator token (#3176). */
import { Show } from "solid-js";
import { t } from "../../i18n";
import Button from "./button";

export type ElevationDialogProps = {
  open: boolean;
  onExit: () => void;
};

export default function ElevationDialog(props: ElevationDialogProps) {
  return (
    <Show when={props.open}>
      <div class="fixed inset-0 z-[100000] flex items-center justify-center dls-modal-backdrop">
        <div
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="elevation-dialog-title"
          aria-describedby="elevation-dialog-body elevation-dialog-hint"
          ref={(el) => queueMicrotask(() => el.querySelector<HTMLElement>("button")?.focus())}
          class="w-[min(460px,92vw)] border p-5 space-y-3 dls-modal-surface"
        >
          <h3 id="elevation-dialog-title" class="text-body-lg font-semibold text-dls-danger-text">{t("capability.elevated_title")}</h3>
          <div id="elevation-dialog-body" class="text-caption text-dls-secondary leading-relaxed">{t("capability.elevated_body")}</div>
          <div id="elevation-dialog-hint" class="text-caption text-dls-secondary leading-relaxed">{t("capability.elevated_hint")}</div>
          <div class="flex items-center justify-end gap-2 pt-1">
            <Button variant="secondary" class="text-caption h-8 py-0 px-4" onClick={props.onExit}>
              {t("capability.elevated_exit")}
            </Button>
          </div>
        </div>
      </div>
    </Show>
  );
}

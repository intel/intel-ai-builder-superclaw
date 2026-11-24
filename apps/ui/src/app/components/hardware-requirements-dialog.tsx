/**
 * Hardware requirements dialog — shown when the LRM preflight reports the
 * machine cannot run the local model (a hard resource failure).
 *
 * Two dismiss modes:
 *  - "exit"   (startup Init gate): the local model is required to boot, so the
 *             only action is to exit the app.
 *  - "cancel" (edge → llama switch): the user is already running on edge, so
 *             failing the switch just cancels it and returns to the app.
 *
 * Copy lists only the failing resource(s). The detail line ("need X GB, have
 * Y GB") is composed entirely on the frontend (i18n) from the structured
 * free_gb / required_gb figures — the backend message is not shown.
 */
import { For, Show } from "solid-js";
import { t } from "../../i18n";
import type { HardwareFailure } from "~/shared/platform/capability/preflight-policy";
import Button from "./button";

export type HardwareRequirementsDialogProps = {
  open: boolean;
  failures: HardwareFailure[];
  /**
   * Dismiss semantics. "exit" quits the app (startup hard block); "cancel"
   * just closes the dialog and aborts the switch (edge → llama). Defaults to
   * "exit" for the startup gate.
   */
  mode?: "exit" | "cancel";
  /** Invoked when the dismiss button is clicked (exit the app OR cancel the switch). */
  onDismiss: () => void;
};

/** Map a backend check kind to its localized requirement label. */
function failureLabel(kind: string): string {
  switch (kind) {
    case "available_memory":
      return t("capability.hardware_req_memory");
    case "model_memory":
      return t("capability.hardware_req_model_memory");
    case "disk_free":
      return t("capability.hardware_req_disk");
    default:
      return kind;
  }
}

const fmtGb = (gb: number): string => `${gb.toFixed(1)} GB`;

/** Localized "need X, have Y" detail from the structured figures. */
function failureDetail(failure: HardwareFailure): string | null {
  const { requiredGb, freeGb } = failure;
  if (requiredGb != null && freeGb != null) {
    return t("capability.hardware_req_detail")
      .replace("{required}", fmtGb(requiredGb))
      .replace("{free}", fmtGb(freeGb));
  }
  if (requiredGb != null) {
    return t("capability.hardware_req_detail_required").replace("{required}", fmtGb(requiredGb));
  }
  if (freeGb != null) {
    return t("capability.hardware_req_detail_free").replace("{free}", fmtGb(freeGb));
  }
  return null;
}

export default function HardwareRequirementsDialog(props: HardwareRequirementsDialogProps) {
  const dismissLabel = () =>
    props.mode === "cancel" ? t("capability.hardware_cancel") : t("capability.hardware_exit");

  return (
    <Show when={props.open}>
      <div class="fixed inset-0 z-[100000] flex items-center justify-center dls-modal-backdrop">
        <div class="w-[min(460px,92vw)] border p-5 space-y-3 dls-modal-surface">
          <div class="text-body-lg font-semibold text-dls-danger-text">
            {t("capability.hardware_insufficient_title")}
          </div>
          <div class="text-caption text-dls-secondary leading-relaxed">
            {t("capability.hardware_insufficient_body")}
          </div>
          <ul class="space-y-1.5">
            <For each={props.failures}>
              {(failure) => (
                <li class="text-caption text-dls-text">
                  <span class="font-medium">{failureLabel(failure.kind)}</span>
                  <Show when={failureDetail(failure)}>
                    <span class="text-dls-secondary"> — {failureDetail(failure)}</span>
                  </Show>
                </li>
              )}
            </For>
          </ul>
          <div class="flex items-center justify-end gap-2 pt-1">
            <Button variant="secondary" class="text-caption h-8 py-0 px-4" onClick={props.onDismiss}>
              {dismissLabel()}
            </Button>
          </div>
        </div>
      </div>
    </Show>
  );
}

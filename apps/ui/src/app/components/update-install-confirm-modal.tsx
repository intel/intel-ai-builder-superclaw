import ConfirmModal from "~/shared/ui/confirm-modal";

import { t } from "../../i18n";
import { updateInstallConfirmMessage } from "../lib/ota-update-state";
import { otaUpdateStore } from "../lib/ota-update-store";

/**
 * The one install confirmation behind every update button. Mount it once: the sidebar button
 * is rendered in both the sidebar and its drawer, so a per-button dialog would open twice.
 */
export default function UpdateInstallConfirmModal() {
  const ota = otaUpdateStore();
  return (
    <ConfirmModal
      open={ota.installConfirm() !== null}
      title={t("settings.update_install_confirm_title")}
      message={
        <p class="whitespace-pre-line">
          {updateInstallConfirmMessage(ota.installConfirm()?.activeRuns ?? false)}
        </p>
      }
      confirmLabel={t("settings.update_install_confirm_start")}
      cancelLabel={t("settings.update_install_confirm_cancel")}
      onConfirm={() => ota.answerInstallConfirm(true)}
      onCancel={() => ota.answerInstallConfirm(false)}
    />
  );
}

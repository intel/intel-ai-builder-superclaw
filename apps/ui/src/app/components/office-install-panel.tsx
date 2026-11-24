import { createSignal, onCleanup, Show } from "solid-js";
import { Loader2 } from "lucide-solid";
import Button from "~/shared/ui/button";
import { t } from "../../i18n";
import { usePlatform } from "../context/platform";
import type { OfficeInstallState } from "../lib/office-preview-install";

const LIBREOFFICE_DOWNLOAD_URL = "https://www.libreoffice.org/download/";
const LIBREOFFICE_LICENSE_URL = "https://www.libreoffice.org/licenses/";

const formatElapsed = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

/**
 * How long the install has been going, so a long wait still shows that it is alive. It counts from
 * `since` (when the install began, once the sandbox manager has said), so a preview opened halfway
 * through does not start again from zero.
 */
function ElapsedTime(props: { since?: number }) {
  const opened = Date.now();
  const [seconds, setSeconds] = createSignal(0);
  const tick = () => setSeconds(Math.max(0, Math.floor((Date.now() - (props.since ?? opened)) / 1000)));
  const timer = setInterval(tick, 1000);
  onCleanup(() => clearInterval(timer));
  return (
    <p class="mt-2 text-caption text-dls-secondary" data-testid="office-install-elapsed">
      {t("session.office_preview_install_elapsed")} {formatElapsed(seconds())}
    </p>
  );
}

type Props = {
  state: OfficeInstallState;
  /** The preview's own message, shown after "Not now". */
  unavailableMessage: string | null;
  onOffer: () => void;
  onInstall: () => void;
  /** Load the preview again, after LibreOffice was installed by hand. */
  onRecheck: () => void;
  onDecline: () => void;
};

/** Offer, progress and outcome of installing LibreOffice with winget, shown inside the preview modal. */
export default function OfficeInstallPanel(props: Props) {
  const platform = usePlatform();

  // What winget is doing now, as far as the sandbox manager has told us.
  const progressText = () => {
    const phase = props.state.step === "installing" ? props.state.phase : undefined;
    return t(
      phase === "downloading"
        ? "session.office_preview_install_downloading"
        : phase === "installing"
          ? "session.office_preview_install_installing"
          : "session.office_preview_install_starting",
    );
  };

  return (
    <div class="mx-auto max-w-md py-10 text-center" data-testid="office-install-panel">
      <Show when={props.state.step === "offer"}>
        <h3 class="text-title leading-title font-semibold text-dls-text">
          {t("session.office_preview_install_title")}
        </h3>
        <p class="mt-2 text-body-lg text-dls-secondary">{t("session.office_preview_install_message")}</p>
        <p class="mt-2 text-body-lg text-dls-secondary">{t("session.office_preview_install_license")}</p>
        <div class="mt-1 flex justify-center">
          <Button
            variant="ghost"
            onClick={() => void platform.openLink(LIBREOFFICE_LICENSE_URL)}
            data-testid="office-install-license-link"
          >
            {t("session.office_preview_install_license_link")}
          </Button>
        </div>
        <div class="mt-6 flex justify-center gap-2">
          <Button variant="outline" onClick={props.onDecline} data-testid="office-install-decline">
            {t("session.office_preview_install_cancel")}
          </Button>
          <Button onClick={props.onInstall} data-testid="office-install-confirm">
            {t("session.office_preview_install_confirm")}
          </Button>
        </div>
      </Show>

      <Show when={props.state.step === "manual"}>
        <p class="text-body-lg text-dls-secondary">{t("session.office_preview_install_manual")}</p>
        <div class="mt-6 flex justify-center gap-2">
          <Button
            variant="ghost"
            onClick={() => void platform.openLink(LIBREOFFICE_DOWNLOAD_URL)}
            data-testid="office-install-download-link"
          >
            {t("session.office_preview_install_download_link")}
          </Button>
          <Button onClick={props.onRecheck} data-testid="office-install-recheck">
            {t("session.office_preview_install_retry")}
          </Button>
        </div>
      </Show>

      <Show when={props.state.step === "unreachable" || props.state.step === "installed_elsewhere"}>
        <p class="text-body-lg text-dls-secondary">
          {t(
            props.state.step === "installed_elsewhere"
              ? "session.office_preview_install_elsewhere"
              : "session.office_preview_install_unreachable",
          )}
        </p>
        <div class="mt-6 flex justify-center">
          <Button onClick={props.onRecheck} data-testid="office-install-recheck">
            {t("session.office_preview_install_retry")}
          </Button>
        </div>
      </Show>

      <Show when={props.state.step === "declined"}>
        <p class="text-body-lg text-dls-secondary">{props.unavailableMessage}</p>
        <div class="mt-6 flex justify-center">
          <Button onClick={props.onOffer} data-testid="office-install-offer">
            {t("session.office_preview_install_confirm")}
          </Button>
        </div>
      </Show>

      <Show when={props.state.step === "installing"}>
        <div class="flex items-center justify-center gap-2 text-dls-secondary" role="status">
          <Loader2 size={18} class="animate-spin" />
          <span class="text-body-lg" data-testid="office-install-progress">
            {progressText()}
          </span>
        </div>
        <ElapsedTime since={props.state.step === "installing" ? props.state.startedAt : undefined} />
      </Show>

      <Show when={props.state.step === "failed"}>
        <p class="text-body-lg text-dls-danger-text">{t("session.office_preview_install_failed")}</p>
        <div class="mt-6 flex justify-center gap-2">
          <Button
            variant="ghost"
            onClick={() => void platform.openLink(LIBREOFFICE_DOWNLOAD_URL)}
            data-testid="office-install-download-link"
          >
            {t("session.office_preview_install_download_link")}
          </Button>
          <Button onClick={props.onInstall} data-testid="office-install-retry">
            {t("session.office_preview_install_retry")}
          </Button>
        </div>
      </Show>
    </div>
  );
}

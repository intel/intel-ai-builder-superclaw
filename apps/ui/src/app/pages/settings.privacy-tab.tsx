import { Show, createMemo, createSignal } from "solid-js";
import SecuritySettingsSection, {
  type SecuritySettingsAvailability,
} from "../components/security-settings-section";
import type {
  OpenworkRuntimeSettings,
  OpenworkRuntimeSettingsPatch,
  OpenworkServerStatus,
} from "../lib/openwork-server";
import { useCapabilityGate } from "~/shared/platform/capability/capability-gate";
import { hdrPrivacyVisible } from "../lib/settings-visibility";
import { t } from "../../i18n";

type LocalFilePrivacy = "share_with_cloud" | "do_not_share_with_cloud";

export type PrivacyTabProps = {
  runtimeSettings: OpenworkRuntimeSettings | null;
  runtimeSettingsStatus: "idle" | "loading" | "saving" | "error";
  saveRuntimeSettings: (patch: OpenworkRuntimeSettingsPatch) => Promise<void>;
  openworkServerStatus: OpenworkServerStatus;
  openworkServerWorkspaceId: string | null;
};

export default function PrivacyTab(props: PrivacyTabProps) {
  const capability = useCapabilityGate();
  const [status, setStatus] = createSignal<string | null>(null);
  const [fileProtection, setFileProtection] =
    createSignal<SecuritySettingsAvailability | null>(null);

  const showHdrPrivacy = () => hdrPrivacyVisible(capability);

  const busy = createMemo(
    () =>
      props.runtimeSettingsStatus === "loading" ||
      props.runtimeSettingsStatus === "saving",
  );
  const unavailable = createMemo(
    () =>
      props.openworkServerStatus !== "connected" ||
      !props.openworkServerWorkspaceId,
  );
  const localFilePrivacy = createMemo<LocalFilePrivacy>(
    () =>
      props.runtimeSettings?.deepResearch?.localFilePrivacy ??
      "do_not_share_with_cloud",
  );

  const setLocalFilePrivacy = async (value: LocalFilePrivacy) => {
    if (value === localFilePrivacy()) return;
    setStatus(null);
    try {
      await props.saveRuntimeSettings({
        deepResearch: { localFilePrivacy: value },
      });
      setStatus(t("settings.deep_research_privacy_saved"));
    } catch (error) {
      setStatus(
        error instanceof Error
          ? error.message
          : t("settings.deep_research_privacy_save_failed"),
      );
    }
  };

  const optionClass = (value: LocalFilePrivacy) =>
    `rounded-inset border px-3 py-3 text-left transition-colors ${localFilePrivacy() === value ? "border-dls-accent bg-dls-accent/10 text-dls-text" : "border-dls-border-strong bg-dls-panel-inset-bg text-dls-secondary hover:bg-dls-surface-raised"}`;
  const dotClass = (value: LocalFilePrivacy) =>
    `h-3 w-3 rounded-pill border ${localFilePrivacy() === value ? "border-dls-accent bg-dls-accent" : "border-dls-border-strong"}`;

  return (
    <div class="space-y-6" data-testid="settings-privacy-content">
      <div>
        <h2 class="text-display-lg font-bold text-dls-text">
          {t("settings.privacy_tab_title")}
        </h2>
      </div>

      <SecuritySettingsSection onAvailabilityChange={setFileProtection} />

      <Show when={fileProtection() === "unavailable"}>
        <div
          data-testid="settings-privacy-file-protection-unavailable"
          class="rounded-card border border-dls-warning-border bg-dls-warning-bg p-5 text-body-lg text-dls-warning-text"
        >
          {t("settings.privacy_file_protection_unavailable")}
        </div>
      </Show>

      <Show when={showHdrPrivacy()}>
        <div data-settings-anchor="hdr_privacy" class="bg-dls-panel-bg border border-dls-panel-border rounded-card p-5 space-y-4">
          <div>
            <div class="text-body-lg font-medium text-dls-text">
              {t("settings.deep_research_privacy_title")}
            </div>
          </div>
          <div class="grid gap-2 sm:grid-cols-2">
            <button
              type="button"
              class={optionClass("share_with_cloud")}
              onClick={() => void setLocalFilePrivacy("share_with_cloud")}
              disabled={unavailable() || busy()}
            >
              <div class="flex items-center gap-2 text-body-lg font-semibold">
                <span class={dotClass("share_with_cloud")} />
                {t("settings.deep_research_privacy_share_title")}
              </div>
            </button>
            <button
              type="button"
              class={optionClass("do_not_share_with_cloud")}
              onClick={() => void setLocalFilePrivacy("do_not_share_with_cloud")}
              disabled={unavailable() || busy()}
            >
              <div class="flex items-center gap-2 text-body-lg font-semibold">
                <span class={dotClass("do_not_share_with_cloud")} />
                {t("settings.deep_research_privacy_no_share_title")}
              </div>
            </button>
          </div>
          <Show when={status()}>
            {(value) => <div class="text-caption text-dls-secondary">{value()}</div>}
          </Show>
        </div>
      </Show>

      <Show when={fileProtection() === "unsupported" && !showHdrPrivacy()}>
        <div
          data-testid="settings-privacy-empty"
          class="rounded-card border border-dls-panel-border bg-dls-panel-bg p-5 text-body-lg text-dls-secondary"
        >
          {t("settings.privacy_tab_empty")}
        </div>
      </Show>
    </div>
  );
}

import { For, Show } from "solid-js";
import Button from "../components/button";
import ToggleSwitch from "~/shared/ui/toggle-switch";
import UpdateAvailabilityBar from "../components/update-availability-bar";
import { useCapabilityGate } from "~/shared/platform/capability/capability-gate";
import { backendLifecycleVisible, desktopSettingVisible } from "../lib/settings-visibility";
import { LANGUAGE_OPTIONS, t } from "../../i18n";
import type { WorkspaceCleanup } from "./settings.workspace-cleanup";
import WorkspaceCleanupSection from "./settings.workspace-cleanup-section";
import type { SettingsViewProps } from "./settings.types";

export type AppSettingsTabProps = Pick<
  SettingsViewProps,
  | "busy"
  | "themeMode"
  | "setThemeMode"
  | "language"
  | "setLanguage"
  | "updateStatus"
  | "updateEnv"
  | "checkForUpdates"
  | "openUpdateDownloadPage"
  | "fullTelemetryEnabled"
  | "setFullTelemetryEnabled"
  | "baselineTelemetryEnabled"
  | "setBaselineTelemetryEnabled"
  | "resetInstallId"
  | "resetInstallIdFeedback"
  | "keepBackendOnExit"
  | "setKeepBackendOnExit"
> & {
  cleanup: WorkspaceCleanup;
};

export default function AppSettingsTab(props: AppSettingsTabProps) {
  // Backend lifecycle toggle is retired under capability gating (the restart saga
  // handles shutdown conflicts). Dark-safe: only hidden once a capability Profile
  // is active; otherwise the current toggle stays visible.
  const capability = useCapabilityGate();

  return (
    <div class="space-y-6" data-testid="settings-app-content">
      <div>
        <h2 class="text-display-lg font-bold text-dls-text">
          {t("settings.app_settings_title")}
        </h2>
      </div>

      <UpdateAvailabilityBar
        updateStatus={props.updateStatus}
        updateEnv={props.updateEnv}
        busy={props.busy}
        checkForUpdates={props.checkForUpdates}
        openUpdateDownloadPage={props.openUpdateDownloadPage}
      />

      <div data-settings-anchor="appearance" class="bg-dls-panel-bg border border-dls-panel-border rounded-card p-5 space-y-4">
        <div class="text-body-lg font-medium text-dls-text">
          {t("settings.appearance_title")}
        </div>

        <div data-settings-anchor="theme" class="flex flex-wrap gap-2">
          <Button
            variant={props.themeMode === "system" ? "secondary" : "outline"}
            class="text-caption h-8 py-0 px-3"
            data-testid="system-btn"
            onClick={() => props.setThemeMode("system")}
            disabled={props.busy}
          >
            {t("settings.theme_system")}
          </Button>
          <Button
            variant={props.themeMode === "light" ? "secondary" : "outline"}
            class="text-caption h-8 py-0 px-3"
            data-testid="light-btn"
            onClick={() => props.setThemeMode("light")}
            disabled={props.busy}
          >
            {t("settings.theme_light")}
          </Button>
          <Button
            variant={props.themeMode === "dark" ? "secondary" : "outline"}
            class="text-caption h-8 py-0 px-3"
            data-testid="dark-btn"
            onClick={() => props.setThemeMode("dark")}
            disabled={props.busy}
          >
            {t("settings.theme_dark")}
          </Button>
        </div>

        <div data-settings-anchor="language" class="space-y-2">
          <div class="text-caption font-medium text-dls-secondary">
            {t("settings.language")}
          </div>
          <div class="flex flex-wrap gap-2">
            <For each={LANGUAGE_OPTIONS}>
              {(option) => (
                <Button
                  variant={
                    props.language === option.value ? "secondary" : "outline"
                  }
                  class="text-caption h-8 py-0 px-3"
                  onClick={() => props.setLanguage(option.value)}
                  disabled={props.busy}
                >
                  {option.nativeName}
                </Button>
              )}
            </For>
          </div>
        </div>
      </div>

      <WorkspaceCleanupSection cleanup={props.cleanup} />

      <Show when={desktopSettingVisible()}>
        <div data-settings-anchor="telemetry" class="bg-dls-panel-bg border border-dls-panel-border rounded-card p-5 space-y-3">
          <div class="text-body-lg font-medium text-dls-text">{t("settings.telemetry_title")}</div>
          <div data-settings-anchor="telemetry_usage" class="flex items-start justify-between bg-dls-panel-inset-bg p-3 rounded-inset border border-dls-border-strong gap-3">
            <div class="min-w-0">
              <div class="text-body-lg text-dls-text">{t("settings.telemetry_baseline_enable")}</div>
              <div class="text-caption text-dls-secondary">
                {t("settings.telemetry_baseline_enable_desc")}
              </div>
              <details class="group">
                <summary class="mt-1 cursor-pointer list-none select-none text-caption text-dls-secondary">
                  <span class="inline-block transition-transform group-open:rotate-90">▸</span>
                  {" "}
                  {t("settings.telemetry_details")}
                </summary>
                <ul class="mt-2 space-y-1 text-caption text-dls-secondary list-disc list-inside">
                  <li>{t("settings.telemetry_baseline_identity")}</li>
                  <li>{t("settings.telemetry_baseline_health")}</li>
                  <li>{t("settings.telemetry_baseline_usage")}</li>
                  <li>{t("settings.telemetry_excludes")}</li>
                </ul>
              </details>
            </div>
            <ToggleSwitch
              checked={props.baselineTelemetryEnabled}
              onChange={props.setBaselineTelemetryEnabled}
              disabled={props.busy}
              aria-label={t("settings.telemetry_baseline_enable")}
            />
          </div>
          <div data-settings-anchor="telemetry_crash" class="flex items-start justify-between bg-dls-panel-inset-bg p-3 rounded-inset border border-dls-border-strong gap-3">
            <div class="min-w-0">
              <div class="text-body-lg text-dls-text">{t("settings.telemetry_enable")}</div>
              <div class="text-caption text-dls-secondary">
                {t("settings.telemetry_crash_enable_desc")}
              </div>
              <details class="group">
                <summary class="mt-1 cursor-pointer list-none select-none text-caption text-dls-secondary">
                  <span class="inline-block transition-transform group-open:rotate-90">▸</span>
                  {" "}
                  {t("settings.telemetry_details")}
                </summary>
                <ul class="mt-2 space-y-1 text-caption text-dls-secondary list-disc list-inside">
                  <li>{t("settings.telemetry_crash_identity")}</li>
                  <li>{t("settings.telemetry_crash_diagnostics")}</li>
                </ul>
              </details>
            </div>
            <ToggleSwitch
              checked={props.fullTelemetryEnabled}
              onChange={props.setFullTelemetryEnabled}
              disabled={props.busy}
              aria-label={t("settings.telemetry_enable")}
            />
          </div>
          <div data-settings-anchor="reset_install_id" class="flex items-center justify-between bg-dls-panel-inset-bg p-3 rounded-inset border border-dls-border-strong gap-3">
            <div class="min-w-0">
              <div class="text-body-lg text-dls-text">{t("settings.telemetry_reset_install_id")}</div>
              <div class="text-caption text-dls-secondary">
                {t("settings.telemetry_reset_install_id_desc")}
              </div>
            </div>
            <Button
              variant="secondary"
              onClick={props.resetInstallId}
              disabled={props.busy}
            >
              {t("settings.telemetry_reset_install_id_action")}
            </Button>
          </div>
          <Show when={props.resetInstallIdFeedback !== "idle"}>
            <div class={`text-caption px-1 ${props.resetInstallIdFeedback === "success" ? "text-dls-success-text" : "text-dls-danger-text"}`}>
              {props.resetInstallIdFeedback === "success"
                ? t("settings.telemetry_reset_install_id_success")
                : t("settings.telemetry_reset_install_id_error")}
            </div>
          </Show>
        </div>
      </Show>

      <Show when={backendLifecycleVisible(capability)}>
        <div data-settings-anchor="backend_lifecycle" class="bg-dls-panel-bg border border-dls-panel-border rounded-card p-5 space-y-3">
          <div class="text-body-lg font-medium text-dls-text">
            {t("settings.backend_lifecycle_title")}
          </div>
          <div data-settings-anchor="keep_backend" class="flex items-center justify-between bg-dls-panel-inset-bg p-3 rounded-inset border border-dls-border-strong gap-3">
            <div class="min-w-0">
              <div class="text-body-lg text-dls-text">
                {t("settings.keep_backend_running")}
              </div>
              <div class="text-caption text-dls-secondary">
                {t("settings.keep_backend_running_desc")}
              </div>
            </div>
            <ToggleSwitch
              checked={props.keepBackendOnExit}
              onChange={props.setKeepBackendOnExit}
              disabled={props.busy}
              aria-label={t("settings.keep_backend_running")}
            />
          </div>
        </div>
      </Show>
    </div>
  );
}

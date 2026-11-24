import { For, Show } from "solid-js";

import { t } from "../../i18n";
import Button from "../components/button";
import ToggleSwitch from "~/shared/ui/toggle-switch";
import { desktopSettingVisible } from "../lib/settings-visibility";
import { formatBytes, formatRelativeTime } from "../utils";
import {
  CLEANUP_RETENTION_PRESETS,
  type WorkspaceCleanup,
} from "./settings.workspace-cleanup";

/** Workspace file-cleanup card on the Advanced tab. */
export default function WorkspaceCleanupSection(props: {
  cleanup: WorkspaceCleanup;
}) {
  return (
    <Show when={desktopSettingVisible()}>
      <div data-settings-anchor="file_cleanup" class="bg-dls-panel-bg border border-dls-panel-border rounded-card p-5 space-y-3">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <div class="text-body-lg font-medium text-dls-panel-text">
              {t("settings.file_cleanup_title")}
            </div>
            <div class="text-caption text-dls-secondary mt-0.5">
              {t("settings.file_cleanup_subtitle").replace(
                "{retentionDays}",
                String(props.cleanup.currentSettings().retentionDays),
              )}
            </div>
          </div>
          <Button
            data-settings-anchor="cleanup_run_now"
            variant="outline"
            class="text-caption h-7 px-3 shrink-0"
            onClick={() => void props.cleanup.runNow()}
            disabled={props.cleanup.runNowBusy() || props.cleanup.settingsBusy() || props.cleanup.settingsUnavailable()}
          >
            {props.cleanup.runNowBusy() && !props.cleanup.confirmOpen()
              ? t("settings.cleanup_run_now_busy")
              : t("settings.cleanup_run_now")}
          </Button>
        </div>

        {/* A failed read or write must say so: otherwise the controls are
            either disabled or silently snap back with no explanation. */}
        <Show when={props.cleanup.settingsError() && !props.cleanup.settingsBusy()}>
          <div class="flex items-start justify-between gap-3 rounded-inset border border-dls-warning-border bg-dls-warning-bg px-3 py-2">
            <div class="min-w-0 text-caption text-dls-warning-text">
              <div>
                {props.cleanup.settingsUnavailable()
                  ? t("settings.cleanup_unavailable")
                  : t("settings.cleanup_save_failed")}
              </div>
              <Show when={props.cleanup.settingsError()}>
                {(msg) => (
                  <div class="mt-0.5 truncate text-dls-secondary" title={msg()}>
                    {msg()}
                  </div>
                )}
              </Show>
            </div>
            <Button
              variant="outline"
              class="text-caption h-7 px-3 shrink-0"
              onClick={() => void props.cleanup.reloadSettings()}
            >
              {t("settings.cleanup_unavailable_retry")}
            </Button>
          </div>
        </Show>

        {/* Message message */}
        <Show when={props.cleanup.runNowResult()}>
          {(res) =>
            res().kind === "info" ? (
              <div class="text-caption text-dls-secondary px-1">
                {res().text}
              </div>
            ) : (
              <div
                class={`flex items-start gap-2 rounded-inset border px-3 py-2 text-caption ${res().kind === "error"
                    ? "bg-dls-danger-bg text-dls-danger-text"
                    : "bg-dls-success-bg text-dls-success-text"
                }`}
              >
                <span>{res().text}</span>
              </div>
            )
          }
        </Show>

        {/* Disk threshold warning banner */}
        <Show
          when={
            props.cleanup.status()?.disk_level !== "ok" &&
            props.cleanup.status()?.disk_level != null
          }
        >
          <div
            class={`flex items-start justify-between gap-2 rounded-inset border px-3 py-2 text-caption ${props.cleanup.status()?.disk_level === "critical"
                ? "bg-dls-danger-bg border-dls-danger-border text-dls-danger-text"
                : "bg-dls-warning-bg border-dls-warning-border text-dls-warning-text"
            }`}
          >
            <span>
              {props.cleanup.status()?.disk_level === "critical"
                ? (props.cleanup.currentSettings().enabled
                  ? t("settings.cleanup_disk_critical").replace("{size}", formatBytes(props.cleanup.status()!.intermediate_bytes)).replace("{limit}", formatBytes(props.cleanup.status()!.critical_bytes))
                  : t("settings.cleanup_disk_critical_disabled").replace("{size}", formatBytes(props.cleanup.status()!.intermediate_bytes)).replace("{limit}", formatBytes(props.cleanup.status()!.critical_bytes)))
                : t("settings.cleanup_disk_warn").replace("{size}", formatBytes(props.cleanup.status()!.intermediate_bytes)).replace("{limit}", formatBytes(props.cleanup.status()!.warn_bytes))}
            </span>
            <Show when={props.cleanup.status()?.disk_level === "critical" && !props.cleanup.currentSettings().enabled}>
              <button
                type="button"
                class="shrink-0 rounded-control border border-dls-danger-border-strong px-2 py-1 text-label font-medium text-dls-danger-text hover:bg-dls-danger-bg disabled:opacity-50"
                onClick={() => void props.cleanup.runNow()}
                disabled={props.cleanup.runNowBusy() || props.cleanup.settingsBusy() || props.cleanup.settingsUnavailable()}
              >
                {props.cleanup.runNowBusy() && !props.cleanup.confirmOpen()
                  ? t("settings.cleanup_run_now_busy")
                  : t("settings.cleanup_disk_allow_delete")}
              </button>
            </Show>
          </div>
        </Show>

        {/* How much of the total the next scheduled run will remove */}
        <Show when={props.cleanup.currentSettings().enabled && (props.cleanup.status()?.reclaimable_bytes ?? 0) > 0}>
          <div class="text-caption text-dls-secondary">
            {t("settings.cleanup_reclaimable_note")
              .replace("{size}", formatBytes(props.cleanup.status()!.reclaimable_bytes))
              .replace("{days}", String(props.cleanup.currentSettings().retentionDays))}
          </div>
        </Show>

        {/* Post-hoc emergency cleanup notice  */}
        <Show when={props.cleanup.status()?.last_emergency_cleanup_at != null}>
          <div class="flex items-start gap-2 rounded-inset border border-dls-warning-border bg-dls-warning-bg px-3 py-2 text-caption text-dls-warning-text">
            <span>
              {t("settings.cleanup_emergency_notice").replace(
                "{when}",
                formatRelativeTime(
                  props.cleanup.status()!.last_emergency_cleanup_at! * 1000,
                ),
              )}
            </span>
          </div>
        </Show>

        {/* Cleanup info*/}
        <Show when={props.cleanup.status()}>
          {(status) => (
            <div class="grid grid-cols-2 gap-2 pt-1">
              <div
                class={`rounded-inset px-3 py-2 text-center border ${
                  status().disk_level === "critical"
                    ? "bg-dls-danger-bg border-dls-danger-border"
                    : status().disk_level === "warn"
                      ? "bg-dls-warning-bg border-dls-warning-border"
                      : "bg-dls-panel-inset-bg border-dls-panel-inset-border"
                }`}
              >
                <div class="text-caption text-dls-secondary">
                  {t("settings.cleanup_info_folder_size")}
                </div>
                <div
                  class={`text-body-lg font-medium mt-0.5 ${
                    status().disk_level === "critical"
                      ? "text-dls-danger-text"
                      : status().disk_level === "warn"
                        ? "text-dls-warning-text"
                        : "text-dls-panel-text"
                  }`}
                >
                  {formatBytes(status().intermediate_bytes)}
                </div>
              </div>
              <div class="rounded-inset bg-dls-panel-inset-bg border border-dls-panel-inset-border px-3 py-2 text-center">
                <div class="text-caption text-dls-secondary">
                  {t("settings.cleanup_info_last_run")}
                </div>
                <div class="text-body-lg font-medium text-dls-panel-text mt-0.5">
                  {status().last_cleaned_at != null
                    ? formatRelativeTime(
                        status().last_cleaned_at! * 1000,
                      )
                    : t("settings.cleanup_info_never")}
                </div>
              </div>
            </div>
          )}
        </Show>
        <div class="rounded-inset border border-dls-panel-inset-border bg-dls-panel-inset-bg p-3 space-y-3">
          <div data-settings-anchor="cleanup_auto" class="flex items-center justify-between gap-3">
            <div class="min-w-0">
              <div class="text-body-lg text-dls-panel-text">
                {t("settings.enable_file_cleanup")}
              </div>
            </div>
            <div class="flex items-center gap-2 shrink-0">
              <Show when={props.cleanup.enableCheckBusy()}>
                <span class="text-caption text-dls-secondary">
                  {t("settings.cleanup_checking")}
                </span>
              </Show>
              <ToggleSwitch
                checked={props.cleanup.currentSettings().enabled}
                onChange={(v) => void props.cleanup.setEnabled(v)}
                disabled={props.cleanup.settingsBusy() || props.cleanup.settingsUnavailable() || props.cleanup.enableCheckBusy()}
                aria-label={t("settings.enable_file_cleanup")}
              />
            </div>
          </div>

          <Show when={props.cleanup.currentSettings().enabled}>
            <div data-settings-anchor="cleanup_retention" class="pt-2 border-t border-dls-panel-divider space-y-1.5">
              <div class="text-caption text-dls-secondary">
                {t("settings.cleanup_retention_label")}
              </div>
              <div class="flex flex-wrap items-center gap-1.5">
                <For each={CLEANUP_RETENTION_PRESETS}>
                  {(days) => {
                    const selected = () => props.cleanup.currentSettings().retentionDays === days;
                    return (
                      <button
                        type="button"
                        class={`text-caption h-7 px-3 rounded-control border transition-colors ${selected()
                            ? "border-dls-accent bg-dls-accent/10 text-dls-text"
                            : "border-dls-panel-input-border bg-dls-panel-input-bg text-dls-panel-icon hover:bg-dls-panel-hover-bg"
                        }`}
                        disabled={props.cleanup.settingsBusy() || props.cleanup.settingsUnavailable() || props.cleanup.retentionCheckBusy()}
                        onClick={() => void props.cleanup.selectRetention(days)}
                      >
                        {days} {t("settings.cleanup_retention_days")}
                      </button>
                    );
                  }}
                </For>
                <Show
                  when={!props.cleanup.retentionCustomOpen()}
                  fallback={
                    <div class="inline-flex items-center gap-1">
                      <input
                        type="number"
                        min={1}
                        max={30}
                        autofocus
                        class="w-16 h-7 rounded-control border border-dls-panel-input-border bg-dls-panel-input-bg px-2 text-caption text-dls-panel-text outline-none focus:border-dls-accent"
                        value={props.cleanup.retentionCustomValue()}
                        onInput={(e) =>
                          props.cleanup.setRetentionCustomValue(
                            (e.target as HTMLInputElement).value,
                          )
                        }
                        onKeyDown={(e) => {
                          if (e.key === "Enter")
                            void props.cleanup.submitCustomRetention();
                          if (e.key === "Escape") {
                            e.preventDefault();
                            props.cleanup.setRetentionCustomOpen(false);
                            props.cleanup.setRetentionCustomValue("");
                          }
                        }}
                        disabled={props.cleanup.settingsBusy() || props.cleanup.settingsUnavailable() || props.cleanup.retentionCheckBusy()}
                      />
                      <Button
                        variant="secondary"
                        type="button"
                        disabled={props.cleanup.settingsBusy() || props.cleanup.settingsUnavailable() || props.cleanup.retentionCheckBusy() || !props.cleanup.retentionCustomValue().trim()}
                        onClick={() => void props.cleanup.submitCustomRetention()}
                      >
                        {t("settings.save")}
                      </Button>
                    </div>
                  }
                >
                  <button
                    type="button"
                    class={`text-caption h-7 px-3 rounded-control border transition-colors ${props.cleanup.isRetentionPreset()
                        ? "border-dls-panel-input-border bg-dls-panel-input-bg text-dls-panel-icon hover:bg-dls-panel-hover-bg"
                        : "border-dls-accent bg-dls-accent/10 text-dls-text"
                    }`}
                    disabled={props.cleanup.settingsBusy() || props.cleanup.settingsUnavailable() || props.cleanup.retentionCheckBusy()}
                    onClick={() => {
                      props.cleanup.setRetentionCustomValue(String(props.cleanup.currentSettings().retentionDays));
                      props.cleanup.setRetentionCustomOpen(true);
                    }}
                  >
                    {props.cleanup.isRetentionPreset()
                      ? t("settings.cleanup_retention_custom")
                      : `${props.cleanup.currentSettings().retentionDays} ${t("settings.cleanup_retention_days")}`}
                  </button>
                </Show>
                <Show when={props.cleanup.retentionCheckBusy()}>
                  <span class="text-caption text-dls-secondary">
                    {t("settings.cleanup_checking")}
                  </span>
                </Show>
              </div>
            </div>
          </Show>
        </div>
        {/* What gets cleaned */}
        <Show when={props.cleanup.policy()}>
          {(policy) => (
            <details class="rounded-inset border border-dls-panel-inset-border bg-dls-panel-inset-bg px-3 py-2 group">
              <summary class="text-caption text-dls-secondary cursor-pointer select-none list-none flex items-center gap-1.5">
                <span class="inline-block transition-transform group-open:rotate-90">
                  ▸
                </span>
                <span class="text-dls-panel-icon font-medium">
                  {t("settings.cleanup_policy_title")}
                </span>
              </summary>
              <div class="mt-2 space-y-2">
                <div class="text-caption text-dls-secondary">
                  {t("settings.cleanup_policy_subtitle")}
                </div>
                <ul class="space-y-1 max-h-64 overflow-y-auto">
                  <For each={policy().patterns}>
                    {(p) => (
                      <li class="rounded-control bg-dls-panel-input-bg border border-dls-panel-inset-border px-2.5 py-1.5">
                        <div
                          class="text-caption text-dls-panel-text font-mono truncate"
                          title={p.pattern}
                        >
                          {p.pattern}
                        </div>
                      </li>
                    )}
                  </For>
                </ul>
                <dl class="grid grid-cols-2 gap-x-3 gap-y-1 text-label text-dls-secondary pt-1">
                  <dt>{t("settings.cleanup_policy_warn")}</dt>
                  <dd class="text-dls-panel-icon text-right">
                    {formatBytes(policy().warn_bytes)}
                  </dd>
                  <dt>{t("settings.cleanup_policy_critical")}</dt>
                  <dd class="text-dls-panel-icon text-right">
                    {formatBytes(policy().critical_bytes)}
                  </dd>
                </dl>
              </div>
            </details>
          )}
        </Show>
      </div>
    </Show>
  );
}

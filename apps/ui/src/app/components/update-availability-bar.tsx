import { Show, createMemo, type Accessor } from "solid-js";
import { LoaderCircle } from "lucide-solid";

import { canInstallUpdateInApp, type UpdateStatus } from "../context/updater";
import type { UpdaterEnvironment } from "../lib/tauri";
import { formatUpdateByteCount, progressPercent } from "../lib/app-update-progress";
import { otaUpdateStore } from "../lib/ota-update-store";
import { updateBarVisible } from "../lib/settings-visibility";
import { t } from "../../i18n";
import Button from "./button";

export type UpdateAvailabilityBarProps = {
  updateStatus: Accessor<UpdateStatus | null | undefined>;
  updateEnv: Accessor<UpdaterEnvironment | null | undefined>;
  busy: boolean;
  checkForUpdates: () => void;
  openUpdateDownloadPage: (url: string) => void;
};

export default function UpdateAvailabilityBar(props: UpdateAvailabilityBarProps) {
  const status = () => props.updateStatus() ?? undefined;

  const updateState = () => status()?.state ?? "idle";
  const updateVersion = () => {
    const s = status();
    if (!s) return null;
    if (
      s.state === "available" ||
      s.state === "downloading" ||
      s.state === "ready" ||
      s.state === "launching"
    ) {
      return s.version;
    }
    return null;
  };
  const updateHomepage = () => {
    const s = status();
    return s?.state === "available" ? s.homepage : null;
  };
  const updateForceUpdate = () => {
    const s = status();
    return s?.state === "available" ? s.forceUpdate : false;
  };

  const showUpdateToolbar = createMemo(() => updateBarVisible(props.updateEnv()));

  const updateToolbarTone = createMemo(() => {
    switch (updateState()) {
      case "available":
        return "bg-dls-warning-bg text-dls-warning-text border-dls-warning-border";
      case "ready":
        return "bg-dls-success-bg text-dls-success-text border-dls-success-border";
      case "error":
        return "bg-dls-danger-bg text-dls-danger-text border-dls-danger-border";
      case "downloading":
      case "launching":
      case "checking":
      default:
        return "bg-dls-surface-muted text-dls-secondary border-dls-panel-border";
    }
  });

  const updateToolbarSpinning = createMemo(() => {
    const state = updateState();
    return state === "checking" || state === "downloading" || state === "launching";
  });

  const updateToolbarLabel = createMemo(() => {
    const state = updateState();
    const version = updateVersion();
    const s = status();
    const progress =
      s?.state === "downloading" || s?.state === "launching"
        ? s.progress ?? null
        : null;
    if (state === "available") {
      const label = updateForceUpdate()
        ? t("settings.update_required")
        : t("settings.update_available");
      return version ? `${label}${version}` : label;
    }
    if (state === "ready") {
      return `${t("settings.update_ready")}${version ?? ""}`;
    }
    if (state === "checking") {
      return t("settings.update_checking");
    }
    if (state === "downloading") {
      if (progress?.phase === "verifying") {
        return t("settings.update_verifying");
      }
      const pct = progress ? progressPercent(progress) : null;
      if (pct != null && pct >= 1) {
        return `${t("settings.update_downloading")} ${Math.round(pct)}%`;
      }
      if (pct != null && pct > 0) {
        return `${t("settings.update_downloading")} <1%`;
      }
      return t("settings.update_downloading");
    }
    if (state === "launching") {
      return t("settings.update_launching");
    }
    if (state === "error") {
      const s = status();
      if (s?.state === "error" && s.context === "install") {
        return t("settings.update_install_failed");
      }
      return t("settings.update_check_failed");
    }
    return t("settings.update_up_to_date");
  });

  const downloadProgressDetail = createMemo(() => {
    const s = status();
    if (s?.state !== "downloading" && s?.state !== "launching") return null;
    const p = s.progress;
    if (!p || p.phase !== "download" || p.bytesDownloaded == null) return null;
    if (p.bytesTotal != null && p.bytesTotal > 0) {
      return `${formatUpdateByteCount(p.bytesDownloaded)} / ${formatUpdateByteCount(p.bytesTotal)}`;
    }
    return formatUpdateByteCount(p.bytesDownloaded);
  });

  const updateToolbarTitle = createMemo(() => updateToolbarLabel());

  const updateToolbarActionLabel = createMemo(() => {
    const state = updateState();
    if (state === "available") {
      const s = status();
      if (s && canInstallUpdateInApp(s)) {
        return t("settings.update_action_download");
      }
      return t("settings.update_action_view");
    }
    if (state === "ready") return t("settings.update_action_install");
    if (state === "error") return t("settings.update_action_retry");
    if (state === "idle") return t("settings.update_action_check");
    return null;
  });

  const updateToolbarDisabled = createMemo(() => {
    const state = updateState();
    if (state === "checking" || state === "downloading" || state === "launching") {
      return true;
    }
    return props.busy;
  });

  // Download, Restart and install, and an install's Retry go through the same store as the
  // sidebar button, so both surfaces drive one flow.
  const handleUpdateToolbarAction = () => {
    if (updateToolbarDisabled()) return;
    const state = updateState();
    const s = status();
    if (state === "ready" || (s?.state === "error" && s.context === "install")) {
      otaUpdateStore().activate();
      return;
    }
    if (state === "available") {
      if (s && canInstallUpdateInApp(s)) {
        otaUpdateStore().activate();
        return;
      }
      const homepage = updateHomepage();
      if (homepage) props.openUpdateDownloadPage(homepage);
      return;
    }
    props.checkForUpdates();
  };

  return (
    <Show when={showUpdateToolbar()}>
      <div data-settings-anchor="updates" class="flex flex-col gap-2 rounded-card border border-dls-panel-border bg-dls-panel-bg px-3 py-2">
        <div class="flex flex-wrap items-center gap-3">
          <span class="text-caption font-medium text-dls-text shrink-0">
            {t("settings.update_availability_label")}
          </span>
          <div
            class={`text-caption px-2 py-1 rounded-pill border flex items-center gap-2 ${updateToolbarTone()}`}
            title={updateToolbarTitle()}
          >
            <Show when={updateToolbarSpinning()}>
              <LoaderCircle size={12} class="animate-spin" />
            </Show>
            <span class="tabular-nums whitespace-nowrap">{updateToolbarLabel()}</span>
          </div>
          <Show when={updateToolbarActionLabel()}>
            <Button
              variant="outline"
              class="text-caption h-8 py-0 px-3 rounded-pill border-dls-border-strong bg-dls-panel-inset-bg hover:bg-dls-surface-raised"
              onClick={handleUpdateToolbarAction}
              disabled={updateToolbarDisabled()}
            >
              {updateToolbarActionLabel()}
            </Button>
          </Show>
        </div>
        <Show when={downloadProgressDetail()}>
          <div class="border-t border-dls-border-strong pt-2">
            <p class="text-label tabular-nums text-dls-secondary">{downloadProgressDetail()}</p>
          </div>
        </Show>
      </div>
    </Show>
  );
}

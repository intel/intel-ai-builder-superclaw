// Pure view of the sidebar update button (issue #2945, "User experience").
// Side effects (the installer hand-off, logging) live in `ota-update-store.ts`.
import { t } from "../../i18n";
import type { UpdateStatus } from "../context/updater";
import { progressPercent } from "./app-update-progress";

export type OtaButtonView =
  | { kind: "hidden" }
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "upToDate" }
  | { kind: "checkFailed"; message: string }
  | { kind: "available"; version: string }
  | { kind: "downloading"; version: string; pct: number }
  | { kind: "verifying"; version: string }
  | { kind: "ready"; version: string }
  | { kind: "launching"; version: string }
  | { kind: "failed"; version: string; message: string };

function deriveManualCheckView(status: UpdateStatus): OtaButtonView {
  switch (status.state) {
    case "checking":
      return { kind: "checking" };
    case "error":
      return { kind: "checkFailed", message: status.message };
    case "idle":
      return status.lastSuccessfulNoUpdateAt != null ? { kind: "upToDate" } : { kind: "idle" };
    default:
      return { kind: "idle" };
  }
}

function ringPct(pct: number | null): number {
  return Math.round(Math.min(100, Math.max(0, pct ?? 0)));
}

/**
 * Sidebar update button. Hidden when the updater cannot run. With no offer, the button is a
 * manual check. An offer stays on screen through a later check or a check error.
 */
export function deriveOtaButtonView(
  offeredVersion: string | null,
  status: UpdateStatus,
  shown: boolean,
): OtaButtonView {
  if (!shown) return { kind: "hidden" };
  if (!offeredVersion) return deriveManualCheckView(status);
  const version = offeredVersion;
  switch (status.state) {
    case "downloading":
      if (status.progress?.phase === "verifying") return { kind: "verifying", version };
      return { kind: "downloading", version, pct: ringPct(progressPercent(status.progress)) };
    case "ready":
      return { kind: "ready", version };
    case "launching":
      return { kind: "launching", version };
    case "error":
      return status.context === "install"
        ? { kind: "failed", version, message: status.message }
        : { kind: "available", version };
    default:
      return { kind: "available", version };
  }
}

/** The progress ring's fill, or null when the button shows no ring. Verification follows a complete download. */
export function otaRingPct(view: OtaButtonView): number | null {
  if (view.kind === "downloading") return view.pct;
  return view.kind === "verifying" ? 100 : null;
}

export function otaButtonTooltip(view: OtaButtonView): string | null {
  switch (view.kind) {
    case "hidden":
      return null;
    case "idle":
      return t("settings.update_tooltip_check");
    case "checking":
      return t("settings.update_checking");
    case "upToDate":
      return t("settings.update_up_to_date");
    case "checkFailed":
      return view.message
        ? `${t("settings.update_check_failed")}\n${view.message}`
        : t("settings.update_check_failed");
    case "available":
      return t("settings.update_tooltip_available").replace("{version}", view.version);
    case "downloading":
      return t("settings.update_tooltip_downloading").replace("{pct}", String(view.pct));
    case "verifying":
      return t("settings.update_verifying");
    case "ready":
      return t("settings.update_tooltip_ready").replace("{version}", view.version);
    case "launching":
      return t("settings.update_launching");
    case "failed":
      return `${t("settings.update_tooltip_update_failed")}\n${view.message}`;
  }
}

/** The Restart and install confirmation, shown before SuperClaw closes to install. */
export function updateInstallConfirmMessage(activeRuns: boolean): string {
  const body = t("settings.update_install_confirm_body");
  return activeRuns ? `${t("settings.update_install_confirm_active_runs")}\n\n${body}` : body;
}

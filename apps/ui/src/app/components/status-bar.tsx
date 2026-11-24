import { Show, createMemo } from "solid-js";
import { MessageCircle } from "lucide-solid";

import type { OpenworkServerStatus } from "../lib/openwork-server";
import type { McpStatusMap } from "../types";
import { t } from "../../i18n";

type StatusBarProps = {
  clientConnected: boolean;
  openworkServerStatus: OpenworkServerStatus;
  developerMode: boolean;
  onSendFeedback: () => void;
  feedbackStatus?: "idle" | "success" | "error";
  onOpenMessaging: () => void;
  onOpenProviders: () => Promise<void> | void;
  onOpenMcp: () => void;
  providerConnectedIds: string[];
  mcpStatuses: McpStatusMap;
  statusLabel?: string;
  statusDetail?: string;
  statusDotClass?: string;
  statusPingClass?: string;
  statusPulse?: boolean;
};

export default function StatusBar(props: StatusBarProps) {
  const providerConnectedCount = createMemo(() => props.providerConnectedIds?.length ?? 0);
  const mcpConnectedCount = createMemo(
    () => Object.values(props.mcpStatuses ?? {}).filter((status) => status?.status === "connected").length,
  );

  const statusCopy = createMemo(() => {
    if (props.statusLabel) {
      return {
        label: props.statusLabel,
        detail: props.statusDetail ?? "",
        dotClass: props.statusDotClass ?? "bg-dls-success-dot",
        pingClass: props.statusPingClass ?? "bg-dls-success-dot/45 animate-ping",
        pulse: props.statusPulse ?? true,
      };
    }

    const providers = providerConnectedCount();
    const mcp = mcpConnectedCount();

    if (props.clientConnected) {
      const detailBits: string[] = [];
      if (providers > 0) {
        detailBits.push(`${providers} ${providers === 1 ? t("status.provider_connected") : t("status.providers_connected")}`);
      }
      if (mcp > 0) {
        detailBits.push(`${mcp} ${t("status.mcp_connected")}`);
      }
      if (!detailBits.length) {
        detailBits.push(`${t("status.ready_for_new_task")}`);
      }
      if (props.developerMode) {
        detailBits.push("Developer mode");
      }
      return {
        label: t("status.superclaw_ready"),
        detail: detailBits.join(" · "),
        dotClass: "bg-dls-success-dot",
        pingClass: "bg-dls-success-dot/45 animate-ping",
        pulse: true,
      };
    }

    if (props.openworkServerStatus === "limited") {
      return {
        label: "Limited Mode",
        detail:
          mcp > 0
            ? `${mcp} MCP connected · reconnect for full features`
            : "Reconnect to restore full SuperClaw features",
        dotClass: "bg-dls-warning-dot",
        pingClass: "bg-dls-warning-dot/35",
        pulse: false,
      };
    }

    return {
      label: "Disconnected",
      detail: "Check connection settings",
      dotClass: "bg-dls-danger-dot",
      pingClass: "bg-dls-danger-dot/35",
      pulse: false,
    };
  });

  return (
    <div class="border-t border-dls-border bg-dls-surface">
      <div class="flex h-12 items-center justify-between gap-3 px-4 md:px-6 text-caption text-dls-secondary">
        <div class="flex min-w-0 items-center gap-2.5">
          <span class="relative flex h-2.5 w-2.5 shrink-0 items-center justify-center">
            <Show when={statusCopy().pulse}>
              <span class={`absolute inline-flex h-full w-full rounded-pill ${statusCopy().pingClass}`} />
            </Show>
            <span class={`relative inline-flex h-2.5 w-2.5 rounded-pill ${statusCopy().dotClass}`} />
          </span>
          <span class="shrink-0 font-medium text-dls-text">{statusCopy().label}</span>
          <span class="truncate text-dls-secondary">{statusCopy().detail}</span>
        </div>

        <div class="flex items-center gap-1.5">
          <button
            type="button"
            class="inline-flex h-8 items-center gap-1.5 rounded-control px-2 text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text"
            onClick={props.onSendFeedback}
            title={t("feedback.send")}
            aria-label={t("feedback.send")}
          >
            <MessageCircle class="h-4 w-4" />
            <span class="text-label font-medium">{t("feedback.label")}</span>
          </button>
          <Show when={props.feedbackStatus && props.feedbackStatus !== "idle"}>
            <span
              class={`text-label ${props.feedbackStatus === "success" ? "text-dls-success-text" : "text-dls-danger-text"}`}
            >
              {props.feedbackStatus === "success"
                ? t("feedback.opened")
                : t("feedback.open_failed")}
            </span>
          </Show>

        </div>
      </div>
    </div>
  );
}

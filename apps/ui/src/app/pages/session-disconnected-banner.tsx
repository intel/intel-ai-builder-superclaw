import { Show } from "solid-js";
import { AlertTriangle, Loader2, RefreshCcw, Settings } from "lucide-solid";

import Button from "../components/button";
import { t } from "../../i18n";
import { setPendingModelSection } from "./settings.model-section";
import {
  edgeDegraded,
  retryEdgeConnection,
  type EdgeDegraded,
} from "~/shared/platform/capability/edge-degraded-signal";

type RuntimeDisconnectedBannerProps = {
  connecting: boolean;
  genericMessage: string | null;
  onRetry: () => void;
  /** Opens Settings → Model; the Edge banner scrolls it to the Edge server card. */
  onOpenSettings?: () => void;
};

/**
 * A send cannot run while the committed Edge server has not connected and no Profile
 * is active (#3531). Says why through `notify` and returns true when it must not run.
 */
export function blockSendWhileEdgeDegraded(profileActive: boolean, notify: (message: string) => void): boolean {
  if (profileActive || !edgeDegraded()) return false;
  notify(t("session.edge_send_blocked"));
  return true;
}

/**
 * The Edge banner shows even while the runtime is connected: a deployment kept from an
 * earlier Profile can start OpenCode while no Profile is active (#3531).
 */
export const edgeBannerShown = (): boolean => edgeDegraded() !== null;

export function RuntimeDisconnectedBanner(props: RuntimeDisconnectedBannerProps) {
  // With no Profile the data plane never starts, so the runtime copy would blame the
  // wrong component. The Edge banner names the real cause instead.
  return (
    <Show when={edgeDegraded()} fallback={<RuntimeBanner {...props} />}>
      {(edge) => (
        <EdgeDegradedBanner
          edge={edge()}
          onOpenSettings={() => {
            setPendingModelSection("local");
            props.onOpenSettings?.();
          }}
        />
      )}
    </Show>
  );
}

function RuntimeBanner(props: RuntimeDisconnectedBannerProps) {
  const title = () => {
    if (props.connecting) return "Connecting to the runtime…";
    return "SuperClaw runtime disconnected";
  };
  const message = () => {
    if (props.connecting) return "Finishing the connection to the SuperClaw runtime.";
    return props.genericMessage ??
      "Unable to connect to the runtime. Retrying — use Retry to restart the backend service if it doesn't recover.";
  };

  return (
    <div
      class={`shrink-0 border-b animate-in fade-in slide-in-from-top-3 duration-300 ${props.connecting ? "border-dls-warning-border bg-dls-warning-bg" : "border-dls-danger-border bg-dls-danger-bg"}`}
    >
      <div class="flex items-start gap-3 px-4 py-4 sm:px-6 lg:px-10">
        <div
          class={`flex h-10 w-10 shrink-0 items-center justify-center rounded-card border ${props.connecting ? "border-dls-warning-border bg-dls-warning-bg text-dls-warning-text" : "border-dls-danger-border bg-dls-danger-bg text-dls-danger-text"}`}
        >
          <Show when={props.connecting} fallback={<AlertTriangle size={18} />}>
            <Loader2 size={18} class="animate-spin" />
          </Show>
        </div>

        <div class="min-w-0 flex-1">
          <div class="min-w-0">
            <span
              class={`text-body-lg font-semibold ${props.connecting ? "text-dls-warning-text" : "text-dls-danger-text"}`}
            >
              {title()}
            </span>
          </div>
          <div class="mt-1 text-body-lg leading-relaxed text-dls-secondary">{message()}</div>

          <Show when={!props.connecting}>
            <div class="mt-3 flex flex-wrap items-center gap-2">
              <Button
                variant="primary"
                class="rounded-pill px-3 py-1.5 text-caption"
                onClick={props.onRetry}
              >
                <RefreshCcw size={12} class="mr-1" />
                Retry
              </Button>
            </div>
          </Show>
        </div>
      </div>
    </div>
  );
}

function EdgeDegradedBanner(props: { edge: EdgeDegraded; onOpenSettings: () => void }) {
  const connecting = () => props.edge.state === "connecting";
  const title = () => {
    if (connecting()) return t("session.edge_connecting_title");
    if (props.edge.profileLoadFailed) return t("session.edge_profile_load_failed_title");
    if (props.edge.reasonCode === "invalid_api_key") return t("session.edge_rejected_key_title");
    if (props.edge.reasonCode === "url_unreachable") return t("session.edge_unreachable_title");
    if (props.edge.reasonCode === "model_not_found") return t("session.edge_model_unavailable_title");
    return t("session.edge_connect_failed_title");
  };
  const message = () => {
    if (connecting()) return t("session.edge_connecting_message");
    if (props.edge.reasonCode === "model_not_found" && !props.edge.profileLoadFailed) {
      const model = props.edge.modelLabel ?? t("session.edge_model_unavailable_unknown");
      return t("session.edge_model_unavailable_message").replace("{model}", model);
    }
    const cause = props.edge.message?.trim().replace(/\.+$/, "") || t("session.edge_unreachable_unknown");
    const copy = props.edge.profileLoadFailed ? "session.edge_profile_load_failed_message" : "session.edge_unreachable_message";
    return t(copy).replace("{message}", cause);
  };

  return (
    <div
      role="status"
      class={`shrink-0 border-b animate-in fade-in slide-in-from-top-3 duration-300 ${connecting() ? "border-dls-info-border bg-dls-info-bg" : "border-dls-danger-border bg-dls-danger-bg"}`}
    >
      <div class="flex items-start gap-3 px-4 py-4 sm:px-6 lg:px-10">
        <div
          class={`flex h-10 w-10 shrink-0 items-center justify-center rounded-card border ${connecting() ? "border-dls-info-border bg-dls-info-bg text-dls-info-text" : "border-dls-danger-border bg-dls-danger-bg text-dls-danger-text"}`}
        >
          <Show when={connecting()} fallback={<AlertTriangle size={18} />}>
            <Loader2 size={18} class="animate-spin" />
          </Show>
        </div>

        <div class="min-w-0 flex-1">
          <span class={`text-body-lg font-semibold ${connecting() ? "text-dls-info-text" : "text-dls-danger-text"}`}>
            {title()}
          </span>
          <div class="mt-1 text-body-lg leading-relaxed text-dls-secondary">{message()}</div>

          <Show when={!connecting()}>
            <div class="mt-3 flex flex-wrap items-center gap-2">
              <Button
                variant="primary"
                class="rounded-pill px-3 py-1.5 text-caption"
                onClick={props.onOpenSettings}
              >
                <Settings size={12} class="mr-1" />
                {t("session.edge_open_settings")}
              </Button>
              <Button
                variant="secondary"
                class="rounded-pill px-3 py-1.5 text-caption"
                onClick={retryEdgeConnection}
              >
                <RefreshCcw size={12} class="mr-1" />
                {t("session.edge_retry")}
              </Button>
            </div>
          </Show>
        </div>
      </div>
    </div>
  );
}

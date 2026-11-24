import { For, Show, createContext, createEffect, createSignal, onCleanup, useContext } from "solid-js";
import { Hand, Loader2, Monitor, Pause, Play, Square } from "lucide-solid";

import Button from "~/shared/ui/button";
import { t } from "../../i18n";
import { hostBannerState, hostCallText, hostRunningText, resumeSecondsLeft } from "./host-mcp";
import HostMcpApprovalNotices from "./host-mcp-approval-notices";
import type { HostMcp, HostMcpApprovals } from "./useHostMcp";

export type HostMcpStopBannerProps = {
  host: Pick<
    HostMcp,
    | "status" | "stopping" | "stopError" | "stopAll" | "resuming" | "resumeError" | "resume"
    | "activeCalls" | "cancelling" | "cancelError" | "cancelCall"
  > & {
    approvals?: Pick<HostMcpApprovals, "notices" | "dismissNotice" | "servers">;
  };
  now?: () => number;
};

/**
 * A full-width bar in the page flow, under the window title bar, like a browser's "controlled by
 * automated software" bar: content below moves down rather than being covered, and the surface is
 * opaque. While something runs on this computer outside the sandbox it says what, with Stop all; after
 * Stop all, until the user resumes, that host tools stay stopped, with Resume. The notices about
 * approvals that ended unanswered follow it in the same flow.
 */
export default function HostMcpStopBanner(props: HostMcpStopBannerProps) {
  const runningNames = () =>
    props.host.approvals?.servers()?.filter((server) => server.state === "running").map((server) => server.name) ?? null;
  const ErrorText = (message: () => string | null) => (
    <Show when={message()}>
      {(text) => (
        <span role="alert" class="text-dls-danger-text">
          {text()}
        </span>
      )}
    </Show>
  );

  // Counts a waiting call down between status reads.
  const clock = props.now ?? Date.now;
  const [now, setNow] = createSignal(clock());
  createEffect(() => {
    if (!props.host.activeCalls().some((call) => call.state === "waiting_for_user")) return;
    setNow(clock());
    const timer = setInterval(() => setNow(clock()), 250);
    onCleanup(() => clearInterval(timer));
  });

  return (
    <div data-testid="host-mcp-infobar" class="flex w-full shrink-0 flex-col font-sans">
      <For each={props.host.activeCalls()}>
        {(call) => (
          <div
            role="status"
            data-testid="host-mcp-call"
            data-state={call.state}
            class="flex w-full flex-wrap items-center gap-3 border-b border-dls-infobar-attention-border bg-dls-infobar-attention-bg px-4 py-1.5 text-caption text-dls-infobar-attention-text"
          >
            <Show when={call.state === "waiting_for_user"} fallback={<Monitor size={16} class="shrink-0" />}>
              <Hand size={16} class="shrink-0" />
            </Show>
            <span data-testid="host-mcp-call-text" class="min-w-0 flex-1 font-medium break-words">
              {hostCallText(call, resumeSecondsLeft(call, now()), (key) => t(key))}
            </span>
            {ErrorText(() =>
              props.host.cancelError()?.callId === call.call_id ? props.host.cancelError()?.message ?? null : null)}
            <Button
              variant="outline"
              class="h-7 px-3 text-caption"
              data-testid="host-mcp-call-cancel-btn"
              disabled={props.host.cancelling().has(call.call_id)}
              onClick={() => void props.host.cancelCall(call.call_id)}
            >
              {t(props.host.cancelling().has(call.call_id) ? "mcp.host.call.cancelling" : "mcp.host.call.cancel")}
            </Button>
          </div>
        )}
      </For>
      <Show when={hostBannerState(props.host.status()) === "running" ? props.host.status() : null}>
        {(status) => (
          <div
            role="status"
            data-testid="host-mcp-stop-banner"
            class="flex w-full flex-wrap items-center gap-3 border-b border-dls-infobar-attention-border bg-dls-infobar-attention-bg px-4 py-1.5 text-caption text-dls-infobar-attention-text"
          >
            <Monitor size={16} class="shrink-0" />
            <span data-testid="host-mcp-stop-banner-text" class="min-w-0 flex-1 font-medium break-words">
              {hostRunningText(status(), runningNames(), (key) => t(key))}
            </span>
            {ErrorText(props.host.stopError)}
            <Button
              variant="danger"
              class="h-7 px-3 text-caption"
              data-testid="host-mcp-stop-all-btn"
              disabled={props.host.stopping()}
              onClick={() => void props.host.stopAll()}
            >
              <Show when={props.host.stopping()} fallback={<Square size={12} />}>
                <Loader2 size={12} class="animate-spin" />
              </Show>
              {t(props.host.stopping() ? "mcp.host.banner.stopping" : "mcp.host.banner.stop_all")}
            </Button>
          </div>
        )}
      </Show>
      <Show when={hostBannerState(props.host.status()) === "paused"}>
        <div
          role="status"
          data-testid="host-mcp-paused-banner"
          class="flex w-full flex-wrap items-center gap-3 border-b border-dls-infobar-neutral-border bg-dls-infobar-neutral-bg px-4 py-1.5 text-caption text-dls-infobar-neutral-text"
        >
          <Pause size={16} class="shrink-0" />
          <span data-testid="host-mcp-paused-banner-text" class="min-w-0 flex-1 font-medium break-words">
            {t("mcp.host.banner.paused")}
          </span>
          {ErrorText(props.host.resumeError)}
          <Button
            variant="outline"
            class="h-7 px-3 text-caption"
            data-testid="host-mcp-resume-btn"
            disabled={props.host.resuming()}
            onClick={() => void props.host.resume()}
          >
            <Show when={props.host.resuming()} fallback={<Play size={12} />}>
              <Loader2 size={12} class="animate-spin" />
            </Show>
            {t(props.host.resuming() ? "mcp.host.banner.resuming" : "mcp.host.banner.resume")}
          </Button>
        </div>
      </Show>
      <Show when={props.host.approvals}>
        {(approvals) => <HostMcpApprovalNotices approvals={approvals()} />}
      </Show>
    </div>
  );
}

const HostMcpContext = createContext<HostMcp | null>(null);

/** Hands the app shell's host MCP state to the bars the pages render under their title bar. */
export const HostMcpProvider = HostMcpContext.Provider;

/** The bar, for whatever page renders it; nothing outside a `HostMcpProvider`. */
export function HostMcpInfobar() {
  const host = useContext(HostMcpContext);
  return host ? <HostMcpStopBanner host={host} /> : null;
}

import { For, Match, Show, Switch, createEffect, createSignal, onCleanup } from "solid-js";
import type { Accessor, JSX } from "solid-js";
import {
  Activity,
  Radio,
  X,
  Check,
  Loader2,
  MessageSquare,
  RefreshCcw,
  TriangleAlert,
} from "lucide-solid";

import Button from "./button";
import { SandboxStatusContent } from "./status-dashboard";
import type { SandboxStatusContentProps } from "./status-dashboard";
import {
  probeTrajectoryHealth,
  shouldRenderTrajectoryFrame,
  trajectoryDiagnostics,
  trajectoryEmbedUrl,
  type TrajectoryHealthState,
} from "../lib/trajectory-inspector-health";

export type DevToolsTab = "sandbox" | "trajectory";

/** Silent retries before the failure panel appears, to race the host bring-up. */
const TRAJECTORY_SILENT_RETRIES = 2;
const TRAJECTORY_RETRY_DELAY_MS = 1000;
/** Cap the `starting` poll so a permanently token-less inspector still settles. */
const TRAJECTORY_STARTING_RETRIES = 10;

export interface DevToolsModalProps {
  open: Accessor<boolean>;
  initialTab: Accessor<DevToolsTab>;
  onClose: () => void;
  /** Sandbox tab props */
  sandbox: SandboxStatusContentProps;
  /** Trajectory inspector origin, e.g. `http://127.0.0.1:7778`. Single source of
   *  truth for both the iframe src and the postMessage origin check. */
  trajectoryOrigin: Accessor<string>;
  /** Current session ID — when absent, trajectory tab shows an empty state */
  sessionId: Accessor<string | null>;
}

export function DevToolsModal(props: DevToolsModalProps): JSX.Element {
  const [activeTab, setActiveTab] = createSignal<DevToolsTab>(props.initialTab());
  const [toast, setToast] = createSignal<string | null>(null);
  let toastTimer: ReturnType<typeof setTimeout> | undefined;

  const showToast = (msg: string) => {
    clearTimeout(toastTimer);
    setToast(msg);
    toastTimer = setTimeout(() => setToast(null), 3500);
  };

  // Listen for download messages from the trajectory iframe
  const onMessage = (e: MessageEvent) => {
    if (e.origin !== props.trajectoryOrigin()) return;
    if (!e.data || typeof e.data !== "object") return;
    if (e.data.type === "trajectory:download" && typeof e.data.data === "string") {
      const blob = new Blob([e.data.data], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const fname = typeof e.data.filename === "string" ? e.data.filename : "trajectory.json";
      a.href = url;
      a.download = fname;
      a.click();
      URL.revokeObjectURL(url);
      showToast(`"${fname}" saved to Downloads folder`);
    }
  };
  window.addEventListener("message", onMessage);

  // ── Trajectory Inspector readiness ────────────────────────────────────────
  // The iframe cannot report ERR_CONNECTION_REFUSED (a refused cross-origin frame
  // still fires onload in WebView2), so probe /health out of band before mounting
  // it. Without this the user just sees "127.0.0.1 refused to connect" (#2546).
  const [health, setHealth] = createSignal<TrajectoryHealthState>({ kind: "probing" });
  const [probing, setProbing] = createSignal(false);
  let probeController: AbortController | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let attempts = 0;

  const runProbe = async (manual: boolean) => {
    clearTimeout(retryTimer);
    probeController?.abort();
    const controller = new AbortController();
    probeController = controller;
    if (manual) {
      attempts = 0;
      setHealth({ kind: "probing" });
    }
    setProbing(true);
    attempts += 1;
    const result = await probeTrajectoryHealth({
      origin: props.trajectoryOrigin(),
      signal: controller.signal,
    });
    if (controller !== probeController) return; // superseded by a newer probe
    setProbing(false);

    // The host schedules the inspector bring-up detached, and a cold first launch
    // of the ~98 MB binary can take a while, so give it a couple of quiet retries
    // before blaming it. Keep polling while it is up but not yet authenticated.
    const keepWaiting =
      (result.kind === "unreachable" && attempts <= TRAJECTORY_SILENT_RETRIES) ||
      (result.kind === "starting" && attempts <= TRAJECTORY_STARTING_RETRIES);
    if (keepWaiting) {
      if (result.kind === "starting") setHealth(result);
      retryTimer = setTimeout(() => void runProbe(false), TRAJECTORY_RETRY_DELAY_MS);
      return;
    }
    setHealth(result);
  };

  createEffect(() => {
    // props.open(), not resolvedOpen(): the latter mutates prevOpen and syncs the
    // active tab, so reading it here would consume the modal's open transition.
    const active = props.open() && activeTab() === "trajectory" && props.sessionId();
    if (!active) {
      // Leaving the tab must also stop the retry loop, or it keeps polling for the
      // life of the session.
      clearTimeout(retryTimer);
      probeController?.abort();
      probeController = null;
      setProbing(false);
      return;
    }
    void runProbe(true);
  });

  onCleanup(() => {
    window.removeEventListener("message", onMessage);
    clearTimeout(toastTimer);
    clearTimeout(retryTimer);
    probeController?.abort();
  });

  // Sync tab when the modal reopens with a different initialTab
  let prevOpen = false;
  const resolvedOpen = () => {
    const isOpen = props.open();
    if (isOpen && !prevOpen) {
      setActiveTab(props.initialTab());
    }
    prevOpen = isOpen;
    return isOpen;
  };

  const tabClass = (tab: DevToolsTab) => {
    const active = activeTab() === tab;
    return `px-3 py-1.5 text-caption font-medium rounded-control transition-all ${
      active
        ? "bg-dls-surface text-dls-text shadow-sm ring-1 ring-dls-border"
        : "text-dls-muted hover:text-dls-text"
    }`;
  };

  return (
    <Show when={resolvedOpen()}>
      <div
        class="fixed inset-0 z-50 dls-modal-backdrop flex items-center justify-center"
        role="dialog"
        aria-modal="true"
        aria-label="Developer tools"
        onClick={(e) => {
          if (e.target === e.currentTarget) props.onClose();
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") props.onClose();
        }}
        tabIndex={-1}
        ref={(el) => el?.focus()}
      >
        <div class="relative flex h-[85vh] w-[90vw] max-w-[1400px] flex-col overflow-hidden border dls-modal-surface">
          {/* Header: tabs + close */}
          <div class="flex h-11 shrink-0 items-center justify-between border-b border-dls-border px-4">
            <div class="flex items-center gap-0.5 rounded-control bg-dls-surface-raised p-0.5">
              <button
                type="button"
                class={tabClass("trajectory")}
                onClick={() => setActiveTab("trajectory")}
              >
                <span class="inline-flex items-center gap-1.5">
                  <Activity size={12} />
                  Trajectory
                </span>
              </button>
              <button
                type="button"
                class={tabClass("sandbox")}
                onClick={() => setActiveTab("sandbox")}
              >
                <span class="inline-flex items-center gap-1.5">
                  <Radio size={12} />
                  Status
                </span>
              </button>
            </div>
            <button
              type="button"
              class="flex h-7 w-7 items-center justify-center rounded-control text-dls-secondary transition-colors hover:bg-dls-hover/70 hover:text-dls-text"
              onClick={() => props.onClose()}
              aria-label="Close developer tools"
            >
              <X size={16} />
            </button>
          </div>

          {/* Tab content */}
          <Show when={activeTab() === "sandbox"}>
            <SandboxStatusContent
              view={props.sandbox.view}
              onRefresh={props.sandbox.onRefresh}
              isFetching={props.sandbox.isFetching}
              lastUpdatedAt={props.sandbox.lastUpdatedAt}
            />
          </Show>

          <Show when={activeTab() === "trajectory"}>
            <Show
              when={props.sessionId()}
              fallback={
                <div class="flex flex-1 items-center justify-center">
                  <div class="flex flex-col items-center gap-3 text-center">
                    <MessageSquare size={28} class="text-dls-subtle" />
                    <div class="text-body-lg font-medium text-dls-text">No active session</div>
                    <div class="text-caption text-dls-secondary">Start or select a conversation first to inspect its trajectory.</div>
                  </div>
                </div>
              }
            >
              <Switch>
                <Match when={health().kind === "probing"}>
                  <div class="flex flex-1 items-center justify-center">
                    <div class="flex flex-col items-center gap-3 text-center">
                      <Loader2 size={24} class="animate-spin text-dls-subtle" />
                      <div class="text-caption text-dls-secondary">
                        Checking the Trajectory Inspector…
                      </div>
                    </div>
                  </div>
                </Match>

                <Match when={health().kind === "unreachable"}>
                  <TrajectoryUnavailable
                    state={health}
                    origin={props.trajectoryOrigin}
                    isProbing={probing}
                    onRetry={() => void runProbe(true)}
                  />
                </Match>

                <Match when={shouldRenderTrajectoryFrame(health())}>
                  <Show when={health().kind === "starting"}>
                    <div class="flex shrink-0 items-center gap-2 border-b border-dls-warning-border bg-dls-warning-bg px-4 py-2 text-caption text-dls-warning-text">
                      <Loader2 size={13} class="shrink-0 animate-spin" />
                      <span>
                        Inspector is up but hasn't attached to the sandbox yet -
                        recent turns may be missing.
                      </span>
                    </div>
                  </Show>
                  <iframe
                    src={trajectoryEmbedUrl(props.trajectoryOrigin(), props.sessionId())}
                    sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-downloads"
                    title="Trajectory Inspector"
                    class="flex-1 w-full border-0"
                  />
                </Match>
              </Switch>
            </Show>
          </Show>

          {/* Centered toast */}
          <Show when={toast()}>
            <div class="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
              <div class="pointer-events-auto flex items-center gap-2.5 rounded-inset border border-dls-success-border bg-dls-success-bg px-4 py-2.5 text-body-lg font-medium text-dls-success-text shadow-lg animate-in fade-in slide-in-from-bottom-2 duration-200">
                <Check size={16} class="shrink-0" />
                <span>{toast()}</span>
              </div>
            </div>
          </Show>
        </div>
      </div>
    </Show>
  );
}

/**
 * The #2546 failure surface: replaces the engine's bare "127.0.0.1 refused to
 * connect" page with the two log paths and the re-stage command an engineer needs.
 * Copy comes from trajectoryDiagnostics() so it can be unit tested.
 */
function TrajectoryUnavailable(props: {
  state: Accessor<TrajectoryHealthState>;
  origin: Accessor<string>;
  isProbing: Accessor<boolean>;
  onRetry: () => void;
}): JSX.Element {
  const info = () => trajectoryDiagnostics(props.state(), props.origin());
  return (
    <div class="flex flex-1 items-center justify-center overflow-y-auto p-6">
      <div class="w-full max-w-2xl space-y-3 rounded-card border border-dls-border/50 bg-dls-panel-bg p-5">
        <div class="flex items-start justify-between gap-3">
          <div class="flex items-start gap-2.5">
            <TriangleAlert size={16} class="mt-0.5 shrink-0 text-dls-warning-text" />
            <div>
              <div class="text-body-lg font-medium text-dls-text">{info().headline}</div>
              <div class="mt-1 text-caption text-dls-secondary">{info().detail}</div>
            </div>
          </div>
          <Button
            variant="outline"
            class="h-8 shrink-0 px-3 py-0 text-caption"
            onClick={props.onRetry}
            disabled={props.isProbing()}
          >
            <Show
              when={props.isProbing()}
              fallback={<RefreshCcw size={13} class="mr-1.5" />}
            >
              <Loader2 size={13} class="mr-1.5 animate-spin" />
            </Show>
            Retry
          </Button>
        </div>

        <ol class="space-y-1.5 text-label text-dls-subtle">
          <For each={info().steps}>
            {(step, i) => (
              <li class="flex gap-2">
                <span class="shrink-0 text-dls-low">{i() + 1}.</span>
                <span class="select-text break-all">{step}</span>
              </li>
            )}
          </For>
        </ol>
      </div>
    </div>
  );
}

export default DevToolsModal;

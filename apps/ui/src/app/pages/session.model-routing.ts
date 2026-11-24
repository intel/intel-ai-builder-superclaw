import { createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";
import {
  checkAutoRouterModelsReady,
  getLastAutoRouterDiagnostics,
} from "../components/cloud-model-settings";

// "check_failed" means the health call itself did not complete (timeout /
// network / 5xx) — distinct from "unhealthy", which is a model-specific
// verdict from a successful health response.
export type CloudModelStatus =
  | "checking"
  | "ready"
  | "not_configured"
  | "unhealthy"
  | "check_failed";

/** The gated llmrouter aliases whose health must be probed before a send. */
const GATED_ROUTER_ALIASES = new Set(["auto", "cloud-model", "local-model"]);

const POLL_INTERVAL_MS = 60_000;

type ModelRoutingDeps = {
  selectedModel: () => { providerID: string; modelID: string };
  /**
   * Same fallback chain as settings.tsx: prefer the host-info baseUrl, fall
   * back to the computed openworkServerUrl (connectUrl -> lanUrl -> mdnsUrl).
   */
  hostInfoBaseUrl: () => string | null | undefined;
  serverUrl: () => string | null | undefined;
  providerConnectedIds: () => readonly string[];
  view: () => string;
};

type ModelRoutingController = {
  cloudStatus: () => CloudModelStatus;
  localStatus: () => CloudModelStatus;
  /**
   * Human-readable summary of the last auto-route health probe, surfaced in the
   * blocking popup so a packaged build (no console/DevTools) can still be
   * diagnosed by the user directly from the UI.
   */
  diagnostics: () => string;
  setDiagnostics: (value: string) => void;
  /** The llmrouter alias in use, or null when another provider is selected. */
  selectedRouterAlias: () => string | null;
  baseUrl: () => string;
  refresh: () => Promise<void>;
  /** An in-flight probe a caller can await, or null when none is running. */
  pendingCheck: () => Promise<void> | null;
};

export function createModelRouting(
  deps: ModelRoutingDeps,
): ModelRoutingController {
  const [cloudStatus, setCloudStatus] = createSignal<CloudModelStatus>("checking");
  const [localStatus, setLocalStatus] = createSignal<CloudModelStatus>("checking");
  const [diagnostics, setDiagnostics] = createSignal<string>("");

  /** Held so handleSendPrompt can await an in-flight check, including a follow-up. */
  let pending: Promise<void> | null = null;
  /**
   * A reactive trigger arrived while a probe was already running. The probe
   * stays pinned to the inputs it started with, so one follow-up re-reads them.
   * Plain refresh() calls (the poll, the send handler, duplicates) do not set
   * this — those are the same snapshot and must join.
   */
  let followUp = false;

  const selectedRouterAlias = () => {
    const model = deps.selectedModel();
    return model.providerID === "llmrouter" ? model.modelID : null;
  };

  const isGatedRouterModel = () => {
    const alias = selectedRouterAlias();
    return alias !== null && GATED_ROUTER_ALIASES.has(alias);
  };

  const baseUrl = createMemo(
    () => (deps.hostInfoBaseUrl()?.trim() || deps.serverUrl()?.trim()) ?? "",
  );

  const publishUnreachable = () => {
    // Can't verify — and can't route to cloud — without a server URL.
    // Treat as "not configured" so the send handler shows the popup.
    setDiagnostics(
      `auto-route health probe @ ${new Date().toISOString()}\n` +
        "llmrouterBaseUrl (OpenWork server URL) is empty — the UI has no server URL, " +
        "so it cannot reach the ServiceHub to probe cloud/edge health.",
    );
    setCloudStatus("not_configured");
    setLocalStatus("not_configured");
  };

  const refresh = async (invalidate = false) => {
    // Identical callers join the in-flight probe. A reactive trigger marks it
    // stale instead: every such trigger during this probe shares one follow-up.
    // Comparing the view string would miss a return to session, because the
    // poll started on "session" and the view is "session" again.
    if (pending) {
      if (invalidate) followUp = true;
      await pending;
      return;
    }

    // A missing URL publishes synchronously. Parking that run in `pending`
    // would keep a fulfilled promise until the next microtask, and a refresh
    // arriving in that window would join it and never run. The loop below
    // still handles a URL that disappears during a follow-up.
    if (!baseUrl()) {
      publishUnreachable();
      return;
    }

    // The loop's finally compares `pending` to this run. The binding has to
    // exist before the async function is created, or a synchronous throw
    // would read it before assignment.
    const owned: { run?: Promise<void> } = {};
    const run = (async () => {
      try {
        do {
          followUp = false;
          const url = baseUrl();
          if (!url) {
            publishUnreachable();
            continue;
          }
          // NOTE: Do NOT reset status to "checking" here. Preserving the cached
          // result (e.g. "ready" or "not_configured") lets the send handler use
          // it instantly while this background refresh is in-flight. The initial
          // "checking" state set by the signal default is intentionally left
          // alone for the very first check.
          const combined = await checkAutoRouterModelsReady(url);
          // This call snapshotted the previous inputs. Drop its verdict; the
          // next iteration publishes the one the later refresh asked for.
          if (followUp) continue;
          setDiagnostics(getLastAutoRouterDiagnostics());
          setCloudStatus(
            combined.cloud.ready ? "ready" : (combined.cloud.reason ?? "unhealthy"),
          );
          setLocalStatus(
            combined.local.ready ? "ready" : (combined.local.reason ?? "unhealthy"),
          );
        } while (followUp);
      } finally {
        // Clear before this promise fulfills. The outer await resumes in a
        // later microtask, and a URL or provider change queued in between
        // would otherwise join a loop that has already exited.
        if (pending === owned.run) pending = null;
      }
    })();

    owned.run = run;
    pending = run;
    try {
      await run;
    } finally {
      // A refresh may have started its own run in the microtask after `run`
      // finished. Only clear the run this caller owns.
      if (pending === run) pending = null;
    }
  };

  // Re-check whenever model key or server URL changes.
  createEffect(
    on(
      () => ({ gated: isGatedRouterModel(), url: baseUrl() }),
      ({ gated, url }) => {
        if (gated && url) {
          void refresh(true);
        } else if (!gated) {
          setCloudStatus("ready");
          setLocalStatus("ready");
        } else {
          setCloudStatus("checking");
          setLocalStatus("checking");
        }
      },
    ),
  );

  // Re-check when connected providers change (user linked a new provider).
  createEffect(
    on(
      () => deps.providerConnectedIds(),
      () => {
        if (isGatedRouterModel()) void refresh(true);
      },
      { defer: true },
    ),
  );

  // Re-check when user navigates back to the session view. This catches the
  // case where the user configures the cloud model in Settings (dashboard
  // view) and returns — none of the other watched signals change on that
  // transition, so without this the cached "not_configured" persists.
  createEffect(
    on(
      () => deps.view(),
      (view) => {
        if (view === "session" && isGatedRouterModel()) void refresh(true);
      },
      { defer: true },
    ),
  );

  // Periodic refresh while any gated llmrouter alias is selected. Uses a
  // reactive effect so the timer is created/destroyed as the model changes.
  createEffect(() => {
    if (!isGatedRouterModel()) return;
    const timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    onCleanup(() => clearInterval(timer));
  });

  return {
    cloudStatus,
    localStatus,
    diagnostics,
    setDiagnostics,
    selectedRouterAlias,
    baseUrl,
    refresh: () => refresh(false),
    pendingCheck: () => pending,
  };
}

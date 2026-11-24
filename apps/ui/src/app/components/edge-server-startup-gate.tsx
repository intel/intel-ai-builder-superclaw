import {
  createSignal,
  createEffect,
  on,
  Show,
  type JSX,
} from "solid-js";
import { Eye, EyeOff, Loader2, AlertTriangle, X } from "lucide-solid";
import { createLlmRouterClient } from "../lib/llmrouter-client";
import {
  isSavedEdgeModelCommitted,
  isSavedEdgeModelSupported,
} from "../edge-gate-policy";
import { activationErrorText, activationRequestErrorText } from "~/shared/platform/capability/activation-error-text";
import { capabilityStartupHandled } from "~/shared/platform/capability/capability-startup-signal";
import {
  buildEdgeConnectActivationRequest,
  fetchModelBindingActivationOperation,
  startModelBindingActivation,
} from "~/shared/platform/capability/model-binding-activation-client";
import type { ServiceHubSettings } from "~/shared/platform/transport/servicehub";
import { isTauriRuntime } from "../utils";
import Button from "./button";
import { t } from "../../i18n";

// ── Types ──────────────────────────────────────────────────────────────

export type EdgeStartupGateState =
  | "idle" // waiting for preconditions (backendBootReady + serverHealthy)
  | "checking-existing" // probing local model + edge config
  | "auto-connecting" // backend has saved config — auto-reconnecting
  | "needs-input" // user must fill in edge server info
  | "applying" // PUT /llm-router/v1/edge in flight
  | "ready" // gate passed — children visible
  | "error"; // something failed — show form + error

export interface EdgeServerStartupGateProps {
  backendBootReady: boolean;
  serverHealthy: boolean | undefined;
  serverBaseUrl: string;
  serverToken: string | undefined;
  hubUrl: string;
  hubToken: string | undefined;
  /** Skip the OpenWork-dependent edge gate when the app is intentionally
   * booted without an OpenWork data plane (ServiceHub transition mode). */
  bypass?: boolean;
  /** True only when the host is known to be ineligible for a local llama model
   * (`deviceCanRunLocal === false`). Gates the automatic "adopt existing edge
   * config as the local provider" behaviour so an eligible device caught in the
   * fail-closed (eligibility `undefined`) window is never silently switched to
   * edge just because an edge config happens to exist. */
  persistEdgeProvider?: boolean;
  children: JSX.Element;
  /** Called once when the gate transitions to "ready" (edge model available). */
  onReady?: () => void;
}

// ── LocalStorage cache ────────────────────────────────────────────────
// On successful connection we persist non-secret form fields so they can
// be pre-filled on next startup.  The connection key is intentionally not
// cached in localStorage.
const EDGE_CACHE_KEY = "openwork.edge-server-gate.v1";

interface EdgeServerCache {
  url: string;
  modelName: string;
  bypassProxy: boolean;
}

function readEdgeCache(): EdgeServerCache | null {
  try {
    const raw = localStorage.getItem(EDGE_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as EdgeServerCache & { apiKey?: string };
    const cache: EdgeServerCache = {
      url: parsed.url,
      modelName: parsed.modelName,
      bypassProxy: parsed.bypassProxy,
    };
    if ("apiKey" in parsed) writeEdgeCache(cache);
    return cache;
  } catch {
    return null;
  }
}

function writeEdgeCache(cache: EdgeServerCache): void {
  try {
    localStorage.setItem(EDGE_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // Storage unavailable — silently ignore.
  }
}

const EDGE_ACTIVATION_POLL_MS = 500;

async function ensureSavedEdgeModelActive(
  client: ReturnType<typeof createLlmRouterClient>,
  settings: ServiceHubSettings,
  modelName: string,
  expectedFingerprint: string,
): Promise<void> {
  let capability = await client.getPrimaryBundleCapability();
  if (
    !expectedFingerprint ||
    capability.edge_model_selection_fingerprint !== expectedFingerprint
  ) {
    throw new Error("The Edge model changed while it was being applied. Retry.");
  }
  if (
    !isSavedEdgeModelSupported(modelName, capability.supported_bundles)
  ) {
    throw new Error(
      "The saved Edge model is not available as a supported Bundle. Re-enter and apply a supported model.",
    );
  }
  if (
    isSavedEdgeModelCommitted(
      modelName,
      capability.supported_bundles,
      capability.primary_bundle,
      capability.primary_edge_config_matches === true,
    )
  ) {
    return;
  }

  const edgeBundle = capability.supported_bundles.find(
    (bundle) =>
      bundle.backend === "edge" && bundle.chat_model_label === modelName,
  );
  const request = edgeBundle
    ? buildEdgeConnectActivationRequest(capability, edgeBundle.bundle_id)
    : null;
  if (!request) {
    throw new Error("The saved Edge model cannot be activated. Retry or choose another model.");
  }

  let operation = await startModelBindingActivation(settings, request);
  while (operation.status === "applying") {
    await new Promise((resolve) => setTimeout(resolve, EDGE_ACTIVATION_POLL_MS));
    operation = await fetchModelBindingActivationOperation(
      settings,
      operation.operation_id,
    );
  }
  if (operation.status === "failed") {
    throw new Error(activationErrorText(operation.error));
  }

  capability = await client.getPrimaryBundleCapability();
  if (
    capability.edge_model_selection_fingerprint !== expectedFingerprint ||
    !isSavedEdgeModelCommitted(
      modelName,
      capability.supported_bundles,
      capability.primary_bundle,
      capability.primary_edge_config_matches === true,
    )
  ) {
    throw new Error(
      "The Edge model activation did not commit. Check the configuration and retry.",
    );
  }
}

// ── Component ──────────────────────────────────────────────────────────

export default function EdgeServerStartupGate(
  props: EdgeServerStartupGateProps,
) {
  if (!isTauriRuntime()) {
    return <>{props.children}</>;
  }

  const [state, setState] = createSignal<EdgeStartupGateState>("idle");
  const [errorMsg, setErrorMsg] = createSignal<string | null>(null);

  // When the capability startup resolver owns startup (gating ON) it only
  // mounts this tree once the data plane is already reachable, so this gate's
  // own precondition checks are redundant and would only flash a loading
  // spinner for a frame before its async bypass inputs settle. Treat
  // capabilityStartupHandled as an unconditional bypass to render children
  // immediately. Dark-safe: the flag is never set on the gating-OFF path.
  const effectiveBypass = () => props.bypass || capabilityStartupHandled();

  // Form fields — initialised from localStorage cache (if any) so a
  // returning user sees their previous values pre-filled.
  const cache = readEdgeCache();
  const [edgeUrl, setEdgeUrl] = createSignal(cache?.url ?? "");
  const [edgeApiKey, setEdgeApiKey] = createSignal("");
  const [edgeModelName, setEdgeModelName] = createSignal(cache?.modelName ?? "");
  const [edgeBypassProxy, setEdgeBypassProxy] = createSignal(cache?.bypassProxy ?? true);
  const [apiKeyVisible, setApiKeyVisible] = createSignal(false);
  // True once checkExisting adopts a pre-existing edge config. Drives the
  // reactive persist effect below.
  const [adoptedExistingEdge, setAdoptedExistingEdge] = createSignal(false);

  const llmRouterClient = () => {
    const baseUrl = props.hubUrl.trim();
    const token = props.hubToken?.trim() ?? "";
    if (!baseUrl || !token) return null;
    return createLlmRouterClient({ baseUrl, token });
  };

  createEffect(() => {
    if (!effectiveBypass()) return;
    if (state() === "ready") return;
    setState("ready");
    props.onReady?.();
  });

  // Persist edge as the local provider once we've adopted a pre-existing edge
  // config AND the device is confirmed ineligible for local llama. Reactive (not
  // inline in checkExisting) so it still fires when eligibility resolves AFTER
  // the gate is already ready — persistEdgeProvider can flip false→true late,
  // and Model Routing would otherwise be left out of sync. Runs at most once;
  // failures are non-blocking (warn, don't strand the gate). Eligible devices
  // keep persistEdgeProvider false, so their preferred provider is never
  // overridden.
  let edgeProviderPersisted = false;
  createEffect(() => {
    if (!adoptedExistingEdge() || !props.persistEdgeProvider || edgeProviderPersisted) return;
    const client = llmRouterClient();
    if (!client) return;
    edgeProviderPersisted = true;
    void client.setLocalProvider("edge").catch((err) => {
      console.warn("edge gate: failed to persist local_provider=edge", err);
    });
  });

  // ── Precondition gate ───────────────────────────────────────────────
  // Transition from idle → checking-existing once backend is ready and
  // the openwork-server is reachable.  No API calls before this point.
  createEffect(
    on(
      () => [props.backendBootReady, props.serverHealthy, props.serverBaseUrl] as const,
      ([bootReady, healthy, serverUrl]) => {
        if (state() !== "idle") return;
        if (bootReady && healthy && serverUrl) {
          // The gate is only mounted-and-enforced when the device cannot run a
          // local llama model (see app.tsx edgeGateBypass). Whenever the app
          // wants to skip the gate — plain browser dev, no data plane, or an
          // eligible device — it passes bypass=true, handled above. So there is
          // no build-flavor shortcut here: if we reach this point the gate is
          // meant to run, in debug and release alike.
          void checkExisting();
        }
      },
    ),
  );


  // ── Check existing config ───────────────────────────────────────────
  // LRM owns the saved config. Re-read capability before adopting it so a
  // failed Edge activation cannot be skipped on the next launch.
  async function checkExisting() {
    setState("checking-existing");

    try {
      const client = llmRouterClient();
      if (client) {
        const data = await client.getEdge();
        if (data.configured) {
          if (data.base_url) setEdgeUrl(data.base_url);
          if (data.model_name) setEdgeModelName(data.model_name);
          if (typeof data.bypass_proxy === "boolean") setEdgeBypassProxy(data.bypass_proxy);
          const settings = {
            baseUrl: props.hubUrl.trim(),
            token: props.hubToken?.trim() ?? "",
          };
          await ensureSavedEdgeModelActive(
            client,
            settings,
            data.model_name ?? "",
            data.edge_model_selection_fingerprint ?? "",
          );
          writeEdgeCache({
            url: data.base_url ?? edgeUrl(),
            modelName: data.model_name ?? edgeModelName(),
            bypassProxy: data.bypass_proxy ?? edgeBypassProxy(),
          });
          // Record that we adopted an existing edge config. Persisting
          // local_provider=edge is handled by a reactive effect (below) rather
          // than inline here, because eligibility can arrive AFTER the gate is
          // already ready — deviceCanRunLocal (hence persistEdgeProvider) may
          // flip to true later, and Model Routing must still be synced then.
          setAdoptedExistingEdge(true);
          setState("ready");
          props.onReady?.();
          return;
        }
      }
    } catch (err) {
      setErrorMsg(
        activationRequestErrorText(err, "Could not validate the saved Edge configuration. Check the connection and retry."),
      );
    }

    setState("needs-input");
  }

  // ── Apply edge model ────────────────────────────────────────────────
  async function handleApply() {
    const url = edgeUrl().trim();
    if (!url) {
      setErrorMsg("Server URL is required.");
      return;
    }

    setErrorMsg(null);
    setState("applying");

    let model: string;
    let selectionFingerprint: string;
    // 1. Pick a trusted model the server serves, then let LLMRouter validate and probe it before saving.
    try {
      const client = llmRouterClient();
      if (!client) throw new Error("ServiceHub is not connected.");
      const input = { base_url: url, api_key: edgeApiKey().trim(), bypass_proxy: edgeBypassProxy() };
      const test = await client.testEdge(input);
      // testEdge resolves HTTP-200 error envelopes (e.g. bad key, unreachable
      // server) as { status: "error", models: [] }. Surface that before
      // interpreting an empty list, so a connection failure stays actionable
      // instead of being reported as "no supported model".
      if (test.status !== "ok") {
        throw new Error(test.detail?.trim() || test.error || "Edge connection test failed.");
      }
      const models = test.models ?? [];
      model = models.includes(edgeModelName()) ? edgeModelName() : models[0] ?? "";
      if (!model) throw new Error("The Edge server serves no supported model.");
      setEdgeModelName(model);
      const result = await client.putEdge({ ...input, model_name: model });
      selectionFingerprint = result.edge_model_selection_fingerprint;
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Edge server validation failed.");
      setState("error");
      return;
    }

    // 2. LRM hot-reloads edge state per request, no restart needed.
    try {
      const client = llmRouterClient();
      if (!client) throw new Error("ServiceHub is not connected.");
      await ensureSavedEdgeModelActive(
        client,
        {
          baseUrl: props.hubUrl.trim(),
          token: props.hubToken?.trim() ?? "",
        },
        model,
        selectionFingerprint,
      );
      // Explicit user action (filled the form + applied) — always select edge
      // as the local provider. Non-blocking: warn on failure rather than
      // silently swallowing, but still let the gate pass.
      await client.setLocalProvider("edge").catch((err) => {
        console.warn("edge gate: failed to persist local_provider=edge", err);
      });

      writeEdgeCache({ url, modelName: model, bypassProxy: edgeBypassProxy() });
      setState("ready");
      props.onReady?.();
    } catch (err) {
      setErrorMsg(activationRequestErrorText(err, "Network error. Check the server connection."));
      setState("error");
    }
  }

  // ── Gate visibility ─────────────────────────────────────────────────
  const showGate = () => {
    if (effectiveBypass()) return false;
    const s = state();
    return s !== "idle" && s !== "ready";
  };

  // Busy states disable form inputs.
  const busy = () => {
    const s = state();
    return s === "applying" || s === "checking-existing" || s === "auto-connecting";
  };

  // ── Close / exit app ────────────────────────────────────────────────
  function handleCloseApp() {
    if (isTauriRuntime()) {
      import("@tauri-apps/plugin-process")
        .then((mod) => mod.exit(0))
        .catch(() => window.close());
    } else {
      window.close();
    }
  }

  return (
    <>
      <Show when={effectiveBypass() || state() === "ready"}>{props.children}</Show>
      <Show when={showGate()}>
        <div class="fixed inset-0 z-[55] flex items-center justify-center overflow-hidden bg-dls-surface-solid text-dls-text">
          {/* Close / exit app button — top-right corner */}
          <button
            type="button"
            class="absolute top-4 right-4 z-10 rounded-control p-1.5 text-dls-secondary hover:text-dls-text hover:bg-dls-hover/60 transition-colors"
            onClick={handleCloseApp}
            title={t("edge.close_app")}
            aria-label={t("edge.close_app")}
          >
            <X size={18} />
          </button>

          {/* Card */}
          <div class="w-full max-w-md rounded-card border border-dls-border bg-dls-surface-solid shadow-2xl p-6 mx-4 space-y-5">
            {/* Header */}
            <div class="text-center space-y-2">
              <h2 class="text-body-xl leading-title font-semibold text-dls-text">
                {t("edge.startup_title")}
              </h2>
              <p class="text-body-lg text-dls-secondary">
                {t("edge.startup_subtitle")}
              </p>
            </div>

            {/* Error banner */}
            <Show when={errorMsg()}>
              <div class="flex items-start gap-2 rounded-inset border border-dls-danger-border bg-dls-danger-bg p-3 text-body-lg text-dls-danger-text">
                <AlertTriangle size={14} class="mt-0.5 shrink-0" />
                <span>{errorMsg()}</span>
              </div>
            </Show>

            {/* Loading: checking existing config */}
            <Show when={state() === "checking-existing"}>
              <div class="flex flex-col items-center gap-3 py-8">
                <Loader2 size={24} class="animate-spin text-dls-secondary" />
                <p class="text-body-lg text-dls-secondary">
                  {t("edge.checking_status")}
                </p>
              </div>
            </Show>

            {/* Loading: auto-reconnecting with saved config */}
            <Show when={state() === "auto-connecting"}>
              <div class="flex flex-col items-center gap-3 py-8">
                <Loader2 size={24} class="animate-spin text-dls-secondary" />
                <p class="text-body-lg text-dls-secondary">
                  {t("edge.reconnecting")}
                </p>
              </div>
            </Show>

            {/* Loading: saving config */}
            <Show when={state() === "applying"}>
              <div class="flex flex-col items-center gap-3 py-8">
                <Loader2 size={24} class="animate-spin text-dls-secondary" />
                <p class="text-body-lg text-dls-secondary">
                  {t("edge.saving_config")}
                </p>
              </div>
            </Show>

            {/* Form — shown in needs-input and error states */}
            <Show when={state() === "needs-input" || state() === "error"}>
              <form
                class="space-y-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  void handleApply();
                }}
              >
                {/* Server URL */}
                <div class="space-y-1.5">
                  <label class="text-caption font-medium text-dls-secondary">
                    {t("edge.server_url")}
                  </label>
                  <input
                    type="text"
                    class="w-full bg-dls-panel-inset-bg p-2.5 rounded-inset border border-dls-border/60 text-body-lg text-dls-text transition-colors focus:outline-none focus:ring-0 focus:border-[rgb(var(--dls-accent-rgb)/0.55)] focus:bg-dls-panel-hover-bg"
                    value={edgeUrl()}
                    onInput={(e) => setEdgeUrl(e.currentTarget.value)}
                    placeholder={t("edge.server_url_placeholder")}
                    disabled={busy()}
                  />
                </div>

                {/* Connection Key */}
                <div class="space-y-1.5">
                  <label class="text-caption font-medium text-dls-secondary">
                    {t("edge.connection_key")}
                  </label>
                  <div class="relative">
                    <input
                      type={apiKeyVisible() ? "text" : "password"}
                      class="w-full bg-dls-panel-inset-bg p-2.5 pr-9 rounded-inset border border-dls-border/60 text-body-lg text-dls-text transition-colors focus:outline-none focus:ring-0 focus:border-[rgb(var(--dls-accent-rgb)/0.55)] focus:bg-dls-panel-hover-bg"
                      value={edgeApiKey()}
                      onInput={(e) => setEdgeApiKey(e.currentTarget.value)}
                      placeholder={t("edge.connection_key_placeholder")}
                      disabled={busy()}
                    />
                    <button
                      type="button"
                      class="absolute right-2 top-1/2 -translate-y-1/2 text-dls-secondary hover:text-dls-text transition-colors"
                      onClick={() => setApiKeyVisible((v) => !v)}
                      title={apiKeyVisible() ? t("edge.hide_key") : t("edge.show_key")}
                      aria-label={
                        apiKeyVisible()
                          ? t("edge.hide_key")
                          : t("edge.show_key")
                      }
                    >
                      {apiKeyVisible() ? (
                        <EyeOff size={15} />
                      ) : (
                        <Eye size={15} />
                      )}
                    </button>
                  </div>
                </div>

                {/* Bypass proxy */}
                <label class="flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    class="w-3.5 h-3.5 accent-[rgb(var(--dls-accent-rgb)/1)] cursor-pointer"
                    checked={edgeBypassProxy()}
                    onChange={(e) =>
                      setEdgeBypassProxy(e.currentTarget.checked)
                    }
                    disabled={busy()}
                  />
                  <span class="text-caption text-dls-secondary">
                    {t("edge.bypass_proxy_label")}
                  </span>
                </label>

                {/* Actions */}
                <div class="flex items-center justify-end gap-2 pt-2">
                  <Button
                    type="submit"
                    variant="outline"
                    class="text-caption h-8 py-0 px-4"
                    disabled={busy() || !edgeUrl().trim()}
                  >
                    {t("edge.connect_apply")}
                  </Button>
                </div>
              </form>
            </Show>
          </div>
        </div>
      </Show>
    </>
  );
}

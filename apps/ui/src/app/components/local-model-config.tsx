import { createSignal, createMemo, createEffect, on, Show, type JSX } from "solid-js";
import { AlertTriangle, Loader2 } from "lucide-solid";

import { t } from "../../i18n";
import Button from "./button";
import Dropdown from "~/shared/ui/dropdown";
import ProviderConnectionCard, { FIELD_LABEL_CLASS } from "./provider-connection-card";
import RestartRequiredDialog from "~/shared/ui/restart-required-dialog";
import { Tooltip } from "~/shared/ui/tooltip";
import type {
  LlmRouterClient,
  LlmRouterLocalProvider,
} from "../lib/llmrouter-client";
import type { ModelWarning, PrimaryBundleCapability } from "@different-ai/openwork-contracts/capability";
import { servingProviderStatus, type LocalModelHealthInfo } from "../lib/local-model-availability";
import { edgeDegraded } from "~/shared/platform/capability/edge-degraded-signal";

const MODEL_WARNING_TEXT_KEYS: Record<ModelWarning, string> = {
  below_default_benchmark_limited_testing: "local.warning_below_default_benchmark_limited_testing",
};

/**
 * A compute-supported Local Bundle exposed by LRM.
 *
 */
type LocalTier = {
  /** Bundle id used as target_bundle_id for the switch. */
  id: string;
  /** Human-friendly label for the dropdown (bundle display name). */
  label: string;
  /** Chat-model caveats shown next to the dropdown while this bundle is selected. */
  warnings?: ModelWarning[];
};

type ProviderState = {
  provider: LlmRouterLocalProvider | "";
  eligible: boolean;
};

// The last provider read, kept outside the component because Settings unmounts
// on every tab switch. A remount shows the Edge card or the llama.cpp panel at
// once instead of an empty card that grows when the read returns, so the Model
// page keeps one height and the scrollbar does not jump.
// `prefetchLocalProvider` fills it at start-up for the first visit.
let cachedProviderState: ProviderState | null = null;

async function readProviderState(lrm: LlmRouterClient): Promise<ProviderState> {
  const providerInfo = await lrm.getLocalProvider();
  const eligible = providerInfo.available_providers.includes("llamacpp");
  // Default the provider dropdown. The committed primary bundle is the
  // authority: if edge is committed, show edge; otherwise (llama committed,
  // or nothing committed yet on first launch — the app auto-brings up the
  // local llama ceiling bundle) default to llamacpp whenever eligible.
  // We deliberately do NOT prefer the persisted local_provider here — it
  // can be a stale value that would wrongly land on edge at first launch.
  let provider: LlmRouterLocalProvider | "" = "";
  try {
    const cap = await lrm.getPrimaryBundleCapability();
    if (cap.primary_bundle?.backend === "edge") provider = "edge";
    else if (eligible) provider = "llamacpp";
  } catch {
    // Capability probe failed — fall back to llamacpp when eligible so the
    // first-launch default still lands on the local model, not edge.
    if (eligible) provider = "llamacpp";
  }
  cachedProviderState = { provider, eligible };
  return cachedProviderState;
}

/** Read the local provider ahead of the first Settings visit. Best-effort. */
export function prefetchLocalProvider(lrm: LlmRouterClient | null): void {
  if (lrm) void readProviderState(lrm).catch(() => undefined);
}

export type LocalModelConfigProps = {
  /** Whether an edge server is already configured (drives the edge default badge). */
  edgeConfigured: boolean;
  /** Pre-wired <EdgeServerCard/> from the parent, rendered when provider === "edge". */
  edgeCard: JSX.Element;
  /** Accessor for the ServiceHub-backed LLM router client (null until connected). */
  llmRouter: () => LlmRouterClient | null;
  /** The committed primary-bundle capability from the parent (single source of
   *  truth for the hardware ceiling + which backend is connected). When absent
   *  the component fetches its own snapshot. */
  capability?: () => PrimaryBundleCapability | null;
  /** Polled local-slot health; an unhealthy edge must not read as "In use". */
  localModelHealth?: () => LocalModelHealthInfo | null;
  /** Stage a switch to the selected local (llama) bundle. */
  onConnectLocal?: (bundleId: string) => Promise<boolean>;
  /** Progress line while the model switch is being applied. */
  switchMessage?: string | null;
  /** Error surfaced if applying the switch failed. */
  switchError?: string | null;
  /** Per-step probe checklist for the model-change dialog. */
  switchSteps?: import("~/shared/ui/restart-required-dialog").BundleSwitchStep[] | null;
  /** True while the staged model switch is being applied. */
  applying?: boolean;
  canResume?: boolean;
  /** Apply the staged switch; true means it completed without an App restart. */
  onApply?: () => Promise<boolean>;
  /** Discard the staged local Connect switch and clear its UI state ("Cancel"). */
  onCancelSwitch?: () => void;
  /** Bumped when Edge Connect is pressed; clears this panel's llama.cpp hints. */
  clearHintsKey?: number;
};

export default function LocalModelConfig(props: LocalModelConfigProps): JSX.Element {
  const [provider, setProvider] = createSignal<LlmRouterLocalProvider | "">(cachedProviderState?.provider ?? "");
  const [llamaEligible, setLlamaEligible] = createSignal(cachedProviderState?.eligible ?? false);

  const [tiers, setTiers] = createSignal<LocalTier[]>([]);
  const [selectedTierId, setSelectedTierId] = createSignal<string>("");
  const [modelsLoading, setModelsLoading] = createSignal(false);
  // The v1.2 primary-bundle capability projection — the single authoritative
  // source for the hardware ceiling AND which backend is currently committed.
  // Prefer the parent-provided snapshot (shared with the Edge card so the two
  // panels stay mutually consistent); fall back to a locally fetched one.
  const [fetchedCapability, setFetchedCapability] = createSignal<PrimaryBundleCapability | null>(null);
  const capability = () => props.capability?.() ?? fetchedCapability();

  // The provider actually committed / serving right now — the authoritative
  // primary_bundle.backend, not the dropdown's optimistic selection. Switching
  // provider only takes effect after the staged change is applied, so this can differ from
  // `provider()`; surfacing it tells the user which provider is really in use.
  //
  // The health poll writes null both before its first result and when a read
  // throws. Only the first means "unknown": keep the last real result, so one
  // failed read cannot turn an unreachable edge green without a passing probe.
  const lastKnownHealth = createMemo<LocalModelHealthInfo | null>(
    (previous) => props.localModelHealth?.() ?? previous,
    null,
  );
  const servingProvider = createMemo(() => {
    const serving = servingProviderStatus(capability()?.primary_bundle, lastKnownHealth());
    // A committed Edge that failed to connect at startup is not in use (#3531).
    const degraded = edgeDegraded();
    if (serving?.provider !== "edge" || !degraded) return serving;
    // A failed Profile read after Edge connected is not an unreachable server.
    const unreachable = degraded.state === "unreachable" && !degraded.profileLoadFailed;
    return { ...serving, status: unreachable ? "unreachable" as const : "not_ready" as const };
  });
  const servingProviderLabel = () => {
    const serving = servingProvider();
    if (!serving) return null;
    return serving.provider === "edge" ? t("local.provider_edge") : t("local.provider_llama");
  };

  const [testingId, setTestingId] = createSignal<string | null>(null);
  const [testResult, setTestResult] = createSignal<{ tierId: string; healthy: boolean } | null>(null);
  const [actionError, setActionError] = createSignal<string | null>(null);

  // Local Connect stages a primary-bundle switch. The shared switch state lives
  // in the parent; the real switch runs only after explicit confirmation.
  const [localApplyOpen, setLocalApplyOpen] = createSignal(false);
  createEffect(
    on(
      () => props.clearHintsKey,
      () => {
        setActionError(null);
        setTestResult(null);
      },
      { defer: true },
    ),
  );
  const handleConnectLocal = async () => {
    if (!props.onConnectLocal) return;
    setActionError(null);
    try {
      // Run the switch preflight first. Only open the apply-confirmation dialog
      // when the switch was actually staged (staged === true). A hardware
      // preflight block returns false and surfaces its own dialog instead, so
      // the confirm dialog must not appear on top of it.
      const tier = selectedTier();
      if (!tier) return;
      const staged = await props.onConnectLocal(tier.id);
      if (staged) setLocalApplyOpen(true);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : t("local.provider_switch_failed"));
      setLocalApplyOpen(false);
    }
  };

  const refreshModels = async () => {
    const lrm = props.llmRouter();
    if (!lrm) return;
    setModelsLoading(true);
    try {
      setFetchedCapability(await lrm.getPrimaryBundleCapability());
    } finally {
      setModelsLoading(false);
    }
  };

  // Show every compute-supported Local Bundle. Prefer the committed local
  // Binding, then the hardware recommendation, when choosing the initial row.
  createEffect(() => {
    const cap = capability();
    const list: LocalTier[] = (cap?.supported_bundles ?? [])
      .filter((bundle) => bundle.backend === "llama")
      .map((bundle) => ({ id: bundle.bundle_id, label: bundle.display_name, warnings: bundle.model_warnings }));
    setTiers(list);
    const current = selectedTierId();
    if (!current || !list.some((tier) => tier.id === current)) {
      const preferredId =
        (cap?.primary_bundle?.backend === "llama" ? cap.primary_bundle.bundle_id : null) ??
        cap?.recommended_bundle_id ??
        cap?.hardware_capability_ceiling?.bundle_id;
      setSelectedTierId(
        (preferredId && list.some((tier) => tier.id === preferredId) ? preferredId : list[0]?.id) ?? "",
      );
    }
  });

  // Initialise provider/eligibility once the router client is available.
  let initialized = false;
  let providerSelectionGeneration = 0;
  createEffect(() => {
    const lrm = props.llmRouter();
    if (!lrm || initialized) return;
    initialized = true;
    void (async () => {
      const selectionGeneration = providerSelectionGeneration;
      try {
        const state = await readProviderState(lrm);
        setLlamaEligible(state.eligible);
        if (state.provider && selectionGeneration === providerSelectionGeneration) {
          setProvider(state.provider);
        }
        if (state.eligible) await refreshModels();
      } catch {
        // Allow a later client change to retry seeding.
        initialized = false;
      }
    })();
  });

  const selectedTier = createMemo(() => tiers().find((tier) => tier.id === selectedTierId()) ?? null);
  // "connected" is the single authoritative truth from the committed primary
  // bundle: this llama bundle is connected iff the committed primary_bundle has
  // backend "llama" and matches this bundle id. Because there is exactly ONE
  // committed primary bundle, llama and edge are mutually exclusive — the edge
  // card and this panel can never both read "connected" at the same time.
  type TierState = "not-connected" | "connected";
  const tierState = (tier: LocalTier): TierState => {
    const primary = capability()?.primary_bundle;
    if (primary && primary.backend === "llama" && primary.bundle_id === tier.id) return "connected";
    return "not-connected";
  };

  // Persist the local backend choice. Switching to edge stops the llama-server;
  // returning to llamacpp re-reads runtime state so a tier displaced by the edge
  // switch no longer shows as connected. On failure, revert and surface the error.
  const handleProviderChange = async (next: string) => {
    if (next !== "edge" && next !== "llamacpp") return;
    if (next === "llamacpp" && !llamaEligible()) return;
    const lrm = props.llmRouter();
    if (!lrm) return;
    providerSelectionGeneration += 1;
    const previous = provider();
    setActionError(null);
    setProvider(next);
    try {
      // Persisting the provider intent is the only failure that should revert
      // the dropdown. It returns quickly and only rejects on a real error.
      await lrm.setLocalProvider(next);
    } catch (error) {
      setProvider(previous);
      setActionError(error instanceof Error ? error.message : t("local.provider_switch_failed"));
      return;
    }
    // Refreshing the model list is best-effort: getPrimaryBundleCapability can
    // transiently fail/timeout while edge is the committed primary (the LRM can
    // briefly report a null primary_bundle during startup/switch windows). That
    // must NOT roll the selection back to edge — the intent above already
    // persisted; the tier list will refresh on the next capability tick.
    if (next === "llamacpp") {
      try {
        await refreshModels();
      } catch {
        /* soft failure — keep the llamacpp selection */
      }
    }
  };

  // Test connection: re-read the primary-bundle capability and report whether
  // THIS bundle is the committed, ready primary bundle (backend "llama",
  // matching id, lifecycle state "ready").
  const handleTest = async (tierId: string) => {
    const lrm = props.llmRouter();
    if (!lrm) return;
    setActionError(null);
    setTestingId(tierId);
    try {
      const cap = await lrm.getPrimaryBundleCapability();
      setFetchedCapability(cap);
      const primary = cap.primary_bundle;
      const healthy = Boolean(
        primary && primary.backend === "llama" && primary.bundle_id === tierId && primary.state === "ready",
      );
      setTestResult({ tierId, healthy });
    } catch {
      setTestResult({ tierId, healthy: false });
    } finally {
      setTestingId(null);
    }
  };

  return (
    <ProviderConnectionCard>
      <div class="space-y-2.5">
        <div class="flex items-center gap-2">
          <label class={FIELD_LABEL_CLASS}>{t("local.provider_label")}</label>
          <Show when={servingProvider()}>
            {(serving) => (
              <Show
                when={serving().status === "in_use"}
                fallback={
                  <span class="inline-flex items-center gap-1.5 rounded-pill border border-dls-warning-border bg-dls-warning-bg px-2 py-0.5 text-tiny font-semibold text-dls-warning-text">
                    <span class="h-1.5 w-1.5 rounded-pill bg-dls-warning-dot" aria-hidden="true" />
                    {servingProviderLabel()} ·{" "}
                    {serving().status === "unreachable"
                      ? t("local.status_unreachable")
                      : serving().status === "not_serving"
                        ? t("local.status_not_serving")
                        : t("local.status_not_ready")}
                  </span>
                }
              >
                <span class="inline-flex items-center gap-1.5 rounded-pill border border-dls-success-border bg-dls-success-bg px-2 py-0.5 text-tiny font-semibold text-dls-success-text">
                  <span class="h-1.5 w-1.5 rounded-pill bg-dls-success-dot" aria-hidden="true" />
                  {t("local.currently_using")} {servingProviderLabel()}
                </span>
              </Show>
            )}
          </Show>
        </div>
        <Dropdown
          class="max-w-md"
          value={provider()}
          placeholder={t("local.select_provider")}
          options={[
            { value: "edge", label: t("local.provider_edge") },
            ...(llamaEligible() ? [{ value: "llamacpp", label: t("local.provider_llama") }] : []),
          ]}
          onChange={(value) => void handleProviderChange(value)}
        />
        <Show when={!llamaEligible()}>
          <div class="text-label text-dls-secondary">{t("local.llama_ineligible")}</div>
        </Show>
      </div>

      {/* Provider-switch / connect errors live at the card root so a failed
          switch stays visible even when the revert unmounts the active branch. */}
      <Show when={actionError()}>
        <div class="flex items-start gap-2 rounded-inset border border-dls-danger-border bg-dls-danger-bg px-3 py-2 text-caption text-dls-danger-text">
          <AlertTriangle size={14} class="shrink-0 mt-0.5" />
          <span>{actionError()}</span>
        </div>
      </Show>

      <Show when={provider() === "edge"}>{props.edgeCard}</Show>

      <Show when={provider() === "llamacpp" && llamaEligible()}>
        <div class="space-y-3">
          <div class="space-y-2.5">
            <label class={FIELD_LABEL_CLASS}>{t("local.model_label")}</label>
            <Show when={testResult()?.tierId === selectedTierId() ? testResult() : null} keyed>
              {(result) => (
                <Show
                  when={result.healthy}
                  fallback={
                    <div class="max-w-md rounded-inset border border-dls-danger-border bg-dls-danger-bg p-3 text-body-lg text-dls-danger-text">
                      {t("settings.connection_test_failed")}
                    </div>
                  }
                >
                  <div class="max-w-md rounded-inset border border-dls-success-border bg-dls-success-bg p-3 text-body-lg text-dls-success-text">
                    {t("settings.connection_test_succeeded")}
                  </div>
                </Show>
              )}
            </Show>
            <div class="flex items-center gap-2">
              <Dropdown
                class="w-full min-w-0 max-w-md"
                value={selectedTierId()}
                placeholder={t("local.select_model")}
                disabled={modelsLoading()}
                options={tiers().map((tier) => ({
                  value: tier.id,
                  label: `${tier.label}${
                    tierState(tier) === "connected" ? ` · ${t("local.state_connected")}` : ""
                  }`,
                }))}
                onChange={(value) => setSelectedTierId(value)}
              />
              <Show when={selectedTier()?.warnings}>
                {(warnings) => {
                  const warningText = () =>
                    warnings()
                      .map((warning) => t(MODEL_WARNING_TEXT_KEYS[warning]))
                      .join("\n");
                  return (
                    <Tooltip content={warningText()} focusable>
                      <span role="img" aria-label={warningText()}>
                        <AlertTriangle
                          size={16}
                          aria-hidden="true"
                          class="shrink-0 text-dls-warning-text"
                          data-testid="local-model-warning"
                        />
                      </span>
                    </Tooltip>
                  );
                }}
              </Show>
            </div>
          </div>

          <Show when={selectedTier()}>
            {(tier) => (
              <div class="flex items-center justify-end gap-2">
                {/* Not yet the serving model: Connect stages a primary-bundle
                    switch to this bundle. Prepare downloads missing assets after
                    the user confirms Apply. */}
                <Show when={tierState(tier()) !== "connected"}>
                  <Button
                    type="button"
                    variant="outline"
                    class="text-caption h-8 py-0 px-4"
                    disabled={props.applying || !props.onConnectLocal}
                    onClick={() => void handleConnectLocal()}
                  >
                    {t("common.connect")}
                  </Button>
                </Show>

                {/* Serving model → probe it (Test). No Disconnect in v1.2: the
                    committed primary bundle can only change by connecting the
                    other backend, so there is nothing to "disconnect" here. */}
                <Show when={tierState(tier()) === "connected"}>
                  <Button
                    type="button"
                    variant="outline"
                    class="text-caption h-8 py-0 px-4"
                    disabled={testingId() === tier().id}
                    onClick={() => void handleTest(tier().id)}
                  >
                    <Show when={testingId() === tier().id} fallback={t("settings.test_connection")}>
                      <Loader2 size={12} class="animate-spin" />
                    </Show>
                  </Button>
                </Show>
              </div>
            )}
          </Show>

          {/* Progress and confirmation for the Connect-staged model switch. */}
          <RestartRequiredDialog
            open={localApplyOpen()}
            onApply={async () => {
              if (await props.onApply?.()) setLocalApplyOpen(false);
            }}
            applying={props.applying}
            resume={props.canResume}
            progressMessage={props.switchMessage}
            progressError={props.switchError}
            steps={props.switchSteps ?? undefined}
            onNotNow={() => {
              setLocalApplyOpen(false);
              props.onCancelSwitch?.();
            }}
          />
        </div>
      </Show>
    </ProviderConnectionCard>
  );
}

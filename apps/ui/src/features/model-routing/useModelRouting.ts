import { createSignal, onCleanup } from "solid-js";
import type {
  ActiveAppCapabilityProfile,
  ModelBindingActivationStage,
} from "@different-ai/openwork-contracts/capability";
import { t } from "../../i18n";
import {
  buildEdgeConnectActivationRequest,
  buildEdgeDisconnectActivationRequest,
  buildLocalBundleActivationRequest,
  canDisconnectEdge,
  cancelModelBindingActivation,
  fetchPrimaryBundleCapability,
  fetchModelBindingActivationOperation,
  putPerfWeight,
  resumeModelBindingActivation,
  startModelBindingActivation,
  type PrimaryBundleCapability,
  type ModelBindingActivationRequest,
} from "~/shared/platform/capability/model-binding-activation-client";
import { activationErrorText, activationRequestErrorText } from "~/shared/platform/capability/activation-error-text";
import { fetchSystemPreflight } from "~/shared/platform/capability/system-preflight-client";
import {
  evaluateHardwarePreflight,
  type HardwareFailure,
} from "~/shared/platform/capability/preflight-policy";
import { routingDefaultsForBundle } from "~/shared/platform/capability/routing-defaults";
import { edgeDegraded } from "~/shared/platform/capability/edge-degraded-signal";
import { toBundleSwitchStepState } from "~/shared/util/bundle-switch-step-progress";
import type { BundleSwitchStep } from "~/shared/ui/restart-required-dialog";
import {
  createLlmRouterClient,
  type LlmRouterEdgeConfig,
  type LlmRouterProviderOption,
} from "~/shared/platform/transport/llmrouter-client";
import {
  refreshManagedWorkspaceToken,
} from "~/shared/platform/transport/managed-workspace-token-refresh";

type LlmRouterClient = ReturnType<typeof createLlmRouterClient>;

export type UseModelRoutingDeps = {
  serviceHubSettings: () => { baseUrl: string; token: string } | null;
  llmRouterClient: () => LlmRouterClient | null;
  llmRouterProviders: () => LlmRouterProviderOption[];
  refreshLocalModelHealth: () => Promise<void>;
  refreshCapabilityProfile: () => Promise<unknown>;
  /** The active Product Profile; its Binding decides whether Edge can be disconnected. */
  activeProfile: () => ActiveAppCapabilityProfile | null;
  syncWorkspaceToken: Parameters<typeof refreshManagedWorkspaceToken>[1];
};

// Pending cross-backend switch staged by Connect and applied only after user
// confirmation. Nothing is switched, and for Edge no credentials are saved,
// until Apply runs. Cancel just clears this state.
type PendingBundleSwitch =
  | {
    kind: "edge";
    input: {
      base_url: string;
      api_key: string;
      model_name: string;
      bypass_proxy?: boolean;
    };
  }
  | { kind: "local"; bundleId: string };

// Poll a running switch until it reaches a terminal state, resolving to that
// outcome. Unlike a fire-and-forget poll, this is awaited by
// `applyBundleSwitch` so the switch fully lands before the UI refreshes.
type BundleSwitchOutcome =
  | { status: "succeeded" }
  | { status: "failed"; message: string }
  | { status: "stale" }; // superseded by a newer generation (cancel)

export function createModelRoutingFeature(deps: UseModelRoutingDeps) {
  const { serviceHubSettings, llmRouterClient, llmRouterProviders, refreshLocalModelHealth } = deps;

  const [cloudModel, setCloudModel] = createSignal<
    Awaited<ReturnType<LlmRouterClient["getCloudModel"]>> | null
  >(null);
  // True only when LLMRouter answered that no cloud model is saved. A failed or
  // pending read leaves it false, so a slow start never looks like "not set".
  const [cloudModelMissing, setCloudModelMissing] = createSignal(false);
  const [cloudModelHealthError, setCloudModelHealthError] = createSignal<
    string | null
  >(null);
  const [cloudModelLoading, setCloudModelLoading] = createSignal(false);
  const [cloudModelSaving, setCloudModelSaving] = createSignal(false);
  const [cloudModelDeleting, setCloudModelDeleting] = createSignal(false);
  const [cloudModelTesting, setCloudModelTesting] = createSignal(false);
  const [edgeConfig, setEdgeConfig] = createSignal<LlmRouterEdgeConfig | null>(
    null,
  );
  const [edgeTesting, setEdgeTesting] = createSignal(false);
  const [edgeError, setEdgeError] = createSignal<string | null>(null);
  // v1.2 committed primary-bundle capability — the SINGLE source of truth for
  // which backend (llama | edge) is currently the connected primary bundle. Both
  // the Edge card and the local (llama) panel derive their "connected" state
  // from this so they are mutually exclusive (never both connected at once).
  const [primaryBundleCapability, setPrimaryBundleCapability] =
    createSignal<PrimaryBundleCapability | null>(null);
  const committedBackend = () =>
    primaryBundleCapability()?.primary_bundle?.backend ?? null;
  // A committed Edge that failed to connect at startup is not connected (#3531): this
  // keeps the card from claiming it and leaves its Connect button usable.
  const edgeConnected = () => committedBackend() === "edge" && edgeDegraded() === null;
  // Lite hardware only: other hardware leaves Edge by connecting a local Bundle.
  const edgeDisconnectAvailable = () =>
    canDisconnectEdge(primaryBundleCapability(), deps.activeProfile());
  const [edgeDisconnecting, setEdgeDisconnecting] = createSignal(false);
  // Edge Bundle primary-bundle switch state (Connect Edge → full-hdr). See
  // docs/design/2026-07-18_edge_server_full_hdr_activation_implementation_plan.md
  // The real switch runs inside `applyBundleSwitch` after explicit confirmation.
  const [bundleSwitchOperationId, setBundleSwitchOperationId] = createSignal<
    string | null
  >(null);
  const [bundleSwitchMessage, setBundleSwitchMessage] = createSignal<
    string | null
  >(null);
  const [bundleSwitchError, setBundleSwitchError] = createSignal<string | null>(
    null,
  );
  const [bundleSwitchSteps, setBundleSwitchSteps] = createSignal<
    BundleSwitchStep[] | null
  >(null);
  const [bundleSwitchApplying, setBundleSwitchApplying] = createSignal(false);
  const [bundleSwitchCanResume, setBundleSwitchCanResume] = createSignal(false);
  let bundleSwitchNeedsResume = false;
  // True when this staged edge switch wrote edge.json without probing it. It
  // lives with the staged operation, not one Apply call: a Retry resumes the
  // operation without calling putEdge again, and the credentials stay unverified.
  let edgeSavedUnverified = false;
  // True once the switch operation reached a terminal state (succeeded/failed/
  // recovery). While false with an operation id set, the operation is still
  // in-flight and can be cancelled on ServiceHub.
  const [bundleSwitchSettled, setBundleSwitchSettled] = createSignal(false);
  // Transient "Edge connected." confirmation shown after Apply connects an Edge server.
  const [edgeUpdatedMessage, setEdgeUpdatedMessage] = createSignal<
    string | null
  >(null);
  const [pendingBundleSwitch, setPendingBundleSwitch] =
    createSignal<PendingBundleSwitch | null>(null);
  // Hardware preflight block for an edge → llama switch. Non-empty while the
  // requirements dialog is shown; dismissing it just cancels the switch (the
  // user keeps running on edge), unlike the startup gate which exits the app.
  const [switchHardwareFailures, setSwitchHardwareFailures] = createSignal<
    HardwareFailure[]
  >([]);

  // Reads can overlap (a Connect, a delete and a mount can each start one), and
  // `cloudModelMissing` hides Cloud and moves Cloud chats to Auto. So only the
  // newest read may write: an older 404 that lands late must not undo a Connect.
  let cloudModelReadGeneration = 0;
  const refreshCloudModel = async () => {
    const generation = ++cloudModelReadGeneration;
    const lrm = llmRouterClient();
    if (!lrm) {
      setCloudModel(null);
      setCloudModelHealthError(null);
      setCloudModelLoading(false);
      return;
    }

    setCloudModelLoading(true);
    try {
      setCloudModelHealthError(null);
      try {
        const model = await lrm.getCloudModel();
        if (generation !== cloudModelReadGeneration) return;
        setCloudModel(model);
        setCloudModelMissing(false);
      } catch (error) {
        if (generation !== cloudModelReadGeneration) return;
        setCloudModel(null);
        // Only the backend's own "no cloud model" answer means Cloud is not
        // set up. Any other 404 (a route that moved, a proxy) is an error.
        const { status, code } = error as { status?: number; code?: string };
        setCloudModelMissing(status === 404 && code === "not_configured");
      }
    } finally {
      if (generation === cloudModelReadGeneration) setCloudModelLoading(false);
    }
  };

  // A ServiceHub-proxied llm-router that is still coming up surfaces either as a
  // transport/timeout failure (Error with no `status`) or as a 502/503/504 from
  // the proxy's error_normalizer. Both are transient and worth a bounded retry;
  // any other HTTP status (notably 4xx auth/config) is terminal.
  const isTransientHubError = (err: unknown): boolean => {
    const status = (err as { status?: number } | null)?.status;
    return (
      status === undefined || status === 502 || status === 503 || status === 504
    );
  };

  const refreshEdgeConfig = async () => {
    const lrm = llmRouterClient();
    if (!lrm) {
      setEdgeConfig(null);
      return;
    }
    // getEdge() returns 200 {configured:false} when genuinely unconfigured. A
    // throw is either a transient early-boot failure — transport/timeout (no
    // status) or the ServiceHub proxy reporting a still-starting llm-router as
    // 502/503/504 (see servicehub proxy error_normalizer) — or a terminal
    // 4xx auth/config error. Retry only the transient class; fail fast on the
    // rest so a real error is surfaced instead of masked by ~5s of retries.
    const MAX_ATTEMPTS = 5;
    const RETRY_DELAY_MS = 1000;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        setEdgeConfig(await lrm.getEdge());
        return;
      } catch (err) {
        if (!isTransientHubError(err) || attempt === MAX_ATTEMPTS) {
          setEdgeConfig(null);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      }
    }
  };

  // Refresh the committed primary-bundle capability (best-effort). Drives the
  // mutually-exclusive "connected" state of the Edge card and llama panel. A
  // 503 (still loading) or any transient error just leaves the previous value.
  const refreshPrimaryBundleCapability = async () => {
    const settings = serviceHubSettings();
    if (!settings) {
      setPrimaryBundleCapability(null);
      return;
    }
    try {
      setPrimaryBundleCapability(await fetchPrimaryBundleCapability(settings));
    } catch {
      // Leave the prior snapshot; a later refresh (post-connect) will retry.
    }
  };

  const refreshBundleSwitchState = async () => {
    const settings = serviceHubSettings();
    if (!settings) return;
    await Promise.allSettled([
      deps.refreshCapabilityProfile(),
      refreshPrimaryBundleCapability(),
      refreshLocalModelHealth(),
      refreshEdgeConfig(),
    ]);
  };

  const saveCloudModel = async (input: {
    provider: string;
    model: string;
    max_tokens?: number;
    context_limit?: number;
  }) => {
    const lrm = llmRouterClient();
    if (!lrm) throw new Error("ServiceHub is not connected.");
    setCloudModelSaving(true);
    try {
      // Auto-detect auth_mode: OAuth wins when a session exists for the
      // picked provider. Users who want to force api_key must delete the
      // OAuth session first (single-source-of-truth per provider).
      const providerEntry = llmRouterProviders().find(
        (item) => item.id === input.provider,
      );
      const authMode: "oauth" | "api_key" = providerEntry?.oauthSet
        ? "oauth"
        : "api_key";
      await lrm.putCloudModel({ ...input, auth_mode: authMode });
      await refreshCloudModel();
    } finally {
      setCloudModelSaving(false);
    }
  };

  const deleteCloudModel = async () => {
    const lrm = llmRouterClient();
    if (!lrm) throw new Error("ServiceHub is not connected.");
    setCloudModelDeleting(true);
    try {
      await lrm.deleteCloudModel();
      await refreshCloudModel();
    } finally {
      setCloudModelDeleting(false);
    }
  };

  const testProviderConnection = async (input: {
    provider: string;
    model?: string;
  }) => {
    const lrm = llmRouterClient();
    if (!lrm) throw new Error("ServiceHub is not connected.");
    setCloudModelTesting(true);
    try {
      const model = input.model?.trim();
      const result = await lrm.testProvider(
        input.provider,
        model ? { model } : undefined,
      );
      if (result.status !== "ok") {
        const detail = result.detail ?? result.error ?? "Provider test failed.";
        // A listed model the chat endpoint rejects is a fixable user choice,
        // not a broken provider, so lead with what to do about it.
        throw new Error(
          result.error === "model_unavailable"
            ? `${t("model.test_model_unavailable")} ${detail}`
            : detail,
        );
      }
    } finally {
      setCloudModelTesting(false);
    }
  };

  // --- Connect Edge → primary-bundle switch (Phase 3) ------------------------
  // A dedicated, lightweight poll loop — NOT the CapabilityStartupResolver's
  // Phase B polling, which is the first-launch/pre-mount path and stays
  // untouched. This is the "App already mounted, user is in Settings" case.
  let bundleSwitchPollTimer: ReturnType<typeof setTimeout> | null = null;
  let bundleSwitchGeneration = 0;
  // Each edge probe takes under a second, so a slower poll skips step states
  // and the checklist falls behind the server.
  const BUNDLE_SWITCH_POLL_MS = 400;
  // Target bundle of the in-flight switch, captured when the request is built.
  // Used to reset the Routing Balance to the target bundle's default exactly
  // once when the switch settles (never on ordinary mount/restart).
  let bundleSwitchTargetBundleId: string | null = null;
  let bundleSwitchRoutingDefaultApplied = false;

  const stopBundleSwitchPoll = () => {
    if (bundleSwitchPollTimer) {
      clearTimeout(bundleSwitchPollTimer);
      bundleSwitchPollTimer = null;
    }
  };
  onCleanup(stopBundleSwitchPoll);

  const resetBundleSwitchState = (): number => {
    bundleSwitchGeneration += 1;
    stopBundleSwitchPoll();
    bundleSwitchTargetBundleId = null;
    bundleSwitchRoutingDefaultApplied = false;
    setBundleSwitchOperationId(null);
    setBundleSwitchMessage(null);
    setBundleSwitchError(null);
    setBundleSwitchSteps(null);
    setBundleSwitchApplying(false);
    setBundleSwitchCanResume(false);
    bundleSwitchNeedsResume = false;
    edgeSavedUnverified = false;
    setBundleSwitchSettled(false);
    setEdgeUpdatedMessage(null);
    setPendingBundleSwitch(null);
    return bundleSwitchGeneration;
  };

  const bundleSwitchStageMessage = (stage: ModelBindingActivationStage): string => {
    const pending = pendingBundleSwitch();
    const isEdge = pending?.kind === "edge";
    switch (stage) {
      case "preparing":
        return isEdge
          ? t("capability.switch_phase.connecting_edge")
          : t("capability.switch_phase.preparing_local");
      default:
        return t("capability.switch_phase.applying");
    }
  };

  // Reset the persisted Routing Balance (perf_weight) to the target bundle's
  // default when a bundle switch settles. This is the ONLY migration boundary
  // where we overwrite the persisted balance. The value is graded by how much
  // the target bundle can carry locally — see `routingDefaultsForBundle`, which
  // owns the policy:
  //   local-4b   -> 0.85 (weak local: lean on cloud)
  //   any other  -> 0.7  (35B / edge-80B carry more locally)
  // Fires once per switch, best-effort.
  const applyRoutingDefaultForSwitch = async (): Promise<void> => {
    if (bundleSwitchRoutingDefaultApplied) return;
    const defaults = routingDefaultsForBundle(bundleSwitchTargetBundleId);
    if (!defaults) return;
    bundleSwitchRoutingDefaultApplied = true;
    const settings = serviceHubSettings();
    if (!settings) return;
    try {
      await putPerfWeight(settings, defaults.perfWeight);
    } catch {
      // Best-effort: a failed reset must not block switch completion.
      // Allow a later settle re-attempt if this one failed.
      bundleSwitchRoutingDefaultApplied = false;
    }
  };

  // Best-effort read of the LRM prepare op's metadata.files (checklist rows).
  // While the switch is applying, the poll does not wait for it: a slow or down
  // prepare endpoint must not hold back the status checks. Only one read runs
  // at a time, so a hung endpoint does not pile up requests at the poll
  // interval. A request that arrives during a read is kept (newest only) and
  // runs next, so the last poll's step states are still read. The returned
  // promise settles once that queued read has run too.
  let prepareStepsReadInFlight = false;
  let prepareStepsReadDone: Promise<void> = Promise.resolve();
  let queuedPrepareStepsRead: { lrmPrepareId: string; generation: number } | null = null;
  const readPrepareSteps = async (
    lrmPrepareId: string | undefined,
    generation: number,
  ): Promise<void> => {
    if (!lrmPrepareId) return;
    if (prepareStepsReadInFlight) {
      queuedPrepareStepsRead = { lrmPrepareId, generation };
      return prepareStepsReadDone;
    }
    const lrm = llmRouterClient();
    if (!lrm) return;
    prepareStepsReadInFlight = true;
    const read = (async () => {
      try {
        const lrmOp = await lrm.getOperation(lrmPrepareId, {
          timeoutMs: 5_000,
        });
        // A reset or a new switch since this read started makes its rows stale.
        if (generation !== bundleSwitchGeneration) return;
        const files = lrmOp.metadata?.files;
        if (!Array.isArray(files)) return;
        setBundleSwitchSteps(
          files.map<BundleSwitchStep>((entry) => ({
            id: entry.id,
            label: entry.label ?? entry.id,
            // Total mapping, not a whitelist: `downloading` used to fall through
            // to `pending`, so a multi-GB transfer drew a hollow "not started"
            // circle for its whole duration.
            state: toBundleSwitchStepState(entry.state),
            role: entry.role,
            error_code: entry.error_code,
            error_detail: entry.error_detail,
            doneBytes: entry.done,
            totalBytes: entry.total,
          })),
        );
      } catch {
        // no-op
      } finally {
        // In `finally`, so a stale or file-less reply still releases the slot
        // and runs the read queued behind it.
        prepareStepsReadInFlight = false;
        const queued = queuedPrepareStepsRead;
        queuedPrepareStepsRead = null;
        if (queued && queued.generation === bundleSwitchGeneration) {
          await readPrepareSteps(queued.lrmPrepareId, queued.generation);
        }
      }
    })();
    prepareStepsReadDone = read;
    return read;
  };

  const pollBundleSwitchOperation = async (
    operationId: string,
    generation: number,
    startPrepareId?: string,
  ): Promise<BundleSwitchOutcome> => {
    const settings = serviceHubSettings();
    if (!settings || generation !== bundleSwitchGeneration)
      return { status: "stale" };
    // A fast switch can succeed before the first poll, so start from the id in the start reply.
    let lrmPrepareId: string | undefined = startPrepareId;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      let op: Awaited<ReturnType<typeof fetchModelBindingActivationOperation>>;
      try {
        op = await fetchModelBindingActivationOperation(settings, operationId);
      } catch (error) {
        if (generation !== bundleSwitchGeneration) return { status: "stale" };
        setBundleSwitchCanResume(true);
        bundleSwitchNeedsResume = false;
        return {
          status: "failed",
          message: activationRequestErrorText(error, String(error)),
        };
      }
      if (generation !== bundleSwitchGeneration) return { status: "stale" };
      // ServiceHub sends the prepare id only while the switch is applying.
      // Keep it, so the final read below can still show the last step states.
      if (op.status === "applying" && op.progress?.lrm_prepare_operation_id) {
        lrmPrepareId = op.progress.lrm_prepare_operation_id;
      }
      // While applying, the read runs beside the poll. Once the switch has
      // finished, wait for it (5 s timeout at most): the reset that follows a
      // success bumps the generation, which would throw away a later reply and
      // leave a fast switch with an empty checklist.
      const stepsRead = readPrepareSteps(lrmPrepareId, generation);
      if (op.status === "succeeded" || op.status === "failed") {
        await stepsRead;
        if (generation !== bundleSwitchGeneration) return { status: "stale" };
      }
      if (op.status === "succeeded") {
        if (op.runtime_transition_required) {
          const tokenRefresh = await refreshManagedWorkspaceToken(
            settings,
            deps.syncWorkspaceToken,
            `bundle-switch-${operationId}`,
          );
          if (generation !== bundleSwitchGeneration) return { status: "stale" };
          if (!tokenRefresh.ok) {
            setBundleSwitchCanResume(true);
            bundleSwitchNeedsResume = false;
            return {
              status: "failed",
              message: `Model switched, but the workspace token could not be refreshed: ${tokenRefresh.message}`,
            };
          }
        }
        setBundleSwitchMessage(null);
        setBundleSwitchSettled(true);
        // Migration boundary: reset the Routing Balance to the target bundle's
        // default now that the switch has committed.
        await applyRoutingDefaultForSwitch();
        if (generation !== bundleSwitchGeneration) return { status: "stale" };
        return { status: "succeeded" };
      }
      if (op.status === "failed") {
        setBundleSwitchSettled(true);
        setBundleSwitchCanResume(op.retryable);
        bundleSwitchNeedsResume = op.retryable;
        // A failure ServiceHub does not mark retryable (a refused sandbox provision, say) is a terminal
        // receipt: forget it, so no later error re-arms a poll of it and the next Apply starts afresh.
        if (!op.retryable) setBundleSwitchOperationId(null);
        return {
          status: "failed",
          message: activationErrorText(op.error),
        };
      }
      setBundleSwitchMessage(bundleSwitchStageMessage(op.stage));
      await new Promise<void>((resolve) => {
        bundleSwitchPollTimer = setTimeout(resolve, BUNDLE_SWITCH_POLL_MS);
      });
      if (generation !== bundleSwitchGeneration) return { status: "stale" };
    }
  };

  // Generic primary-bundle switch driver, shared by Connect-Edge (full-hdr) and
  // Connect-Local. The only difference between the two is which switch request
  // is built from the capability snapshot; everything else is identical.
  //
  // This runs the real switch after confirmation, not from Connect.
  const startBundleSwitch = async (
    generation: number,
    buildRequest: (
      capability: PrimaryBundleCapability,
    ) => ModelBindingActivationRequest | null,
  ): Promise<BundleSwitchOutcome> => {
    const settings = serviceHubSettings();
    if (!settings)
      return { status: "failed", message: "ServiceHub is not connected." };
    try {
      const capability = await fetchPrimaryBundleCapability(settings);
      const request = buildRequest(capability);
      if (!request) return { status: "succeeded" };
      // Remember the target bundle so the settle handler can reset the Routing
      // Balance to that bundle's default.
      bundleSwitchTargetBundleId = request.intent === "disconnect" ? null : request.target_bundle_id;
      const op = await startModelBindingActivation(settings, request);
      if (generation !== bundleSwitchGeneration) return { status: "stale" };
      setBundleSwitchOperationId(op.operation_id);
      // A new operation has not settled, whatever the one before it did: Cancel only aborts an
      // operation that has not.
      setBundleSwitchSettled(false);
      setBundleSwitchMessage(op.status === "applying" ? bundleSwitchStageMessage(op.stage) : null);
      const startPrepareId = op.status === "applying" ? op.progress?.lrm_prepare_operation_id : undefined;
      return await pollBundleSwitchOperation(op.operation_id, generation, startPrepareId);
    } catch (error) {
      if (generation !== bundleSwitchGeneration) return { status: "stale" };
      return {
        status: "failed",
        message: activationRequestErrorText(error, String(error)),
      };
    }
  };

  /**
   * Apply the pending switch after explicit user confirmation:
   * the real switch (edge: save credentials + start switch; local: start switch)
   * runs here; nothing was switched at Connect time. Both in-place and runtime
   * transition success refresh state and leave the App running.
   */
  const applyBundleSwitch = async (): Promise<boolean> => {
    const pending = pendingBundleSwitch();
    if (!pending) {
      // The dialog's visibility (`restartOpen`, local to the card) and the staged
      // switch (`pendingBundleSwitch`, here) are separate signals set by the same
      // Connect click, so they can desync -- e.g. a second Connect on the other
      // card runs `resetBundleSwitchState()` and then bails on a hardware
      // preflight failure, clearing this while the first card's dialog stays open.
      // Returning silently made "Restart now" a dead key with no feedback, which
      // is the shape of report #1682. Say so instead.
      setBundleSwitchError(t("capability.model_change_stage_lost"));
      return false;
    }
    setBundleSwitchApplying(true);
    setBundleSwitchError(null);
    const generation = bundleSwitchGeneration;
    // putEdge writes edge.json before the activation probe; when it skipped its
    // own probe, a failed Apply has still left unverified credentials on disk.
    const switchFailureMessage = (message: string) =>
      edgeSavedUnverified ? `${message} ${t("edge.saved_not_verified")}` : message;
    try {
      const settings = serviceHubSettings();
      if (!settings) throw new Error("ServiceHub is not connected.");
      let outcome: BundleSwitchOutcome;
      const existingOperationId = bundleSwitchOperationId();
      if (bundleSwitchCanResume() && existingOperationId) {
        setBundleSwitchCanResume(false);
        setBundleSwitchSettled(false);
        if (bundleSwitchNeedsResume) {
          const operation = await resumeModelBindingActivation(settings, existingOperationId);
          setBundleSwitchMessage(operation.status === "applying" ? bundleSwitchStageMessage(operation.stage) : null);
        }
        bundleSwitchNeedsResume = false;
        outcome = await pollBundleSwitchOperation(existingOperationId, generation);
      } else if (pending.kind === "edge") {
        const lrm = llmRouterClient();
        if (!lrm) throw new Error("ServiceHub is not connected.");
        // Save the edge credentials, then run the switch — both deferred from
        // Connect to here so "Cancel" never persists anything.
        setBundleSwitchMessage(bundleSwitchStageMessage("preparing"));
        // Probing with bypass_proxy=false routes through the corporate proxy and
        // often fails for intranet edges, which blocks persisting edge.json. Skip
        // the probe when the user opted out of bypass or credentials were already
        // on disk from an earlier Apply.
        const edgeAlreadyConfigured = Boolean(edgeConfig()?.configured);
        const skipUpstreamProbe =
          pending.input.bypass_proxy === false || edgeAlreadyConfigured;
        const savedEdge = await lrm.putEdge(pending.input, {
          probe: !skipUpstreamProbe,
        });
        edgeSavedUnverified = skipUpstreamProbe;
        await refreshEdgeConfig();
        await refreshLocalModelHealth();
        if (generation !== bundleSwitchGeneration) return false;
        outcome = await startBundleSwitch(
          generation,
          (capability) => {
            if (
              capability.edge_model_selection_fingerprint !==
              savedEdge?.edge_model_selection_fingerprint
            ) {
              throw new Error(
                "The Edge model changed while this Apply was in progress. Retry the switch.",
              );
            }
            const edgeBundle = capability.supported_bundles.find(
              (bundle) => bundle.backend === "edge" && bundle.chat_model_label === pending.input.model_name,
            );
            if (!edgeBundle) {
              throw new Error(
                `Edge model "${pending.input.model_name}" is not a trusted complete Bundle.`,
              );
            }
            const request = buildEdgeConnectActivationRequest(capability, edgeBundle.bundle_id);
            if (!request) {
              throw new Error(`Selected Edge Bundle is no longer supported: ${edgeBundle.bundle_id}`);
            }
            return request;
          },
        );
      } else {
        outcome = await startBundleSwitch(
          generation,
          (capability) => {
            const request = buildLocalBundleActivationRequest(capability, pending.bundleId);
            if (!request) {
              throw new Error(
                `Selected local Bundle is no longer supported: ${pending.bundleId}`,
              );
            }
            return request;
          },
        );
      }
      if (generation !== bundleSwitchGeneration) return false;
      if (outcome.status === "failed") {
        setBundleSwitchError(switchFailureMessage(outcome.message));
        setBundleSwitchApplying(false);
        return false;
      }
      if (outcome.status === "stale") {
        setBundleSwitchApplying(false);
        return false;
      }
      await refreshBundleSwitchState();
      const switchedToEdge = pending.kind === "edge";
      resetBundleSwitchState();
      if (switchedToEdge) {
        // An error from an earlier test no longer applies, so only the success shows.
        setEdgeError(null);
        setEdgeUpdatedMessage("Edge connected.");
      }
      return true;
    } catch (error) {
      if (generation !== bundleSwitchGeneration) return false;
      if (bundleSwitchOperationId()) setBundleSwitchCanResume(true);
      setBundleSwitchError(
        switchFailureMessage(activationRequestErrorText(error, String(error))),
      );
      setBundleSwitchApplying(false);
      return false;
    }
  };

  /**
   * User chose "Cancel": discard the staged switch and clear all local switch
   * state. Because Connect no longer starts a ServiceHub operation (the switch
   * runs only inside `applyBundleSwitch`), there is usually nothing to cancel on
   * the server. If an applying switch is in flight, bumping the generation
   * (via `resetBundleSwitchState`) makes its poll bail out; a best-effort server
   * cancel is sent only when an operation id exists and it has not settled.
   */
  const cancelBundleSwitch = async () => {
    const settings = serviceHubSettings();
    const operationId = bundleSwitchOperationId();
    const shouldCancel =
      Boolean(settings && operationId) && !bundleSwitchSettled();
    // Bump generation first so any in-flight poll callback bails out.
    resetBundleSwitchState();
    if (shouldCancel && settings && operationId) {
      try {
        await cancelModelBindingActivation(settings, operationId);
      } catch {
        // Best-effort abort — local state is already reset above.
      }
    }
  };

  // Stage only, like Connect-Local: nothing is saved until the user chooses
  // Apply, so Cancel leaves the saved edge config unchanged. Apply saves the
  // credentials and skips the upstream probe when a config already exists or
  // proxy bypass is off. The card opens the model-change confirmation dialog.
  const connectEdge = async (input: {
    base_url: string;
    api_key: string;
    model_name: string;
    bypass_proxy?: boolean;
  }) => {
    if (!llmRouterClient()) throw new Error("ServiceHub is not connected.");
    resetBundleSwitchState();
    // Keep an earlier Test Connection error: it stays on the card behind the
    // Apply dialog. A successful Apply clears it.
    setPendingBundleSwitch({ kind: "edge", input });
  };

  // Disconnect Edge (Lite hardware only): release the Edge Bundle and return to
  // bundle-free Lite. Runs at once; the card asks for confirmation first. Throws
  // with a readable message when the operation fails.
  const disconnectEdge = async (): Promise<void> => {
    const generation = resetBundleSwitchState();
    setEdgeError(null);
    setEdgeDisconnecting(true);
    try {
      const outcome = await startBundleSwitch(generation, (capability) => {
        const request = buildEdgeDisconnectActivationRequest(capability, deps.activeProfile());
        if (!request) throw new Error(t("edge.disconnect_unavailable"));
        return request;
      });
      if (outcome.status === "stale") return;
      if (outcome.status === "failed") {
        // Refresh so the card shows the real state: LRM may have released Edge already,
        // while the Profile keeps Edge and Disconnect stays available to finish the job.
        await refreshBundleSwitchState();
        resetBundleSwitchState();
        throw new Error(outcome.message);
      }
      await refreshBundleSwitchState();
      resetBundleSwitchState();
      setEdgeUpdatedMessage(t("edge.disconnected"));
    } finally {
      setEdgeDisconnecting(false);
    }
  };

  // Connect-Local (llama): stage a switch to the selected supported bundle.
  //
  // Returns true when the switch was staged (the caller may open the restart
  // confirm dialog), false when a hardware preflight failure blocked it (the
  // requirements dialog is shown instead — the confirm dialog must NOT open).
  const connectLocal = async (bundleId: string): Promise<boolean> => {
    const lrm = llmRouterClient();
    if (!lrm) throw new Error("ServiceHub is not connected.");
    resetBundleSwitchState();
    setEdgeError(null);
    // Preflight the target llama bundle BEFORE staging the switch, so the
    // requirements dialog appears before (and instead of) the restart-confirm
    // dialog. Unlike the startup gate (which exits the app), a failed switch
    // here just surfaces a dismissable dialog and leaves the user on edge/app.
    // Fail-open: any probe error / unknown bundle does not block.
    const settings = serviceHubSettings();
    if (settings) {
      try {
        const preflight = await fetchSystemPreflight(settings, bundleId);
        const gate = evaluateHardwarePreflight(preflight);
        if (gate.blocked) {
          setSwitchHardwareFailures(gate.failures);
          return false;
        }
      } catch {
        // Fail-open: never block the switch on a preflight transport error.
      }
    }
    setPendingBundleSwitch({ kind: "local", bundleId });
    return true;
  };

  const testEdgeConnection = async (input: {
    base_url: string;
    api_key: string;
    model_name: string;
    bypass_proxy?: boolean;
  }) => {
    const lrm = llmRouterClient();
    if (!lrm) throw new Error("ServiceHub is not connected.");
    setEdgeTesting(true);
    setEdgeError(null);
    // A new test supersedes the last Apply's "Edge connected.". Leaving it set
    // keeps the card's success prop non-null, so the card never resets the
    // stale message it hid on remount and the new result stays hidden.
    setEdgeUpdatedMessage(null);
    try {
      const result = await lrm.testEdge(input);
      if (result.status !== "ok") {
        const detail = result.detail?.trim();
        const message =
          detail ||
          (result.error === "timeout" || result.error === "connection_failed"
            ? "could not reach edge upstream"
            : result.error) ||
          "Edge test failed.";
        throw new Error(message);
      }
      return result.models ?? [];
    } catch (error) {
      setEdgeError(error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      setEdgeTesting(false);
    }
  };

  return {
    cloudModel,
    setCloudModel,
    cloudModelMissing,
    cloudModelHealthError,
    cloudModelLoading,
    cloudModelSaving,
    cloudModelDeleting,
    cloudModelTesting,
    edgeConfig,
    setEdgeConfig,
    edgeTesting,
    edgeError,
    primaryBundleCapability,
    setPrimaryBundleCapability,
    committedBackend,
    edgeConnected,
    edgeDisconnectAvailable,
    edgeDisconnecting,
    bundleSwitchOperationId,
    bundleSwitchMessage,
    bundleSwitchError,
    bundleSwitchSteps,
    bundleSwitchApplying,
    bundleSwitchCanResume,
    bundleSwitchSettled,
    edgeUpdatedMessage,
    pendingBundleSwitch,
    switchHardwareFailures,
    setSwitchHardwareFailures,
    refreshCloudModel,
    refreshEdgeConfig,
    refreshPrimaryBundleCapability,
    saveCloudModel,
    deleteCloudModel,
    testProviderConnection,
    connectEdge,
    disconnectEdge,
    testEdgeConnection,
    connectLocal,
    applyBundleSwitch,
    cancelBundleSwitch,
    startBundleSwitch,
    pollBundleSwitchOperation,
  };
}

export type ModelRoutingFeature = ReturnType<typeof createModelRoutingFeature>;

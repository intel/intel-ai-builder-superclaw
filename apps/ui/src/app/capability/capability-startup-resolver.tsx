/**
 * CapabilityStartupResolver — orchestrates the clean-startup lifecycle
 * (Phase A/B/C) on top of the mainline G1 provider, and gates mounting of the
 * runtime application.
 *
 * Scheme 1 (dark-safe): only takes over when capability gating is ON. When the
 * backend has gating OFF, `GET /app/capability-profile` returns 404 → the
 * provider surfaces `transport_error` → we passthrough and render the runtime
 * tree exactly like today (v1.1 boot path unchanged).
 *
 * State mapping (from useAppCapability().state):
 *   loading         → Profile request is pending → show progress overlay
 *   initializing    → no active Profile → run the temporary initialization adapter
 *   active          → Phase C: profile committed → wait for the data plane
 *                     (owtToken / sandbox container ready) before mounting
 *   recovery        → Host-only recovery message
 *   transport_error → gating OFF (or transient) → passthrough runtime tree
 *
 * Phase B (first-launch initialization) runs only after ServiceHub explicitly
 * reports that no active Profile exists. During migration it uses the legacy
 * switch endpoint as an adapter; ordinary startup never enters this path.
 *
 * Phase C (data-plane wait): once `active`, the sandbox container is still
 * being provisioned by the capability switch saga (the Rust boot path
 * deliberately SKIPS the container-ready wait under gating to avoid a 409
 * deadlock, emitting servicehub-ready without an owtToken). So `active` alone
 * does NOT mean the workspace is reachable — entering the app here shows a
 * "disconnected" state until the owtToken lands. We therefore hold the overlay
 * and poll `fetchOwtToken` until the data plane is ready (owtToken obtained),
 * then mount. A bounded timeout falls through to mounting anyway so startup can
 * never hard-hang; sandbox 503/404 mean "still waiting" (keep polling), not a
 * fatal error.
 */
import { Show, createEffect, createMemo, createSignal, onCleanup, type JSX } from "solid-js";
import { Rocket, HardDriveDownload, Cpu, Container, CheckCircle2 } from "lucide-solid";
import BackendBootOverlay, { type BootStep } from "../components/backend-boot-overlay";
import DownloadConfirmDialog, { type DownloadAsset } from "../components/download-confirm-dialog";
import HardwareRequirementsDialog from "../components/hardware-requirements-dialog";
import {
  fetchOwtToken,
  fetchReadinessBlockers,
  isOwtSandboxProvisioningCode,
  requestRuntimeConverge,
  ServiceHubHttpError,
} from "../lib/servicehub";
import { createLlmRouterClient } from "../lib/llmrouter-client";
import { cacheTargetBundleId, getProductVersion } from "../lib/tauri";
import { uiLogDebug, uiLogError, uiLogInfo, uiLogWarn } from "../lib/log";
import {
  completeStartupStep,
  startStartupStep,
} from "../lib/startup-timing";
import {
  armStartupGrace,
  DATA_PLANE_TIMEOUT_MS,
  markCapabilityStartupHandled,
  setStartupOwtToken,
} from "~/shared/platform/capability/capability-startup-signal";
import { useAppCapability } from "~/shared/platform/capability/app-capability-provider";
import {
  activationErrorText,
  activationRequestErrorText,
  owtProvisionFailureReason,
  owtProvisionRefusalText,
} from "~/shared/platform/capability/activation-error-text";
import { useHostClient } from "./host-client-provider";
import {
  buildStartupCeilingActivationRequest,
  fetchPrimaryBundleCapability,
  fetchActiveModelBindingActivation,
  fetchModelBindingActivationOperation,
  putPerfWeight,
  resolveActiveProfileBundleCheck,
  resumeModelBindingActivation,
  startModelBindingActivation,
  verifyUnverifiedBundleAssets,
  type PrimaryBundleCapability,
} from "~/shared/platform/capability/model-binding-activation-client";
import type { ServiceHubSettings } from "~/shared/platform/transport/servicehub";
import { routingDefaultsForBundle } from "~/shared/platform/capability/routing-defaults";
import {
  convergeNeedsNewActivation,
  decideActivationPoll,
  decideActiveProfileStartup,
  resumableFailedOperationId,
} from "~/shared/platform/capability/activation-poll-decision";
import { fetchSystemPreflight } from "~/shared/platform/capability/system-preflight-client";
import { evaluateHardwarePreflight, type HardwareFailure } from "~/shared/platform/capability/preflight-policy";
import { createSandboxReadyReporter, emitStartupPhase } from "../lib/telemetry";
import { resolveDialogCompletion } from "~/shared/platform/capability/download-dialog-completion";
import { toBundleSwitchStepState } from "~/shared/util/bundle-switch-step-progress";
import { promptOwesUserAnOutcome, resolveActivationErrorSurface, resolveReveal } from "~/shared/platform/capability/startup-reveal-policy";
import { DOWNLOAD_POLL_MS, DownloadPrompt, OPERATION_POLL_MS, OWT_POLL_MS, PromptAsset, READY_DWELL_MS, READY_PCT, RecoveryRetryAction, STARTUP_STEPS, STEP_BAND, StartupStepId, capabilityRecoveryBlock, createActivationGate, exitApp, hardwareProbeFailed, hardwareReadIncompleteAfter, hardwareUsable, payloadStartup, phaseBShouldStart, readUntilHardwareKnown, recoveryRetryRearmsPhaseB, stageToStep, unsupportedBundleBlock } from "./capability-startup-resolver.steps";
import { createStartupPoll, expediteWhen } from "./startup-poll";
import { OWT_CONVERGE_INITIAL, decideOwtConverge, owtPollState } from "~/shared/platform/capability/owt-poll-decision";
import { createEdgeStartupController } from "./capability-startup-edge-controller";

export function CapabilityStartupResolver(props: { children: JSX.Element }) {
  const cap = useAppCapability();
  const host = useHostClient();

  // This resolver owns the whole post-host-ready segment: its mount is the origin
  // of the frontend timeline and its reveal is the end.
  startStartupStep("hub.settings.wait");
  startStartupStep("reveal");

  // Phase B progress state.
  const [switchStep, setSwitchStep] = createSignal<StartupStepId>("init");
  const [switchTitle, setSwitchTitle] = createSignal<string>("Starting…");
  const [switchDescription, setSwitchDescription] = createSignal<string>("Getting things ready…");
  const [switchPct, setSwitchPct] = createSignal<number | null>(null);
  const [switchError, setSwitchError] = createSignal<string | null>(null);
  const [payloadFailed, setPayloadFailed] = createSignal(false);
  // The error on screen cannot change on Retry, so the overlay offers only Cancel.
  const [retryUnavailable, setRetryUnavailable] = createSignal(false);
  const [recoveryRetrying, setRecoveryRetrying] = createSignal(false);
  const [recoveryHardwareReadIncomplete, setRecoveryHardwareReadIncomplete] = createSignal(false);
  const [operationPending, setOperationPending] = createSignal(false);
  const [primaryBundleCheckPending, setPrimaryBundleCheckPending] = createSignal(false);
  // Init-stage hardware gate. Non-empty when the LRM preflight reports the
  // machine cannot run the local model — surfaces a hard-block dialog (exit
  // only) and stops the activation before any switch/download.
  const [hardwareFailures, setHardwareFailures] = createSignal<HardwareFailure[]>([]);
  // First-launch download-consent dialog. Non-null while we wait for the user
  // to confirm (proceed with the download) or cancel (exit the app).
  const [downloadPrompt, setDownloadPrompt] = createSignal<DownloadPrompt | null>(null);
  /**
   * The consent sequence owns the screen until the download dialog is mounted.
   *
   * The reveal effect must not mount the app in the interval after consent starts and
   * before `downloadPrompt` is set, or the prompt would be unmounted before the
   * download switch begins.
   */
  const [consentFlowActive, setConsentFlowActive] = createSignal(false);
  /**
   * Target bundle of the switch this resolver started, so the settle handler can
   * reset the Routing Balance to that bundle's default — the same migration
   * boundary `app.tsx` uses for a post-setup bundle change.
   *
   * WHY this exists: first-launch activation starts its own switch here and never
   * went through `app.tsx`'s `startBundleSwitch`, so `routingDefaultsForBundle`
   * was never applied on a fresh install. Applied once per switch, best-effort.
   */
  let activationTargetBundleId: string | null = null;
  let activationRoutingDefaultApplied = false;
  let preserveRoutingBalanceForActivation = false;
  let lastOperationLogKey: string | null = null;
  let failedOperationId: string | null = null;
  // The sandbox refused its provision during the data-plane wait; Retry asks it to provision again.
  let provisionRetryPending = false;
  let pollRetryOperationId: string | null = null;

  /**
   * Reset the Routing Balance to the target bundle's default once the
   * first-launch switch commits. Mirrors `applyRoutingDefaultForSwitch` in
   * `app.tsx`; both are bounded to a real migration boundary so a user's
   * hand-picked value survives ordinary relaunches.
   */
  const applyRoutingDefaultForActivation = async () => {
    if (activationRoutingDefaultApplied) return;
    if (preserveRoutingBalanceForActivation) {
      preserveRoutingBalanceForActivation = false;
      return;
    }
    const defaults = routingDefaultsForBundle(activationTargetBundleId);
    if (!defaults) return;
    const settings = host.settings();
    if (!settings) return;
    activationRoutingDefaultApplied = true;
    uiLogInfo("capability.routing-balance", "Applying bundle routing default", {
      bundleId: activationTargetBundleId,
      perfWeight: defaults.perfWeight,
    });
    // Await so terminal completion also includes the routing-default update.
    try {
      await putPerfWeight(settings, defaults.perfWeight);
    } catch {
      // Best-effort: a failed reset must not block activation. Allow a later
      // settle re-attempt if this one failed.
      activationRoutingDefaultApplied = false;
    }
  };
  // Minimum on-screen time for the startup overlay. Without this, the
  // cached-model fast path flips capability to `active` within a few hundred
  // ms, so the stepper/progress bar flashes for a frame and the user just sees
  // a jarring blank→app jump. Holding the overlay for a short floor gives the
  // animation time to register as a deliberate startup sequence.
  const MIN_OVERLAY_MS = 1600;
  const [minElapsed, setMinElapsed] = createSignal(false);
  const minTimer = setTimeout(() => setMinElapsed(true), MIN_OVERLAY_MS);

  // Phase C — data-plane readiness gate. After capability becomes `active`, we
  // poll the owtToken until the sandbox data plane is reachable, so the app is
  // mounted already-connected instead of flashing a disconnected state.
  const [dataPlaneReady, setDataPlaneReady] = createSignal(false);
  const [dataPlaneTimedOut, setDataPlaneTimedOut] = createSignal(false);
  const owtPoll = createStartupPoll(OWT_POLL_MS);
  let owtDeadlineTimer: ReturnType<typeof setTimeout> | null = null;
  let owtStarted = false;
  // Set when a refused provision ended the token wait: nothing else restarts it once a replacement
  // activation has succeeded, because `owtStarted` stays latched.
  let dataPlaneWaitEndedByRefusal = false;
  let switchStarted = false;
  let activeProfileCheckKey: string | null = null;
  let activeProfileCheckGeneration = 0;
  let activeProfileCheckFailed = false;
  const activationGate = createActivationGate();
  // Bounds the auto-retry in runActivation()'s catch block for
  // lrm_bundle_revision_conflict (see isRevisionConflict below) so a
  // persistently-stale revision fails closed into the normal error/manual
  // Retry UI instead of looping forever.
  let revisionConflictRetryCount = 0;
  let cancelled = false;
  const operationPoll = createStartupPoll(OPERATION_POLL_MS);
  // Per-asset download-progress poll (LRM operations) for the download dialog.
  let downloadPollTimer: ReturnType<typeof setTimeout> | null = null;
  /** Pending close of the all-complete dialog (see READY_DWELL_MS). */
  let readyDwellTimer: ReturnType<typeof setTimeout> | null = null;
  let lastOwtCode: string | null = null;
  let sandboxAttemptStarted = false;
  const reportSandboxReady = createSandboxReadyReporter();
  // One-shot flag so container_start is emitted only on the first transition
  // from "container not up" to "container up" within a single data-plane wait.
  let containerStartEmitted = false;

  const stopPoll = () => operationPoll.cancel();

  // Monotonic overall progress. Maps (step, optional 0–100 sub-progress) into
  // that step's band and only ever moves forward, so the bar never snaps back
  // when the capability profile briefly re-fetches (loading→active churn) or
  // when a child op resets its own pct. `setProgress` clamps to the band and
  // guards against regression.
  const bandValue = (step: StartupStepId, sub: number | null): number => {
    const band = STEP_BAND[step];
    if (sub == null) return band.start;
    const clamped = Math.max(0, Math.min(100, sub)) / 100;
    return band.start + (band.end - band.start) * clamped;
  };
  const setProgress = (step: StartupStepId, sub: number | null = null) => {
    const target = bandValue(step, sub);
    setSwitchPct((prev) => Math.max(prev ?? 0, Math.round(target)));
  };
  onCleanup(() => {
    if (sandboxAttemptStarted) {
      reportSandboxReady("cancelled", "cancelled_by_user");
    }
    cancelled = true;
    activeProfileCheckGeneration += 1;
    stopPoll();
    clearTimeout(minTimer);
    owtPoll.cancel();
    if (owtDeadlineTimer) clearTimeout(owtDeadlineTimer);
    if (downloadPollTimer) clearTimeout(downloadPollTimer);
    if (readyDwellTimer) clearTimeout(readyDwellTimer);
  });

  const status = () => cap.state().status;

  const edge = createEdgeStartupController({ cap, revealed: () => revealed(), cancelled: () => cancelled, setOperationPending, switchError, setSwitchError, // #3531
    runActivation: () => runActivation(), resetForRetry: () => { stopPoll(); failedOperationId = pollRetryOperationId = null; revisionConflictRetryCount = 0; } });
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  // Before a Profile refresh that can return to `initializing`: hand Phase B back, and drop
  // the error an earlier attempt left, which would otherwise outlive the recovery.
  const rearmPhaseB = () => {
    activationGate.invalidate();
    switchStarted = false;
    setSwitchError(null);
    setRetryUnavailable(false);
  };

  const readUntilHardwareKnownFor = (
    settings: ServiceHubSettings,
    capability: PrimaryBundleCapability,
  ): Promise<PrimaryBundleCapability> => {
    setSwitchTitle("Checking hardware");
    setSwitchDescription("Reading this device's hardware again…");
    return readUntilHardwareKnown(capability, () => fetchPrimaryBundleCapability(settings), sleep);
  };

  /** Show why the committed Bundle cannot start here; returns whether Retry can help. */
  const showUnsupportedBundle = (capability: PrimaryBundleCapability, bundleId: string): boolean => {
    const block = unsupportedBundleBlock(capability, bundleId);
    uiLogWarn("capability.active-bundle", "Committed bundle is not supported on this device", {
      bundleId,
      retry: block.retry,
      supported: capability.supported_bundle_ids,
      cloudOnlyProductProfileId: capability.cloud_only_product_profile_id ?? null,
      detectionErrors: capability.hardware.detection_errors,
    });
    setRetryUnavailable(!block.retry);
    setSwitchError(block.message);
    return block.retry;
  };

  // An active Profile can outlive its local model files when uninstall preserves
  // user data but removes the model cache. Validate that durable state against
  // LRM before Phase C; missing assets re-enter the existing consented activation.
  createEffect(() => {
    const state = cap.state();
    const settings = host.settings();
    if (state.status !== "active" || !settings) return;
    const bundle = state.profile.primary_bundle;
    const key = [
      settings.baseUrl,
      state.profile.profile_revision,
      bundle?.bundle_id ?? "none",
      bundle?.bundle_revision ?? 0,
    ].join(":");
    if (activeProfileCheckKey === key) return;
    activeProfileCheckKey = key;
    const generation = ++activeProfileCheckGeneration;
    if (!bundle || bundle.backend === "edge") {
      setPrimaryBundleCheckPending(false);
      return;
    }
    setPrimaryBundleCheckPending(true);

    void (async () => {
      try {
        const { operation } = await fetchActiveModelBindingActivation(settings);
        if (cancelled || generation !== activeProfileCheckGeneration) return;
        let capability = await fetchPrimaryBundleCapability(settings);
        if (cancelled || generation !== activeProfileCheckGeneration) return;
        let startupDecision = decideActiveProfileStartup(
          resolveActiveProfileBundleCheck(state.profile, capability),
          operation,
        );
        if (startupDecision === "unsupported" && hardwareProbeFailed(capability)) {
          capability = await readUntilHardwareKnownFor(settings, capability);
          if (cancelled || generation !== activeProfileCheckGeneration) return;
          startupDecision = decideActiveProfileStartup(
            resolveActiveProfileBundleCheck(state.profile, capability),
            operation,
          );
        }
        uiLogInfo("capability.active-bundle", "Checked active Profile model cache", {
          bundleId: bundle?.bundle_id ?? null,
          decision: startupDecision,
        });
        if (startupDecision === "adopt-activation" && operation?.status === "applying") {
          switchStarted = true;
          await pollOperation(operation.operation_id);
          return;
        }
        if (startupDecision === "unsupported") {
          activeProfileCheckFailed = showUnsupportedBundle(capability, bundle?.bundle_id ?? "unknown");
          return;
        }
        if (startupDecision === "stale") {
          await cap.refresh();
          if (cancelled || generation !== activeProfileCheckGeneration) return;
          if (cap.activeProfile()?.profile_revision !== state.profile.profile_revision) {
            activeProfileCheckKey = null;
            return;
          }
          activeProfileCheckFailed = true;
          setSwitchError("The active model configuration changed. Retry startup to reconcile it.");
          return;
        }
        if (startupDecision === "reconcile") {
          switchStarted = true;
          void runActivation();
          return;
        }
        if (startupDecision === "repair") {
          switchStarted = true;
          preserveRoutingBalanceForActivation = true;
          void runActivation();
          return;
        }
        setPrimaryBundleCheckPending(false);
      } catch (error) {
        if (cancelled || generation !== activeProfileCheckGeneration) return;
        activeProfileCheckFailed = true;
        setSwitchError(error instanceof Error ? error.message : "Failed to check local model files.");
      }
    })();
  });

  // Phase C — after an active Profile's local Bundle passes the cache check,
  // advance the stepper into the sandbox/connect wait and poll the data plane
  // (owtToken) so we only mount the app once the workspace is reachable. The two waits are
  // split by the owt probe status: 503 = container not up yet (Sandbox step),
  // 404/other = container up, obtaining the token (Connect step). This is where
  // most of the wall-clock time is spent, so the bar keeps moving through the
  // sandbox → connect bands instead of parking near the end.
  createEffect(() => {
    if (status() !== "active" || primaryBundleCheckPending() || owtStarted) return;
    // Hard hardware block: if the Init-stage preflight blocked startup, do NOT
    // advance into the sandbox/connect data-plane wait even if the capability
    // profile independently flips to `active`. Otherwise the progress bar keeps
    // creeping behind the requirements dialog and the app eventually mounts.
    if (hardwareFailures().length > 0) return;
    owtStarted = true;
    // As soon as the profile is active we KNOW capability gating is on, so the
    // resolver owns the startup overlay for the rest of this session. Claim
    // ownership NOW (well before the app is revealed, which waits for the data
    // plane) so app.tsx's legacy V1.1 BackendBootOverlay is already suppressed
    // by the time the runtime tree mounts — otherwise there is a one-frame race
    // where the app mounts with capabilityStartupHandled() still false and the
    // legacy overlay flashes over the disconnected UI. (The gatedReveal branch
    // below still calls it too; it's an idempotent set-once latch.)
    markCapabilityStartupHandled();
    setSwitchStep("sandbox");
    setSwitchTitle("Starting sandbox");
    setSwitchDescription("Starting the sandbox runtime…");
    setProgress("sandbox", 0);
    sandboxAttemptStarted = true;
    void emitStartupPhase("sandbox_provision");
    startDataPlaneWait();
  });

  /**
   * Name the component blocking readiness, after a data-plane wait gives up.
   *
   * Must stay fire-and-forget and must run *after* the existing failure reporting:
   * awaiting it, or moving it earlier, would put a network read on the reveal path.
   * It gates nothing; the OWT poll remains the mount signal.
   */
  const logReadinessBlockers = (hubBaseUrl: string, hubToken: string, outcome: string) => {
    void (async () => {
      const blockers = await fetchReadinessBlockers(hubBaseUrl, hubToken);
      if (blockers.length === 0) return;
      uiLogWarn("runtime.blockers", "Readiness blockers at data-plane wait failure", {
        outcome,
        blockers,
      });
    })();
  };

  const startDataPlaneWait = () => {
    dataPlaneWaitEndedByRefusal = false;
    const settings = host.settings();
    startStartupStep("dataplane.wait");
    if (!settings) {
      // No hub settings to poll with — don't block startup on a wait we can't
      // perform; fall through so the app still mounts.
      reportSandboxReady("failed", "servicehub_unavailable");
      completeStartupStep("dataplane.wait", { outcome: "failed", errorClass: "servicehub_unavailable" });
      setDataPlaneTimedOut(true);
      return;
    }
    // Per-band sub-progress, nudged forward on each poll so each wait animates
    // instead of freezing (capped so it never reaches the band end — real
    // readiness jumps to READY_PCT).
    let sandboxCreep = 0;
    let connectCreep = 0;
    // Set by the first `payload_preparing`; `undefined` until the product version was asked for.
    let preparingSinceMs: number | null = null;
    let preparingVersion: string | null | undefined;
    let owtConverge = OWT_CONVERGE_INITIAL;
    owtDeadlineTimer = setTimeout(function onDeadline() {
      // The clock must not run through a model download. This fallback exists to
      // survive a stuck sandbox provision, not to cut short a legitimately long
      // transfer: a multi-GB download can outlast 90 s on its own, and letting the
      // deadline expire mid-download would mark the data plane "timed out" so the
      // reveal fires the instant the prompt guard lifts — mounting before the
      // workspace is actually reachable. Re-arm instead while the dialog still owes
      // the user an outcome.
      if (
        consentFlowActive() ||
        promptOwesUserAnOutcome(downloadPrompt()?.phase ?? null)
      ) {
        owtDeadlineTimer = setTimeout(onDeadline, DATA_PLANE_TIMEOUT_MS);
        return;
      }
      // Bounded fallback: never hard-hang on a slow/stuck sandbox provision.
      completeStartupStep("dataplane.wait", { outcome: "timeout", lastOwtCode });
      uiLogWarn("runtime.timeout", "Data-plane wait timed out; mounting anyway", {
        timeoutMs: DATA_PLANE_TIMEOUT_MS,
        lastOwtCode,
      });
      void emitStartupPhase("sandbox_provision", "timeout", "deadline_exceeded");
      reportSandboxReady("timeout", "deadline_exceeded");
      setDataPlaneTimedOut(true);
      logReadinessBlockers(settings.baseUrl, settings.token, "timeout");
    }, DATA_PLANE_TIMEOUT_MS);

    const poll = async () => {
      if (cancelled || dataPlaneReady()) return;
      const s = host.settings();
      if (!s) {
        // No request went out, so this poll observed nothing new.
        owtPoll.schedule(null, () => void poll());
        return;
      }
      const result = await fetchOwtToken(s.baseUrl, s.token);
      if (cancelled) return;
      if (result.ok) {
        completeStartupStep("dataplane.wait", { outcome: "ready", lastOwtCode });
        uiLogInfo("runtime.ready", "Sandbox data plane is ready", {
          profileStatus: status(),
        });
        // Stash the token so app.tsx's lazy-fetch effect can reuse it on mount
        // instead of re-fetching (an extra round-trip). NOTE: the owt can still
        // be rotated by the backend between here and app.tsx's use, so app.tsx
        // must handle a 401 by refreshing (Plan C 401 auto-refresh) — the reuse
        // is a best-effort fast path, not a guarantee.
        setStartupOwtToken(result.token);
        if (owtDeadlineTimer) clearTimeout(owtDeadlineTimer);
        setSwitchStep("connect");
        setSwitchTitle("Ready");
        setSwitchDescription("Opening your workspace…");
        setSwitchPct(READY_PCT);
        reportSandboxReady("success", "unknown");
        setDataPlaneReady(true);
        void emitStartupPhase("ready");
        return;
      }
      const codeChanged = result.code !== lastOwtCode;
      if (codeChanged) {
        uiLogWarn("runtime.owt", "Sandbox token readiness changed", {
          previousCode: lastOwtCode,
          code: result.code,
          status: result.status,
          message: result.message,
          retryable: result.retryable,
        });
        lastOwtCode = result.code;
      }

      const provisionRefusal = owtProvisionRefusalText(result);
      if (provisionRefusal) {
        // Waiting does not clear a refused provision (a declined UAC prompt, say), so the poll ends
        // here and the overlay says why. Retry re-arms the provision.
        completeStartupStep("dataplane.wait", { outcome: "failed", errorClass: result.code });
        uiLogError("runtime.owt", "Sandbox provision refused", {
          code: result.code,
          reason: owtProvisionFailureReason(result),
          status: result.status,
        });
        if (owtDeadlineTimer) clearTimeout(owtDeadlineTimer);
        reportSandboxReady("failed", "owt_unavailable");
        provisionRetryPending = true;
        dataPlaneWaitEndedByRefusal = true;
        setSwitchError(provisionRefusal);
        return;
      }

      const converge = decideOwtConverge(owtConverge, result.code);
      owtConverge = converge.next;
      if (converge.converge) {
        void requestRuntimeConverge(s.baseUrl, s.token).catch((error: unknown) => {
          uiLogWarn("runtime.owt", "Runtime converge request failed during OWT recovery", {
            message: error instanceof Error ? error.message : String(error),
          });
        });
      }

      if (result.code === "payload_preparing" && preparingVersion === undefined) {
        try {
          preparingVersion = await getProductVersion();
        } catch {
          preparingVersion = null;
        }
        if (cancelled) return;
      }
      if (result.code === "payload_preparing") preparingSinceMs ??= performance.now();
      const payload = payloadStartup(result, preparingVersion ?? null, preparingSinceMs ?? 0, performance.now());
      if (payload?.kind === "preparing") {
        setSwitchStep(payload.info.step);
        setSwitchTitle(payload.info.title);
        setSwitchDescription(payload.info.description);
        sandboxCreep = Math.min(sandboxCreep + 2, 100);
        setProgress("sandbox", sandboxCreep);
        owtPoll.schedule(owtPollState(result.code), () => void poll());
        return;
      }

      if (!result.retryable) {
        completeStartupStep("dataplane.wait", { outcome: "failed", errorClass: result.code });
        uiLogError("runtime.owt", "Sandbox token readiness failed", {
          code: result.code,
          status: result.status,
          message: result.message,
        });
        if (owtDeadlineTimer) clearTimeout(owtDeadlineTimer);
        reportSandboxReady("failed", "owt_unavailable");
        if (payload?.kind === "failed") {
          // The workspace cannot come up, so the overlay keeps the remedy on screen.
          setPayloadFailed(true);
          setSwitchError(payload.error);
          return;
        }
        setDataPlaneTimedOut(true);
        logReadinessBlockers(s.baseUrl, s.token, "failed");
        return;
      }

      // Split the wait by probe status (all still-provisioning, NOT fatal):
      //   503 = sandbox container not up yet  → Sandbox step (62-85 band)
      //   404 / owt_stale / other             → container up, token pending →
      //                                          Connect step (85-97 band)
      // Both bands creep within themselves; setProgress's Math.max keeps the bar
      // monotonic even if the probe status regresses (e.g. container restart),
      // and the overlay stepper's own maxPhaseIdx guard prevents the icon from
      // stepping backward.
      const containerUp = !isOwtSandboxProvisioningCode(result.code);
      if (containerUp) {
        if (!containerStartEmitted) {
          containerStartEmitted = true;
          void emitStartupPhase("container_start");
        }
        setSwitchStep("connect");
        setSwitchTitle("Connecting");
        setSwitchDescription("Connecting to your workspace…");
        connectCreep = Math.min(connectCreep + 10, 100);
        setProgress("connect", connectCreep);
      } else {
        setSwitchStep("sandbox");
        setSwitchTitle("Starting sandbox");
        setSwitchDescription("Starting the sandbox runtime…");
        sandboxCreep = Math.min(sandboxCreep + 8, 100);
        setProgress("sandbox", sandboxCreep);
      }
      owtPoll.schedule(owtPollState(result.code), () => void poll());
    };
    void poll();
  };

  // Trace capability profile state transitions + host settings readiness.
  createEffect(() => {
    const s = cap.state();
    const settings = host.settings();
    // Settings gate on ServiceHub being ready, which is what this step measures.
    if (settings) completeStartupStep("hub.settings.wait");
    uiLogDebug("capability.state", "Capability startup state changed", {
      status: s.status,
      hasSettings: !!settings,
      baseUrl: settings?.baseUrl ?? null,
    });
  });

  // Phase B starts only after ServiceHub explicitly reports that no active
  // Profile exists. The initial request-pending state is also "loading", but
  // starting from that state races the normal active-Profile response.
  createEffect(() => {
    const state = cap.state();
    const settings = host.settings();
    if (!phaseBShouldStart(state.status, switchStarted) || !settings) return;
    switchStarted = true;
    uiLogInfo("capability.phase-b", "Starting first-launch activation");
    void runActivation();
  });

  // Poll LRM for live per-asset download progress and feed it into the download
  // dialog. The switch operation only carries a coarse total `pct`; the real
  // per-file manifest lives on the LRM prepare operation, whose id ServiceHub
  // surfaces as `lrm_prepare_operation_id` on the switch projection.
  //
  // The `lrm_prepare_operation_id` never changes once known, so we resolve it
  // ONCE (polling the switch op only until it appears) and then poll ONLY
  // `GET /llm-router/v1/operations/{lrm_id}` (which carries `metadata.files`)
  // every second. Re-reading the switch op every tick was the cause of the
  // jumpy ~20–30s updates: during a download both ServiceHub and LRM are busy,
  // so two serial requests per tick could each crawl toward the 10s default
  // timeout, stretching the effective period. A short 5s timeout keeps a slow
  // tick from stalling the bar, and dropping the per-tick switch read halves
  // the request load. When every asset is complete we close the dialog.
  const startDownloadProgressPoll = async (switchOperationId: string) => {
    const client = createLlmRouterClient;
    let lrmId: string | null = null;
    let lastLoggedDone = -1;
    let lastPollError: string | null = null;
    const poll = async () => {
      if (cancelled || downloadPrompt() === null) return;
      const settings = host.settings();
      if (!settings) {
        downloadPollTimer = setTimeout(() => void poll(), DOWNLOAD_POLL_MS);
        return;
      }
      try {
        // Resolve the LRM prepare op id once, then stop reading the switch op.
        if (!lrmId) {
          const switchOp = await fetchModelBindingActivationOperation(settings, switchOperationId);
          lrmId = switchOp.status === "applying"
            ? switchOp.progress?.lrm_prepare_operation_id ?? null
            : null;
          if (!lrmId) {
            // LRM prepare hasn't reported its operation id yet — keep waiting.
            downloadPollTimer = setTimeout(() => void poll(), DOWNLOAD_POLL_MS);
            return;
          }
        }
        const lrmOp = await client(settings).getOperation(lrmId, { timeoutMs: 5_000 });
        const files = lrmOp.metadata?.files ?? [];
        if (files.length > 0) {
          const done = files.reduce((sum, file) => sum + file.done, 0);
          if (done !== lastLoggedDone) {
            lastLoggedDone = done;
            uiLogDebug("capability.download", "Model download progress changed", {
              operationId: lrmId,
              done,
              files,
            });
          }
          setDownloadPrompt((p) => {
            if (!p) return p;
            const assets = p.assets.map((a) => {
              const f = files.find((file) => file.id === a.id);
              if (!f) return a;
              const complete = f.state === "complete" || (f.total > 0 && f.done >= f.total);
              return {
                ...a,
                doneBytes: f.done,
                totalBytes: f.total || a.totalBytes,
                complete,
                // Carried so the dialog reads what the row IS doing rather than
                // inferring it from the counters — see `download-dialog-activity`.
                state: toBundleSwitchStepState(f.state),
              };
            });
            return { ...p, assets, error: null };
          });
        }
        // Done when every asset is complete (per product decision: close on
        // full download, don't wait for the switch to reach succeeded). Hold the
        // all-complete state for READY_DWELL_MS first so the finished rows are
        // actually perceivable — see that constant for why.
        const prompt = downloadPrompt();
        if (prompt) {
          const action = resolveDialogCompletion(prompt.phase, prompt.assets);
          if (action === "enter-ready") {
            setDownloadPrompt((p) => (p ? { ...p, phase: "ready", error: null } : p));
            readyDwellTimer = setTimeout(() => {
              readyDwellTimer = null;
              setDownloadPrompt(null);
            }, READY_DWELL_MS);
            return;
          }
          if (action === "already-ready") return;
        }
        if (lrmOp.state === "error") {
          setDownloadPrompt((p) =>
            p ? { ...p, error: lrmOp.last_error_message ?? lrmOp.message ?? "Download failed." } : p,
          );
          return; // stop polling; user can Retry.
        }
      } catch (err) {
        // A single slow/timed-out tick must NOT abort the whole poll (that
        // would freeze the bar until Retry). Only surface a hard error; keep
        // polling through transient timeouts.
        const msg = err instanceof Error ? err.message : String(err);
        if (/timed out|timeout|aborted/i.test(msg)) {
          downloadPollTimer = setTimeout(() => void poll(), DOWNLOAD_POLL_MS);
          return;
        }
        if (msg !== lastPollError) {
          lastPollError = msg;
          uiLogWarn("capability.download", "Download progress poll retrying", {
            error: msg,
          });
        }
        setDownloadPrompt((p) => (p ? { ...p, error: msg } : p));
        return;
      }
      downloadPollTimer = setTimeout(() => void poll(), DOWNLOAD_POLL_MS);
    };
    void poll();
  };

  const pollOperation = async (operationId: string) => {
    const settings = host.settings();
    if (!settings || cancelled) return;
    edge.pollStarted();
    setOperationPending(true);
    try {
      const op = await fetchModelBindingActivationOperation(settings, operationId);
      if (cancelled) return;
      // Both terminal checks are evaluated BEFORE `owtStarted` is consulted, and
      // a non-terminal op keeps polling even after handoff. See
      // `activation-poll-decision.ts` for why that ordering is load-bearing (it
      // is the only thing that applies the bundle Routing Balance default).
      switch (decideActivationPoll(op, owtStarted)) {
        case "apply-routing-default": {
          edge.succeeded();
          setOperationPending(false);
          failedOperationId = null;
          pollRetryOperationId = null;
          // A refused provision ended the token wait and this activation brought a deployment back.
          if (dataPlaneWaitEndedByRefusal && !dataPlaneReady()) startDataPlaneWait();
          uiLogInfo("capability.operation", "Activation operation succeeded", {
            operationId,
            status: op.status,
            owtStarted,
            runtimeTransitionRequired: op.status === "succeeded"
              ? op.runtime_transition_required
              : undefined,
          });
          const settings = host.settings();
          if (settings) {
            activeProfileCheckKey = null;
            await Promise.allSettled([cap.refresh()]);
            activationTargetBundleId ??= cap.activeProfile()?.primary_bundle?.bundle_id ?? null;
          }
          await applyRoutingDefaultForActivation();
          // Provider will re-fetch capability-profile and flip to active.
          return;
        }
        case "surface-error":
        case "log-error-only": {
          failedOperationId = resumableFailedOperationId(op);
          const error = op.status === "failed"
            ? activationErrorText(op.error)
            : "Model activation requires recovery.";
          uiLogError("capability.operation", "Activation operation failed", {
            operationId,
            status: op.status,
            owtStarted,
            errorCode: op.status === "failed" ? op.error.code : undefined,
            error,
          });
          if (edge.routeFailure(op, !owtStarted)) return; // an unreachable Edge goes to the in-app banner
          setSwitchError(error);
          return;
        }
        case "advance-stepper": {
          if (op.status !== "applying") break;
          const mapped = stageToStep(op.stage, edge.isTarget());
          setSwitchStep(mapped.step);
          setSwitchTitle(mapped.title);
          setSwitchDescription(mapped.description);
          // Drive the overall bar within this step's band using the child op pct
          // as sub-progress. Monotonic: brief phase/pct resets won't rewind it.
          setProgress(mapped.step, op.progress?.pct ?? 0);
          const logKey = JSON.stringify([
            operationId,
            op.status,
            op.stage,
            op.progress?.pct,
          ]);
          if (logKey !== lastOperationLogKey) {
            lastOperationLogKey = logKey;
            uiLogInfo("capability.operation", "Activation operation changed", {
              operationId,
              status: op.status,
              stage: op.stage,
              pct: op.progress?.pct,
            });
          }
          break;
        }
        case "keep-polling-silently":
          // Phase C owns the UI now: a late-returning poll from the earlier
          // A late preparing-stage poll must not overwrite the connect-step copy. Stop
          // driving the stepper — but do NOT stop polling.
          break;
      }
      // An applying operation keeps polling until it reaches a terminal status. One state for
      // every operation, since neither a stage change nor a retried operation brings the end
      // closer; expediteWhen below speeds up the end itself.
      operationPoll.schedule("applying", () => void pollOperation(operationId));
    } catch (err) {
      pollRetryOperationId = operationId;
      setSwitchError(edge.relayRequestError(activationRequestErrorText(err, "Failed to poll activation.")));
    }
  };

  // Once the data plane is ready the reveal waits on this poll alone, and the activation has
  // settled by then: ServiceHub settles it as it activates the Profile, and Phase C starts only
  // after that.
  expediteWhen(dataPlaneReady, operationPoll);

  const isActivationInProgress = (err: unknown): boolean =>
    err instanceof ServiceHubHttpError &&
    err.status === 409 &&
    err.code === "model_binding_activation_in_progress";

  // Keep post-consent failures on whichever surface currently owns the screen:
  // once the download dialog is up, routing the error to the startup overlay
  // behind it makes the failure invisible.
  const surfaceActivationError = (error: string, isDownload: boolean): void => {
    uiLogError("capability.switch", "Activation failed", { error, isDownload });
    if (edge.absorbRequestError(error)) return;
    if (resolveActivationErrorSurface(isDownload, downloadPrompt()?.phase ?? null) === "download-dialog") {
      setDownloadPrompt((prompt) => (prompt ? { ...prompt, error } : prompt));
      return;
    }
    setSwitchError(error);
  };

  // ServiceHub's own boot-time reconcile can independently re-drive a
  // `connect` switch for the same bundle this startup flow just resolved
  // (e.g. after detecting capability-manifest drift and re-healing). If that
  // reheal commits to LRM in the narrow window between this flow's capability
  // GET and its switch POST, the `expected_bundle_revision` snapshot captured
  // in buildStartupCeilingActivationRequest() is already stale by the time it
  // reaches the server, and `_preflight()` rejects it with this 409. A fresh
  // capability re-fetch always carries the post-reheal revision, so retrying
  // runActivation() from scratch (exactly what the manual Retry button
  // already does) resolves it — this just does that once, automatically,
  // instead of surfacing "Model Binding Activation cannot start." to the user
  // for a race that self-resolves within milliseconds.
  const isRevisionConflict = (err: unknown): boolean =>
    err instanceof ServiceHubHttpError && err.status === 409 && err.code === "lrm_bundle_revision_conflict";

  const MAX_REVISION_CONFLICT_RETRIES = 1;


  // Adopt the active operation instead of starting a competing activation.
  // ServiceHub owns automatic convergence; discovery does not retry it.
  const adoptInFlightActivation = async (isDownload: boolean): Promise<boolean> => {
    const settings = host.settings();
    if (!settings) return false;
    const { operation } = await fetchActiveModelBindingActivation(settings);
    if (!operation) return false;
    if (isDownload) {
      setDownloadPrompt((p) => (p ? { ...p, phase: "downloading", error: null } : p));
      void startDownloadProgressPoll(operation.operation_id);
    }
    await pollOperation(operation.operation_id);
    return true;
  };

  // Deferred past the settling attempt, whose `end` is what frees the gate.
  const settleActivation = (attempt: number) => {
    if (activationGate.end(attempt)) setTimeout(() => void runActivation(), 0);
  };

  const runActivation = async () => {
    const attempt = activationGate.begin();
    if (attempt === null) return;
    const settings = host.settings();
    if (!settings) {
      settleActivation(attempt);
      return;
    }
    setSwitchStep("init");
    setProgress("init", 0);
    setSwitchTitle("Initializing");
    setSwitchDescription("Initializing…");
    let isDownload = false;
    try {
      startStartupStep("capability.profile");
      let capability = await fetchPrimaryBundleCapability(settings);
      completeStartupStep("capability.profile");
      if (activationGate.superseded(attempt)) return;
      if (capability.cloud_only_product_profile_id === "lite" && !capability.primary_bundle) {
        // ServiceHub owns the bundle-free Lite bootstrap; the Profile provider
        // keeps polling until its Runtime is ready. There is no download/switch.
        setSwitchTitle("Starting Lite");
        setSwitchDescription("Starting the cloud-only runtime…");
        return;
      }
      let request = buildStartupCeilingActivationRequest(capability);
      // Init-stage hardware preflight: between learning which bundle we need
      // (step 2) and starting the switch (step 3), ask LRM whether this machine
      // can actually run *this specific bundle* right now. Scope the check to
      // the bundle this launch will activate. A hard resource failure blocks startup;
      // anything else (probe failure, skipped, edge provider, unknown bundle
      // 404) is fail-open so we never wrongly block. Backend owns the
      // provider/bundle-aware logic; we only interpret the check results.
      const preflightBundleId =
        request?.target_bundle_id ?? capability.hardware_capability_ceiling?.bundle_id ?? null;
      startStartupStep("capability.preflight");
      const preflight = await fetchSystemPreflight(settings, preflightBundleId);
      completeStartupStep("capability.preflight", { bundleId: preflightBundleId });
      // Hardware recovered while this attempt waited: its snapshot is stale, and the
      // attempt that recovery started runs once this one settles.
      if (activationGate.superseded(attempt)) return;
      const gate = evaluateHardwarePreflight(preflight);
      uiLogInfo("capability.preflight", "Hardware preflight evaluated", {
        bundleId: preflightBundleId,
        blocked: gate.blocked,
        checks: preflight?.checks ?? null,
      });
      // A committed bundle already passed LRM's OWN memory gate before its
      // boot-resume spawn (`resume_local_if_ready`'s check in
      // inference_logic.py, run against a clean, uncontended reading before
      // anything loads) — that is the authoritative "before it starts" check.
      // Re-running this same kind of check here, seconds later, measures
      // memory that resume's own in-flight load is now legitimately holding,
      // which is a false block, not a real one (no retry/poll duration fixes
      // that — it is comparing against the wrong baseline by construction).
      // This gate is therefore only authoritative for a bundle with no prior
      // commit: the very first local-model activation on this host, where
      // nothing has run resume's check yet and this is the only gate there is.
      if (gate.blocked && !capability.primary_bundle) {
        // Hard block: freeze all startup progress and surface the requirements
        // dialog. Stop the switch poll AND the data-plane wait (owt timers),
        // and latch owtStarted so the active-profile effect can't restart it.
        // Claim the startup gate (markCapabilityStartupHandled) so app.tsx's
        // independent V1.1 BackendBootOverlay — which runs its own progress bar
        // keyed on !capabilityStartupHandled() — is suppressed; otherwise its
        // bar keeps climbing behind our dialog. The reveal latch also checks
        // hardwareFailures() so the app never mounts behind the dialog — the
        // user can only exit.
        stopPoll();
        owtStarted = true;
        owtPoll.cancel();
        if (owtDeadlineTimer) clearTimeout(owtDeadlineTimer);
        markCapabilityStartupHandled();
        setHardwareFailures(gate.failures);
        setSwitchStep("init");
        setSwitchPct(0);
        setSwitchDescription("Hardware requirements not met.");
        return;
      }
      uiLogInfo("capability.ceiling", "Resolved startup capability", {
        ceiling: capability.hardware_capability_ceiling ?? null,
        primaryBundle: capability.primary_bundle ?? null,
        request,
      });
      // Best-effort: let host telemetry attribute this session to the target
      // bundle before it commits, in case a heartbeat fires mid-switch (the
      // switch may still fail — see cacheTargetBundleId's doc comment).
      if (request?.target_bundle_id) {
        void cacheTargetBundleId(request.target_bundle_id).catch(() => {});
      }
      if (!request) {
        if (capability.primary_bundle) {
          // Only reachable when the committed bundle is absent from
          // supported_bundles (hardware downgrade, registry change) or a
          // malformed uncached edge row — a committed bundle that IS supported
          // always produces a connect/download re-drive request now (#1528).
          // No Profile driver exists for this state, so waiting silently would
          // be the same indefinite "Initializing" hang this fix removes:
          // surface an explicit error instead. Retry re-fetches capability, so
          // a transiently missing/malformed row can still self-heal.
          const bundleId = capability.primary_bundle.bundle_id;
          if (!capability.supported_bundle_ids.includes(bundleId)) {
            showUnsupportedBundle(capability, bundleId);
            return;
          }
          uiLogWarn("capability.phase-b", "Committed bundle cannot be re-driven", {
            bundleId,
            supported: capability.supported_bundle_ids,
          });
          setSwitchError(
            `The configured model bundle "${bundleId}" is not available on this device. ` +
              "Choose a different model in Settings, or retry.",
          );
          return;
        }
        setSwitchError("No supported model bundle for this hardware.");
        return;
      }
      // Preserved-but-unverified files: hash them BEFORE asking for download consent.
      //
      // Manually preserved weights can outlive `model_verifications`, and the
      // capability projection is deliberately hash-free, so it honestly reports those
      // assets uncached and the request comes back as `download_and_connect`.
      // Consenting to that is consenting to a download that will not happen: the
      // prompt's total sums `download_bytes`, which for a present-but-unverified asset
      // is its full size (`missing_bytes = total_size_bytes` when no record exists,
      // identical to an absent file), so the user is asked to approve GBs while zero
      // bytes move.
      //
      // Verifying first turns those assets cached, and the rebuilt request is a plain
      // `connect` with no prompt at all. Restores the sequence added in #1464 and lost
      // in #1520, which replaced this block and dropped the call with it.
      //
      // Placed before the consent branch on purpose: `setConsentFlowActive(true)` in
      // there claims the screen for the whole consent sequence, and claiming it for a
      // flow that then turns out unnecessary would flash. Best-effort per asset, so
      // anything that fails to verify simply stays in the prompt.
      if (request.intent === "download_and_connect") {
        setSwitchTitle("Checking model files");
        setSwitchDescription("Verifying the models already on disk…");
        await verifyUnverifiedBundleAssets(settings, capability, request.target_bundle_id);
        capability = await fetchPrimaryBundleCapability(settings);
        const rebuilt = buildStartupCeilingActivationRequest(capability);
        // A null rebuild would mean the bundle just stopped being supported, which
        // pre-verification cannot cause; keep the original request rather than bail.
        if (rebuilt) request = rebuilt;
        uiLogInfo("capability.verify", "Re-evaluated switch after pre-verification", {
          intent: request.intent,
        });
      }
      // First-launch download consent: when the target bundle is NOT already
      // cached, `buildStartupCeilingActivationRequest` emits `download_and_connect`.
      // Before kicking off a (potentially multi-GB, multi-minute) download we
      // ask the user to confirm, listing the model + per-asset sizes. If they
      // cancel we exit the app (the model is required to continue). A cached
      // bundle uses `connect` (no download) and skips this prompt entirely.
      if (request.intent === "download_and_connect") {
        isDownload = true;
        const target = capability.supported_bundles.find(
          (b) => b.bundle_id === request.target_bundle_id,
        );
        const promptAssets: PromptAsset[] = (target?.assets ?? []).map((a) => ({
          id: a.asset_id,
          role: a.role,
          label: a.label,
          totalBytes: a.download_bytes,
          doneBytes: 0,
          complete: false,
        }));
        const modelName = target?.display_name ?? request.target_bundle_id;
        // Claim the screen before mounting the consent prompt, so the reveal cannot
        // slip through the setup tick.
        setConsentFlowActive(true);
        const confirmed = await new Promise<boolean>((resolve) => {
          setDownloadPrompt({
            phase: "consent",
            modelName,
            assets: promptAssets,
            totalBytes: target?.total_download_bytes ?? 0,
            error: null,
            resolve,
          });
          // The prompt now holds the reveal on its own phase, so the bridging latch
          // has done its job. Released after the prompt exists, never before.
          setConsentFlowActive(false);
        });
        if (!confirmed) {
          // User declined the download — exit the app.
          setDownloadPrompt(null);
          exitApp();
          return;
        }
        // Confirmed: keep the dialog open and switch it to the live progress
        // view. Per-asset progress is polled from LRM once the switch reports
        // its `lrm_prepare_operation_id` (see startDownloadProgressPoll).
        setDownloadPrompt((p) => (p ? { ...p, phase: "downloading", error: null } : p));
        void emitStartupPhase("model_download");
      }
      // Remember the target so the settle handler can reset the Routing Balance
      // to that bundle's default (see applyRoutingDefaultForActivation).
      activationTargetBundleId = request.target_bundle_id;
      edge.setTarget(capability, request.target_bundle_id);
      startStartupStep("capability.switch");
      const op = await startModelBindingActivation(settings, request);
      uiLogInfo("capability.switch", "Model Binding Activation started", {
        operationId: op.operation_id,
        intent: request.intent,
        targetBundleId: request.target_bundle_id,
      });
      // If this is a download, start polling LRM for live per-asset progress in
      // parallel with the switch-operation poll. `lrm_prepare_operation_id`
      // arrives on a later poll (LRM prepare returns after the switch starts),
      // so startDownloadProgressPoll re-reads the switch op until it appears.
      if (request.intent === "download_and_connect") {
        void startDownloadProgressPoll(op.operation_id);
      }
      await pollOperation(op.operation_id);
      // A `download_and_connect` switch includes a multi-GB transfer, so this
      // duration is only comparable against another switch of the same intent.
      completeStartupStep("capability.switch", { intent: request.intent });
    } catch (err) {
      if (activationGate.superseded(attempt)) return;
      if (isActivationInProgress(err)) {
        try {
          if (await adoptInFlightActivation(isDownload)) return;
        } catch (adoptErr) {
          surfaceActivationError(activationRequestErrorText(adoptErr, "Failed to resume activation."), isDownload);
          return;
        }
      }
      // An in-progress 409 with nothing to adopt: that operation settled in between (a boot reheal failing fast, #3531).
      if ((isRevisionConflict(err) || isActivationInProgress(err)) && revisionConflictRetryCount < MAX_REVISION_CONFLICT_RETRIES) {
        revisionConflictRetryCount += 1;
        uiLogInfo("capability.switch", "Retrying activation after a start conflict", {
          attempt: revisionConflictRetryCount,
          code: err instanceof ServiceHubHttpError ? err.code : null,
        });
        // Deferred past this call's `finally` below, which is what frees the
        // activation gate — calling runActivation() synchronously here
        // would just hit its own re-entrancy guard and no-op.
        setTimeout(() => void runActivation(), 0);
        return;
      }
      surfaceActivationError(activationRequestErrorText(err, "Failed to start model activation."), isDownload);
    } finally {
      settleActivation(attempt);
      // Never let the bridging latch outlive this call: an early return or a throw
      // before the prompt is created would otherwise hold the startup screen forever.
      // Releasing here is safe because by this point either the prompt owns the hold
      // on its own phase, or there is no consent sequence left to protect.
      setConsentFlowActive(false);
    }
  };

  // A recovery state is terminal for the Profile provider, so Retry must act and
  // then read the Profile again itself; runActivation never does either.
  const retryRecovery = async (action: RecoveryRetryAction) => {
    const settings = host.settings();
    if (!settings || recoveryRetrying()) return;
    setRecoveryRetrying(true);
    try {
      if (action === "converge") {
        setSwitchTitle("Starting Lite");
        setSwitchDescription("Starting the cloud-only runtime again…");
        try {
          await requestRuntimeConverge(settings.baseUrl, settings.token);
        } catch (error) {
          uiLogWarn("capability.lite", "Runtime converge request failed during Lite retry", {
            message: error instanceof Error ? error.message : String(error),
          });
        }
        await cap.refresh();
        return;
      }
      try {
        const capability = await readUntilHardwareKnownFor(settings, await fetchPrimaryBundleCapability(settings));
        if (cancelled) return;
        setRecoveryHardwareReadIncomplete(hardwareProbeFailed(capability));
      } catch (error) {
        uiLogWarn("capability.recovery", "Hardware re-read failed during Retry", {
          message: error instanceof Error ? error.message : String(error),
        });
      }
      if (recoveryRetryRearmsPhaseB(action)) rearmPhaseB();
      await cap.refresh();
    } finally {
      setRecoveryRetrying(false);
    }
  };

  // Retry after the sandbox refused its provision: re-arm it (a new UAC prompt), then wait again.
  const retryProvision = async () => {
    const settings = host.settings();
    if (!settings) {
      provisionRetryPending = true;
      return;
    }
    setSwitchError(null);
    setSwitchStep("sandbox");
    setSwitchTitle("Starting sandbox");
    setSwitchDescription("Starting the sandbox runtime…");
    try {
      await requestRuntimeConverge(settings.baseUrl, settings.token, { rearm: true });
    } catch (error) {
      if (convergeNeedsNewActivation(error)) {
        // The activation that owned the refused deployment has already cleaned it up, so there is
        // nothing to re-arm: a plain Retry starts a new activation.
        retry();
        return;
      }
      provisionRetryPending = true;
      setSwitchError(error instanceof Error ? error.message : "Failed to start the sandbox again.");
      return;
    }
    startDataPlaneWait();
  };

  const retry = () => {
    const recoveryAction = status() === "recovery" ? recoveryBlock()?.action : null;
    if (recoveryAction) {
      void retryRecovery(recoveryAction);
      return;
    }
    if (provisionRetryPending) {
      provisionRetryPending = false;
      void retryProvision();
      return;
    }
    setSwitchError(null);
    setRetryUnavailable(false);
    stopPoll();
    switchStarted = true;
    revisionConflictRetryCount = 0;
    if (activeProfileCheckFailed) {
      activeProfileCheckFailed = false;
      activeProfileCheckKey = null;
      activeProfileCheckGeneration += 1;
      void cap.refresh();
      return;
    }
    if (pollRetryOperationId) {
      const operationId = pollRetryOperationId;
      pollRetryOperationId = null;
      edge.armGrace(); // a slow Edge must not hold startup on the resumed poll (#3531)
      void pollOperation(operationId);
      return;
    }
    if (failedOperationId) {
      const operationId = failedOperationId;
      failedOperationId = null;
      const settings = host.settings();
      if (!settings) return;
      void (async () => {
        try {
          await resumeModelBindingActivation(settings, operationId);
          await pollOperation(operationId);
        } catch (error) {
          failedOperationId = operationId;
          setSwitchError(activationRequestErrorText(error, "Failed to resume activation."));
        }
      })();
      return;
    }
    void runActivation();
  };

  // Retry a failed first-launch download: clear the error and re-issue the
  // switch + progress poll. The dialog stays in the downloading phase (the user
  // already consented) — LRM resumes the partial download.
  const retryDownload = () => {
    const prompt = downloadPrompt();
    if (!prompt) return;
    setSwitchError(null);
    setDownloadPrompt({ ...prompt, phase: "downloading", error: null });
    const settings = host.settings();
    if (!settings) return;
    void (async () => {
      try {
        if (failedOperationId) {
          const operationId = failedOperationId;
          failedOperationId = null;
          await resumeModelBindingActivation(settings, operationId);
          void startDownloadProgressPoll(operationId);
          await pollOperation(operationId);
          return;
        }
        const capability = await fetchPrimaryBundleCapability(settings);
        const request = buildStartupCeilingActivationRequest(capability);
        if (!request) {
          setDownloadPrompt(null);
          return;
        }
        // Retry path: same migration boundary, so track the target here too.
        activationTargetBundleId = request.target_bundle_id;
        activationRoutingDefaultApplied = false;
        const op = await startModelBindingActivation(settings, request);
        void startDownloadProgressPoll(op.operation_id);
        await pollOperation(op.operation_id);
      } catch (err) {
        if (isActivationInProgress(err)) {
          try {
            if (await adoptInFlightActivation(true)) return;
          } catch (adoptErr) {
            setDownloadPrompt((p) =>
              p ? { ...p, error: activationRequestErrorText(adoptErr, "Retry failed.") } : p,
            );
            return;
          }
        }
        setDownloadPrompt((p) =>
          p ? { ...p, error: activationRequestErrorText(err, "Retry failed.") } : p,
        );
      }
    })();
  };

  // ServiceHub's recovery projection carries no detection errors, so ask LRM whether an
  // "unsupported" verdict came from an incomplete hardware reading.
  // If that read already shows the recovered hardware, the verdict is stale and the provider
  // will not poll it away; read the Profile again. Bounded: ServiceHub derives the verdict from
  // the same LRM read, so a mismatch that outlives a few refreshes is not staleness.
  let recoveryHardwareCheck = 0;
  let staleUnsupportedRefreshes = 0;
  const MAX_STALE_UNSUPPORTED_REFRESHES = 3;
  createEffect(() => {
    const recovery = cap.recovery();
    const settings = host.settings();
    const check = ++recoveryHardwareCheck;
    if (recovery?.recovery_code !== "hardware_unsupported" || !settings) {
      setRecoveryHardwareReadIncomplete(false);
      return;
    }
    void (async () => {
      try {
        const capability = await fetchPrimaryBundleCapability(settings);
        if (cancelled || check !== recoveryHardwareCheck) return;
        if (hardwareUsable(capability) && staleUnsupportedRefreshes < MAX_STALE_UNSUPPORTED_REFRESHES) {
          staleUnsupportedRefreshes += 1;
          uiLogInfo("capability.recovery", "Unsupported verdict predates the recovered hardware reading; reading the Profile again", {
            attempt: staleUnsupportedRefreshes,
            cloudOnlyProductProfileId: capability.cloud_only_product_profile_id ?? null,
            ceiling: capability.hardware_capability_ceiling?.bundle_id ?? null,
          });
          rearmPhaseB();
          await cap.refresh();
          return;
        }
        setRecoveryHardwareReadIncomplete(hardwareReadIncompleteAfter(capability));
      } catch (error) {
        if (cancelled || check !== recoveryHardwareCheck) return;
        uiLogWarn("capability.recovery", "Could not read hardware evidence for an unsupported verdict", {
          message: error instanceof Error ? error.message : String(error),
        });
        setRecoveryHardwareReadIncomplete(hardwareReadIncompleteAfter(null));
      }
    })();
  });

  // Overlay copy derived from state. Recovery is a Host-only terminal error.
  const recoveryBlock = createMemo(() => {
    const recovery = cap.recovery();
    return recovery ? capabilityRecoveryBlock(recovery, recoveryHardwareReadIncomplete()) : null;
  });
  const showRecovery = () => status() === "recovery" && !recoveryRetrying();
  const overlayTitle = createMemo(() => {
    if (showRecovery()) return "Capability unavailable";
    return switchTitle();
  });
  const overlayDescription = createMemo(() => {
    if (showRecovery()) {
      if (recoveryBlock()) return "";
      return cap.recovery()?.recovery_code ?? "This device cannot run the required capability.";
    }
    return switchDescription();
  });
  const overlayError = createMemo(() => {
    if (showRecovery()) return recoveryBlock()?.message ?? cap.recovery()?.recovery_code ?? "unsupported";
    return switchError();
  });
  const overlayRetryDisabled = () =>
    payloadFailed() || retryUnavailable() || (showRecovery() && recoveryBlock()?.retry === false);

  // Latch: once we decide to mount the runtime tree we NEVER retract it. The
  // capability provider re-fetches the profile whenever hub settings churn
  // (token refresh), briefly flipping status back to `loading`; without a latch
  // the <Show> would flap active→loading→active, yanking the overlay back over
  // the app for a frame (the "enter → flash disconnected/overlay → enter again"
  // jank). Reveal is one-way.
  const [revealed, setRevealed] = createSignal(false);
  createEffect(() => {
    if (revealed()) return;
    // Reveal unmounts the entire startup fallback subtree — boot overlay, hardware
    // requirements dialog, and the download dialog. The decision therefore has to
    // respect anything still on screen, which is why it lives in a named policy with
    // tests (see `startup-reveal-policy`): the download-dialog case was missing here
    // and let the app mount 9.7 s before the first asset finished downloading.
    const inputs = {
      status: status(),
      minElapsed: minElapsed(),
      dataPlaneReady: dataPlaneReady(),
      dataPlaneTimedOut: dataPlaneTimedOut(),
      operationPending: operationPending(),
      primaryBundleCheckPending: primaryBundleCheckPending(),
      hardwareBlocked: hardwareFailures().length > 0,
      promptPhase: downloadPrompt()?.phase ?? null,
      consentFlowActive: consentFlowActive(),
      edgeDegraded: edge.state(),
    };
    const decision = resolveReveal(inputs);
    if (decision === "hold") return;
    if (decision === "reveal-gated") {
      // Under gating, tell app.tsx we own the startup gate so it suppresses its own
      // V1.1 boot overlay — otherwise it flashes over the app for a beat right after
      // we mount. Deliberately NOT set on the `transport_error` passthrough: that path
      // is exactly the V1.1 behaviour and app.tsx's overlay must stay in charge
      // (dark-safe).
      markCapabilityStartupHandled();
      armStartupGrace();
    }
    completeStartupStep("reveal", { decision });
    setRevealed(true);
  });

  return (
    <Show
      when={revealed()}
      fallback={
        <>
          {/* Hard hardware block hides the startup stepper/progress overlay
              entirely: the requirements dialog (with its own solid backdrop) is
              the only thing shown, so there is no shimmering progress bar
              behind it. Otherwise render the normal startup overlay. */}
          <Show when={hardwareFailures().length === 0}>
            <BackendBootOverlay
              stage={switchStep()}
              steps={STARTUP_STEPS}
              activeStepId={switchStep()}
              title={overlayTitle()}
              description={overlayDescription()}
              message={switchDescription()}
              pct={switchPct()}
              pctIsPercent={true}
              error={overlayError()}
              ready={false}
              onRetry={retry}
              retryDisabled={overlayRetryDisabled()}
              onCancel={switchError() || (showRecovery() && recoveryBlock()) ? exitApp : undefined}
            />
          </Show>
          <DownloadConfirmDialog
            open={downloadPrompt() !== null}
            phase={downloadPrompt()?.phase ?? "consent"}
            modelName={downloadPrompt()?.modelName ?? ""}
            assets={downloadPrompt()?.assets ?? []}
            totalBytes={downloadPrompt()?.totalBytes ?? 0}
            error={downloadPrompt()?.error ?? null}
            onConfirm={() => downloadPrompt()?.resolve(true)}
            onCancel={() => downloadPrompt()?.resolve(false)}
            onRetry={retryDownload}
            onCancelDownload={exitApp}
          />
          <HardwareRequirementsDialog
            open={hardwareFailures().length > 0}
            failures={hardwareFailures()}
            mode="exit"
            onDismiss={exitApp}
          />
        </>
      }
    >
      {props.children}
    </Show>
  );
}

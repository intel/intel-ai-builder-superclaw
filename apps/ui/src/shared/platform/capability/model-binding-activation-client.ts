/**
 * Model Binding Activation client for first-launch and settings flows.
 *
 *   POST /app/model-binding/activations      → start activation, returns operation
 *   GET  /app/model-binding/activations/active → discover the active operation
 *   GET  /app/operations/{operation_id}      → poll public status/stage/progress
 *   POST /app/operations/{id}/cancellations  → cancel
 *   GET  /llm-router/v1/capability/primary-bundle → hardware ceiling + supported bundles
 *
 * All calls go through the ServiceHub control-plane proxy with the hub token
 * (same transport as the capability profile fetch). Strictly validated against
 * the shared contracts.
 */
import {
  requestServiceHubJson,
  ServiceHubHttpError,
  type ServiceHubSettings,
} from "~/shared/platform/transport/servicehub";
import {
  PrimaryBundleCapabilitySchema,
  ModelBindingActivationActiveResponseSchema,
  ModelBindingActivationOperationSchema,
  type PrimaryBundleCapability,
  type ModelBindingActivationOperation,
  type ModelBindingActivationRequest,
  type ModelBindingActivationActiveResponse,
  type ActiveAppCapabilityProfile,
} from "@different-ai/openwork-contracts/capability";
import { uiLogDebug, uiLogWarn } from "~/shared/platform/log/log";

// Re-export the capability contract types so consumers (e.g. app.tsx's generic
// activation driver) can import them from this single client module instead
// of reaching into the contracts package directly.
export type { PrimaryBundleCapability, ModelBindingActivationRequest, ModelBindingActivationActiveResponse };

/** An activation that targets a Bundle (every intent except `disconnect`). */
export type ModelBindingConnectRequest = Exclude<ModelBindingActivationRequest, { intent: "disconnect" }>;

export type ActiveProfileBundleCheck = "ready" | "repair" | "reconcile" | "stale" | "unsupported";

/** Decide whether an active Profile's committed local Bundle still has usable assets. */
export function resolveActiveProfileBundleCheck(
  profile: ActiveAppCapabilityProfile,
  capability: PrimaryBundleCapability,
): ActiveProfileBundleCheck {
  const profileBundle = profile.primary_bundle;
  if (!profileBundle || profileBundle.backend === "edge") return "ready";

  const committed = capability.primary_bundle;
  if (
    !committed ||
    committed.bundle_id !== profileBundle.bundle_id ||
    committed.bundle_revision !== profileBundle.bundle_revision
  ) {
    return "stale";
  }

  if (!capability.supported_bundle_ids.includes(committed.bundle_id)) {
    return capability.recommended_bundle_id ? "reconcile" : "unsupported";
  }

  const supported = capability.supported_bundles.find(
    (bundle) => bundle.bundle_id === committed.bundle_id,
  );
  if (!supported || supported.backend !== "llama") return "stale";
  if (committed.state !== "ready") return "repair";
  return supported.fully_cached_and_verified ? "ready" : "repair";
}

export const PRIMARY_BUNDLE_CAPABILITY_PATH = "/llm-router/v1/capability/primary-bundle";
export const MODEL_BINDING_ACTIVATIONS_PATH = "/app/model-binding/activations";
export const OPERATIONS_PATH = "/app/operations";
export const ACTIVE_MODEL_BINDING_ACTIVATION_PATH = "/app/model-binding/activations/active";
export const PERF_WEIGHT_PATH = "/llm-router/v1/perf-weight";
const MODEL_VERIFICATION_TIMEOUT_MS = 120_000;
const SWITCH_START_TIMEOUT_MS = 20_000;

/** DEBUG: log every capability API request + raw response for E2E tracing. */
function logApi(label: string, detail: unknown): void {
  uiLogDebug("capability.api", label, { detail });
}

function isSwitchStartTimeout(error: unknown): error is Error {
  return error instanceof Error &&
    !(error instanceof ServiceHubHttpError) &&
    error.message === "Request timed out.";
}

/** GET the hardware ceiling + supported bundles. */
export async function fetchPrimaryBundleCapability(
  settings: ServiceHubSettings,
  signal?: AbortSignal,
): Promise<PrimaryBundleCapability> {
  logApi("GET primary-bundle → request", { path: PRIMARY_BUNDLE_CAPABILITY_PATH });
  try {
    const raw = await requestServiceHubJson<unknown>(
      settings.baseUrl,
      PRIMARY_BUNDLE_CAPABILITY_PATH,
      settings.token,
      { signal },
    );
    logApi("GET primary-bundle ← response", raw);
    return PrimaryBundleCapabilitySchema.parse(raw);
  } catch (err) {
    logApi("GET primary-bundle ✗ error", { status: (err as { status?: number }).status, message: String(err) });
    throw err;
  }
}

/**
 * Hash and register existing local files for a bundle before first-launch
 * download consent. The capability projection intentionally avoids hashing,
 * so preseeded models have no verification record until this request runs.
 *
 * Best-effort: this is an optimization, not a requirement for startup to
 * proceed. Any failure verifying one asset (missing file, bad id, LRM
 * hiccup, timeout) just leaves that asset unverified — the caller
 * re-evaluates the switch intent afterwards and falls back to the normal
 * download-consent flow for whatever didn't verify. A deliberate cancel via
 * `signal` is the one exception and is always propagated.
 */
export async function verifyUnverifiedBundleAssets(
  settings: ServiceHubSettings,
  capability: PrimaryBundleCapability,
  bundleId: string,
  signal?: AbortSignal,
): Promise<void> {
  const bundle = capability.supported_bundles.find((item) => item.bundle_id === bundleId);
  if (!bundle || bundle.fully_cached_and_verified) return;

  for (const asset of bundle.assets) {
    if (asset.cached_and_verified) continue;
    try {
      await requestServiceHubJson<unknown>(
        settings.baseUrl,
        `/llm-router/v1/models/${encodeURIComponent(asset.asset_id)}/verifications`,
        settings.token,
        { method: "POST", signal, timeoutMs: MODEL_VERIFICATION_TIMEOUT_MS },
      );
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      uiLogWarn("capability.verify", "bundle asset verification failed; falling back to download", {
        assetId: asset.asset_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/** POST an activation. Returns the initial operation projection. */
export async function startModelBindingActivation(
  settings: ServiceHubSettings,
  request: ModelBindingActivationRequest,
  signal?: AbortSignal,
): Promise<ModelBindingActivationOperation> {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    logApi("POST activations → request", { attempt, request });
    try {
      const raw = await requestServiceHubJson<unknown>(
        settings.baseUrl,
        MODEL_BINDING_ACTIVATIONS_PATH,
        settings.token,
        { method: "POST", body: request, signal, timeoutMs: SWITCH_START_TIMEOUT_MS },
      );
      logApi("POST activations ← response", { attempt, response: raw });
      return ModelBindingActivationOperationSchema.parse(raw);
    } catch (err) {
      logApi("POST activations ✗ error", {
        attempt,
        status: (err as { status?: number }).status,
        message: String(err),
      });
      if (!isSwitchStartTimeout(err) || attempt === 2) {
        throw err;
      }
    }
  }
  throw new Error("Model Binding activation retry exhausted.");
}

/** Discover the active activation without changing or retrying it. */
export async function fetchActiveModelBindingActivation(
  settings: ServiceHubSettings,
  signal?: AbortSignal,
): Promise<ModelBindingActivationActiveResponse> {
  try {
    const raw = await requestServiceHubJson<unknown>(
      settings.baseUrl,
      ACTIVE_MODEL_BINDING_ACTIVATION_PATH,
      settings.token,
      { signal },
    );
    logApi("GET active activation ← response", raw);
    return ModelBindingActivationActiveResponseSchema.parse(raw);
  } catch (err) {
    logApi("GET active activation ✗ error", { status: (err as { status?: number }).status, message: String(err) });
    throw err;
  }
}

/** GET an activation operation's current public projection. */
export async function fetchModelBindingActivationOperation(
  settings: ServiceHubSettings,
  operationId: string,
  signal?: AbortSignal,
): Promise<ModelBindingActivationOperation> {
  try {
    const raw = await requestServiceHubJson<unknown>(
      settings.baseUrl,
      `${OPERATIONS_PATH}/${encodeURIComponent(operationId)}`,
      settings.token,
      { signal },
    );
    logApi(`GET operations/${operationId} ← response`, raw);
    return ModelBindingActivationOperationSchema.parse(raw);
  } catch (err) {
    logApi(`GET operations/${operationId} ✗ error`, { status: (err as { status?: number }).status, message: String(err) });
    throw err;
  }
}


/** Explicitly retry the same durable activation after a user Retry action. */
export async function resumeModelBindingActivation(
  settings: ServiceHubSettings,
  operationId: string,
  signal?: AbortSignal,
): Promise<ModelBindingActivationOperation> {
  logApi(`POST activations/${operationId}/resume → request`, {});
  const raw = await requestServiceHubJson<unknown>(
    settings.baseUrl,
    `${MODEL_BINDING_ACTIVATIONS_PATH}/${encodeURIComponent(operationId)}/resume`,
    settings.token,
    { method: "POST", signal },
  );
  logApi(`POST activations/${operationId}/resume ← response`, raw);
  return ModelBindingActivationOperationSchema.parse(raw);
}

/** POST a cancellation for an in-flight activation. */
export async function cancelModelBindingActivation(
  settings: ServiceHubSettings,
  operationId: string,
  signal?: AbortSignal,
): Promise<ModelBindingActivationOperation> {
  const raw = await requestServiceHubJson<unknown>(
    settings.baseUrl,
    `${OPERATIONS_PATH}/${encodeURIComponent(operationId)}/cancellations`,
    settings.token,
    { method: "POST", signal },
  );
  return ModelBindingActivationOperationSchema.parse(raw);
}

/**
 * PUT the AUTO-routing balance (`perf_weight`) via the LRM control plane, the
 * same endpoint the Routing Balance slider uses. Called at a bundle-switch
 * boundary to reset the persisted balance to the target bundle's default
 * (see routing-defaults). Persists + live-updates the router.
 */
export async function putPerfWeight(
  settings: ServiceHubSettings,
  perfWeight: number,
  signal?: AbortSignal,
): Promise<void> {
  await requestServiceHubJson<unknown>(
    settings.baseUrl,
    PERF_WEIGHT_PATH,
    settings.token,
    { method: "PUT", body: { perf_weight: perfWeight }, signal },
  );
}

export const LOCAL_CTX_SIZE_PATH = "/llm-router/v1/local/ctx-size";

/** GET the AUTO-routing balance. `supported` is false when the router has no such knob. */
export async function fetchPerfWeight(
  settings: ServiceHubSettings,
): Promise<{ perf_weight?: number; supported?: boolean }> {
  return requestServiceHubJson(settings.baseUrl, PERF_WEIGHT_PATH, settings.token);
}

export type LocalCtxSizeState = {
  ctx_size: number | null;
  applied: number | null;
  source: "env" | "store" | "registry" | "booster" | "unknown";
  restarted?: boolean;
  supported: boolean;
};

/** GET the llama-server context size override and the value it runs with. */
export async function fetchLocalCtxSize(settings: ServiceHubSettings): Promise<LocalCtxSizeState> {
  return requestServiceHubJson(settings.baseUrl, LOCAL_CTX_SIZE_PATH, settings.token);
}

/**
 * LRM's current lifecycle revision. `bundle_revision` is set even when no
 * Bundle is committed (after a release it is higher than 0); the fallbacks
 * cover an older LRM that only reported it inside `primary_bundle`.
 */
export function currentBundleRevision(capability: PrimaryBundleCapability): number {
  return capability.bundle_revision ?? capability.primary_bundle?.bundle_revision ?? 0;
}

/**
 * Build an explicit user-requested switch to the hardware ceiling bundle.
 * Uses `connect` when the bundle is fully cached (no download), else
 * `download_and_connect` with explicit consent.
 */
export function buildCeilingActivationRequest(
  capability: PrimaryBundleCapability,
): ModelBindingConnectRequest | null {
  const ceiling = capability.hardware_capability_ceiling;
  if (!ceiling) return null;
  return buildLocalBundleActivationRequest(capability, ceiling.bundle_id);
}

/** Build an explicit user-requested switch to any compute-supported Local Bundle. */
export function buildLocalBundleActivationRequest(
  capability: PrimaryBundleCapability,
  bundleId: string,
): ModelBindingConnectRequest | null {
  const bundle = capability.supported_bundles.find(
    (item) => item.backend === "llama" && item.bundle_id === bundleId,
  );
  if (!bundle) return null;
  const cached = bundle?.fully_cached_and_verified ?? false;
  const idempotency_key = `local-connect-${bundleId}-${crypto.randomUUID()}`;
  const common = {
    contract_version: 1 as const,
    target_bundle_id: bundleId,
    candidate_revision: capability.model_candidate_revision,
    expected_bundle_revision: currentBundleRevision(capability),
    idempotency_key,
  };
  return cached
    ? { ...common, intent: "connect" }
    : { ...common, intent: "download_and_connect", user_confirmed_download: true };
}

/**
 * Build the automatic first-launch activation request. Startup preserves a
 * committed primary bundle while it remains compute-supported. If hardware or
 * registry changes make it unsupported, startup activates LRM's recommendation.
 *
 * Why a committed bundle still needs a switch at all (#1528): the caller only
 * runs while the capability profile reports `capability_profile_initializing`,
 * and ServiceHub answers that endpoint strictly AFTER its startup reconcile
 * settled — so reaching this builder with a committed bundle means there is NO
 * active Profile and nothing else is producing one (a discarded-on-drift
 * Profile, a wiped profile-state.json). Waiting would hang startup forever;
 * the committed bundle must be re-driven through a switch to re-project it:
 *
 *   * assets cached-and-verified (incl. edge, which never has local assets) →
 *     `connect`: no download, commits and re-activates in seconds. If another
 *     driver does have a switch in flight, the POST fails switch-in-progress
 *     and the caller adopts that operation instead — re-driving is race-safe.
 *   * local bundle with drifted assets (deleted model files, wiped models
 *     dir) → `download_and_connect`; the caller's consent dialog still gates
 *     the actual re-download.
 *   * committed bundle missing from `supported_bundles` entirely → null;
 *     nothing safe to build — the caller surfaces an explicit error (waiting
 *     silently would be the same indefinite hang, since no Profile driver
 *     exists for this state either).
 */
export function buildStartupCeilingActivationRequest(
  capability: PrimaryBundleCapability,
): ModelBindingConnectRequest | null {
  const committed = capability.primary_bundle;
  if (committed && !capability.supported_bundle_ids.includes(committed.bundle_id)) {
    const recommended = capability.recommended_bundle_id;
    return recommended ? buildLocalBundleActivationRequest(capability, recommended) : null;
  }
  if (committed) {
    const bundle = capability.supported_bundles.find(
      (b) => b.bundle_id === committed.bundle_id,
    );
    if (!bundle) return null;
    const common = {
      contract_version: 1 as const,
      target_bundle_id: committed.bundle_id,
      candidate_revision: capability.model_candidate_revision,
      expected_bundle_revision: committed.bundle_revision,
      idempotency_key: `startup-${committed.bundle_id}-${crypto.randomUUID()}`,
    };
    if (bundle.fully_cached_and_verified) {
      return { ...common, intent: "connect" };
    }
    if (bundle.backend === "edge") {
      // Defensive: an edge row should always report cached (no local assets);
      // an uncached edge row is malformed, and edge can never download.
      return null;
    }
    return { ...common, intent: "download_and_connect", user_confirmed_download: true };
  }
  return buildCeilingActivationRequest(capability);
}

/**
 * Build the switch request that submits the configured Edge Bundle as the
 * primary bundle ("Connect Edge"). `null` when no Edge Bundle is surfaced by
 * `GET /llm-router/v1/capability/primary-bundle` — either Edge is not
 * configured, or capability gating itself is off (caller should treat `null`
 * as "nothing to switch", not an error).
 *
 * Edge has no download semantics: the target bundle's `backend === "edge"`
 * row is always reported `fully_cached_and_verified` by LRM, so `connect` is
 * the only legal intent here (unlike `buildCeilingActivationRequest`, which may
 * need `download_and_connect` for a local bundle).
 */
export function buildEdgeConnectActivationRequest(
  capability: PrimaryBundleCapability,
  preferredBundleId?: string,
): ModelBindingConnectRequest | null {
  const edgeBundles = capability.supported_bundles.filter((b) => b.backend === "edge");
  const edgeBundle = preferredBundleId
    ? edgeBundles.find((bundle) => bundle.bundle_id === preferredBundleId)
    : edgeBundles.length === 1 ? edgeBundles[0] : undefined;
  if (!edgeBundle) return null;
  return {
    contract_version: 1,
    target_bundle_id: edgeBundle.bundle_id,
    intent: "connect",
    candidate_revision: capability.model_candidate_revision,
    expected_bundle_revision: currentBundleRevision(capability),
    idempotency_key: `edge-connect-${edgeBundle.bundle_id}-${crypto.randomUUID()}`,
  };
}

/**
 * True when Edge can be disconnected: Lite hardware (cloud-only verdict) and
 * an active Profile bound to Edge. The Profile, not LRM, is the check: after a
 * disconnect whose runtime step failed, LRM has already released Edge while the
 * Profile is still Edge, and Disconnect must stay available to finish the job.
 * Other hardware switches to a local Bundle instead.
 */
export function canDisconnectEdge(
  capability: PrimaryBundleCapability | null | undefined,
  profile: ActiveAppCapabilityProfile | null | undefined,
): boolean {
  return (
    capability?.cloud_only_product_profile_id === "lite" &&
    profile?.primary_bundle?.backend === "edge"
  );
}

/** Build the request that releases the Edge Bundle and returns to bundle-free Lite. */
export function buildEdgeDisconnectActivationRequest(
  capability: PrimaryBundleCapability,
  profile: ActiveAppCapabilityProfile | null | undefined,
): ModelBindingActivationRequest | null {
  const bundle = profile?.primary_bundle;
  if (!canDisconnectEdge(capability, profile) || !bundle) return null;
  return {
    contract_version: 1,
    intent: "disconnect",
    // ServiceHub checks this against the Profile's Binding, which outlives an LRM release.
    expected_bundle_revision: bundle.bundle_revision,
    idempotency_key: `edge-disconnect-${crypto.randomUUID()}`,
  };
}

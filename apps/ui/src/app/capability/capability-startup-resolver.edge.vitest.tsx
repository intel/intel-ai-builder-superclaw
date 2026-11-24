/**
 * Contract test for #3531: a committed Edge Bundle whose server is unreachable must
 * open the app degraded instead of holding the startup overlay.
 *
 * Renders the real resolver, reveal policy and signals; mocks only the transports.
 * Real timers: the resolver's dwell (1.6 s), Edge grace (2.5 s) and operation poll
 * (1.5 s) are what is under test.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type {
  ModelBindingActivationOperation,
  PrimaryBundleCapability,
  SupportedBundle,
} from "@different-ai/openwork-contracts/capability";
import type { AppCapabilityState } from "~/shared/platform/capability/app-capability-provider";

const mocks = vi.hoisted(() => ({
  fetchPrimaryBundleCapability: vi.fn(),
  fetchActiveModelBindingActivation: vi.fn(),
  fetchModelBindingActivationOperation: vi.fn(),
  startModelBindingActivation: vi.fn(),
  fetchSystemPreflight: vi.fn(),
  fetchOwtToken: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "2.0.0" }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({}) }));
vi.mock("../utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils")>()),
  isTauriRuntime: () => false,
}));
vi.mock("../lib/log", () => ({ uiLogDebug: vi.fn(), uiLogError: vi.fn(), uiLogInfo: vi.fn(), uiLogWarn: vi.fn() }));
vi.mock("../lib/tauri", () => ({ cacheTargetBundleId: async () => undefined }));
vi.mock("../lib/telemetry", () => ({
  createSandboxReadyReporter: () => () => undefined,
  emitStartupPhase: async () => undefined,
}));
vi.mock("../lib/llmrouter-client", () => ({ createLlmRouterClient: () => ({}) }));
vi.mock("../lib/servicehub", () => ({
  fetchOwtToken: mocks.fetchOwtToken,
  fetchReadinessBlockers: async () => [],
  isOwtSandboxProvisioningCode: () => true,
  requestRuntimeConverge: async () => undefined,
  ServiceHubHttpError: class extends Error {
    status = 0;
    code = "";
  },
}));
vi.mock("~/shared/platform/capability/system-preflight-client", () => ({
  fetchSystemPreflight: mocks.fetchSystemPreflight,
}));
vi.mock("~/shared/platform/capability/model-binding-activation-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/shared/platform/capability/model-binding-activation-client")>()),
  fetchPrimaryBundleCapability: mocks.fetchPrimaryBundleCapability,
  fetchActiveModelBindingActivation: mocks.fetchActiveModelBindingActivation,
  fetchModelBindingActivationOperation: mocks.fetchModelBindingActivationOperation,
  startModelBindingActivation: mocks.startModelBindingActivation,
  putPerfWeight: async () => undefined,
  verifyUnverifiedBundleAssets: async () => undefined,
}));

const [capState, setCapState] = createSignal<AppCapabilityState>({ status: "initializing" });
vi.mock("~/shared/platform/capability/app-capability-provider", () => ({
  useAppCapability: () => ({
    state: capState,
    activeProfile: () => {
      const state = capState();
      return state.status === "active" ? state.profile : null;
    },
    recovery: () => null,
    refresh: mocks.refresh,
  }),
}));
vi.mock("./host-client-provider", () => ({
  useHostClient: () => ({ settings: () => ({ baseUrl: "http://127.0.0.1:1", token: "hub-token" }) }),
}));

const { CapabilityStartupResolver } = await import("./capability-startup-resolver");
const { capabilityStartupHandled, startupOwtToken } = await import(
  "~/shared/platform/capability/capability-startup-signal"
);
const { edgeDegraded, retryEdgeConnection, setEdgeDegraded } = await import(
  "~/shared/platform/capability/edge-degraded-signal"
);

const WAIT = { timeout: 8000 };

function row(bundle_id: string, backend: SupportedBundle["backend"]): SupportedBundle {
  return {
    bundle_id,
    backend,
    display_name: bundle_id,
    capability_grade: "standard",
    chat_model_label: "chat",
    embedding_model_label: "embed",
    assets: [],
    total_download_bytes: 0,
    required_free_bytes: 0,
    fully_cached_and_verified: true,
    download_feasibility: "ready",
  } as SupportedBundle;
}

/** A device with a committed Bundle of the given backend, and nothing to download. */
function committed(bundleId: string, backend: SupportedBundle["backend"]): PrimaryBundleCapability {
  return {
    model_candidate_revision: 3,
    supported_bundle_ids: [bundleId],
    supported_bundles: [row(bundleId, backend)],
    hardware: { cpu_brand: "", gpu_names: [], total_ram_gb: 32, mem_speed_mts: 0, detection_errors: [] },
    observed_at: "2026-10-26T00:00:00Z",
    reasons: [],
    primary_bundle: {
      bundle_id: bundleId,
      backend,
      bundle_revision: 7,
      state: "ready",
    },
  } as unknown as PrimaryBundleCapability;
}

const applying: ModelBindingActivationOperation = {
  contract_version: 1,
  status: "applying",
  operation_id: "op-1",
  stage: "preparing",
} as ModelBindingActivationOperation;

function failedWith(
  reason_code?: "url_unreachable" | "bundle_incomplete" | "model_not_found",
): ModelBindingActivationOperation {
  return {
    contract_version: 1,
    status: "failed",
    operation_id: "op-1",
    error: { code: "safe_error", message: "Can't reach Edge server edge.example: connection failed", reason_code },
    retryable: false,
  } as ModelBindingActivationOperation;
}

const succeeded = {
  contract_version: 1,
  status: "succeeded",
  operation_id: "op-1",
  runtime_transition_required: false,
} as ModelBindingActivationOperation;

const activeEdgeProfile = {
  status: "active",
  profile: {
    lifecycle_state: "active",
    product_profile_id: "standard",
    profile_revision: 2,
    primary_bundle: { bundle_id: "edge-1", backend: "edge", bundle_revision: 8, state: "ready" },
    reasons: [],
  },
} as unknown as AppCapabilityState;

function renderResolver() {
  return render(() => (
    <CapabilityStartupResolver>
      <div>APP</div>
    </CapabilityStartupResolver>
  ));
}

beforeEach(() => {
  vi.clearAllMocks();
  setCapState({ status: "initializing" });
  setEdgeDegraded(null);
  mocks.fetchSystemPreflight.mockResolvedValue(null);
  mocks.fetchActiveModelBindingActivation.mockResolvedValue({ operation: null });
  mocks.startModelBindingActivation.mockResolvedValue(applying);
  mocks.fetchOwtToken.mockResolvedValue({ ok: true, token: "owt-token" });
  mocks.refresh.mockImplementation(async () => {
    setCapState(activeEdgeProfile);
  });
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("CapabilityStartupResolver with a committed Edge Bundle (#3531)", () => {
  // Kept first: capabilityStartupHandled is a process-lifetime latch.
  test("an unreachable Edge server reveals the app degraded, not the blocking overlay", async () => {
    expect(capabilityStartupHandled()).toBe(false);
    mocks.fetchPrimaryBundleCapability.mockResolvedValue(committed("edge-1", "edge"));
    mocks.fetchModelBindingActivationOperation.mockResolvedValue(failedWith("url_unreachable"));

    renderResolver();

    await waitFor(() => expect(screen.getByText("APP")).toBeTruthy(), WAIT);
    // The legacy edge-server-startup-gate (F8) bypasses on this latch.
    expect(capabilityStartupHandled()).toBe(true);
    expect(edgeDegraded()).toEqual({
      state: "unreachable",
      bundleId: "edge-1",
      reasonCode: "url_unreachable",
      message: "Can't reach Edge server edge.example: connection failed",
      modelLabel: "chat",
    });
    // No "SuperClaw failed to start" overlay with the error.
    expect(screen.queryByText(/Can't reach Edge server/)).toBeNull();
    expect(mocks.startModelBindingActivation.mock.calls[0]?.[1]).toMatchObject({
      intent: "connect",
      target_bundle_id: "edge-1",
    });
  }, 15_000);

  test("an Edge server that no longer serves the committed Bundle reveals the app degraded", async () => {
    mocks.fetchPrimaryBundleCapability.mockResolvedValue(committed("edge-1", "edge"));
    mocks.fetchModelBindingActivationOperation.mockResolvedValue(failedWith("bundle_incomplete"));

    renderResolver();

    await waitFor(() => expect(screen.getByText("APP")).toBeTruthy(), WAIT);
    expect(edgeDegraded()).toMatchObject({ state: "unreachable", bundleId: "edge-1", reasonCode: "bundle_incomplete" });
  }, 15_000);

  test("a saved Edge model the server no longer lists reveals the app degraded (#4066)", async () => {
    mocks.fetchPrimaryBundleCapability.mockResolvedValue(committed("edge-1", "edge"));
    mocks.fetchModelBindingActivationOperation.mockResolvedValue(failedWith("model_not_found"));

    renderResolver();

    await waitFor(() => expect(screen.getByText("APP")).toBeTruthy(), WAIT);
    expect(edgeDegraded()).toMatchObject({ bundleId: "edge-1", reasonCode: "model_not_found", modelLabel: "chat" });
  }, 15_000);

  test("an in-progress 409 whose operation already settled starts once more and degrades", async () => {
    // ServiceHub's boot reheal was in flight at POST time and failed before the adopt lookup.
    const { ServiceHubHttpError } = await import("../lib/servicehub");
    const code = "model_binding_activation_in_progress";
    // The mocked class ignores constructor args, so set the fields it checks.
    const inProgress = Object.assign(new ServiceHubHttpError("conflicts with durable state", 409, code), {
      status: 409,
      code,
    });
    mocks.fetchPrimaryBundleCapability.mockResolvedValue(committed("edge-1", "edge"));
    mocks.startModelBindingActivation.mockRejectedValueOnce(inProgress).mockResolvedValue(applying);
    mocks.fetchModelBindingActivationOperation.mockResolvedValue(failedWith("url_unreachable"));

    renderResolver();

    await waitFor(() => expect(edgeDegraded()?.state).toBe("unreachable"), WAIT);
    expect(mocks.startModelBindingActivation).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/conflicts with durable state/)).toBeNull();
  }, 15_000);

  test("a slow Edge reveals as connecting after the grace period, and success clears it", async () => {
    mocks.fetchPrimaryBundleCapability.mockResolvedValue(committed("edge-1", "edge"));
    mocks.fetchModelBindingActivationOperation.mockResolvedValue(applying);

    renderResolver();

    await waitFor(() => expect(screen.getByText("APP")).toBeTruthy(), WAIT);
    expect(edgeDegraded()?.state).toBe("connecting");

    mocks.fetchModelBindingActivationOperation.mockResolvedValue(succeeded);
    await waitFor(() => expect(edgeDegraded()).toBeNull(), WAIT);
    expect(capState().status).toBe("active");
    // Late recovery hands the workspace token over, as startup Phase C does.
    await waitFor(() => expect(startupOwtToken()).toBe("owt-token"), WAIT);
  }, 20_000);

  test("a slow Edge whose Profile read fails after success leaves connecting, and Retry reads it again", async () => {
    mocks.fetchPrimaryBundleCapability.mockResolvedValue(committed("edge-1", "edge"));
    mocks.fetchModelBindingActivationOperation.mockResolvedValue(applying);
    // The provider does not retry a network failure: it settles on transport_error.
    mocks.refresh.mockImplementationOnce(async () => {
      setCapState({ status: "transport_error", error: { kind: "network", message: "fetch failed" } });
    });

    renderResolver();
    await waitFor(() => expect(edgeDegraded()?.state).toBe("connecting"), WAIT);
    mocks.fetchModelBindingActivationOperation.mockResolvedValue(succeeded);

    await waitFor(() => expect(edgeDegraded()?.state).toBe("unreachable"), WAIT);
    expect(edgeDegraded()).toMatchObject({ profileLoadFailed: true, message: "fetch failed", bundleId: "edge-1" });
    expect(screen.getByText("APP")).toBeTruthy();

    // Retry reads the Profile again rather than starting another activation.
    retryEdgeConnection();
    await waitFor(() => expect(edgeDegraded()).toBeNull(), WAIT);
    expect(capState().status).toBe("active");
    expect(mocks.refresh).toHaveBeenCalledTimes(2);
    expect(mocks.startModelBindingActivation).toHaveBeenCalledTimes(1);
  }, 20_000);

  test("a Profile read that fails before the activation succeeds does not make Retry refresh-only", async () => {
    mocks.fetchPrimaryBundleCapability.mockResolvedValue(committed("edge-1", "edge"));
    mocks.fetchModelBindingActivationOperation.mockResolvedValue(applying);

    renderResolver();
    await waitFor(() => expect(edgeDegraded()?.state).toBe("connecting"), WAIT);

    // Both reads fail while the activation is still applying: the provider's, then the poll's.
    setCapState({ status: "transport_error", error: { kind: "network", message: "fetch failed" } });
    expect(edgeDegraded()?.state).toBe("connecting");
    mocks.fetchModelBindingActivationOperation.mockRejectedValue(new Error("ServiceHub poll failed"));
    await waitFor(() => expect(edgeDegraded()?.state).toBe("unreachable"), WAIT);
    expect(edgeDegraded()?.profileLoadFailed).toBeFalsy();

    // Retry goes back through the activation, not only the Profile read.
    mocks.fetchModelBindingActivationOperation.mockResolvedValue(applying);
    retryEdgeConnection();
    await waitFor(() => expect(mocks.startModelBindingActivation).toHaveBeenCalledTimes(2), WAIT);
    expect(mocks.refresh).not.toHaveBeenCalled();
  }, 20_000);

  test("a slow Edge that then fails moves from connecting to unreachable, and Retry re-runs it", async () => {
    mocks.fetchPrimaryBundleCapability.mockResolvedValue(committed("edge-1", "edge"));
    mocks.fetchModelBindingActivationOperation.mockResolvedValue(applying);

    renderResolver();

    await waitFor(() => expect(edgeDegraded()?.state).toBe("connecting"), WAIT);
    mocks.fetchModelBindingActivationOperation.mockResolvedValue(failedWith("url_unreachable"));
    await waitFor(() => expect(edgeDegraded()?.state).toBe("unreachable"), WAIT);
    expect(screen.getByText("APP")).toBeTruthy();

    // Retry runs the activation again in place, no app restart.
    mocks.fetchModelBindingActivationOperation.mockResolvedValue(applying);
    retryEdgeConnection();
    expect(edgeDegraded()?.state).toBe("connecting");
    await waitFor(() => expect(mocks.startModelBindingActivation).toHaveBeenCalledTimes(2), WAIT);
  }, 20_000);

  test("a Retry that settles without starting a connection falls back to unreachable with its reason", async () => {
    mocks.fetchPrimaryBundleCapability.mockResolvedValue(committed("edge-1", "edge"));
    mocks.fetchModelBindingActivationOperation.mockResolvedValue(failedWith("url_unreachable"));

    renderResolver();
    await waitFor(() => expect(edgeDegraded()?.state).toBe("unreachable"), WAIT);

    // The committed Bundle is gone from capability: runActivation sets an overlay
    // error and returns without polling. The overlay is unmounted by now.
    mocks.fetchPrimaryBundleCapability.mockResolvedValue({
      ...committed("edge-1", "edge"),
      supported_bundle_ids: [],
      supported_bundles: [],
    });
    retryEdgeConnection();
    expect(edgeDegraded()?.state).toBe("connecting");
    await waitFor(() => expect(edgeDegraded()?.state).toBe("unreachable"), WAIT);
    expect(edgeDegraded()?.message).toContain("edge-1");
    expect(mocks.startModelBindingActivation).toHaveBeenCalledTimes(1);
  }, 15_000);
});

describe("CapabilityStartupResolver negatives (#3531)", () => {
  test("a local Bundle failure still blocks on the startup overlay", async () => {
    mocks.fetchPrimaryBundleCapability.mockResolvedValue(committed("local-1", "llama"));
    mocks.fetchModelBindingActivationOperation.mockResolvedValue(failedWith("url_unreachable"));

    renderResolver();

    await waitFor(() => expect(screen.getAllByText(/Can't reach Edge server/).length).toBeGreaterThan(0), WAIT);
    await new Promise((resolve) => setTimeout(resolve, 3000));
    expect(screen.queryByText("APP")).toBeNull();
    expect(edgeDegraded()).toBeNull();
  }, 15_000);

  test("an Edge failure without a reason code before reveal keeps the overlay", async () => {
    mocks.fetchPrimaryBundleCapability.mockResolvedValue(committed("edge-1", "edge"));
    mocks.fetchModelBindingActivationOperation.mockResolvedValue(failedWith());

    renderResolver();

    await waitFor(() => expect(screen.getAllByText(/Can't reach Edge server/).length).toBeGreaterThan(0), WAIT);
    await new Promise((resolve) => setTimeout(resolve, 3000));
    expect(screen.queryByText("APP")).toBeNull();
    expect(edgeDegraded()).toBeNull();
  }, 15_000);

  test("a first Edge poll that throws keeps the overlay; the grace timer does not reveal it later", async () => {
    mocks.fetchPrimaryBundleCapability.mockResolvedValue(committed("edge-1", "edge"));
    mocks.fetchModelBindingActivationOperation.mockRejectedValue(new Error("ServiceHub poll failed"));

    renderResolver();

    await waitFor(() => expect(screen.getAllByText(/ServiceHub poll failed/).length).toBeGreaterThan(0), WAIT);
    // Past the 2.5 s grace period.
    await new Promise((resolve) => setTimeout(resolve, 3500));
    expect(edgeDegraded()).toBeNull();
    expect(screen.queryByText("APP")).toBeNull();
  }, 15_000);

  test("the overlay Retry after a failed first poll re-arms the Edge grace for the resumed poll", async () => {
    mocks.fetchPrimaryBundleCapability.mockResolvedValue(committed("edge-1", "edge"));
    mocks.fetchModelBindingActivationOperation.mockRejectedValueOnce(new Error("ServiceHub poll failed"));

    renderResolver();

    await waitFor(() => expect(screen.getAllByText(/ServiceHub poll failed/).length).toBeGreaterThan(0), WAIT);
    // The resumed poll finds the Edge connect still running.
    mocks.fetchModelBindingActivationOperation.mockResolvedValue(applying);
    fireEvent.click(screen.getByRole("button", { name: /Retry/ }));

    await waitFor(() => expect(edgeDegraded()?.state).toBe("connecting"), WAIT);
    await waitFor(() => expect(screen.getByText("APP")).toBeTruthy(), WAIT);
    expect(mocks.startModelBindingActivation).toHaveBeenCalledTimes(1);
  }, 15_000);

  test("a hardware block still holds", async () => {
    mocks.fetchPrimaryBundleCapability.mockResolvedValue({
      ...committed("local-1", "llama"),
      primary_bundle: undefined,
      hardware_capability_ceiling: { bundle_id: "local-1" },
    });
    mocks.fetchSystemPreflight.mockResolvedValue({
      checks: [{ name: "model_memory", state: "fail", severity: "error", free_gb: 4, required_gb: 16 }],
    });

    renderResolver();

    await new Promise((resolve) => setTimeout(resolve, 3500));
    expect(mocks.startModelBindingActivation).not.toHaveBeenCalled();
    expect(screen.queryByText("APP")).toBeNull();
    expect(edgeDegraded()).toBeNull();
  }, 15_000);
});

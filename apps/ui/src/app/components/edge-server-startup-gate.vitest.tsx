import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getEdge: vi.fn(),
  putEdge: vi.fn(),
  testEdge: vi.fn(),
  getPrimaryBundleCapability: vi.fn(),
  startActivation: vi.fn(),
  fetchActivationOperation: vi.fn(),
  setLocalProvider: vi.fn(),
  isTauriRuntime: vi.fn(),
  capabilityStartupHandled: vi.fn(),
}));

import { MODEL_BINDING_ACTIVATION_ERROR_COPY } from "@different-ai/openwork-contracts/capability";
import { ServiceHubHttpError } from "~/shared/platform/transport/servicehub";

vi.mock("../lib/llmrouter-client", () => ({
  createLlmRouterClient: () => ({
    getEdge: mocks.getEdge,
    putEdge: mocks.putEdge,
    testEdge: mocks.testEdge,
    getPrimaryBundleCapability: mocks.getPrimaryBundleCapability,
    setLocalProvider: mocks.setLocalProvider,
  }),
}));
vi.mock("~/shared/platform/capability/model-binding-activation-client", () => ({
  buildEdgeConnectActivationRequest: (_capability: unknown, bundleId: string) => ({
    target_bundle_id: bundleId,
  }),
  startModelBindingActivation: mocks.startActivation,
  fetchModelBindingActivationOperation: mocks.fetchActivationOperation,
}));
vi.mock("../utils", () => ({ isTauriRuntime: mocks.isTauriRuntime }));
vi.mock("~/shared/platform/capability/capability-startup-signal", () => ({
  capabilityStartupHandled: mocks.capabilityStartupHandled,
}));
vi.mock("../../i18n", () => ({ t: (key: string) => key }));

const { default: EdgeServerStartupGate } = await import(
  "./edge-server-startup-gate"
);

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.isTauriRuntime.mockReturnValue(true);
  mocks.capabilityStartupHandled.mockReturnValue(false);
  mocks.setLocalProvider.mockResolvedValue(undefined);
  mocks.putEdge.mockResolvedValue({
    edge_model_selection_fingerprint: "selection-coder",
  });
  mocks.startActivation.mockResolvedValue({
    status: "succeeded",
    operation_id: "activation-1",
  });
  mocks.fetchActivationOperation.mockResolvedValue({
    status: "succeeded",
    operation_id: "activation-1",
  });
  mocks.getEdge.mockResolvedValue({
    configured: true,
    base_url: "https://edge.example/v1",
    model_name: "Qwen3-Coder-Next",
    edge_model_selection_fingerprint: "selection-coder",
    bypass_proxy: true,
  });
});

async function renderGate() {
  const ready = vi.fn();
  const view = render(
    () => (
      <EdgeServerStartupGate
        backendBootReady
        serverHealthy
        serverBaseUrl="http://127.0.0.1:8787"
        serverToken="server-token"
        hubUrl="http://127.0.0.1:8788"
        hubToken="hub-token"
        persistEdgeProvider={false}
        onReady={ready}
      >
        <div data-testid="gate-children">ready</div>
      </EdgeServerStartupGate>
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  return { host: view.container, ready };
}

describe("EdgeServerStartupGate saved-config recovery", () => {
  test("adopts a saved config only when capability still supports its model", async () => {
    mocks.getPrimaryBundleCapability.mockResolvedValue({
      supported_bundles: [
        {
          bundle_id: "edge-coder",
          backend: "edge",
          chat_model_label: "Qwen3-Coder-Next",
        },
      ],
      primary_edge_config_matches: true,
      edge_model_selection_fingerprint: "selection-coder",
      primary_bundle: {
        backend: "edge",
        bundle_id: "edge-coder",
        state: "ready",
      },
    });

    const { host, ready } = await renderGate();

    expect(mocks.getPrimaryBundleCapability).toHaveBeenCalledOnce();
    expect(ready).toHaveBeenCalledOnce();
    expect(host.querySelector("[data-testid=gate-children]")).not.toBeNull();
  });

  test("keeps the gate open for input when saved-config validation fails", async () => {
    mocks.getPrimaryBundleCapability.mockRejectedValue(new Error("offline"));

    const { host, ready } = await renderGate();

    expect(mocks.getPrimaryBundleCapability).toHaveBeenCalledOnce();
    expect(ready).not.toHaveBeenCalled();
    expect(host.querySelector("[data-testid=gate-children]")).toBeNull();
    expect(host.textContent).toContain("offline");
  });

  test("does not adopt a saved model absent from supported Edge Bundles", async () => {
    mocks.getPrimaryBundleCapability.mockResolvedValue({
      supported_bundles: [
        {
          bundle_id: "local-coder",
          backend: "llama",
          chat_model_label: "Qwen3-Coder-Next",
        },
      ],
      edge_model_selection_fingerprint: "selection-coder",
    });

    const { host, ready } = await renderGate();

    expect(ready).not.toHaveBeenCalled();
    expect(host.querySelector("[data-testid=gate-children]")).toBeNull();
    expect(host.textContent).toContain(
      "The saved Edge model is not available as a supported Bundle.",
    );
  });

  test("retries activation instead of adopting a supported but uncommitted model", async () => {
    mocks.getPrimaryBundleCapability
      .mockResolvedValueOnce({
        primary_edge_config_matches: false,
        edge_model_selection_fingerprint: "selection-coder",
        supported_bundles: [
          {
            bundle_id: "edge-coder",
            backend: "edge",
            chat_model_label: "Qwen3-Coder-Next",
          },
        ],
      })
      .mockResolvedValueOnce({
        primary_edge_config_matches: true,
        edge_model_selection_fingerprint: "selection-coder",
        supported_bundles: [
          {
            bundle_id: "edge-coder",
            backend: "edge",
            chat_model_label: "Qwen3-Coder-Next",
          },
        ],
        primary_bundle: {
          backend: "edge",
          bundle_id: "edge-coder",
          state: "ready",
        },
      });

    const { ready } = await renderGate();

    expect(mocks.startActivation).toHaveBeenCalledOnce();
    expect(ready).toHaveBeenCalledOnce();
  });

  test("re-activates a ready model when the saved connection has changed", async () => {
    mocks.getPrimaryBundleCapability
      .mockResolvedValueOnce({
        primary_edge_config_matches: false,
        edge_model_selection_fingerprint: "selection-coder",
        supported_bundles: [
          {
            bundle_id: "edge-coder",
            backend: "edge",
            chat_model_label: "Qwen3-Coder-Next",
          },
        ],
        primary_bundle: {
          backend: "edge",
          bundle_id: "edge-coder",
          state: "ready",
        },
      })
      .mockResolvedValueOnce({
        primary_edge_config_matches: true,
        edge_model_selection_fingerprint: "selection-coder",
        supported_bundles: [
          {
            bundle_id: "edge-coder",
            backend: "edge",
            chat_model_label: "Qwen3-Coder-Next",
          },
        ],
        primary_bundle: {
          backend: "edge",
          bundle_id: "edge-coder",
          state: "ready",
        },
      });

    const { ready } = await renderGate();

    expect(mocks.startActivation).toHaveBeenCalledOnce();
    expect(ready).toHaveBeenCalledOnce();
  });

  test("does not adopt a supported model when activation fails", async () => {
    mocks.getPrimaryBundleCapability.mockResolvedValue({
      edge_model_selection_fingerprint: "selection-coder",
      supported_bundles: [
        {
          bundle_id: "edge-coder",
          backend: "edge",
          chat_model_label: "Qwen3-Coder-Next",
        },
      ],
    });
    mocks.startActivation.mockResolvedValue({
      status: "failed",
      operation_id: "activation-1",
      error: { code: "safe_error", message: "embedding model is missing" },
    });

    const { host, ready } = await renderGate();

    expect(ready).not.toHaveBeenCalled();
    expect(host.querySelector("[data-testid=gate-children]")).toBeNull();
    expect(host.textContent).toContain("embedding model is missing");
    expect(host.textContent).toContain("(Code: safe_error)");
  });

  test("says why and what to do when ServiceHub refuses to start the activation", async () => {
    mocks.getPrimaryBundleCapability.mockResolvedValue({
      edge_model_selection_fingerprint: "selection-coder",
      supported_bundles: [
        {
          bundle_id: "edge-coder",
          backend: "edge",
          chat_model_label: "Qwen3-Coder-Next",
        },
      ],
    });
    mocks.startActivation.mockRejectedValue(
      new ServiceHubHttpError(
        MODEL_BINDING_ACTIVATION_ERROR_COPY.bundle_candidate_changed,
        409,
        "bundle_candidate_changed",
      ),
    );

    const { host, ready } = await renderGate();

    expect(ready).not.toHaveBeenCalled();
    expect(host.textContent).toContain(MODEL_BINDING_ACTIVATION_ERROR_COPY.bundle_candidate_changed);
    expect(host.textContent).toContain("(Code: bundle_candidate_changed)");
  });

  test("rejects a capability snapshot from a newer Edge model selection", async () => {
    mocks.getPrimaryBundleCapability.mockResolvedValue({
      edge_model_selection_fingerprint: "selection-flash",
      supported_bundles: [
        {
          bundle_id: "edge-coder",
          backend: "edge",
          chat_model_label: "Qwen3-Coder-Next",
        },
      ],
      primary_bundle: {
        backend: "edge",
        bundle_id: "edge-coder",
        state: "ready",
      },
    });

    const { host, ready } = await renderGate();

    expect(ready).not.toHaveBeenCalled();
    expect(mocks.startActivation).not.toHaveBeenCalled();
    expect(host.querySelector("[data-testid=gate-children]")).toBeNull();
  });
});

describe("EdgeServerStartupGate Apply", () => {
  test("applies the top trusted model the server serves", async () => {
    localStorage.clear();
    mocks.getEdge.mockResolvedValue({ configured: false });
    mocks.testEdge.mockResolvedValue({ status: "ok", models: ["Qwen3-Coder-Next", "Qwen3.8-Flash-Next"] });
    mocks.getPrimaryBundleCapability.mockResolvedValue({
      supported_bundles: [{ bundle_id: "edge-coder", backend: "edge", chat_model_label: "Qwen3-Coder-Next" }],
      primary_edge_config_matches: true,
      edge_model_selection_fingerprint: "selection-coder",
      primary_bundle: { backend: "edge", bundle_id: "edge-coder", state: "ready" },
    });

    const { host, ready } = await renderGate();
    const urlField = host.querySelector('input[placeholder="edge.server_url_placeholder"]') as HTMLInputElement;
    fireEvent.input(urlField, { target: { value: "https://edge.example/v1" } });
    fireEvent.submit(urlField.closest("form") as HTMLFormElement);

    await waitFor(() => expect(ready).toHaveBeenCalledOnce());
    expect(mocks.putEdge).toHaveBeenCalledWith(expect.objectContaining({ model_name: "Qwen3-Coder-Next" }));
  });
});

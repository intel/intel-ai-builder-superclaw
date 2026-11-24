/**
 * The llama.cpp model picker shows the selected Bundle's chat-model warnings as
 * an icon beside the dropdown, with the caveats on hover.
 *
 * Needs a DOM (Portal and hover handlers), so it runs in the vitest lane.
 */
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, test } from "vitest";
import type { PrimaryBundleCapability } from "@different-ai/openwork-contracts/capability";

import LocalModelConfig from "./local-model-config";
import type { LlmRouterClient } from "../lib/llmrouter-client";
import { setEdgeDegraded } from "~/shared/platform/capability/edge-degraded-signal";

afterEach(cleanup);

const BELOW_DEFAULT_TEXT =
  "Experimental: this model scores below the recommended default in our benchmarks and has had limited testing.";

const capabilityRecommending = (bundleId: string): PrimaryBundleCapability =>
  ({
    recommended_bundle_id: bundleId,
    primary_bundle: null,
    supported_bundles: [
      { bundle_id: "local-4b", backend: "llama", display_name: "Qwen3.5 4B" },
      {
        bundle_id: "local-gemma-4e4b",
        backend: "llama",
        display_name: "Gemma 4 E4B IT (Q4_K_M) (Experimental)",
        model_warnings: ["below_default_benchmark_limited_testing"],
      },
    ],
  }) as unknown as PrimaryBundleCapability;

function renderPicker(recommendedBundleId: string) {
  const capability = capabilityRecommending(recommendedBundleId);
  const lrm = {
    getLocalProvider: async () => ({ available_providers: ["llamacpp"] }),
    getPrimaryBundleCapability: async () => capability,
  } as unknown as LlmRouterClient;
  render(() => (
    <LocalModelConfig
      edgeConfigured={false}
      edgeCard={<div />}
      llmRouter={() => lrm}
      capability={() => capability}
    />
  ));
}

describe("LocalModelConfig bundle warning", () => {
  test("a Bundle whose chat model has a warning shows the icon with its caveat on hover", async () => {
    renderPicker("local-gemma-4e4b");

    const icon = await screen.findByTestId("local-model-warning");
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(screen.getByRole("img", { name: BELOW_DEFAULT_TEXT })).toBeTruthy();
    expect(icon.getAttribute("aria-hidden")).toBe("true");

    fireEvent.mouseEnter(icon.closest("[tabindex]") as HTMLElement);
    expect(screen.getByRole("tooltip").textContent).toBe(BELOW_DEFAULT_TEXT);
  });

  test("a Bundle without a warning shows no icon", async () => {
    renderPicker("local-4b");

    await screen.findByText("Qwen3.5 4B");
    expect(screen.queryByTestId("local-model-warning")).toBeNull();
  });
});

describe("LocalModelConfig serving badge with a degraded Edge (#3531)", () => {
  afterEach(() => setEdgeDegraded(null));

  function renderEdgeCommitted() {
    const capability = {
      supported_bundles: [{ bundle_id: "edge-1", backend: "edge", display_name: "Edge" }],
      primary_bundle: { bundle_id: "edge-1", backend: "edge", bundle_revision: 1, state: "ready" },
    } as unknown as PrimaryBundleCapability;
    const lrm = {
      getLocalProvider: async () => ({ available_providers: ["llamacpp"] }),
      getPrimaryBundleCapability: async () => capability,
    } as unknown as LlmRouterClient;
    render(() => (
      <LocalModelConfig edgeConfigured edgeCard={<div />} llmRouter={() => lrm} capability={() => capability} />
    ));
  }

  const edge = { bundleId: "edge-1", reasonCode: null, message: "fetch failed" };

  test("an unreachable Edge server reads as not reachable, never In use", async () => {
    setEdgeDegraded({ ...edge, state: "unreachable", reasonCode: "url_unreachable" });
    renderEdgeCommitted();
    expect(await screen.findByText(/not reachable/)).toBeTruthy();
    expect(screen.queryByText(/In use/)).toBeNull();
  });

  test("a failed Profile read after Edge connected reads as not ready, not unreachable", async () => {
    setEdgeDegraded({ ...edge, state: "unreachable", profileLoadFailed: true });
    renderEdgeCommitted();
    expect(await screen.findByText(/not ready/)).toBeTruthy();
    expect(screen.queryByText(/not reachable/)).toBeNull();
  });
});

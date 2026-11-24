import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, test, vi } from "vitest";

import { RuntimeDisconnectedBanner, blockSendWhileEdgeDegraded, edgeBannerShown } from "./session-disconnected-banner";
import { NativeRecoveryBanner } from "../components/status-banner";
import { pendingModelSection, setPendingModelSection } from "./settings.model-section";
import { registerEdgeRetry, setEdgeDegraded } from "~/shared/platform/capability/edge-degraded-signal";

afterEach(() => {
  cleanup();
  setEdgeDegraded(null);
  setPendingModelSection(null);
});

describe("RuntimeDisconnectedBanner with a degraded Edge (#3531)", () => {
  const unreachable = {
    state: "unreachable" as const,
    bundleId: "edge-1",
    reasonCode: "url_unreachable" as const,
    message: "Can't reach Edge server edge.example: connection failed",
  };

  test("is shown whenever Edge is degraded, even with the runtime connected", () => {
    // A deployment kept from an earlier Profile can start OpenCode with no Profile active.
    expect(edgeBannerShown()).toBe(false);
    setEdgeDegraded(unreachable);
    expect(edgeBannerShown()).toBe(true);
  });

  test("names the Edge server and offers settings and Retry instead of the runtime copy", async () => {
    setEdgeDegraded(unreachable);
    const runtimeRetry = vi.fn();
    const openSettings = vi.fn();
    const edgeRetry = vi.fn();
    const unregister = registerEdgeRetry(edgeRetry);
    render(() => (
      <RuntimeDisconnectedBanner
        connecting={false}
        genericMessage={null}
        onRetry={runtimeRetry}
        onOpenSettings={openSettings}
      />
    ));

    expect(screen.getByText("Edge server unreachable")).toBeTruthy();
    expect(
      screen.getByText(
        "Can't reach Edge server edge.example: connection failed. Fix the server or update the connection in Settings.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("SuperClaw runtime disconnected")).toBeNull();
    expect(screen.queryByRole("button", { name: /disconnect/i })).toBeNull();

    await fireEvent.click(screen.getByRole("button", { name: "Open Edge settings" }));
    expect(openSettings).toHaveBeenCalledTimes(1);
    expect(pendingModelSection()).toBe("local");

    await fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(edgeRetry).toHaveBeenCalledTimes(1);
    expect(runtimeRetry).not.toHaveBeenCalled();
    unregister();
  });

  test("connecting shows progress copy without actions or error styling", () => {
    setEdgeDegraded({ ...unreachable, state: "connecting", reasonCode: null, message: null });
    const view = render(() => (
      <RuntimeDisconnectedBanner connecting={false} genericMessage={null} onRetry={() => {}} />
    ));

    expect(screen.getByText("Connecting to Edge server…")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(view.container.innerHTML).not.toContain("danger");
  });

  test("a failed Profile read after Edge connected says so and keeps its actions", () => {
    setEdgeDegraded({ ...unreachable, reasonCode: null, message: "fetch failed", profileLoadFailed: true });
    render(() => <RuntimeDisconnectedBanner connecting={false} genericMessage={null} onRetry={() => {}} />);
    expect(screen.getByText("Connected to the Edge server, but SuperClaw couldn't load the Profile")).toBeTruthy();
    expect(screen.getByText("fetch failed. Retry to load it again.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open Edge settings" })).toBeTruthy();
  });

  test("the title follows the failure reason", () => {
    const cases = [
      ["invalid_api_key", "Edge server rejected the API key"],
      ["url_unreachable", "Edge server unreachable"],
      ["bundle_incomplete", "Couldn't connect to Edge server"],
      [null, "Couldn't connect to Edge server"],
    ] as const;
    for (const [reasonCode, title] of cases) {
      setEdgeDegraded({ ...unreachable, reasonCode });
      render(() => <RuntimeDisconnectedBanner connecting={false} genericMessage={null} onRetry={() => {}} />);
      expect(screen.getByText(title)).toBeTruthy();
      cleanup();
    }
  });

  test("a saved model the server can no longer run is named, not reported as a connection failure (#4066)", () => {
    // model_not_found also covers a missing embedding model, so the text must not claim the chat model is gone.
    setEdgeDegraded({ ...unreachable, reasonCode: "model_not_found", message: "missing model", modelLabel: "Qwen3-Coder-Next" });
    render(() => <RuntimeDisconnectedBanner connecting={false} genericMessage={null} onRetry={() => {}} />);
    expect(screen.getByText("Your saved Edge model is no longer available")).toBeTruthy();
    expect(
      screen.getByText(
        "Qwen3-Coder-Next can no longer be used: the Edge server no longer offers all the models it needs. Open Edge settings to choose another model.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Couldn't connect to Edge server")).toBeNull();
    expect(screen.getByRole("button", { name: "Open Edge settings" })).toBeTruthy();
    cleanup();

    setEdgeDegraded({ ...unreachable, reasonCode: "model_not_found", message: "missing model" });
    render(() => <RuntimeDisconnectedBanner connecting={false} genericMessage={null} onRetry={() => {}} />);
    expect(
      screen.getByText(
        "The model you used before can no longer be used: the Edge server no longer offers all the models it needs. Open Edge settings to choose another model.",
      ),
    ).toBeTruthy();
  });

  test("a send fails legibly only while Edge is degraded and no Profile is active", () => {
    const notify = vi.fn();
    expect(blockSendWhileEdgeDegraded(false, notify)).toBe(false);
    setEdgeDegraded(unreachable);
    expect(blockSendWhileEdgeDegraded(true, notify)).toBe(false);
    expect(notify).not.toHaveBeenCalled();
    expect(blockSendWhileEdgeDegraded(false, notify)).toBe(true);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Connect a model to start"));
  });
});

describe("RuntimeDisconnectedBanner", () => {
  test("preserves generic Retry behavior", async () => {
    const retry = vi.fn();
    render(() => (
      <RuntimeDisconnectedBanner
        connecting={false}
        genericMessage={null}
        onRetry={retry}
      />
    ));

    expect(screen.getByText("SuperClaw runtime disconnected")).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });
});

describe("NativeRecoveryBanner", () => {
  test.each(["debug", "release"])("renders one detailed recovery action in %s mode", async () => {
    const restart = vi.fn();
    render(() => (
      <NativeRecoveryBanner
        recovery={{
          title: "Restart SuperClaw",
          message: "The native backend stopped after repeated restart attempts.",
        }}
        recoveryBusy={false}
        recoveryError={null}
        onRestart={restart}
      />
    ));

    expect(screen.getAllByText("Restart SuperClaw")).toHaveLength(2);
    expect(screen.getByText("The native backend stopped after repeated restart attempts.")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Restart SuperClaw" })).toHaveLength(1);
    await fireEvent.click(screen.getByRole("button", { name: "Restart SuperClaw" }));
    expect(restart).toHaveBeenCalledTimes(1);
  });

  test("shows restart failure details", () => {
    render(() => (
      <NativeRecoveryBanner
        recovery={{ title: "Restart SuperClaw", message: "Backend stopped." }}
        recoveryBusy={false}
        recoveryError="SuperClaw couldn't stop the current backend. Try again."
        onRestart={() => {}}
      />
    ));

    expect(screen.getByText("SuperClaw couldn't stop the current backend. Try again.")).toBeTruthy();
  });
});
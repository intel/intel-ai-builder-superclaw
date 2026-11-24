import { createRoot, createSignal } from "solid-js";
import { beforeEach, describe, expect, test, vi } from "vitest";

import type { CloudModelStatus } from "./session.model-routing";

/**
 * Lives in the vitest lane, not the bun lane: `createModelRouting` is four
 * `createEffect`s plus a `createMemo`, and the bun lane resolves Solid's server
 * build, where an effect never runs and a memo is frozen at its first value.
 * Every assertion below would pass vacuously there.
 *
 * The health probe is imported directly by the controller rather than injected,
 * so it has to be mocked at the module boundary.
 */
type Readiness = { ready: boolean; reason?: CloudModelStatus };

const checkAutoRouterModelsReady =
  vi.fn<(url: string) => Promise<{ cloud: Readiness; local: Readiness }>>();
const getLastAutoRouterDiagnostics = vi.fn<() => string>();

vi.mock("../components/cloud-model-settings", () => ({
  checkAutoRouterModelsReady: (url: string) => checkAutoRouterModelsReady(url),
  getLastAutoRouterDiagnostics: () => getLastAutoRouterDiagnostics(),
}));

const { createModelRouting } = await import("./session.model-routing");

const bothReady = { cloud: { ready: true }, local: { ready: true } };

/** Lets the queued effects and the probe's promise chain settle. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Makes the probe hang until the test releases it, so an in-flight check can be
 * observed rather than inferred. The handle is an object because a bare `let`
 * assigned inside the promise callback narrows to `null` for the caller.
 */
function deferredProbe(): { release: () => void } {
  const gate = { release: () => {} };
  checkAutoRouterModelsReady.mockImplementation(
    () =>
      new Promise((resolve) => {
        gate.release = () => resolve(bothReady);
      }),
  );
  return gate;
}

/** Each call hangs until `release(n)` and then resolves with `results[n]`. */
function scriptedProbes(
  results: Array<{ cloud: Readiness; local: Readiness }>,
): { release: (index: number) => void } {
  const gates: Array<() => void> = [];
  checkAutoRouterModelsReady.mockImplementation(
    () =>
      new Promise((resolve) => {
        const result = results[gates.length] ?? bothReady;
        gates.push(() => resolve(result));
      }),
  );
  return {
    release: (index: number) => {
      const open = gates[index];
      if (!open) throw new Error(`probe ${index} has not started`);
      open();
    },
  };
}

function harness(initial?: {
  model?: { providerID: string; modelID: string };
  hostInfoBaseUrl?: string | null;
  serverUrl?: string | null;
  view?: string;
}) {
  const [model, setModel] = createSignal(
    initial?.model ?? { providerID: "llmrouter", modelID: "auto" },
  );
  const [hostInfoBaseUrl, setHostInfoBaseUrl] = createSignal<string | null>(
    initial?.hostInfoBaseUrl === undefined
      ? "http://127.0.0.1:9000"
      : initial.hostInfoBaseUrl,
  );
  const [serverUrl, setServerUrl] = createSignal<string | null>(
    initial?.serverUrl ?? null,
  );
  const [view, setView] = createSignal(initial?.view ?? "session");
  const [providerIds, setProviderIds] = createSignal<readonly string[]>([
    "anthropic",
  ]);

  let dispose = () => {};
  const routing = createRoot((disposeRoot) => {
    dispose = disposeRoot;
    return createModelRouting({
      selectedModel: model,
      hostInfoBaseUrl,
      serverUrl,
      providerConnectedIds: providerIds,
      view,
    });
  });

  return {
    routing,
    setModel,
    setHostInfoBaseUrl,
    setServerUrl,
    setView,
    setProviderIds,
    dispose,
  };
}

beforeEach(() => {
  checkAutoRouterModelsReady.mockReset();
  checkAutoRouterModelsReady.mockResolvedValue(bothReady);
  getLastAutoRouterDiagnostics.mockReset();
  getLastAutoRouterDiagnostics.mockReturnValue("probe diagnostics");
});

describe("the pre-send gate", () => {
  test("a gated alias with a server URL probes on mount and publishes each verdict", async () => {
    // The whole point of the controller: without this the send handler has no
    // readiness to consult and the blocking popup never clears.
    checkAutoRouterModelsReady.mockResolvedValue({
      cloud: { ready: true },
      local: { ready: false, reason: "unhealthy" },
    });
    const h = harness();

    await settle();

    expect(checkAutoRouterModelsReady).toHaveBeenCalledTimes(1);
    expect(checkAutoRouterModelsReady).toHaveBeenCalledWith("http://127.0.0.1:9000");
    expect(h.routing.cloudStatus()).toBe("ready");
    expect(h.routing.localStatus()).toBe("unhealthy");
    expect(h.routing.diagnostics()).toBe("probe diagnostics");
    h.dispose();
  });

  test("a non-gated provider is ready without a probe at all", async () => {
    // Selecting Anthropic directly must not be gated behind an llmrouter health
    // call, and must not leave the user stuck on "checking".
    const h = harness({
      model: { providerID: "anthropic", modelID: "claude-sonnet-4" },
    });

    await settle();

    expect(checkAutoRouterModelsReady).not.toHaveBeenCalled();
    expect(h.routing.cloudStatus()).toBe("ready");
    expect(h.routing.localStatus()).toBe("ready");
    expect(h.routing.selectedRouterAlias()).toBeNull();
    h.dispose();
  });

  test("an llmrouter alias outside the gated set is not probed", async () => {
    // Only auto / cloud-model / local-model are gated; a specific pinned alias
    // routes without a health check.
    const h = harness({
      model: { providerID: "llmrouter", modelID: "some-pinned-alias" },
    });

    await settle();

    expect(checkAutoRouterModelsReady).not.toHaveBeenCalled();
    expect(h.routing.selectedRouterAlias()).toBe("some-pinned-alias");
    h.dispose();
  });

  test("a gated alias with no server URL stays unverified rather than claiming ready", async () => {
    // Mounting does not probe (there is nothing to probe) and must not fall
    // through to "ready", which would let a send bypass the gate entirely.
    const h = harness({ hostInfoBaseUrl: null, serverUrl: null });

    await settle();

    expect(checkAutoRouterModelsReady).not.toHaveBeenCalled();
    expect(h.routing.cloudStatus()).toBe("checking");
    expect(h.routing.localStatus()).toBe("checking");
    h.dispose();
  });

  test("refreshing with no server URL reports not_configured and says why", async () => {
    // This is the send handler's path: it awaits a refresh before sending, and
    // a packaged build has no console, so the reason has to reach the popup.
    const h = harness({ hostInfoBaseUrl: null, serverUrl: null });
    await settle();

    await h.routing.refresh();

    expect(checkAutoRouterModelsReady).not.toHaveBeenCalled();
    expect(h.routing.cloudStatus()).toBe("not_configured");
    expect(h.routing.localStatus()).toBe("not_configured");
    expect(h.routing.diagnostics()).toContain("llmrouterBaseUrl");
    h.dispose();
  });

  test("a URL that arrives during a no-URL refresh is probed", async () => {
    // A missing URL publishes synchronously. If that refresh still occupies
    // `pending` until the next microtask, the URL effect joins it and the
    // follow-up is never run, so the gate stays not_configured.
    const h = harness({ hostInfoBaseUrl: null, serverUrl: null, view: "dashboard" });
    await settle();
    expect(h.routing.cloudStatus()).toBe("checking");

    const finished = h.routing.refresh();
    h.setHostInfoBaseUrl("http://127.0.0.1:9000");
    await finished;
    await settle();

    expect(checkAutoRouterModelsReady).toHaveBeenCalledTimes(1);
    expect(checkAutoRouterModelsReady).toHaveBeenCalledWith("http://127.0.0.1:9000");
    expect(h.routing.cloudStatus()).toBe("ready");
    expect(h.routing.pendingCheck()).toBeNull();
    h.dispose();
  });

  test("the server URL falls back to the computed URL when host info has none", async () => {
    const h = harness({
      hostInfoBaseUrl: null,
      serverUrl: "http://127.0.0.1:7777",
    });

    await settle();

    expect(h.routing.baseUrl()).toBe("http://127.0.0.1:7777");
    expect(checkAutoRouterModelsReady).toHaveBeenCalledWith("http://127.0.0.1:7777");
    h.dispose();
  });
});

describe("de-duplication", () => {
  test("concurrent refreshes join the in-flight probe instead of racing it", async () => {
    // Two probes in flight means the last to land wins, which may be the stale
    // one. Both callers must observe the same single result.
    const gate = deferredProbe();
    const h = harness();
    await settle();

    expect(checkAutoRouterModelsReady).toHaveBeenCalledTimes(1);
    const first = h.routing.refresh();
    const second = h.routing.refresh();
    expect(h.routing.pendingCheck()).not.toBeNull();

    gate.release();
    await Promise.all([first, second]);

    // Still one: the mount probe. The two explicit refreshes joined it.
    expect(checkAutoRouterModelsReady).toHaveBeenCalledTimes(1);
    expect(h.routing.pendingCheck()).toBeNull();
    h.dispose();
  });

  test("returning to the session during an in-flight probe queues one follow-up", async () => {
    // The reported case: the provider list and the URL do not change. The poll
    // started on the session view, and the view is "session" again on return,
    // so joining on equal inputs would drop this refresh.
    const notConfigured = {
      cloud: { ready: false, reason: "not_configured" as const },
      local: { ready: false, reason: "not_configured" as const },
    };
    const probes = scriptedProbes([notConfigured, bothReady]);
    const h = harness();
    await settle();
    expect(checkAutoRouterModelsReady).toHaveBeenCalledTimes(1);

    h.setView("dashboard");
    await settle();
    expect(checkAutoRouterModelsReady).toHaveBeenCalledTimes(1);

    h.setView("session");
    await settle();
    expect(checkAutoRouterModelsReady).toHaveBeenCalledTimes(1);

    probes.release(0);
    await settle();
    expect(checkAutoRouterModelsReady).toHaveBeenCalledTimes(2);
    expect(h.routing.cloudStatus()).toBe("checking");

    probes.release(1);
    await settle();
    expect(h.routing.cloudStatus()).toBe("ready");
    expect(h.routing.localStatus()).toBe("ready");
    expect(checkAutoRouterModelsReady).toHaveBeenCalledTimes(2);
    expect(h.routing.pendingCheck()).toBeNull();
    h.dispose();
  });

  test("a routing change during an in-flight probe queues one follow-up", async () => {
    // The in-flight probe (mount, or the 60s poll) snapshotted the pre-change
    // world. Connecting a provider and returning to the session while it is
    // running must still publish the post-change verdict, and those triggers
    // must share one follow-up rather than each starting a probe.
    const notConfigured = {
      cloud: { ready: false, reason: "not_configured" as const },
      local: { ready: false, reason: "not_configured" as const },
    };
    const probes = scriptedProbes([notConfigured, bothReady]);
    const h = harness();
    await settle();
    expect(checkAutoRouterModelsReady).toHaveBeenCalledTimes(1);
    expect(checkAutoRouterModelsReady).toHaveBeenCalledWith("http://127.0.0.1:9000");

    h.setHostInfoBaseUrl("http://127.0.0.1:9999");
    h.setProviderIds(["anthropic", "openai"]);
    h.setView("dashboard");
    h.setView("session");
    await settle();
    expect(checkAutoRouterModelsReady).toHaveBeenCalledTimes(1);

    const waiter = h.routing.refresh();
    probes.release(0);
    await settle();

    expect(checkAutoRouterModelsReady).toHaveBeenCalledTimes(2);
    expect(checkAutoRouterModelsReady).toHaveBeenLastCalledWith(
      "http://127.0.0.1:9999",
    );
    // The snapshotted not_configured must not land while the follow-up is open.
    expect(h.routing.cloudStatus()).toBe("checking");

    probes.release(1);
    await waiter;
    expect(h.routing.cloudStatus()).toBe("ready");
    expect(h.routing.localStatus()).toBe("ready");
    expect(checkAutoRouterModelsReady).toHaveBeenCalledTimes(2);
    expect(h.routing.pendingCheck()).toBeNull();
    h.dispose();
  });

  test("a routing change during the follow-up is picked up once, then stops", async () => {
    // Triggers that land together share one follow-up. A trigger that lands
    // after that follow-up has snapshotted its own inputs needs one more
    // probe, and then the chain stops.
    const notConfigured = {
      cloud: { ready: false, reason: "not_configured" as const },
      local: { ready: false, reason: "not_configured" as const },
    };
    const probes = scriptedProbes([notConfigured, notConfigured, bothReady]);
    const h = harness();
    await settle();

    h.setProviderIds(["anthropic", "openai"]);
    await settle();
    expect(checkAutoRouterModelsReady).toHaveBeenCalledTimes(1);

    probes.release(0);
    await settle();
    expect(checkAutoRouterModelsReady).toHaveBeenCalledTimes(2);

    h.setProviderIds(["anthropic", "openai", "google"]);
    await settle();
    expect(checkAutoRouterModelsReady).toHaveBeenCalledTimes(2);

    probes.release(1);
    await settle();
    expect(checkAutoRouterModelsReady).toHaveBeenCalledTimes(3);
    expect(h.routing.cloudStatus()).toBe("checking");

    probes.release(2);
    await settle();
    expect(h.routing.cloudStatus()).toBe("ready");
    expect(checkAutoRouterModelsReady).toHaveBeenCalledTimes(3);
    expect(h.routing.pendingCheck()).toBeNull();
    h.dispose();
  });

  test("a URL change queued as the probe settles is not dropped", async () => {
    // The probe continuation publishes and leaves the loop in one microtask.
    // `pending` used to stay set until the outer await resumed, so a URL
    // update queued behind that continuation joined a finished loop.
    const notConfigured = {
      cloud: { ready: false, reason: "not_configured" as const },
      local: { ready: false, reason: "not_configured" as const },
    };
    const probes = scriptedProbes([notConfigured, bothReady]);
    const h = harness();
    await settle();
    expect(checkAutoRouterModelsReady).toHaveBeenCalledTimes(1);

    probes.release(0);
    queueMicrotask(() => h.setHostInfoBaseUrl("http://127.0.0.1:9999"));
    await settle();

    expect(checkAutoRouterModelsReady).toHaveBeenCalledTimes(2);
    expect(checkAutoRouterModelsReady).toHaveBeenLastCalledWith(
      "http://127.0.0.1:9999",
    );
    expect(h.routing.cloudStatus()).toBe("not_configured");

    probes.release(1);
    await settle();
    expect(h.routing.cloudStatus()).toBe("ready");
    expect(h.routing.pendingCheck()).toBeNull();
    h.dispose();
  });

  test("a refresh does not blank a cached verdict while it is in flight", async () => {
    // The send handler reads the cached status synchronously; resetting to
    // "checking" here would make a ready model look unverified and pop the
    // dialog on a send that should have gone straight through.
    const h = harness();
    await settle();
    expect(h.routing.cloudStatus()).toBe("ready");

    const gate = deferredProbe();
    const pending = h.routing.refresh();

    expect(h.routing.cloudStatus()).toBe("ready");

    gate.release();
    await pending;
    h.dispose();
  });
});

describe("re-check triggers", () => {
  test("changing the server URL re-probes against the new one", async () => {
    const h = harness();
    await settle();
    expect(checkAutoRouterModelsReady).toHaveBeenCalledTimes(1);

    h.setHostInfoBaseUrl("http://127.0.0.1:9999");
    await settle();

    expect(checkAutoRouterModelsReady).toHaveBeenCalledTimes(2);
    expect(checkAutoRouterModelsReady).toHaveBeenLastCalledWith(
      "http://127.0.0.1:9999",
    );
    h.dispose();
  });

  test("connecting a provider re-probes, but mounting does not double-probe", async () => {
    // The effect is deferred precisely so the initial read is not a second
    // probe on top of the mount one.
    const h = harness();
    await settle();
    expect(checkAutoRouterModelsReady).toHaveBeenCalledTimes(1);

    h.setProviderIds(["anthropic", "openai"]);
    await settle();

    expect(checkAutoRouterModelsReady).toHaveBeenCalledTimes(2);
    h.dispose();
  });

  test("returning to the session view re-probes; leaving it does not", async () => {
    // Configuring the cloud model in Settings changes none of the other watched
    // signals, so without this the stale "not_configured" would persist.
    const h = harness({ view: "session" });
    await settle();
    expect(checkAutoRouterModelsReady).toHaveBeenCalledTimes(1);

    h.setView("dashboard");
    await settle();
    expect(checkAutoRouterModelsReady).toHaveBeenCalledTimes(1);

    h.setView("session");
    await settle();
    expect(checkAutoRouterModelsReady).toHaveBeenCalledTimes(2);
    h.dispose();
  });

  test("switching to a non-gated model stops the poll", async () => {
    // The interval lives in a reactive effect so it is torn down with the
    // gating condition; a leaked one keeps probing for the session's life.
    vi.useFakeTimers();
    try {
      const h = harness();
      await vi.advanceTimersByTimeAsync(0);
      expect(checkAutoRouterModelsReady).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(checkAutoRouterModelsReady).toHaveBeenCalledTimes(2);

      h.setModel({ providerID: "anthropic", modelID: "claude-sonnet-4" });
      await vi.advanceTimersByTimeAsync(180_000);

      expect(checkAutoRouterModelsReady).toHaveBeenCalledTimes(2);
      h.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

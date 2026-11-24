import { createRoot, createSignal } from "solid-js";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { createAgentOptions, LOAD_TIMEOUT_MS } from "./session.agent-options";

/**
 * Lives in the vitest lane, not the bun lane: the re-fetch on `agentsVersion`
 * is a `createEffect`, which never runs under the server build the bun lane
 * resolves, and the controller's signals would be frozen there too.
 *
 * The roster filter is a pure import used as-is; only the agent list and the
 * clock are faked, both of which arrive as injected deps.
 */
/** The controller is generic over { name: string }, so no SDK shape is needed. */
type TestAgent = { name: string };
const agent = (name: string): TestAgent => ({ name });

/** The cutoff that used to discard a live cold start. #3493. */
const OLD_LOAD_TIMEOUT_MS = 8_000;

/** A `listAgents` the test resolves or rejects on demand. */
function deferredAgents() {
  const gate: {
    resolve: (agents: TestAgent[]) => void;
    reject: (error: Error) => void;
  } = { resolve: () => {}, reject: () => {} };
  const listAgents = vi.fn<() => Promise<TestAgent[]>>(
    () =>
      new Promise<TestAgent[]>((resolve, reject) => {
        gate.resolve = resolve;
        gate.reject = reject;
      }),
  );
  return { listAgents, gate };
}

function harness(listAgents: () => Promise<TestAgent[]>) {
  const [agentsVersion, setAgentsVersion] = createSignal(0);
  let dispose = () => {};
  const controller = createRoot((disposeRoot) => {
    dispose = disposeRoot;
    return createAgentOptions({
      listAgents,
      agentsVersion,
      connectionKey: () => null,
      capabilityActive: () => true,
      isAgentAllowed: () => true,
      productProfileId: () => "pro",
    });
  });
  return { controller, setAgentsVersion, dispose };
}

beforeEach(() => {
  vi.useRealTimers();
});

describe("the load timeout", () => {
  test("a cold start that outlasts the old 8s window still loads", async () => {
    // #3493: the picker raced `app.agents()` against 8s and, on a slow cold
    // start after `/instance/dispose`, showed "Click to retry" while the
    // request was still in flight. The ceiling has to sit past that window.
    expect(LOAD_TIMEOUT_MS).toBeGreaterThan(OLD_LOAD_TIMEOUT_MS);
    vi.useFakeTimers();
    const { listAgents, gate } = deferredAgents();
    const h = harness(listAgents);

    const pending = h.controller.load();
    await vi.advanceTimersByTimeAsync(OLD_LOAD_TIMEOUT_MS);

    expect(h.controller.busy()).toBe(true);
    expect(h.controller.error()).toBeNull();

    gate.resolve([agent("my-custom-agent")]);
    await pending;

    expect(h.controller.error()).toBeNull();
    expect(h.controller.ready()).toBe(true);
    expect(h.controller.options().map((a) => a.name)).toEqual(["my-custom-agent"]);
    h.dispose();
  });

  test("a transport timeout is shown as the click-to-retry error", async () => {
    const listAgents = vi.fn(async () => {
      throw new Error("Request timed out.");
    });
    const h = harness(listAgents);

    await h.controller.load();

    expect(h.controller.error()).toBe("Loading agents timed out. Click to retry.");
    expect(h.controller.ready()).toBe(false);
    h.dispose();
  });

  test("a result that arrives in time cancels the timer instead of rejecting later", async () => {
    // This is the behaviour change the extraction carries: the losing race arm
    // used to keep the timer alive for the full window, holding the closure and
    // rejecting after the roster had already loaded.
    vi.useFakeTimers();
    const { listAgents, gate } = deferredAgents();
    const h = harness(listAgents);

    const pending = h.controller.load();
    gate.resolve([agent("build")]);
    await pending;

    expect(h.controller.ready()).toBe(true);
    expect(h.controller.error()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);

    // Past the timeout window: a surviving timer would reject here and stamp an
    // error onto a roster that loaded successfully.
    await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS * 2);

    expect(h.controller.error()).toBeNull();
    expect(h.controller.ready()).toBe(true);
    expect(h.controller.options().map((a) => a.name)).toEqual(["build"]);
    h.dispose();
  });

  test("a stalled load times out with a retry-able message and no roster", async () => {
    vi.useFakeTimers();
    const { listAgents } = deferredAgents();
    const h = harness(listAgents);

    const pending = h.controller.load();
    expect(h.controller.busy()).toBe(true);

    await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS);
    await pending;

    expect(h.controller.error()).toBe("Loading agents timed out. Click to retry.");
    expect(h.controller.busy()).toBe(false);
    expect(h.controller.ready()).toBe(false);
    expect(h.controller.options()).toEqual([]);
    h.dispose();
  });

  test("a load that timed out can be retried without forcing", async () => {
    // `ready` stayed false, so the ordinary load path must be allowed through
    // again; otherwise the error message tells the user to click something that
    // does nothing.
    vi.useFakeTimers();
    const first = deferredAgents();
    const h = harness(first.listAgents);

    const timedOut = h.controller.load();
    await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS);
    await timedOut;
    expect(h.controller.error()).not.toBeNull();

    const pending = h.controller.load();
    first.gate.resolve([agent("build"), agent("email-agent")]);
    const retried = await pending;

    expect(first.listAgents).toHaveBeenCalledTimes(2);
    expect(h.controller.error()).toBeNull();
    expect(h.controller.ready()).toBe(true);
    expect(retried.map((a) => a.name)).toEqual(["build", "email-agent"]);
    h.dispose();
  });
});

describe("load guards", () => {
  test("a second load while one is in flight does not fetch again", async () => {
    const { listAgents, gate } = deferredAgents();
    const h = harness(listAgents);

    const first = h.controller.load();
    const second = h.controller.load();
    gate.resolve([agent("build")]);
    await Promise.all([first, second]);

    expect(listAgents).toHaveBeenCalledTimes(1);
    h.dispose();
  });

  test("loading again after success is a no-op unless forced", async () => {
    const { listAgents, gate } = deferredAgents();
    const h = harness(listAgents);

    const first = h.controller.load();
    gate.resolve([agent("build")]);
    await first;

    await h.controller.load();
    expect(listAgents).toHaveBeenCalledTimes(1);

    const forced = h.controller.load(true);
    gate.resolve([agent("build")]);
    await forced;
    expect(listAgents).toHaveBeenCalledTimes(2);
    h.dispose();
  });

  test("an unchanged roster keeps the previous array so the picker does not remount", async () => {
    // The picker's <For> reconciles by object reference: handing back an equal
    // but freshly-built array flickers every row for no reason.
    const { listAgents, gate } = deferredAgents();
    const h = harness(listAgents);

    const first = h.controller.load();
    gate.resolve([agent("build")]);
    await first;
    const before = h.controller.options();

    const forced = h.controller.load(true);
    gate.resolve([agent("build")]);
    const after = await forced;

    expect(after).toBe(before);

    const changed = h.controller.load(true);
    gate.resolve([agent("build"), agent("hybrid-deep-research")]);
    expect(await changed).not.toBe(before);
    h.dispose();
  });

  test("a failing load surfaces the error message and empties the roster", async () => {
    const { listAgents, gate } = deferredAgents();
    const h = harness(listAgents);

    const pending = h.controller.load();
    gate.reject(new Error("backend unreachable"));
    await pending;

    expect(h.controller.error()).toBe("backend unreachable");
    expect(h.controller.options()).toEqual([]);
    expect(h.controller.busy()).toBe(false);
    h.dispose();
  });
});

describe("the agentsVersion re-fetch", () => {
  test("a bump after the roster is loaded forces a re-fetch", async () => {
    // Creating an agent bumps the version; without this the new agent is
    // missing from the picker until the view remounts.
    const { listAgents, gate } = deferredAgents();
    const h = harness(listAgents);

    const first = h.controller.load();
    gate.resolve([agent("build")]);
    await first;
    expect(listAgents).toHaveBeenCalledTimes(1);

    h.setAgentsVersion(1);
    gate.resolve([agent("build"), agent("email-agent")]);
    await Promise.resolve();
    await Promise.resolve();

    expect(listAgents).toHaveBeenCalledTimes(2);
    h.dispose();
  });

  describe("the product profile re-fetch", () => {
    test("refreshes an already loaded roster when the active profile changes", async () => {
      const [profileId, setProfileId] = createSignal<"lite" | "pro">("lite");
      const listAgents = vi.fn(async () => [agent("build"), agent("email-agent")]);
      let dispose = () => {};
      const controller = createRoot((disposeRoot) => {
        dispose = disposeRoot;
        return createAgentOptions({
          listAgents,
          agentsVersion: () => 0,
          connectionKey: () => null,
          capabilityActive: () => true,
          isAgentAllowed: () => true,
          productProfileId: profileId,
        });
      });

      await controller.load();
      expect(controller.options().map((a) => a.name)).toEqual(["email-agent"]);

      setProfileId("pro");
      await Promise.resolve();
      await Promise.resolve();

      expect(listAgents).toHaveBeenCalledTimes(2);
      expect(controller.options().map((a) => a.name)).toEqual([
        "build",
        "email-agent",
      ]);
      dispose();
    });

    test("re-fetches after a profile change during an in-flight load", async () => {
      const [profileId, setProfileId] = createSignal<"lite" | "pro">("lite");
      const { listAgents, gate } = deferredAgents();
      let dispose = () => {};
      const controller = createRoot((disposeRoot) => {
        dispose = disposeRoot;
        return createAgentOptions({
          listAgents,
          agentsVersion: () => 0,
          connectionKey: () => null,
          capabilityActive: () => true,
          isAgentAllowed: () => true,
          productProfileId: profileId,
        });
      });

      const pending = controller.load();
      setProfileId("pro");
      await Promise.resolve();
      gate.resolve([agent("plan")]);
      await pending;
      await Promise.resolve();

      expect(listAgents).toHaveBeenCalledTimes(2);
      gate.resolve([agent("build"), agent("email-agent")]);
      await Promise.resolve();
      await Promise.resolve();
      expect(controller.options().map((a) => a.name)).toEqual([
        "build",
        "email-agent",
      ]);
      dispose();
    });

    test("hides Pro agents during a Lite refresh and after it fails", async () => {
      const [profileId, setProfileId] = createSignal<"lite" | "pro">("pro");
      const { listAgents, gate } = deferredAgents();
      let dispose = () => {};
      const controller = createRoot((disposeRoot) => {
        dispose = disposeRoot;
        return createAgentOptions({
          listAgents,
          agentsVersion: () => 0,
          connectionKey: () => null,
          capabilityActive: () => true,
          isAgentAllowed: (name) =>
            profileId() === "pro" || name === "my-workspace-agent",
          productProfileId: profileId,
        });
      });

      const initial = controller.load();
      gate.resolve([
        agent("build"),
        agent("email-agent"),
        agent("my-workspace-agent"),
      ]);
      await initial;
      expect(controller.options().map((a) => a.name)).toEqual([
        "build",
        "email-agent",
        "my-workspace-agent",
      ]);

      setProfileId("lite");
      await Promise.resolve();
      expect(controller.options().map((a) => a.name)).toEqual([
        "my-workspace-agent",
      ]);
      expect(listAgents).toHaveBeenCalledTimes(2);

      gate.reject(new Error("engine restarting"));
      await Promise.resolve();
      await Promise.resolve();
      expect(controller.options().map((a) => a.name)).toEqual([
        "my-workspace-agent",
      ]);
      expect(controller.error()).toBe("engine restarting");
      dispose();
    });

    test("filters cached agents when the Profile changes during a pending refresh", async () => {
      const [profileId, setProfileId] = createSignal<"standard" | "pro">("pro");
      const { listAgents, gate } = deferredAgents();
      let dispose = () => {};
      const controller = createRoot((disposeRoot) => {
        dispose = disposeRoot;
        return createAgentOptions({
          listAgents,
          agentsVersion: () => 0,
          connectionKey: () => null,
          capabilityActive: () => true,
          isAgentAllowed: (name) =>
            profileId() === "pro" || name === "my-workspace-agent",
          productProfileId: profileId,
        });
      });

      const initial = controller.load();
      gate.resolve([agent("build"), agent("my-workspace-agent")]);
      await initial;

      const pending = controller.load(true);
      setProfileId("standard");
      await Promise.resolve();
      expect(controller.options().map((a) => a.name)).toEqual([
        "my-workspace-agent",
      ]);

      gate.reject(new Error("engine restarting"));
      await pending;
      await Promise.resolve();
      expect(controller.options().map((a) => a.name)).toEqual([
        "my-workspace-agent",
      ]);
      expect(listAgents).toHaveBeenCalledTimes(3);
      gate.reject(new Error("engine restarting"));
      await Promise.resolve();
      await Promise.resolve();
      expect(controller.options().map((a) => a.name)).toEqual([
        "my-workspace-agent",
      ]);
      dispose();
    });
  });

  test("a bump before anything loaded does not fetch", async () => {
    // Nothing is displaying the roster yet, so a fetch here is wasted work on
    // the startup path.
    const { listAgents } = deferredAgents();
    const h = harness(listAgents);

    h.setAgentsVersion(1);
    await Promise.resolve();

    expect(listAgents).not.toHaveBeenCalled();
    h.dispose();
  });

  test("mounting without a connection does not fetch", async () => {
    const { listAgents } = deferredAgents();
    const h = harness(listAgents);

    await Promise.resolve();

    expect(listAgents).not.toHaveBeenCalled();
    expect(h.controller.ready()).toBe(false);
    h.dispose();
  });
});

describe("backend connection refresh", () => {
  test("loads the roster when already connected at mount", async () => {
    const connectedClient = {};
    const listAgents = vi.fn(async () => [agent("build")]);
    let dispose = () => {};
    const controller = createRoot((disposeRoot) => {
      dispose = disposeRoot;
      return createAgentOptions({
        listAgents,
        agentsVersion: () => 0,
        connectionKey: () => connectedClient,
        capabilityActive: () => true,
        isAgentAllowed: () => true,
        productProfileId: () => "pro",
      });
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(listAgents).toHaveBeenCalledTimes(1);
    expect(controller.options().map((a) => a.name)).toEqual(["build"]);
    dispose();
  });

  test("loads a roster when the backend connects after mount", async () => {
    const [connected, setConnected] = createSignal<object | null>(null);
    const listAgents = vi.fn(async () => connected() ? [agent("build")] : []);
    let dispose = () => {};
    const controller = createRoot((disposeRoot) => {
      dispose = disposeRoot;
      return createAgentOptions({
        listAgents,
        agentsVersion: () => 0,
        connectionKey: connected,
        capabilityActive: () => true,
        isAgentAllowed: () => true,
        productProfileId: () => "pro",
      });
    });

    await Promise.resolve();
    expect(listAgents).not.toHaveBeenCalled();
    setConnected({});
    await Promise.resolve();
    await Promise.resolve();

    expect(listAgents).toHaveBeenCalledTimes(1);
    expect(controller.options().map((a) => a.name)).toEqual(["build"]);
    dispose();
  });

  test("replaces a cached empty roster when the backend connects", async () => {
    const [connected, setConnected] = createSignal<object | null>(null);
    const listAgents = vi.fn(async () => connected() ? [agent("build")] : []);
    let dispose = () => {};
    const controller = createRoot((disposeRoot) => {
      dispose = disposeRoot;
      return createAgentOptions({
        listAgents,
        agentsVersion: () => 0,
        connectionKey: connected,
        capabilityActive: () => true,
        isAgentAllowed: () => true,
        productProfileId: () => "pro",
      });
    });

    await controller.load();
    expect(controller.options()).toEqual([]);
    expect(controller.ready()).toBe(true);

    setConnected({});
    await Promise.resolve();
    await Promise.resolve();

    expect(listAgents).toHaveBeenCalledTimes(2);
    expect(controller.options().map((a) => a.name)).toEqual(["build"]);
    dispose();
  });

  test("refreshes after connecting while an earlier request is pending", async () => {
    const [connected, setConnected] = createSignal<object | null>(null);
    const { listAgents, gate } = deferredAgents();
    let dispose = () => {};
    const controller = createRoot((disposeRoot) => {
      dispose = disposeRoot;
      return createAgentOptions({
        listAgents,
        agentsVersion: () => 0,
        connectionKey: connected,
        capabilityActive: () => true,
        isAgentAllowed: () => true,
        productProfileId: () => "pro",
      });
    });

    const pending = controller.load();
    setConnected({});
    await Promise.resolve();
    gate.resolve([]);
    await pending;
    await Promise.resolve();

    expect(listAgents).toHaveBeenCalledTimes(2);
    gate.resolve([agent("build")]);
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.options().map((a) => a.name)).toEqual(["build"]);
    dispose();
  });

  test("switching connected workspaces clears old agents and loads the new roster", async () => {
    const workspaceA = {};
    const workspaceB = {};
    const [connectionKey, setConnectionKey] = createSignal<object | null>(workspaceA);
    const listAgents = vi.fn(async () =>
      connectionKey() === workspaceA ? [agent("workspace-a-agent")] : [agent("workspace-b-agent")],
    );
    let dispose = () => {};
    const controller = createRoot((disposeRoot) => {
      dispose = disposeRoot;
      return createAgentOptions({
        listAgents,
        agentsVersion: () => 0,
        connectionKey,
        capabilityActive: () => true,
        isAgentAllowed: () => true,
        productProfileId: () => "pro",
      });
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(controller.options().map((a) => a.name)).toEqual(["workspace-a-agent"]);

    setConnectionKey(workspaceB);
    await Promise.resolve();
    expect(controller.options()).toEqual([]);
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.options().map((a) => a.name)).toEqual(["workspace-b-agent"]);
    expect(listAgents).toHaveBeenCalledTimes(2);
    dispose();
  });

  test("discards a pending roster from the previous workspace", async () => {
    const [connectionKey, setConnectionKey] = createSignal<object | null>({});
    const { listAgents, gate } = deferredAgents();
    let dispose = () => {};
    const controller = createRoot((disposeRoot) => {
      dispose = disposeRoot;
      return createAgentOptions({
        listAgents,
        agentsVersion: () => 0,
        connectionKey,
        capabilityActive: () => true,
        isAgentAllowed: () => true,
        productProfileId: () => "pro",
      });
    });

    await Promise.resolve();
    expect(listAgents).toHaveBeenCalledTimes(1);
    setConnectionKey({});
    await Promise.resolve();
    gate.resolve([agent("old-agent")]);
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.options()).toEqual([]);
    expect(listAgents).toHaveBeenCalledTimes(2);

    gate.resolve([agent("new-agent")]);
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.options().map((a) => a.name)).toEqual(["new-agent"]);
    dispose();
  });
});

describe("refresh during an engine reload", () => {
  test("keeps the last successful roster and reports refresh errors", async () => {
    const { listAgents, gate } = deferredAgents();
    const h = harness(listAgents);
    const initial = h.controller.load();
    gate.resolve([agent("build")]);
    await initial;

    const refreshing = h.controller.load(true);
    gate.reject(new Error("engine restarting"));
    await refreshing;

    expect(h.controller.options().map((a) => a.name)).toEqual(["build"]);
    expect(h.controller.error()).toBe("engine restarting");
    expect(h.controller.ready()).toBe(true);
    h.dispose();
  });

  test("queues a version change while a refresh is pending", async () => {
    const { listAgents, gate } = deferredAgents();
    const h = harness(listAgents);
    const initial = h.controller.load();
    gate.resolve([agent("build")]);
    await initial;

    const refreshing = h.controller.load(true);
    h.setAgentsVersion(1);
    await Promise.resolve();
    gate.reject(new Error("engine restarting"));
    await refreshing;
    await Promise.resolve();
    expect(listAgents).toHaveBeenCalledTimes(3);
    expect(h.controller.options().map((a) => a.name)).toEqual(["build"]);

    gate.resolve([agent("build"), agent("email-agent")]);
    await Promise.resolve();
    await Promise.resolve();
    expect(h.controller.options().map((a) => a.name)).toEqual(["build", "email-agent"]);
    expect(h.controller.error()).toBeNull();
    h.dispose();
  });
});

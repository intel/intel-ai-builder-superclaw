import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRoot } from "solid-js";
import { beforeEach, describe, expect, test, vi } from "vitest";

import {
  createColdRestartController,
  nextNativeRecoveryPresentation,
  restartAfterServiceHubStop,
} from "./native-backend-recovery";

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function harness() {
  const events: string[] = [];
  const stopServiceHub = vi.fn(async () => {
    events.push("stop");
  });
  const restartApp = vi.fn(async () => {
    events.push("restart");
  });
  const logError = vi.fn();
  let dispose = () => {};
  const controller = createRoot((cleanup) => {
    dispose = cleanup;
    return createColdRestartController({ stopServiceHub, restartApp, logError });
  });
  return { controller, dispose, events, stopServiceHub, restartApp, logError };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("createColdRestartController", () => {
  test("does not read retention preferences or reload the webview directly", () => {
    const source = readFileSync(join(process.cwd(), "src/app/native-backend-recovery.ts"), "utf8");
    expect(source).not.toContain("keepBackendOnExit");
    expect(source).not.toContain("window.location.reload");
  });

  test.each([false, true])("stops before restart without depending on retention=%s", async (_retention) => {
    const h = harness();

    await h.controller.restart();

    expect(h.events).toEqual(["stop", "restart"]);
    h.dispose();
  });

  test("keeps the guard active and joins requests until relaunch completes", async () => {
    const h = harness();
    const gate = deferred();
    h.restartApp.mockImplementation(async () => {
      h.events.push("restart");
      await gate.promise;
    });

    const first = h.controller.restart();
    await Promise.resolve();
    const second = h.controller.restart();

    expect(second).toBe(first);
    expect(h.controller.busy()).toBe(true);
    expect(h.stopServiceHub).toHaveBeenCalledTimes(1);
    expect(h.restartApp).toHaveBeenCalledTimes(1);
    gate.resolve();
    await first;
    expect(h.controller.busy()).toBe(false);
    h.dispose();
  });

  test("prevents relaunch and exposes an error when stop fails", async () => {
    const h = harness();
    h.stopServiceHub.mockRejectedValue(new Error("port still live"));

    await h.controller.restart();

    expect(h.restartApp).not.toHaveBeenCalled();
    expect(h.controller.error()).toBe("SuperClaw couldn't stop the current backend. Try again.");
    expect(h.logError).toHaveBeenCalled();
    h.dispose();
  });

  test("exposes a relaunch failure after releasing the guard", async () => {
    const h = harness();
    h.restartApp.mockRejectedValue(new Error("relaunch refused"));

    await expect(h.controller.restart()).resolves.toBeUndefined();

    expect(h.controller.error()).toBe("SuperClaw couldn't restart. Try again.");
    expect(h.controller.busy()).toBe(false);
    expect(h.logError).toHaveBeenCalled();
    h.dispose();
  });
});

describe("restartAfterServiceHubStop", () => {
  test.each([
    { development: true, expected: ["start", "restart"] },
    { development: false, expected: ["restart"] },
  ])("uses the required backend restart sequence when development=$development", async ({
    development,
    expected,
  }) => {
    const events: string[] = [];

    await restartAfterServiceHubStop({
      development,
      restartServiceHub: async () => {
        events.push("start");
      },
      restartApp: async () => {
        events.push("restart");
      },
    });

    expect(events).toEqual(expected);
  });
});

describe("nextNativeRecoveryPresentation", () => {
  const recovery = {
    title: "Restart SuperClaw",
    message: "The native backend stopped after repeated restart attempts.",
  };

  test("preserves recovery and its retry error after relaunch fails and polling is unavailable", async () => {
    const h = harness();
    h.restartApp.mockRejectedValue(new Error("relaunch refused"));

    await h.controller.restart();
    const presentation = nextNativeRecoveryPresentation(recovery, {
      status: "unavailable",
    });

    expect(presentation).toBe(recovery);
    expect(h.controller.error()).toBe("SuperClaw couldn't restart. Try again.");
    h.dispose();
  });

  test("clears recovery only after a successful non-recovery response", () => {
    expect(nextNativeRecoveryPresentation(recovery, {
      status: "available",
      recovery: null,
    })).toBeNull();
  });
});
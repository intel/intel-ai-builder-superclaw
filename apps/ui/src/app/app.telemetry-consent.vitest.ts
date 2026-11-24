import { createRoot } from "solid-js";
import { beforeEach, describe, expect, test, vi } from "vitest";

import type { AppPrefs, AppPrefsUserPatch } from "./lib/tauri";
import { DEFAULT_APP_PREFS } from "./telemetry-consent-policy";

/**
 * Lives in the vitest lane, not the bun lane: `createTelemetryConsent` owns
 * signals, and the bun lane runs Solid's server build where reactivity is
 * inert.
 *
 * The backend stop and the runtime check arrive as injected deps, so they are
 * plain stubs rather than module mocks; only the logger still has to be mocked
 * at the module boundary, because the controller imports it directly.
 */
const stopBackend = vi.fn<() => Promise<void>>();
const isTauriRuntime = vi.fn<() => boolean>();
const uiLogError = vi.fn();

vi.mock("./lib/log", () => ({ uiLogError: (...a: unknown[]) => uiLogError(...a) }));

const { createTelemetryConsent } = await import("./app.telemetry-consent");

type Prefs = AppPrefs;

/** Builds a controller over mutable prefs, exposing the knobs each test bends. */
function harness(initial: Partial<Prefs> = {}) {
  let prefs: Prefs = {
    ...DEFAULT_APP_PREFS,
    // Both flags start off, so a test asserting a flip is not reading a default.
    fullTelemetryEnabled: false,
    baselineTelemetryEnabled: false,
    ...initial,
  };
  let writeTail: Promise<void> = Promise.resolve();
  const persist = vi.fn<(patch: AppPrefsUserPatch) => Promise<void>>();
  const restartApp = vi.fn<() => Promise<void>>(() => Promise.resolve());

  persist.mockImplementation((patch) => {
    prefs = { ...prefs, ...patch };
    return Promise.resolve();
  });

  let dispose = () => {};
  const consent = createRoot((d) => {
    dispose = d;
    return createTelemetryConsent({
      appPrefs: () => prefs,
      setAppPrefs: (updater) => {
        prefs = updater(prefs);
      },
      persistAppPrefs: persist,
      appPrefsReady: Promise.resolve(),
      appPrefsWriteTail: () => writeTail,
      isTauriRuntime,
      stopBackend,
      restartApp,
    });
  });

  return {
    consent,
    persist,
    restartApp,
    dispose,
    readPrefs: () => prefs,
    /** Stands in for anything outside the controller writing prefs. */
    applyPatch: (patch: AppPrefsUserPatch) => {
      prefs = { ...prefs, ...patch };
    },
    setWriteTail: (p: Promise<void>) => {
      writeTail = p;
    },
  };
}

beforeEach(() => {
  stopBackend.mockReset().mockResolvedValue(undefined);
  isTauriRuntime.mockReset().mockReturnValue(true);
  uiLogError.mockReset();
});

describe("telemetry flags", () => {
  test("reads each flag straight off prefs", () => {
    const h = harness({ fullTelemetryEnabled: true });
    expect(h.consent.fullEnabled()).toBe(true);
    expect(h.consent.baselineEnabled()).toBe(false);
    h.dispose();
  });

  test("persists only the flag that changed", async () => {
    const h = harness();
    h.consent.setFullEnabled(true);
    expect(h.persist).toHaveBeenCalledWith({ fullTelemetryEnabled: true });

    h.consent.setBaselineEnabled(true);
    expect(h.persist).toHaveBeenCalledWith({ baselineTelemetryEnabled: true });
    h.dispose();
  });

  test("raises the restart hint once an enabling write lands", async () => {
    const h = harness();
    expect(h.consent.restartHint()).toBe(false);

    h.consent.setFullEnabled(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(h.consent.restartHint()).toBe(true);
    h.dispose();
  });

  test("clears both error flags when a change starts", async () => {
    const h = harness();
    h.consent.setWriteError(true);
    h.consent.setRestartError(true);

    h.consent.setFullEnabled(true);

    expect(h.consent.writeError()).toBe(false);
    expect(h.consent.restartError()).toBe(false);
    h.dispose();
  });

  test("rolls the flag back and reports when the write rejects", async () => {
    const h = harness();
    h.persist.mockImplementation((patch) => {
      // The UI has already moved; the write is what fails.
      Object.assign(h.readPrefs(), patch);
      return Promise.reject(new Error("disk full"));
    });

    h.consent.setFullEnabled(true);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(h.consent.writeError()).toBe(true);
    expect(h.consent.restartHint()).toBe(false);
    expect(h.readPrefs().fullTelemetryEnabled).toBe(false);
    h.dispose();
  });

  test("leaves a flag alone if something else changed it before the rollback", async () => {
    const h = harness();
    // Apply before rejecting, the way the real bridge does: a rollback is only
    // reachable once the requested value is actually in place.
    h.persist.mockImplementation((patch) => {
      h.applyPatch(patch);
      return Promise.reject(new Error("nope"));
    });

    h.consent.setFullEnabled(true);
    expect(h.readPrefs().fullTelemetryEnabled).toBe(true);

    // Something else puts the flag back before the rejection lands.
    h.applyPatch({ fullTelemetryEnabled: false });
    const afterExternalChange = h.readPrefs();

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Identity, not value: `previous` and the externally set value are both
    // `false`, so an unguarded rollback would look right while still writing a
    // fresh object and firing every downstream reaction for nothing.
    expect(h.readPrefs()).toBe(afterExternalChange);
    expect(h.readPrefs().fullTelemetryEnabled).toBe(false);
    expect(h.consent.writeError()).toBe(true);
    h.dispose();
  });
});

describe("confirmRestart", () => {
  test("stops the backend before relaunching", async () => {
    const h = harness();
    await h.consent.confirmRestart();

    expect(stopBackend).toHaveBeenCalledTimes(1);
    expect(h.restartApp).toHaveBeenCalledTimes(1);
    expect(h.consent.restartHint()).toBe(false);
    h.dispose();
  });

  test("skips the backend stop outside Tauri", async () => {
    isTauriRuntime.mockReturnValue(false);
    const h = harness();
    await h.consent.confirmRestart();

    expect(stopBackend).not.toHaveBeenCalled();
    expect(h.restartApp).toHaveBeenCalledTimes(1);
    h.dispose();
  });

  test("does not restart when the pending write rejects", async () => {
    const h = harness();
    h.setWriteTail(Promise.reject(new Error("write failed")));

    await h.consent.confirmRestart();

    expect(h.consent.writeError()).toBe(true);
    expect(stopBackend).not.toHaveBeenCalled();
    expect(h.restartApp).not.toHaveBeenCalled();
    h.dispose();
  });

  test("does not restart when the backend will not stop", async () => {
    stopBackend.mockRejectedValue(new Error("still running"));
    const h = harness();

    await h.consent.confirmRestart();

    expect(h.consent.restartError()).toBe(true);
    expect(h.restartApp).not.toHaveBeenCalled();
    h.dispose();
  });

  test("logs, rather than throws, when the relaunch itself fails", async () => {
    const h = harness();
    h.restartApp.mockRejectedValue(new Error("relaunch refused"));

    await expect(h.consent.confirmRestart()).resolves.toBeUndefined();
    await Promise.resolve();

    expect(uiLogError).toHaveBeenCalled();
    h.dispose();
  });

  test("clears the hint before relaunching, so a failed restart is not sticky", async () => {
    const h = harness();
    // The relaunch has to fail for this to mean anything: with it resolving,
    // clearing the hint only on success would pass too.
    h.restartApp.mockRejectedValue(new Error("relaunch refused"));
    h.consent.setRestartHint(true);

    await h.consent.confirmRestart();
    await Promise.resolve();

    expect(h.consent.restartHint()).toBe(false);
    h.dispose();
  });
});

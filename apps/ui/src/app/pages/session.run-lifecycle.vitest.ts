import { batch, createMemo, createRoot, createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { MessageWithParts } from "../types";
import { RUN_ELAPSED_KEY_PREFIX, RUN_TICK_INTERVAL_MS } from "./session.view-tuning";

/**
 * Lives in the vitest lane, not the bun lane: `createRunLifecycle` is signals,
 * memos and four `createEffect`s, and the bun lane resolves Solid's server
 * build where an effect never runs and a memo is frozen at its first value.
 * `session.run-lifecycle.test.ts` covers the one piece that is pure -
 * `stallThresholdsForPhase` - and everything below needs real reactivity.
 *
 * Timers and `Date.now()` are faked together so elapsed time is deterministic;
 * `localStorage` is the happy-dom one this lane provides.
 */
const recordPerfLog = vi.fn();

vi.mock("~/shared/platform/log/perf-log", () => ({
  recordPerfLog: (...args: unknown[]) => recordPerfLog(...args),
}));

const { createRunLifecycle } = await import("./session.run-lifecycle");

const message = (id: string, role: string, partCount = 0): MessageWithParts =>
  ({
    info: { id, role },
    parts: Array.from({ length: partCount }, () => ({ type: "text" })),
  }) as unknown as MessageWithParts;

function harness(initial?: { sessionId?: string | null; developerMode?: boolean }) {
  const [selectedSessionId, setSelectedSessionId] = createSignal<string | null>(
    initial?.sessionId === undefined ? "ses_1" : initial.sessionId,
  );
  const [messages, setMessages] = createSignal<MessageWithParts[]>([]);
  const [sessionStatus, setSessionStatus] = createSignal("idle");
  const [sessionStatusKnown, setSessionStatusKnown] = createSignal(true);
  const [error, setError] = createSignal<unknown>(null);
  const [sessionReadOnly, setSessionReadOnly] = createSignal(false);
  const [lastPromptSent, setLastPromptSent] = createSignal("the last prompt");
  const notify = vi.fn<(message: string) => void>();
  const notifySessionReadOnly = vi.fn<() => void>();
  const retryLastPrompt = vi.fn<() => void>();
  const abortSession = vi.fn<(sessionId: string) => Promise<void>>(() =>
    Promise.resolve(),
  );

  let dispose = () => {};
  const run = createRoot((disposeRoot) => {
    dispose = disposeRoot;
    return createRunLifecycle({
      messages,
      sessionStatus,
      sessionStatusKnown,
      error,
      totalPartCount: () => messages().reduce((n, m) => n + m.parts.length, 0),
      selectedSessionId,
      developerMode: () => initial?.developerMode ?? false,
      debugObservabilityAvailable: () => true,
      renderedMessageCount: () => messages().length,
      hiddenMessageCount: () => 0,
      lastPromptSent,
      sessionReadOnly,
      notify,
      notifySessionReadOnly,
      abortSession,
      retryLastPrompt,
    });
  });

  return {
    run,
    setSelectedSessionId,
    setMessages,
    setSessionStatus,
    setSessionStatusKnown,
    setError,
    setSessionReadOnly,
    setLastPromptSent,
    notify,
    notifySessionReadOnly,
    retryLastPrompt,
    abortSession,
    dispose,
  };
}

/** Lets queued effects and promise chains settle under fake timers. */
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  recordPerfLog.mockClear();
  window.localStorage.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("phase", () => {
  test("an untouched session is idle and shows no indicator", async () => {
    const h = harness();
    await settle();

    expect(h.run.phase()).toBe("idle");
    expect(h.run.showIndicator()).toBe(false);
    expect(h.run.label()).toBe("");
    h.dispose();
  });

  test("starting a run shows Sending until the assistant produces something", async () => {
    const h = harness();
    h.run.start();
    await settle();

    expect(h.run.phase()).toBe("sending");
    expect(h.run.label()).toBe("Sending");
    expect(h.run.showIndicator()).toBe(true);
    expect(h.run.isGenerating()).toBe(true);
    expect(h.run.responseStarted()).toBe(false);
    h.dispose();
  });

  test("a running session with no new output yet reads as Working", async () => {
    const h = harness();
    h.run.start();
    h.setSessionStatus("running");
    await settle();

    expect(h.run.phase()).toBe("thinking");
    expect(h.run.label()).toBe("Working");
    h.dispose();
  });

  test("a new assistant message flips the run to Responding", async () => {
    const h = harness();
    h.setMessages([message("msg_user", "user")]);
    h.run.start();
    h.setSessionStatus("running");
    await settle();
    expect(h.run.phase()).toBe("thinking");

    h.setMessages([message("msg_user", "user"), message("msg_a", "assistant", 1)]);
    await settle();

    expect(h.run.responseStarted()).toBe(true);
    expect(h.run.phase()).toBe("responding");
    expect(h.run.label()).toBe("Responding");
    h.dispose();
  });

  test("more parts on the same assistant message also count as a response", async () => {
    // A retry reuses the message the baseline was captured against, so the
    // part count is the only signal that output has resumed.
    const h = harness();
    h.setMessages([message("msg_a", "assistant", 2)]);
    h.run.start();
    h.setSessionStatus("running");
    await settle();
    expect(h.run.responseStarted()).toBe(false);

    h.setMessages([message("msg_a", "assistant", 3)]);
    await settle();

    expect(h.run.responseStarted()).toBe(true);
    h.dispose();
  });

  test("an error ends generation but keeps the indicator to explain why", async () => {
    const h = harness();
    h.run.start();
    h.setError(new Error("transport died"));
    await settle();

    expect(h.run.phase()).toBe("error");
    expect(h.run.label()).toBe("Run failed");
    expect(h.run.showIndicator()).toBe(true);
    expect(h.run.isGenerating()).toBe(false);
    h.dispose();
  });

  test("starting twice does not restart the clock", async () => {
    // The guard matters because a double-send would otherwise reset elapsed to
    // zero mid-run and lose the real start time.
    const h = harness();
    h.run.start();
    await settle();
    const startedAt = h.run.runStartedAt();

    await vi.advanceTimersByTimeAsync(3_000);
    h.run.start();
    await settle();

    expect(h.run.runStartedAt()).toBe(startedAt);
    h.dispose();
  });
});

describe("completion", () => {
  test("a finished run records its duration against the message it produced", async () => {
    const h = harness();
    h.setMessages([message("msg_user", "user")]);
    h.run.start();
    // The page calls markBegun() from an effect on the status becoming
    // "running"/"retry", never while idle, so the order here matters: marking
    // begun on an idle status is itself a completion and ends the run.
    h.setSessionStatus("running");
    h.run.markBegun();
    await settle();

    await vi.advanceTimersByTimeAsync(4_000);
    h.setMessages([message("msg_user", "user"), message("msg_a", "assistant", 1)]);
    h.setSessionStatus("idle");
    await settle();

    expect(h.run.elapsedByMessageId()["msg_a"]).toBeGreaterThanOrEqual(4_000);
    // And the run state is reset so the next prompt starts clean.
    expect(h.run.runStartedAt()).toBeNull();
    expect(h.run.phase()).toBe("idle");
    h.dispose();
  });

  test("the duration is persisted per session so a reopen still shows it", async () => {
    const h = harness();
    h.run.start();
    h.setSessionStatus("running");
    h.run.markBegun();
    await settle();
    await vi.advanceTimersByTimeAsync(2_000);
    h.setMessages([message("msg_a", "assistant", 1)]);
    h.setSessionStatus("idle");
    await settle();

    const raw = window.localStorage.getItem(`${RUN_ELAPSED_KEY_PREFIX}ses_1`);
    expect(raw).not.toBeNull();
    const stored = JSON.parse(raw ?? "{}") as { d: Record<string, number> };
    expect(stored.d["msg_a"]).toBeGreaterThanOrEqual(2_000);
    h.dispose();
  });

  test("a run that produced no new message does not overwrite the previous time", async () => {
    // Otherwise an empty turn stamps ~0 ms over the time of the answer the user
    // is still looking at.
    const h = harness();
    h.run.loadElapsedByMessageId("ses_1", { msg_a: 9_999 });
    h.setMessages([message("msg_a", "assistant", 1)]);
    h.run.start();
    h.setSessionStatus("running");
    h.run.markBegun();
    await settle();
    h.setSessionStatus("idle");
    await settle();

    expect(h.run.elapsedByMessageId()["msg_a"]).toBe(9_999);
    h.dispose();
  });

  test("a run that never began is not recorded as completing", async () => {
    // `markBegun` is the server acknowledging the prompt; without it an idle
    // status is just the pre-send state.
    const h = harness();
    h.run.start();
    await settle();

    h.setMessages([message("msg_a", "assistant", 1)]);
    await settle();

    expect(h.run.elapsedByMessageId()).toEqual({});
    expect(h.run.runStartedAt()).not.toBeNull();
    h.dispose();
  });

  test("the elapsed label tracks the ticker while a run is in flight", async () => {
    const h = harness();
    h.run.start();
    h.setSessionStatus("running");
    await settle();

    await vi.advanceTimersByTimeAsync(RUN_TICK_INTERVAL_MS * 4);

    expect(h.run.elapsedLabel()).toBe("2.0s");
    h.dispose();
  });
});

describe("cross-session attribution", () => {
  /**
   * Reproduces what `session.tsx` does when the user switches session while a
   * run is in flight: the stored elapsed map for the newly opened session
   * replaces the in-memory one, the message list follows, and the status
   * becomes that session's. The completion effect then fires, because the new
   * session is idle and the old run is still marked begun.
   */
  const switchTo = (
    h: ReturnType<typeof harness>,
    sessionId: string,
    storedMap: Record<string, number>,
    messages: MessageWithParts[],
  ) => {
    h.run.loadElapsedByMessageId(sessionId, storedMap);
    h.setMessages(messages);
    h.setSelectedSessionId(sessionId);
    h.setSessionStatus("idle");
  };

  test("a run completing after a session switch is not recorded against either session", async () => {
    const h = harness();
    h.run.start();
    h.setSessionStatus("running");
    h.run.markBegun();
    await settle();
    await vi.advanceTimersByTimeAsync(5_000);

    switchTo(h, "ses_2", { msg_b: 1_234 }, [message("msg_b", "assistant", 1)]);
    await settle();

    // The new session's map is what it was loaded with - no 5s entry appears on
    // a message this run never produced.
    expect(h.run.elapsedByMessageId()).toEqual({ msg_b: 1_234 });
    // And nothing is persisted. Writing here would stamp the new session's key
    // with this run's duration, which survives a reload.
    expect(
      window.localStorage.getItem(`${RUN_ELAPSED_KEY_PREFIX}ses_2`),
    ).toBeNull();
    expect(
      window.localStorage.getItem(`${RUN_ELAPSED_KEY_PREFIX}ses_1`),
    ).toBeNull();
    h.dispose();
  });

  test("the discarded run still resets, so the next prompt starts clean", async () => {
    // Skipping the reset instead would leave the new session showing a run
    // indicator and a climbing timer for a run that is not its own.
    const h = harness();
    h.run.start();
    h.setSessionStatus("running");
    h.run.markBegun();
    await settle();

    switchTo(h, "ses_2", {}, [message("msg_b", "assistant", 1)]);
    await settle();

    expect(h.run.runStartedAt()).toBeNull();
    expect(h.run.phase()).toBe("idle");
    expect(h.run.showIndicator()).toBe(false);
    h.dispose();
  });

  test("a run never acknowledged by any session is not attributed to a later one", async () => {
    const h = harness({ sessionId: null });
    h.run.start();
    h.setSessionStatus("running");
    h.run.markBegun();
    await settle();
    await vi.advanceTimersByTimeAsync(3_000);

    switchTo(h, "ses_2", {}, [message("msg_b", "assistant", 1)]);
    await settle();

    expect(h.run.elapsedByMessageId()).toEqual({});
    expect(
      window.localStorage.getItem(`${RUN_ELAPSED_KEY_PREFIX}ses_2`),
    ).toBeNull();
    h.dispose();
  });

  test("the first run in a brand-new session is still recorded", async () => {
    // `app.prompt-dispatch` creates the session inside `sendPrompt`, which the
    // page calls after `start()`. There is no id to capture at start time, so
    // the dispatch reports the one it created via `onSessionResolved` -
    // otherwise every new session would lose the duration of its first answer.
    const h = harness({ sessionId: null });
    h.run.start();
    await settle();

    h.setSelectedSessionId("ses_new");
    h.run.adoptSession("ses_new");
    h.setSessionStatus("running");
    h.run.markBegun();
    await settle();
    await vi.advanceTimersByTimeAsync(2_000);
    h.setMessages([message("msg_a", "assistant", 1)]);
    h.setSessionStatus("idle");
    await settle();

    expect(h.run.elapsedByMessageId()["msg_a"]).toBeGreaterThanOrEqual(2_000);
    expect(
      window.localStorage.getItem(`${RUN_ELAPSED_KEY_PREFIX}ses_new`),
    ).not.toBeNull();
    h.dispose();
  });

  test("a later adoptSession does not hand an owned run to another session", async () => {
    // A retry dispatches again while the run is still in flight, so the
    // report can arrive on a run that already has an owner. Re-binding it
    // would reintroduce exactly the bug the ownership guard closes.
    const h = harness();
    h.run.start();
    h.setSessionStatus("running");
    h.run.markBegun();
    await settle();
    await vi.advanceTimersByTimeAsync(5_000);

    h.setSelectedSessionId("ses_2");
    h.setMessages([message("msg_b", "assistant", 1)]);
    h.run.adoptSession("ses_2");
    h.setSessionStatus("idle");
    await settle();

    expect(h.run.elapsedByMessageId()).toEqual({});
    expect(
      window.localStorage.getItem(`${RUN_ELAPSED_KEY_PREFIX}ses_2`),
    ).toBeNull();
    h.dispose();
  });

  test("completing before the page reloads the new session's map leaves that session's history alone", async () => {
    // Effect ordering, not just attribution. The page creates this controller
    // near the top of SessionView, so its completion effect is registered
    // before the session-change effect that calls loadElapsedByMessageId().
    // On a switch both are invalidated and completion runs FIRST, while
    // elapsedByMessageId() still holds the old session's map. Persisting there
    // would write the old map under the new session's key and destroy the
    // history the loader is about to read.
    window.localStorage.setItem(
      `${RUN_ELAPSED_KEY_PREFIX}ses_2`,
      JSON.stringify({ t: Date.now(), d: { msg_old: 7_777 } }),
    );
    const before = window.localStorage.getItem(
      `${RUN_ELAPSED_KEY_PREFIX}ses_2`,
    );

    const h = harness();
    h.run.start();
    h.setSessionStatus("running");
    h.run.markBegun();
    await settle();
    await vi.advanceTimersByTimeAsync(5_000);

    // Deliberately no loadElapsedByMessageId() here: that is the loader the
    // page has not run yet.
    h.setMessages([message("msg_b", "assistant", 1)]);
    h.setSelectedSessionId("ses_2");
    h.setSessionStatus("idle");
    await settle();

    expect(window.localStorage.getItem(`${RUN_ELAPSED_KEY_PREFIX}ses_2`)).toBe(
      before,
    );
    h.dispose();
  });

  test("a run that stays in its own session is still recorded", async () => {
    // The guard compares ids; it must not reject every completion.
    const h = harness();
    h.run.start();
    h.setSessionStatus("running");
    h.run.markBegun();
    await settle();
    await vi.advanceTimersByTimeAsync(2_000);
    h.setMessages([message("msg_a", "assistant", 1)]);
    h.setSessionStatus("idle");
    await settle();

    expect(h.run.elapsedByMessageId()["msg_a"]).toBeGreaterThanOrEqual(2_000);
    expect(
      window.localStorage.getItem(`${RUN_ELAPSED_KEY_PREFIX}ses_1`),
    ).not.toBeNull();
    h.dispose();
  });
});

describe("returning to a running session (#3554)", () => {
  /** Mirrors the page: a running status for the selected session starts and acknowledges the run. */
  const returnTo = (
    h: ReturnType<typeof harness>,
    sessionId: string,
    status: string,
    messages: MessageWithParts[],
  ) => {
    h.setMessages(messages);
    batch(() => {
      h.setSelectedSessionId(sessionId);
      h.setSessionStatus(status);
    });
    if (status === "running") {
      h.run.start();
      h.run.markBegun();
    }
  };

  const leaveRunningSession = async (h: ReturnType<typeof harness>) => {
    h.run.start();
    h.setSessionStatus("running");
    h.run.markBegun();
    await settle();
    await vi.advanceTimersByTimeAsync(60_000);
    h.setSelectedSessionId("ses_2");
    h.setSessionStatus("idle");
    await settle();
  };

  test("the elapsed clock continues instead of restarting at 0ms", async () => {
    const h = harness();
    await leaveRunningSession(h);
    expect(h.run.runStartedAt()).toBeNull();

    await vi.advanceTimersByTimeAsync(30_000);
    returnTo(h, "ses_1", "running", [message("msg_user", "user")]);
    await settle();

    expect(h.run.phase()).not.toBe("idle");
    expect(h.run.elapsedLabel()).toBe("1m 30s");
    h.dispose();
  });

  test("the resumed run still records its duration against the message it produced", async () => {
    const h = harness();
    h.setMessages([message("msg_prev", "assistant", 1)]);
    await leaveRunningSession(h);

    returnTo(h, "ses_1", "running", [
      message("msg_prev", "assistant", 1),
      message("msg_a", "assistant", 1),
    ]);
    await settle();
    await vi.advanceTimersByTimeAsync(5_000);
    h.setSessionStatus("idle");
    await settle();

    expect(h.run.elapsedByMessageId()["msg_a"]).toBeGreaterThanOrEqual(65_000);
    h.dispose();
  });

  test("a run that finished while away does not lend its clock to the next prompt", async () => {
    const h = harness();
    await leaveRunningSession(h);

    await vi.advanceTimersByTimeAsync(120_000);
    returnTo(h, "ses_1", "idle", []);
    await settle();
    h.run.start();
    await settle();

    expect(h.run.elapsedLabel()).toBe("0ms");
    h.dispose();
  });

  test("the switched-to session does not show the parked run", async () => {
    const h = harness();
    await leaveRunningSession(h);

    expect(h.run.runStartedAt()).toBeNull();
    expect(h.run.showIndicator()).toBe(false);
    h.dispose();
  });

  test("a prompt sent elsewhere and abandoned before acknowledgement keeps the parked clock", async () => {
    const h = harness();
    await leaveRunningSession(h);

    // Send in ses_2, then go back to ses_1 before ses_2's run is acknowledged.
    h.run.start();
    await settle();
    batch(() => {
      h.setSelectedSessionId("ses_1");
      h.setSessionStatus("running");
    });
    await settle();
    expect(h.run.runStartedAt()).toBeNull();

    await vi.advanceTimersByTimeAsync(10_000);
    h.run.start();
    h.run.markBegun();
    await settle();

    expect(h.run.elapsedLabel()).toBe("1m 10s");
    h.dispose();
  });

  test("a retry after the parked run finished while away starts a fresh clock", async () => {
    const h = harness();
    await leaveRunningSession(h);

    await vi.advanceTimersByTimeAsync(120_000);
    returnTo(h, "ses_1", "idle", []);
    await settle();

    // Retry dispatches without start(); only the running status is seen, which
    // the page turns into start().
    await vi.advanceTimersByTimeAsync(5_000);
    h.setSessionStatus("running");
    h.run.start();
    h.run.markBegun();
    await settle();

    expect(h.run.elapsedLabel()).toBe("0ms");
    h.dispose();
  });

  test("a status map reset does not drop the parked run before the real status arrives", async () => {
    const h = harness();
    await leaveRunningSession(h);

    // Reconnect / workspace switch clears every status entry; a missing entry
    // reads as "idle" but says nothing about whether the run finished.
    batch(() => {
      h.setSelectedSessionId("ses_1");
      h.setSessionStatusKnown(false);
      h.setSessionStatus("idle");
    });
    await settle();

    await vi.advanceTimersByTimeAsync(10_000);
    batch(() => {
      h.setSessionStatusKnown(true);
      h.setSessionStatus("running");
    });
    h.run.start();
    h.run.markBegun();
    await settle();

    expect(h.run.elapsedLabel()).toBe("1m 10s");
    h.dispose();
  });

  test("a status entry that appears as idle after a missing one still drops the parked run", async () => {
    // Backed by a real Solid store, like the page: the entry being added must be
    // read by index to be tracked, and the derived status stays "idle" across it.
    const [store, setStore] = createStore<{ status: Record<string, string> }>({
      status: { ses_1: "running" },
    });
    const [selected, setSelected] = createSignal<string | null>("ses_1");
    const [messages] = createSignal<MessageWithParts[]>([]);
    let dispose = () => {};
    const run = createRoot((disposeRoot) => {
      dispose = disposeRoot;
      // A memo, as in the page: its equality check hides the missing -> "idle" change.
      const status = createMemo(() => store.status[selected() ?? ""] ?? "idle");
      return createRunLifecycle({
        messages,
        sessionStatus: status,
        sessionStatusKnown: () => store.status[selected() ?? ""] !== undefined,
        error: () => null,
        totalPartCount: () => 0,
        selectedSessionId: selected,
        developerMode: () => false,
        debugObservabilityAvailable: () => true,
        renderedMessageCount: () => 0,
        hiddenMessageCount: () => 0,
        lastPromptSent: () => "the last prompt",
        sessionReadOnly: () => false,
        notify: vi.fn(),
        notifySessionReadOnly: vi.fn(),
        abortSession: () => Promise.resolve(),
        retryLastPrompt: vi.fn(),
      });
    });

    run.start();
    run.markBegun();
    await settle();
    await vi.advanceTimersByTimeAsync(60_000);

    // Away to an idle session: the run is parked.
    batch(() => {
      setStore("status", "ses_2", "idle");
      setSelected("ses_2");
    });
    await settle();
    expect(run.runStartedAt()).toBeNull();

    // Back with no entry for ses_1: reads as idle but is not a real idle.
    batch(() => {
      setStore("status", "ses_1", undefined as never);
      setSelected("ses_1");
    });
    await settle();

    // The real idle arrives; the derived status does not change.
    setStore("status", "ses_1", "idle");
    await settle();

    await vi.advanceTimersByTimeAsync(120_000);
    setStore("status", "ses_1", "running");
    run.start();
    run.markBegun();
    await settle();

    expect(run.elapsedLabel()).toBe("0ms");
    dispose();
  });
});

describe("cancel", () => {
  test("cancelling aborts the session and clears the run state", async () => {
    const h = harness();
    h.run.start();
    h.setSessionStatus("running");
    await settle();

    await h.run.cancel();

    expect(h.abortSession).toHaveBeenCalledWith("ses_1");
    expect(h.run.runStartedAt()).toBeNull();
    expect(h.notify).toHaveBeenCalledWith("Stopped.");
    h.dispose();
  });

  test("a failed abort still clears the run state and reports the reason", async () => {
    // Leaving the indicator spinning after a failed stop is worse than the
    // failure: there is no longer anything to stop.
    const h = harness();
    h.abortSession.mockRejectedValueOnce(new Error("already gone"));
    h.run.start();
    await settle();

    await h.run.cancel();

    expect(h.notify).toHaveBeenCalledWith("already gone");
    expect(h.run.runStartedAt()).toBeNull();
    h.dispose();
  });

  test("cancelling with no session selected says so and aborts nothing", async () => {
    const h = harness({ sessionId: null });
    h.run.start();
    await settle();

    await h.run.cancel();

    expect(h.abortSession).not.toHaveBeenCalled();
    expect(h.notify).toHaveBeenCalledWith("No session selected");
    h.dispose();
  });
});

describe("retry", () => {
  test("a read-only session refuses to retry", async () => {
    // Confirmed subtasks and sessions whose metadata is still loading must not
    // mutate history; this is the backstop for a stale button or a shortcut.
    const h = harness();
    h.setSessionReadOnly(true);
    await settle();

    await h.run.retry();

    expect(h.notifySessionReadOnly).toHaveBeenCalledTimes(1);
    expect(h.retryLastPrompt).not.toHaveBeenCalled();
    h.dispose();
  });

  test("nothing to retry is reported rather than silently ignored", async () => {
    const h = harness();
    h.setLastPromptSent("   ");
    await settle();

    await h.run.retry();

    expect(h.notify).toHaveBeenCalledWith("Nothing to retry yet");
    expect(h.retryLastPrompt).not.toHaveBeenCalled();
    h.dispose();
  });

  test("retrying mid-run aborts the in-flight run first", async () => {
    const h = harness();
    h.run.start();
    h.setSessionStatus("running");
    await settle();

    await h.run.retry();

    expect(h.abortSession).toHaveBeenCalledWith("ses_1");
    expect(h.retryLastPrompt).toHaveBeenCalledTimes(1);
    h.dispose();
  });

  test("a failed abort does not block the retry", async () => {
    // Users care more about forward motion than about a clean stop here.
    const h = harness();
    h.abortSession.mockRejectedValueOnce(new Error("abort failed"));
    h.run.start();
    h.setSessionStatus("running");
    await settle();

    await h.run.retry();

    expect(h.retryLastPrompt).toHaveBeenCalledTimes(1);
    h.dispose();
  });
});

describe("stall telemetry", () => {
  const stallEvents = () =>
    recordPerfLog.mock.calls
      .filter((call) => call[1] === "session.run")
      .map((call) => call[2])
      .filter((event: unknown) => String(event).startsWith("stall"));

  test("a quiet run reports soft then hard, and recovery when output resumes", async () => {
    const h = harness({ developerMode: true });
    h.run.start();
    await settle();

    // "sending" has the impatient thresholds: soft at 8s, hard at 20s.
    await vi.advanceTimersByTimeAsync(9_000);
    expect(stallEvents()).toEqual(["stall-soft"]);

    await vi.advanceTimersByTimeAsync(12_000);
    expect(stallEvents()).toEqual(["stall-soft", "stall-hard"]);

    h.run.noteProgress();
    await vi.advanceTimersByTimeAsync(RUN_TICK_INTERVAL_MS);

    expect(stallEvents()).toEqual(["stall-soft", "stall-hard", "stall-recovered"]);
    h.dispose();
  });

  test("a stall is reported once per stage, not once per tick", async () => {
    const h = harness({ developerMode: true });
    h.run.start();
    await settle();

    await vi.advanceTimersByTimeAsync(9_000);
    await vi.advanceTimersByTimeAsync(3_000);

    expect(stallEvents()).toEqual(["stall-soft"]);
    h.dispose();
  });

  test("nothing is reported with developer mode off", async () => {
    const h = harness({ developerMode: false });
    h.run.start();
    await settle();

    await vi.advanceTimersByTimeAsync(30_000);

    expect(stallEvents()).toEqual([]);
    h.dispose();
  });
});

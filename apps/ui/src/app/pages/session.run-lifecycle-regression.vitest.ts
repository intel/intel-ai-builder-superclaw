/**
 * Regression tests for `createRunLifecycle` — one test per Copilot finding.
 * Kept in a separate file to hold the main vitest file under the 800-line cap.
 * Boilerplate mirrors session.run-lifecycle.vitest.ts intentionally; extracting
 * a shared helper would require either exporting test-only code or a third file.
 */
import { createRoot, createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { MessageWithParts } from "../types";
import { RUN_ELAPSED_KEY_PREFIX } from "./session.view-tuning";

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
    dispose,
  };
}

const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  recordPerfLog.mockClear();
  window.localStorage.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Finding 1 — pre-ack session switch
// ---------------------------------------------------------------------------

describe("regression: pre-ack session switch (Finding 1)", () => {
  test("switching sessions before acknowledgement clears the stale run", async () => {
    // start() sets runSessionId and runStartedAt, but markBegun() has not fired.
    // The completion effect guards on runHasBegun(), so without the pre-ack
    // effect the run would never be cleared and the new session's start() would
    // be blocked by the `if (runStartedAt()) return` guard.
    const h = harness();
    h.run.start();
    await settle();
    expect(h.run.phase()).toBe("sending");

    h.setSelectedSessionId("ses_2");
    h.setSessionStatus("idle");
    await settle();

    expect(h.run.runStartedAt()).toBeNull();
    expect(h.run.phase()).toBe("idle");

    // The new session can now start its own run without being blocked.
    h.run.start();
    await settle();
    expect(h.run.phase()).toBe("sending");

    h.dispose();
  });
});

// ---------------------------------------------------------------------------
// Finding 2 — A→B(running)→A elapsed map corruption
// ---------------------------------------------------------------------------

describe("regression: A→B(running)→A elapsed map corruption (Finding 2)", () => {
  test("completing a run after an A→B→A round trip uses A's persisted map, not B's", async () => {
    // Prime ses_1's localStorage with a pre-existing entry.
    window.localStorage.setItem(
      `${RUN_ELAPSED_KEY_PREFIX}ses_1`,
      JSON.stringify({ t: Date.now(), d: { msg_prev: 9_000 } }),
    );

    const h = harness();
    h.run.start();
    h.setSessionStatus("running");
    h.run.markBegun();
    await settle();
    await vi.advanceTimersByTimeAsync(3_000);

    // Switch to ses_2, which is still running (so the completion effect does
    // not fire). B's map is loaded into the in-memory signal.
    h.run.loadElapsedByMessageId("ses_2", { msg_b: 5_000 });
    h.setSelectedSessionId("ses_2");
    h.setSessionStatus("running");
    await settle();

    // Switch back to ses_1. A new assistant message has appeared and ses_1 is
    // now idle — the completion effect fires and should write A's history.
    h.setMessages([message("msg_a", "assistant", 1)]);
    h.setSelectedSessionId("ses_1");
    h.setSessionStatus("idle");
    await settle();

    const raw = window.localStorage.getItem(`${RUN_ELAPSED_KEY_PREFIX}ses_1`);
    expect(raw).not.toBeNull();
    const stored = JSON.parse(raw ?? "{}") as { d: Record<string, number> };
    // Pre-existing entry preserved.
    expect(stored.d["msg_prev"]).toBe(9_000);
    // This run's elapsed recorded.
    expect(stored.d["msg_a"]).toBeGreaterThanOrEqual(3_000);
    // B's entry must not bleed into A's map.
    expect(stored.d["msg_b"]).toBeUndefined();

    h.dispose();
  });
});

// ---------------------------------------------------------------------------
// Finding 3 — telemetry emitted before ownership check
// ---------------------------------------------------------------------------

describe("regression: telemetry before ownership check (Finding 3)", () => {
  test("completion telemetry is not emitted when the session does not own the run", async () => {
    const h = harness();
    h.run.start();
    h.setSessionStatus("running");
    h.run.markBegun();
    await settle();

    // Switch away while the run is still in flight — ses_2 is idle, which
    // triggers the completion effect. ownsResult is false (ses_1 != ses_2).
    h.setSelectedSessionId("ses_2");
    h.setSessionStatus("idle");
    h.setMessages([message("msg_b", "assistant", 1)]);
    await settle();

    const completeEvents = recordPerfLog.mock.calls.filter(
      (call: unknown[]) => call[1] === "session.run" && call[2] === "complete",
    );
    expect(completeEvents).toHaveLength(0);

    h.dispose();
  });
});

// ---------------------------------------------------------------------------
// Finding 4 — spurious stall-recovered on session switch
// ---------------------------------------------------------------------------

describe("regression: stall-recovered on session switch (Finding 4)", () => {
  const stallEvents = () =>
    recordPerfLog.mock.calls
      .filter((call) => call[1] === "session.run")
      .map((call) => call[2])
      .filter((event: unknown) => String(event).startsWith("stall"));

  test("switching sessions during a pre-ack stall does not emit stall-recovered", async () => {
    // The pre-ack effect clears the run when the session changes; without the
    // lastStallPerfStage reset in clearPending the stall effect would see the
    // soft→none transition and record stall-recovered against ses_2.
    const h = harness({ developerMode: true });
    h.run.start();
    await settle();

    await vi.advanceTimersByTimeAsync(9_000); // past the "sending" soft threshold (8s)
    expect(stallEvents()).toEqual(["stall-soft"]);

    h.setSelectedSessionId("ses_2");
    h.setSessionStatus("idle");
    await settle();

    // Only the original stall-soft; no stall-recovered attributed to ses_2.
    expect(stallEvents()).toEqual(["stall-soft"]);

    h.dispose();
  });

  test("a post-ack stall cleared by a session switch does not emit stall-recovered", async () => {
    // After markBegun the completion effect (not the pre-ack effect) clears the
    // run when the new session is idle. Same lastStallPerfStage corruption risk.
    const h = harness({ developerMode: true });
    h.run.start();
    h.setSessionStatus("running");
    h.run.markBegun();
    await settle();

    await vi.advanceTimersByTimeAsync(26_000); // past "thinking" soft threshold (25s)
    expect(stallEvents()).toEqual(["stall-soft"]);

    // Switch to an idle session — completion effect fires, discards the run.
    h.setSelectedSessionId("ses_2");
    h.setSessionStatus("idle");
    await settle();

    expect(stallEvents()).toEqual(["stall-soft"]);

    h.dispose();
  });
});

// ---------------------------------------------------------------------------
// Stall telemetry for a run nothing owns yet. The guard above compares the
// owner with the selection, and a draft's owner is null until the dispatch
// resolves — so a session selected inside that window must not collect the
// draft's stall events, which stamp the *selected* session's id.
// ---------------------------------------------------------------------------

describe("regression: stall telemetry for an unowned draft run", () => {
  const stallCalls = () =>
    recordPerfLog.mock.calls
      .filter((call) => call[1] === "session.run" && String(call[2]).startsWith("stall"))
      .map((call) => ({
        event: String(call[2]),
        sessionID: (call[3] as { sessionID?: string | null }).sessionID ?? null,
      }));

  test("a session selected mid-dispatch does not collect the draft's stall", async () => {
    const h = harness({ sessionId: null, developerMode: true });
    h.run.start(); // no session exists yet, so the run has no owner
    await settle();

    // The user opens an existing session while the dispatch is in flight. There
    // is no adoptSession() yet, so the run is still unowned.
    h.setSelectedSessionId("ses_2");
    await settle();

    await vi.advanceTimersByTimeAsync(9_000); // past the "sending" soft threshold

    expect(stallCalls()).toEqual([]);

    h.dispose();
  });

  test("a draft with nothing selected still reports its stall", async () => {
    // The complement of the case above: null owner and null selection is a
    // genuine draft, and silencing it would trade one bug for another.
    const h = harness({ sessionId: null, developerMode: true });
    h.run.start();
    await settle();

    await vi.advanceTimersByTimeAsync(9_000);

    expect(stallCalls()).toEqual([{ event: "stall-soft", sessionID: null }]);

    h.dispose();
  });
});

// ---------------------------------------------------------------------------
// Finding A — a draft run must never be attributed to a session it was not
// dispatched to. Ownership comes from `sendPrompt`'s `onSessionResolved`, so
// nothing the user selects during the dispatch can claim the run. The two
// cases below are the idle and running selections; a status-derived owner
// survives the first and fails the second.
// ---------------------------------------------------------------------------

describe("regression: draft-run attribution during dispatch (Finding A)", () => {
  // start() is called while selectedSessionId()=null (the new chat is created
  // inside sendPrompt), then the user selects an existing session before the
  // dispatch reports back. session.tsx's responseStarted()-triggered effect
  // calls markBegun() for whatever is displayed, because that session's own
  // messages make responseStarted() true against the draft's empty baseline.
  for (const selected of ["idle", "running"] as const) {
    test(`a draft run does not adopt a ${selected} session selected mid-dispatch`, async () => {
      const h = harness({ sessionId: null });
      h.run.start(); // runSessionId = null: no id exists yet
      await settle();
      await vi.advanceTimersByTimeAsync(5_000);

      // Deliberately no adoptSession(): the dispatch has not resolved, which
      // is the whole window this finding is about.
      h.setSelectedSessionId("ses_2");
      h.setMessages([message("msg_b", "assistant", 1)]);
      h.setSessionStatus(selected);
      h.run.markBegun();
      await settle();

      // Whether or not the run is still live, ses_2 must not be attributed.
      h.setSessionStatus("idle");
      await settle();

      expect(h.run.elapsedByMessageId()["msg_b"]).toBeUndefined();
      expect(
        window.localStorage.getItem(`${RUN_ELAPSED_KEY_PREFIX}ses_2`),
      ).toBeNull();

      h.dispose();
    });
  }

  test("a draft run is attributed to the session the dispatch created", async () => {
    // The other half of the guard: ownership must still arrive, or every new
    // session loses the duration of its first answer.
    const h = harness({ sessionId: null });
    h.run.start();
    await settle();

    h.setSelectedSessionId("ses_new");
    h.run.adoptSession("ses_new"); // sendPrompt's onSessionResolved
    h.setSessionStatus("running");
    h.run.markBegun();
    await settle();
    await vi.advanceTimersByTimeAsync(3_000);
    h.setMessages([message("msg_a", "assistant", 1)]);
    h.setSessionStatus("idle");
    await settle();

    expect(h.run.elapsedByMessageId()["msg_a"]).toBeGreaterThanOrEqual(3_000);
    expect(
      window.localStorage.getItem(`${RUN_ELAPSED_KEY_PREFIX}ses_new`),
    ).not.toBeNull();

    h.dispose();
  });
});

// ---------------------------------------------------------------------------
// Durations already in memory survive a session whose writes cannot persist
// ---------------------------------------------------------------------------

describe("regression: elapsed history the stored copy does not have", () => {
  test("durations held only in memory survive the next completion", async () => {
    // A session's in-memory map can hold entries the stored copy lacks: every
    // completion writes both, so a `setItem` that failed (a full or disabled
    // store) leaves memory ahead of storage. Basing the write on the stored
    // copy alone would then replace the whole map with just the newest
    // message, and the previous run would lose its label while the user is
    // still looking at it. The map is usable here precisely because it is
    // known to describe this session.
    const h = harness();
    h.run.loadElapsedByMessageId("ses_1", { msg_old: 7_777 });
    expect(
      window.localStorage.getItem(`${RUN_ELAPSED_KEY_PREFIX}ses_1`),
    ).toBeNull();

    h.run.start();
    h.setSessionStatus("running");
    h.run.markBegun();
    await settle();
    await vi.advanceTimersByTimeAsync(2_000);
    h.setMessages([message("msg_b", "assistant", 1)]);
    h.setSessionStatus("idle");
    await settle();

    const map = h.run.elapsedByMessageId();
    expect(map["msg_b"]).toBeGreaterThanOrEqual(2_000);
    expect(map["msg_old"]).toBe(7_777);

    // And the write repairs the stored copy rather than narrowing it.
    const stored = window.localStorage.getItem(
      `${RUN_ELAPSED_KEY_PREFIX}ses_1`,
    );
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored ?? "{}").d["msg_old"]).toBe(7_777);

    h.dispose();
  });
});

// ---------------------------------------------------------------------------
// Finding B — legacy localStorage format overwritten on first upgrade write
// ---------------------------------------------------------------------------

describe("regression: legacy localStorage format on first write after upgrade (Finding B)", () => {
  test("a legacy plain-Record entry is preserved when a new message is recorded", async () => {
    // parseRunElapsedEntry handles both { d, t } and the plain Record format.
    // The completion effect previously used a hand-rolled parse that only
    // accepted { d, t }; on the first completed run after upgrade the baseMap
    // was empty and the entire stored history was replaced with one entry.
    window.localStorage.setItem(
      `${RUN_ELAPSED_KEY_PREFIX}ses_1`,
      // Legacy format: plain Record<string, number>, no { d, t } wrapper.
      JSON.stringify({ msg_old: 8_000 }),
    );

    const h = harness();
    h.run.start();
    h.setSessionStatus("running");
    h.run.markBegun();
    await settle();
    await vi.advanceTimersByTimeAsync(4_000);

    h.setMessages([message("msg_new", "assistant", 1)]);
    h.setSessionStatus("idle");
    await settle();

    const raw = window.localStorage.getItem(`${RUN_ELAPSED_KEY_PREFIX}ses_1`);
    expect(raw).not.toBeNull();
    const stored = JSON.parse(raw ?? "{}") as { d: Record<string, number> };
    // Pre-existing legacy entry must be preserved.
    expect(stored.d["msg_old"]).toBe(8_000);
    // This run's entry must also be present.
    expect(stored.d["msg_new"]).toBeGreaterThanOrEqual(4_000);

    h.dispose();
  });
});


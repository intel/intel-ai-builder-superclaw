import assert from "node:assert/strict";
import { test } from "bun:test";

import { createRunStatus } from "../../dist/run-status.js";

// The ordering rules in run-status.ts were each the fix for a real bug: a slow
// setStatus landing after a clear re-shows the shimmer, and a dropped clear
// leaves "Working on it..." shimmering forever. These tests pin that behaviour.

function makeRun(overrides = {}) {
  return {
    key: "k1",
    directory: "/w",
    sessionID: "s1",
    channel: "slack",
    identityId: "i1",
    adapterKey: "slack:i1",
    // Native status needs a thread: parseSlackPeerId splits channel from threadTs on "|".
    peerId: "C123|168.1",
    peerKey: "C123",
    toolUpdatesEnabled: true,
    seenToolStates: new Map(),
    nativeStatusEligible: true,
    ...overrides,
  };
}

function makeStatus(adapterOverrides = {}, depOverrides = {}) {
  const calls = [];
  const adapter = {
    updateMessage: async (peerId, ts) => {
      calls.push({ op: "updateMessage", peerId, ts });
      return { ts };
    },
    setStatus: async (peerId, threadTs, status) => {
      calls.push({ op: "setStatus", status });
      return { ok: true };
    },
    clearStatus: async () => {
      calls.push({ op: "clearStatus" });
      return { ok: true };
    },
    sendTyping: async () => calls.push({ op: "sendTyping" }),
    ...adapterOverrides,
  };
  const reported = [];
  const deps = {
    adapters: new Map([["slack:i1", adapter]]),
    logger: { warn() {}, info() {}, error() {}, debug() {} },
    deliverParts: async () => ({
      attemptedParts: 1,
      sentParts: 1,
      partResults: [{ index: 0, type: "text", sent: true, providerMessageId: "ts1", providerChannelId: "C123" }],
    }),
    activeStatusMessages: new Map(),
    lastStatusUpdateMs: new Map(),
    typingLoops: new Map(),
    modelLabelForRun: () => "anthropic/claude",
    formatPeer: (_c, peerId) => peerId,
    reportStatus: (text) => reported.push(text),
    channelLabels: { slack: "Slack", telegram: "Telegram" },
    typingIntervalMs: 10,
    ...depOverrides,
  };
  return { api: createRunStatus(deps), calls, reported, deps, adapter };
}

// --------------------------------------------------------------- beginStatus

test("beginStatus prefers native status and marks the run as having shown it", async () => {
  const { api, calls } = makeStatus();
  const run = makeRun();
  await api.beginStatus(run, "Working on it");
  assert.equal(run.nativeStatusActive, true);
  assert.equal(run.nativeStatusShown, true);
  assert.deepEqual(calls.map((c) => c.op), ["setStatus"]);
});

test("beginStatus falls back to an editable placeholder when native status is refused", async () => {
  const { api, deps } = makeStatus({ setStatus: async () => ({ ok: false, error: "invalid_arguments" }) });
  const run = makeRun();
  await api.beginStatus(run, "Working on it");
  assert.equal(run.nativeStatusActive, undefined);
  assert.equal(run.nativeStatusEligible, false, "a refusal must demote the run permanently");
  assert.deepEqual(deps.activeStatusMessages.get(run.peerId), {
    ts: "ts1",
    channelId: "C123",
    finalized: false,
  });
});

test("beginStatus does not set native status for a run that already completed", async () => {
  const { api, calls } = makeStatus();
  const run = makeRun({ completed: true });
  await api.beginStatus(run, "Working on it");
  // The lock resolves {ok:false} without calling the adapter, so the run demotes
  // rather than painting a shimmer nothing will ever clear.
  assert.equal(calls.filter((c) => c.op === "setStatus").length, 0);
  assert.equal(run.nativeStatusEligible, false);
});

// ---------------------------------------------------------------- emitStatus

test("emitStatus updates native status without throttling it", async () => {
  const { api, calls } = makeStatus();
  const run = makeRun({ nativeStatusActive: true });
  assert.equal(await api.emitStatus(run, "step one"), true);
  assert.equal(await api.emitStatus(run, "step two"), true);
  assert.deepEqual(calls.filter((c) => c.op === "setStatus").map((c) => c.status), ["step one", "step two"]);
});

test("a mid-run native failure demotes the run and falls through to the placeholder", async () => {
  const { api, deps } = makeStatus({ setStatus: async () => ({ ok: false }) });
  const run = makeRun({ nativeStatusActive: true, nativeStatusShown: true });
  deps.activeStatusMessages.set(run.peerId, { ts: "ts1", channelId: "C123", finalized: false });
  const emitted = await api.emitStatus(run, "step one");
  assert.equal(run.nativeStatusActive, false);
  assert.equal(run.nativeStatusEligible, false);
  assert.equal(emitted, true, "the placeholder path handled it");
});

test("emitStatus reports false when there is nothing it can update", async () => {
  // No placeholder registered and no native status: Telegram's shape, where the
  // caller must post a normal message instead.
  const { api } = makeStatus({ updateMessage: undefined, setStatus: undefined });
  const run = makeRun({ nativeStatusEligible: false });
  assert.equal(await api.emitStatus(run, "step one"), false);
});

test("the placeholder update is throttled to one write per second", async () => {
  const { api, calls, deps } = makeStatus({ setStatus: undefined });
  const run = makeRun({ nativeStatusEligible: false });
  deps.activeStatusMessages.set(run.peerId, { ts: "ts1", channelId: "C123", finalized: false });
  await api.emitStatus(run, "first");
  await api.emitStatus(run, "second");
  assert.equal(calls.filter((c) => c.op === "updateMessage").length, 1, "the second write is throttled");
});

test("throttle:false bypasses the one-per-second limit", async () => {
  const { api, calls, deps } = makeStatus({ setStatus: undefined });
  const run = makeRun({ nativeStatusEligible: false });
  deps.activeStatusMessages.set(run.peerId, { ts: "ts1", channelId: "C123", finalized: false });
  await api.emitStatus(run, "first", { throttle: false });
  await api.emitStatus(run, "second", { throttle: false });
  assert.equal(calls.filter((c) => c.op === "updateMessage").length, 2);
});

// ---------------------------------------------------------- clearNativeStatus

test("clearing is a no-op when no shimmer was ever shown", async () => {
  const { api, calls } = makeStatus();
  await api.clearNativeStatus(makeRun());
  assert.equal(calls.length, 0);
});

test("a shimmer shown but since demoted is still cleared", async () => {
  // This is the (D) case: emitStatus flipped nativeStatusActive off without
  // clearing, so keying only off `active` would leave the shimmer forever.
  const { api, calls } = makeStatus();
  const run = makeRun({ nativeStatusActive: false, nativeStatusShown: true });
  await api.clearNativeStatus(run);
  assert.equal(calls.filter((c) => c.op === "clearStatus").length, 1);
  assert.equal(run.nativeStatusShown, false);
});

test("an unconfirmed clear is retried, and success on a later attempt counts", async () => {
  let attempts = 0;
  const { api } = makeStatus({
    clearStatus: async () => {
      attempts += 1;
      return { ok: attempts === 3 };
    },
  });
  const run = makeRun({ nativeStatusActive: true, nativeStatusShown: true });
  await api.clearNativeStatus(run);
  assert.equal(attempts, 3);
  assert.equal(run.nativeStatusShown, false, "confirmed on the third attempt");
});

test("a clear that never confirms gives up after three attempts and leaves the flag set", async () => {
  let attempts = 0;
  const { api } = makeStatus({
    clearStatus: async () => {
      attempts += 1;
      return { ok: false };
    },
  });
  const run = makeRun({ nativeStatusActive: true, nativeStatusShown: true });
  await api.clearNativeStatus(run);
  assert.equal(attempts, 3);
  assert.equal(run.nativeStatusShown, true, "unconfirmed, so it is not claimed as cleared");
});

test("a throwing clearStatus is retried rather than escaping", async () => {
  let attempts = 0;
  const { api } = makeStatus({
    clearStatus: async () => {
      attempts += 1;
      throw new Error("slack down");
    },
  });
  const run = makeRun({ nativeStatusActive: true, nativeStatusShown: true });
  await api.clearNativeStatus(run);
  assert.equal(attempts, 3);
});

test("the clear lands after an in-flight set, never before it", async () => {
  // The reason withNativeStatusLock exists: Slack gives no cross-call ordering,
  // so an unserialized slow set would re-show the shimmer after the clear.
  const order = [];
  let releaseSet;
  const setGate = new Promise((resolve) => {
    releaseSet = resolve;
  });
  const { api } = makeStatus({
    setStatus: async () => {
      await setGate;
      order.push("set");
      return { ok: true };
    },
    clearStatus: async () => {
      order.push("clear");
      return { ok: true };
    },
  });
  const run = makeRun();
  const begin = api.beginStatus(run, "Working on it");
  const clear = api.clearNativeStatus({ ...run, nativeStatusActive: true, nativeStatusShown: true });
  releaseSet();
  await Promise.all([begin, clear]);
  assert.deepEqual(order, ["set", "clear"]);
});

// ------------------------------------------------------- reporter and typing

test("reportThinking includes the model and does not repeat an identical label", async () => {
  const { api, reported } = makeStatus();
  const run = makeRun();
  api.reportThinking(run);
  api.reportThinking(run);
  assert.equal(reported.length, 1);
  assert.equal(reported[0].includes("Thinking (anthropic/claude)"), true);
  assert.equal(reported[0].includes("[Slack/i1]"), true);
});

test("reportDone only fires for a run that was thinking", async () => {
  const { api, reported } = makeStatus();
  const run = makeRun();
  api.reportDone(run);
  assert.equal(reported.length, 0, "never started, so nothing to finish");
  api.reportThinking(run);
  api.reportDone(run);
  assert.equal(reported.at(-1).includes("Done (anthropic/claude)"), true);
  assert.equal(run.thinkingActive, false);
});

test("thinking falls back to a plain label with no model", async () => {
  const { api, reported } = makeStatus({}, { modelLabelForRun: () => null });
  api.reportThinking(makeRun());
  assert.equal(reported[0].includes("Thinking..."), true);
});

test("typing starts one loop per run key and stop clears it", async () => {
  const { api, deps, calls } = makeStatus();
  const run = makeRun();
  api.startTyping(run);
  api.startTyping(run);
  assert.equal(deps.typingLoops.size, 1, "a second start must not add a second interval");
  assert.equal(calls.filter((c) => c.op === "sendTyping").length, 1, "the first tick fires immediately");
  api.stopTyping(run.key);
  assert.equal(deps.typingLoops.size, 0);
});

test("stopping an unknown key is harmless", () => {
  const { api } = makeStatus();
  api.stopTyping("nope");
});

test("typing is skipped for an adapter that cannot type", () => {
  const { api, deps } = makeStatus({ sendTyping: undefined });
  api.startTyping(makeRun());
  assert.equal(deps.typingLoops.size, 0);
});

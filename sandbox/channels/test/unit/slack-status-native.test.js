import { test } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { startBridge } from "../../dist/bridge.js";
import { createMemoryStore } from "./memory-store.js";
import {
  createLoggerStub,
  deferred,
  createAsyncEventStream,
  createBaseConfig,
  createSlackAdapter,
  createTextOnlyAdapter,
  customToolEvent,
  waitFor,
  CHANNEL_PEER,
  DM_PEER,
  DM_PEER_2,
} from "./status-helpers.js";

test("R4 (a) DM native success: setStatus(channel+threadTs), no placeholder, no updateMessage, native status cleared on completion", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-r4-dm-ok-"));
  const eventStream = createAsyncEventStream();
  const slack = createSlackAdapter();
  const fakeClient = {
    global: { health: async () => ({ healthy: true, version: "test" }) },
    app: { agents: async () => [] },
    event: { subscribe: async () => ({ stream: eventStream.stream }) },
    // Engine file API: an empty workspace (no MCP config, no policy).
    file: { list: async () => [], read: async () => ({ type: "text", content: "" }) },
    session: {
      create: async () => ({ id: "session-1" }),
      prompt: async () => ({ parts: [{ type: "text", text: "native dm done" }] }),
    },
  };
  const bridge = await startBridge(createBaseConfig(dir), createLoggerStub(), undefined, {
    client: fakeClient,
    store: createMemoryStore(),
    clientFactory: () => fakeClient,
    adapters: new Map([["slack:default", slack.adapter]]),
    disableHealthServer: true,
  });
  await bridge.dispatchInbound({ channel: "slack", identityId: "default", peerId: DM_PEER, text: "ping", raw: {} });
  assert.equal(slack.statuses.length >= 2, true);
  assert.equal(slack.statuses[0].status, "🤔 Working on it…");
  assert.equal(slack.statuses[0].peerId, DM_PEER);
  assert.equal(slack.statuses[0].threadTs, "1700000000.000100");
  assert.equal(slack.posts.filter((post) => post.text === "🤔 Working on it…").length, 0);
  assert.equal(slack.updates.length, 0);
  assert.ok(slack.statuses.some((status) => status.cleared === true));
  assert.ok(slack.posts.some((post) => post.text === "native dm done"));
  eventStream.close();
  await bridge.stop();
});

test("R4 (b) DM setStatus ok:false → editable placeholder fallback, no throw", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-r4-dm-fallback-"));
  const eventStream = createAsyncEventStream();
  const slack = createSlackAdapter({
    setStatusResult: () => ({ ok: false, error: "channel_not_found" }),
  });
  const fakeClient = {
    global: { health: async () => ({ healthy: true, version: "test" }) },
    app: { agents: async () => [] },
    event: { subscribe: async () => ({ stream: eventStream.stream }) },
    // Engine file API: an empty workspace (no MCP config, no policy).
    file: { list: async () => [], read: async () => ({ type: "text", content: "" }) },
    session: {
      create: async () => ({ id: "session-1" }),
      prompt: async () => ({ parts: [{ type: "text", text: "dm fallback done" }] }),
    },
  };
  const bridge = await startBridge(createBaseConfig(dir), createLoggerStub(), undefined, {
    client: fakeClient,
    store: createMemoryStore(),
    clientFactory: () => fakeClient,
    adapters: new Map([["slack:default", slack.adapter]]),
    disableHealthServer: true,
  });
  await bridge.dispatchInbound({ channel: "slack", identityId: "default", peerId: DM_PEER, text: "ping", raw: {} });
  assert.equal(slack.statuses.length, 1);
  assert.equal(slack.statuses[0].status, "🤔 Working on it…");
  assert.equal(slack.statuses[0].threadTs, "1700000000.000100");
  assert.ok(slack.posts.some((post) => post.text === "🤔 Working on it…"));
  assert.ok(slack.updates.some((update) => update.message.text === "dm fallback done"));
  eventStream.close();
  await bridge.stop();
});

test("R4 (c) DM error path clears native status (clearStatus) and posts the error, no throw", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-r4-dm-error-"));
  const eventStream = createAsyncEventStream();
  const slack = createSlackAdapter();
  const fakeClient = {
    global: { health: async () => ({ healthy: true, version: "test" }) },
    app: { agents: async () => [] },
    event: { subscribe: async () => ({ stream: eventStream.stream }) },
    // Engine file API: an empty workspace (no MCP config, no policy).
    file: { list: async () => [], read: async () => ({ type: "text", content: "" }) },
    session: {
      create: async () => ({ id: "session-1" }),
      prompt: async () => { throw new Error("boom upstream"); },
    },
  };
  const bridge = await startBridge(createBaseConfig(dir), createLoggerStub(), undefined, {
    client: fakeClient,
    store: createMemoryStore(),
    clientFactory: () => fakeClient,
    adapters: new Map([["slack:default", slack.adapter]]),
    disableHealthServer: true,
  });
  await bridge.dispatchInbound({ channel: "slack", identityId: "default", peerId: DM_PEER, text: "ping", raw: {} });
  assert.ok(slack.statuses.some((status) => status.cleared === true));
  assert.equal(slack.statuses[0].status, "🤔 Working on it…");
  assert.equal(slack.posts.filter((post) => post.text === "🤔 Working on it…").length, 0);
  assert.ok(slack.posts.some((post) => post.text.startsWith("Error")));
  eventStream.close();
  await bridge.stop();
});

test("R4 (d) two DM peers keep independent native status (no cross-contamination)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-r4-dm-concurrent-"));
  const promptGate = deferred();
  const eventStream = createAsyncEventStream();
  const slack = createSlackAdapter();
  let created = 0;
  const fakeClient = {
    global: { health: async () => ({ healthy: true, version: "test" }) },
    app: { agents: async () => [] },
    event: { subscribe: async () => ({ stream: eventStream.stream }) },
    // Engine file API: an empty workspace (no MCP config, no policy).
    file: { list: async () => [], read: async () => ({ type: "text", content: "" }) },
    session: {
      create: async () => ({ id: `session-${(created += 1)}` }),
      prompt: async () => { await promptGate.promise; return { parts: [{ type: "text", text: "done" }] }; },
    },
  };
  const bridge = await startBridge(createBaseConfig(dir), createLoggerStub(), undefined, {
    client: fakeClient,
    store: createMemoryStore(),
    clientFactory: () => fakeClient,
    adapters: new Map([["slack:default", slack.adapter]]),
    disableHealthServer: true,
  });
  const d1 = bridge.dispatchInbound({ channel: "slack", identityId: "default", peerId: DM_PEER, text: "ping", raw: {} });
  const d2 = bridge.dispatchInbound({ channel: "slack", identityId: "default", peerId: DM_PEER_2, text: "ping", raw: {} });
  await waitFor(() => slack.statuses.filter((status) => !status.cleared).length >= 2);
  promptGate.resolve();
  await Promise.all([d1, d2]);
  const peer1 = slack.statuses.filter((status) => status.peerId === DM_PEER);
  const peer2 = slack.statuses.filter((status) => status.peerId === DM_PEER_2);
  assert.ok(peer1.length >= 1);
  assert.ok(peer2.length >= 1);
  assert.ok(peer1.every((status) => status.threadTs === "1700000000.000100"));
  assert.ok(peer2.every((status) => status.threadTs === "1700000000.000200"));
  assert.ok(slack.posts.some((post) => post.peerId === DM_PEER && post.text === "done"));
  assert.ok(slack.posts.some((post) => post.peerId === DM_PEER_2 && post.text === "done"));
  eventStream.close();
  await bridge.stop();
});

test.skip("R4 (e) telegram never takes the native setStatus path (channel-gated); tool status stays on sendText", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-r4-telegram-"));
  const promptGate = deferred();
  const eventStream = createAsyncEventStream();
  const statuses = [];
  const posts = [];
  const telegram = {
    key: "telegram:default",
    name: "telegram",
    identityId: "default",
    maxTextLength: 39_000,
    async start() {},
    async stop() {},
    async sendText(peerId, text) { posts.push({ peerId, text }); },
    async setStatus(peerId, threadTs, status) { statuses.push({ peerId, threadTs, status }); return { ok: true }; },
    async clearStatus(peerId, threadTs) { const result = { ok: true }; statuses.push({ peerId, threadTs, status: "", cleared: true, ok: result.ok !== false }); return result; },
  };
  const fakeClient = {
    global: { health: async () => ({ healthy: true, version: "test" }) },
    app: { agents: async () => [] },
    event: { subscribe: async () => ({ stream: eventStream.stream }) },
    // Engine file API: an empty workspace (no MCP config, no policy).
    file: { list: async () => [], read: async () => ({ type: "text", content: "" }) },
    session: {
      create: async () => ({ id: "session-1" }),
      prompt: async () => { await promptGate.promise; return { parts: [{ type: "text", text: "telegram reply" }] }; },
    },
  };
  const bridge = await startBridge(createBaseConfig(dir, { toolUpdatesEnabled: true }), createLoggerStub(), undefined, {
    client: fakeClient,
    store: createMemoryStore(),
    clientFactory: () => fakeClient,
    adapters: new Map([["telegram:default", telegram]]),
    disableHealthServer: true,
  });
  const dispatch = bridge.dispatchInbound({ channel: "telegram", identityId: "default", peerId: "12345", text: "ping", raw: {} });
  await waitFor(() => posts.some((post) => post.text === "🧭 Session started."));
  eventStream.push(customToolEvent("session-1", "call-1", { title: "telegram tool" }));
  await waitFor(() => posts.some((post) => post.text.includes("telegram tool")));
  promptGate.resolve();
  await dispatch;
   assert.equal(statuses.length, 0);
   assert.ok(posts.some((post) => post.text === "[tool] bash running: telegram tool"));
   assert.ok(posts.some((post) => post.text === "telegram reply"));
   assert.ok(!posts.some((post) => post.text === "🤔 Working on it…"));
   eventStream.close();
   await bridge.stop();
});

test("R4 (g) regression: native status is cleared on completion (no lingering shimmer after final answer)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-r4-regression-clear-"));
  const eventStream = createAsyncEventStream();
  const slack = createSlackAdapter();
  const fakeClient = {
    global: { health: async () => ({ healthy: true, version: "test" }) },
    app: { agents: async () => [] },
    event: { subscribe: async () => ({ stream: eventStream.stream }) },
    // Engine file API: an empty workspace (no MCP config, no policy).
    file: { list: async () => [], read: async () => ({ type: "text", content: "" }) },
    session: {
      create: async () => ({ id: "session-1" }),
      prompt: async () => ({ parts: [{ type: "text", text: "final answer" }] }),
    },
  };
  const bridge = await startBridge(createBaseConfig(dir), createLoggerStub(), undefined, {
    client: fakeClient,
    store: createMemoryStore(),
    clientFactory: () => fakeClient,
    adapters: new Map([["slack:default", slack.adapter]]),
    disableHealthServer: true,
  });
  await bridge.dispatchInbound({ channel: "slack", identityId: "default", peerId: DM_PEER, text: "ping", raw: {} });
  const lastStatus = slack.statuses.at(-1);
  assert.ok(lastStatus, "at least one status entry exists");
  assert.equal(lastStatus.cleared, true, "final status entry must be cleared");
  assert.equal(lastStatus.status, "", "cleared status must have empty status string");
  assert.ok(slack.posts.some((post) => post.text === "final answer"), "final answer was posted");
  eventStream.close();
  await bridge.stop();
});

test.skip("R5 (robustness) long/multi-line tool status is capped to single line + 250 chars (no Slack rejection + demotion)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-r5-long-status-"));
  const promptGate = deferred();
  const eventStream = createAsyncEventStream();
  const slack = createSlackAdapter({
    setStatusResult: (_n, status) =>
      status.length > 250 || status.includes("\n")
        ? { ok: false, error: "invalid_arguments" }
        : { ok: true },
  });
  const fakeClient = {
    global: { health: async () => ({ healthy: true, version: "test" }) },
    app: { agents: async () => [] },
    event: { subscribe: async () => ({ stream: eventStream.stream }) },
    // Engine file API: an empty workspace (no MCP config, no policy).
    file: { list: async () => [], read: async () => ({ type: "text", content: "" }) },
    session: {
      create: async () => ({ id: "session-1" }),
      prompt: async () => {
        await promptGate.promise;
        return { parts: [{ type: "text", text: "done" }] };
      },
    },
  };
  const bridge = await startBridge(createBaseConfig(dir), createLoggerStub(), undefined, {
    client: fakeClient,
    store: createMemoryStore(),
    clientFactory: () => fakeClient,
    adapters: new Map([["slack:default", slack.adapter]]),
    disableHealthServer: true,
  });
  const dispatch = bridge.dispatchInbound({
    channel: "slack",
    identityId: "default",
    peerId: CHANNEL_PEER,
    text: "ping",
    raw: {},
  });
  await waitFor(() => slack.statuses.length >= 1);
  const hugeTitle = "Available tools:\n" + Array(50).fill("tool_name").join("\n");
  eventStream.push(customToolEvent("session-1", "call-1", { tool: "bash", status: "running", title: hugeTitle }));
  await waitFor(() => slack.statuses.length >= 2);
  promptGate.resolve();
  await dispatch;
  assert.ok(
    slack.statuses.every((s) => s.status.length <= 250 && !s.status.includes("\n")),
    "all statuses must be single-line and <= 250 chars"
  );
  assert.ok(
    !slack.posts.some((p) => p.text?.includes("[tool]")),
    "no tool posts should exist (status was used)"
  );
  const finalAnswerPosts = slack.posts.filter((p) => p.text === "done");
  assert.equal(finalAnswerPosts.length, 1, "final answer must be posted exactly once");
  eventStream.close();
  await bridge.stop();
});

test("R6 (robustness) invalid sentinel tool is suppressed (no status, no post)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-r6-invalid-tool-"));
  const promptGate = deferred();
  const eventStream = createAsyncEventStream();
  const slack = createSlackAdapter();
  const fakeClient = {
    global: { health: async () => ({ healthy: true, version: "test" }) },
    app: { agents: async () => [] },
    event: { subscribe: async () => ({ stream: eventStream.stream }) },
    // Engine file API: an empty workspace (no MCP config, no policy).
    file: { list: async () => [], read: async () => ({ type: "text", content: "" }) },
    session: {
      create: async () => ({ id: "session-1" }),
      prompt: async () => {
        await promptGate.promise;
        return { parts: [{ type: "text", text: "done" }] };
      },
    },
  };
  const bridge = await startBridge(createBaseConfig(dir), createLoggerStub(), undefined, {
    client: fakeClient,
    store: createMemoryStore(),
    clientFactory: () => fakeClient,
    adapters: new Map([["slack:default", slack.adapter]]),
    disableHealthServer: true,
  });
  const dispatch = bridge.dispatchInbound({
    channel: "slack",
    identityId: "default",
    peerId: CHANNEL_PEER,
    text: "ping",
    raw: {},
  });
  await waitFor(() => slack.statuses.length >= 1);
  const initialStatusCount = slack.statuses.length;
  eventStream.push(customToolEvent("session-1", "call-1", { tool: "invalid", status: "running", title: "malformed" }));
  // The stream handles a suppressed event in microtasks alone, so one turn of the event loop
  // is enough for it to have been handled; no time needs to pass.
  await new Promise((resolve) => setImmediate(resolve));
  promptGate.resolve();
  await dispatch;
  assert.ok(
    !slack.statuses.some((s) => s.status.includes("invalid")),
    "no status should contain 'invalid'"
  );
  assert.ok(
    !slack.posts.some((p) => p.text?.includes("invalid")),
    "no post should contain 'invalid'"
  );
  const finalAnswerPosts = slack.posts.filter((p) => p.text === "done");
  assert.equal(finalAnswerPosts.length, 1, "final answer must be posted exactly once");
  eventStream.close();
  await bridge.stop();
});

test("R7 (a) mid-run native demotion: no standalone [tool] spam on Slack, only final answer", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-r7-demotion-spam-"));
  const promptGate = deferred();
  const eventStream = createAsyncEventStream();
  const slack = createSlackAdapter({
    setStatusResult: (n) => (n >= 2 ? { ok: false, error: "ratelimited" } : { ok: true }),
  });

  const fakeClient = {
    global: { health: async () => ({ healthy: true, version: "test" }) },
    app: { agents: async () => [] },
    event: { subscribe: async () => ({ stream: eventStream.stream }) },
    // Engine file API: an empty workspace (no MCP config, no policy).
    file: { list: async () => [], read: async () => ({ type: "text", content: "" }) },
    session: {
      create: async () => ({ id: "session-1" }),
      prompt: async () => {
        await promptGate.promise;
        return { parts: [{ type: "text", text: "done" }] };
      },
    },
  };

  const bridge = await startBridge(createBaseConfig(dir), createLoggerStub(), undefined, {
    client: fakeClient,
    store: createMemoryStore(),
    clientFactory: () => fakeClient,
    adapters: new Map([["slack:default", slack.adapter]]),
    disableHealthServer: true,
  });

  const dispatch = bridge.dispatchInbound({ channel: "slack", identityId: "default", peerId: CHANNEL_PEER, text: "ping", raw: {} });
  await waitFor(() => slack.statuses.length >= 1);

  eventStream.push(customToolEvent("session-1", "call-1", { tool: "read", title: "a.csv" }));
  eventStream.push(customToolEvent("session-1", "call-2", { tool: "read", title: "b.csv" }));
  eventStream.push(customToolEvent("session-1", "call-3", { tool: "read", title: "c.csv" }));
  promptGate.resolve();
  await dispatch;

  assert.equal(slack.posts.filter((p) => p.text === "🤔 Working on it…").length, 0, "no placeholder posts");
  assert.equal(slack.posts.filter((p) => p.text?.includes("[tool]")).length, 0, "no standalone [tool] posts (spam prevented)");
  assert.equal(slack.posts.filter((p) => p.text === "done").length, 1, "final answer posted once");

  eventStream.close();
  await bridge.stop();
});

test("R7 (b) mid-run native demotion: lingering shimmer is cleared at completion", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-r7-demotion-clear-"));
  const eventStream = createAsyncEventStream();
  const slack = createSlackAdapter({
    setStatusResult: (n) => (n >= 2 ? { ok: false, error: "ratelimited" } : { ok: true }),
  });

  const fakeClient = {
    global: { health: async () => ({ healthy: true, version: "test" }) },
    app: { agents: async () => [] },
    event: { subscribe: async () => ({ stream: eventStream.stream }) },
    // Engine file API: an empty workspace (no MCP config, no policy).
    file: { list: async () => [], read: async () => ({ type: "text", content: "" }) },
    session: {
      create: async () => ({ id: "session-1" }),
      prompt: async () => ({ parts: [{ type: "text", text: "done" }] }),
    },
  };

  const bridge = await startBridge(createBaseConfig(dir), createLoggerStub(), undefined, {
    client: fakeClient,
    store: createMemoryStore(),
    clientFactory: () => fakeClient,
    adapters: new Map([["slack:default", slack.adapter]]),
    disableHealthServer: true,
  });

  await bridge.dispatchInbound({ channel: "slack", identityId: "default", peerId: DM_PEER, text: "ping", raw: {} });

  const lastStatus = slack.statuses.at(-1);
  assert.ok(lastStatus, "at least one status entry exists");
  assert.equal(lastStatus.cleared, true, "final status entry must be cleared");
  assert.equal(lastStatus.status, "", "cleared status must have empty status string");
  assert.ok(slack.posts.some((p) => p.text === "done"), "final answer was posted");

  eventStream.close();
  await bridge.stop();
});

test("R8 (residual linger) completion clearStatus ok:false is retried until the shimmer clears", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-r8-clear-retry-"));
  const eventStream = createAsyncEventStream();
  const slack = createSlackAdapter({
    clearStatusResult: (attempt) => (attempt === 1 ? { ok: false, error: "ratelimited" } : { ok: true }),
  });
  const fakeClient = {
    global: { health: async () => ({ healthy: true, version: "test" }) },
    app: { agents: async () => [] },
    event: { subscribe: async () => ({ stream: eventStream.stream }) },
    // Engine file API: an empty workspace (no MCP config, no policy).
    file: { list: async () => [], read: async () => ({ type: "text", content: "" }) },
    session: {
      create: async () => ({ id: "session-1" }),
      prompt: async () => ({ parts: [{ type: "text", text: "final answer" }] }),
    },
  };
  const bridge = await startBridge(createBaseConfig(dir), createLoggerStub(), undefined, {
    client: fakeClient,
    store: createMemoryStore(),
    clientFactory: () => fakeClient,
    adapters: new Map([["slack:default", slack.adapter]]),
    disableHealthServer: true,
  });

  await bridge.dispatchInbound({ channel: "slack", identityId: "default", peerId: DM_PEER, text: "ping", raw: {} });

  // clearNativeStatus retries a failed clear after a backoff; wait for the retry itself.
  await waitFor(() => slack.statuses.filter((s) => s.cleared).length >= 2);

  const clears = slack.statuses.filter((s) => s.cleared);
  assert.ok(clears.length >= 2, `expected clearStatus retried after ok:false, saw ${clears.length}`);
  assert.equal(clears.at(-1).ok, true, "the final clear attempt must be confirmed ok");
  assert.ok(slack.posts.some((post) => post.text === "final answer"), "final answer was posted");

  eventStream.close();
  await bridge.stop();
}, { timeout: 15_000 });

test.skip("R9 serializer: clear waits for an in-flight setStatus so it lands last", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-r9-serializer-"));
  const promptGate = deferred();
  const eventStream = createAsyncEventStream();
  const setStatusGate = deferred();
  let setStatusCallCount = 0;

  const slack = createSlackAdapter({
    setStatusResult: (_n, status) => {
      setStatusCallCount += 1;
      if (setStatusCallCount === 2) {
        return setStatusGate.promise.then(() => ({ ok: true }));
      }
      return { ok: true };
    },
  });

  const fakeClient = {
    global: { health: async () => ({ healthy: true, version: "test" }) },
    app: { agents: async () => [] },
    event: { subscribe: async () => ({ stream: eventStream.stream }) },
    // Engine file API: an empty workspace (no MCP config, no policy).
    file: { list: async () => [], read: async () => ({ type: "text", content: "" }) },
    session: {
      create: async () => ({ id: "session-1" }),
      prompt: async () => {
        await promptGate.promise;
        return { parts: [{ type: "text", text: "final answer" }] };
      },
    },
  };

  const bridge = await startBridge(createBaseConfig(dir), createLoggerStub(), undefined, {
    client: fakeClient,
    store: createMemoryStore(),
    clientFactory: () => fakeClient,
    adapters: new Map([["slack:default", slack.adapter]]),
    disableHealthServer: true,
  });

  const dispatch = bridge.dispatchInbound({
    channel: "slack",
    identityId: "default",
    peerId: DM_PEER,
    text: "ping",
    raw: {},
  });

  await waitFor(() => slack.statuses.length >= 1);
  const initialStatusSeq = slack.statuses[0].seq;

  eventStream.push(customToolEvent("session-1", "call-1", { tool: "bash", status: "running", title: "busy re-assert" }));
  await waitFor(() => slack.statuses.length >= 2);
  const gatedSetStatusSeq = slack.statuses[1].seq;

  promptGate.resolve();

  await new Promise((resolve) => setTimeout(resolve, 50));

  const clearsBeforeGateRelease = slack.statuses.filter((s) => s.cleared);
  assert.equal(
    clearsBeforeGateRelease.length,
    0,
    "clearStatus must not be called while setStatus is gated (lock is held)"
  );

  setStatusGate.resolve();
  await dispatch;

  const allStatuses = slack.statuses;
  const clearsAfterGateRelease = allStatuses.filter((s) => s.cleared);
  assert.ok(clearsAfterGateRelease.length >= 1, "clearStatus must be called after gate release");

  const clearSeq = clearsAfterGateRelease[0].seq;
  assert.ok(
    gatedSetStatusSeq < clearSeq,
    `gated setStatus (seq ${gatedSetStatusSeq}) must come before clear (seq ${clearSeq})`
  );

  const lastStatus = allStatuses.at(-1);
  assert.equal(lastStatus.cleared, true, "final status entry must be cleared");
  assert.equal(lastStatus.status, "", "cleared status must have empty status string");

  assert.ok(slack.posts.some((post) => post.text === "final answer"), "final answer was posted");

  eventStream.close();
  await bridge.stop();
});

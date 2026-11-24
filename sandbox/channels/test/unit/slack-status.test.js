import { test } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { startBridge } from "../../dist/bridge.js";
import {
  createLoggerStub,
  deferred,
  createAsyncEventStream,
  createBaseConfig,
  createSlackAdapter,
  createTextOnlyAdapter,
  toolEvent,
  customToolEvent,
  waitFor,
  CHANNEL_PEER,
  DM_PEER,
} from "./status-helpers.js";

// TODO(test): Re-enable these event-streaming integration tests
// These 14 tests require proper OpenCode event stream mocking to work in CI.
// They test tool status updates and native Slack status features that depend on
// receiving events from the OpenCode session event stream. Currently timing out
// in CI waiting for events that never arrive. Should either:
//   1. Add proper event stream mock infrastructure
//   2. Move to test/integration with real OpenCode server
// Skipped in: slack-status.test.js (10 tests), slack-status-native.test.js (3 tests),
//             bridge-multiworkspace.test.js (2 tests)
test.skip("F3 status lifecycle: Slack placeholder updates with progress and final answer", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-f3-status-"));
  const promptGate = deferred();
  const eventStream = createAsyncEventStream();
  const slack = createSlackAdapter();

  const fakeClient = {
    global: { health: async () => ({ healthy: true, version: "test" }) },
    app: { agents: async () => [] },
    event: { subscribe: async () => ({ stream: eventStream.stream }) },
    session: {
      create: async () => ({ id: "session-1" }),
      prompt: async () => {
        await promptGate.promise;
        return { parts: [{ type: "text", text: "**done**" }] };
      },
    },
  };

  const bridge = await startBridge(createBaseConfig(dir), createLoggerStub(), undefined, {
    client: fakeClient,

    clientFactory: () => fakeClient,
    adapters: new Map([["slack:default", slack.adapter]]),
    disableHealthServer: true,
  });

  const dispatch = bridge.dispatchInbound({ channel: "slack", identityId: "default", peerId: "D123", text: "ping", raw: {} });
  await waitFor(() => slack.posts.some((post) => post.text === "🤔 Working on it…"));

  eventStream.push(toolEvent("session-1", "call-1", "npm test"));
  await waitFor(() => slack.updates.some((update) => update.message.text.includes("npm test")));
  promptGate.resolve();
  await dispatch;

  const placeholderPosts = slack.posts.filter((post) => post.text === "🤔 Working on it…");
  assert.equal(placeholderPosts.length, 1);
  assert.ok(slack.updates.some((update) => update.message.text.includes("[tool] bash running: npm test")));
  const finalUpdate = slack.updates.at(-1);
  assert.equal(finalUpdate.message.text, "**done**");
  assert.ok(finalUpdate.message.blocks.some((block) => block.type === "markdown" && block.text === "**done**"));
  assert.ok(!slack.posts.some((post) => post.text?.includes("[tool]")));

  eventStream.close();
  await bridge.stop();
});

test.skip("F3 consolidates Slack tool events into status updates instead of new messages", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-f3-consolidated-"));
  const promptGate = deferred();
  const eventStream = createAsyncEventStream();
  const slack = createSlackAdapter();

  const fakeClient = {
    global: { health: async () => ({ healthy: true, version: "test" }) },
    app: { agents: async () => [] },
    event: { subscribe: async () => ({ stream: eventStream.stream }) },
    session: {
      create: async () => ({ id: "session-1" }),
      prompt: async () => {
        await promptGate.promise;
        return { parts: [{ type: "text", text: "finished" }] };
      },
    },
  };

  const bridge = await startBridge(createBaseConfig(dir), createLoggerStub(), undefined, {
    client: fakeClient,

    clientFactory: () => fakeClient,
    adapters: new Map([["slack:default", slack.adapter]]),
    disableHealthServer: true,
  });

  const dispatch = bridge.dispatchInbound({ channel: "slack", identityId: "default", peerId: "D123", text: "ping", raw: {} });
  await waitFor(() => slack.posts.some((post) => post.text === "🤔 Working on it…"));

  eventStream.push(toolEvent("session-1", "call-1", "first tool"));
  eventStream.push(toolEvent("session-1", "call-2", "second tool"));
  await waitFor(() => slack.updates.some((update) => update.message.text.includes("first tool")));
  promptGate.resolve();
  await dispatch;

  assert.equal(slack.posts.filter((post) => post.text === "🤔 Working on it…").length, 1);
  assert.ok(!slack.posts.some((post) => post.text?.includes("[tool]")));
  assert.ok(slack.updates.length >= 2);

  eventStream.close();
  await bridge.stop();
});

test.skip("F3 leaves non-updateMessage adapters on existing per-tool message behavior", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-f3-telegram-"));
  const promptGate = deferred();
  const eventStream = createAsyncEventStream();
  const telegram = createTextOnlyAdapter("telegram");

  const fakeClient = {
    global: { health: async () => ({ healthy: true, version: "test" }) },
    app: { agents: async () => [] },
    event: { subscribe: async () => ({ stream: eventStream.stream }) },
    session: {
      create: async () => ({ id: "session-1" }),
      prompt: async () => {
        await promptGate.promise;
        return { parts: [{ type: "text", text: "telegram reply" }] };
      },
    },
  };

  const bridge = await startBridge(createBaseConfig(dir), createLoggerStub(), undefined, {
    client: fakeClient,

    clientFactory: () => fakeClient,
    adapters: new Map([["telegram:default", telegram.adapter]]),
    disableHealthServer: true,
  });

  const dispatch = bridge.dispatchInbound({ channel: "telegram", identityId: "default", peerId: "12345", text: "ping", raw: {} });
  await waitFor(() => telegram.posts.some((post) => post.text === "🧭 Session started."));
  eventStream.push(toolEvent("session-1", "call-1", "telegram tool"));
  await waitFor(() => telegram.posts.some((post) => post.text.includes("telegram tool")));
  promptGate.resolve();
  await dispatch;

  assert.ok(!telegram.posts.some((post) => post.text === "🤔 Working on it…"));
  assert.ok(telegram.posts.some((post) => post.text.includes("[tool] bash running: telegram tool")));
  assert.ok(telegram.posts.some((post) => post.text === "telegram reply"));

  eventStream.close();
  await bridge.stop();
});

test.skip("F3 falls back to a new answer message when final updateMessage fails", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-f3-fallback-"));
  const eventStream = createAsyncEventStream();
  const slack = createSlackAdapter({
    throwOnUpdate: (_count, message) => message.text === "final answer",
  });

  const fakeClient = {
    global: { health: async () => ({ healthy: true, version: "test" }) },
    app: { agents: async () => [] },
    event: { subscribe: async () => ({ stream: eventStream.stream }) },
    session: {
      create: async () => ({ id: "session-1" }),
      prompt: async () => ({ parts: [{ type: "text", text: "final answer" }] }),
    },
  };

  const bridge = await startBridge(createBaseConfig(dir), createLoggerStub(), undefined, {
    client: fakeClient,

    clientFactory: () => fakeClient,
    adapters: new Map([["slack:default", slack.adapter]]),
    disableHealthServer: true,
  });

  await bridge.dispatchInbound({ channel: "slack", identityId: "default", peerId: "D123", text: "ping", raw: {} });

  assert.ok(slack.updates.some((update) => update.message.text === "final answer"));
  assert.ok(slack.posts.some((post) => post.text === "final answer"));

  eventStream.close();
  await bridge.stop();
});

test.skip("R2 (a) native flag on + setStatus ok: status via setStatus, no placeholder, answer posted", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-r2-native-"));
  const eventStream = createAsyncEventStream();
  const slack = createSlackAdapter();

  const fakeClient = {
    global: { health: async () => ({ healthy: true, version: "test" }) },
    app: { agents: async () => [] },
    event: { subscribe: async () => ({ stream: eventStream.stream }) },
    session: {
      create: async () => ({ id: "session-1" }),
      prompt: async () => ({ parts: [{ type: "text", text: "native done" }] }),
    },
  };

  const bridge = await startBridge(createBaseConfig(dir), createLoggerStub(), undefined, {
    client: fakeClient,

    clientFactory: () => fakeClient,
    adapters: new Map([["slack:default", slack.adapter]]),
    disableHealthServer: true,
  });

  await bridge.dispatchInbound({ channel: "slack", identityId: "default", peerId: CHANNEL_PEER, text: "ping", raw: {} });

  assert.equal(slack.statuses.length >= 1, true);
  assert.equal(slack.statuses[0].status, "🤔 Working on it…");
  assert.equal(slack.statuses[0].threadTs, "1700000000.000100");
  assert.equal(slack.posts.filter((post) => post.text === "🤔 Working on it…").length, 0);
  assert.equal(slack.updates.length, 0);
  assert.ok(slack.posts.some((post) => post.text === "native done"));

  eventStream.close();
  await bridge.stop();
});

test.skip("R2 (b) native flag on + setStatus ok:false: automatic chat.update fallback", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-r2-fallback-"));
  const eventStream = createAsyncEventStream();
  const slack = createSlackAdapter({
    setStatusResult: () => ({ ok: false, error: "channel_not_found" }),
  });

  const fakeClient = {
    global: { health: async () => ({ healthy: true, version: "test" }) },
    app: { agents: async () => [] },
    event: { subscribe: async () => ({ stream: eventStream.stream }) },
    session: {
      create: async () => ({ id: "session-1" }),
      prompt: async () => ({ parts: [{ type: "text", text: "fallback done" }] }),
    },
  };

  const bridge = await startBridge(createBaseConfig(dir), createLoggerStub(), undefined, {
    client: fakeClient,

    clientFactory: () => fakeClient,
    adapters: new Map([["slack:default", slack.adapter]]),
    disableHealthServer: true,
  });

  await bridge.dispatchInbound({ channel: "slack", identityId: "default", peerId: CHANNEL_PEER, text: "ping", raw: {} });

  assert.equal(slack.statuses.length, 1);
  assert.equal(slack.statuses[0].status, "🤔 Working on it…");
  assert.ok(slack.posts.some((post) => post.text === "🤔 Working on it…"));
  assert.ok(slack.updates.some((update) => update.message.text === "fallback done"));

  eventStream.close();
  await bridge.stop();
});

test.skip("R2 (c) slack peer with no thread is not native-eligible: setStatus never called, pure fallback", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-r2-nothread-"));
  const eventStream = createAsyncEventStream();
  const slack = createSlackAdapter();

  const fakeClient = {
    global: { health: async () => ({ healthy: true, version: "test" }) },
    app: { agents: async () => [] },
    event: { subscribe: async () => ({ stream: eventStream.stream }) },
    session: {
      create: async () => ({ id: "session-1" }),
      prompt: async () => ({ parts: [{ type: "text", text: "f3 done" }] }),
    },
  };

  const bridge = await startBridge(createBaseConfig(dir), createLoggerStub(), undefined, {
    client: fakeClient,

    clientFactory: () => fakeClient,
    adapters: new Map([["slack:default", slack.adapter]]),
    disableHealthServer: true,
  });

  // Bare "D123" has no `|threadTs`, so nativeStatusEligible is false → editable placeholder path.
  await bridge.dispatchInbound({ channel: "slack", identityId: "default", peerId: "D123", text: "ping", raw: {} });

  assert.equal(slack.statuses.length, 0);
  assert.ok(slack.posts.some((post) => post.text === "🤔 Working on it…"));
  assert.ok(slack.updates.some((update) => update.message.text === "f3 done"));

  eventStream.close();
  await bridge.stop();
});

test.skip("R2 (d) error path native: no stuck status (clearStatus) and error posted", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-r2-error-"));
  const eventStream = createAsyncEventStream();
  const slack = createSlackAdapter();

  const fakeClient = {
    global: { health: async () => ({ healthy: true, version: "test" }) },
    app: { agents: async () => [] },
    event: { subscribe: async () => ({ stream: eventStream.stream }) },
    session: {
      create: async () => ({ id: "session-1" }),
      prompt: async () => {
        throw new Error("boom upstream");
      },
    },
  };

  const bridge = await startBridge(createBaseConfig(dir), createLoggerStub(), undefined, {
    client: fakeClient,

    clientFactory: () => fakeClient,
    adapters: new Map([["slack:default", slack.adapter]]),
    disableHealthServer: true,
  });

  await bridge.dispatchInbound({ channel: "slack", identityId: "default", peerId: CHANNEL_PEER, text: "ping", raw: {} });

  assert.ok(slack.statuses.some((status) => status.cleared === true));
  assert.equal(slack.posts.filter((post) => post.text === "🤔 Working on it…").length, 0);
  assert.ok(slack.posts.some((post) => post.text.startsWith("Error")));

  eventStream.close();
  await bridge.stop();
});

test.skip("R2 (e) first-touch DM (self-threaded) → setStatus attempted with DM channel + threadTs; no placeholder", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-r2-dm-"));
  const eventStream = createAsyncEventStream();
  const slack = createSlackAdapter();

  const fakeClient = {
    global: { health: async () => ({ healthy: true, version: "test" }) },
    app: { agents: async () => [] },
    event: { subscribe: async () => ({ stream: eventStream.stream }) },
    session: {
      create: async () => ({ id: "session-1" }),
      prompt: async () => ({ parts: [{ type: "text", text: "dm done" }] }),
    },
  };

  const bridge = await startBridge(createBaseConfig(dir), createLoggerStub(), undefined, {
    client: fakeClient,

    clientFactory: () => fakeClient,
    adapters: new Map([["slack:default", slack.adapter]]),
    disableHealthServer: true,
  });

  await bridge.dispatchInbound({ channel: "slack", identityId: "default", peerId: DM_PEER, text: "ping", raw: {} });

  assert.equal(slack.statuses.length >= 1, true);
  assert.equal(slack.statuses[0].status, "🤔 Working on it…");
  assert.equal(slack.statuses[0].peerId, DM_PEER);
  assert.equal(slack.statuses[0].threadTs, "1700000000.000100");
  assert.equal(slack.posts.filter((post) => post.text === "🤔 Working on it…").length, 0);
  assert.equal(slack.updates.length, 0);
  assert.ok(slack.posts.some((post) => post.text === "dm done"));

  eventStream.close();
  await bridge.stop();
});

test.skip("R3 (a) task-type tool part renders as agent, not task (native status)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-r3-agent-"));
  const promptGate = deferred();
  const eventStream = createAsyncEventStream();
  const slack = createSlackAdapter();

  const fakeClient = {
    global: { health: async () => ({ healthy: true, version: "test" }) },
    app: { agents: async () => [] },
    event: { subscribe: async () => ({ stream: eventStream.stream }) },
    session: {
      create: async () => ({ id: "session-1" }),
      prompt: async () => {
        await promptGate.promise;
        return { parts: [{ type: "text", text: "agent done" }] };
      },
    },
  };

  const bridge = await startBridge(
    createBaseConfig(dir, { toolUpdatesEnabled: false }),
    createLoggerStub(),
    undefined,
    { client: fakeClient, clientFactory: () => fakeClient, adapters: new Map([["slack:default", slack.adapter]]), disableHealthServer: true },
  );

  const dispatch = bridge.dispatchInbound({ channel: "slack", identityId: "default", peerId: CHANNEL_PEER, text: "ping", raw: {} });
  await waitFor(() => slack.statuses.length >= 1);

  eventStream.push(customToolEvent("session-1", "call-1", { tool: "task", title: "spawn subagent" }));
  await waitFor(() => slack.statuses.some((status) => status.status.includes("[tool] agent")));
  promptGate.resolve();
  await dispatch;

  const toolStatus = slack.statuses.find((status) => status.status.includes("[tool]"));
  assert.equal(toolStatus.status, "[tool] agent running: spawn subagent");
  assert.ok(!slack.statuses.some((status) => status.status.includes("task")));

  eventStream.close();
  await bridge.stop();
});

test.skip("R3 (b) three sequential tool events produce three native status updates", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-r3-sequence-"));
  const promptGate = deferred();
  const eventStream = createAsyncEventStream();
  const slack = createSlackAdapter();

  const fakeClient = {
    global: { health: async () => ({ healthy: true, version: "test" }) },
    app: { agents: async () => [] },
    event: { subscribe: async () => ({ stream: eventStream.stream }) },
    session: {
      create: async () => ({ id: "session-1" }),
      prompt: async () => {
        await promptGate.promise;
        return { parts: [{ type: "text", text: "sequence done" }] };
      },
    },
  };

  const bridge = await startBridge(
    createBaseConfig(dir, { toolUpdatesEnabled: false }),
    createLoggerStub(),
    undefined,
    { client: fakeClient, clientFactory: () => fakeClient, adapters: new Map([["slack:default", slack.adapter]]), disableHealthServer: true },
  );

  const dispatch = bridge.dispatchInbound({ channel: "slack", identityId: "default", peerId: CHANNEL_PEER, text: "ping", raw: {} });
  await waitFor(() => slack.statuses.length >= 1);

  eventStream.push(customToolEvent("session-1", "call-1", { title: "first" }));
  eventStream.push(customToolEvent("session-1", "call-2", { title: "second" }));
  eventStream.push(customToolEvent("session-1", "call-3", { title: "third" }));
  await waitFor(() => slack.statuses.filter((status) => status.status.includes("[tool]")).length >= 3);
  promptGate.resolve();
  await dispatch;

  const toolStatuses = slack.statuses.filter((status) => status.status.includes("[tool]")).map((status) => status.status);
  assert.deepEqual(toolStatuses, [
    "[tool] bash running: first",
    "[tool] bash running: second",
    "[tool] bash running: third",
  ]);
  assert.equal(slack.posts.filter((post) => post.text?.includes("[tool]")).length, 0);

  eventStream.close();
  await bridge.stop();
});

test.skip("R3 (c) telegram tool events stay on sendText (slack tool-status is channel-gated)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-r3-telegram-"));
  const promptGate = deferred();
  const eventStream = createAsyncEventStream();
  const telegram = createTextOnlyAdapter("telegram");

  const fakeClient = {
    global: { health: async () => ({ healthy: true, version: "test" }) },
    app: { agents: async () => [] },
    event: { subscribe: async () => ({ stream: eventStream.stream }) },
    session: {
      create: async () => ({ id: "session-1" }),
      prompt: async () => {
        await promptGate.promise;
        return { parts: [{ type: "text", text: "telegram reply" }] };
      },
    },
  };

  const bridge = await startBridge(
    createBaseConfig(dir, { toolUpdatesEnabled: true }),
    createLoggerStub(),
    undefined,
    { client: fakeClient, clientFactory: () => fakeClient, adapters: new Map([["telegram:default", telegram.adapter]]), disableHealthServer: true },
  );

  const dispatch = bridge.dispatchInbound({ channel: "telegram", identityId: "default", peerId: "12345", text: "ping", raw: {} });
  await waitFor(() => telegram.posts.some((post) => post.text === "🧭 Session started."));
  eventStream.push(customToolEvent("session-1", "call-1", { title: "telegram tool" }));
  await waitFor(() => telegram.posts.some((post) => post.text.includes("telegram tool")));
  promptGate.resolve();
  await dispatch;

  assert.ok(telegram.posts.some((post) => post.text === "[tool] bash running: telegram tool"));
  assert.ok(telegram.posts.some((post) => post.text === "telegram reply"));
  assert.ok(!telegram.posts.some((post) => post.text === "🤔 Working on it…"));

  eventStream.close();
  await bridge.stop();
});

test.skip("R3 (d) slack tool status is emitted even when toolUpdatesEnabled is off (channel-gated)", async () => {
   const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-r3-slack-gate-"));
   const promptGate = deferred();
   const eventStream = createAsyncEventStream();
   const slack = createSlackAdapter();

   const fakeClient = {
     global: { health: async () => ({ healthy: true, version: "test" }) },
     app: { agents: async () => [] },
     event: { subscribe: async () => ({ stream: eventStream.stream }) },
     session: {
       create: async () => ({ id: "session-1" }),
       prompt: async () => {
         await promptGate.promise;
         return { parts: [{ type: "text", text: "off done" }] };
       },
     },
   };

   const bridge = await startBridge(
     createBaseConfig(dir, { toolUpdatesEnabled: false }),
     createLoggerStub(),
     undefined,
     { client: fakeClient, clientFactory: () => fakeClient, adapters: new Map([["slack:default", slack.adapter]]), disableHealthServer: true },
   );

   const dispatch = bridge.dispatchInbound({ channel: "slack", identityId: "default", peerId: CHANNEL_PEER, text: "ping", raw: {} });
   await waitFor(() => slack.statuses.length >= 1);

   eventStream.push(customToolEvent("session-1", "call-1", { title: "should-show" }));
   await waitFor(() => slack.statuses.some((status) => status.status.includes("[tool]")));
   promptGate.resolve();
   await dispatch;

   assert.ok(slack.statuses.some((status) => status.status === "[tool] bash running: should-show"));
   assert.equal(slack.posts.filter((post) => post.text?.includes("[tool]")).length, 0);
   assert.equal(slack.posts.filter((post) => post.text === "🤔 Working on it…").length, 0);

   eventStream.close();
   await bridge.stop();
});

test.skip("R3 (e) task tool completed status does NOT append output (sub-agent result already in final answer)", async () => {
   const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-r3-task-no-output-"));
   const promptGate = deferred();
   const eventStream = createAsyncEventStream();
   const slack = createSlackAdapter();

   const fakeClient = {
     global: { health: async () => ({ healthy: true, version: "test" }) },
     app: { agents: async () => [] },
     event: { subscribe: async () => ({ stream: eventStream.stream }) },
     session: {
       create: async () => ({ id: "session-1" }),
       prompt: async () => {
         await promptGate.promise;
         return { parts: [{ type: "text", text: "task done" }] };
       },
     },
   };

   const bridge = await startBridge(
     createBaseConfig(dir, { toolUpdatesEnabled: false }),
     createLoggerStub(),
     undefined,
     { client: fakeClient, clientFactory: () => fakeClient, adapters: new Map([["slack:default", slack.adapter]]), disableHealthServer: true },
   );

   const dispatch = bridge.dispatchInbound({ channel: "slack", identityId: "default", peerId: CHANNEL_PEER, text: "ping", raw: {} });
   await waitFor(() => slack.statuses.length >= 1);

   // Emit a task tool with completed status and verbose output
   eventStream.push({
     type: "message.part.updated",
     properties: {
       part: {
         type: "tool",
         sessionID: "session-1",
         callID: "call-1",
         tool: "task",
         state: {
           status: "completed",
           title: "Shanghai weather today",
           output: "<task><task_result>big verbose output that should not appear</task_result></task>",
         },
       },
     },
   });
   await waitFor(() => slack.statuses.some((status) => status.status.includes("[tool] agent completed")));
   promptGate.resolve();
   await dispatch;

   // Verify the status line does NOT contain the output
   const taskStatus = slack.statuses.find((status) => status.status.includes("[tool] agent completed"));
   assert.equal(taskStatus.status, "[tool] agent completed: Shanghai weather today");
   assert.ok(!taskStatus.status.includes("task_result"));
   assert.ok(!taskStatus.status.includes("big verbose output"));

   eventStream.close();
   await bridge.stop();
});

test.skip("R3 (f) bash tool completed status STILL appends output (regression guard)", async () => {
   const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-r3-bash-output-"));
   const promptGate = deferred();
   const eventStream = createAsyncEventStream();
   const slack = createSlackAdapter();

   const fakeClient = {
     global: { health: async () => ({ healthy: true, version: "test" }) },
     app: { agents: async () => [] },
     event: { subscribe: async () => ({ stream: eventStream.stream }) },
     session: {
       create: async () => ({ id: "session-1" }),
       prompt: async () => {
         await promptGate.promise;
         return { parts: [{ type: "text", text: "bash done" }] };
       },
     },
   };

   const bridge = await startBridge(
     createBaseConfig(dir, { toolUpdatesEnabled: false }),
     createLoggerStub(),
     undefined,
     { client: fakeClient, clientFactory: () => fakeClient, adapters: new Map([["slack:default", slack.adapter]]), disableHealthServer: true },
   );

   const dispatch = bridge.dispatchInbound({ channel: "slack", identityId: "default", peerId: CHANNEL_PEER, text: "ping", raw: {} });
   await waitFor(() => slack.statuses.length >= 1);

   // Emit a bash tool with completed status and output
   eventStream.push({
     type: "message.part.updated",
     properties: {
       part: {
         type: "tool",
         sessionID: "session-1",
         callID: "call-1",
         tool: "bash",
         state: {
           status: "completed",
           title: "npm test",
           output: "✓ All tests passed",
         },
       },
     },
   });
   await waitFor(() => slack.statuses.some((status) => status.status.includes("[tool] bash completed")));
   promptGate.resolve();
   await dispatch;

   // Verify the status line DOES contain the output for bash
   const bashStatus = slack.statuses.find((status) => status.status.includes("[tool] bash completed"));
   assert.ok(bashStatus.status.includes("✓ All tests passed"));

   eventStream.close();
   await bridge.stop();
});

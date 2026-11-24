import assert from "node:assert/strict";
import { test } from "bun:test";

import { createSendMessageHandler } from "../../dist/health-send-message.js";

// A fan-out send to several bound conversations can partly succeed, so this
// handler reports per-target and per-part results instead of throwing. These
// tests pin that a partial failure stays partial and is attributed correctly.

function makeSend(overrides = {}) {
  const delivered = [];
  const upserted = [];
  const deletedBindings = [];
  const deletedSessions = [];
  const subscribed = [];
  const adapters = new Map(overrides.adapters ?? [["slack:i1", { name: "slack", identityId: "i1" }]]);
  const deps = {
    store: {
      listBindings: () => overrides.bindings ?? [],
      upsertBinding: (...args) => upserted.push(args),
      deleteBinding: (...args) => deletedBindings.push(args),
      deleteSession: (...args) => deletedSessions.push(args),
    },
    adapters,
    adapterKey: (channel, identityId) => `${channel}:${identityId}`,
    normalizeIdentityId: (value) => (typeof value === "string" && value.trim() ? value.trim() : "default"),
    normalizeDirectory: (input) => input.replace(/\/+$/, ""),
    resolveScopedDirectory: (input) =>
      input.startsWith("/outside")
        ? { ok: false, error: "Directory must stay within workspace root: /w" }
        : { ok: true, directory: `/w/${input.replace(/^\/+/, "")}` },
    listIdentityConfigs: () => overrides.identityConfigs ?? [],
    resolveOutboundParts: async (_directory, input) =>
      input.parts ?? [{ type: "text", text: input.text ?? "" }],
    // `options` is captured because it carries the control-plane flags: a send
    // that went out with display:true would reach the user as a chat message,
    // and a double that drops the argument cannot tell that apart from a
    // correct send.
    deliverParts: async (channel, identityId, peerId, parts, options) => {
      delivered.push({ channel, identityId, peerId, parts, options });
      const fail = overrides.failFor?.(peerId);
      if (fail) {
        return {
          attemptedParts: parts.length,
          sentParts: 0,
          partResults: parts.map((part, index) => ({ index, type: part.type, sent: false, error: fail })),
        };
      }
      return {
        attemptedParts: parts.length,
        sentParts: parts.length,
        partResults: parts.map((part, index) => ({ index, type: part.type, sent: true })),
      };
    },
    ensureEventSubscription: (directory) => subscribed.push(directory),
    invalidTelegramPeerIdError: () => Object.assign(new Error("Invalid Telegram peerId"), { status: 400 }),
    workspaceRoot: "/w",
    workspaceRootNormalized: "/w",
  };
  return {
    send: createSendMessageHandler(deps),
    delivered,
    upserted,
    deletedBindings,
    deletedSessions,
    subscribed,
    adapters,
  };
}

// ------------------------------------------------------------------ validation

test("an unknown channel is a 400", async () => {
  const h = makeSend();
  await assert.rejects(
    () => h.send({ channel: "discord", peerId: "C1" }),
    (error) => {
      assert.equal(error.message, "Invalid channel");
      assert.equal(error.status, 400, "an unknown channel is a client error, not a 500");
      return true;
    },
  );
});

test("either a directory or a peerId is required", async () => {
  const h = makeSend();
  await assert.rejects(() => h.send({ channel: "slack" }), /directory or peerId is required/);
});

test("a Telegram peerId must be numeric", async () => {
  const h = makeSend();
  await assert.rejects(() => h.send({ channel: "telegram", peerId: "nope" }), /Invalid Telegram peerId/);
});

test("a directory outside the workspace root is a 400", async () => {
  const h = makeSend();
  await assert.rejects(
    () => h.send({ channel: "slack", directory: "/outside/x", text: "hi" }),
    (error) => {
      assert.equal(error.status, 400);
      return true;
    },
  );
});

// --------------------------------------------------------------- direct send

test("a direct send delivers to the one peer and reports it sent", async () => {
  const h = makeSend();
  const result = await h.send({ channel: "slack", identityId: "i1", peerId: "C1", text: "hi" });
  assert.equal(result.attempted, 1);
  assert.equal(result.sent, 1);
  assert.equal(result.failures, undefined);
  assert.deepEqual(result.targets[0].partResults, [{ index: 0, type: "text", sent: true }]);
  assert.equal(h.delivered[0].peerId, "C1");
});

test("a direct send is system output that is not displayed as a chat message", async () => {
  const h = makeSend();
  await h.send({ channel: "slack", identityId: "i1", peerId: "C1", text: "hi" });
  assert.equal(h.delivered.length, 1);
  // The claim in the name is display:false. Counting deliveries does not test
  // it: a send that surfaced in chat would also count one.
  assert.deepEqual(h.delivered[0].options, { kind: "system", display: false });
});

test("a failed direct send reports sent:0 with the failure reason", async () => {
  const h = makeSend({ failFor: (peerId) => (peerId === "C1" ? "channel_not_found" : null) });
  const result = await h.send({ channel: "slack", identityId: "i1", peerId: "C1", text: "hi" });
  assert.equal(result.sent, 0);
  assert.deepEqual(result.failures, [{ identityId: "i1", peerId: "C1", error: "channel_not_found" }]);
});

test("a direct send with no adapter running at all reports a reason and no targets", async () => {
  const h = makeSend({ adapters: [] });
  const result = await h.send({ channel: "slack", peerId: "C1", text: "hi" });
  assert.equal(result.attempted, 0);
  assert.deepEqual(result.targets, []);
  assert.equal(result.reason, "No slack adapter is running for direct send");
});

test("a direct send to an identity whose adapter is gone reports per-part failures", async () => {
  const h = makeSend({ adapters: [["slack:other", { name: "slack", identityId: "other" }]] });
  const result = await h.send({ channel: "slack", identityId: "i1", peerId: "C1", text: "hi" });
  assert.equal(result.sent, 0);
  assert.equal(result.targets[0].partResults[0].error, "Adapter not running");
  assert.equal(result.targets[0].partResults[0].retryable, false);
  assert.deepEqual(h.delivered, [], "nothing is attempted against a missing adapter");
});

test("autoBind records the binding and subscribes before sending", async () => {
  const h = makeSend();
  await h.send({ channel: "slack", identityId: "i1", peerId: "C1", directory: "proj", text: "hi", autoBind: true });
  assert.deepEqual(h.upserted, [["slack", "i1", "C1", "/w/proj"]]);
  assert.deepEqual(h.deletedSessions, [["slack", "i1", "C1"]]);
  assert.deepEqual(h.subscribed, ["/w/proj"]);
});

test("autoBind without a directory binds nothing", async () => {
  const h = makeSend();
  await h.send({ channel: "slack", identityId: "i1", peerId: "C1", text: "hi", autoBind: true });
  assert.deepEqual(h.upserted, []);
});

test("without autoBind a direct send leaves bindings alone", async () => {
  const h = makeSend();
  await h.send({ channel: "slack", identityId: "i1", peerId: "C1", directory: "proj", text: "hi" });
  assert.deepEqual(h.upserted, []);
});

// ------------------------------------------------------- identity resolution

test("an identity configured for the directory and running is preferred", async () => {
  const h = makeSend({
    adapters: [
      ["slack:other", { name: "slack", identityId: "other" }],
      ["slack:match", { name: "slack", identityId: "match" }],
    ],
    identityConfigs: [
      { id: "nodir", directory: "" },
      { id: "match", directory: "/w/proj" },
    ],
  });
  const result = await h.send({ channel: "slack", peerId: "C1", directory: "proj", text: "hi" });
  assert.equal(result.identityId, "match");
});

test("a configured identity whose adapter is not running is skipped", async () => {
  const h = makeSend({
    adapters: [["slack:running", { name: "slack", identityId: "running" }]],
    identityConfigs: [{ id: "stopped", directory: "/w/proj" }],
  });
  const result = await h.send({ channel: "slack", peerId: "C1", directory: "proj", text: "hi" });
  assert.equal(result.identityId, "running", "falls back to any running adapter");
});

test("an adapter on another channel is not used", async () => {
  const h = makeSend({ adapters: [["telegram:t", { name: "telegram", identityId: "t" }]] });
  const result = await h.send({ channel: "slack", peerId: "C1", text: "hi" });
  assert.equal(result.reason, "No slack adapter is running for direct send");
});

// ------------------------------------------------------------------- fan-out

test("no bound conversations reports a reason rather than failing", async () => {
  const h = makeSend({ bindings: [] });
  const result = await h.send({ channel: "slack", directory: "proj", text: "hi" });
  assert.equal(result.attempted, 0);
  assert.equal(result.reason.includes("No bound conversations for slack"), true);
});

test("the reason names the identity when one was given", async () => {
  const h = makeSend({ bindings: [] });
  const result = await h.send({ channel: "slack", identityId: "i1", directory: "proj", text: "hi" });
  assert.equal(result.reason.includes("slack/i1"), true);
});

test("a fan-out delivers to every binding and counts each one", async () => {
  const h = makeSend({
    bindings: [
      { channel: "slack", identity_id: "i1", peer_id: "C1" },
      { channel: "slack", identity_id: "i1", peer_id: "C2" },
    ],
  });
  const result = await h.send({ channel: "slack", directory: "proj", text: "hi" });
  assert.equal(result.attempted, 2);
  assert.equal(result.sent, 2);
  assert.deepEqual(h.delivered.map((d) => d.peerId), ["C1", "C2"]);
  // Fan-out is a second deliverParts call site, so it can drift from the direct
  // send independently. Asserted here too rather than trusting the one above.
  assert.deepEqual(
    h.delivered.map((d) => d.options),
    [
      { kind: "system", display: false },
      { kind: "system", display: false },
    ],
  );
});

test("one failing target does not stop the others, and is attributed", async () => {
  const h = makeSend({
    bindings: [
      { channel: "slack", identity_id: "i1", peer_id: "C1" },
      { channel: "slack", identity_id: "i1", peer_id: "C2" },
      { channel: "slack", identity_id: "i1", peer_id: "C3" },
    ],
    failFor: (peerId) => (peerId === "C2" ? "is_archived" : null),
  });
  const result = await h.send({ channel: "slack", directory: "proj", text: "hi" });
  assert.equal(result.attempted, 3);
  assert.equal(result.sent, 2, "a partial fan-out stays partial");
  assert.deepEqual(result.failures, [{ identityId: "i1", peerId: "C2", error: "is_archived" }]);
  assert.equal(result.targets.length, 3);
});

test("a binding whose adapter is not running fails only that target", async () => {
  const h = makeSend({
    bindings: [
      { channel: "slack", identity_id: "i1", peer_id: "C1" },
      { channel: "slack", identity_id: "gone", peer_id: "C2" },
    ],
  });
  const result = await h.send({ channel: "slack", directory: "proj", text: "hi" });
  assert.equal(result.sent, 1);
  assert.deepEqual(result.failures, [{ identityId: "gone", peerId: "C2", error: "Adapter not running" }]);
});

test("an undeliverable Telegram binding is removed rather than retried forever", async () => {
  const h = makeSend({
    adapters: [["telegram:i1", { name: "telegram", identityId: "i1" }]],
    bindings: [{ channel: "telegram", identity_id: "i1", peer_id: "not-numeric" }],
  });
  const result = await h.send({ channel: "telegram", directory: "proj", text: "hi" });
  assert.deepEqual(h.deletedBindings, [["telegram", "i1", "not-numeric"]]);
  assert.deepEqual(h.deletedSessions, [["telegram", "i1", "not-numeric"]], "the session holds the same dead peer");
  assert.equal(result.targets[0].partResults[0].code, "invalid_target");
  assert.equal(result.sent, 0);
});

test("explicit parts are sent instead of text", async () => {
  const h = makeSend();
  const parts = [{ type: "text", text: "a" }, { type: "file", filePath: "/w/f.png" }];
  const result = await h.send({ channel: "slack", identityId: "i1", peerId: "C1", parts });
  assert.deepEqual(h.delivered[0].parts, parts);
  assert.equal(result.targets[0].attemptedParts, 2);
});

test("the reported directory falls back to the workspace root for a direct send", async () => {
  const h = makeSend();
  const result = await h.send({ channel: "slack", identityId: "i1", peerId: "C1", text: "hi" });
  assert.equal(result.directory, "/w");
});

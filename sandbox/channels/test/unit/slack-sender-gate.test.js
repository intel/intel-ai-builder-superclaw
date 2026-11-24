import assert from "node:assert/strict";
import { test } from "bun:test";

import { createSlackAdapter } from "../../dist/slack.js";
import { createSlackSenderAccess } from "../../dist/slack-senders.js";

function loggerStub() {
  const logger = {
    child() { return logger; },
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
  return logger;
}

async function startAdapter(slackSenders) {
  const inbound = [];
  const fake = { slackDown: false, failedPosts: 0 };

  class FakeWebClient {
    constructor() {
      this.posts = [];
      this.auth = { test: async () => ({ ok: true, user_id: "UBOT" }) };
      this.chat = {
        postMessage: async (payload) => {
          if (fake.slackDown) {
            fake.failedPosts += 1;
            throw new Error("channel_not_found");
          }
          this.posts.push(payload);
          return { ok: true, ts: "1700000000.999999" };
        },
      };
      fake.web = this;
    }
  }

  class FakeSocketModeClient {
    constructor() {
      this.handlers = new Map();
      fake.socket = this;
    }
    on(event, handler) {
      this.handlers.set(event, handler);
    }
    async start() {}
    async disconnect() {}
    async emit(event, payload) {
      await this.handlers.get(event)?.({ ack: async () => {}, event: payload });
    }
  }

  const adapter = createSlackAdapter(
    { id: "ws_a", botToken: "xoxb-test", appToken: "xapp-test", enabled: true },
    { groupsEnabled: false, slackSenders },
    loggerStub(),
    async (message) => inbound.push(message),
    { WebClient: FakeWebClient, SocketModeClient: FakeSocketModeClient },
  );
  await adapter.start();
  // The notice is sent without blocking the event handler; let it land.
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { inbound, fake, settle };
}

function noSenders() {
  return createSlackSenderAccess({ env: [], saved: [], persist() {} });
}

test("an unapproved DM is held, listed as pending, and answered with a notice only once", async () => {
  const slackSenders = noSenders();
  const { inbound, fake, settle } = await startAdapter(slackSenders);

  await fake.socket.emit("message", { type: "message", channel: "D123", user: "U9", text: "hi", ts: "1700000000.000001" });
  await fake.socket.emit("message", { type: "message", channel: "D123", user: "U9", text: "hello?", ts: "1700000000.000002" });
  await settle();

  assert.equal(inbound.length, 0);
  assert.equal(fake.web.posts.length, 1);
  assert.equal(fake.web.posts[0].channel, "D123");
  assert.match(fake.web.posts[0].text, /U9/);
  assert.match(fake.web.posts[0].text, /Settings → Connections → Slack/);
  assert.deepEqual(slackSenders.list().pending.map((entry) => [entry.userId, entry.identityId, entry.attempts]), [["U9", "ws_a", 2]]);
});

test("a notice Slack failed to deliver is sent again on the sender's next message", async () => {
  const { fake, settle } = await startAdapter(noSenders());

  fake.slackDown = true;
  await fake.socket.emit("message", { type: "message", channel: "D123", user: "U9", text: "hi", ts: "1700000000.000001" });
  await settle();
  assert.ok(fake.failedPosts > 0);
  assert.equal(fake.web.posts.length, 0);

  fake.slackDown = false;
  await fake.socket.emit("message", { type: "message", channel: "D123", user: "U9", text: "hello?", ts: "1700000000.000002" });
  await settle();
  assert.equal(fake.web.posts.length, 1);

  await fake.socket.emit("message", { type: "message", channel: "D123", user: "U9", text: "anyone?", ts: "1700000000.000003" });
  await settle();
  assert.equal(fake.web.posts.length, 1);
});

test("an unapproved mention gets the notice in its thread", async () => {
  const { inbound, fake, settle } = await startAdapter(noSenders());

  await fake.socket.emit("app_mention", { type: "app_mention", channel: "C123", user: "U9", text: "<@UBOT> run tests", ts: "1700000000.000100" });
  await settle();

  assert.equal(inbound.length, 0);
  assert.equal(fake.web.posts.length, 1);
  assert.equal(fake.web.posts[0].channel, "C123");
  assert.equal(fake.web.posts[0].thread_ts, "1700000000.000100");
});

test("an unapproved sender's ordinary channel message is neither answered nor listed", async () => {
  const slackSenders = noSenders();
  const { inbound, fake, settle } = await startAdapter(slackSenders);

  await fake.socket.emit("message", { type: "message", channel: "C123", user: "U9", text: "lunch?", ts: "1700000000.000200" });
  await settle();

  assert.equal(inbound.length, 0);
  assert.equal(fake.web.posts.length, 0);
  assert.deepEqual(slackSenders.list().pending, []);
});

test("approving a sender admits their next message without restarting the adapter", async () => {
  const slackSenders = noSenders();
  const { inbound, fake } = await startAdapter(slackSenders);

  await fake.socket.emit("message", { type: "message", channel: "D123", user: "U9", text: "hi", ts: "1700000000.000001" });
  slackSenders.allow("U9");
  await fake.socket.emit("message", { type: "message", channel: "D123", user: "U9", text: "hi again", ts: "1700000000.000003" });

  assert.equal(inbound.length, 1);
  assert.equal(inbound[0].text, "hi again");
});

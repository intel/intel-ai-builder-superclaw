import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { MediaStore } from "../../dist/media-store.js";
import { createSlackSenderAccess } from "../../dist/slack-senders.js";
import {
  createSlackAdapter,
  formatSlackPeerId,
  parseSlackPeerId,
  stripSlackMention,
} from "../../dist/slack.js";
import { resolveModelPrefix, stripModelPrefix } from "../../dist/text.js";

function createLoggerStub() {
  const base = {
    child() {
      return base;
    },
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
  return base;
}

test("slack peerId encoding", () => {
  assert.deepEqual(parseSlackPeerId("D123"), { channelId: "D123" });
  assert.deepEqual(parseSlackPeerId("C123|1700000000.000100"), {
    channelId: "C123",
    threadTs: "1700000000.000100",
  });
  assert.equal(formatSlackPeerId({ channelId: "D123" }), "D123");
  assert.equal(
    formatSlackPeerId({ channelId: "C123", threadTs: "1700000000.000100" }),
    "C123|1700000000.000100",
  );
});

test("stripSlackMention removes bot mention and punctuation", () => {
  assert.equal(stripSlackMention("<@UBOT> hello", "UBOT"), "hello");
  assert.equal(stripSlackMention("<@UBOT>: hello", "UBOT"), "hello");
  assert.equal(stripSlackMention("<@UBOT> - hello", "UBOT"), "hello");
  assert.equal(stripSlackMention("hello", "UBOT"), "hello");
});

// The DM path calls this on every message (#2956 item 1), so text that never
// carried a mention must come back trim-only. Stripping a leading `-` there
// turned `- /reset` into the /reset command and `-42` into `42`.
test("stripSlackMention leaves leading punctuation when there is no mention", () => {
  assert.equal(stripSlackMention("- /reset", "UBOT"), "- /reset");
  assert.equal(stripSlackMention("-42", "UBOT"), "-42");
  assert.equal(stripSlackMention(": not a command", "UBOT"), ": not a command");
  assert.equal(stripSlackMention(", hello", "UBOT"), ", hello");
  assert.equal(stripSlackMention("  - /reset  ", "UBOT"), "- /reset");
  // Unresolved bot id: nothing can be a mention, so nothing is stripped.
  assert.equal(stripSlackMention("- /reset", null), "- /reset");
  // A mention elsewhere in the text is still removed, and the leading
  // punctuation that belongs to the user's own text survives.
  assert.equal(stripSlackMention("- hi <@UBOT>", "UBOT"), "- hi");
});

// A dash with whitespace after a leading mention is the mention's separator.
// A dash glued to the next token is the user's text: `<@UBOT> -42` used to
// reach the model as `42`.
test("stripSlackMention keeps a dash that is part of the next token", () => {
  assert.equal(stripSlackMention("<@UBOT> -42", "UBOT"), "-42");
  assert.equal(stripSlackMention("<@UBOT>-42", "UBOT"), "-42");
  assert.equal(stripSlackMention("<@UBOT> - hello", "UBOT"), "hello");
  assert.equal(stripSlackMention("<@UBOT>: /help", "UBOT"), "/help");
  assert.equal(stripSlackMention("<@UBOT>, hi", "UBOT"), "hi");
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// A start that outlasts its caller used to finish with `started = true` on a
// socket stop() had already given up on, because stop() returns immediately
// while `started` is still false. The late success has to disconnect, and a
// message on that socket must not be acked or dispatched.
test("a stop during start disconnects the socket when start later succeeds", async () => {
  const logger = createLoggerStub();
  const inbound = [];
  let socket;
  const gate = deferred();

  class FakeWebClient {
    constructor() {
      this.auth = { test: async () => ({ ok: true, user_id: "UBOT" }) };
    }
  }

  class FakeSocketModeClient {
    constructor() {
      this.handlers = new Map();
      this.disconnects = 0;
      this.connected = false;
      this.acks = [];
      this.startCalls = 0;
      socket = this;
    }
    on(event, handler) {
      this.handlers.set(event, handler);
    }
    start() {
      this.startCalls += 1;
      return gate.promise.then(() => {
        this.connected = true;
      });
    }
    async disconnect() {
      this.disconnects += 1;
      this.connected = false;
    }
    async emit(event, args) {
      const handler = this.handlers.get(event);
      if (handler) await handler(args);
    }
  }

  const adapter = createSlackAdapter(
    { id: "default", botToken: "xoxb-test", appToken: "xapp-test", enabled: true },
    { groupsEnabled: false },
    logger,
    async (msg) => inbound.push(msg),
    { WebClient: FakeWebClient, SocketModeClient: FakeSocketModeClient },
  );

  const pending = adapter.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(socket.startCalls, 1, "start is in flight");

  await adapter.stop();
  assert.equal(socket.disconnects, 0, "nothing to disconnect until the socket has actually started");

  gate.resolve();
  await pending;
  assert.equal(socket.connected, false);
  assert.equal(socket.disconnects, 1, "the late success disconnects itself");

  await socket.emit("message", {
    ack: async () => socket.acks.push("late"),
    event: { type: "message", channel: "D123", user: "U1", text: "hi", ts: "1" },
  });
  await socket.emit("app_mention", {
    ack: async () => socket.acks.push("mention"),
    event: { type: "app_mention", channel: "C123", user: "U2", text: "<@UBOT> hi", ts: "2" },
  });
  assert.deepEqual(inbound, []);
  assert.deepEqual(socket.acks, []);
});

// stop() clears `started` before disconnect returns. An event in that window
// used to reach handleInbound on a socket the bridge had already dropped.
test("inbound handlers ignore events once stop has begun", async () => {
  const logger = createLoggerStub();
  const inbound = [];
  let socket;
  const gate = deferred();

  class FakeWebClient {
    constructor() {
      this.auth = { test: async () => ({ ok: true, user_id: "UBOT" }) };
    }
  }

  class FakeSocketModeClient {
    constructor() {
      this.handlers = new Map();
      this.acks = [];
      socket = this;
    }
    on(event, handler) {
      this.handlers.set(event, handler);
    }
    async start() {
      this.connected = true;
    }
    disconnect() {
      return gate.promise;
    }
    async emit(event, args) {
      const handler = this.handlers.get(event);
      if (handler) await handler(args);
    }
  }

  const adapter = createSlackAdapter(
    { id: "default", botToken: "xoxb-test", appToken: "xapp-test", enabled: true },
    { groupsEnabled: false },
    logger,
    async (msg) => inbound.push(msg),
    { WebClient: FakeWebClient, SocketModeClient: FakeSocketModeClient },
  );

  await adapter.start();
  const stopping = adapter.stop();
  await socket.emit("message", {
    ack: async () => socket.acks.push("during-stop"),
    event: { type: "message", channel: "D123", user: "U1", text: "hi", ts: "1" },
  });
  assert.deepEqual(inbound, []);
  assert.deepEqual(socket.acks, []);
  gate.resolve();
  await stopping;
});

test("createSlackAdapter routes DM + app mentions", async () => {
  const logger = createLoggerStub();
  const inbound = [];
  let socketInstance;
  let webInstance;

  class FakeWebClient {
    constructor(token) {
      this.token = token;
      this.posts = [];
      this.uploads = [];
      webInstance = this;
      this.auth = {
        test: async () => ({ ok: true, user_id: "UBOT" }),
      };
      this.chat = {
        postMessage: async (payload) => {
          this.posts.push(payload);
          return { ok: true };
        },
      };
      this.files = {
        uploadV2: async (payload) => {
          this.uploads.push(payload);
          return { ok: true };
        },
      };
    }
  }

  class FakeSocketModeClient {
    constructor(opts) {
      this.opts = opts;
      this.handlers = new Map();
      this.acks = [];
      socketInstance = this;
    }
    on(event, handler) {
      this.handlers.set(event, handler);
    }
    async start() {
      this.started = true;
    }
    async ack(envelopeId) {
      this.acks.push(envelopeId);
    }
    async disconnect() {
      this.started = false;
    }
    async emit(event, args) {
      const handler = this.handlers.get(event);
      if (handler) {
        await handler(args);
      }
    }
  }

  const adapter = createSlackAdapter(
    {
      id: "default",
      botToken: "xoxb-test",
      appToken: "xapp-test",
      enabled: true,
    },
    { groupsEnabled: false, slackSenders: createSlackSenderAccess({ env: ["U1", "U2"], saved: [], persist() {} }) },
    logger,
    async (msg) => inbound.push(msg),
    { WebClient: FakeWebClient, SocketModeClient: FakeSocketModeClient },
  );

  await adapter.start();
  assert.equal(socketInstance.started, true);

  await socketInstance.emit("message", {
    ack: async () => socketInstance.acks.push("a1"),
    event: {
      type: "message",
      channel: "D123",
      user: "U1",
      text: "hi",
      ts: "1700000000.000001",
    },
  });

  await socketInstance.emit("app_mention", {
    ack: async () => socketInstance.acks.push("a2"),
    event: {
      type: "app_mention",
      channel: "C123",
      user: "U2",
      text: "<@UBOT> run tests",
      ts: "1700000000.000100",
    },
  });

  assert.deepEqual(socketInstance.acks, ["a1", "a2"]);
  assert.equal(inbound.length, 2);
  assert.equal(inbound[0].channel, "slack");
  assert.equal(inbound[0].identityId, "default");
  assert.equal(inbound[0].peerId, "D123|1700000000.000001"); // DM peerId now carries a self-synthesized thread_ts (threadTs || ts).
  assert.equal(inbound[0].text, "hi");
  assert.equal(inbound[1].identityId, "default");
  assert.equal(inbound[1].peerId, "C123|1700000000.000100");
  assert.equal(inbound[1].text, "run tests");

  await adapter.sendText("D123", "ok");
  await adapter.sendText("C123|1700000000.000100", "ok-thread");

  const mediaFile = path.join(os.tmpdir(), `opencode-router-slack-${Date.now()}.txt`);
  fs.writeFileSync(mediaFile, "hello from file");
  const mediaResult = await adapter.sendMessage("D123", {
    parts: [{ type: "file", filePath: mediaFile }],
  });

  assert.equal(webInstance.posts.length, 2);
  assert.equal(webInstance.posts[0].channel, "D123");
  assert.equal(webInstance.posts[0].text, "ok");
  assert.ok(Array.isArray(webInstance.posts[0].blocks), "DM post should include blocks array");
  assert.equal(webInstance.posts[0].blocks[0].type, "markdown");
  assert.equal(webInstance.posts[0].blocks[0].text, "ok");

  assert.equal(webInstance.posts[1].channel, "C123");
  assert.equal(webInstance.posts[1].text, "ok-thread");
  assert.equal(webInstance.posts[1].thread_ts, "1700000000.000100");
  assert.ok(Array.isArray(webInstance.posts[1].blocks), "thread post should include blocks array");
  assert.equal(webInstance.posts[1].blocks[0].type, "markdown");
  assert.equal(webInstance.posts[1].blocks[0].text, "ok-thread");
  assert.equal(mediaResult.sentParts, 1);
  assert.equal(webInstance.uploads.length, 1);
  assert.equal(webInstance.uploads[0].channel_id, "D123");
  assert.equal(Buffer.isBuffer(webInstance.uploads[0].file), true);
  assert.equal(webInstance.uploads[0].filename, path.basename(mediaFile));

  await adapter.stop();
  assert.equal(socketInstance.started, false);
});

test("DM message strips a leading @bot mention so slash commands dispatch (#2956 item 1)", async () => {
  const logger = createLoggerStub();
  const inbound = [];
  let socketInstance;

  class FakeWebClient {
    constructor(token) {
      this.token = token;
      this.auth = { test: async () => ({ ok: true, user_id: "UBOT" }) };
      this.chat = { postMessage: async () => ({ ok: true }) };
    }
  }

  class FakeSocketModeClient {
    constructor(opts) {
      this.opts = opts;
      this.handlers = new Map();
      socketInstance = this;
    }
    on(event, handler) {
      this.handlers.set(event, handler);
    }
    async start() {}
    async disconnect() {}
    async emit(event, args) {
      const handler = this.handlers.get(event);
      if (handler) await handler(args);
    }
  }

  const adapter = createSlackAdapter(
    { id: "default", botToken: "xoxb-test", appToken: "xapp-test", enabled: true },
    { groupsEnabled: false, slackSenders: createSlackSenderAccess({ env: ["U1"], saved: [], persist() {} }) },
    logger,
    async (msg) => inbound.push(msg),
    { WebClient: FakeWebClient, SocketModeClient: FakeSocketModeClient },
  );

  await adapter.start();

  // Typing "/help" directly in a Slack DM never reaches the bridge (Slack intercepts it
  // client-side), so the only reachable path is "@bot /help", which arrives as a mention token.
  await socketInstance.emit("message", {
    ack: async () => {},
    event: {
      type: "message",
      channel: "D123",
      user: "U1",
      text: "<@UBOT> /help",
      ts: "1700000000.000002",
    },
  });

  assert.equal(inbound.length, 1);
  assert.equal(inbound[0].text, "/help");
});

test("complex text sends blocks alongside text", async () => {
  const logger = createLoggerStub();
  let webInstance;

  class FakeWebClient {
    constructor(token) {
      this.token = token;
      this.posts = [];
      webInstance = this;
      this.auth = {
        test: async () => ({ ok: true, user_id: "UBOT" }),
      };
      this.chat = {
        postMessage: async (payload) => {
          this.posts.push(payload);
          return { ok: true };
        },
      };
    }
  }

  class FakeSocketModeClient {
    constructor(opts) {
      this.opts = opts;
      this.handlers = new Map();
    }
    on(event, handler) {
      this.handlers.set(event, handler);
    }
    async start() {}
    async disconnect() {}
  }

  const adapter = createSlackAdapter(
    {
      id: "default",
      botToken: "xoxb-test",
      appToken: "xapp-test",
      enabled: true,
    },
    { groupsEnabled: false },
    logger,
    async () => {},
    { WebClient: FakeWebClient, SocketModeClient: FakeSocketModeClient },
  );

  await adapter.sendMessage("D123", {
    parts: [
      {
        type: "text",
        text: "## Hello\n\n```python\nprint(42)\n```",
      },
    ],
  });

  assert.equal(webInstance.posts.length, 1);
  assert.equal(webInstance.posts[0].channel, "D123");
  assert.equal(webInstance.posts[0].text, "## Hello\n\n```python\nprint(42)\n```");
  assert.ok(Array.isArray(webInstance.posts[0].blocks), "blocks should be an array");
  assert.ok(webInstance.posts[0].blocks.length > 0, "blocks should have at least one block");
});

test("plain text now includes a markdown block", async () => {
  const logger = createLoggerStub();
  let webInstance;

  class FakeWebClient {
    constructor(token) {
      this.token = token;
      this.posts = [];
      webInstance = this;
      this.auth = {
        test: async () => ({ ok: true, user_id: "UBOT" }),
      };
      this.chat = {
        postMessage: async (payload) => {
          this.posts.push(payload);
          return { ok: true };
        },
      };
    }
  }

  class FakeSocketModeClient {
    constructor(opts) {
      this.opts = opts;
      this.handlers = new Map();
    }
    on(event, handler) {
      this.handlers.set(event, handler);
    }
    async start() {}
    async disconnect() {}
  }

  const adapter = createSlackAdapter(
    {
      id: "default",
      botToken: "xoxb-test",
      appToken: "xapp-test",
      enabled: true,
    },
    { groupsEnabled: false },
    logger,
    async () => {},
    { WebClient: FakeWebClient, SocketModeClient: FakeSocketModeClient },
  );

  await adapter.sendMessage("D123", {
    parts: [{ type: "text", text: "simple message" }],
  });

  assert.equal(webInstance.posts.length, 1);
  assert.equal(webInstance.posts[0].channel, "D123");
  assert.equal(webInstance.posts[0].text, "simple message");
  assert.ok(Array.isArray(webInstance.posts[0].blocks), "blocks should be present for plain text");
  assert.equal(webInstance.posts[0].blocks.length, 1);
  assert.equal(webInstance.posts[0].blocks[0].type, "markdown");
  assert.equal(webInstance.posts[0].blocks[0].text, "simple message");
});

test("DM and channel-thread produce identical blocks for the same text", async () => {
  const logger = createLoggerStub();
  let webInstance;

  class FakeWebClient {
    constructor(token) {
      this.token = token;
      this.posts = [];
      webInstance = this;
      this.auth = {
        test: async () => ({ ok: true, user_id: "UBOT" }),
      };
      this.chat = {
        postMessage: async (payload) => {
          this.posts.push(payload);
          return { ok: true };
        },
      };
    }
  }

  class FakeSocketModeClient {
    constructor(opts) {
      this.opts = opts;
      this.handlers = new Map();
    }
    on(event, handler) {
      this.handlers.set(event, handler);
    }
    async start() {}
    async disconnect() {}
  }

  const adapter = createSlackAdapter(
    { id: "default", botToken: "xoxb-test", appToken: "xapp-test", enabled: true },
    { groupsEnabled: false },
    logger,
    async () => {},
    { WebClient: FakeWebClient, SocketModeClient: FakeSocketModeClient },
  );

  const markdownText = "**bold** and\n- item one\n- item two";

  await adapter.sendText("D123", markdownText);
  await adapter.sendText("C123|1700000000.000100", markdownText);

  assert.equal(webInstance.posts.length, 2);

  const dmPost = webInstance.posts[0];
  const threadPost = webInstance.posts[1];

  assert.equal(dmPost.text, markdownText);
  assert.equal(threadPost.text, markdownText);

  assert.ok(Array.isArray(dmPost.blocks), "DM should have blocks");
  assert.ok(Array.isArray(threadPost.blocks), "thread should have blocks");
  assert.equal(dmPost.blocks.length, threadPost.blocks.length);
  assert.equal(dmPost.blocks[0].type, "markdown");
  assert.equal(threadPost.blocks[0].type, "markdown");
  assert.equal(dmPost.blocks[0].text, threadPost.blocks[0].text);

  assert.equal(dmPost.thread_ts, undefined);
  assert.equal(threadPost.thread_ts, "1700000000.000100");
});

test("updateMessage calls chat.update with correct payload", async () => {
  const logger = createLoggerStub();
  let webInstance;

  class FakeWebClient {
    constructor(token) {
      this.token = token;
      this.posts = [];
      this.updates = [];
      webInstance = this;
      this.auth = { test: async () => ({ ok: true, user_id: "UBOT" }) };
      this.chat = {
        postMessage: async (payload) => {
          this.posts.push(payload);
          return { ok: true };
        },
        update: async (payload) => {
          this.updates.push(payload);
          return { ok: true, ts: payload.ts };
        },
      };
    }
  }

  class FakeSocketModeClient {
    constructor(opts) { this.opts = opts; this.handlers = new Map(); }
    on(event, handler) { this.handlers.set(event, handler); }
    async start() {}
    async disconnect() {}
  }

  const adapter = createSlackAdapter(
    { id: "default", botToken: "xoxb-test", appToken: "xapp-test", enabled: true },
    { groupsEnabled: false },
    logger,
    async () => {},
    { WebClient: FakeWebClient, SocketModeClient: FakeSocketModeClient },
  );

  await adapter.start();
  await adapter.updateMessage("C123|1700000000.000100", "168000000.000200", {
    text: "Updated text",
    blocks: [{ type: "markdown", text: "hello" }],
  });

  assert.equal(webInstance.updates.length, 1);
  assert.equal(webInstance.updates[0].channel, "C123");
  assert.equal(webInstance.updates[0].ts, "168000000.000200");
  assert.equal(webInstance.updates[0].text, "Updated text");
  assert.ok(Array.isArray(webInstance.updates[0].blocks));
  assert.equal(webInstance.updates[0].blocks[0].type, "markdown");

  await adapter.stop();
});

test("setStatus sends loading_messages for non-empty status; clearStatus omits it", async () => {
  const logger = createLoggerStub();
  let webInstance;
  class FakeWebClient {
    constructor(token) {
      this.token = token;
      this.statusCalls = [];
      webInstance = this;
      this.auth = { test: async () => ({ ok: true, user_id: "UBOT" }) };
      this.chat = { postMessage: async () => ({ ok: true }) };
      this.assistant = { threads: { setStatus: async (payload) => { this.statusCalls.push(payload); return { ok: true }; } } };
    }
  }
  class FakeSocketModeClient {
    constructor(opts) { this.opts = opts; this.handlers = new Map(); }
    on(event, handler) { this.handlers.set(event, handler); }
    async start() {}
    async disconnect() {}
  }
  const adapter = createSlackAdapter(
    { id: "default", botToken: "xoxb-test", appToken: "xapp-test", enabled: true },
    { groupsEnabled: false },
    logger,
    async () => {},
    { WebClient: FakeWebClient, SocketModeClient: FakeSocketModeClient },
  );
  const setResult = await adapter.setStatus("D123|1700000000.000100", "1700000000.000100", "Reading files…");
  const clearResult = await adapter.clearStatus("D123|1700000000.000100", "1700000000.000100");
  assert.equal(setResult.ok, true);
  assert.equal(clearResult.ok, true);
  assert.equal(webInstance.statusCalls.length, 2);
  const active = webInstance.statusCalls[0];
  assert.equal(active.channel_id, "D123");
  assert.equal(active.thread_ts, "1700000000.000100");
  assert.equal(active.status, "Reading files…");
  assert.deepEqual(active.loading_messages, ["Reading files…"]);
  const cleared = webInstance.statusCalls[1];
  assert.equal(cleared.channel_id, "D123");
  assert.equal(cleared.thread_ts, "1700000000.000100");
  assert.equal(cleared.status, "");
  assert.equal("loading_messages" in cleared, false);
});

test("block parser error falls back to text-only delivery", async () => {
  const logger = createLoggerStub();
  let webInstance;

  class FakeWebClient {
    constructor(token) {
      this.token = token;
      this.posts = [];
      webInstance = this;
      this.auth = {
        test: async () => ({ ok: true, user_id: "UBOT" }),
      };
      this.chat = {
        postMessage: async (payload) => {
          this.posts.push(payload);
          return { ok: true };
        },
      };
    }
  }

  class FakeSocketModeClient {
    constructor(opts) {
      this.opts = opts;
      this.handlers = new Map();
    }
    on(event, handler) {
      this.handlers.set(event, handler);
    }
    async start() {}
    async disconnect() {}
  }

  const adapter = createSlackAdapter(
    {
      id: "default",
      botToken: "xoxb-test",
      appToken: "xapp-test",
      enabled: true,
    },
    { groupsEnabled: false },
    logger,
    async () => {},
    { WebClient: FakeWebClient, SocketModeClient: FakeSocketModeClient },
  );

  // Send text that looks complex (has markdown) but should still deliver even if parser fails
  await adapter.sendMessage("D123", {
    parts: [{ type: "text", text: "## Heading\n\ntext" }],
  });

  // Should have delivered the message (with or without blocks - main point is it didn't crash)
  assert.ok(webInstance.posts.length >= 1, "message should be delivered despite any parser issues");
  assert.equal(webInstance.posts[0].channel, "D123");
  assert.ok(webInstance.posts[0].text, "text property should always be present");
});

test("createSlackAdapter downloads inbound files into media store", async () => {
  const logger = createLoggerStub();
  const inbound = [];
  let socketInstance;

  class FakeWebClient {
    constructor(token) {
      this.token = token;
      this.auth = {
        test: async () => ({ ok: true, user_id: "UBOT" }),
      };
      this.chat = {
        postMessage: async () => ({ ok: true }),
      };
      this.files = {
        uploadV2: async () => ({ ok: true }),
      };
    }
  }

  class FakeSocketModeClient {
    constructor() {
      this.handlers = new Map();
      socketInstance = this;
    }
    on(event, handler) {
      this.handlers.set(event, handler);
    }
    async start() {}
    async disconnect() {}
    async emit(event, args) {
      const handler = this.handlers.get(event);
      if (handler) {
        await handler(args);
      }
    }
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-router-slack-media-"));
  const mediaStore = new MediaStore(path.join(tempDir, "media"));
  await mediaStore.ensureReady();
  let downloadSignal;
  const downloadInbound = mediaStore.downloadInbound.bind(mediaStore);
  mediaStore.downloadInbound = async (input) => {
    downloadSignal = input.signal;
    return downloadInbound(input);
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response("downloaded-slack-file", {
      status: 200,
      headers: { "content-type": "text/plain" },
    });

  try {
    const adapter = createSlackAdapter(
      {
        id: "default",
        botToken: "xoxb-test",
        appToken: "xapp-test",
        enabled: true,
      },
      { groupsEnabled: false, slackSenders: createSlackSenderAccess({ env: ["U1"], saved: [], persist() {} }) },
      logger,
      async (msg) => inbound.push(msg),
      { WebClient: FakeWebClient, SocketModeClient: FakeSocketModeClient },
      mediaStore,
    );

    await adapter.start();

    await socketInstance.emit("message", {
      ack: async () => {},
      event: {
        type: "message",
        subtype: "file_share",
        channel: "D123",
        user: "U1",
        files: [
          {
            id: "F1",
            url_private_download: "https://files.example.com/download/F1",
            name: "report.txt",
            mimetype: "text/plain",
            size: 22,
          },
        ],
      },
    });

    assert.equal(inbound.length, 1);
    const mediaPart = inbound[0].parts.find((part) => part.type === "media");
    assert.ok(mediaPart);
    assert.equal(mediaPart.media.status, "ready");
    const downloadedPath = mediaPart.media.filePath;
    assert.ok(downloadedPath);
    assert.equal(fs.existsSync(downloadedPath), true);
    assert.equal(fs.readFileSync(downloadedPath, "utf8"), "downloaded-slack-file");
    assert.ok(downloadSignal instanceof AbortSignal);

    await adapter.stop();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function createSlackTestAdapter() {
  const logger = createLoggerStub();
  let webInstance;

  class FakeWebClient {
    constructor(token) {
      this.token = token;
      this.posts = [];
      webInstance = this;
      this.auth = {
        test: async () => ({ ok: true, user_id: "UBOT" }),
      };
      this.chat = {
        postMessage: async (payload) => {
          this.posts.push(payload);
          return { ok: true };
        },
      };
    }
  }

  class FakeSocketModeClient {
    constructor(opts) {
      this.opts = opts;
      this.handlers = new Map();
    }
    on(event, handler) {
      this.handlers.set(event, handler);
    }
    async start() {}
    async disconnect() {}
  }

  const adapter = createSlackAdapter(
    { id: "default", botToken: "xoxb-test", appToken: "xapp-test", enabled: true },
    { groupsEnabled: false },
    logger,
    async () => {},
    { WebClient: FakeWebClient, SocketModeClient: FakeSocketModeClient },
  );

  return { adapter, web: webInstance };
}

test("sendMessage with meta.model appends a context block", async () => {
  const { adapter, web } = createSlackTestAdapter();

  await adapter.sendMessage("D123", {
    parts: [{ type: "text", text: "Hello world" }],
    meta: { model: "gpt-5.4-mini" },
  });

  assert.equal(web.posts.length, 1);
  assert.equal(web.posts[0].channel, "D123");
  assert.equal(web.posts[0].text, "Hello world");
  const blocks = web.posts[0].blocks;
  assert.ok(Array.isArray(blocks), "blocks should be an array");
  const last = blocks[blocks.length - 1];
  assert.equal(last.type, "context");
  assert.equal(last.elements[0].type, "mrkdwn");
  assert.equal(last.elements[0].text, "Model: *gpt-5.4-mini*");
});

test("sendMessage without meta does not include a context block", async () => {
  const { adapter, web } = createSlackTestAdapter();

  await adapter.sendMessage("D123", {
    parts: [{ type: "text", text: "Hello world" }],
  });

  const blocks = web.posts[0].blocks;
  if (Array.isArray(blocks)) {
    const hasContext = blocks.some((b) => b.type === "context");
    assert.equal(hasContext, false);
  }
});

test("sendMessage with meta.model as empty string does not include a context block", async () => {
  const { adapter, web } = createSlackTestAdapter();

  await adapter.sendMessage("D123", {
    parts: [{ type: "text", text: "Hello world" }],
    meta: { model: "" },
  });

  const blocks = web.posts[0].blocks;
  if (Array.isArray(blocks)) {
    const hasContext = blocks.some((b) => b.type === "context");
    assert.equal(hasContext, false);
  }
});

test("sendMessage retry-without-blocks drops the context block", async () => {
  const logger = createLoggerStub();
  let webInstance;

  class FakeWebClient {
    constructor(token) {
      this.token = token;
      this.posts = [];
      this.attempts = 0;
      webInstance = this;
      this.auth = {
        test: async () => ({ ok: true, user_id: "UBOT" }),
      };
      this.chat = {
        postMessage: async (payload) => {
          this.attempts += 1;
          if (payload.blocks) {
            throw new Error("invalid_blocks");
          }
          this.posts.push(payload);
          return { ok: true };
        },
      };
    }
  }

  class FakeSocketModeClient {
    constructor(opts) {
      this.opts = opts;
      this.handlers = new Map();
    }
    on(event, handler) {
      this.handlers.set(event, handler);
    }
    async start() {}
    async disconnect() {}
  }

  const adapter = createSlackAdapter(
    { id: "default", botToken: "xoxb-test", appToken: "xapp-test", enabled: true },
    { groupsEnabled: false },
    logger,
    async () => {},
    { WebClient: FakeWebClient, SocketModeClient: FakeSocketModeClient },
  );

  await adapter.sendMessage("D123", {
    parts: [{ type: "text", text: "Hello world" }],
    meta: { model: "gpt-5.4-mini" },
  });

  assert.equal(webInstance.attempts, 2);
  assert.equal(webInstance.posts.length, 1);
  assert.equal(webInstance.posts[0].channel, "D123");
  assert.equal(webInstance.posts[0].text, "Hello world");
  assert.equal(webInstance.posts[0].blocks, undefined);
});

// R1: mirror of the bridge finalize decision (src/bridge.ts ~2387-2393) — the
// label defaults to `${providerID}/${modelID}`, but a router-alias session
// prefers the concrete model resolved from the reply prefix. Keep in sync.
function isAliasModelForTest(model) {
  if (!model) return false;
  const modelID = model.modelID.trim();
  if (modelID === "auto" || modelID === "local-model" || modelID === "cloud-model") return true;
  return false;
}

function computeFinalizeModel(reply, sessionModel) {
  let model = sessionModel ? `${sessionModel.providerID}/${sessionModel.modelID}` : undefined;
  if (isAliasModelForTest(sessionModel)) {
    const concrete = resolveModelPrefix(reply);
    if (concrete) model = concrete;
  }
  return model;
}

async function postFinalized(reply, sessionModel) {
  const { adapter, web } = createSlackTestAdapter();
  const model = computeFinalizeModel(reply, sessionModel);
  await adapter.sendMessage("D123", {
    parts: [{ type: "text", text: stripModelPrefix(reply) }],
    meta: { model },
  });
  return web.posts[0];
}

test("R1(a) alias session resolves the concrete model from the reply prefix", async () => {
  const post = await postFinalized("[deepseek/deepseek-chat] Hello", {
    providerID: "llmrouter",
    modelID: "auto",
  });
  const blocks = post.blocks;
  const last = blocks[blocks.length - 1];
  assert.equal(last.type, "context");
  assert.equal(last.elements[0].type, "mrkdwn");
  assert.equal(last.elements[0].text, "Model: *deepseek/deepseek-chat*");
});

test("R1(b) alias session with no reply prefix falls back to the alias label", async () => {
  const post = await postFinalized("Hello", { providerID: "llmrouter", modelID: "auto" });
  const blocks = post.blocks;
  const last = blocks[blocks.length - 1];
  assert.equal(last.type, "context");
  assert.equal(last.elements[0].text, "Model: *llmrouter/auto*");
});

test("R1(c) alias session rejects the litellm placeholder and uses the alias label", async () => {
  const reply = "[System: Empty message content sanitised to satisfy protocol] Hi";
  assert.equal(resolveModelPrefix(reply), null);
  const post = await postFinalized(reply, { providerID: "llmrouter", modelID: "auto" });
  const blocks = post.blocks;
  const last = blocks[blocks.length - 1];
  assert.equal(last.type, "context");
  assert.equal(last.elements[0].text, "Model: *llmrouter/auto*");
});

test("R1(d) pinned concrete session skips prefix resolution and keeps its label", async () => {
  const post = await postFinalized("[deepseek/deepseek-chat] Hello", {
    providerID: "anthropic",
    modelID: "claude-opus-4-5",
  });
  const blocks = post.blocks;
  const last = blocks[blocks.length - 1];
  assert.equal(last.type, "context");
  assert.equal(last.elements[0].text, "Model: *anthropic/claude-opus-4-5*");
});

test("R1(e) resolved-alias reply still has the model prefix stripped from the body", async () => {
  const post = await postFinalized("[deepseek/deepseek-chat] Hello", {
    providerID: "llmrouter",
    modelID: "auto",
  });
  assert.equal(post.text, "Hello");
  assert.equal(post.blocks[0].type, "markdown");
  assert.equal(post.blocks[0].text, "Hello");
});

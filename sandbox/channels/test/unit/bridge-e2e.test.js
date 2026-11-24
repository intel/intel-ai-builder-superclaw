import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { startBridge } from "../../dist/bridge.js";
import { createMemoryStore } from "./memory-store.js";

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

test("bridge end-to-end: inbound -> prompt -> outbound", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-e2e-"));
  const dbPath = path.join(dir, "opencode-router.db");

  const sent = [];
  const slackAdapter = {
    key: "slack:default",
    name: "slack",
    identityId: "default",
    maxTextLength: 39_000,
    async start() {},
    async stop() {},
    async sendText(peerId, text) {
      sent.push({ peerId, text });
    },
  };

  const fakeClient = {
    global: {
      health: async () => ({ healthy: true, version: "test" }),
    },
    // Engine file API: an empty workspace (no MCP config, no policy).
    file: { list: async () => [], read: async () => ({ type: "text", content: "" }) },
    session: {
      create: async () => ({ id: "session-1" }),
      prompt: async () => ({ parts: [{ type: "text", text: "pong" }] }),
    },
  };

  const bridge = await startBridge(
    {
      configPath: path.join(dir, "opencode-router.json"),
      configFile: { version: 1 },
      opencodeUrl: "http://127.0.0.1:4096",
      opencodeDirectory: dir,
      telegramBots: [],
      slackApps: [],
      dataDir: dir,
      dbPath,
      logFile: path.join(dir, "opencode-router.log"),
      toolUpdatesEnabled: false,
      groupsEnabled: false,
      permissionMode: "allow",
      toolOutputLimit: 1200,
      healthPort: undefined,
      logLevel: "silent",
    },
    createLoggerStub(),
    undefined,
    {
      client: fakeClient,
      store: createMemoryStore(),
      clientFactory: () => fakeClient,
      adapters: new Map([["slack:default", slackAdapter]]),
      disableEventStream: true,
      disableHealthServer: true,
    },
  );

  await bridge.dispatchInbound({ channel: "slack", identityId: "default", peerId: "D123", text: "ping", raw: {} });

  assert.equal(sent.length, 2);
  assert.equal(sent[0].peerId, "D123");
  assert.equal(sent[1].peerId, "D123");
  assert.ok(sent[0].text.includes("Session started."));
  assert.equal(sent[1].text, "pong");

  await bridge.stop();
});

test("bridge silently recovers from empty prompt replies by recreating session", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-e2e-empty-"));
  const dbPath = path.join(dir, "opencode-router.db");

  const sent = [];
  let sessionCounter = 0;
  const slackAdapter = {
    key: "slack:default",
    name: "slack",
    identityId: "default",
    maxTextLength: 39_000,
    async start() {},
    async stop() {},
    async sendText(peerId, text) {
      sent.push({ peerId, text });
    },
  };

  const fakeClient = {
    global: {
      health: async () => ({ healthy: true, version: "test" }),
    },
    // Engine file API: an empty workspace (no MCP config, no policy).
    file: { list: async () => [], read: async () => ({ type: "text", content: "" }) },
    session: {
      create: async () => {
        sessionCounter += 1;
        return { id: `session-${sessionCounter}` };
      },
      prompt: async ({ sessionID }) => {
        if (sessionID === "session-1") {
          return { parts: [] };
        }
        return { parts: [{ type: "text", text: "fresh reply" }] };
      },
    },
  };

  const bridge = await startBridge(
    {
      configPath: path.join(dir, "opencode-router.json"),
      configFile: { version: 1 },
      opencodeUrl: "http://127.0.0.1:4096",
      opencodeDirectory: dir,
      telegramBots: [],
      slackApps: [],
      dataDir: dir,
      dbPath,
      logFile: path.join(dir, "opencode-router.log"),
      toolUpdatesEnabled: false,
      groupsEnabled: false,
      permissionMode: "allow",
      toolOutputLimit: 1200,
      healthPort: undefined,
      logLevel: "silent",
    },
    createLoggerStub(),
    undefined,
    {
      client: fakeClient,
      store: createMemoryStore(),
      clientFactory: () => fakeClient,
      adapters: new Map([["slack:default", slackAdapter]]),
      disableEventStream: true,
      disableHealthServer: true,
    },
  );

  await bridge.dispatchInbound({ channel: "slack", identityId: "default", peerId: "D123", text: "first", raw: {} });

  assert.equal(sessionCounter, 2);
  const sessionStartedCount = sent.filter((m) => m.text.includes("Session started.")).length;
  assert.equal(sessionStartedCount, 1);
  assert.ok(
    !sent.some((message) =>
      message.text.includes("No visible response was generated."),
    ),
    `unexpected reset message in: ${JSON.stringify(sent.map((m) => m.text))}`,
  );
  assert.ok(sent.some((message) => message.text === "fresh reply"));

  await bridge.stop();
});

test("bridge silently recovers when prompt throws NotFoundError for stale session", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-e2e-notfound-"));
  const dbPath = path.join(dir, "opencode-router.db");

  const sent = [];
  let sessionCounter = 0;
  const slackAdapter = {
    key: "slack:default",
    name: "slack",
    identityId: "default",
    maxTextLength: 39_000,
    async start() {},
    async stop() {},
    async sendText(peerId, text) {
      sent.push({ peerId, text });
    },
  };

  const fakeClient = {
    global: {
      health: async () => ({ healthy: true, version: "test" }),
    },
    // Engine file API: an empty workspace (no MCP config, no policy).
    file: { list: async () => [], read: async () => ({ type: "text", content: "" }) },
    session: {
      create: async () => {
        sessionCounter += 1;
        return { id: `session-${sessionCounter}` };
      },
      prompt: async ({ sessionID }) => {
        if (sessionID === "session-1") {
          // Mimic the OpenCode SDK: throwOnError + responseStyle:"data" throws
          // the parsed JSON body, NOT an Error instance.
          // eslint-disable-next-line no-throw-literal
          throw { name: "NotFoundError", data: { message: "Session session-1 not found" } };
        }
        return { parts: [{ type: "text", text: "after recovery" }] };
      },
    },
  };

  const bridge = await startBridge(
    {
      configPath: path.join(dir, "opencode-router.json"),
      configFile: { version: 1 },
      opencodeUrl: "http://127.0.0.1:4096",
      opencodeDirectory: dir,
      telegramBots: [],
      slackApps: [],
      dataDir: dir,
      dbPath,
      logFile: path.join(dir, "opencode-router.log"),
      toolUpdatesEnabled: false,
      groupsEnabled: false,
      permissionMode: "allow",
      toolOutputLimit: 1200,
      healthPort: undefined,
      logLevel: "silent",
    },
    createLoggerStub(),
    undefined,
    {
      client: fakeClient,
      store: createMemoryStore(),
      clientFactory: () => fakeClient,
      adapters: new Map([["slack:default", slackAdapter]]),
      disableEventStream: true,
      disableHealthServer: true,
    },
  );

  await bridge.dispatchInbound({ channel: "slack", identityId: "default", peerId: "D123", text: "hello", raw: {} });

  assert.equal(sessionCounter, 2);
  const sessionStartedCount = sent.filter((m) => m.text.includes("Session started.")).length;
  assert.equal(sessionStartedCount, 1);
  assert.ok(
    !sent.some((m) => m.text.includes("Error:") || m.text.includes("No visible response was generated.")),
    `unexpected error/reset message in: ${JSON.stringify(sent.map((m) => m.text))}`,
  );
  assert.ok(sent.some((message) => message.text === "after recovery"));

  await bridge.stop();
});

test("bridge promotes leading visible agent mention into structured prompt agent", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-e2e-agent-mention-"));
  const dbPath = path.join(dir, "opencode-router.db");

  const sent = [];
  const promptCalls = [];
  const slackAdapter = {
    key: "slack:default",
    name: "slack",
    identityId: "default",
    maxTextLength: 39_000,
    async start() {},
    async stop() {},
    async sendText(peerId, text) {
      sent.push({ peerId, text });
    },
  };

  const fakeClient = {
    global: {
      health: async () => ({ healthy: true, version: "test" }),
    },
    app: {
      agents: async () => ([
        { name: "local-deep-research", mode: "primary", hidden: false },
        { name: "plan", mode: "primary", hidden: true },
      ]),
    },
    // Engine file API: an empty workspace (no MCP config, no policy).
    file: { list: async () => [], read: async () => ({ type: "text", content: "" }) },
    session: {
      create: async () => ({ id: "session-1" }),
      prompt: async (args) => {
        promptCalls.push(args);
        return { parts: [{ type: "text", text: "pong" }] };
      },
    },
  };

  const bridge = await startBridge(
    {
      configPath: path.join(dir, "opencode-router.json"),
      configFile: { version: 1 },
      opencodeUrl: "http://127.0.0.1:4096",
      opencodeDirectory: dir,
      telegramBots: [],
      slackApps: [],
      dataDir: dir,
      dbPath,
      logFile: path.join(dir, "opencode-router.log"),
      toolUpdatesEnabled: false,
      groupsEnabled: false,
      permissionMode: "allow",
      toolOutputLimit: 1200,
      healthPort: undefined,
      logLevel: "silent",
    },
    createLoggerStub(),
    undefined,
    {
      client: fakeClient,
      store: createMemoryStore(),
      clientFactory: () => fakeClient,
      adapters: new Map([["slack:default", slackAdapter]]),
      disableEventStream: true,
      disableHealthServer: true,
    },
  );

  await bridge.dispatchInbound({
    channel: "slack",
    identityId: "default",
    peerId: "D123",
    text: "@local-deep-research what's special for you",
    raw: {},
  });

  assert.equal(promptCalls.length, 1);
  assert.equal(promptCalls[0].agent, "local-deep-research");
  assert.equal(promptCalls[0].system, undefined);
  assert.equal(promptCalls[0].parts[0].text, "@local-deep-research what's special for you");
  assert.equal(sent.at(-1)?.text, "pong");

  await bridge.stop();
});

test("bridge ignores leading hidden agent mentions", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-e2e-hidden-agent-"));
  const dbPath = path.join(dir, "opencode-router.db");

  const promptCalls = [];
  const slackAdapter = {
    key: "slack:default",
    name: "slack",
    identityId: "default",
    maxTextLength: 39_000,
    async start() {},
    async stop() {},
    async sendText() {},
  };

  const fakeClient = {
    global: {
      health: async () => ({ healthy: true, version: "test" }),
    },
    app: {
      agents: async () => ([{ name: "plan", mode: "primary", hidden: true }]),
    },
    // Engine file API: an empty workspace (no MCP config, no policy).
    file: { list: async () => [], read: async () => ({ type: "text", content: "" }) },
    session: {
      create: async () => ({ id: "session-1" }),
      prompt: async (args) => {
        promptCalls.push(args);
        return { parts: [{ type: "text", text: "pong" }] };
      },
    },
  };

  const bridge = await startBridge(
    {
      configPath: path.join(dir, "opencode-router.json"),
      configFile: { version: 1 },
      opencodeUrl: "http://127.0.0.1:4096",
      opencodeDirectory: dir,
      telegramBots: [],
      slackApps: [],
      dataDir: dir,
      dbPath,
      logFile: path.join(dir, "opencode-router.log"),
      toolUpdatesEnabled: false,
      groupsEnabled: false,
      permissionMode: "allow",
      toolOutputLimit: 1200,
      healthPort: undefined,
      logLevel: "silent",
    },
    createLoggerStub(),
    undefined,
    {
      client: fakeClient,
      store: createMemoryStore(),
      clientFactory: () => fakeClient,
      adapters: new Map([["slack:default", slackAdapter]]),
      disableEventStream: true,
      disableHealthServer: true,
    },
  );

  await bridge.dispatchInbound({
    channel: "slack",
    identityId: "default",
    peerId: "D123",
    text: "@plan what's special for you",
    raw: {},
  });

  assert.equal(promptCalls.length, 1);
  assert.equal(promptCalls[0].agent, undefined);
  assert.equal(typeof promptCalls[0].system, "string");
  assert.equal(promptCalls[0].parts[0].text, "@plan what's special for you");

  await bridge.stop();
});

test("bridge reuses recovered session for queued messages instead of recreating again", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-e2e-queued-"));
  const dbPath = path.join(dir, "opencode-router.db");

  const sent = [];
  let sessionCounter = 0;
  const slackAdapter = {
    key: "slack:default",
    name: "slack",
    identityId: "default",
    maxTextLength: 39_000,
    async start() {},
    async stop() {},
    async sendText(peerId, text) {
      sent.push({ peerId, text });
    },
  };

  const fakeClient = {
    global: {
      health: async () => ({ healthy: true, version: "test" }),
    },
    // Engine file API: an empty workspace (no MCP config, no policy).
    file: { list: async () => [], read: async () => ({ type: "text", content: "" }) },
    session: {
      create: async () => {
        sessionCounter += 1;
        return { id: `session-${sessionCounter}` };
      },
      prompt: async ({ sessionID }) => {
        if (sessionID === "session-1") {
          // eslint-disable-next-line no-throw-literal
          throw { name: "NotFoundError", data: { message: "Session session-1 not found" } };
        }
        return { parts: [{ type: "text", text: `reply on ${sessionID}` }] };
      },
    },
  };

  const bridge = await startBridge(
    {
      configPath: path.join(dir, "opencode-router.json"),
      configFile: { version: 1 },
      opencodeUrl: "http://127.0.0.1:4096",
      opencodeDirectory: dir,
      telegramBots: [],
      slackApps: [],
      dataDir: dir,
      dbPath,
      logFile: path.join(dir, "opencode-router.log"),
      toolUpdatesEnabled: false,
      groupsEnabled: false,
      permissionMode: "allow",
      toolOutputLimit: 1200,
      healthPort: undefined,
      logLevel: "silent",
    },
    createLoggerStub(),
    undefined,
    {
      client: fakeClient,
      store: createMemoryStore(),
      clientFactory: () => fakeClient,
      adapters: new Map([["slack:default", slackAdapter]]),
      disableEventStream: true,
      disableHealthServer: true,
    },
  );

  await Promise.all([
    bridge.dispatchInbound({ channel: "slack", identityId: "default", peerId: "D123", text: "first", raw: {} }),
    bridge.dispatchInbound({ channel: "slack", identityId: "default", peerId: "D123", text: "second", raw: {} }),
  ]);

  assert.equal(sessionCounter, 2);
  assert.ok(sent.some((m) => m.text === "reply on session-2"));
  assert.ok(!sent.some((m) => m.text === "reply on session-3"));

  await bridge.stop();
});

test("a FILE: reply pointing outside the outbox is refused, not delivered", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-e2e-file-"));
  const outbox = path.join(dir, "outbox");
  fs.mkdirSync(outbox);
  const secret = path.join(dir, "opencode-router.json");
  fs.writeFileSync(secret, "{}");

  const sent = [];
  const files = [];
  const slackAdapter = {
    key: "slack:default",
    name: "slack",
    identityId: "default",
    maxTextLength: 39_000,
    async start() {},
    async stop() {},
    async sendText(peerId, text) {
      sent.push({ peerId, text });
    },
    async sendFile(peerId, filePath) {
      files.push(filePath);
    },
  };
  const fakeClient = {
    global: { health: async () => ({ healthy: true, version: "test" }) },
    // Engine file API: an empty workspace (no MCP config, no policy).
    file: { list: async () => [], read: async () => ({ type: "text", content: "" }) },
    session: {
      create: async () => ({ id: "session-1" }),
      prompt: async () => ({ parts: [{ type: "text", text: `FILE:${secret}` }] }),
    },
  };

  const bridge = await startBridge(
    {
      configPath: path.join(dir, "opencode-router.json"),
      configFile: { version: 1 },
      opencodeUrl: "http://127.0.0.1:4096",
      opencodeDirectory: dir,
      telegramBots: [],
      slackApps: [],
      dataDir: dir,
      dbPath: path.join(dir, "opencode-router.db"),
      logFile: path.join(dir, "opencode-router.log"),
      outboxDir: outbox,
      toolUpdatesEnabled: false,
      groupsEnabled: false,
      permissionMode: "allow",
      toolOutputLimit: 1200,
      healthPort: undefined,
      logLevel: "silent",
    },
    createLoggerStub(),
    undefined,
    {
      client: fakeClient,
      store: createMemoryStore(),
      clientFactory: () => fakeClient,
      adapters: new Map([["slack:default", slackAdapter]]),
      disableEventStream: true,
      disableHealthServer: true,
    },
  );

  await bridge.dispatchInbound({ channel: "slack", identityId: "default", peerId: "D123", text: "ping", raw: {} });

  assert.deepEqual(files, []);
  assert.ok(sent.some((m) => m.text.includes("File not sent")));
  assert.equal(sent.some((m) => m.text.includes(secret)), false);

  await bridge.stop();
});

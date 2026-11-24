import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { startBridge } from "../../dist/bridge.js";
import { loadConfig } from "../../dist/config.js";
import { buildPermissionRules, channelDenyRules } from "../../dist/opencode.js";
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

const emptyWorkspaceFileApi = {
  list: async () => [],
  read: async () => ({ type: "text", content: "" }),
};

function baseEnv(dir) {
  return {
    OPENCODE_ROUTER_DATA_DIR: dir,
    OPENCODE_ROUTER_DB_PATH: path.join(dir, "opencode-router.db"),
    OPENCODE_ROUTER_CONFIG_PATH: path.join(dir, "opencode-router.json"),
    OPENCODE_DIRECTORY: dir,
    OPENCODE_URL: "http://127.0.0.1:4096",
    LOG_LEVEL: "silent",
  };
}

test("loadConfig parses PERMISSION_MODE=inherit", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-perm-"));
  fs.writeFileSync(path.join(dir, "opencode-router.json"), JSON.stringify({ version: 1 }));
  const config = loadConfig({ ...baseEnv(dir), PERMISSION_MODE: "inherit" });
  assert.equal(config.permissionMode, "inherit");
});

test("loadConfig defaults a missing permission mode to inherit", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-perm-default-"));
  assert.equal(loadConfig(baseEnv(dir)).permissionMode, "inherit");
});

test("loadConfig treats blank permission mode as unset", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-perm-blank-"));
  for (const value of ["", "  \t "]) {
    assert.equal(loadConfig({ ...baseEnv(dir), PERMISSION_MODE: value }).permissionMode, "inherit");
  }
});

test("loadConfig rejects an invalid permission mode with a clear error", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-perm-invalid-"));
  assert.throws(
    () => loadConfig({ ...baseEnv(dir), PERMISSION_MODE: "invalid" }),
    /Invalid PERMISSION_MODE\. Expected "allow", "deny" or "inherit"\./,
  );
});

test("loadConfig preserves explicit PERMISSION_MODE=allow", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-perm-allow-"));
  assert.equal(loadConfig({ ...baseEnv(dir), PERMISSION_MODE: "allow" }).permissionMode, "allow");
});

test("buildPermissionRules supports inherit", () => {
  assert.deepEqual(buildPermissionRules("inherit"), channelDenyRules());
  assert.deepEqual(buildPermissionRules("allow"), [
    { permission: "*", pattern: "*", action: "allow" },
    { permission: "webfetch", pattern: "*", action: "deny" },
    { permission: "websearch", pattern: "*", action: "deny" },
  ]);
  assert.deepEqual(buildPermissionRules("deny"), [
    { permission: "*", pattern: "*", action: "deny" },
  ]);
});

// channels sends this session-level `permission` ruleset on session.create and
// session.update, and it is the ONLY thing governing MCP tool availability
// unless/until the MCP tool gate (sandbox/channels/src/mcp-tool-gate.ts) has
// something to project for a given prompt: a per-tool policy deny or a
// config-disabled server. When it does, the gate re-expresses this very
// ruleset (see shared/mcp-policy's reexpressRuleset) rather than replacing it
// wholesale, specifically so a narrower base ruleset here is not silently
// reopened or ignored by the gate's own map.
//
// Consequence: MCP tool availability on Slack/Telegram still rides on the `*`
// permission pattern below for any turn the gate has nothing to deny.
// Narrowing it to an explicit tool list switches MCP off on those turns
// SILENTLY - no error, no failing runtime path.
test("channels allow/deny rulesets still cover MCP tool names", () => {
  for (const mode of ["allow", "deny"]) {
    const rules = buildPermissionRules(mode);
    assert.ok(
      rules?.some((rule) => rule.permission === "*"),
      `permissionMode="${mode}" no longer resolves MCP tools through a "*" permission ` +
        "pattern, so Slack/Telegram just lost (or silently kept) MCP access. Pick one: " +
        "keep a '*' rule, add explicit '<mcp>_*' rules here, or route channels through " +
        "the openwork-server proxy so mcp-tool-gate.ts owns the decision.",
    );
  }
});

test("bridge createSession sends only the web-tool denies in inherit mode", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-inherit-"));
  const dbPath = path.join(dir, "opencode-router.db");

  const createCalls = [];
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
    // Engine file API: an empty workspace (no MCP config, no policy).
    file: { list: async () => [], read: async () => ({ type: "text", content: "" }) },
    session: {
      create: async (input) => {
        createCalls.push(input);
        return { id: "session-1" };
      },
      prompt: async () => ({ parts: [{ type: "text", text: "ok" }] }),
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
      permissionMode: "inherit",
      toolOutputLimit: 1200,
      healthPort: undefined,
      logLevel: "silent",
    },
    createLoggerStub(),
    undefined,
    {
      store: createMemoryStore(),
      clientFactory: () => fakeClient,
      adapters: new Map([["slack:default", slackAdapter]]),
      disableEventStream: true,
      disableHealthServer: true,
    },
  );

  await bridge.dispatchInbound({ channel: "slack", identityId: "default", peerId: "D123", text: "ping", raw: {} });

  assert.equal(createCalls.length, 1);
  assert.deepEqual(createCalls[0].permission, channelDenyRules());

  await bridge.stop();
});

test("slack custom agent mention uses inherit semantics even when global mode is allow", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-custom-agent-"));
  const dbPath = path.join(dir, "opencode-router.db");

  const createCalls = [];
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
      agents: async () => ([
        { name: "my-agent", mode: "primary", hidden: false },
        { name: "superclaw-default", mode: "primary", hidden: false },
      ]),
    },
    // Engine file API: an empty workspace (no MCP config, no policy).
    file: { list: async () => [], read: async () => ({ type: "text", content: "" }) },
    session: {
      create: async (input) => {
        createCalls.push(input);
        return { id: "session-1" };
      },
      prompt: async () => ({ parts: [{ type: "text", text: "ok" }] }),
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
    text: "@my-agent hi",
    raw: {},
  });

  assert.equal(createCalls.length, 1);
  assert.deepEqual(createCalls[0].permission, channelDenyRules());

  await bridge.stop();
});

test("slack built-in protected-pipeline-agent keeps configured permission mode", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-built-in-agent-"));
  const dbPath = path.join(dir, "opencode-router.db");

  const createCalls = [];
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
      agents: async () => ([
        { name: "protected-pipeline-agent", mode: "primary", hidden: false },
      ]),
    },
    // Engine file API: an empty workspace (no MCP config, no policy).
    file: { list: async () => [], read: async () => ({ type: "text", content: "" }) },
    session: {
      create: async (input) => {
        createCalls.push(input);
        return { id: "session-1" };
      },
      prompt: async () => ({ parts: [{ type: "text", text: "ok" }] }),
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
    text: "@protected-pipeline-agent hi",
    raw: {},
  });

  assert.equal(createCalls.length, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(createCalls[0], "permission"), true);

  await bridge.stop();
});

test("slack @plan (hidden but invocable built-in) does NOT switch an existing session to inherit", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-plan-builtin-"));
  const dbPath = path.join(dir, "opencode-router.db");

  const createCalls = [];
  const updateCalls = [];
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
      // Real opencode returns `plan` WITHOUT hidden:true, so it resolves as a
      // leading mention. It must still be treated as a built-in.
      agents: async () => ([
        { name: "plan", mode: "primary" },
        { name: "superclaw-default", mode: "primary", hidden: false },
      ]),
    },
    // Engine file API: an empty workspace (no MCP config, no policy).
    file: { list: async () => [], read: async () => ({ type: "text", content: "" }) },
    session: {
      create: async (input) => {
        createCalls.push(input);
        return { id: `session-${createCalls.length}` };
      },
      update: async (input) => {
        updateCalls.push(input);
        return {};
      },
      prompt: async () => ({ parts: [{ type: "text", text: "ok" }] }),
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
      store: createMemoryStore(),
      clientFactory: () => fakeClient,
      adapters: new Map([["slack:default", slackAdapter]]),
      disableEventStream: true,
      disableHealthServer: true,
    },
  );

  // Establish an allow-mode session with a normal message first.
  await bridge.dispatchInbound({
    channel: "slack",
    identityId: "default",
    peerId: "D123",
    text: "hello",
    raw: {},
  });
  assert.equal(createCalls.length, 1);

  // Then @plan on the same peer: as a built-in it must reuse the session and
  // must NOT recreate or switch to inherit (this was the reported bug).
  await bridge.dispatchInbound({
    channel: "slack",
    identityId: "default",
    peerId: "D123",
    text: "@plan help me plan a trip",
    raw: {},
  });
  assert.equal(createCalls.length, 1);
  assert.equal(updateCalls.length, 0);

  await bridge.stop();
});

test("bridge reuses persisted inherit permission mode for existing sessions", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-inherit-persist-"));
  const dbPath = path.join(dir, "opencode-router.db");
  // One store for both bridges: the second must find the session the first one persisted.
  const store = createMemoryStore();

  const slackAdapter = {
    key: "slack:default",
    name: "slack",
    identityId: "default",
    maxTextLength: 39_000,
    async start() {},
    async stop() {},
    async sendText() {},
  };

  const firstRunCreateCalls = [];
  const firstRunClient = {
    global: {
      health: async () => ({ healthy: true, version: "test" }),
    },
    app: {
      agents: async () => ([
        { name: "my-agent", mode: "primary", hidden: false },
      ]),
    },
    // Engine file API: an empty workspace (no MCP config, no policy).
    file: { list: async () => [], read: async () => ({ type: "text", content: "" }) },
    session: {
      create: async (input) => {
        firstRunCreateCalls.push(input);
        return { id: "session-1" };
      },
      prompt: async () => ({ parts: [{ type: "text", text: "ok" }] }),
    },
  };

  const firstBridge = await startBridge(
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
      store,
      clientFactory: () => firstRunClient,
      adapters: new Map([["slack:default", slackAdapter]]),
      disableEventStream: true,
      disableHealthServer: true,
    },
  );

  await firstBridge.dispatchInbound({
    channel: "slack",
    identityId: "default",
    peerId: "D123",
    text: "@my-agent hi",
    raw: {},
  });
  assert.equal(firstRunCreateCalls.length, 1);
  assert.deepEqual(firstRunCreateCalls[0].permission, channelDenyRules());
  await firstBridge.stop();

  const secondRunCreateCalls = [];
  const secondRunPromptCalls = [];
  const secondRunUpdateCalls = [];
  const secondRunPermissionCalls = [];
  const secondRunSent = [];
  let releasePermissionEvent;
  let resolveEventSubscription;
  const eventSubscriptionReady = new Promise((resolve) => {
    resolveEventSubscription = resolve;
  });
  let resolvePermissionResponse;
  const permissionResponse = new Promise((resolve) => {
    resolvePermissionResponse = resolve;
  });
  const secondRunClient = {
    event: {
      subscribe: async (_query, { signal }) => ({
        stream: (async function* () {
          resolveEventSubscription();
          while (!signal.aborted) {
            const event = await new Promise((resolve) => {
              releasePermissionEvent = resolve;
              signal.addEventListener("abort", () => resolve(undefined), { once: true });
            });
            if (!event) return;
            yield event;
          }
        })(),
      }),
    },
    global: {
      health: async () => ({ healthy: true, version: "test" }),
    },
    app: {
      agents: async () => ([
        { name: "my-agent", mode: "primary", hidden: false },
      ]),
    },
    // Engine file API: an empty workspace (no MCP config, no policy).
    file: { list: async () => [], read: async () => ({ type: "text", content: "" }) },
    session: {
      get: async () => ({ permission: channelDenyRules() }),
      create: async (input) => {
        secondRunCreateCalls.push(input);
        return { id: "session-2" };
      },
      update: async (input) => {
        secondRunUpdateCalls.push(input);
        return {};
      },
      prompt: async (input) => {
        secondRunPromptCalls.push(input);
        releasePermissionEvent({
          type: "permission.asked",
          properties: { id: "permission-1", sessionID: input.sessionID, permission: "bash" },
        });
        await permissionResponse;
        return { parts: [{ type: "text", text: "ok" }] };
      },
    },
    permission: {
      respond: async (input) => {
        secondRunPermissionCalls.push(input);
        resolvePermissionResponse();
      },
    },
  };

  const secondBridge = await startBridge(
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
      store,
      clientFactory: () => secondRunClient,
      adapters: new Map([[
        "slack:default",
        { ...slackAdapter, async sendText(_peerId, text) { secondRunSent.push(text); } },
      ]]),
      disableHealthServer: true,
    },
  );

  await eventSubscriptionReady;

  await secondBridge.dispatchInbound({
    channel: "slack",
    identityId: "default",
    peerId: "D123",
    text: "@my-agent hi again",
    raw: {},
  });

  assert.equal(secondRunCreateCalls.length, 0);
  assert.equal(secondRunPromptCalls.length, 1);
  assert.equal(secondRunPromptCalls[0].sessionID, "session-1");
  // Reusing a session persisted by an earlier process appends the channel denies once.
  assert.deepEqual(secondRunUpdateCalls, [
    { sessionID: "session-1", permission: channelDenyRules() },
  ]);
  assert.deepEqual(secondRunPermissionCalls, [
    { sessionID: "session-1", permissionID: "permission-1", response: "reject" },
  ]);
  assert.ok(secondRunSent.some((text) => text.includes("requires approval")), JSON.stringify(secondRunSent));

  await secondBridge.stop();
}, 15_000);

test("allow-mode session is replaced before a later custom-agent mention", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-allow-to-inherit-"));
  const dbPath = path.join(dir, "opencode-router.db");

  const createCalls = [];
  const updateCalls = [];
  const promptCalls = [];
  const sent = [];
  const slackAdapter = {
    key: "slack:default",
    name: "slack",
    identityId: "default",
    maxTextLength: 39_000,
    async start() {},
    async stop() {},
    async sendText(_peerId, text) {
      sent.push(text);
    },
  };

  const fakeClient = {
    global: {
      health: async () => ({ healthy: true, version: "test" }),
    },
    app: {
      agents: async () => ([
        { name: "my-agent", mode: "primary", hidden: false },
        { name: "superclaw-default", mode: "primary", hidden: false },
      ]),
    },
    // Engine file API: an empty workspace (no MCP config, no policy).
    file: { list: async () => [], read: async () => ({ type: "text", content: "" }) },
    session: {
      create: async (input) => {
        createCalls.push(input);
        return { id: `session-${createCalls.length}` };
      },
      update: async (input) => {
        updateCalls.push(input);
        return {};
      },
      prompt: async (input) => {
        promptCalls.push(input);
        return { parts: [{ type: "text", text: "ok" }] };
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
      store: createMemoryStore(),
      clientFactory: () => fakeClient,
      adapters: new Map([["slack:default", slackAdapter]]),
      disableEventStream: true,
      disableHealthServer: true,
    },
  );

  // First a normal message: session created in allow mode (permission present).
  await bridge.dispatchInbound({
    channel: "slack",
    identityId: "default",
    peerId: "D123",
    text: "hello",
    raw: {},
  });
  assert.equal(createCalls.length, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(createCalls[0], "permission"), true);

  // A custom-agent mention needs inherit semantics. Since an update cannot
  // remove the earlier blanket allow, the channel moves this peer to a new session.
  await bridge.dispatchInbound({
    channel: "slack",
    identityId: "default",
    peerId: "D123",
    text: "@my-agent hi",
    raw: {},
  });

  assert.equal(createCalls.length, 2);
  assert.deepEqual(createCalls[1].permission, channelDenyRules());
  assert.deepEqual(updateCalls, []);
  assert.equal(promptCalls.at(-1).sessionID, "session-2");
  assert.ok(sent.some((text) => text.includes("previous history remains")), JSON.stringify(sent));

  await bridge.stop();
});

// OpenCode 1.18.25 `Permission.evaluate`: findLast over agent rules then session rules.
const evaluate = (tool, rules) => rules.findLast((r) => r.permission === "*" || r.permission === tool)?.action;

test("allow mode keeps normal and MCP tools allowed but the last match denies web tools", () => {
  const rules = buildPermissionRules("allow");
  for (const tool of ["bash", "edit", "read", "sc_fetch_url", "playwright_browser_navigate"]) {
    assert.equal(evaluate(tool, rules), "allow", tool);
  }
  for (const tool of ["webfetch", "websearch"]) assert.equal(evaluate(tool, rules), "deny", tool);
});

test("deny mode denies everything and inherit denies only the web tools", () => {
  assert.equal(evaluate("webfetch", buildPermissionRules("deny")), "deny");
  assert.equal(evaluate("bash", buildPermissionRules("deny")), "deny");
  const inherit = buildPermissionRules("inherit");
  for (const tool of ["webfetch", "websearch"]) assert.equal(evaluate(tool, inherit), "deny", tool);
  for (const tool of ["bash", "edit", "sc_fetch_url"]) {
    assert.equal(evaluate(tool, inherit), undefined, `${tool} is left to the agent's own block`);
  }
});

// ------------------------------------------------ sessions persisted before the channel denies (#3436)

function preUpgradeBridgeConfig(dir, permissionMode = "allow") {
  return {
    configPath: path.join(dir, "opencode-router.json"),
    configFile: { version: 1 },
    opencodeUrl: "http://127.0.0.1:4096",
    opencodeDirectory: dir,
    telegramBots: [],
    slackApps: [],
    dataDir: dir,
    dbPath: path.join(dir, "opencode-router.db"),
    logFile: path.join(dir, "opencode-router.log"),
    toolUpdatesEnabled: false,
    groupsEnabled: false,
    permissionMode,
    toolOutputLimit: 1200,
    healthPort: undefined,
    logLevel: "silent",
  };
}

// A session created by an earlier build: its stored ruleset is the bare blanket allow.
async function seedPreUpgradeSession(dir, store, slackAdapter) {
  const oldRuleset = [{ permission: "*", pattern: "*", action: "allow" }];
  const bridge = await startBridge(preUpgradeBridgeConfig(dir), createLoggerStub(), undefined, {
    store,
    clientFactory: () => ({
      file: emptyWorkspaceFileApi,
      global: { health: async () => ({ healthy: true, version: "test" }) },
      app: { agents: async () => [] },
      session: {
        create: async () => ({ id: "session-old" }),
        prompt: async () => ({ parts: [{ type: "text", text: "ok" }] }),
      },
    }),
    adapters: new Map([["slack:default", slackAdapter]]),
    disableEventStream: true,
    disableHealthServer: true,
  });
  await bridge.dispatchInbound({ channel: "slack", identityId: "default", peerId: "D123", text: "hi", raw: {} });
  await bridge.stop();
  return oldRuleset;
}

function makeSlackAdapter(sent) {
  return {
    key: "slack:default",
    name: "slack",
    identityId: "default",
    maxTextLength: 39_000,
    async start() {},
    async stop() {},
    async sendText(_peerId, text) {
      sent.push(text);
    },
  };
}

async function startBridgeWithStoredInheritSession({ dir, store, slackAdapter, session }) {
  store.upsertSession("slack", "default", "D123", "session-old", dir, "inherit");
  return startBridge(preUpgradeBridgeConfig(dir, "inherit"), createLoggerStub(), undefined, {
    store,
    clientFactory: () => ({
      file: emptyWorkspaceFileApi,
      global: { health: async () => ({ healthy: true, version: "test" }) },
      app: { agents: async () => [] },
      session,
    }),
    adapters: new Map([["slack:default", slackAdapter]]),
    disableEventStream: true,
    disableHealthServer: true,
  });
}

test("a pre-upgrade allow session is replaced when the configured mode is inherit", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-preupgrade-migrate-"));
  const store = createMemoryStore();
  const sent = [];
  const slackAdapter = makeSlackAdapter(sent);
  await seedPreUpgradeSession(dir, store, slackAdapter);
  sent.length = 0;

  const createCalls = [];
  const updateCalls = [];
  const promptCalls = [];
  const events = [];
  const bridge = await startBridge(
    preUpgradeBridgeConfig(dir, "inherit"),
    createLoggerStub(),
    undefined,
    {
      store,
      clientFactory: () => ({
        file: emptyWorkspaceFileApi,
        global: { health: async () => ({ healthy: true, version: "test" }) },
        app: { agents: async () => [] },
        session: {
          create: async (input) => {
            events.push("create");
            createCalls.push(input);
            return { id: "session-safe" };
          },
          update: async (input) => {
            events.push("update");
            updateCalls.push(input);
            return {};
          },
          prompt: async (input) => {
            events.push("prompt");
            promptCalls.push(input.sessionID);
            return { parts: [{ type: "text", text: "ok" }] };
          },
        },
      }),
      adapters: new Map([["slack:default", slackAdapter]]),
      disableEventStream: true,
      disableHealthServer: true,
    },
  );

  await bridge.dispatchInbound({ channel: "slack", identityId: "default", peerId: "D123", text: "one", raw: {} });
  await bridge.dispatchInbound({ channel: "slack", identityId: "default", peerId: "D123", text: "two", raw: {} });
  await bridge.stop();

  assert.deepEqual(updateCalls, []);
  assert.deepEqual(events.slice(0, 2), ["create", "prompt"]);
  assert.equal(createCalls.length, 1);
  assert.deepEqual(createCalls[0].permission, channelDenyRules());
  assert.deepEqual(promptCalls, ["session-safe", "session-safe"]);
  assert.equal(store.getSession("slack", "default", "D123")?.session_id, "session-safe");
  assert.equal(store.getSession("slack", "default", "D123")?.permission_mode, "inherit");
  assert.ok(sent.some((text) => text.includes("previous history remains")), JSON.stringify(sent));
});

test("a legacy session is replaced without changing its existing permissions", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-preupgrade-quarantine-fail-"));
  const store = createMemoryStore();
  const sent = [];
  const slackAdapter = makeSlackAdapter(sent);
  await seedPreUpgradeSession(dir, store, slackAdapter);
  sent.length = 0;

  const createCalls = [];
  const updateCalls = [];
  const promptCalls = [];
  const bridge = await startBridge(preUpgradeBridgeConfig(dir, "inherit"), createLoggerStub(), undefined, {
    store,
    clientFactory: () => ({
      file: emptyWorkspaceFileApi,
      global: { health: async () => ({ healthy: true, version: "test" }) },
      app: { agents: async () => [] },
      session: {
        create: async (input) => {
          createCalls.push(input);
          return { id: "session-safe" };
        },
        update: async (input) => {
          updateCalls.push(input);
          throw new Error("legacy session should not be modified");
        },
        prompt: async (input) => {
          promptCalls.push(input.sessionID);
          return { parts: [{ type: "text", text: "should not run" }] };
        },
      },
    }),
    adapters: new Map([["slack:default", slackAdapter]]),
    disableEventStream: true,
    disableHealthServer: true,
  });

  await bridge.dispatchInbound({ channel: "slack", identityId: "default", peerId: "D123", text: "run", raw: {} });
  await bridge.stop();

  assert.equal(createCalls.length, 1);
  assert.deepEqual(createCalls[0].permission, channelDenyRules());
  assert.deepEqual(updateCalls, []);
  assert.deepEqual(promptCalls, ["session-safe"]);
  assert.equal(store.getSession("slack", "default", "D123")?.session_id, "session-safe");
  assert.ok(sent.some((text) => text.includes("previous history remains")), JSON.stringify(sent));
});

test("an inherited session retaining a legacy wildcard allow is replaced", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-inherit-with-legacy-allow-"));
  const store = createMemoryStore();
  const sent = [];
  const slackAdapter = makeSlackAdapter(sent);
  store.upsertSession("slack", "default", "D123", "session-old", dir, "inherit");

  const createCalls = [];
  const updateCalls = [];
  const promptCalls = [];
  const bridge = await startBridge(preUpgradeBridgeConfig(dir, "inherit"), createLoggerStub(), undefined, {
    store,
    clientFactory: () => ({
      file: emptyWorkspaceFileApi,
      global: { health: async () => ({ healthy: true, version: "test" }) },
      app: { agents: async () => [] },
      session: {
        get: async () => ({
          permission: [
            { permission: "*", pattern: "*", action: "allow" },
            ...channelDenyRules(),
          ],
        }),
        create: async (input) => {
          createCalls.push(input);
          return { id: "session-safe" };
        },
        update: async (input) => {
          updateCalls.push(input);
          return {};
        },
        prompt: async (input) => {
          promptCalls.push(input.sessionID);
          return { parts: [{ type: "text", text: "ok" }] };
        },
      },
    }),
    adapters: new Map([["slack:default", slackAdapter]]),
    disableEventStream: true,
    disableHealthServer: true,
  });

  await bridge.dispatchInbound({ channel: "slack", identityId: "default", peerId: "D123", text: "run", raw: {} });
  await bridge.stop();

  assert.equal(createCalls.length, 1);
  assert.deepEqual(createCalls[0].permission, channelDenyRules());
  assert.deepEqual(updateCalls, []);
  assert.deepEqual(promptCalls, ["session-safe"]);
  assert.equal(store.getSession("slack", "default", "D123")?.permission_mode, "inherit");
});

test("explicit allow replaces a tainted inherited session before a custom-agent mention", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-allow-tainted-inherit-"));
  const store = createMemoryStore();
  const sent = [];
  store.upsertSession("slack", "default", "D123", "session-old", dir, "inherit");

  const createCalls = [];
  const getCalls = [];
  const updateCalls = [];
  const promptCalls = [];
  let markFirstPrompt;
  const firstPrompt = new Promise((resolve) => {
    markFirstPrompt = resolve;
  });
  const bridge = await startBridge(preUpgradeBridgeConfig(dir, "allow"), createLoggerStub(), undefined, {
    store,
    clientFactory: () => ({
      file: emptyWorkspaceFileApi,
      global: { health: async () => ({ healthy: true, version: "test" }) },
      app: { agents: async () => [
        { name: "my-agent", mode: "primary", hidden: false },
        { name: "superclaw-default", mode: "primary", hidden: false },
      ] },
      session: {
        get: async (input) => {
          getCalls.push(input.sessionID);
          return {
            permission: [
              { permission: "*", pattern: "*", action: "allow" },
              ...channelDenyRules(),
            ],
          };
        },
        create: async (input) => {
          createCalls.push(input);
          return { id: "session-safe" };
        },
        update: async (input) => {
          updateCalls.push(input);
          return {};
        },
        prompt: async (input) => {
          promptCalls.push({ sessionID: input.sessionID, agent: input.agent });
          if (promptCalls.length === 1) markFirstPrompt();
          return { parts: [{ type: "text", text: "ok" }] };
        },
      },
    }),
    adapters: new Map([["slack:default", makeSlackAdapter(sent)]]),
    disableEventStream: true,
    disableHealthServer: true,
  });

  await bridge.dispatchInbound({ channel: "slack", identityId: "default", peerId: "D123", text: "hello", raw: {} });
  assert.equal(createCalls.length, 0, "plain allow-mode turn should not replace the legacy session");
  await firstPrompt;
  assert.deepEqual(promptCalls, [{ sessionID: "session-old", agent: undefined }]);
  await bridge.dispatchInbound({
    channel: "slack",
    identityId: "default",
    peerId: "D123",
    text: "@my-agent do this",
    raw: {},
  });
  await bridge.stop();

  assert.deepEqual(getCalls, ["session-old"]);
  assert.equal(updateCalls.length, 1, "only the plain allow-mode turn reapplies channel denies");
  assert.equal(promptCalls[1].sessionID, "session-safe");
  assert.equal(promptCalls[1].agent, "my-agent");
  assert.equal(createCalls.length, 1);
  assert.deepEqual(createCalls[0].permission, channelDenyRules());
  assert.equal(store.getSession("slack", "default", "D123")?.session_id, "session-safe");
});

test("an inherited session without a legacy wildcard allow is reused", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-clean-inherit-"));
  const store = createMemoryStore();
  store.upsertSession("slack", "default", "D123", "session-safe", dir, "inherit");

  const createCalls = [];
  const promptCalls = [];
  const bridge = await startBridge(preUpgradeBridgeConfig(dir, "inherit"), createLoggerStub(), undefined, {
    store,
    clientFactory: () => ({
      file: emptyWorkspaceFileApi,
      global: { health: async () => ({ healthy: true, version: "test" }) },
      app: { agents: async () => [] },
      session: {
        get: async () => ({ permission: channelDenyRules() }),
        create: async (input) => {
          createCalls.push(input);
          return { id: "unexpected-replacement" };
        },
        update: async () => ({}),
        prompt: async (input) => {
          promptCalls.push(input.sessionID);
          return { parts: [{ type: "text", text: "ok" }] };
        },
      },
    }),
    adapters: new Map([["slack:default", makeSlackAdapter([])]]),
    disableEventStream: true,
    disableHealthServer: true,
  });

  await bridge.dispatchInbound({ channel: "slack", identityId: "default", peerId: "D123", text: "run", raw: {} });
  await bridge.stop();

  assert.deepEqual(createCalls, []);
  assert.deepEqual(promptCalls, ["session-safe"]);
});

test("permission inspection errors refuse the turn without creating or prompting", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-inherit-inspection-error-"));
  const store = createMemoryStore();
  const sent = [];
  const createCalls = [];
  const promptCalls = [];
  const bridge = await startBridgeWithStoredInheritSession({
    dir,
    store,
    slackAdapter: makeSlackAdapter(sent),
    session: {
      get: async () => {
        throw new Error("engine unavailable");
      },
      create: async (input) => {
        createCalls.push(input);
        return { id: "session-new" };
      },
      update: async () => ({}),
      prompt: async (input) => {
        promptCalls.push(input.sessionID);
        return { parts: [{ type: "text", text: "should not run" }] };
      },
    },
  });

  await bridge.dispatchInbound({ channel: "slack", identityId: "default", peerId: "D123", text: "run", raw: {} });
  await bridge.stop();

  assert.deepEqual(createCalls, []);
  assert.deepEqual(promptCalls, []);
  assert.equal(store.getSession("slack", "default", "D123")?.session_id, "session-old");
  assert.ok(sent.some((text) => text.includes("safety settings could not be verified")), JSON.stringify(sent));
});

test("malformed permission inspection results refuse the turn", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-inherit-inspection-malformed-"));
  const store = createMemoryStore();
  const sent = [];
  const createCalls = [];
  const promptCalls = [];
  const bridge = await startBridgeWithStoredInheritSession({
    dir,
    store,
    slackAdapter: makeSlackAdapter(sent),
    session: {
      get: async () => ({ permission: { permission: "*", pattern: "*", action: "allow" } }),
      create: async (input) => {
        createCalls.push(input);
        return { id: "session-new" };
      },
      update: async () => ({}),
      prompt: async (input) => {
        promptCalls.push(input.sessionID);
        return { parts: [{ type: "text", text: "should not run" }] };
      },
    },
  });

  await bridge.dispatchInbound({ channel: "slack", identityId: "default", peerId: "D123", text: "run", raw: {} });
  await bridge.stop();

  assert.deepEqual(createCalls, []);
  assert.deepEqual(promptCalls, []);
  assert.ok(sent.some((text) => text.includes("safety settings could not be verified")), JSON.stringify(sent));
});

test("a missing inherited session is replaced with safe permissions", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-inherit-inspection-missing-"));
  const store = createMemoryStore();
  const sent = [];
  const notFound = { name: "NotFoundError", data: { message: "Session not found: session-old" } };
  const createCalls = [];
  const promptCalls = [];
  const bridge = await startBridgeWithStoredInheritSession({
    dir,
    store,
    slackAdapter: makeSlackAdapter(sent),
    session: {
      get: async () => {
        throw notFound;
      },
      create: async (input) => {
        createCalls.push(input);
        return { id: "session-safe" };
      },
      update: async () => ({}),
      prompt: async (input) => {
        promptCalls.push(input.sessionID);
        return { parts: [{ type: "text", text: "ok" }] };
      },
    },
  });

  await bridge.dispatchInbound({ channel: "slack", identityId: "default", peerId: "D123", text: "run", raw: {} });
  await bridge.stop();

  assert.equal(createCalls.length, 1);
  assert.deepEqual(createCalls[0].permission, channelDenyRules());
  assert.deepEqual(promptCalls, ["session-safe"]);
  assert.equal(store.getSession("slack", "default", "D123")?.session_id, "session-safe");
  assert.ok(!sent.some((text) => text.includes("safety settings could not be verified")), JSON.stringify(sent));
});

test("concurrent messages await the same legacy session replacement", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-preupgrade-concurrent-"));
  const store = createMemoryStore();
  const sent = [];
  const slackAdapter = makeSlackAdapter(sent);
  await seedPreUpgradeSession(dir, store, slackAdapter);
  sent.length = 0;

  let markCreateStarted;
  let releaseCreate;
  const createStarted = new Promise((resolve) => {
    markCreateStarted = resolve;
  });
  const createGate = new Promise((resolve) => {
    releaseCreate = resolve;
  });
  const createCalls = [];
  const promptCalls = [];
  const bridge = await startBridge(preUpgradeBridgeConfig(dir, "inherit"), createLoggerStub(), undefined, {
    store,
    clientFactory: () => ({
      file: emptyWorkspaceFileApi,
      global: { health: async () => ({ healthy: true, version: "test" }) },
      app: { agents: async () => [] },
      session: {
        create: async (input) => {
          createCalls.push(input);
          markCreateStarted();
          await createGate;
          return { id: "session-safe" };
        },
        update: async () => {
          throw new Error("legacy session should not be modified");
        },
        prompt: async (input) => {
          promptCalls.push(input.sessionID);
          return { parts: [{ type: "text", text: "ok" }] };
        },
      },
    }),
    adapters: new Map([["slack:default", slackAdapter]]),
    disableEventStream: true,
    disableHealthServer: true,
  });

  const firstMessage = bridge.dispatchInbound({
    channel: "slack",
    identityId: "default",
    peerId: "D123",
    text: "first",
    raw: {},
  });
  await createStarted;
  const secondMessage = bridge.dispatchInbound({
    channel: "slack",
    identityId: "default",
    peerId: "D123",
    text: "second",
    raw: {},
  });
  releaseCreate();
  await Promise.all([firstMessage, secondMessage]);
  await bridge.stop();

  assert.equal(createCalls.length, 1);
  assert.deepEqual(promptCalls, ["session-safe", "session-safe"]);
  assert.equal(store.getSession("slack", "default", "D123")?.session_id, "session-safe");
  assert.equal(sent.filter((text) => text.includes("previous history remains")).length, 1);
});

test("agent migration waits for an in-flight turn on the old session", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-migration-drains-turn-"));
  const store = createMemoryStore();
  const createCalls = [];
  const promptCalls = [];
  let markOldPromptStarted;
  let releaseOldPrompt;
  const oldPromptStarted = new Promise((resolve) => {
    markOldPromptStarted = resolve;
  });
  const oldPromptGate = new Promise((resolve) => {
    releaseOldPrompt = resolve;
  });
  let markAgentLookup;
  const agentLookup = new Promise((resolve) => {
    markAgentLookup = resolve;
  });
  let activePrompts = 0;
  let maxActivePrompts = 0;
  const bridge = await startBridge(preUpgradeBridgeConfig(dir, "allow"), createLoggerStub(), undefined, {
    store,
    clientFactory: () => ({
      file: emptyWorkspaceFileApi,
      global: { health: async () => ({ healthy: true, version: "test" }) },
      app: {
        agents: async () => {
          markAgentLookup();
          return [
            { name: "my-agent", mode: "primary", hidden: false },
            { name: "superclaw-default", mode: "primary", hidden: false },
          ];
        },
      },
      session: {
        create: async (input) => {
          createCalls.push(input);
          return { id: createCalls.length === 1 ? "session-old" : "session-safe" };
        },
        update: async () => ({}),
        prompt: async (input) => {
          promptCalls.push({ sessionID: input.sessionID, agent: input.agent });
          activePrompts += 1;
          maxActivePrompts = Math.max(maxActivePrompts, activePrompts);
          try {
            if (input.sessionID === "session-old") {
              markOldPromptStarted();
              await oldPromptGate;
              return {
                parts: [{
                  type: "tool",
                  tool: "bash",
                  callID: "old-call",
                  state: { status: "completed", input: {}, output: "done" },
                }],
              };
            }
            return { parts: [{ type: "text", text: "ok" }] };
          } finally {
            activePrompts -= 1;
          }
        },
      },
    }),
    adapters: new Map([["slack:default", makeSlackAdapter([])]]),
    disableEventStream: true,
    disableHealthServer: true,
  });

  const oldMessage = bridge.dispatchInbound({
    channel: "slack",
    identityId: "default",
    peerId: "D123",
    text: "hello",
    raw: {},
  });
  await oldPromptStarted;
  const agentMessage = bridge.dispatchInbound({
    channel: "slack",
    identityId: "default",
    peerId: "D123",
    text: "@my-agent do this",
    raw: {},
  });
  await agentLookup;
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(createCalls.length, 1, "replacement is not published while the old turn is active");
  assert.deepEqual(promptCalls, [{ sessionID: "session-old", agent: undefined }]);

  releaseOldPrompt();
  await Promise.all([oldMessage, agentMessage]);
  await bridge.stop();

  assert.deepEqual(promptCalls, [
    { sessionID: "session-old", agent: undefined },
    { sessionID: "session-safe", agent: "my-agent" },
  ]);
  assert.equal(maxActivePrompts, 1);
  assert.equal(createCalls.length, 2);
  assert.equal(store.getSession("slack", "default", "D123")?.session_id, "session-safe");
});

test("an explicitly configured allow session keeps its mode and gets channel web denies", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-preupgrade-"));
  const store = createMemoryStore();
  const sent = [];
  const slackAdapter = makeSlackAdapter(sent);
  const ruleset = await seedPreUpgradeSession(dir, store, slackAdapter);

  const updateCalls = [];
  const promptCalls = [];
  const bridge = await startBridge(preUpgradeBridgeConfig(dir), createLoggerStub(), undefined, {
    store,
    clientFactory: () => ({
      file: emptyWorkspaceFileApi,
      global: { health: async () => ({ healthy: true, version: "test" }) },
      app: { agents: async () => [] },
      // Engine file API: an empty workspace (no MCP config, no policy).
      file: { list: async () => [], read: async () => ({ type: "text", content: "" }) },
      session: {
        create: async () => {
          throw new Error("must reuse the persisted session");
        },
        update: async (input) => {
          updateCalls.push(input);
          ruleset.push(...input.permission);
          return {};
        },
        prompt: async (input) => {
          promptCalls.push(input);
          return { parts: [{ type: "text", text: "ok" }] };
        },
      },
    }),
    adapters: new Map([["slack:default", slackAdapter]]),
    disableEventStream: true,
    disableHealthServer: true,
  });

  await bridge.dispatchInbound({ channel: "slack", identityId: "default", peerId: "D123", text: "one", raw: {} });
  await bridge.dispatchInbound({ channel: "slack", identityId: "default", peerId: "D123", text: "two", raw: {} });
  await bridge.stop();

  assert.equal(updateCalls.length, 1, "patched once per process, not per message");
  assert.equal(updateCalls[0].sessionID, "session-old");
  assert.deepEqual(promptCalls.map((call) => call.sessionID), ["session-old", "session-old"]);
  for (const tool of ["webfetch", "websearch"]) assert.equal(evaluate(tool, ruleset), "deny", tool);
  assert.equal(evaluate("bash", ruleset), "allow");
});

test("a reused session whose denies cannot be applied refuses the turn and says so", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-preupgrade-fail-"));
  const store = createMemoryStore();
  const sent = [];
  const slackAdapter = makeSlackAdapter(sent);
  await seedPreUpgradeSession(dir, store, slackAdapter);
  sent.length = 0;

  const promptCalls = [];
  const bridge = await startBridge(preUpgradeBridgeConfig(dir), createLoggerStub(), undefined, {
    store,
    clientFactory: () => ({
      file: emptyWorkspaceFileApi,
      global: { health: async () => ({ healthy: true, version: "test" }) },
      app: { agents: async () => [] },
      // Engine file API: an empty workspace (no MCP config, no policy).
      file: { list: async () => [], read: async () => ({ type: "text", content: "" }) },
      session: {
        create: async () => ({ id: "session-new" }),
        update: async () => {
          throw new Error("engine unreachable");
        },
        prompt: async (input) => {
          promptCalls.push(input);
          return { parts: [{ type: "text", text: "ok" }] };
        },
      },
    }),
    adapters: new Map([["slack:default", slackAdapter]]),
    disableEventStream: true,
    disableHealthServer: true,
  });

  await bridge.dispatchInbound({ channel: "slack", identityId: "default", peerId: "D123", text: "one", raw: {} });
  await bridge.stop();

  assert.equal(promptCalls.length, 0, "no turn runs on an unpatched blanket allow");
  assert.ok(sent.some((text) => text.includes("safety settings could not be updated")), JSON.stringify(sent));
});

test("a reused session that OpenCode deleted is recreated with the denies, not refused", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-preupgrade-gone-"));
  const store = createMemoryStore();
  const sent = [];
  const slackAdapter = makeSlackAdapter(sent);
  await seedPreUpgradeSession(dir, store, slackAdapter);
  sent.length = 0;

  const notFound = { name: "NotFoundError", data: { message: "Session not found: session-old" } };
  const createCalls = [];
  const promptCalls = [];
  const bridge = await startBridge(preUpgradeBridgeConfig(dir), createLoggerStub(), undefined, {
    store,
    clientFactory: () => ({
      file: emptyWorkspaceFileApi,
      global: { health: async () => ({ healthy: true, version: "test" }) },
      app: { agents: async () => [] },
      // Engine file API: an empty workspace (no MCP config, no policy).
      file: { list: async () => [], read: async () => ({ type: "text", content: "" }) },
      session: {
        create: async (input) => {
          createCalls.push(input);
          return { id: "session-new" };
        },
        update: async () => {
          throw notFound;
        },
        prompt: async (input) => {
          promptCalls.push(input.sessionID);
          if (input.sessionID === "session-old") throw notFound;
          return { parts: [{ type: "text", text: "ok" }] };
        },
      },
    }),
    adapters: new Map([["slack:default", slackAdapter]]),
    disableEventStream: true,
    disableHealthServer: true,
  });

  await bridge.dispatchInbound({ channel: "slack", identityId: "default", peerId: "D123", text: "one", raw: {} });
  await bridge.stop();

  assert.deepEqual(promptCalls, ["session-old", "session-new"]);
  assert.equal(createCalls.length, 1);
  for (const tool of ["webfetch", "websearch"]) assert.equal(evaluate(tool, createCalls[0].permission), "deny", tool);
  assert.ok(!sent.some((text) => text.includes("safety settings")), JSON.stringify(sent));
});

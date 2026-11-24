import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "bun:test";

import { startBridge } from "../../dist/bridge.js";
import { createClient } from "../../dist/opencode.js";
import { createMemoryStore } from "../unit/memory-store.js";
import { engineFileApi } from "./engine-file-api.js";

// Slack/Telegram -> router bridge -> (real SDK client, real HTTP) -> mock OpenCode.
//
// Unlike slack-mcp-tool.test.js's weather harness, the mock OpenCode server here
// MODELS the engine's real session.permission semantics instead of just recording
// bodies: a per-message `tools` map REPLACES session.permission wholesale, and
// PATCH /session only ever APPENDS. That is what lets these tests assert the
// router's gate re-reads live session state on every invocation, rather than just
// recording the map it sent once. These tests prove outgoing request wiring --
// that every session.prompt path carries the policy wrapper's correct map -- not
// model-level tool filtering, which sandbox/server and the real-OpenCode suite
// cover separately.

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

function writeWorkspaceConfig(dir, mcpServers, extra = {}) {
  fs.writeFileSync(
    path.join(dir, "opencode.jsonc"),
    JSON.stringify({ $schema: "https://opencode.ai/config.json", mcp: mcpServers, ...extra }, null, 2),
  );
}

function writePolicy(dir, servers) {
  fs.mkdirSync(path.join(dir, ".opencode"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".opencode", "superclaw-mcp-policy.json"),
    JSON.stringify({ schemaVersion: 1, servers }),
  );
}

function removePolicy(dir) {
  fs.rmSync(path.join(dir, ".opencode", "superclaw-mcp-policy.json"), { force: true });
}

const ARXIV_SERVER = {
  arxiv: { type: "remote", url: "http://127.0.0.1:1/mcp", enabled: true },
};

// Allow- and inherit-mode channel sessions always carry these denies
// (CHANNEL_DENIED_TOOLS in src/opencode.ts), so the gate re-expresses them too.
const CHANNEL_DENIES = { webfetch: false, websearch: false };
const CHANNEL_DENY_RULES = [
  { permission: "webfetch", pattern: "*", action: "deny" },
  { permission: "websearch", pattern: "*", action: "deny" },
];

/**
 * A mock OpenCode engine that tracks each session's `permission` the way the
 * real engine does: `POST /session/:id/message` with a non-empty `tools` map
 * REPLACES it (one `pattern: "*"` rule per key), `PATCH /session/:id` only
 * APPENDS, and `GET /session/:id` reports whatever is currently stored. A
 * queued "outcome" per sessionID lets a test script one call's response
 * (fail-tool / empty parts / timeout / missing-session) without touching the
 * permission bookkeeping above, which always applies first.
 */
function startOpencode() {
  const requests = [];
  const sessions = new Map(); // id -> { permission }
  const outcomes = new Map(); // id -> outcome[] (shifted on each /message call)
  let sessionCounter = 0;

  const queueOutcome = (sessionID, outcome) => {
    const queue = outcomes.get(sessionID) ?? [];
    queue.push(outcome);
    outcomes.set(sessionID, queue);
  };
  const nextOutcome = (sessionID) => {
    const queue = outcomes.get(sessionID);
    return queue && queue.length ? queue.shift() : "ok";
  };
  const notFound = (sessionID) =>
    Response.json({ name: "NotFoundError", data: { message: `Session ${sessionID} not found` } }, { status: 404 });

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const rawBody = request.method !== "GET" && request.method !== "DELETE" ? await request.text() : "";
      const body = rawBody ? JSON.parse(rawBody) : undefined;
      requests.push({ method: request.method, pathname: url.pathname, search: url.search, headers: request.headers, body });

      if (request.method === "GET" && url.pathname === "/global/health") {
        return Response.json({ healthy: true, version: "mock-opencode" });
      }
      const fileResponse = engineFileApi(request, url);
      if (fileResponse) return fileResponse;
      if (request.method === "GET" && url.pathname === "/agent") {
        return Response.json([]);
      }
      if (request.method === "POST" && url.pathname === "/session") {
        sessionCounter += 1;
        const id = `session-${sessionCounter}`;
        sessions.set(id, { permission: body?.permission });
        return Response.json({ id, title: "Router", version: "1", time: { created: 1, updated: 1 } });
      }

      const sessionMatch = /^\/session\/([^/]+)$/.exec(url.pathname);
      if (sessionMatch && request.method === "GET") {
        const id = sessionMatch[1];
        const state = sessions.get(id);
        if (!state) return notFound(id);
        return Response.json({ id, permission: state.permission });
      }
      if (sessionMatch && request.method === "PATCH") {
        const id = sessionMatch[1];
        const state = sessions.get(id);
        if (!state) return notFound(id);
        if (Array.isArray(body?.permission)) {
          // Real PATCH /session semantics: append-only, never a clear.
          state.permission = [...(state.permission ?? []), ...body.permission];
        }
        return Response.json({});
      }

      const message = request.method === "POST" ? /^\/session\/([^/]+)\/message$/.exec(url.pathname) : null;
      if (message) {
        const id = message[1];
        const state = sessions.get(id);
        if (!state) return notFound(id);
        // The `tools` map's mere PRESENCE replaces the whole ruleset.
        if (body?.tools && Object.keys(body.tools).length > 0) {
          state.permission = Object.entries(body.tools).map(([key, allowed]) => ({
            permission: key,
            pattern: "*",
            action: allowed ? "allow" : "deny",
          }));
        }

        const outcome = nextOutcome(id);
        if (outcome === "timeout") {
          return Response.json({ name: "TimeoutError", data: { message: "Request timed out" } }, { status: 504 });
        }
        if (outcome === "missing") {
          return notFound(id);
        }
        if (outcome === "empty") {
          return Response.json({ info: { id: `message-${requests.length}`, sessionID: id, role: "assistant" }, parts: [] });
        }
        if (outcome === "fail-tool") {
          return Response.json({
            info: { id: `message-${requests.length}`, sessionID: id, role: "assistant" },
            parts: [
              {
                id: `part-tool-${requests.length}`,
                type: "tool",
                tool: "arxiv_search",
                callID: `call-${requests.length}`,
                state: { status: "error", input: {}, error: "upstream search timed out" },
              },
            ],
          });
        }
        const text = body?.parts?.find((part) => part.type === "text")?.text ?? "";
        return Response.json({
          info: { id: `message-${requests.length}`, sessionID: id, role: "assistant" },
          parts: [{ id: `part-text-${requests.length}`, type: "text", text: `ack: ${text}` }],
        });
      }

      return Response.json(
        { name: "NotFoundError", data: { message: `no mock for ${request.method} ${url.pathname}` } },
        { status: 404 },
      );
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    prompts: () => requests.filter((entry) => entry.method === "POST" && /\/message$/.test(entry.pathname)),
    creates: () => requests.filter((entry) => entry.method === "POST" && entry.pathname === "/session"),
    permissionOf: (id) => sessions.get(id)?.permission,
    queueOutcome,
    stop: () => server.stop(true),
  };
}

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

async function startHarness({ permissionMode = "allow", channel = "slack", identityDirectory, dir: providedDir } = {}) {
  const dir = providedDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-mcp-policy-"));
  // listMcpServers() also consults the global opencode config; isolate it so
  // these assertions do not depend on whatever the developer/CI machine has.
  const globalConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-mcp-policy-global-"));
  const previousConfigDir = process.env.OPENCODE_CONFIG_DIR;
  process.env.OPENCODE_CONFIG_DIR = globalConfigDir;

  const opencode = startOpencode();
  const sent = [];
  const adapterKey = `${channel}:default`;
  const adapter = {
    key: adapterKey,
    name: channel,
    identityId: "default",
    maxTextLength: 39_000,
    async start() {},
    async stop() {},
    async sendText(peerId, text) {
      sent.push({ peerId, text });
    },
  };

  const config = {
    configPath: path.join(dir, "opencode-router.json"),
    configFile: { version: 1 },
    opencodeUrl: opencode.url,
    opencodeDirectory: dir,
    telegramBots: channel === "telegram" && identityDirectory ? [{ id: "default", directory: identityDirectory }] : [],
    slackApps: channel === "slack" && identityDirectory ? [{ id: "default", directory: identityDirectory }] : [],
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

  const bridge = await startBridge(config, createLoggerStub(), undefined, {
    client: createClient(config),
    clientFactory: (directory) => createClient(config, directory),
    store: createMemoryStore(),
    adapters: new Map([[adapterKey, adapter]]),
    disableEventStream: true,
    disableHealthServer: true,
  });

  cleanups.push(async () => {
    await bridge.stop();
    opencode.stop();
    if (previousConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = previousConfigDir;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(globalConfigDir, { recursive: true, force: true });
  });

  return {
    dir,
    sent,
    opencode,
    say: (text, peerId = "P1") => bridge.dispatchInbound({ channel, identityId: "default", peerId, text, raw: {} }),
  };
}

test("allow-mode session + a policy deny: tools preserves the catch-all allow and adds the deny", async () => {
  const harness = await startHarness({ permissionMode: "allow" });
  writeWorkspaceConfig(harness.dir, ARXIV_SERVER);
  writePolicy(harness.dir, { arxiv: { search: "deny" } });

  await harness.say("hi");

  const [prompt] = harness.opencode.prompts();
  assert.deepEqual(prompt.body.tools, { "*": true, ...CHANNEL_DENIES, arxiv_search: false });
});

test("deny-mode session + a policy deny: tools preserves the catch-all deny and adds the deny", async () => {
  const harness = await startHarness({ permissionMode: "deny" });
  writeWorkspaceConfig(harness.dir, ARXIV_SERVER);
  writePolicy(harness.dir, { arxiv: { search: "deny" } });

  await harness.say("hi");

  const [prompt] = harness.opencode.prompts();
  assert.deepEqual(prompt.body.tools, { "*": false, arxiv_search: false });
});

test("inherit-mode fresh session + a policy deny: tools carries just that deny", async () => {
  const harness = await startHarness({ permissionMode: "inherit" });
  writeWorkspaceConfig(harness.dir, ARXIV_SERVER);
  writePolicy(harness.dir, { arxiv: { search: "deny" } });

  await harness.say("hi");

  const [prompt] = harness.opencode.prompts();
  assert.deepEqual(prompt.body.tools, { ...CHANNEL_DENIES, arxiv_search: false });
});

test("no policy and no config-off servers: tools is omitted so the session ruleset governs", async () => {
  const harness = await startHarness({ permissionMode: "allow" });
  writeWorkspaceConfig(harness.dir, ARXIV_SERVER);

  await harness.say("hi");

  const [prompt] = harness.opencode.prompts();
  assert.equal(Object.prototype.hasOwnProperty.call(prompt.body, "tools"), false);
});

test("a tools.deny'd MCP server is not reopened by the session's blanket allow", async () => {
  const harness = await startHarness({ permissionMode: "allow" });
  writeWorkspaceConfig(harness.dir, ARXIV_SERVER, { tools: { deny: ["mcp:arxiv:*"] } });

  await harness.say("hi");

  const [prompt] = harness.opencode.prompts();
  assert.deepEqual(prompt.body.tools, { "*": true, ...CHANNEL_DENIES, "arxiv_*": false });
});

test("a config-disabled MCP server is not reopened by the session's blanket allow", async () => {
  const harness = await startHarness({ permissionMode: "allow" });
  writeWorkspaceConfig(harness.dir, { arxiv: { ...ARXIV_SERVER.arxiv, enabled: false } });

  await harness.say("hi");

  const [prompt] = harness.opencode.prompts();
  assert.deepEqual(prompt.body.tools, { "*": true, ...CHANNEL_DENIES, "arxiv_*": false });
});

test("a second inbound message recomputes the same map from the persisted session ruleset", async () => {
  const harness = await startHarness({ permissionMode: "allow" });
  writeWorkspaceConfig(harness.dir, ARXIV_SERVER);
  writePolicy(harness.dir, { arxiv: { search: "deny" } });

  await harness.say("first");
  await harness.say("second");

  const prompts = harness.opencode.prompts();
  assert.equal(prompts.length, 2);
  assert.deepEqual(prompts[0].body.tools, { "*": true, ...CHANNEL_DENIES, arxiv_search: false });
  // The session now genuinely carries the array the engine persisted from turn
  // 1's map (not channels' original blanket-allow array): the gate re-expresses
  // it and gets back the SAME map, proving the replace-semantics round-trip.
  assert.deepEqual(prompts[1].body.tools, { "*": true, ...CHANNEL_DENIES, arxiv_search: false });
});

test("a failed-tool recovery retry re-reads policy and carries the same gated map", async () => {
  const harness = await startHarness({ permissionMode: "allow" });
  writeWorkspaceConfig(harness.dir, ARXIV_SERVER);
  writePolicy(harness.dir, { arxiv: { search: "deny" } });
  harness.opencode.queueOutcome("session-1", "fail-tool");

  await harness.say("search arxiv");

  const prompts = harness.opencode.prompts();
  assert.equal(prompts.length, 2, "a failed tool call should trigger exactly one recovery retry");
  assert.ok(prompts[1].body.parts[0].text.startsWith("Your previous tool call failed:"));
  assert.deepEqual(prompts[0].body.tools, { "*": true, ...CHANNEL_DENIES, arxiv_search: false });
  assert.deepEqual(prompts[1].body.tools, { "*": true, ...CHANNEL_DENIES, arxiv_search: false });
});

test("a policy edit between the initial prompt and its recovery retry is picked up by the retry", async () => {
  const harness = await startHarness({ permissionMode: "allow" });
  writeWorkspaceConfig(harness.dir, { ...ARXIV_SERVER, "mock-search": { type: "remote", url: "http://127.0.0.1:1/mcp", enabled: true } });
  writePolicy(harness.dir, { arxiv: { search: "deny" } });
  harness.opencode.queueOutcome("session-1", "fail-tool");

  await harness.say("search arxiv");

  const prompts = harness.opencode.prompts();
  assert.equal(prompts.length, 2);
  assert.deepEqual(prompts[0].body.tools, { "*": true, ...CHANNEL_DENIES, arxiv_search: false });
});

test("an empty-response retry succeeds and both attempts carry the same gated map", async () => {
  const harness = await startHarness({ permissionMode: "allow" });
  writeWorkspaceConfig(harness.dir, ARXIV_SERVER);
  writePolicy(harness.dir, { arxiv: { search: "deny" } });
  harness.opencode.queueOutcome("session-1", "empty");

  await harness.say("hi");

  const prompts = harness.opencode.prompts();
  assert.equal(prompts.length, 2, "an empty first response should trigger exactly one retry");
  assert.deepEqual(prompts[0].body.tools, { "*": true, ...CHANNEL_DENIES, arxiv_search: false });
  assert.deepEqual(prompts[1].body.tools, { "*": true, ...CHANNEL_DENIES, arxiv_search: false });
  assert.ok(harness.sent.some((m) => m.text === "ack: hi"));
});

test("two empty responses recreate the session, preserving permission mode, and the new session is gated too", async () => {
  const harness = await startHarness({ permissionMode: "deny" });
  writeWorkspaceConfig(harness.dir, ARXIV_SERVER);
  writePolicy(harness.dir, { arxiv: { search: "deny" } });
  harness.opencode.queueOutcome("session-1", "empty");
  harness.opencode.queueOutcome("session-1", "empty");

  await harness.say("hi");

  const creates = harness.opencode.creates();
  assert.equal(creates.length, 2, "the second session should be a fresh recreate, not a reuse");
  // The bug this guards: recreateSession must pass the turn's actual resolved
  // mode, not silently fall back to the bridge's global default.
  assert.deepEqual(creates[1].body.permission, [{ permission: "*", pattern: "*", action: "deny" }]);

  const prompts = harness.opencode.prompts();
  assert.equal(prompts.length, 3);
  assert.equal(prompts[2].pathname, "/session/session-2/message");
  assert.deepEqual(prompts[2].body.tools, { "*": false, arxiv_search: false });
  assert.ok(harness.sent.some((m) => m.text === "ack: hi"));
});

test("a missing-session error on the very first prompt recreates the session, preserving mode and re-gating it", async () => {
  const harness = await startHarness({ permissionMode: "inherit" });
  writeWorkspaceConfig(harness.dir, ARXIV_SERVER);
  writePolicy(harness.dir, { arxiv: { search: "deny" } });
  harness.opencode.queueOutcome("session-1", "missing");

  await harness.say("hi");

  const creates = harness.opencode.creates();
  assert.equal(creates.length, 2);
  // inherit mode sends only the channel denies on create.
  assert.deepEqual(creates[1].body.permission, CHANNEL_DENY_RULES);

  const prompts = harness.opencode.prompts();
  assert.equal(prompts.length, 2);
  assert.equal(prompts[1].pathname, "/session/session-2/message");
  assert.deepEqual(prompts[1].body.tools, { ...CHANNEL_DENIES, arxiv_search: false });
  assert.ok(harness.sent.some((m) => m.text === "ack: hi"));
});

test("a timed-out prompt is followed by a continuation prompt carrying the same gated map", async () => {
  const harness = await startHarness({ permissionMode: "allow" });
  writeWorkspaceConfig(harness.dir, ARXIV_SERVER);
  writePolicy(harness.dir, { arxiv: { search: "deny" } });
  harness.opencode.queueOutcome("session-1", "timeout");

  await harness.say("hi");

  const prompts = harness.opencode.prompts();
  assert.equal(prompts.length, 2);
  assert.ok(prompts[1].body.parts[0].text.includes("Continue the task"));
  assert.deepEqual(prompts[0].body.tools, { "*": true, ...CHANNEL_DENIES, arxiv_search: false });
  assert.deepEqual(prompts[1].body.tools, { "*": true, ...CHANNEL_DENIES, arxiv_search: false });
});

test("re-allowing a tool in policy does not undo an already-echoed session deny", async () => {
  const harness = await startHarness({ permissionMode: "allow" });
  writeWorkspaceConfig(harness.dir, ARXIV_SERVER);
  writePolicy(harness.dir, { arxiv: { search: "deny" } });

  await harness.say("first");
  // Policy file removed entirely: arxiv_search is no longer denied by policy.
  removePolicy(harness.dir);
  await harness.say("second");

  const prompts = harness.opencode.prompts();
  assert.equal(prompts.length, 2);
  assert.deepEqual(prompts[0].body.tools, { "*": true, ...CHANNEL_DENIES, arxiv_search: false });
  // With no policy denies and no config-off servers left, the gate omits
  // `tools` entirely on turn 2 -- but that does NOT re-allow arxiv_search: it
  // just leaves the engine's own persisted ruleset (turn 1's map, which the
  // engine stored verbatim) in force, and that ruleset still denies it. No
  // `true` is ever sent for a re-allowed tool merely to clear a previous deny
  // (documented in shared/mcp-policy/src/projection.ts); a fresh session would
  // be required to regain it.
  assert.equal(Object.prototype.hasOwnProperty.call(prompts[1].body, "tools"), false);
  assert.deepEqual(harness.opencode.permissionOf("session-1"), [
    { permission: "*", pattern: "*", action: "allow" },
    ...CHANNEL_DENY_RULES,
    { permission: "arxiv_search", pattern: "*", action: "deny" },
  ]);
});

test("a malformed policy file fails closed (every MCP server off) instead of rejecting the turn", async () => {
  const harness = await startHarness({ permissionMode: "allow" });
  writeWorkspaceConfig(harness.dir, ARXIV_SERVER);
  fs.mkdirSync(path.join(harness.dir, ".opencode"), { recursive: true });
  fs.writeFileSync(path.join(harness.dir, ".opencode", "superclaw-mcp-policy.json"), "{not json");

  await harness.say("hi");

  // A malformed POLICY file (unlike a malformed CONFIG or a failed session
  // read) must not reject the turn -- it withholds MCP and the prompt still
  // goes out, matching the sandbox server's own malformed-policy behavior.
  const [prompt] = harness.opencode.prompts();
  assert.deepEqual(prompt.body.tools, { "*": true, ...CHANNEL_DENIES, "arxiv_*": false });
  assert.ok(
    !harness.sent.some((m) => m.text.includes("MCP tool permissions could not be resolved")),
    `did not expect the MCP gate error for a malformed policy: ${JSON.stringify(harness.sent.map((m) => m.text))}`,
  );
  assert.ok(harness.sent.some((m) => m.text === "ack: hi"));
});

test("a deny in a gitignored policy file (listed by the engine with ignored: true) is applied", async () => {
  const harness = await startHarness({ permissionMode: "allow" });
  writeWorkspaceConfig(harness.dir, ARXIV_SERVER);
  writePolicy(harness.dir, { arxiv: { search: "deny" } });
  fs.writeFileSync(path.join(harness.dir, ".gitignore"), ".opencode/\n");

  await harness.say("hi");

  const [prompt] = harness.opencode.prompts();
  assert.deepEqual(prompt.body.tools, { "*": true, ...CHANNEL_DENIES, arxiv_search: false });
});

test("a malformed MCP config blocks the prompt and reports the MCP gate error", async () => {
  const harness = await startHarness({ permissionMode: "allow" });
  fs.writeFileSync(path.join(harness.dir, "opencode.jsonc"), "{ not json");

  await harness.say("hi");

  assert.equal(harness.opencode.prompts().length, 0);
  assert.ok(
    harness.sent.some((m) => m.text === "MCP tool permissions could not be resolved. Please check the workspace policy/configuration and try again."),
  );
});

test("a Telegram turn is gated the same way a Slack turn is", async () => {
  const harness = await startHarness({ permissionMode: "allow", channel: "telegram" });
  writeWorkspaceConfig(harness.dir, ARXIV_SERVER);
  writePolicy(harness.dir, { arxiv: { search: "deny" } });

  await harness.say("hi", "12345");

  const [prompt] = harness.opencode.prompts();
  assert.deepEqual(prompt.body.tools, { "*": true, ...CHANNEL_DENIES, arxiv_search: false });
});

test("a subdirectory-bound peer is still gated by the top-level workspace root's policy", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-mcp-policy-sub-"));
  const subdir = path.join(dir, "project-a");
  fs.mkdirSync(subdir, { recursive: true });
  writeWorkspaceConfig(dir, ARXIV_SERVER);
  writePolicy(dir, { arxiv: { search: "deny" } });
  // The subdirectory has NO config/policy of its own -- if the gate read from
  // the identity's bound directory instead of the top-level workspace root,
  // listMcpServers would see no servers at all and the gate would omit
  // `tools` entirely instead of denying arxiv_search.
  const harness = await startHarness({ permissionMode: "allow", identityDirectory: subdir, dir });

  await harness.say("hi");

  const [prompt] = harness.opencode.prompts();
  assert.deepEqual(prompt.body.tools, { "*": true, ...CHANNEL_DENIES, arxiv_search: false });
});

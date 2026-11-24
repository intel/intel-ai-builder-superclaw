import assert from "node:assert/strict";
import { test } from "bun:test";

import { createCommandHandler } from "../../dist/commands.js";
import { getUserModel } from "../../dist/model-preferences.js";

// The model override map in model-preferences is process-wide by design, so every
// test here uses its own peerKey; sharing one would leak state between cases.
let seq = 0;
const nextPeer = () => `peer-${(seq += 1)}`;

function makeHandler(overrides = {}) {
  const sent = [];
  const bindings = new Map();
  const sessions = new Map();
  const deletedSessions = [];
  const clearedGates = [];
  const subscribed = [];
  const deps = {
    sendText: async (_channel, _identityId, _peerId, text, options) => {
      sent.push({ text, options });
    },
    store: {
      getBinding: (_c, _i, peerKey) => bindings.get(peerKey),
      getSession: (_c, _i, peerKey) => sessions.get(peerKey),
      upsertBinding: (_c, _i, peerKey, directory) => bindings.set(peerKey, { directory }),
      deleteSession: (_c, _i, peerKey) => deletedSessions.push(peerKey),
    },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    clearThreadGateState: (_c, _i, peerKey) => clearedGates.push(peerKey),
    handleTelegramPairingGate: async () => "handled",
    resolveScopedDirectory: (input) =>
      input.startsWith("/outside")
        ? { ok: false, error: "Directory must stay within workspace root: /w" }
        : { ok: true, directory: `/w/${input.replace(/^\/+/, "")}` },
    ensureEventSubscription: (directory) => subscribed.push(directory),
    loadMessagingAgentConfig: async () => ({
      filePath: "/w/.opencode/agents/superclaw-router.md",
      loaded: true,
      instructions: "be helpful",
      selectedAgent: "build",
    }),
    defaultDirectory: "/w",
    defaultModel: { providerID: "anthropic", modelID: "claude-sonnet" },
    ...overrides,
  };
  return { handle: createCommandHandler(deps), sent, bindings, sessions, deletedSessions, clearedGates, subscribed };
}

// ------------------------------------------------------------- pass-through

test("an unknown command is not handled, so it can be sent to the agent", async () => {
  const { handle, sent } = makeHandler();
  assert.equal(await handle("slack", "i1", nextPeer(), "C1", "/deploy prod"), false);
  assert.equal(sent.length, 0, "an unknown command must not produce a reply");
});

test("a bare slash is not handled", async () => {
  const { handle } = makeHandler();
  assert.equal(await handle("slack", "i1", nextPeer(), "C1", "/"), false);
});

// ------------------------------------------------------------ model presets

test("a preset switches the model and confirms which one", async () => {
  const { handle, sent } = makeHandler();
  const peer = nextPeer();
  assert.equal(await handle("slack", "i1", peer, "C1", "/opus"), true);
  assert.equal(sent[0].text, "Model switched to anthropic/claude-opus-4-5-20251101");
  assert.deepEqual(getUserModel("slack", "i1", peer), {
    providerID: "anthropic",
    modelID: "claude-opus-4-5-20251101",
  });
});

test("preset names are case-insensitive", async () => {
  const { handle, sent } = makeHandler();
  assert.equal(await handle("slack", "i1", nextPeer(), "C1", "/CODEX"), true);
  assert.equal(sent[0].text.includes("gpt-5.2-codex"), true);
});

test("an override is scoped to its own peer", async () => {
  const { handle } = makeHandler();
  const mine = nextPeer();
  const theirs = nextPeer();
  await handle("slack", "i1", mine, "C1", "/opus");
  assert.equal(getUserModel("slack", "i1", theirs), undefined, "another peer keeps the default");
});

test("/model reports the override once set, and the default before that", async () => {
  const { handle, sent } = makeHandler();
  const peer = nextPeer();
  await handle("slack", "i1", peer, "C1", "/model");
  assert.equal(sent[0].text, "Current model: anthropic/claude-sonnet");
  await handle("slack", "i1", peer, "C1", "/opus");
  await handle("slack", "i1", peer, "C1", "/model");
  assert.equal(sent.at(-1).text, "Current model: anthropic/claude-opus-4-5-20251101");
});

test("/model says 'default' when the bridge has no configured model", async () => {
  const { handle, sent } = makeHandler({ defaultModel: undefined });
  await handle("slack", "i1", nextPeer(), "C1", "/model");
  assert.equal(sent[0].text, "Current model: default");
});

// -------------------------------------------------------------------- /reset

test("/reset clears the override, the session and both gate caches together", async () => {
  const { handle, deletedSessions, clearedGates, sent } = makeHandler();
  const peer = nextPeer();
  await handle("slack", "i1", peer, "C1", "/opus");
  assert.equal(await handle("slack", "i1", peer, "C1", "/reset"), true);
  assert.equal(getUserModel("slack", "i1", peer), undefined);
  assert.deepEqual(deletedSessions, [peer]);
  assert.deepEqual(clearedGates, [peer], "a stale gate entry would skip classification after reset");
  assert.equal(sent.at(-1).text.includes("Session and model reset"), true);
});

// --------------------------------------------------------------------- /pair

test("/pair is refused outside Telegram", async () => {
  const { handle, sent } = makeHandler();
  assert.equal(await handle("slack", "i1", nextPeer(), "C1", "/pair abc"), true);
  assert.equal(sent[0].text, "Pairing is only available for Telegram private bots.");
});

test("/pair defers to the pairing gate and stops when it handles the message", async () => {
  let received;
  const { handle, sent } = makeHandler({
    handleTelegramPairingGate: async (input) => {
      received = input;
      return "handled";
    },
  });
  const peer = nextPeer();
  assert.equal(await handle("telegram", "i1", peer, "123", "/pair abc"), true);
  assert.equal(received.text, "/pair abc");
  assert.equal(received.peerKey, peer);
  assert.equal(sent.length, 0, "the gate owns the reply");
});

test("/pair on an already-paired chat says so", async () => {
  const { handle, sent } = makeHandler({ handleTelegramPairingGate: async () => "continue" });
  assert.equal(await handle("telegram", "i1", nextPeer(), "123", "/pair abc"), true);
  assert.equal(sent[0].text, "This chat is already paired.");
});

test("/pair forwards an existing binding directory to the gate", async () => {
  let received;
  const h = makeHandler({
    handleTelegramPairingGate: async (input) => {
      received = input;
      return "handled";
    },
  });
  const peer = nextPeer();
  h.bindings.set(peer, { directory: "/w/proj" });
  await h.handle("telegram", "i1", peer, "123", "/pair abc");
  assert.equal(received.bindingDirectory, "/w/proj");
});

test("/pair omits a blank binding directory rather than forwarding an empty string", async () => {
  let received;
  const h = makeHandler({
    handleTelegramPairingGate: async (input) => {
      received = input;
      return "handled";
    },
  });
  const peer = nextPeer();
  h.bindings.set(peer, { directory: "   " });
  await h.handle("telegram", "i1", peer, "123", "/pair abc");
  assert.equal("bindingDirectory" in received, false);
});

// ----------------------------------------------------------------- /dir, /cd

test("/dir with no argument shows the binding, then the session, then the default", async () => {
  const h = makeHandler();
  const peer = nextPeer();
  await h.handle("slack", "i1", peer, "C1", "/dir");
  assert.equal(h.sent.at(-1).text, "Current directory: /w", "falls back to the default");

  h.sessions.set(peer, { directory: "/w/from-session" });
  await h.handle("slack", "i1", peer, "C1", "/dir");
  assert.equal(h.sent.at(-1).text, "Current directory: /w/from-session");

  h.bindings.set(peer, { directory: "/w/from-binding" });
  await h.handle("slack", "i1", peer, "C1", "/dir");
  assert.equal(h.sent.at(-1).text, "Current directory: /w/from-binding", "the binding wins");
});

test("/dir <path> rebinds, drops the session, clears the gates and subscribes", async () => {
  const h = makeHandler();
  const peer = nextPeer();
  assert.equal(await h.handle("slack", "i1", peer, "C1", "/dir proj"), true);
  assert.deepEqual(h.bindings.get(peer), { directory: "/w/proj" });
  assert.deepEqual(h.deletedSessions, [peer]);
  assert.deepEqual(h.clearedGates, [peer]);
  assert.deepEqual(h.subscribed, ["/w/proj"], "the new directory needs its own event stream");
  assert.equal(h.sent.at(-1).text, "Directory set to: /w/proj");
});

test("/cd is an alias for /dir", async () => {
  const h = makeHandler();
  const peer = nextPeer();
  await h.handle("slack", "i1", peer, "C1", "/cd proj");
  assert.deepEqual(h.bindings.get(peer), { directory: "/w/proj" });
});

test("a directory outside the workspace root is reported and changes nothing", async () => {
  const h = makeHandler();
  const peer = nextPeer();
  assert.equal(await h.handle("slack", "i1", peer, "C1", "/dir /outside/etc"), true);
  assert.equal(h.sent.at(-1).text.includes("must stay within workspace root"), true);
  assert.equal(h.bindings.has(peer), false);
  assert.deepEqual(h.subscribed, []);
});

test("a directory containing spaces is kept intact", async () => {
  const h = makeHandler();
  const peer = nextPeer();
  await h.handle("slack", "i1", peer, "C1", "/dir my project");
  assert.deepEqual(h.bindings.get(peer), { directory: "/w/my project" });
});

// -------------------------------------------------------------------- /agent

test("/agent reports the workspace agent file and its status", async () => {
  const { handle, sent } = makeHandler();
  assert.equal(await handle("slack", "i1", nextPeer(), "C1", "/agent"), true);
  assert.deepEqual(sent[0].text.split("\n"), [
    "Scope: workspace",
    "Agent file: /w/.opencode/agents/superclaw-router.md",
    "OpenCode agent: build",
    "Status: loaded",
  ]);
});

test("/agent reports a missing agent file without failing", async () => {
  const { handle, sent } = makeHandler({
    loadMessagingAgentConfig: async () => ({ filePath: "/w/a.md", loaded: false, instructions: "" }),
  });
  await handle("slack", "i1", nextPeer(), "C1", "/agent");
  assert.equal(sent[0].text.includes("OpenCode agent: (none)"), true);
  assert.equal(sent[0].text.includes("Status: missing or empty"), true);
});

// --------------------------------------------------------------------- /help

test("/help lists every command it can handle", async () => {
  const { handle, sent } = makeHandler();
  assert.equal(await handle("slack", "i1", nextPeer(), "C1", "/help"), true);
  for (const name of ["/opus", "/codex", "/pair", "/dir", "/cd", "/agent", "/model", "/reset", "/help"]) {
    assert.equal(sent[0].text.includes(name), true, `${name} is missing from /help`);
  }
});

test("every command reply is sent as system output", async () => {
  const { handle, sent } = makeHandler();
  const peer = nextPeer();
  for (const text of ["/help", "/model", "/agent", "/dir"]) {
    await handle("slack", "i1", peer, "C1", text);
  }
  assert.equal(sent.length, 4);
  assert.equal(
    sent.every((entry) => entry.options.kind === "system"),
    true,
    "command output is bridge output, not agent output",
  );
});

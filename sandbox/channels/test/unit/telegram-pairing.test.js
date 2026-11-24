import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  createTelegramPairingGate,
  extractPairingCodeFromCommand,
  hashPairingCode,
  normalizePairingCodeValue,
} from "../../dist/telegram-pairing.js";

// The gate is the only thing standing between a private Telegram bot and an
// unpaired stranger prompting the agent, so its decision order matters: a public
// bot and an already-bound chat must never be gated, and every rejection has to
// answer the user rather than silently drop the message.

const CODE = "ABC123";
const CODE_HASH = hashPairingCode(CODE);

function makeDeps(overrides = {}) {
  const sent = [];
  const bindings = [];
  const deletedSessions = [];
  const subscribed = [];
  const deps = {
    sent,
    bindings,
    deletedSessions,
    subscribed,
    sendText: async (channel, identityId, peerId, text, options) => {
      sent.push({ channel, identityId, peerId, text, options });
    },
    resolveTelegramIdentityAccess: () => ({ access: "private", pairingCodeHash: CODE_HASH }),
    resolveIdentityDirectory: () => "/work/dir",
    resolveScopedDirectory: (input) => ({ ok: true, directory: input }),
    isDangerousRootDirectory: () => false,
    ensureEventSubscription: (directory) => subscribed.push(directory),
    store: {
      upsertBinding: (...args) => bindings.push(args),
      deleteSession: (...args) => deletedSessions.push(args),
    },
    defaultDirectory: "/work/default",
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    ...overrides,
  };
  return deps;
}

const baseInput = { identityId: "bot1", peerKey: "peer1", peerId: "12345", text: "hello" };

// ------------------------------------------------------------ pure helpers

test("normalizes a code by upper-casing and dropping punctuation", () => {
  assert.equal(normalizePairingCodeValue("  abc-123 "), "ABC123");
  assert.equal(normalizePairingCodeValue("a.b_c 1!2@3"), "ABC123");
});

test("hashing is insensitive to the punctuation a user might retype", () => {
  assert.equal(hashPairingCode("abc-123"), hashPairingCode("ABC 123"));
  assert.equal(hashPairingCode("abc123").length, 64);
});

test("extracts the code from /pair and from Telegram's /pair@botname form", () => {
  assert.equal(extractPairingCodeFromCommand("/pair abc-123"), "ABC123");
  assert.equal(extractPairingCodeFromCommand("/pair@my_bot abc123"), "ABC123");
  assert.equal(extractPairingCodeFromCommand("  /PAIR abc123  "), "ABC123");
});

test("returns no code for a bare /pair or an unrelated message", () => {
  assert.equal(extractPairingCodeFromCommand("/pair"), "");
  assert.equal(extractPairingCodeFromCommand("/pair   "), "");
  assert.equal(extractPairingCodeFromCommand("hello"), "");
});

// ------------------------------------------------------------------ the gate

test("a public bot is never gated", async () => {
  const deps = makeDeps({ resolveTelegramIdentityAccess: () => ({ access: "public", pairingCodeHash: "" }) });
  const result = await createTelegramPairingGate(deps)(baseInput);
  assert.equal(result, "continue");
  assert.equal(deps.sent.length, 0);
});

test("an already-bound chat is not gated, even on a private bot", async () => {
  const deps = makeDeps();
  const result = await createTelegramPairingGate(deps)({ ...baseInput, bindingDirectory: "/work/dir" });
  assert.equal(result, "continue");
  assert.equal(deps.sent.length, 0);
});

test("a live session directory also counts as bound", async () => {
  const deps = makeDeps();
  const result = await createTelegramPairingGate(deps)({ ...baseInput, sessionDirectory: "/work/dir" });
  assert.equal(result, "continue");
});

test("an unbound chat with no code is told how to pair", async () => {
  const deps = makeDeps();
  const result = await createTelegramPairingGate(deps)(baseInput);
  assert.equal(result, "handled");
  assert.equal(deps.sent.length, 1);
  assert.equal(deps.sent[0].text.includes("/pair <code>"), true);
  assert.deepEqual(deps.sent[0].options, { kind: "system" });
  assert.equal(deps.bindings.length, 0);
});

test("a private bot with no configured code hash says so instead of rejecting the user", async () => {
  const deps = makeDeps({ resolveTelegramIdentityAccess: () => ({ access: "private", pairingCodeHash: "" }) });
  const result = await createTelegramPairingGate(deps)({ ...baseInput, text: `/pair ${CODE}` });
  assert.equal(result, "handled");
  assert.equal(deps.sent[0].text.includes("missing a pairing code"), true);
  assert.equal(deps.bindings.length, 0);
});

test("a wrong code is rejected and binds nothing", async () => {
  const deps = makeDeps();
  const result = await createTelegramPairingGate(deps)({ ...baseInput, text: "/pair WRONG" });
  assert.equal(result, "handled");
  assert.equal(deps.sent[0].text.includes("Invalid pairing code"), true);
  assert.equal(deps.bindings.length, 0);
  assert.equal(deps.subscribed.length, 0);
});

test("the correct code binds the chat, clears any stale session and subscribes to events", async () => {
  const deps = makeDeps();
  const result = await createTelegramPairingGate(deps)({ ...baseInput, text: `/pair ${CODE}` });
  assert.equal(result, "handled");
  assert.deepEqual(deps.bindings, [["telegram", "bot1", "peer1", "/work/dir"]]);
  assert.deepEqual(deps.deletedSessions, [["telegram", "bot1", "peer1"]]);
  assert.deepEqual(deps.subscribed, ["/work/dir"]);
  assert.equal(deps.sent.at(-1).text.includes("Pairing successful"), true);
});

test("a punctuated retype of the right code still pairs", async () => {
  const deps = makeDeps();
  const result = await createTelegramPairingGate(deps)({ ...baseInput, text: "/pair abc-123" });
  assert.equal(result, "handled");
  assert.equal(deps.bindings.length, 1);
});

test("a dangerous root falls back to a message rather than binding the filesystem root", async () => {
  // No per-identity directory, so the candidate is the default; if that is a
  // root the gate must refuse rather than hand the agent the whole disk.
  const deps = makeDeps({
    resolveIdentityDirectory: () => "",
    isDangerousRootDirectory: () => true,
  });
  const result = await createTelegramPairingGate(deps)({ ...baseInput, text: `/pair ${CODE}` });
  assert.equal(result, "handled");
  assert.equal(deps.sent[0].text.includes("No workspace directory configured"), true);
  assert.equal(deps.bindings.length, 0);
});

test("an explicit per-identity directory is trusted even if it looks like a root", async () => {
  const deps = makeDeps({
    resolveIdentityDirectory: () => "/",
    isDangerousRootDirectory: () => true,
  });
  const result = await createTelegramPairingGate(deps)({ ...baseInput, text: `/pair ${CODE}` });
  assert.equal(result, "handled");
  assert.deepEqual(deps.bindings, [["telegram", "bot1", "peer1", "/"]]);
});

test("a directory the scope check rejects surfaces that error to the user", async () => {
  const deps = makeDeps({
    resolveScopedDirectory: () => ({ ok: false, error: "Directory is outside the workspace." }),
  });
  const result = await createTelegramPairingGate(deps)({ ...baseInput, text: `/pair ${CODE}` });
  assert.equal(result, "handled");
  assert.equal(deps.sent[0].text, "Directory is outside the workspace.");
  assert.equal(deps.bindings.length, 0);
});

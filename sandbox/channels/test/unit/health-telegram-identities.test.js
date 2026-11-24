import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";

import { createTelegramIdentityHandlers } from "../../dist/health-telegram-identities.js";

// Each write has to keep the config file, the runtime telegramBots list and the
// running adapter in step. These tests use a real config file on disk so the
// round-trip through readConfigFile/writeConfigFile is exercised, and stub only
// the adapter factory and its bounded start.

// These mirror the production normalizers in `bridge.ts`. A looser double would
// let the private-access cases below pass on hashes the real bridge discards.
const PAIRING_CODE_HASH_PATTERN = /^[a-f0-9]{64}$/;
const normalizeIdentityId = (value) => (typeof value === "string" && value.trim() ? value.trim() : "default");
const normalizeTelegramAccess = (value) => {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  return raw === "private" ? "private" : "public";
};
const normalizePairingCodeHash = (value) => {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  return PAIRING_CODE_HASH_PATTERN.test(raw) ? raw : "";
};

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

async function makeHandlers(overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), "tg-identities-"));
  const configPath = join(dir, "config.json");
  await writeFile(configPath, JSON.stringify({ version: 1, channels: overrides.channels ?? {} }), "utf8");

  const stopped = [];
  const startCalls = [];
  const created = [];
  // `stopped` and `startCalls` record that each call happened, not which came
  // first. This one ordered log is what makes interleaving visible.
  const events = [];
  const onErrors = [];
  const adapters = new Map();
  const config = {
    configPath,
    configFile: undefined,
    telegramBots: overrides.telegramBots ?? [],
    slackApps: [],
  };
  const deps = {
    config,
    adapters,
    adapterKey: (channel, identityId) => `${channel}:${identityId}`,
    normalizeIdentityId,
    normalizeTelegramAccess,
    normalizePairingCodeHash,
    startAdapterBounded: async (adapter, options) => {
      startCalls.push(adapter.key);
      events.push(`start:${adapter.key}`);
      if (options.onError) onErrors.push(options.onError);
      const result = overrides.startResult ?? { status: "started" };
      if (result.status === "error") options.onError?.(result.error);
      return result;
    },
    createAdapter: (identity) => (created.push(identity), {
      name: "telegram",
      identityId: identity.id,
      maxTextLength: 4096,
      start: async () => {},
      stop: async () => {
        events.push(`stop-created:${identity.token}`);
      },
      sendText: async () => {},
    }),
    handleInbound: async () => {},
    mediaStore: {},
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  };
  const seedAdapter = (key) => {
    adapters.set(key, {
      key,
      name: "telegram",
      identityId: key.split(":")[1],
      maxTextLength: 4096,
      start: async () => {},
      stop: async () => {
        if (overrides.stopDelayMs) await new Promise((resolve) => setTimeout(resolve, overrides.stopDelayMs));
        stopped.push(key);
        events.push(`stop:${key}`);
        if (overrides.stopThrows) throw new Error("stop failed");
      },
      sendText: async () => {},
    });
  };
  const readConfig = async () => JSON.parse(await readFile(configPath, "utf8"));
  return {
    ...createTelegramIdentityHandlers(deps),
    config,
    adapters,
    stopped,
    startCalls,
    created,
    events,
    onErrors,
    seedAdapter,
    readConfig,
  };
}

// ---------------------------------------------------------------------- list

test("listing reports which identities are actually running", async () => {
  const h = await makeHandlers({
    telegramBots: [
      { id: "a", token: "t", enabled: true },
      { id: "b", token: "t", enabled: false, access: "private" },
    ],
  });
  h.seedAdapter("telegram:a");
  const { items } = await h.listTelegramIdentities();
  assert.deepEqual(items, [
    { id: "a", enabled: true, running: true, access: "public", pairingRequired: false },
    { id: "b", enabled: false, running: false, access: "private", pairingRequired: true },
  ]);
});

test("listing carries the bot an adapter has started as, and nothing for one that has not", async () => {
  const h = await makeHandlers({
    telegramBots: [
      { id: "a", token: "t", enabled: true },
      { id: "b", token: "t", enabled: true },
    ],
  });
  h.seedAdapter("telegram:a");
  h.seedAdapter("telegram:b");
  h.adapters.get("telegram:a").botInfo = () => ({ id: 42, username: "demo_bot", name: "Demo" });
  h.adapters.get("telegram:b").botInfo = () => null;

  const { items } = await h.listTelegramIdentities();

  assert.deepEqual(items[0].bot, { id: 42, username: "demo_bot", name: "Demo" });
  assert.equal("bot" in items[1], false);
  assert.equal(JSON.stringify(items).includes('"token"'), false, "a listing never carries a token");
});

// -------------------------------------------------------------------- upsert

test("a token is required", async () => {
  const h = await makeHandlers();
  await assert.rejects(() => h.upsertTelegramIdentity({ token: "   " }), /token is required/);
});

test("the env identity id is reserved", async () => {
  const h = await makeHandlers();
  await assert.rejects(() => h.upsertTelegramIdentity({ id: "env", token: "t" }), /reserved/);
});

test("a new identity is written to the config file and the runtime list together", async () => {
  const h = await makeHandlers();
  const result = await h.upsertTelegramIdentity({ id: "a", token: "tok", directory: "/w/proj" });
  assert.deepEqual(result, { id: "a", enabled: true, access: "public", pairingRequired: false, applied: true });

  const file = await h.readConfig();
  assert.deepEqual(file.channels.telegram.bots, [
    { id: "a", token: "tok", enabled: true, directory: "/w/proj", access: "public" },
  ]);
  assert.equal(file.channels.telegram.enabled, true);
  assert.deepEqual(h.config.telegramBots, [
    { id: "a", token: "tok", enabled: true, directory: "/w/proj", access: "public" },
  ]);
});

test("an existing identity is replaced, not duplicated", async () => {
  const h = await makeHandlers({
    channels: { telegram: { bots: [{ id: "a", token: "old", enabled: true, access: "public" }] } },
    telegramBots: [{ id: "a", token: "old", enabled: true }],
  });
  await h.upsertTelegramIdentity({ id: "a", token: "new" });
  const file = await h.readConfig();
  assert.equal(file.channels.telegram.bots.length, 1);
  assert.equal(file.channels.telegram.bots[0].token, "new");
  assert.equal(h.config.telegramBots.length, 1);
});

test("other identities are left untouched by an upsert", async () => {
  const h = await makeHandlers({
    channels: { telegram: { bots: [{ id: "keep", token: "k", enabled: true }] } },
  });
  await h.upsertTelegramIdentity({ id: "a", token: "tok" });
  const file = await h.readConfig();
  assert.deepEqual(file.channels.telegram.bots.map((b) => b.id).sort(), ["a", "keep"]);
});

test("an omitted directory keeps the one already on the identity", async () => {
  const h = await makeHandlers({
    channels: { telegram: { bots: [{ id: "a", token: "old", directory: "/w/kept" }] } },
  });
  await h.upsertTelegramIdentity({ id: "a", token: "new" });
  const file = await h.readConfig();
  assert.equal(file.channels.telegram.bots[0].directory, "/w/kept");
});

// The test above shows the config file keeps the directory; this one shows the
// adapter that actually runs gets it too. Both are now built from one resolved
// identity rather than from the raw input (#2961 item 1).
test("an omitted directory reaches the adapter too, so disk and runtime agree", async () => {
  const h = await makeHandlers({
    channels: { telegram: { bots: [{ id: "a", token: "old", directory: "/w/kept" }] } },
    telegramBots: [{ id: "a", token: "old", enabled: true, directory: "/w/kept" }],
  });
  await h.upsertTelegramIdentity({ id: "a", token: "new" });

  const file = await h.readConfig();
  assert.equal(file.channels.telegram.bots[0].directory, "/w/kept", "config keeps it");
  assert.equal(h.config.telegramBots[0].directory, "/w/kept", "the runtime list keeps it");
  assert.equal(h.created.length, 1);
  assert.equal(h.created[0].directory, "/w/kept", "and the live adapter is built with it");
});

// The file and the runtime list can disagree within one run. An omitted
// directory used to keep the file's value on disk and the runtime list's value
// on the adapter, so the workspace changed at the next restart.
test("an omitted directory is resolved once and written back to the file", async () => {
  const h = await makeHandlers({
    channels: { telegram: { bots: [{ id: "a", token: "old", directory: "/file-dir", access: "public" }] } },
    telegramBots: [{ id: "a", token: "old", enabled: true, directory: "/runtime-dir", access: "public" }],
  });
  await h.upsertTelegramIdentity({ id: "a", token: "new" });

  const file = await h.readConfig();
  assert.equal(file.channels.telegram.bots[0].directory, "/runtime-dir", "disk takes the live directory");
  assert.equal(h.config.telegramBots[0].directory, "/runtime-dir");
  assert.equal(h.created[0].directory, "/runtime-dir", "and so does the adapter");
});

// The config file and the runtime list are resolved from different sources, so
// one can reject after the other has been accepted. Writing the file before
// that second validation made the divergence permanent on disk (#2961 item 2).
test("a runtime validation failure leaves the config file untouched", async () => {
  const h = await makeHandlers({
    channels: { telegram: { bots: [{ id: "a", token: "old", access: "private", pairingCodeHash: HASH_A }] } },
    // The runtime copy has drifted: private, but without the hash the file carries.
    telegramBots: [{ id: "a", token: "old", enabled: true, access: "private" }],
  });

  await assert.rejects(
    () => h.upsertTelegramIdentity({ id: "a", token: "new" }),
    /pairingCodeHash is required/,
  );

  const file = await h.readConfig();
  assert.equal(file.channels.telegram.bots[0].token, "old", "a rejected upsert must not reach disk");
  assert.equal(h.config.telegramBots[0].token, "old", "nor the runtime list");
  assert.deepEqual(h.startCalls, []);
});

// Stopping the running adapter is an await point. Without a per-slot queue both
// upserts stop the seeded adapter, and the second then drops the first's
// freshly started adapter from the map without stopping it, leaking a live bot
// (#2961 item 3).
test("concurrent upserts for one identity do not interleave", async () => {
  const h = await makeHandlers({
    stopDelayMs: 5,
    channels: { telegram: { bots: [{ id: "a", token: "old" }] } },
    telegramBots: [{ id: "a", token: "old", enabled: true }],
  });
  h.seedAdapter("telegram:a");

  await Promise.all([
    h.upsertTelegramIdentity({ id: "a", token: "one" }),
    h.upsertTelegramIdentity({ id: "a", token: "two" }),
  ]);

  assert.deepEqual(h.events, [
    "stop:telegram:a",
    "start:telegram:a",
    "stop-created:one",
    "start:telegram:a",
  ]);
  assert.deepEqual(h.created.map((identity) => identity.token), ["one", "two"]);
  assert.equal(h.config.telegramBots[0].token, "two");
  assert.equal(h.adapters.size, 1);
});

test("a delete racing an upsert leaves the file, the runtime list and the map in agreement", async () => {
  const h = await makeHandlers({
    stopDelayMs: 5,
    channels: { telegram: { bots: [{ id: "a", token: "old" }] } },
    telegramBots: [{ id: "a", token: "old", enabled: true }],
  });
  h.seedAdapter("telegram:a");

  await Promise.all([
    h.upsertTelegramIdentity({ id: "a", token: "one" }),
    h.deleteTelegramIdentity("a"),
  ]);

  const file = await h.readConfig();
  const inFile = file.channels.telegram.bots.some((bot) => bot.id === "a");
  const inRuntime = h.config.telegramBots.some((bot) => bot.id === "a");
  assert.equal(inFile, inRuntime);
  assert.equal(h.adapters.has("telegram:a"), inRuntime, "a started adapter is not left behind a delete");
  if (inRuntime) {
    assert.equal(h.config.telegramBots[0].token, "one");
    assert.equal(file.channels.telegram.bots.find((bot) => bot.id === "a").token, "one");
    assert.deepEqual(h.events, ["stop:telegram:a", "start:telegram:a"]);
  } else {
    assert.equal(h.adapters.size, 0);
    assert.deepEqual(h.events, ["stop:telegram:a", "start:telegram:a", "stop-created:one"]);
  }
});

// A bounded start reports a timeout but leaves the start running, so its
// failure can land after a later upsert has taken the slot (#2961 item 4).
test("a late start failure does not evict a replacement adapter", async () => {
  const h = await makeHandlers({ startResult: { status: "timeout" } });
  await h.upsertTelegramIdentity({ id: "a", token: "one" });
  const staleOnError = h.onErrors[0];
  await h.upsertTelegramIdentity({ id: "a", token: "two" });
  const replacement = h.adapters.get("telegram:a");
  assert.ok(replacement, "the second upsert installed an adapter");

  staleOnError(new Error("socket refused"));

  assert.equal(h.adapters.get("telegram:a"), replacement, "the replacement must survive");
});

test("private access without a pairing hash is refused", async () => {
  const h = await makeHandlers();
  await assert.rejects(
    () => h.upsertTelegramIdentity({ id: "a", token: "t", access: "private" }),
    /pairingCodeHash is required/,
  );
});

test("private access with a pairing hash is stored", async () => {
  const h = await makeHandlers();
  const result = await h.upsertTelegramIdentity({
    id: "a",
    token: "t",
    access: "private",
    pairingCodeHash: HASH_A,
  });
  assert.equal(result.pairingRequired, true);
  const file = await h.readConfig();
  assert.equal(file.channels.telegram.bots[0].pairingCodeHash, HASH_A);
});

test("private access with a malformed pairing hash is refused", async () => {
  const h = await makeHandlers();
  await assert.rejects(
    () => h.upsertTelegramIdentity({ id: "a", token: "t", access: "private", pairingCodeHash: "abc123" }),
    /pairingCodeHash is required/,
  );
});

test("an existing private identity keeps its hash when the caller omits one", async () => {
  const h = await makeHandlers({
    channels: { telegram: { bots: [{ id: "a", token: "t", access: "private", pairingCodeHash: HASH_A }] } },
  });
  await h.upsertTelegramIdentity({ id: "a", token: "t2" });
  const file = await h.readConfig();
  assert.equal(file.channels.telegram.bots[0].pairingCodeHash, HASH_A);
});

test("switching an identity to public drops its pairing hash", async () => {
  const h = await makeHandlers({
    channels: { telegram: { bots: [{ id: "a", token: "t", access: "private", pairingCodeHash: HASH_B }] } },
  });
  await h.upsertTelegramIdentity({ id: "a", token: "t", access: "public" });
  const file = await h.readConfig();
  assert.equal("pairingCodeHash" in file.channels.telegram.bots[0], false);
});

test("upserting the default identity clears the legacy single-app Slack tokens", async () => {
  const h = await makeHandlers({
    channels: { slack: { botToken: "xoxb-old", appToken: "xapp-old", other: "keep" } },
  });
  await h.upsertTelegramIdentity({ token: "t" });
  const file = await h.readConfig();
  assert.equal("botToken" in file.channels.slack, false);
  assert.equal("appToken" in file.channels.slack, false);
  assert.equal(file.channels.slack.other, "keep", "unrelated slack config survives");
});

test("a named identity does not touch the Slack tokens", async () => {
  const h = await makeHandlers({ channels: { slack: { botToken: "xoxb-old" } } });
  await h.upsertTelegramIdentity({ id: "a", token: "t" });
  const file = await h.readConfig();
  assert.equal(file.channels.slack.botToken, "xoxb-old");
});

// ------------------------------------------------------- adapter start / stop

test("a fresh identity starts an adapter and registers it", async () => {
  const h = await makeHandlers();
  await h.upsertTelegramIdentity({ id: "a", token: "t" });
  assert.deepEqual(h.startCalls, ["telegram:a"]);
  assert.equal(h.adapters.get("telegram:a").key, "telegram:a", "the adapter carries its own map key");
});

test("re-upserting stops the old adapter before starting the new one", async () => {
  const h = await makeHandlers();
  h.seedAdapter("telegram:a");
  await h.upsertTelegramIdentity({ id: "a", token: "t2" });
  assert.deepEqual(h.stopped, ["telegram:a"]);
  assert.deepEqual(h.startCalls, ["telegram:a"]);
});

test("disabling an identity stops its adapter and starts nothing", async () => {
  const h = await makeHandlers();
  h.seedAdapter("telegram:a");
  const result = await h.upsertTelegramIdentity({ id: "a", token: "t", enabled: false });
  assert.deepEqual(result, { id: "a", enabled: false, access: "public", pairingRequired: false, applied: true });
  assert.deepEqual(h.stopped, ["telegram:a"]);
  assert.equal(h.adapters.has("telegram:a"), false);
  assert.deepEqual(h.startCalls, []);
});

test("an adapter that throws on stop is still forgotten", async () => {
  const h = await makeHandlers({ stopThrows: true });
  h.seedAdapter("telegram:a");
  await h.upsertTelegramIdentity({ id: "a", token: "t", enabled: false });
  assert.equal(h.adapters.has("telegram:a"), false, "a failed stop must not wedge the map");
});

test("a start timeout reports starting rather than applied", async () => {
  const h = await makeHandlers({ startResult: { status: "timeout" } });
  const result = await h.upsertTelegramIdentity({ id: "a", token: "t" });
  assert.equal(result.applied, false);
  assert.equal(result.starting, true);
  assert.equal(h.adapters.has("telegram:a"), true, "a slow start is left to finish");
});

test("a start error is reported and the adapter is dropped", async () => {
  const h = await makeHandlers({ startResult: { status: "error", error: new Error("bad token") } });
  const result = await h.upsertTelegramIdentity({ id: "a", token: "t" });
  assert.equal(result.applied, false);
  assert.equal(result.error.includes("bad token"), true);
  assert.equal(h.adapters.has("telegram:a"), false);
});

// -------------------------------------------------------------------- delete

test("the env identity cannot be deleted", async () => {
  const h = await makeHandlers();
  await assert.rejects(() => h.deleteTelegramIdentity("env"), /cannot be deleted/);
});

test("deleting removes the identity from the file, the runtime list and the adapters", async () => {
  const h = await makeHandlers({
    channels: { telegram: { bots: [{ id: "a", token: "t" }, { id: "b", token: "t" }] } },
    telegramBots: [{ id: "a", token: "t" }, { id: "b", token: "t" }],
  });
  h.seedAdapter("telegram:a");
  const result = await h.deleteTelegramIdentity("a");
  assert.deepEqual(result, { id: "a", deleted: true });
  const file = await h.readConfig();
  assert.deepEqual(file.channels.telegram.bots.map((b) => b.id), ["b"]);
  assert.deepEqual(h.config.telegramBots.map((b) => b.id), ["b"]);
  assert.deepEqual(h.stopped, ["telegram:a"]);
});

test("deleting an unknown identity reports deleted:false without failing", async () => {
  const h = await makeHandlers({ channels: { telegram: { bots: [{ id: "b", token: "t" }] } } });
  const result = await h.deleteTelegramIdentity("a");
  assert.deepEqual(result, { id: "a", deleted: false });
  const file = await h.readConfig();
  assert.deepEqual(file.channels.telegram.bots.map((b) => b.id), ["b"]);
});

test("the runtime list is mutated in place, so holders of the array see the delete", async () => {
  const bots = [{ id: "a", token: "t" }];
  const h = await makeHandlers({
    channels: { telegram: { bots: [{ id: "a", token: "t" }] } },
    telegramBots: bots,
  });
  await h.deleteTelegramIdentity("a");
  assert.deepEqual(bots, [], "adapters hold a reference to this array");
});

import assert from "node:assert/strict";
import { test } from "bun:test";

import { createSlackIdentityHandlers } from "../../dist/health-slack-identities.js";

// The ordering that matters here: verification runs before anything is mutated,
// so a rejected token cannot leave a half-applied identity behind.

function makeHandlers(overrides = {}) {
  const stopped = [];
  const startCalls = [];
  // `stopped` and `startCalls` record that each call happened, not which came
  // first, so a replacement that started before the old adapter stopped would
  // satisfy both. This one ordered log is what makes that visible.
  const events = [];
  const created = [];
  const onErrors = [];
  const verified = [];
  const adapters = new Map();
  const config = { slackApps: overrides.slackApps ?? [] };
  const deps = {
    config,
    adapters,
    adapterKey: (channel, identityId) => `${channel}:${identityId}`,
    normalizeIdentityId: (value) => (typeof value === "string" && value.trim() ? value.trim() : "default"),
    verifySlackIdentity: async (input) => {
      verified.push(input);
      if (overrides.verifyThrows) throw Object.assign(new Error("Slack rejected the bot token."), { status: 400 });
      return overrides.teamFields ?? { teamName: "Acme", teamId: "T1", botUserId: "U1" };
    },
    createAdapter: (identity) => (created.push(identity), {
      name: "slack",
      identityId: identity.id,
      maxTextLength: 3000,
      start: async () => {},
      stop: async () => {
        events.push(`stop-created:${identity.botToken}`);
      },
      sendText: async () => {},
    }),
    startAdapterBounded: async (adapter, options) => {
      startCalls.push(adapter.key);
      events.push(`start:${adapter.key}`);
      if (options.onError) onErrors.push(options.onError);
      const result = overrides.startResult ?? { status: "started" };
      if (result.status === "error") options.onError?.(result.error);
      return result;
    },
    handleInbound: async () => {},
    mediaStore: {},
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  };
  const seedAdapter = (key) => {
    adapters.set(key, {
      key,
      name: "slack",
      identityId: key.split(":")[1],
      maxTextLength: 3000,
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
  return {
    ...createSlackIdentityHandlers(deps),
    config,
    adapters,
    stopped,
    startCalls,
    events,
    created,
    onErrors,
    verified,
    seedAdapter,
  };
}

// ---------------------------------------------------------------------- list

test("listing reports which Slack apps are running", async () => {
  const h = makeHandlers({ slackApps: [{ id: "a", enabled: true }, { id: "b", enabled: false }] });
  h.seedAdapter("slack:a");
  const { items } = await h.listSlackIdentities();
  assert.deepEqual(items, [
    { id: "a", enabled: true, running: true },
    { id: "b", enabled: false, running: false },
  ]);
});

// -------------------------------------------------------------------- upsert

test("both tokens are required", async () => {
  const h = makeHandlers();
  await assert.rejects(() => h.upsertSlackIdentity({ botToken: "b", appToken: " " }), /botToken and appToken/);
  await assert.rejects(() => h.upsertSlackIdentity({ botToken: " ", appToken: "a" }), /botToken and appToken/);
});

test("the env identity id is reserved", async () => {
  const h = makeHandlers();
  await assert.rejects(
    () => h.upsertSlackIdentity({ id: "env", botToken: "b", appToken: "a" }),
    /reserved/,
  );
});

test("verification runs before the identity is recorded", async () => {
  const h = makeHandlers({ verifyThrows: true });
  await assert.rejects(() => h.upsertSlackIdentity({ id: "a", botToken: "b", appToken: "a" }), /Slack rejected/);
  assert.deepEqual(h.config.slackApps, [], "a rejected token must not half-apply");
  assert.deepEqual(h.startCalls, []);
});

test("a verified identity is recorded and its adapter started", async () => {
  const h = makeHandlers();
  const result = await h.upsertSlackIdentity({ id: "a", botToken: "xoxb", appToken: "xapp", directory: "/w/p" });
  assert.deepEqual(result, {
    id: "a",
    enabled: true,
    applied: true,
    teamName: "Acme",
    teamId: "T1",
    botUserId: "U1",
  });
  assert.deepEqual(h.config.slackApps, [
    { id: "a", botToken: "xoxb", appToken: "xapp", enabled: true, directory: "/w/p" },
  ]);
  assert.deepEqual(h.startCalls, ["slack:a"]);
});

test("the verified team fields ride on every outcome", async () => {
  for (const startResult of [{ status: "timeout" }, { status: "error", error: new Error("x") }]) {
    const h = makeHandlers({ startResult });
    const result = await h.upsertSlackIdentity({ id: "a", botToken: "b", appToken: "a" });
    assert.equal(result.teamName, "Acme", "the UI shows the workspace name even when the start did not finish");
  }
});

test("an existing identity is replaced, not duplicated", async () => {
  const h = makeHandlers({ slackApps: [{ id: "a", botToken: "old", appToken: "old", enabled: true }] });
  await h.upsertSlackIdentity({ id: "a", botToken: "new", appToken: "new" });
  assert.equal(h.config.slackApps.length, 1);
  assert.equal(h.config.slackApps[0].botToken, "new");
});

test("an omitted directory keeps the one already on the identity", async () => {
  const h = makeHandlers({ slackApps: [{ id: "a", botToken: "o", appToken: "o", directory: "/w/kept" }] });
  await h.upsertSlackIdentity({ id: "a", botToken: "n", appToken: "n" });
  assert.equal(h.config.slackApps[0].directory, "/w/kept");
  // The adapter that actually runs is built from the same resolved identity, so
  // it cannot be left without the directory the list kept (#2961 item 1).
  assert.equal(h.created[0].directory, "/w/kept", "and the live adapter is built with it");
});

// Stopping the running adapter is an await point. Without a per-slot queue both
// upserts stop the seeded adapter, and the second then drops the first's
// freshly started adapter from the map without stopping it, leaking a live
// socket (#2961 item 3).
test("concurrent upserts for one identity do not interleave", async () => {
  const h = makeHandlers({
    stopDelayMs: 5,
    slackApps: [{ id: "a", botToken: "old", appToken: "old", enabled: true }],
  });
  h.seedAdapter("slack:a");

  await Promise.all([
    h.upsertSlackIdentity({ id: "a", botToken: "one", appToken: "one" }),
    h.upsertSlackIdentity({ id: "a", botToken: "two", appToken: "two" }),
  ]);

  assert.deepEqual(h.events, ["stop:slack:a", "start:slack:a", "stop-created:one", "start:slack:a"]);
  assert.deepEqual(h.created.map((identity) => identity.botToken), ["one", "two"]);
  assert.equal(h.config.slackApps.length, 1);
  assert.equal(h.config.slackApps[0].botToken, "two");
  assert.equal(h.adapters.size, 1);
});

// Deletes take the same per-identity slot as upserts. Without that, a delete
// can remove the identity from config and return before the upsert's start
// lands, leaving a started adapter the map still holds and nothing will stop.
test("a delete racing an upsert leaves the map and the config in agreement", async () => {
  const h = makeHandlers({
    stopDelayMs: 5,
    slackApps: [{ id: "a", botToken: "old", appToken: "old", enabled: true }],
  });
  h.seedAdapter("slack:a");

  await Promise.all([
    h.upsertSlackIdentity({ id: "a", botToken: "one", appToken: "one" }),
    h.deleteSlackIdentity("a"),
  ]);

  const kept = h.config.slackApps.find((app) => app.id === "a");
  assert.equal(h.adapters.has("slack:a"), Boolean(kept), "the map and slackApps describe the same identity");
  if (kept) {
    assert.equal(kept.botToken, "one");
    assert.equal(h.adapters.size, 1);
    assert.deepEqual(h.events, ["stop:slack:a", "start:slack:a"]);
  } else {
    assert.equal(h.adapters.size, 0);
    assert.deepEqual(h.events, ["stop:slack:a", "start:slack:a", "stop-created:one"]);
  }
});

// A bounded start reports a timeout but leaves the start running, so its
// failure can land after a later upsert has taken the slot (#2961 item 4).
test("a late start failure does not evict a replacement adapter", async () => {
  const h = makeHandlers({ startResult: { status: "timeout" } });
  await h.upsertSlackIdentity({ id: "a", botToken: "one", appToken: "one" });
  const staleOnError = h.onErrors[0];
  await h.upsertSlackIdentity({ id: "a", botToken: "two", appToken: "two" });
  const replacement = h.adapters.get("slack:a");
  assert.ok(replacement, "the second upsert installed an adapter");

  staleOnError(new Error("socket refused"));

  assert.equal(h.adapters.get("slack:a"), replacement, "the replacement must survive");
});

test("disabling stops the adapter and starts nothing", async () => {
  const h = makeHandlers();
  h.seedAdapter("slack:a");
  const result = await h.upsertSlackIdentity({ id: "a", botToken: "b", appToken: "a", enabled: false });
  assert.equal(result.enabled, false);
  assert.equal(result.applied, true);
  assert.deepEqual(h.stopped, ["slack:a"]);
  assert.equal(h.adapters.has("slack:a"), false);
  assert.deepEqual(h.startCalls, []);
});

test("disabling does not ask Slack, so a revoked token can still be switched off", async () => {
  const h = makeHandlers({ verifyThrows: true });
  h.seedAdapter("slack:a");
  const result = await h.upsertSlackIdentity({ id: "a", botToken: "b", appToken: "a", enabled: false });
  assert.equal(result.applied, true);
  assert.deepEqual(h.verified, []);
  assert.equal(h.adapters.has("slack:a"), false);
  assert.equal(h.config.slackApps[0].enabled, false);
});

test("re-upserting stops the old adapter before starting the new one", async () => {
  const h = makeHandlers();
  h.seedAdapter("slack:a");
  await h.upsertSlackIdentity({ id: "a", botToken: "b", appToken: "a" });
  assert.deepEqual(h.stopped, ["slack:a"]);
  assert.deepEqual(h.startCalls, ["slack:a"]);
  // The "before" in the name. Dropping this line leaves the test green against
  // a start-then-stop implementation, which would briefly run two adapters on
  // one identity and leave the surviving one holding a stopped socket.
  assert.deepEqual(h.events, ["stop:slack:a", "start:slack:a"]);
});

test("an adapter that throws on stop is still forgotten", async () => {
  const h = makeHandlers({ stopThrows: true });
  h.seedAdapter("slack:a");
  await h.upsertSlackIdentity({ id: "a", botToken: "b", appToken: "a", enabled: false });
  assert.equal(h.adapters.has("slack:a"), false);
});

// The slot queue holds its slot across the stop, and Slack's socket.disconnect()
// carries no bound of its own. An unbounded stop would park the slot forever and
// block every later upsert and delete for this identity until a restart.
test("a wedged stop does not hold the identity's slot", async () => {
  const h = makeHandlers({ stopDelayMs: 60_000 });
  h.seedAdapter("slack:a");

  const started = Date.now();
  await h.upsertSlackIdentity({ id: "a", botToken: "b", appToken: "a", enabled: false });
  // The next write for the same identity has to get its turn, not queue behind
  // the abandoned stop.
  await h.upsertSlackIdentity({ id: "a", botToken: "c", appToken: "a", enabled: false });

  assert.ok(Date.now() - started < 30_000, "both writes completed without waiting on the wedged stop");
  assert.equal(h.adapters.has("slack:a"), false, "the wedged adapter is dropped from the map anyway");
}, 40_000);

test("a start timeout reports starting and leaves the adapter to finish", async () => {
  const h = makeHandlers({ startResult: { status: "timeout" } });
  const result = await h.upsertSlackIdentity({ id: "a", botToken: "b", appToken: "a" });
  assert.equal(result.starting, true);
  assert.equal(result.applied, false);
  assert.equal(h.adapters.has("slack:a"), true);
});

test("a start error is reported and the adapter dropped", async () => {
  const h = makeHandlers({ startResult: { status: "error", error: new Error("socket refused") } });
  const result = await h.upsertSlackIdentity({ id: "a", botToken: "b", appToken: "a" });
  assert.equal(result.error.includes("socket refused"), true);
  assert.equal(h.adapters.has("slack:a"), false);
});

// -------------------------------------------------------------------- delete

test("the env identity cannot be deleted", async () => {
  const h = makeHandlers();
  await assert.rejects(() => h.deleteSlackIdentity("env"), /cannot be deleted/);
});

test("deleting removes the app and stops its adapter", async () => {
  const h = makeHandlers({ slackApps: [{ id: "a" }, { id: "b" }] });
  h.seedAdapter("slack:a");
  const result = await h.deleteSlackIdentity("a");
  assert.deepEqual(result, { id: "a", deleted: true });
  assert.deepEqual(h.config.slackApps.map((a) => a.id), ["b"]);
  assert.deepEqual(h.stopped, ["slack:a"]);
});

test("deleting an unknown identity reports deleted:false", async () => {
  const h = makeHandlers({ slackApps: [{ id: "b" }] });
  assert.deepEqual(await h.deleteSlackIdentity("a"), { id: "a", deleted: false });
});

test("the runtime list is mutated in place, so holders see the delete", async () => {
  const apps = [{ id: "a" }];
  const h = makeHandlers({ slackApps: apps });
  await h.deleteSlackIdentity("a");
  assert.deepEqual(apps, []);
});

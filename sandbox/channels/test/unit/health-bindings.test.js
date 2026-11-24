import assert from "node:assert/strict";
import { test } from "bun:test";

import { createBindingHandlers } from "../../dist/health-bindings.js";

// Setting or clearing a binding must always drop the session too: the session
// carries the old directory, so a surviving session keeps answering from the
// directory the user just moved away from.

function makeHandlers(overrides = {}) {
  const bindings = [];
  const upserted = [];
  const deletedBindings = [];
  const deletedSessions = [];
  const subscribed = [];
  const deps = {
    store: {
      listBindings: (filters) => {
        bindings.push(filters);
        return overrides.rows ?? [];
      },
      upsertBinding: (...args) => upserted.push(args),
      deleteBinding: (...args) => deletedBindings.push(args),
      deleteSession: (...args) => deletedSessions.push(args),
    },
    normalizeIdentityId: (value) => (typeof value === "string" && value.trim() ? value.trim() : "default"),
    resolveScopedDirectory: (input) =>
      input.startsWith("/outside")
        ? { ok: false, error: "Directory must stay within workspace root: /w" }
        : { ok: true, directory: `/w/${input.replace(/^\/+/, "")}` },
    ensureEventSubscription: (directory) => subscribed.push(directory),
    invalidTelegramPeerIdError: () => Object.assign(new Error("Invalid Telegram peerId"), { status: 400 }),
    ...(overrides.deps ?? {}),
  };
  return {
    ...createBindingHandlers(deps),
    filters: bindings,
    upserted,
    deletedBindings,
    deletedSessions,
    subscribed,
  };
}

// ------------------------------------------------------------- listBindings

test("bindings are mapped from snake_case rows to the API shape", async () => {
  const h = makeHandlers({
    rows: [
      { channel: "slack", identity_id: "i1", peer_id: "C1", directory: "/w/a", updated_at: 1700 },
    ],
  });
  const { items } = await h.listBindings();
  assert.deepEqual(items, [
    { channel: "slack", identityId: "i1", peerId: "C1", directory: "/w/a", updatedAt: 1700 },
  ]);
});

test("listing with no filters queries without any", async () => {
  const h = makeHandlers();
  await h.listBindings();
  assert.deepEqual(h.filters[0], {});
});

test("listing filters are normalized and passed through", async () => {
  const h = makeHandlers();
  await h.listBindings({ channel: "  SLACK ", identityId: " i1 " });
  assert.deepEqual(h.filters[0], { channel: "slack", identityId: "i1" });
});

const invalidChannel = (error) => {
  assert.equal(error.message, "Invalid channel");
  assert.equal(error.status, 400, "an unknown channel is a client error, not a 500");
  return true;
};

test("listing rejects an unknown channel", async () => {
  const h = makeHandlers();
  await assert.rejects(() => h.listBindings({ channel: "discord" }), invalidChannel);
});

test("a blank channel filter is treated as no filter", async () => {
  const h = makeHandlers();
  await h.listBindings({ channel: "   " });
  assert.deepEqual(h.filters[0], {});
});

// ---------------------------------------------------------------- setBinding

test("setting a binding persists it, drops the session and subscribes", async () => {
  const h = makeHandlers();
  await h.setBinding({ channel: "slack", identityId: "i1", peerId: "C1", directory: "proj" });
  assert.deepEqual(h.upserted, [["slack", "i1", "C1", "/w/proj"]]);
  assert.deepEqual(h.deletedSessions, [["slack", "i1", "C1"]], "the session holds the old directory");
  assert.deepEqual(h.subscribed, ["/w/proj"]);
});

test("an omitted identityId defaults", async () => {
  const h = makeHandlers();
  await h.setBinding({ channel: "slack", peerId: "C1", directory: "proj" });
  assert.equal(h.upserted[0][1], "default");
});

test("setting rejects an unknown channel before touching the store", async () => {
  const h = makeHandlers();
  await assert.rejects(
    () => h.setBinding({ channel: "discord", peerId: "C1", directory: "proj" }),
    invalidChannel,
  );
  assert.deepEqual(h.upserted, []);
});

test("peerId and directory are both required", async () => {
  const h = makeHandlers();
  await assert.rejects(() => h.setBinding({ channel: "slack", peerId: "  ", directory: "proj" }), /required/);
  await assert.rejects(() => h.setBinding({ channel: "slack", peerId: "C1", directory: " " }), /required/);
  assert.deepEqual(h.upserted, []);
});

test("a Telegram binding requires a valid numeric peer id", async () => {
  const h = makeHandlers();
  await assert.rejects(
    () => h.setBinding({ channel: "telegram", peerId: "not-a-chat", directory: "proj" }),
    /Invalid Telegram peerId/,
  );
  assert.deepEqual(h.upserted, []);
});

test("a valid Telegram peer id is accepted", async () => {
  const h = makeHandlers();
  await h.setBinding({ channel: "telegram", peerId: "123456", directory: "proj" });
  assert.deepEqual(h.upserted, [["telegram", "default", "123456", "/w/proj"]]);
});

test("a Slack peer id is not checked against the Telegram rule", async () => {
  const h = makeHandlers();
  await h.setBinding({ channel: "slack", peerId: "C1|168.1", directory: "proj" });
  assert.equal(h.upserted.length, 1);
});

test("a directory outside the workspace root is a 400 and changes nothing", async () => {
  const h = makeHandlers();
  await assert.rejects(
    () => h.setBinding({ channel: "slack", peerId: "C1", directory: "/outside/etc" }),
    (error) => {
      assert.equal(error.status, 400, "the UI needs a client error, not a 500");
      assert.equal(error.message.includes("must stay within workspace root"), true);
      return true;
    },
  );
  assert.deepEqual(h.upserted, []);
  assert.deepEqual(h.subscribed, []);
});

// -------------------------------------------------------------- clearBinding

test("clearing removes the binding and the session together", async () => {
  const h = makeHandlers();
  await h.clearBinding({ channel: "slack", identityId: "i1", peerId: "C1" });
  assert.deepEqual(h.deletedBindings, [["slack", "i1", "C1"]]);
  assert.deepEqual(h.deletedSessions, [["slack", "i1", "C1"]]);
});

test("clearing rejects an unknown channel", async () => {
  const h = makeHandlers();
  await assert.rejects(() => h.clearBinding({ channel: "discord", peerId: "C1" }), invalidChannel);
  assert.deepEqual(h.deletedBindings, []);
});

test("clearing requires a peerId", async () => {
  const h = makeHandlers();
  await assert.rejects(() => h.clearBinding({ channel: "slack", peerId: "   " }), /peerId is required/);
  assert.deepEqual(h.deletedBindings, []);
});

test("clearing does not subscribe anything", async () => {
  const h = makeHandlers();
  await h.clearBinding({ channel: "slack", peerId: "C1" });
  assert.deepEqual(h.subscribed, []);
});

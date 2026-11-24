import assert from "node:assert/strict";
import { test } from "bun:test";

import { createSessionLifecycle } from "../../dist/session-lifecycle.js";

// Creating a session has to keep the OpenCode session, the in-memory permission
// map and the persisted binding in step; these tests assert all three, plus the
// explicit title that suppresses opencode's extra title-generation LLM call.

function makeLifecycle(overrides = {}) {
  const created = [];
  const updated = [];
  const upserted = [];
  const sent = [];
  const statuses = [];
  const routerManagedSessions = new Set();
  const sessionsWithoutWildcardAllow = new Set();
  const sessionPermissionModes = new Map();
  const deps = {
    getClient: () => ({
      session: {
        create: async (input) => {
          created.push(input);
          return overrides.createResult === undefined ? { id: "sess-1" } : overrides.createResult;
        },
        update: async (input) => {
          updated.push(input);
          return {};
        },
      },
    }),
    store: {
      upsertSession: (...args) => upserted.push(args),
    },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    routerManagedSessions,
    sessionsWithoutWildcardAllow,
    sessionPermissionModes,
    sendText: async (_channel, _identityId, _peerId, text) => sent.push(text),
    formatPeer: (_channel, peerId) => peerId,
    channelLabels: { slack: "Slack", telegram: "Telegram" },
    reportStatus: (text) => statuses.push(text),
    defaultPermissionMode: overrides.defaultPermissionMode ?? "allow",
    ...(overrides.deps ?? {}),
  };
  return {
    ...createSessionLifecycle(deps),
    created,
    updated,
    upserted,
    sent,
    statuses,
    routerManagedSessions,
    sessionsWithoutWildcardAllow,
    sessionPermissionModes,
  };
}

const input = (overrides = {}) => ({
  channel: "slack",
  identityId: "i1",
  peerId: "C1|168.1",
  peerKey: "C1",
  directory: "/w",
  ...overrides,
});

// ------------------------------------------------------------- createSession

test("createSession returns the new id and registers it as router-managed", async () => {
  const h = makeLifecycle();
  assert.equal(await h.createSession(input()), "sess-1");
  assert.equal(h.routerManagedSessions.has("sess-1"), true, "otherwise permissions would wait on a UI that never shows");
});

test("the session gets an explicit title, so opencode does not generate one", async () => {
  // A default-shaped title triggers an extra small_model LLM call that can
  // mislabel the reply's Model: footer.
  const h = makeLifecycle();
  await h.createSession(input());
  assert.equal(h.created[0].title, "Slack/i1 C1|168.1");
});

test("the channel name is capitalized in the title", async () => {
  const h = makeLifecycle();
  await h.createSession(input({ channel: "telegram", peerId: "123", peerKey: "123" }));
  assert.equal(h.created[0].title, "Telegram/i1 123");
});

test("the permission mode, the map and the persisted binding all agree", async () => {
  const h = makeLifecycle();
  await h.createSession(input({ permissionMode: "deny" }));
  assert.equal(h.sessionPermissionModes.get("sess-1"), "deny");
  assert.deepEqual(h.upserted[0], ["slack", "i1", "C1", "sess-1", "/w", "deny"]);
});

test("the bridge default applies when the caller names no mode", async () => {
  const h = makeLifecycle({ defaultPermissionMode: "deny" });
  await h.createSession(input());
  assert.equal(h.sessionPermissionModes.get("sess-1"), "deny");
});

test("inherit mode sends only the web-tool denies", async () => {
  const h = makeLifecycle();
  await h.createSession(input({ permissionMode: "inherit" }));
  assert.deepEqual(
    h.created[0].permission.map((r) => [r.permission, r.action]),
    [["webfetch", "deny"], ["websearch", "deny"]],
    "no blanket rule: the agent's own block governs everything else",
  );
  assert.equal(h.sessionPermissionModes.get("sess-1"), "inherit");
});

test("allow and deny each send a ruleset", async () => {
  for (const mode of ["allow", "deny"]) {
    const h = makeLifecycle();
    await h.createSession(input({ permissionMode: mode }));
    assert.equal(Array.isArray(h.created[0].permission), true, `${mode} should carry rules`);
  }
});

test("allow-mode create carries the web-tool denies", async () => {
  const h = makeLifecycle();
  await h.createSession(input({ permissionMode: "allow" }));
  const rules = h.created[0].permission;
  assert.deepEqual(rules.slice(-2).map((r) => [r.permission, r.action]), [["webfetch", "deny"], ["websearch", "deny"]]);
});

test("a session start is announced by default", async () => {
  const h = makeLifecycle();
  await h.createSession(input());
  assert.deepEqual(h.sent, ["🧭 Session started."]);
});

test("announce:false creates the session silently", async () => {
  const h = makeLifecycle();
  await h.createSession(input({ announce: false }));
  assert.deepEqual(h.sent, [], "recovery paths must not announce a session the user never lost");
});

test("the status reporter names the channel, peer and session", async () => {
  const h = makeLifecycle();
  await h.createSession(input());
  assert.equal(h.statuses[0], "Slack/i1 session created for C1|168.1 (ID: sess-1).");
});

test("a create with no id fails loudly rather than returning a bad session", async () => {
  const h = makeLifecycle({ createResult: {} });
  await assert.rejects(() => h.createSession(input()), /Failed to create session/);
  assert.equal(h.routerManagedSessions.size, 0, "nothing is registered for a session that does not exist");
  assert.deepEqual(h.upserted, [], "and nothing is persisted");
});

test("createSession works without a status reporter", async () => {
  const h = makeLifecycle({ deps: { reportStatus: undefined } });
  assert.equal(await h.createSession(input()), "sess-1");
});

// ------------------------------------------------ switchSessionPermissionMode

test("switching a mode updates the session in place, preserving history", async () => {
  const h = makeLifecycle();
  await h.switchSessionPermissionMode("/w", "sess-1", "deny", {
    channel: "slack",
    identityId: "i1",
    peerKey: "C1",
  });
  assert.equal(h.updated[0].sessionID, "sess-1");
  assert.equal(h.created.length, 0, "no new session, so the conversation survives");
  assert.equal(h.sessionPermissionModes.get("sess-1"), "deny");
  assert.deepEqual(h.upserted[0], ["slack", "i1", "C1", "sess-1", "/w", "deny"]);
});

test("switching to inherit sends only the web-tool denies", async () => {
  // Documented caveat: opencode only APPENDS to session.permission, so this
  // does not clear an earlier blanket allow; the appended denies still win.
  const h = makeLifecycle();
  await h.switchSessionPermissionMode("/w", "sess-1", "inherit", {
    channel: "slack",
    identityId: "i1",
    peerKey: "C1",
  });
  assert.deepEqual(
    h.updated[0].permission.map((r) => [r.permission, r.action]),
    [["webfetch", "deny"], ["websearch", "deny"]],
  );
});

test("a switch announces nothing", async () => {
  const h = makeLifecycle();
  await h.switchSessionPermissionMode("/w", "sess-1", "allow", {
    channel: "slack",
    identityId: "i1",
    peerKey: "C1",
  });
  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.statuses, []);
});

// ------------------------------------------------ ensureChannelDenies

test("ensureChannelDenies appends the web-tool denies once for a session it did not create", async () => {
  const h = makeLifecycle();
  await h.ensureChannelDenies("/w", "sess-old");
  await h.ensureChannelDenies("/w", "sess-old");
  assert.equal(h.updated.length, 1);
  assert.deepEqual(h.updated[0], {
    sessionID: "sess-old",
    permission: [
      { permission: "webfetch", pattern: "*", action: "deny" },
      { permission: "websearch", pattern: "*", action: "deny" },
    ],
  });
});

test("ensureChannelDenies skips a session created in this process", async () => {
  const h = makeLifecycle();
  const id = await h.createSession(input());
  await h.ensureChannelDenies("/w", id);
  assert.equal(h.updated.length, 0);
});

test("ensureChannelDenies retries after a failed update", async () => {
  let fail = true;
  const updated = [];
  const h = makeLifecycle({
    deps: {
      getClient: () => ({
        session: {
          create: async () => ({ id: "sess-1" }),
          update: async (u) => {
            if (fail) throw new Error("down");
            updated.push(u);
            return {};
          },
        },
      }),
    },
  });
  await assert.rejects(h.ensureChannelDenies("/w", "sess-old"), /down/);
  fail = false;
  await h.ensureChannelDenies("/w", "sess-old");
  assert.equal(updated.length, 1);
});

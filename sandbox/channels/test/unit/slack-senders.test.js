import assert from "node:assert/strict";
import { test } from "bun:test";

import { createSlackSenderAccess, parseAllowedUsers } from "../../dist/slack-senders.js";

// Fail-closed is the contract: a sender is admitted only once it is approved,
// and approving or removing one takes effect without a restart.

function access(overrides = {}) {
  const persisted = [];
  let clock = 1_000;
  const senders = createSlackSenderAccess({
    env: [],
    saved: [],
    persist: (userIds) => persisted.push(userIds),
    now: () => clock,
    ...overrides,
  });
  return { senders, persisted, tick: (ms) => { clock += ms; } };
}

test("parseAllowedUsers splits on commas and whitespace and drops blanks", () => {
  assert.deepEqual(parseAllowedUsers(" U123, U456 ,,W07ABC\nU789 "), ["U123", "U456", "W07ABC", "U789"]);
  assert.deepEqual(parseAllowedUsers(undefined), []);
  assert.deepEqual(parseAllowedUsers("  ,  "), []);
});

test("nobody is admitted until approved, and a missing sender id never is", () => {
  const { senders } = access();
  assert.equal(senders.isAllowed("U1"), false);
  assert.equal(senders.isAllowed(null), false);
  assert.equal(senders.isAllowed(undefined), false);
});

test("a lone * is not a wildcard", () => {
  const { senders } = access({ env: ["*"] });
  assert.equal(senders.isAllowed("U1"), false);
});

test("env and saved entries are both admitted, and each is reported with its source", () => {
  const { senders } = access({ env: ["U_ENV"], saved: ["U_APP"] });
  assert.equal(senders.isAllowed("U_ENV"), true);
  assert.equal(senders.isAllowed("U_APP"), true);
  assert.deepEqual(senders.list().allowed, [
    { userId: "U_APP", source: "app" },
    { userId: "U_ENV", source: "env" },
  ]);
});

test("a refused sender is recorded as pending, and reported for notification only the first time", () => {
  const { senders, tick } = access();
  assert.equal(senders.recordBlocked("ws_a", "U1"), true);
  tick(500);
  assert.equal(senders.recordBlocked("ws_a", "U1"), false);
  assert.deepEqual(senders.list().pending, [
    { userId: "U1", identityId: "ws_a", firstSeenAt: 1_000, lastSeenAt: 1_500, attempts: 2 },
  ]);
});

test("a sender whose notice failed is told again on their next message, and only until it lands", () => {
  const { senders } = access();
  assert.equal(senders.recordBlocked("ws_a", "U1"), true);
  senders.noticeFailed("U1");
  assert.equal(senders.recordBlocked("ws_a", "U1"), true);
  assert.equal(senders.recordBlocked("ws_a", "U1"), false);
  assert.equal(senders.list().pending[0].attempts, 3);
});

test("approving a pending sender admits them at once, clears the request, and persists only app entries", () => {
  const { senders, persisted } = access({ env: ["U_ENV"] });
  senders.recordBlocked("ws_a", "U1");
  senders.allow("U1");
  assert.equal(senders.isAllowed("U1"), true);
  assert.deepEqual(senders.list().pending, []);
  assert.deepEqual(persisted, [["U1"]]);
});

test("removing an approved sender refuses them at once and persists the removal", () => {
  const { senders, persisted } = access({ saved: ["U1", "U2"] });
  senders.revoke("U1");
  assert.equal(senders.isAllowed("U1"), false);
  assert.deepEqual(persisted, [["U2"]]);
  // Refused again, so they are told again.
  assert.equal(senders.recordBlocked("ws_a", "U1"), true);
});

test("a sender approved through SLACK_ALLOWED_USERS cannot be removed from the app", () => {
  const { senders, persisted } = access({ env: ["U_ENV"] });
  assert.throws(() => senders.revoke("U_ENV"), (error) => error.status === 409);
  assert.equal(senders.isAllowed("U_ENV"), true);
  assert.deepEqual(persisted, []);
});

test("an id approved both in the app and by SLACK_ALLOWED_USERS is reported as env, so it is not offered for removal", () => {
  const { senders } = access({ env: ["U1"], saved: ["U1", "U2"] });
  assert.deepEqual(senders.list().allowed, [
    { userId: "U1", source: "env" },
    { userId: "U2", source: "app" },
  ]);
});

test("a failed save on approve changes nothing, and a retry saves", () => {
  let fail = true;
  const persisted = [];
  const senders = createSlackSenderAccess({
    env: [],
    saved: [],
    persist: (userIds) => {
      if (fail) throw new Error("disk full");
      persisted.push(userIds);
    },
  });
  senders.recordBlocked("ws_a", "U1");

  assert.throws(() => senders.allow("U1"), /disk full/);
  assert.equal(senders.isAllowed("U1"), false);
  assert.deepEqual(senders.list().pending.map((entry) => entry.userId), ["U1"]);

  fail = false;
  senders.allow("U1");
  assert.equal(senders.isAllowed("U1"), true);
  assert.deepEqual(persisted, [["U1"]]);
});

test("a failed save on remove keeps the sender approved", () => {
  const senders = createSlackSenderAccess({
    env: [],
    saved: ["U1"],
    persist: () => {
      throw new Error("disk full");
    },
  });
  assert.throws(() => senders.revoke("U1"), /disk full/);
  assert.equal(senders.isAllowed("U1"), true);
});

test("only Slack user ids can be approved", () => {
  const { senders, persisted } = access();
  for (const bad of ["", "  ", "*", "C123", "u123", "U 1"]) {
    assert.throws(() => senders.allow(bad), (error) => error.status === 400, `accepted ${JSON.stringify(bad)}`);
  }
  assert.deepEqual(persisted, []);
});

test("the pending list keeps the most recent senders when it is full", () => {
  const { senders, tick } = access();
  for (let index = 0; index < 120; index += 1) {
    senders.recordBlocked("ws_a", `U${index}`);
    tick(1);
  }
  const pending = senders.list().pending;
  assert.equal(pending.length, 100);
  assert.equal(pending[0].userId, "U119");
  assert.equal(pending.some((entry) => entry.userId === "U0"), false);
});

import assert from "node:assert/strict";
import { test } from "bun:test";

import { createScopedSend, redactTarget } from "../../dist/scoped-send.js";
import { ScopedSendError } from "../../dist/send-approvals.js";

// The scoped token's send: the conversation the agent is answering and the ones bound to this
// workspace need no operator and are audited; every other explicit target is held for approval.

const WORKSPACE = "/w";

function makeScoped({ sessions = {}, bindings = [], hold } = {}) {
  const sent = [];
  const audits = [];
  const holds = [];
  const store = {
    findSessionById: (sessionId) => sessions[sessionId] ?? null,
    listBindings: (filters) =>
      bindings.filter(
        (row) => (!filters.channel || row.channel === filters.channel) && (!filters.identityId || row.identity_id === filters.identityId),
      ),
  };
  const send = createScopedSend({
    store,
    hold: hold ?? {
      hold: async (channel, peerId) => {
        holds.push({ channel, peerId });
        return { approvalId: "approval-1" };
      },
    },
    send: async (input) => {
      sent.push(input);
      return { channel: input.channel, directory: WORKSPACE, attempted: 1, sent: 1 };
    },
    normalizeDirectory: (input) => input.replace(/\/+$/, ""),
    resolveScopedDirectory: (input) => ({ ok: true, directory: input.startsWith("/") ? input : `${WORKSPACE}/${input}` }),
    workspaceRootNormalized: WORKSPACE,
    audit: (entry) => audits.push(entry),
  });
  return { send, sent, audits, holds };
}

const SESSION = { channel: "slack", identity_id: "default", peer_id: "C0CURRENT01", session_id: "ses_1" };

test("a reply to the current conversation needs no approval and is audited", async () => {
  const { send, sent, audits, holds } = makeScoped({ sessions: { ses_1: SESSION } });
  await send({ channel: "slack", text: "done", peerId: "C0CURRENT01", sessionId: "ses_1" });
  assert.equal(holds.length, 0);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].sessionId, undefined, "the session claim is not passed to the send");
  assert.deepEqual(audits, [
    { event: "router_scoped_send", channel: "slack", sessionId: "ses_1", target: "C0…01", basis: "current_conversation" },
  ]);
});

test("a Slack thread inside a bound channel or the current conversation needs no approval, another channel does", async () => {
  const bound = makeScoped({
    bindings: [{ channel: "slack", identity_id: "default", peer_id: "C0BOUND0001", directory: WORKSPACE }],
  });
  await bound.send({ channel: "slack", text: "x", peerId: "C0BOUND0001|1700000000.000100" });
  assert.equal(bound.holds.length, 0);
  await bound.send({ channel: "slack", text: "x", peerId: "C0OTHER00002|1700000000.000100" });
  assert.deepEqual(bound.holds, [{ channel: "slack", peerId: "C0OTHER00002|1700000000.000100" }]);
  const current = makeScoped({ sessions: { ses_1: { ...SESSION, peer_id: "C0CURRENT01|1700000000.000200" } } });
  await current.send({ channel: "slack", text: "x", peerId: "C0CURRENT01|1700000000.000200", sessionId: "ses_1" });
  await current.send({ channel: "slack", text: "x", peerId: "C0CURRENT01|1700000009.000900", sessionId: "ses_1" });
  assert.equal(current.holds.length, 0);
  const telegram = makeScoped({ sessions: { ses_1: { ...SESSION, channel: "telegram", peer_id: "1234" } } });
  await telegram.send({ channel: "telegram", text: "x", peerId: "1234|5", sessionId: "ses_1" });
  assert.equal(telegram.holds.length, 0, "a Telegram send the router refuses as malformed is not offered for approval");
});

test("a send to a peer bound to the workspace needs no approval", async () => {
  const { send, holds, audits } = makeScoped({
    bindings: [{ channel: "slack", identity_id: "default", peer_id: "C0BOUND0001", directory: WORKSPACE }],
  });
  await send({ channel: "slack", text: "report", peerId: "C0BOUND0001" });
  assert.equal(holds.length, 0);
  assert.equal(audits[0].basis, "bound_conversation");
});

test("a binding to the requested directory counts, one to another directory does not", async () => {
  const bindings = [{ channel: "slack", identity_id: "default", peer_id: "C0OTHERDIR1", directory: "/w/other" }];
  const direct = makeScoped({ bindings });
  await direct.send({ channel: "slack", text: "x", peerId: "C0OTHERDIR1", directory: "/w/other" });
  assert.equal(direct.holds.length, 0);
  const elsewhere = makeScoped({ bindings });
  await elsewhere.send({ channel: "slack", text: "x", peerId: "C0OTHERDIR1" });
  assert.deepEqual(elsewhere.holds, [{ channel: "slack", peerId: "C0OTHERDIR1" }]);
});

test("directory fan-out reaches only bound conversations and needs no approval", async () => {
  const { send, holds, sent, audits } = makeScoped();
  await send({ channel: "telegram", text: "job finished", directory: WORKSPACE });
  assert.equal(holds.length, 0);
  assert.equal(sent.length, 1);
  assert.equal(audits[0].basis, "bound_directory");
});

test("a send to a new target is held, and goes out only after the approval", async () => {
  let approve;
  const order = [];
  const hold = { hold: () => new Promise((resolve) => (approve = () => resolve({ approvalId: "approval-9" }))) };
  const { send, sent, audits } = makeScoped({ sessions: { ses_1: SESSION }, hold });
  const pending = send({ channel: "slack", text: "hello", peerId: "C0NEWTARGET", sessionId: "ses_1" }).then(() => order.push("sent"));
  await Promise.resolve();
  assert.equal(sent.length, 0, "nothing is sent while the approval is pending");
  approve();
  await pending;
  assert.equal(sent.length, 1);
  assert.equal(audits[0].basis, "approved");
  assert.equal(audits[0].approvalId, "approval-9");
});

test("a denied or expired approval sends nothing and the error reaches the caller", async () => {
  for (const code of ["approval_denied", "approval_expired", "approval_unavailable"]) {
    const hold = { hold: async () => { throw new ScopedSendError(code); } };
    const { send, sent } = makeScoped({ hold });
    await assert.rejects(send({ channel: "slack", text: "hello", peerId: "C0NEWTARGET" }), (error) => error.code === code);
    assert.equal(sent.length, 0);
  }
});

test("another conversation's session does not make a target current, and a mismatched identity does not either", async () => {
  const { send, holds } = makeScoped({ sessions: { ses_1: SESSION } });
  await send({ channel: "slack", text: "x", peerId: "C0SOMEONEELS", sessionId: "ses_1" });
  await send({ channel: "telegram", text: "x", peerId: "123456", sessionId: "ses_1" });
  await send({ channel: "slack", text: "x", peerId: "C0CURRENT01", sessionId: "ses_1", identityId: "other" });
  await send({ channel: "slack", text: "x", peerId: "C0CURRENT01", sessionId: "ses_unknown" });
  assert.equal(holds.length, 4);
});

test("a Telegram peer the send would refuse is not offered for approval", async () => {
  const { send, holds, sent } = makeScoped();
  await send({ channel: "telegram", text: "x", peerId: "@not_numeric" });
  assert.equal(holds.length, 0);
  assert.equal(sent.length, 1, "the send itself refuses it");
});

test("the audit line never carries message text or the whole target", async () => {
  const { send, audits } = makeScoped({ sessions: { ses_1: SESSION } });
  await send({ channel: "slack", text: "a secret message", peerId: "C0CURRENT01", sessionId: "ses_1" });
  const line = JSON.stringify(audits);
  assert.equal(line.includes("secret"), false);
  assert.equal(line.includes("C0CURRENT01"), false);
  assert.equal(redactTarget("abc"), "hidden");
});

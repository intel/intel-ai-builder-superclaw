import assert from "node:assert/strict";
import net from "node:net";
import { test } from "bun:test";

import { startHealthServer } from "../../dist/health.js";
import { SendApprovalHold } from "../../dist/send-approvals.js";

// The router's two bearers. The admin token is the host's; the scoped token goes to the tier the agent
// runs in and may read status and send, nothing else. These run a real server on 127.0.0.1 only.

const ADMIN = "admin-token-for-tests-0123456789abcdef";
const SCOPED = "scoped-token-for-tests-0123456789abcdef";
const SECRET = "A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg";
const quietLogger = { info() {}, error() {}, warn() {}, debug() {} };

async function freePort() {
  return await new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function start({ withApprovals = false, hold } = {}) {
  const calls = { admin: [], scoped: [], binding: [], identity: [], groups: [], senders: [] };
  const port = await freePort();
  const approvalHold = hold ?? new SendApprovalHold({ config: null });
  const stop = await startHealthServer(
    port,
    () => ({ ok: true, opencode: { url: "x", healthy: true }, channels: {}, config: {}, activity: {} }),
    quietLogger,
    {
      listBindings: async () => ({ items: [] }),
      listSlackIdentities: async () => ({ items: [] }),
      setBinding: async (input) => void calls.binding.push(input),
      clearBinding: async (input) => void calls.binding.push(input),
      upsertSlackIdentity: async (input) => void calls.identity.push(input),
      setGroupsEnabled: async (enabled) => void calls.groups.push(enabled) ?? { groupsEnabled: enabled },
      listSlackSenders: async () => ({ allowed: [], pending: [] }),
      updateSlackSender: async (input) => {
        calls.senders.push(input);
        return { allowed: [], pending: [] };
      },
      sendMessage: async (input) => {
        calls.admin.push(input);
        return { channel: input.channel, directory: "/w", attempted: 1, sent: 1 };
      },
      scopedSendMessage: async (input) => {
        calls.scoped.push(input);
        return { channel: input.channel, directory: "/w", attempted: 1, sent: 1 };
      },
    },
    ADMIN,
    {
      token: SCOPED,
      ...(withApprovals ? { approvals: { hold: approvalHold, adminSecret: SECRET } } : {}),
    },
  );
  const call = (token, method, path, body) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  return { call, calls, stop, port };
}

test("the scoped token reads bindings and identities and sends, through the scoped handler", async () => {
  const { call, calls, stop } = await start();
  try {
    assert.equal((await call(SCOPED, "GET", "/bindings")).status, 200);
    assert.equal((await call(SCOPED, "GET", "/identities/slack")).status, 200);
    const sent = await call(SCOPED, "POST", "/send", { channel: "slack", text: "hi", peerId: "C1", sessionId: "ses_1" });
    assert.equal(sent.status, 200);
    assert.equal(calls.scoped.length, 1);
    assert.equal(calls.scoped[0].sessionId, "ses_1");
    assert.equal(calls.admin.length, 0, "a scoped send never reaches the unrestricted handler");
  } finally {
    stop();
  }
});

test("the admin token's send is unrestricted and carries no session claim", async () => {
  const { call, calls, stop } = await start();
  try {
    const sent = await call(ADMIN, "POST", "/send", { channel: "slack", text: "hi", peerId: "C1", autoBind: true, sessionId: "ses_1" });
    assert.equal(sent.status, 200);
    assert.equal(calls.admin.length, 1);
    assert.equal(calls.admin[0].autoBind, true);
    assert.equal(calls.admin[0].sessionId, undefined);
    assert.equal(calls.scoped.length, 0);
  } finally {
    stop();
  }
});

test("the scoped token is refused on binding writes, identity writes, config writes and autoBind", async () => {
  const { call, calls, stop } = await start();
  try {
    const refused = [
      ["POST", "/bindings", { channel: "slack", peerId: "C1", directory: "/w" }],
      ["POST", "/bindings", { channel: "slack", peerId: "C1" }],
      ["POST", "/identities/slack", { id: "a", botToken: "x", appToken: "y" }],
      ["POST", "/identities/slack/verify", { id: "a", botToken: "x", appToken: "y" }],
      ["DELETE", "/identities/slack/default", undefined],
      ["POST", "/identities/telegram", { id: "a", token: "x" }],
      ["POST", "/config/telegram-token", { token: "x" }],
      ["POST", "/config/slack-tokens", { botToken: "x", appToken: "y" }],
      ["POST", "/config/groups", { enabled: true }],
      ["GET", "/config/groups", undefined],
      ["POST", "/send", { channel: "slack", text: "hi", peerId: "C1", directory: "/w", autoBind: true }],
    ];
    for (const [method, path, body] of refused) {
      const response = await call(SCOPED, method, path, body);
      const json = await response.json();
      assert.equal(response.status, 403, `${method} ${path}`);
      assert.equal(json.code, "scoped_token_forbidden", `${method} ${path}`);
    }
    assert.deepEqual([calls.binding, calls.identity, calls.groups, calls.scoped, calls.admin], [[], [], [], [], []]);
  } finally {
    stop();
  }
});

test("the Slack sender approvals need the control token: the scoped token is refused on both routes", async () => {
  const { call, calls, stop } = await start();
  try {
    for (const [method, path, body] of [
      ["GET", "/slack/senders", undefined],
      ["POST", "/slack/senders", { userId: "U0BHQ6EM317", allowed: true }],
    ]) {
      const response = await call(SCOPED, method, path, body);
      assert.equal(response.status, 403, `${method} ${path}`);
      assert.equal((await response.json()).code, "scoped_token_forbidden", `${method} ${path}`);
    }
    assert.deepEqual(calls.senders, []);
    assert.equal((await call(ADMIN, "GET", "/slack/senders")).status, 200);
    assert.equal((await call(ADMIN, "POST", "/slack/senders", { userId: "U0BHQ6EM317", allowed: true })).status, 200);
    assert.deepEqual(calls.senders, [{ userId: "U0BHQ6EM317", allowed: true }]);
  } finally {
    stop();
  }
});

test("the same writes work with the admin token", async () => {
  const { call, calls, stop } = await start();
  try {
    assert.equal((await call(ADMIN, "POST", "/bindings", { channel: "slack", peerId: "C1", directory: "/w" })).status, 200);
    assert.equal((await call(ADMIN, "POST", "/config/groups", { enabled: true })).status, 200);
    assert.equal(calls.binding.length, 1);
    assert.deepEqual(calls.groups, [true]);
  } finally {
    stop();
  }
});

test("a wrong or missing token is 401, and /health needs none", async () => {
  const { call, stop } = await start();
  try {
    assert.equal((await call("nope", "GET", "/bindings")).status, 401);
    assert.equal((await call(undefined, "POST", "/send", {})).status, 401);
    assert.equal((await call(undefined, "GET", "/health")).status, 200);
  } finally {
    stop();
  }
});

test("a scoped token equal to the admin token is refused at start", async () => {
  await assert.rejects(
    startHealthServer(await freePort(), () => ({}), quietLogger, {}, ADMIN, { token: ADMIN }),
    /must differ/,
  );
});

test("without a scoped token only the admin one is accepted", async () => {
  const port = await freePort();
  const stop = await startHealthServer(port, () => ({}), quietLogger, { listBindings: async () => ({ items: [] }) }, ADMIN);
  try {
    const headers = (token) => ({ Authorization: `Bearer ${token}` });
    assert.equal((await fetch(`http://127.0.0.1:${port}/bindings`, { headers: headers(SCOPED) })).status, 401);
    assert.equal((await fetch(`http://127.0.0.1:${port}/bindings`, { headers: headers(ADMIN) })).status, 200);
  } finally {
    stop();
  }
});

test("the approval admin endpoint answers to its secret only, and not to either bearer", async () => {
  const hold = new SendApprovalHold({ config: { approval_public_key: SECRET, boot_id: "sm-boot-1", admin_secret: SECRET } });
  const { port, stop } = await start({ withApprovals: true, hold });
  try {
    const url = `http://127.0.0.1:${port}/v1/admin/approvals`;
    for (const headers of [{}, { Authorization: `Bearer ${ADMIN}` }, { Authorization: `Bearer ${SCOPED}` }, { "X-SuperClaw-Admin-Secret": "wrong" }]) {
      const response = await fetch(url, { headers });
      assert.equal(response.status, 401);
      assert.equal((await response.json()).error.code, "admin_authentication_failed");
    }
    const listed = await fetch(url, { headers: { "X-SuperClaw-Admin-Secret": SECRET } });
    assert.equal(listed.status, 200);
    assert.deepEqual(await listed.json(), { approvals: [] });
    const denied = await fetch(`http://127.0.0.1:${port}/v1/admin/decisions`, {
      method: "POST",
      headers: { "X-SuperClaw-Admin-Secret": SECRET },
      body: JSON.stringify({ approval_id: "approval-none", decision: "denied" }),
    });
    assert.equal(denied.status, 404);
    const bad = await fetch(`http://127.0.0.1:${port}/v1/admin/grants`, {
      method: "POST",
      headers: { "X-SuperClaw-Admin-Secret": SECRET },
      body: JSON.stringify({ grant: "x" }),
    });
    assert.equal(bad.status, 400);
  } finally {
    stop();
  }
});

test("a router with no sealed approval config has no admin endpoint", async () => {
  const { port, stop } = await start();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/admin/approvals`, { headers: { "X-SuperClaw-Admin-Secret": SECRET } });
    assert.equal(response.status, 404);
  } finally {
    stop();
  }
});

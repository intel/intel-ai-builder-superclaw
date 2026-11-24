import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { BridgeStore } from "../../dist/db.js";
import { startHealthServer } from "../../dist/health.js";
import { createSlackSenderHandlers } from "../../dist/health-slack-senders.js";
import { createStoredSlackSenderAccess } from "../../dist/slack-senders.js";

const AUTH = { Authorization: "Bearer control-token", "Content-Type": "application/json" };

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function loggerStub() {
  const logger = {
    child() { return logger; },
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
  return logger;
}

function snapshot() {
  return {
    ok: true,
    opencode: { url: "http://127.0.0.1:4096", healthy: true },
    channels: { telegram: false, whatsapp: false, slack: true },
    config: { groupsEnabled: false },
  };
}

// Approvals live in the router's own database, which no other process writes,
// so a concurrent save of opencode-router.json cannot undo one.
async function startRouter({ env = [], saved = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-slack-senders-"));
  const dbPath = path.join(dir, "opencode-router.db");
  const seed = new BridgeStore(dbPath);
  seed.replaceSlackAllowedSenders(saved);
  seed.close();

  const open = async () => {
    const store = new BridgeStore(dbPath);
    const slackSenders = createStoredSlackSenderAccess(store, env);
    const port = await freePort();
    const stop = await startHealthServer(
      port,
      snapshot,
      loggerStub(),
      createSlackSenderHandlers({ slackSenders, logger: loggerStub() }),
      "control-token",
    );
    return {
      slackSenders,
      url: `http://127.0.0.1:${port}/slack/senders`,
      stop: () => {
        stop();
        store.close();
      },
    };
  };
  return { open };
}

const post = (url, body) => fetch(url, { method: "POST", headers: AUTH, body: JSON.stringify(body) });

test("the sender routes require the control token", async () => {
  const router = await (await startRouter()).open();
  try {
    assert.equal((await fetch(router.url)).status, 401);
    const write = await fetch(router.url, { method: "POST", body: JSON.stringify({ userId: "U1", allowed: true }) });
    assert.equal(write.status, 401);
  } finally {
    router.stop();
  }
});

test("a pending sender is listed, and approving them admits them at once", async () => {
  const router = await (await startRouter()).open();
  try {
    router.slackSenders.recordBlocked("ws_a", "U0BHQ6EM317");

    const before = await (await fetch(router.url, { headers: AUTH })).json();
    assert.equal(before.ok, true);
    assert.deepEqual(before.allowed, []);
    assert.deepEqual(before.pending.map((entry) => [entry.userId, entry.identityId]), [["U0BHQ6EM317", "ws_a"]]);

    const approve = await post(router.url, { userId: "U0BHQ6EM317", allowed: true });
    assert.equal(approve.status, 200);
    const after = await approve.json();
    assert.deepEqual(after.allowed, [{ userId: "U0BHQ6EM317", source: "app" }]);
    assert.deepEqual(after.pending, []);
    assert.equal(router.slackSenders.isAllowed("U0BHQ6EM317"), true);
  } finally {
    router.stop();
  }
});

test("an approval survives a router restart", async () => {
  const setup = await startRouter();
  const first = await setup.open();
  assert.equal((await post(first.url, { userId: "U1", allowed: true })).status, 200);
  first.stop();

  const second = await setup.open();
  try {
    assert.equal(second.slackSenders.isAllowed("U1"), true);
  } finally {
    second.stop();
  }
});

test("a removal takes effect at once and survives a router restart", async () => {
  const setup = await startRouter({ saved: ["U1", "U2"] });
  const first = await setup.open();
  assert.equal((await post(first.url, { userId: "U1", allowed: false })).status, 200);
  assert.equal(first.slackSenders.isAllowed("U1"), false);
  first.stop();

  const second = await setup.open();
  try {
    assert.equal(second.slackSenders.isAllowed("U1"), false);
    assert.equal(second.slackSenders.isAllowed("U2"), true);
  } finally {
    second.stop();
  }
});

test("bad requests are rejected and change nothing", async () => {
  const setup = await startRouter({ env: ["U_ENV"] });
  const router = await setup.open();
  try {
    const cases = [
      [{ allowed: true }, 400],
      [{ userId: "U1" }, 400],
      [{ userId: "C123", allowed: true }, 400],
      [{ userId: "U_ENV", allowed: false }, 409],
    ];
    for (const [body, status] of cases) {
      const response = await post(router.url, body);
      assert.equal(response.status, status, JSON.stringify(body));
      const json = await response.json();
      assert.equal(json.ok, false);
      // The app's transport shows `message`, so the reason has to be there, not only in `error`.
      assert.equal(typeof json.message, "string", JSON.stringify(body));
      if (status === 409) assert.match(json.message, /SLACK_ALLOWED_USERS/);
    }
    assert.deepEqual((await (await fetch(router.url, { headers: AUTH })).json()).allowed, [{ userId: "U_ENV", source: "env" }]);
  } finally {
    router.stop();
  }
});

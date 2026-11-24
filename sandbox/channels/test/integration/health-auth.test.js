import assert from "node:assert/strict";
import net from "node:net";
import { test } from "bun:test";

import { startHealthServer } from "../../dist/health.js";

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
    channels: { telegram: false, whatsapp: false, slack: false },
    config: { groupsEnabled: false },
  };
}

test("health server refuses to start without a control token", async () => {
  const port = await freePort();
  await assert.rejects(
    startHealthServer(port, snapshot, loggerStub()),
    /OPENCODE_ROUTER_CONTROL_TOKEN is required/,
  );
});

test("health server leaves health public and protects read and write control routes", async () => {
  const port = await freePort();
  let sendCalls = 0;
  const stop = await startHealthServer(port, snapshot, loggerStub(), {
    listSlackIdentities: async () => ({ items: [] }),
    sendMessage: async () => {
      sendCalls += 1;
      return { channel: "slack", directory: "/workspace", attempted: 1, sent: 1 };
    },
  }, "control-token");

  try {
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);

    const anonymousRead = await fetch(`http://127.0.0.1:${port}/identities/slack`);
    assert.equal(anonymousRead.status, 401);

    const wrongToken = await fetch(`http://127.0.0.1:${port}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer wrong-token" },
      body: JSON.stringify({ channel: "slack", peerId: "D123", text: "blocked" }),
    });
    assert.equal(wrongToken.status, 401);
    assert.equal(sendCalls, 0);

    const authorized = await fetch(`http://127.0.0.1:${port}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer control-token" },
      body: JSON.stringify({ channel: "slack", peerId: "D123", text: "allowed" }),
    });
    assert.equal(authorized.status, 200);
    assert.equal(sendCalls, 1);
    assert.equal(authorized.headers.get("access-control-allow-origin"), null);
  } finally {
    stop();
  }
});

test("Slack verification is authenticated and never invokes identity upsert", async () => {
  const port = await freePort();
  let verifies = 0;
  let upserts = 0;
  const stop = await startHealthServer(port, snapshot, loggerStub(), {
    verifySlackIdentity: async ({ botToken }) => {
      verifies += 1;
      if (botToken === "bad") throw Object.assign(new Error("invalid_auth"), {
        status: 400, slackScope: "bot", slackReason: "invalid", slackError: "invalid_auth",
      });
      if (botToken === "offline") throw Object.assign(new Error("unreachable"), {
        status: 503, slackScope: "app", slackReason: "unreachable",
      });
      return { teamName: "Test workspace", teamId: "T123" };
    },
    upsertSlackIdentity: async () => {
      upserts += 1;
      return { id: "default", enabled: true, applied: true };
    },
  }, "control-token");
  try {
    for (const [token, expected] of [["good", 200], ["bad", 400], ["offline", 503]]) {
      const request = { method: "POST", body: JSON.stringify({ botToken: token, appToken: "xapp-test" }) };
      const denied = await fetch(`http://127.0.0.1:${port}/identities/slack/verify`, request);
      assert.equal(denied.status, 401);
      const response = await fetch(`http://127.0.0.1:${port}/identities/slack/verify`, {
        ...request, headers: { Authorization: "Bearer control-token", "Content-Type": "application/json" },
      });
      assert.equal(response.status, expected);
      const body = await response.json();
      if (expected === 200) assert.equal(body.slack.teamId, "T123");
      else assert.equal(body.reason, token === "bad" ? "invalid" : "unreachable");
    }
    assert.equal(verifies, 3);
    assert.equal(upserts, 0);
  } finally {
    stop();
  }
});
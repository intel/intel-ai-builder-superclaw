import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import net from "node:net";
import assert from "node:assert/strict";

import { startBridge } from "../../dist/bridge.js";
import { BridgeStore } from "../../dist/db.js";

// Client errors from the binding handlers must reach the caller as 400s. The
// handlers attach `status`; these tests prove the HTTP routes honour it.

const CONTROL_TOKEN = "control-token";
const CONTROL_HEADERS = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${CONTROL_TOKEN}`,
};

function createLoggerStub() {
  const base = {
    child() {
      return base;
    },
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
  return base;
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function startHealthServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-health-bindings-"));
  const dbPath = path.join(dir, "opencode-router.db");
  const store = new BridgeStore(dbPath);
  const healthPort = await freePort();
  const bridge = await startBridge(
    {
      configPath: path.join(dir, "opencode-router.json"),
      configFile: { version: 1 },
      opencodeUrl: "http://127.0.0.1:4096",
      opencodeDirectory: dir,
      telegramBots: [],
      slackApps: [],
      dataDir: dir,
      dbPath,
      logFile: path.join(dir, "opencode-router.log"),
      toolUpdatesEnabled: false,
      groupsEnabled: false,
      permissionMode: "allow",
      toolOutputLimit: 1200,
      healthPort,
      controlToken: CONTROL_TOKEN,
      logLevel: "silent",
    },
    createLoggerStub(),
    undefined,
    {
      client: {
        global: {
          health: async () => ({ healthy: true, version: "test" }),
        },
      },
      store,
      adapters: new Map(),
      disableEventStream: true,
    },
  );
  return {
    url: `http://127.0.0.1:${healthPort}`,
    async stop() {
      await bridge.stop();
      store.close();
    },
  };
}

test("GET /bindings with an unknown channel is a 400", async () => {
  const server = await startHealthServer();
  try {
    const response = await fetch(`${server.url}/bindings?channel=discord`, { headers: CONTROL_HEADERS });
    assert.equal(response.status, 400);
    const json = await response.json();
    assert.equal(json.ok, false);
    assert.equal(json.error, "Invalid channel");
  } finally {
    await server.stop();
  }
});

test("POST /bindings with an unknown channel is a 400", async () => {
  const server = await startHealthServer();
  try {
    const response = await fetch(`${server.url}/bindings`, {
      method: "POST",
      headers: CONTROL_HEADERS,
      body: JSON.stringify({ channel: "discord", peerId: "C1", directory: "proj" }),
    });
    assert.equal(response.status, 400);
    const json = await response.json();
    assert.equal(json.ok, false);
    assert.equal(json.error, "Invalid channel");
  } finally {
    await server.stop();
  }
});

test("POST /bindings with a directory outside the workspace root is a 400", async () => {
  const server = await startHealthServer();
  try {
    const response = await fetch(`${server.url}/bindings`, {
      method: "POST",
      headers: CONTROL_HEADERS,
      body: JSON.stringify({ channel: "slack", peerId: "C1", directory: path.join(os.tmpdir(), "outside-workspace") }),
    });
    assert.equal(response.status, 400);
    const json = await response.json();
    assert.equal(json.ok, false);
    assert.match(String(json.error), /within workspace root/i);
  } finally {
    await server.stop();
  }
});

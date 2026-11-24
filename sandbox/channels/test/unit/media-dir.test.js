import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { loadConfig } from "../../dist/config.js";
import { startBridge } from "../../dist/bridge.js";

function baseEnv(dir) {
  return {
    OPENCODE_ROUTER_DATA_DIR: dir,
    OPENCODE_ROUTER_DB_PATH: path.join(dir, "opencode-router.db"),
    OPENCODE_ROUTER_CONFIG_PATH: path.join(dir, "opencode-router.json"),
    OPENCODE_DIRECTORY: dir,
    OPENCODE_URL: "http://127.0.0.1:4096",
    LOG_LEVEL: "silent",
  };
}

function createLoggerStub() {
  const calls = [];
  const base = {
    child() { return base; },
    debug() {},
    info(...args) { calls.push(args); },
    warn() {},
    error() {},
    _calls: calls,
  };
  return base;
}

// --- loadConfig tests ---

test("loadConfig: mediaDir is undefined when env var is not set", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-cfg-"));
  fs.writeFileSync(path.join(dir, "opencode-router.json"), JSON.stringify({ version: 1 }));
  const config = loadConfig(baseEnv(dir));
  assert.equal(config.mediaDir, undefined);
});

test("loadConfig: mediaDir is undefined when env var is empty string", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-cfg-"));
  fs.writeFileSync(path.join(dir, "opencode-router.json"), JSON.stringify({ version: 1 }));
  const config = loadConfig({ ...baseEnv(dir), OPENCODE_ROUTER_MEDIA_DIR: "" });
  assert.equal(config.mediaDir, undefined);
});

test("loadConfig: mediaDir is undefined when env var is whitespace only", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-cfg-"));
  fs.writeFileSync(path.join(dir, "opencode-router.json"), JSON.stringify({ version: 1 }));
  const config = loadConfig({ ...baseEnv(dir), OPENCODE_ROUTER_MEDIA_DIR: "   " });
  assert.equal(config.mediaDir, undefined);
});

test("loadConfig: mediaDir is set when env var has a value", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-cfg-"));
  fs.writeFileSync(path.join(dir, "opencode-router.json"), JSON.stringify({ version: 1 }));
  const config = loadConfig({ ...baseEnv(dir), OPENCODE_ROUTER_MEDIA_DIR: "/data/media" });
  assert.equal(config.mediaDir, "/data/media");
});

test("loadConfig: mediaDir trims whitespace from env var", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-cfg-"));
  fs.writeFileSync(path.join(dir, "opencode-router.json"), JSON.stringify({ version: 1 }));
  const config = loadConfig({ ...baseEnv(dir), OPENCODE_ROUTER_MEDIA_DIR: "  /data/media  " });
  assert.equal(config.mediaDir, "/data/media");
});

test("loadConfig: mediaDir expands ~ to home directory", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-cfg-"));
  fs.writeFileSync(path.join(dir, "opencode-router.json"), JSON.stringify({ version: 1 }));
  const config = loadConfig({ ...baseEnv(dir), OPENCODE_ROUTER_MEDIA_DIR: "~/media-files" });
  assert.equal(config.mediaDir, path.join(os.homedir(), "media-files"));
});

test("loadConfig: reads and trims the control token", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-cfg-"));
  fs.writeFileSync(path.join(dir, "opencode-router.json"), JSON.stringify({ version: 1 }));
  const config = loadConfig({ ...baseEnv(dir), OPENCODE_ROUTER_CONTROL_TOKEN: "  control-token  " });
  assert.equal(config.controlToken, "control-token");
});

// --- bridge media directory tests ---

test("bridge: uses default media dir when mediaDir is not configured", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-media-"));
  const dbPath = path.join(dir, "opencode-router.db");
  const logger = createLoggerStub();

  const fakeClient = {
    global: { health: async () => ({ healthy: true, version: "test" }) },
    session: {
      create: async () => ({ id: "session-1" }),
      prompt: async () => ({ parts: [{ type: "text", text: "ok" }] }),
    },
  };

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
      healthPort: undefined,
      logLevel: "silent",
    },
    logger,
    undefined,
    {
      client: fakeClient,
      adapters: new Map(),
      disableEventStream: true,
      disableHealthServer: true,
    },
  );

  const defaultMediaDir = path.join(dir, ".opencode-router", "media");
  assert.ok(fs.existsSync(defaultMediaDir), "default media directory should be created");

  const mediaLogCalls = logger._calls.filter((args) => args[1] === "Using custom media directory");
  assert.equal(mediaLogCalls.length, 0, "should not log custom media directory message");

  await bridge.stop();
}, 15_000);

test("bridge: uses custom media dir and logs when mediaDir is configured", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-media-"));
  const customMediaDir = path.join(dir, "custom-media");
  const dbPath = path.join(dir, "opencode-router.db");
  const logger = createLoggerStub();

  const fakeClient = {
    global: { health: async () => ({ healthy: true, version: "test" }) },
    session: {
      create: async () => ({ id: "session-1" }),
      prompt: async () => ({ parts: [{ type: "text", text: "ok" }] }),
    },
  };

  const bridge = await startBridge(
    {
      configPath: path.join(dir, "opencode-router.json"),
      configFile: { version: 1 },
      opencodeUrl: "http://127.0.0.1:4096",
      opencodeDirectory: dir,
      mediaDir: customMediaDir,
      telegramBots: [],
      slackApps: [],
      dataDir: dir,
      dbPath,
      logFile: path.join(dir, "opencode-router.log"),
      toolUpdatesEnabled: false,
      groupsEnabled: false,
      permissionMode: "allow",
      toolOutputLimit: 1200,
      healthPort: undefined,
      logLevel: "silent",
    },
    logger,
    undefined,
    {
      client: fakeClient,
      adapters: new Map(),
      disableEventStream: true,
      disableHealthServer: true,
    },
  );

  assert.ok(fs.existsSync(customMediaDir), "custom media directory should be created");
  const defaultMediaDir = path.join(dir, ".opencode-router", "media");
  assert.ok(!fs.existsSync(defaultMediaDir), "default media directory should NOT be created");

  const mediaLogCalls = logger._calls.filter((args) => args[1] === "Using custom media directory");
  assert.equal(mediaLogCalls.length, 1, "should log custom media directory message");
  assert.equal(mediaLogCalls[0][0].mediaDir, customMediaDir);

  await bridge.stop();
}, 15_000);

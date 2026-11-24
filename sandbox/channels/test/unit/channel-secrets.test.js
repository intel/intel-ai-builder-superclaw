import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "bun:test";

import { prepareSlackIdentities, storeSlackSecrets } from "../../dist/channel-secrets.js";
import { listSlackIdentityMetadata } from "../../dist/config.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const env = {
  SC_CHANNEL_SECRET_API_URL: "http://secret-adapter",
  SC_CHANNEL_SECRET_MANAGEMENT_TOKEN: "management-token",
  SC_CHANNEL_SECRET_RESOLVE_TOKEN: "resolve-token",
};

test("storeSlackSecrets sends credentials only to the authenticated host adapter", async () => {
  let request;
  globalThis.fetch = async (input, init) => {
    request = { input: String(input), init };
    return Response.json({
      botTokenRef: "sc-channel-secret:slack:workspace-1:bot",
      appTokenRef: "sc-channel-secret:slack:workspace-1:app",
    });
  };

  const refs = await storeSlackSecrets("workspace-1", "xoxb-secret", "xapp-secret", env);

  assert.equal(request.input, "http://secret-adapter/v1/channel-secrets/slack/workspace-1");
  assert.equal(request.init.headers.Authorization, "Bearer management-token");
  assert.equal(request.init.signal instanceof AbortSignal, true);
  assert.deepEqual(JSON.parse(request.init.body), {
    botToken: "xoxb-secret",
    appToken: "xapp-secret",
  });
  assert.equal(refs.botTokenRef, "sc-channel-secret:slack:workspace-1:bot");
});

test("listSlackIdentityMetadata includes the legacy default identity", () => {
  assert.deepEqual(listSlackIdentityMetadata({
    version: 1,
    channels: { slack: { enabled: true, botToken: "xoxb-secret", appToken: "xapp-secret" } },
  }), [{ id: "default", enabled: true }]);
});

test("prepareSlackIdentities resolves stored references", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-secrets-"));
  const configPath = path.join(dir, "opencode-router.json");
  fs.writeFileSync(configPath, JSON.stringify({
    version: 1,
    channels: { slack: { apps: [{
      id: "default",
      botTokenRef: "sc-channel-secret:slack:abcdefghijklmnopqrstuvwxyzABCDEF:bot",
      appTokenRef: "sc-channel-secret:slack:abcdefghijklmnopqrstuvwxyzABCDEF:app",
    }] } },
  }));
  const paths = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    paths.push(url);
    assert.equal(init.headers.Authorization, "Bearer resolve-token");
    return Response.json({ values: {
      "sc-channel-secret:slack:abcdefghijklmnopqrstuvwxyzABCDEF:bot": "xoxb-secret",
      "sc-channel-secret:slack:abcdefghijklmnopqrstuvwxyzABCDEF:app": "xapp-secret",
    } });
  };

  try {
    const identities = await prepareSlackIdentities(configPath, env);
    assert.equal(identities.length, 1);
    assert.deepEqual(paths, ["http://secret-adapter/v1/channel-secrets/resolve"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("prepareSlackIdentities uses legacy plaintext without rewriting it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-secrets-"));
  const configPath = path.join(dir, "opencode-router.json");
  fs.writeFileSync(configPath, JSON.stringify({
    version: 1,
    channels: {
      slack: {
        botToken: "xoxb-secret",
        appToken: "xapp-secret",
      },
    },
  }));

  globalThis.fetch = async () => { throw new Error("legacy config should not call the adapter"); };

  try {
    const identities = await prepareSlackIdentities(configPath, env);
    assert.deepEqual(identities.map(({ id, botToken, appToken }) => ({ id, botToken, appToken })), [
      { id: "default", botToken: "xoxb-secret", appToken: "xapp-secret" },
    ]);
    assert.equal(fs.readFileSync(configPath, "utf8").includes("xoxb-secret"), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("prepareSlackIdentities keeps legacy multi-identity config compatible", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-secrets-"));
  const configPath = path.join(dir, "opencode-router.json");
  const original = JSON.stringify({
    version: 1,
    channels: { slack: { apps: [{ id: "default", botToken: "xoxb-secret", appToken: "xapp-secret" }] } },
  });
  fs.writeFileSync(configPath, original);
  try {
    const identities = await prepareSlackIdentities(configPath, env);
    assert.equal(identities[0].botToken, "xoxb-secret");
    assert.equal(fs.readFileSync(configPath, "utf8"), original);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("prepareSlackIdentities fails without rewriting incomplete identity records", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-secrets-"));
  const configPath = path.join(dir, "opencode-router.json");
  const original = JSON.stringify({
    version: 1,
    channels: { slack: { apps: [{ id: "default", botTokenRef: "partial-ref" }] } },
  });
  fs.writeFileSync(configPath, original);

  try {
    await assert.rejects(prepareSlackIdentities(configPath, env), /incomplete credentials/);
    assert.equal(fs.readFileSync(configPath, "utf8"), original);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

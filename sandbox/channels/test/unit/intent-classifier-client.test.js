import assert from "node:assert/strict";
import { afterEach, test } from "bun:test";

import { classifyIntent } from "../../dist/intent-classifier-client.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const silentLogger = {
  warn: () => {},
};

test("sends Bearer when a token is configured", async () => {
  let authorization = null;
  globalThis.fetch = async (_url, init) => {
    authorization = new Headers(init?.headers).get("Authorization");
    return Response.json({ agent: "superclaw-default" });
  };

  const result = await classifyIntent("hello", "session-1", silentLogger, {
    url: "http://127.0.0.1:18791",
    token: "bridge-token",
  });
  assert.equal(authorization, "Bearer bridge-token");
  assert.deepEqual(result, { agent: "superclaw-default" });
});

test("omits Authorization when no token is configured", async () => {
  let authorization = "unset";
  globalThis.fetch = async (_url, init) => {
    authorization = new Headers(init?.headers).get("Authorization");
    return Response.json({ agent: "superclaw-default" });
  };

  await classifyIntent("hello", "session-1", silentLogger, {
    url: "http://127.0.0.1:18791",
    token: "",
  });
  assert.equal(authorization, null);
});

test("a 401 becomes null with a credential warning", async () => {
  const warnings = [];
  const logger = {
    warn: (payload, message) => warnings.push({ payload, message }),
  };
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ code: "intent_classifier_unauthorized" }), { status: 401 });

  const result = await classifyIntent("hello", "session-1", logger, {
    url: "http://127.0.0.1:18791",
    token: "bridge-token",
  });
  assert.equal(result, null);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].message, "intent classifier rejected the bridge credential");
  assert.equal(warnings[0].payload.status, 401);
  assert.equal(warnings[0].payload.code, "intent_classifier_unauthorized");
});

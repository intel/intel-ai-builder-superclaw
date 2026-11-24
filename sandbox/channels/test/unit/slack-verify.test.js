import assert from "node:assert/strict";
import { test } from "bun:test";

import { verifySlackCredentials } from "../../dist/slack.js";

/**
 * Build a WebClient stub whose behaviour is keyed on the token it is constructed
 * with, so a test can make the bot token succeed while the app token fails (and
 * vice versa). That asymmetry is the point: the two tokens authorize different
 * halves of the integration — `auth.test` covers sending, and
 * `apps.connections.open` covers receiving — so a stub that treats them
 * identically could not detect the "sends fine, never receives" failure this
 * verification exists to prevent.
 */
function createWebClientStub(behaviour) {
  const calls = [];
  class WebClientStub {
    constructor(token) {
      this.token = token;
      this.auth = {
        test: async () => {
          calls.push({ kind: "auth.test", token });
          const outcome = behaviour(token, "auth.test");
          if (outcome instanceof Error) throw outcome;
          return outcome ?? {};
        },
      };
    }
    async apiCall(method) {
      calls.push({ kind: method, token: this.token });
      const outcome = behaviour(this.token, method);
      if (outcome instanceof Error) throw outcome;
      return outcome ?? {};
    }
  }
  return { WebClient: WebClientStub, calls };
}

/** Slack's SDK surfaces a rejected token as a platform error carrying `data.error`. */
function slackPlatformError(code) {
  return Object.assign(new Error(`An API error occurred: ${code}`), {
    code: "slack_webapi_platform_error",
    data: { ok: false, error: code },
  });
}

const validBotAuth = {
  ok: true,
  team: "Acme Corp",
  team_id: "T123",
  user_id: "UBOT",
  bot_id: "BBOT",
  app_id: "A123",
};

function validAppConnection(appId = "A123") {
  return { ok: true, url: `wss://example.invalid/link?ticket=test&app_id=${appId}` };
}

function validPairBehaviour(token) {
  return token.startsWith("xoxb-") || token.startsWith("xoxe.xoxb-")
    ? validBotAuth
    : validAppConnection();
}

test("verifySlackCredentials accepts a valid pair and returns the workspace identity", async () => {
  const { WebClient, calls } = createWebClientStub(validPairBehaviour);

  const result = await verifySlackCredentials("xoxb-good", "xapp-good", { WebClient });

  assert.equal(result.ok, true);
  assert.equal(result.teamName, "Acme Corp");
  assert.equal(result.teamId, "T123");
  assert.equal(result.botUserId, "UBOT");
  // Both credentials must actually be exercised; checking only one would let the
  // other be arbitrary text.
  assert.deepEqual(
    calls.map((c) => c.kind),
    ["auth.test", "apps.connections.open"],
  );
});

test("verifySlackCredentials rejects an invalid bot token without testing the app token", async () => {
  const { WebClient, calls } = createWebClientStub((token) =>
    token.startsWith("xoxb-") ? slackPlatformError("invalid_auth") : { ok: true },
  );

  const result = await verifySlackCredentials("xoxb-bad", "xapp-good", { WebClient });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid");
  assert.equal(result.scope, "bot");
  assert.equal(result.error, "invalid_auth");
  // Fails fast: no point opening a Socket Mode connection for a bot that cannot
  // post, and it keeps the reported `scope` unambiguous.
  assert.deepEqual(
    calls.map((c) => c.kind),
    ["auth.test"],
  );
});

for (const { name, botToken, appToken, scope } of [
  { name: "app token in the bot field", botToken: "xapp-good", appToken: "xapp-good", scope: "bot" },
  { name: "bot token in the app field", botToken: "xoxb-good", appToken: "xoxb-good", scope: "app" },
  { name: "arbitrary text", botToken: "not-a-token", appToken: "also-not-a-token", scope: "bot" },
]) {
  test(`verifySlackCredentials rejects ${name} before calling Slack`, async () => {
    const { WebClient, calls } = createWebClientStub(() => ({ ok: true }));

    const result = await verifySlackCredentials(botToken, appToken, { WebClient });

    assert.deepEqual(result, {
      ok: false,
      reason: "invalid",
      scope,
      error: "not_allowed_token_type",
    });
    assert.deepEqual(calls, []);
  });
}

test("verifySlackCredentials accepts a rotating bot access token", async () => {
  const { WebClient } = createWebClientStub(validPairBehaviour);

  const result = await verifySlackCredentials("xoxe.xoxb-good", "xapp-good", { WebClient });

  assert.equal(result.ok, true);
});

test("verifySlackCredentials rejects a bad app token even when the bot token is valid", async () => {
  // The regression that motivated this: a real `xoxb-` paired with a junk
  // `xapp-` produced a channel that looked connected but never received events.
  const { WebClient } = createWebClientStub((token) =>
    token.startsWith("xoxb-") ? validBotAuth : slackPlatformError("invalid_auth"),
  );

  const result = await verifySlackCredentials("xoxb-good", "xapp-bad", { WebClient });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid");
  assert.equal(result.scope, "app");
  assert.equal(result.error, "invalid_auth");
});

test("verifySlackCredentials rejects credentials from different Slack apps", async () => {
  const { WebClient, calls } = createWebClientStub((token, method) =>
    token.startsWith("xoxb-") ? { ...validBotAuth, app_id: "A-BOT" } : validAppConnection("A-APP"),
  );

  const result = await verifySlackCredentials("xoxb-good", "xapp-good", { WebClient });

  assert.deepEqual(result, {
    ok: false,
    reason: "invalid",
    scope: "app",
    error: "token_app_mismatch",
  });
  assert.deepEqual(
    calls.map((c) => c.kind),
    ["auth.test", "apps.connections.open"],
  );
});

test("verifySlackCredentials accepts documented responses without optional app identity", async () => {
  const { WebClient } = createWebClientStub((token, method) =>
    token.startsWith("xoxb-") ? { ...validBotAuth, app_id: undefined } : validAppConnection(""),
  );

  const result = await verifySlackCredentials("xoxb-good", "xapp-good", { WebClient });

  assert.equal(result.ok, true);
});

test("verifySlackCredentials rejects apps.connections.open without a WebSocket URL", async () => {
  const { WebClient } = createWebClientStub((token) =>
    token.startsWith("xoxb-") ? validBotAuth : { ok: true },
  );

  const result = await verifySlackCredentials("xoxb-good", "xapp-good", { WebClient });

  assert.deepEqual(result, {
    ok: false,
    reason: "invalid",
    scope: "app",
    error: "invalid_app_identity",
  });
});

test("verifySlackCredentials rejects missing required bot scopes when Slack reports them", async () => {
  const { WebClient, calls } = createWebClientStub((token) =>
    token.startsWith("xoxb-")
      ? { ...validBotAuth, response_metadata: { scopes: ["app_mentions:read", "im:history"] } }
      : validAppConnection(),
  );

  const result = await verifySlackCredentials("xoxb-good", "xapp-good", { WebClient });

  assert.deepEqual(result, {
    ok: false,
    reason: "invalid",
    scope: "bot",
    error: "missing_scope:chat:write",
  });
  assert.deepEqual(
    calls.map((c) => c.kind),
    ["auth.test"],
  );
});

test("verifySlackCredentials distinguishes an unreachable Slack from a rejected token", async () => {
  // A transport failure carries no `data.error`, so the verdict is *unknown*
  // rather than negative. Collapsing it into "invalid" would tell the user their
  // token is wrong when the real problem is the network.
  const { WebClient } = createWebClientStub(
    () => Object.assign(new Error("getaddrinfo ENOTFOUND slack.com"), { code: "ENOTFOUND" }),
  );

  const result = await verifySlackCredentials("xoxb-good", "xapp-good", { WebClient });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "unreachable");
  assert.equal(result.scope, "bot");
  assert.match(result.error, /ENOTFOUND/);
});

test("verifySlackCredentials treats a timeout as unreachable", async () => {
  const { WebClient } = createWebClientStub(
    () => Object.assign(new Error("A request timed out"), { code: "slack_webapi_request_error" }),
  );

  const result = await verifySlackCredentials("xoxb-good", "xapp-good", { WebClient });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "unreachable");
});

test("verifySlackCredentials rejects auth.test without bot identity metadata", async () => {
  const { WebClient } = createWebClientStub(() => ({ ok: true }));

  const result = await verifySlackCredentials("xoxb-good", "xapp-good", { WebClient });

  assert.deepEqual(result, {
    ok: false,
    reason: "invalid",
    scope: "bot",
    error: "invalid_bot_identity",
  });
});

test("verifySlackCredentials never throws", async () => {
  // The caller's contract is a typed result, so even a stub that throws a
  // non-Error must come back as a verdict rather than an exception.
  const { WebClient } = createWebClientStub(() => {
    throw "plain string failure";
  });

  const result = await verifySlackCredentials("xoxb-good", "xapp-good", { WebClient });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "unreachable");
});

// The proxy agent sends CONNECT over plain HTTP, so only an http:// proxy can carry Slack; with an
// https:// proxy the bridge connects directly, as it did before it was handed a proxy at all.
for (const [proxy, expectAgent] of [
  ["http://proxy.example:912", true],
  ["https://proxy.example:912", false],
]) {
  test(`verifySlackCredentials ${expectAgent ? "uses" : "does not use"} a proxy agent for ${proxy}`, async () => {
    const names = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"];
    const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    for (const name of names) delete process.env[name];
    process.env.HTTPS_PROXY = proxy;
    const agents = [];
    class WebClientStub {
      constructor(token, options) {
        agents.push(options?.agent);
        this.auth = { test: async () => validBotAuth };
      }
      async apiCall() {
        return validAppConnection();
      }
    }
    try {
      const result = await verifySlackCredentials("xoxb-good", "xapp-good", { WebClient: WebClientStub });
      assert.equal(result.ok, true);
      assert.equal(agents.length, 2);
      for (const agent of agents) assert.equal(agent !== undefined, expectAgent);
    } finally {
      for (const name of names) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
      }
    }
  });
}

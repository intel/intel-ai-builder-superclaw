import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "bun:test";

import { resolveUnderlyingModel } from "../../dist/lrm-usage.js";

const REACHABLE_BASE = "http://lrm.test";

const originalFetch = globalThis.fetch;
const originalBase = process.env.LRM_API_BASE_URL;
const originalApiKey = process.env.LRM_API_KEY;

/** Requests observed by the stubbed fetch, in order. */
let calls = [];

/**
 * Stub `fetch` with a handler receiving the parsed request plus the raw init
 * (for `signal`). Returning a plain object serves it as a 200 JSON body,
 * returning `undefined` serves a 500, and throwing simulates a transport
 * failure.
 */
function stubFetch(handler) {
  calls = [];
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(String(url));
    const call = {
      base: `${parsed.protocol}//${parsed.host}`,
      pathname: parsed.pathname,
      sessionId: parsed.searchParams.get("session_id"),
      sinceMs: parsed.searchParams.get("since_ms"),
      limit: parsed.searchParams.get("limit"),
      authorization: new Headers(init?.headers).get("Authorization"),
    };
    calls.push(call);
    const result = await handler(call, init);
    if (result === undefined) return new Response("nope", { status: 500 });
    return Response.json(result);
  };
}

function event(occurredAt, underlyingModel, alias) {
  return { occurred_at: occurredAt, underlying_model: underlyingModel, ...(alias === undefined ? {} : { alias }) };
}

beforeEach(() => {
  process.env.LRM_API_BASE_URL = REACHABLE_BASE;
  delete process.env.LRM_API_KEY;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalBase === undefined) delete process.env.LRM_API_BASE_URL;
  else process.env.LRM_API_BASE_URL = originalBase;
  if (originalApiKey === undefined) delete process.env.LRM_API_KEY;
  else process.env.LRM_API_KEY = originalApiKey;
});

test("resolveUnderlyingModel: hits the usage-events endpoint scoped to the session", async () => {
  stubFetch(() => ({ events: [event(1000, "qwen3.6-35b-a3b")] }));

  const result = await resolveUnderlyingModel("ses_abc", 0);

  assert.deepEqual(result, { model: "qwen3.6-35b-a3b", cursorMs: 1000 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].base, REACHABLE_BASE);
  assert.equal(calls[0].pathname, "/llm-router/v1/usage/events");
  assert.equal(calls[0].sessionId, "ses_abc");
  assert.equal(calls[0].sinceMs, "0");
  assert.equal(calls[0].limit, "1000");
  assert.equal(calls[0].authorization, null);
});

test("resolveUnderlyingModel: sends the LRM API key as a Bearer token", async () => {
  process.env.LRM_API_KEY = " lrm-secret ";
  stubFetch(() => ({ events: [] }));

  await resolveUnderlyingModel("ses_abc", 0);

  assert.equal(calls[0].authorization, "Bearer lrm-secret");
});

test("resolveUnderlyingModel: omits Authorization for a blank LRM API key", async () => {
  process.env.LRM_API_KEY = "   ";
  stubFetch(() => ({ events: [] }));

  await resolveUnderlyingModel("ses_abc", 0);

  assert.equal(calls[0].authorization, null);
});

test("resolveUnderlyingModel: takes the LAST event, not the first", async () => {
  // An agentic turn makes several LLM calls; only the final one produced the
  // visible reply, so the footer must not name the first model of the turn.
  stubFetch(() => ({
    events: [event(1000, "first-model"), event(2000, "middle-model"), event(3000, "final-model")],
  }));

  const result = await resolveUnderlyingModel("ses_abc", 0);

  assert.deepEqual(result, { model: "final-model", cursorMs: 3000 });
});

test("resolveUnderlyingModel: advances the cursor so the next turn skips this turn", async () => {
  stubFetch(() => ({ events: [event(4200, "turn-one-model")] }));
  const first = await resolveUnderlyingModel("ses_abc", 0);
  assert.equal(first.cursorMs, 4200);

  stubFetch((call) => {
    assert.equal(call.sinceMs, "4200");
    return { events: [event(9100, "turn-two-model")] };
  });
  const second = await resolveUnderlyingModel("ses_abc", first.cursorMs);

  assert.deepEqual(second, { model: "turn-two-model", cursorMs: 9100 });
});

test("resolveUnderlyingModel: follows next_since_ms across pages", async () => {
  // since_ms=0 on a long session returns the OLDEST page (occurred_at ASC +
  // LIMIT), so the current turn is only reachable by following the cursor.
  stubFetch((call) => {
    if (call.sinceMs === "0") return { events: [event(10, "old-model")], next_since_ms: 10 };
    if (call.sinceMs === "10") return { events: [event(20, "newer-model")], next_since_ms: 20 };
    return { events: [event(30, "current-model")] };
  });

  const result = await resolveUnderlyingModel("ses_abc", 0);

  assert.deepEqual(result, { model: "current-model", cursorMs: 30 });
  assert.deepEqual(
    calls.map((call) => call.sinceMs),
    ["0", "10", "20"],
  );
});

test("resolveUnderlyingModel: stops after 5 pages instead of paging forever", async () => {
  let occurredAt = 0;
  stubFetch(() => {
    occurredAt += 10;
    return { events: [event(occurredAt, `model-${occurredAt}`)], next_since_ms: occurredAt };
  });

  const result = await resolveUnderlyingModel("ses_abc", 0);

  assert.equal(calls.length, 5);
  assert.deepEqual(result, { model: "model-50", cursorMs: 50 });
});

test("resolveUnderlyingModel: stops when next_since_ms does not advance", async () => {
  stubFetch(() => ({ events: [event(700, "stuck-model")], next_since_ms: 700 }));

  const result = await resolveUnderlyingModel("ses_abc", 700);

  assert.equal(calls.length, 1);
  assert.deepEqual(result, { model: "stuck-model", cursorMs: 700 });
});

test("resolveUnderlyingModel: an unreachable configured base is not retried anywhere else", async () => {
  stubFetch(() => {
    throw new Error("ECONNREFUSED");
  });

  const result = await resolveUnderlyingModel("ses_abc", 0);

  assert.deepEqual(result, { model: null, cursorMs: 0 });
  assert.deepEqual(calls.map((call) => call.base), [REACHABLE_BASE]);
});

test("resolveUnderlyingModel: with no LRM_API_BASE_URL it makes no request at all", async () => {
  // The channel tier can reach no LRM port, so an unset base means there is nothing to ask. A guessed
  // loopback port would only be a connection the tier is not allowed to make.
  delete process.env.LRM_API_BASE_URL;
  stubFetch(() => {
    throw new Error("must not be called");
  });

  const result = await resolveUnderlyingModel("ses_abc", 1234);

  assert.deepEqual(result, { model: null, cursorMs: 1234 });
  assert.deepEqual(calls, []);
});

test("resolveUnderlyingModel: fails open with the cursor intact when LRM is unreachable", async () => {
  stubFetch(() => {
    throw new Error("ECONNREFUSED");
  });

  const result = await resolveUnderlyingModel("ses_abc", 1234);

  assert.deepEqual(result, { model: null, cursorMs: 1234 });
});

test("resolveUnderlyingModel: fails open on a non-OK status", async () => {
  stubFetch(() => undefined);

  const result = await resolveUnderlyingModel("ses_abc", 1234);

  assert.deepEqual(result, { model: null, cursorMs: 1234 });
});

test("resolveUnderlyingModel: fails open on a malformed body", async () => {
  stubFetch(() => ({ unexpected: true }));

  const result = await resolveUnderlyingModel("ses_abc", 77);

  assert.deepEqual(result, { model: null, cursorMs: 77 });
});

test("resolveUnderlyingModel: one shared deadline bounds the whole lookup, not each request", async () => {
  // Only the AbortController can end this request, so reaching the assertions
  // at all proves the deadline is wired up. It must be a whole-call budget: a
  // per-request timeout would multiply out to bases x pages of dead waiting
  // right before a reply is posted.
  stubFetch(
    (_call, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          const abortError = new Error("aborted");
          abortError.name = "AbortError";
          reject(abortError);
        });
      }),
  );

  const started = Date.now();
  const result = await resolveUnderlyingModel("ses_abc", 5);
  const elapsed = Date.now() - started;

  assert.deepEqual(result, { model: null, cursorMs: 5 });
  assert.ok(elapsed >= 1400, `expected the 1500ms deadline to be honoured, waited ${elapsed}ms`);
  assert.ok(elapsed < 2900, `budget must be shared across base URLs, waited ${elapsed}ms`);
  assert.equal(calls.length, 1, "remaining base URLs are skipped once the budget is spent");
}, 20_000);

test("resolveUnderlyingModel: an empty page is authoritative, not a reason to retry elsewhere", async () => {
  // A reachable LRM with no recorded dispatch yet means "unknown model", so the
  // caller shows the alias; retrying other base URLs would only add latency.
  stubFetch(() => ({ events: [] }));

  const result = await resolveUnderlyingModel("ses_abc", 42);

  assert.equal(calls.length, 1);
  assert.deepEqual(result, { model: null, cursorMs: 42 });
});

test("resolveUnderlyingModel: skips events with no usable underlying_model", async () => {
  stubFetch(() => ({ events: [event(100, "real-model"), event(200, ""), event(300, null)] }));

  const result = await resolveUnderlyingModel("ses_abc", 0);

  assert.deepEqual(result, { model: "real-model", cursorMs: 300 });
});

test("resolveUnderlyingModel: never queries without a session id", async () => {
  stubFetch(() => ({ events: [event(100, "should-not-be-read")] }));

  assert.deepEqual(await resolveUnderlyingModel("", 9), { model: null, cursorMs: 9 });
  assert.deepEqual(await resolveUnderlyingModel("   ", 9), { model: null, cursorMs: 9 });
  assert.equal(calls.length, 0);
});

// ─── model-id shape validation ───────────────────────────────────────────
// `underlying_model` is whatever the upstream echoed in its response `model`
// field, and cloud providers are reachable at an operator-supplied base_url.
// The value is rendered into the reply's `Model: *…*` Slack mrkdwn footer — the
// "did this stay local" trust signal — so it must satisfy the same shape
// contract `resolveModelPrefix` enforced on the prefix it replaced.

test("resolveUnderlyingModel: rejects a model id containing whitespace", async () => {
  stubFetch(() => ({ events: [event(100, "Local-Qwen-35B\n\n*Verified: stayed on-device*")] }));

  const result = await resolveUnderlyingModel("ses_abc", 0);

  // Cursor still advances: the event was seen, it just is not a usable label.
  assert.deepEqual(result, { model: null, cursorMs: 100 });
});

test("resolveUnderlyingModel: rejects an over-long model id", async () => {
  stubFetch(() => ({ events: [event(100, "m".repeat(81))] }));

  assert.deepEqual(await resolveUnderlyingModel("ses_abc", 0), { model: null, cursorMs: 100 });
});

test("resolveUnderlyingModel: keeps the last well-shaped id when a later one is rejected", async () => {
  stubFetch(() => ({
    events: [event(100, "qwen3.6-35b-a3b"), event(200, "spoofed *label* here")],
  }));

  assert.deepEqual(await resolveUnderlyingModel("ses_abc", 0), {
    model: "qwen3.6-35b-a3b",
    cursorMs: 200,
  });
});

test("resolveUnderlyingModel: accepts the id shapes real models use", async () => {
  for (const id of ["gpt-5.4", "MiniMax-M3", "deepseek/deepseek-chat", "m".repeat(80)]) {
    stubFetch(() => ({ events: [event(100, id)] }));
    assert.equal((await resolveUnderlyingModel("ses_abc", 0)).model, id);
  }
});

// ─── alias filtering ─────────────────────────────────────────────────────
// The HDR sidecar keeps dispatching under the same session id after its tool
// has returned and the reply has been posted. Its `fill` node requests
// `local-model` while the `hybrid-deep-research` turn itself requests
// `cloud-model`, so without the filter a late `fill` call names the footer.

test("resolveUnderlyingModel: prefers the event whose alias matches the turn", async () => {
  stubFetch(() => ({
    events: [
      event(100, "MiniMax-M3", "cloud-model"),
      event(200, "qwen3.6-35b-a3b", "local-model"), // HDR sidecar `fill`, post-reply
    ],
  }));

  const result = await resolveUnderlyingModel("ses_abc", 0, "cloud-model");

  assert.deepEqual(result, { model: "MiniMax-M3", cursorMs: 200 });
});

test("resolveUnderlyingModel: the cursor still advances past filtered-out events", async () => {
  // Otherwise the next turn would re-scan them forever.
  stubFetch(() => ({
    events: [event(100, "MiniMax-M3", "cloud-model"), event(900, "qwen3.6-35b-a3b", "local-model")],
  }));

  const first = await resolveUnderlyingModel("ses_abc", 0, "cloud-model");
  assert.equal(first.cursorMs, 900);

  stubFetch((call) => {
    assert.equal(call.sinceMs, "900");
    return { events: [] };
  });
  assert.deepEqual(await resolveUnderlyingModel("ses_abc", first.cursorMs, "cloud-model"), {
    model: null,
    cursorMs: 900,
  });
});

test("resolveUnderlyingModel: falls back to the last event when no alias matches", async () => {
  // `sessionModels` is fed asynchronously from opencode's event stream, so the
  // expected alias can lag a turn behind an agent switch. Degrade to the
  // pre-filter behaviour rather than dropping the label.
  stubFetch(() => ({
    events: [event(100, "first-model", "cloud-model"), event(200, "final-model", "cloud-model")],
  }));

  const result = await resolveUnderlyingModel("ses_abc", 0, "auto");

  assert.deepEqual(result, { model: "final-model", cursorMs: 200 });
});

test("resolveUnderlyingModel: an absent alias on the event never matches", async () => {
  stubFetch(() => ({ events: [event(100, "aliasless-model")] }));

  const result = await resolveUnderlyingModel("ses_abc", 0, "cloud-model");

  // No match, so the unfiltered candidate is used.
  assert.deepEqual(result, { model: "aliasless-model", cursorMs: 100 });
});

test("resolveUnderlyingModel: omitting the expected alias disables the filter", async () => {
  stubFetch(() => ({
    events: [event(100, "MiniMax-M3", "cloud-model"), event(200, "qwen3.6-35b-a3b", "local-model")],
  }));

  assert.deepEqual(await resolveUnderlyingModel("ses_abc", 0), {
    model: "qwen3.6-35b-a3b",
    cursorMs: 200,
  });
  assert.deepEqual(await resolveUnderlyingModel("ses_abc", 0, null), {
    model: "qwen3.6-35b-a3b",
    cursorMs: 200,
  });
});

test("resolveUnderlyingModel: alias preference holds across pages", async () => {
  stubFetch((call) => {
    if (call.sinceMs === "0") {
      return { events: [event(10, "MiniMax-M3", "cloud-model")], next_since_ms: 10 };
    }
    return { events: [event(20, "qwen3.6-35b-a3b", "local-model")] };
  });

  const result = await resolveUnderlyingModel("ses_abc", 0, "cloud-model");

  assert.deepEqual(result, { model: "MiniMax-M3", cursorMs: 20 });
});

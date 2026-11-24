import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "bun:test";

import { EGRESS_APPROVAL_GRANT_VECTOR as KEY, encodeEgressApprovalGrantToken } from "@different-ai/openwork-contracts/egress-approval-grant";
import { RouterApprovalGrantSchema, routerSendRequestDigest } from "@different-ai/openwork-contracts/router-approval";

import { SendApprovalHold, ScopedSendError } from "../../dist/send-approvals.js";

// The router checks a grant the way the design's verifier list says: signature, schema, canonical form,
// audience, boot id, time window, the held approval, its digest, and only then that it was not used.

const BOOT = "sm-boot-test-0001";
const CONFIG = { approval_public_key: KEY.public_key, boot_id: BOOT, admin_secret: KEY.public_key };

function makeHold(overrides = {}) {
  const clock = { now: 1_800_000_000_000 };
  const events = [];
  const hold = new SendApprovalHold({
    config: CONFIG,
    now: () => clock.now,
    onEvent: (event) => events.push(event),
    ...overrides,
  });
  return { hold, clock, events };
}

function signFor(entry, overrides = {}) {
  const grant = RouterApprovalGrantSchema.parse({
    contract_version: 1,
    grant_id: `grant-${Math.random().toString(36).slice(2)}`,
    approval_id: entry.approval_id,
    audience: "router",
    boot_id: BOOT,
    action: "router.send_new_target",
    request_digest: entry.request_digest,
    scope: { kind: "once" },
    issued_at_ms: entry.requested_at_ms,
    expires_at_ms: entry.requested_at_ms + 60_000,
    ...overrides,
  });
  return encodeEgressApprovalGrantToken(grant, KEY.test_private_key_seed_hex, RouterApprovalGrantSchema);
}

async function held(hold, channel = "slack", peer = "C0123456789") {
  const outcome = hold.hold(channel, peer).then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error }),
  );
  const [entry] = await hold.pending(0);
  return { entry, outcome };
}

test("a held send is listed with the contract's digest and is released by a valid grant", async () => {
  const { hold } = makeHold();
  const { entry, outcome } = await held(hold);
  assert.equal(entry.audience, "router");
  assert.equal(entry.action, "router.send_new_target");
  assert.equal(entry.caller, "agent");
  assert.equal(entry.target, "slack:C0123456789");
  assert.equal(entry.request_digest, routerSendRequestDigest("slack", "C0123456789"));
  hold.grant(signFor(entry));
  const settled = await outcome;
  assert.equal(settled.ok, true);
  assert.equal(settled.value.approvalId, entry.approval_id);
  assert.deepEqual(await hold.pending(0), []);
});

test("a denial refuses the send with the denied sentence", async () => {
  const { hold } = makeHold();
  const { entry, outcome } = await held(hold);
  assert.equal(hold.deny(entry.approval_id), true);
  const settled = await outcome;
  assert.equal(settled.ok, false);
  assert.ok(settled.error instanceof ScopedSendError);
  assert.equal(settled.error.code, "approval_denied");
  assert.match(settled.error.message, /SuperClaw desktop app/);
  assert.equal(hold.deny(entry.approval_id), false);
});

test("an unanswered hold expires after the contract's lifetime", async () => {
  const realSetTimeout = globalThis.setTimeout;
  const timers = [];
  globalThis.setTimeout = (callback, ms) => {
    timers.push({ callback, ms });
    return { unref() {} };
  };
  try {
    const { hold, events } = makeHold();
    const { outcome } = await held(hold);
    const expiry = timers.find((timer) => timer.ms === 120_000);
    assert.ok(expiry, "the hold is bounded by the contract's max lifetime");
    expiry.callback();
    const settled = await outcome;
    assert.equal(settled.error.code, "approval_expired");
    assert.ok(events.some((event) => event.event === "approval_expired"));
    assert.deepEqual(await hold.pending(0), []);
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});

test("a grant for another conversation, boot, audience key or time is refused and the send stays held", async () => {
  const { hold, clock } = makeHold();
  const { entry, outcome } = await held(hold);
  const other = routerSendRequestDigest("slack", "C9999999999");
  const bad = [
    signFor(entry, { request_digest: other }),
    signFor(entry, { boot_id: "sm-boot-other" }),
    signFor(entry, { approval_id: "approval-unknown" }),
    signFor(entry, { issued_at_ms: entry.requested_at_ms + 5_000 }),
    "not-a-token",
    `${signFor(entry).split(".")[0]}.${"A".repeat(86)}`,
  ];
  for (const token of bad) assert.throws(() => hold.grant(token), { message: "grant_rejected" });
  clock.now = entry.requested_at_ms + 60_000;
  assert.throws(() => hold.grant(signFor(entry)), { message: "grant_rejected" });
  clock.now = entry.requested_at_ms;
  assert.equal((await hold.pending(0)).length, 1);
  hold.grant(signFor(entry));
  assert.equal((await outcome).ok, true);
});

test("a grant is used once: the same one cannot release a second hold of the same conversation", async () => {
  const { hold } = makeHold();
  const first = await held(hold);
  const token = signFor(first.entry, { grant_id: "grant-once-0001" });
  hold.grant(token);
  await first.outcome;
  const second = await held(hold);
  const replay = signFor({ ...second.entry, approval_id: first.entry.approval_id }, { grant_id: "grant-once-0001" });
  assert.throws(() => hold.grant(replay), { message: "grant_rejected" });
  const fresh = signFor(second.entry, { grant_id: "grant-once-0001" });
  assert.throws(() => hold.grant(fresh), { message: "grant_rejected" });
});

test("a grant signed with a different key is refused", async () => {
  const other = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const { hold } = makeHold({ config: { ...CONFIG, approval_public_key: other.toString("base64url") } });
  const { entry } = await held(hold);
  assert.throws(() => hold.grant(signFor(entry)), { message: "grant_rejected" });
});

test("with no sealed approval config a new target is refused as unavailable, never sent", async () => {
  const hold = new SendApprovalHold({ config: null });
  await assert.rejects(hold.hold("slack", "C1"), (error) => error.code === "approval_unavailable" && error.status === 503);
});

test("the queue is bounded by the contract's pending limit", async () => {
  const { hold } = makeHold();
  const holds = [];
  for (let index = 0; index < 64; index += 1) {
    holds.push(hold.hold("slack", `C${index}`).catch(() => undefined));
  }
  await assert.rejects(hold.hold("slack", "C-overflow"), (error) => error.code === "approval_queue_full");
  for (const entry of await hold.pending(0)) hold.deny(entry.approval_id);
  await Promise.all(holds);
});

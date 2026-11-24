import assert from "node:assert/strict";
import { test } from "bun:test";

import { decideIntentGate, mapClassifierAgentToRuntimeAgent } from "../../dist/intent-gate.js";

// Regression coverage for issue #682: a prompt classified `ambiguous` triggers a
// canned "Clarification Needed" reply, and before the fix the bridge returned
// without recording anything — so every follow-up message was re-classified, and
// repeated `ambiguous` verdicts trapped the user in clarification cards forever
// with no way to steer the conversation back. The gate must guarantee recovery.

test("cached agent short-circuits the gate", () => {
  const d = decideIntentGate({ cachedAgent: "hybrid-coding", alreadyClarified: false }, null);
  assert.deepEqual(d, { action: "use-cached-agent", agent: "hybrid-coding" });
});

test("maps the classifier-only general task label to the OpenCode runtime agent", () => {
  assert.equal(mapClassifierAgentToRuntimeAgent("general-task-agent"), "superclaw-default");
  assert.equal(mapClassifierAgentToRuntimeAgent("build"), "build");
});

test("fresh ambiguous (response, no agent) sends the canned clarification once", () => {
  const classified = { category: "ambiguous", agent: null, response: "Where should I look?", confidence: 0.9 };
  const d = decideIntentGate({ cachedAgent: undefined, alreadyClarified: false }, classified);
  assert.deepEqual(d, { action: "send-canned", text: "Where should I look?" });
});

test("#682 RECOVERY: after a clarification, a repeat ambiguous does NOT re-canned — it falls through to the default agent", () => {
  // The classifier would happily return `ambiguous` again; the gate must refuse to
  // short-circuit a user who already saw a clarification, so they can recover and
  // have a real conversation.
  const repeatAmbiguous = { category: "ambiguous", agent: null, response: "Still need more info", confidence: 0.9 };
  const d = decideIntentGate({ cachedAgent: undefined, alreadyClarified: true }, repeatAmbiguous);
  assert.equal(d.action, "fall-through");
  assert.equal(d.reason, "post-clarification-recovery");
});

test("#682 RECOVERY holds even if the classifier is unreachable on the follow-up", () => {
  const d = decideIntentGate({ cachedAgent: undefined, alreadyClarified: true }, null);
  assert.equal(d.action, "fall-through");
  assert.equal(d.reason, "post-clarification-recovery");
});

test("resolved agent caches and carries the routing notice", () => {
  const classified = { category: "coding", agent: "hybrid-coding", response: "Routing to Hybrid Coding...", confidence: 0.95 };
  const d = decideIntentGate({ cachedAgent: undefined, alreadyClarified: false }, classified);
  assert.deepEqual(d, { action: "resolve-agent", agent: "hybrid-coding", notice: "Routing to Hybrid Coding..." });
});

test("an agent with no notice resolves without a routing message", () => {
  const classified = { category: "email", agent: "gmail", response: null, confidence: 0.8 };
  const d = decideIntentGate({ cachedAgent: undefined, alreadyClarified: false }, classified);
  assert.deepEqual(d, { action: "resolve-agent", agent: "gmail", notice: null });
});

test("classifier null on a fresh thread falls through to the default agent", () => {
  const d = decideIntentGate({ cachedAgent: undefined, alreadyClarified: false }, null);
  assert.equal(d.action, "fall-through");
  assert.equal(d.reason, "no-classifier-result");
});

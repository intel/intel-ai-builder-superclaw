import assert from "node:assert/strict";
import { test } from "bun:test";

import { formatInputSummary } from "../../dist/text.js";

test("formatInputSummary: returns description when present", () => {
  const result = formatInputSummary({
    description: "Shanghai weather today",
    prompt: "What is the weather in Shanghai today? This is a long prompt that should not appear in the output.",
  });
  assert.equal(result, "Shanghai weather today");
  assert(!result.includes("weather in Shanghai"), "result should not contain prompt text");
  assert(!result.includes("What is the weather"), "result should not contain prompt text");
});

test("formatInputSummary: returns command when present", () => {
  const result = formatInputSummary({ command: "ls -la" });
  assert.equal(result, "ls -la");
});

test("formatInputSummary: returns empty string for empty object", () => {
  const result = formatInputSummary({});
  assert.equal(result, "");
});

test("formatInputSummary: fallback to key=value for scalar fields, skipping prompt", () => {
  const result = formatInputSummary({ count: 3, flag: true });
  assert.equal(result, "count=3, flag=true");
});

test("formatInputSummary: prefers summary keys in order", () => {
  const result = formatInputSummary({
    name: "test-name",
    description: "test-description",
    query: "test-query",
  });
  // Should return the first matching key in SUMMARY_KEYS order
  assert.equal(result, "test-description");
});

test("formatInputSummary: skips prompt field in fallback", () => {
  const result = formatInputSummary({
    prompt: "This should be skipped",
    count: 5,
  });
  assert.equal(result, "count=5");
  assert(!result.includes("prompt"), "result should not contain prompt field");
});

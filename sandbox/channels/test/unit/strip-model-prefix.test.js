import assert from "node:assert/strict";
import { test } from "bun:test";

import { resolveModelPrefix, stripModelPrefix } from "../../dist/text.js";

test("stripModelPrefix: strips model-id, preserves [Note]", () => {
  assert.equal(stripModelPrefix("[MiniMax-M3] hello"), "hello");
  assert.equal(stripModelPrefix("[Note] important"), "[Note] important");
});

// `resolveModelPrefix` is now only the FALLBACK provenance source for the
// Slack/Telegram model footer (LRM usage events are primary, and prefix
// injection is off unless SUPERCLAW_LRM_MODEL_PREFIX opts in). These lock its
// behaviour so the fallback cannot rot unnoticed.
test("resolveModelPrefix: reads the injected model id", () => {
  assert.equal(resolveModelPrefix("[qwen3.6-35b-a3b] hello"), "qwen3.6-35b-a3b");
  assert.equal(resolveModelPrefix("[deepseek/deepseek-chat] hi"), "deepseek/deepseek-chat");
  assert.equal(resolveModelPrefix("  [gpt-5] leading whitespace"), "gpt-5");
  // Looser than stripModelPrefix: no trailing-space requirement.
  assert.equal(resolveModelPrefix("[gpt-5]"), "gpt-5");
});

test("resolveModelPrefix: returns null when there is no leading bracket token", () => {
  assert.equal(resolveModelPrefix(""), null);
  assert.equal(resolveModelPrefix("plain reply"), null);
  assert.equal(resolveModelPrefix("mid-text [gpt-5] bracket"), null);
  assert.equal(resolveModelPrefix("[] empty"), null);
});

test("resolveModelPrefix: rejects prose so litellm placeholders are not shown as models", () => {
  assert.equal(resolveModelPrefix("[System: content sanitised] body"), null);
  assert.equal(resolveModelPrefix(`[${"m".repeat(81)}] too long`), null);
});

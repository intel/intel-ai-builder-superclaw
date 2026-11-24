/**
 * superclaw_output_token_cap — clamp the per-request output-token budget so
 * `input_tokens + max_output_tokens` cannot exceed the model context window.
 *
 * Why this exists (and why the read-output-cap plugin was not enough):
 * The remote model window is 140000 tok. The observed ContextOverflowError is
 * NOT caused by one oversized read — the input was ~108k tok (well under the
 * window). It overflowed because opencode requested max_tokens=32768, and
 * 108368 + 32768 = 140368 > 140000. The upstream admission rule is
 * `input + max_tokens <= window`, so the fix is to shrink the OUTPUT budget,
 * not the input.
 *
 * The `chat.params` hook is the only plugin-layer lever for this (see
 * FINDINGS.md F-007 attempt 2: `chat.params.maxOutputTokens` demonstrably
 * shrinks each LLM call). We cap it to CAP_TOKENS: with CAP_TOKENS=32768 any
 * request whose input is <= 108000 tok is admitted.
 *
 * Limitation: `chat.params` does not expose the assembled prompt token count,
 * so this is a STATIC cap, not a per-request dynamic clamp. Inputs larger than
 * (window - CAP_TOKENS) would still overflow; bounding input growth is handled
 * separately (step budget + read-output cap). Lower CAP_TOKENS via env
 * LRM_LOCAL_MAX_OUTPUT_TOKENS if larger inputs are expected.
 *
 * Scope: every session (parent and subagent).
 */
import type { Plugin } from "@opencode-ai/plugin";

// Per-request output-token cap. 32768 leaves ~108k tok of input headroom inside a
// 140k window, so prompts beyond that depend on the context guard compacting
// first rather than on this cap. Tunable via env.
const DEFAULT_CAP = 32768;

function resolveCap(): number {
  const raw = process.env.LRM_LOCAL_MAX_OUTPUT_TOKENS;
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_CAP;
}

const CAP_TOKENS = resolveCap();

export const SuperclawOutputTokenCap: Plugin = async ({ client }) => {
  await client.app.log({
    body: {
      service: "superclaw-output-token-cap",
      level: "info",
      message: `Plugin initialised; capping maxOutputTokens at ${CAP_TOKENS}`,
    },
  });

  return {
    "chat.params": async (_input: any, output: any) => {
      if (!output || typeof output !== "object") return;

      // Primary lever (validated in FINDINGS F-007): maxOutputTokens.
      const current =
        typeof output.maxOutputTokens === "number" ? output.maxOutputTokens : undefined;
      output.maxOutputTokens = CAP_TOKENS;

      // Belt-and-suspenders: also stamp the provider options bag in case this
      // model path reads max_tokens / maxOutputTokens from options instead.
      output.options = output.options ?? {};
      output.options.maxOutputTokens = CAP_TOKENS;
      output.options.max_tokens = CAP_TOKENS;

      if (current === undefined || current > CAP_TOKENS) {
        await client.app.log({
          body: {
            service: "superclaw-output-token-cap",
            level: "info",
            message: `Capped maxOutputTokens ${current ?? "default"} -> ${CAP_TOKENS}`,
          },
        });
      }
    },
  };
};

// opencode SDK expects a direct function as the default export.
export default SuperclawOutputTokenCap;

/**
 * User-facing removal of llmrouter_manager's "Tool call rejected" hardening notices.
 *
 * `host/llmrouter_manager`'s tool-call hardening drops a weak local/edge model's
 * unknown-name or malformed-argument tool call — including one a repeat lock or the
 * unrun-script lock forced out of the catalog — and appends a corrective notice
 * straight into the assistant's own `content` (see `common/tools.py`
 * `_format_structured_error` / `_format_key_error` / `_repeat_lock_note`). The model
 * needs to see that notice on its next turn to self-correct, but opencode has no way
 * to mark "the proxy wrote this" apart from "the model wrote this", so it streams
 * through and renders as ordinary assistant prose, naming internal tool-catalog
 * details the user never asked about.
 *
 * Detection is a literal opener because every variant of this notice is built from
 * the exact prefix `"Tool call rejected:"` and nothing else. Unlike
 * `sanitizeGuardErrors`'s openers, this phrase does not collide with ordinary
 * English, so no lower-case-prose precautions are needed here.
 *
 * Unlike `sanitizeGuardErrors`'s whole-run removal, only the notice's OWN line(s)
 * (and an enclosing fence, if a model quotes the notice inside one) are dropped —
 * not every non-blank line physically adjacent to it. `tools.py` always writes one
 * notice per line (`_format_structured_error` / `_format_key_error` build one
 * string per violated call with no embedded newline, so a multi-call rejection is
 * still one line per call) and always separates it from any prior content with a
 * blank line (`existing_content + "\n\n" + error_text`). A whole-run removal would
 * therefore delete real answer text that merely happens to sit on the line right
 * after the notice with no blank line of its own in between (a model's own prose
 * doesn't reliably blank-separate itself from a tool result) — see #3831's review:
 * "The report is saved.\nTool call rejected: ...\nUse report.txt for the results."
 * must keep both of the model's sentences, dropping only the middle line.
 *
 * A single directly-adjacent (no intervening blank line) colon-terminated line
 * immediately before the notice is treated as its introduction and dropped too, the
 * same reason `sanitizeGuardErrors` drops one — but unlike `sanitizeGuardErrors`,
 * the lookback does NOT skip past a blank line to find it: `tools.py`'s own blank
 * line before the notice is structural punctuation, not a model's deliberate "here
 * is a quote" paragraph break, so skipping it would delete the last line of
 * whatever the model was saying before the rejected call merely because it happened
 * to end in a colon (e.g. a status line like "Remaining work:").
 *
 * M4 (`validate_tool_call_arg_values` / `_format_value_error`) appends a second,
 * unprefixed line after a rejected `task(subagent_type=...)` value —
 * `"Do not retry the same value. Pick a \`subagent_type\` ..."` — that carries no
 * opener of its own but is still part of the same notice (and references "the
 * allowed set above", which would otherwise dangle once that line is gone), so it
 * is recognized as a known continuation and dropped together with the notice line
 * immediately before it, the same way a guard's `Required next action:` line
 * extends `sanitizeGuardErrors`'s run.
 *
 * No placeholder copy takes the notice's place — it carries no information the
 * user needs (it exists purely to steer the model's own next turn) — so a
 * pure-notice message disappears entirely (see `isToolRejectOnlyTextPart` in
 * `part-visibility.ts`, which drops the whole part when this leaves nothing
 * behind) and a notice mixed into real prose just closes the gap it left.
 *
 * Only the gap a removed line leaves behind is cleaned up: a blank line is
 * collapsed or trimmed ONLY when it sits directly next to a dropped line.
 * Untouched regions — including a run of blank lines inside an unrelated quoted
 * code block — are reproduced verbatim; this function never collapses or trims
 * whitespace that has nothing to do with the notice it removed.
 *
 * Known gap, left undone deliberately rather than guessed at: M2's
 * `hit_output_cap` branch (`validate_tool_call_args` in tools.py) phrases a
 * truncated-output notice as "Your output hit the max output-token limit..."
 * with no "Tool call rejected:" opener at all, so it is not recognized here.
 *
 * The llmrouter_manager contract is untouched; this is presentation only.
 */

/**
 * Opening marker of a rejection notice, anywhere in the line — llmrouter_manager
 * always emits it at the start of its own text, but a model retelling it can inline
 * it mid-sentence, and markdown quote/bullet decoration can precede it.
 */
const TOOL_REJECT_OPENER_RE = /\bTool call rejected:/;

/** Same opener `sanitizeToolRejectMessages` drops — for step-tone, not copy. */
export function isToolRejectText(text: string): boolean {
  return TOOL_REJECT_OPENER_RE.test(text);
}

/** A ``` line, which opens or closes a fenced block. */
const FENCE_RE = /^\s*```/;

/**
 * M4's unprefixed continuation line (`_format_value_error` in tools.py), only
 * ever meaningful directly after a dropped notice line — see the module doc.
 * Accepts the same markdown quote/bullet decoration the opener already
 * tolerates (unanchored), since a model quoting the notice back quotes both
 * lines the same way: `> Tool call rejected: ...` / `> Do not retry ...`.
 */
const TOOL_REJECT_CONTINUATION_RE =
  /^[ \t]*(?:>[ \t]*)*(?:[-+*][ \t]+|\d+[.)][ \t]+)?Do not retry the same value\./;

/**
 * Remove any "Tool call rejected" notice from `text`, line by line.
 *
 * A line is dropped if it is itself a notice line, a known unprefixed
 * continuation directly after one (M4's "Do not retry the same value." hint), or
 * if it is one half of a fenced block (```...```) whose content contains a
 * notice line anywhere inside — the whole fence goes with it, the same way
 * `sanitizeGuardErrors` treats a fence as one unit, so a model that quotes the
 * notice in a code block doesn't leave a dangling empty ``` pair behind. A
 * single directly-adjacent colon-terminated line immediately before a dropped
 * run is absorbed as that run's introduction.
 *
 * A blank line is collapsed or trimmed only when it is itself adjacent to a
 * dropped line — see the module doc's "untouched regions" note.
 */
export function sanitizeToolRejectMessages(text: string): string {
  if (!text) return text;
  if (!TOOL_REJECT_OPENER_RE.test(text)) return text;

  const lines = text.split("\n");
  const drop = new Array<boolean>(lines.length).fill(false);

  let fenceStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (FENCE_RE.test(lines[i])) {
      if (fenceStart === -1) {
        fenceStart = i;
        continue;
      }
      const hasNotice = lines
        .slice(fenceStart, i + 1)
        .some((line) => TOOL_REJECT_OPENER_RE.test(line));
      if (hasNotice) {
        for (let k = fenceStart; k <= i; k++) drop[k] = true;
      }
      fenceStart = -1;
      continue;
    }
    if (TOOL_REJECT_OPENER_RE.test(lines[i])) drop[i] = true;
  }

  if (!drop.some(Boolean)) return text;

  // A known continuation line directly after a dropped line is part of the same
  // notice (M4's "Do not retry the same value." hint has no opener of its own).
  for (let i = 1; i < lines.length; i++) {
    if (!drop[i] && drop[i - 1] && TOOL_REJECT_CONTINUATION_RE.test(lines[i])) {
      drop[i] = true;
    }
  }

  // Absorb a single directly-adjacent (no blank line between) colon-terminated
  // introduction immediately before the start of each dropped run.
  for (let i = 0; i < lines.length; i++) {
    if (!drop[i] || (i > 0 && drop[i - 1])) continue;
    const prev = i - 1;
    if (prev >= 0 && !drop[prev] && lines[prev].trimEnd().endsWith(":")) {
      drop[prev] = true;
    }
  }

  // A blank line is only ever a cleanup candidate when a direct neighbor was
  // dropped; a blank run with nothing removed next to it (e.g. inside an
  // untouched quoted code block elsewhere in the message) is never touched.
  const blankTouchesDrop = (i: number) =>
    (i > 0 && drop[i - 1]) || (i + 1 < lines.length && drop[i + 1]);

  const keptIdx: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (drop[i]) continue;
    if (lines[i].trim() === "" && blankTouchesDrop(i)) {
      const prevIdx = keptIdx[keptIdx.length - 1];
      const prevIsBlank = prevIdx === undefined || lines[prevIdx].trim() === "";
      if (prevIsBlank) continue;
    }
    keptIdx.push(i);
  }
  while (keptIdx.length) {
    const lastIdx = keptIdx[keptIdx.length - 1];
    if (lines[lastIdx].trim() !== "" || !blankTouchesDrop(lastIdx)) break;
    keptIdx.pop();
  }

  return keptIdx.map((i) => lines[i]).join("\n");
}

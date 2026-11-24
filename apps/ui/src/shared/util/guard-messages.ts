/**
 * User-facing rewrites for opencode plugin tool-guard errors.
 *
 * The guard plugins under `sandbox/agent_config/profiles/<profile>/plugins/` block
 * a tool call by throwing, and opencode surfaces the thrown text as the tool part's
 * `state.error`. That text is model steering: it names internal subagents, exact
 * tool-call arguments and routing rules.
 *
 * It reaches the user two ways. A model asked to "show the error" quotes it
 * back into an assistant text part (#1762). A thrown tool also stores it on
 * `state.error` and leaves `output` empty; the Activity row shows that text
 * when the failed step is open. Both surfaces run this sanitizer first, so a
 * guard's internal routing is replaced before it is painted.
 *
 * Detection is shape-based rather than a list of known messages, so a new guard
 * that uses an existing shape needs no change here. It is deliberately not a
 * catch-all for internal steering text: recognizing arbitrary steering prose
 * misfires on the model's ordinary answers, which is worse than the leak.
 *
 * The upper-case opener is the whole of the signal. Of the 44 distinct payloads
 * the shipped plugins throw across the three profiles, every safety-rule guard
 * announces itself on its first line with `BLOCKED:`
 * (`90_superclaw_default_tool_guard`, `93_protected_pipeline_terminal_guard`),
 * `CANCELLED:`, or `DENIED by <guard-name>:` (`01_projects_delete_guard`,
 * `08_protected_pipeline_confirm_guard`) — 23 payloads in all.
 *
 * A guard's `Required next action:` line is deliberately NOT a signal on its own,
 * even though every guard carries one. It is equally the shape of the limit
 * guards, and the only shipped payload it caught that an opener did not was
 * `93_protected_pipeline_terminal_guard`'s file-too-large stop:
 *
 *     The protected file pipeline failed because the source file is too large; …
 *     Required next action: report the failure to the user and ask them to retry …
 *
 * Rewriting that one destroys the only thing the user needed — that their file
 * was too big — and mislabels a capacity failure as a safety rule. Since a guard
 * quoted without its opener has exactly this shape, no rule here can separate the
 * two, so the opener is required and the tail-only quote is left to the prompt
 * rule, which forbids quoting any of it in the first place. The line is still
 * read as a *continuation* of a run whose opener was already found, which is a
 * different question and safe to answer: see `GUARD_CONTINUATION_RE`.
 *
 * Out of scope for the same "the copy would misdescribe it" reason: the limit
 * guards opening on a lower-case `blocked:` indistinguishable from ordinary
 * English (`93_superclaw_repeat_command_guard`, `93_hybrid_dr_terminal_guard`,
 * `94_superclaw_read_output_cap`'s `read blocked:`), budget exhaustion
 * (`STEP`/`CROSS-SESSION BUDGET EXHAUSTED`), and the five "you have ALREADY done
 * this" / "could not be verified" payloads in
 * `93_protected_pipeline_terminal_guard` and `90_superclaw_default_tool_guard`.
 * Those five do name internal agents, but they report a repetition or a failed
 * verification, and one of them is a result the user is owed
 * ("Protected-file analysis could not be verified"), so routing them here would
 * repeat exactly the mislabelling described above. They need their own copy.
 *
 * The plugin contract is untouched; this is presentation only.
 */

/**
 * Opening marker of a guard error, anywhere in the line — the guards throw it
 * first, but a model asked to "show the error" also inlines it mid-sentence
 * ("The exact error was BLOCKED: ..."), and markdown quote/bullet decoration can
 * precede it. One unanchored test covers all three.
 *
 * Case-SENSITIVE on purpose: the guards shout their opener, and requiring the
 * capitals is what keeps this off ordinary prose, where the lower-case words are
 * ordinary English ("the port was blocked: check the firewall", "- Blocked:
 * waiting on review" in a status list). Because a run is every consecutive
 * non-blank line, one such line would have replaced a whole list. The trailing
 * colon is required, so prose merely opening on the word does not match; the word
 * boundary keeps this off deliberately user-facing codes like SEARCH_BLOCKED.
 */
const GUARD_OPENER_RE = /\b(?:BLOCKED|CANCELLED|DENIED by [\w-]+)\s*:/;

/** Same opener `sanitizeGuardErrors` rewrites — for step-tone, not copy. */
export function isGuardErrorText(text: string): boolean {
  return GUARD_OPENER_RE.test(text);
}

/**
 * Cheap whole-text pre-check, so a message with no guard text is not re-chunked
 * on every stream event. Case-sensitive like the matcher it stands in for, of
 * which it must stay a superset: "blocked" and "cancelled" are common enough in
 * ordinary answers that a case-insensitive pre-check would put most messages on
 * the slow path.
 */
const GUARD_OPENER_MARKER_RE = /BLOCKED|CANCELLED|DENIED by/;

/**
 * A guard's routing line, matched only to extend a run whose opener was already
 * found. The guards throw one paragraph, but a model retelling it reflows the
 * quote, and a blank line before `Required next action:` splits it in two: the
 * opener half is replaced and the half naming the subagent and its arguments —
 * the part actually worth hiding — survives.
 *
 * Requiring a preceding guard is what makes this safe where a standalone match
 * is not. The file-too-large stop carries this line but no opener anywhere, so
 * it is still left alone, and prose that opens on these words is only ever
 * absorbed when it directly follows a guard.
 */
const GUARD_CONTINUATION_RE = /^[ \t>*\-]*Required next action\b/m;

/** A ``` line, which opens or closes a fenced block. */
const FENCE_RE = /^\s*```/;

const GUARD_FRIENDLY =
  "Blocked by a SuperClaw safety rule. The internal rule details are not shown here.";

/**
 * Replace any tool-guard error in `text` with its user-facing copy.
 *
 * A guard error is a run of consecutive non-blank lines containing at least one
 * guard line. The whole run is replaced, not just the matching lines: the run is
 * how the model wraps a quoted guard error (an introducing sentence, a code
 * fence, the guard text, the closing fence), and leaving those fragments behind
 * reads as a truncated error rather than a handled one.
 *
 * A colon-terminated run immediately before a guard block is that block's
 * introduction, so it goes too. Observed on the real repro: the model wrote
 * "The system blocked the request with this internal routing error (do not
 * copy/quote this text back to the user):" — keeping it both dangles and tells
 * the user there is a hidden instruction it just ignored.
 *
 * Two things keep a blank line from cutting a quote in half and letting the tail
 * through: a fenced block is one run however it is spaced inside, and a run whose
 * opener was already found extends over a following `Required next action:`
 * paragraph. Neither covers a quote reflowed unfenced into a paragraph per line,
 * where the middle paragraphs carry no marker at all and are indistinguishable
 * from the model's own prose; the prompt rule is what covers that shape.
 */
export function sanitizeGuardErrors(text: string): string {
  if (!text) return text;
  if (!GUARD_OPENER_MARKER_RE.test(text)) return text;

  type Chunk = { text: string; blank: boolean; guard: boolean };
  const chunks: Chunk[] = [];
  let run: string[] = [];
  let runHasGuardLine = false;

  const flushRun = (): void => {
    if (run.length === 0) return;
    chunks.push({
      text: runHasGuardLine ? GUARD_FRIENDLY : run.join("\n"),
      blank: false,
      guard: runHasGuardLine,
    });
    run = [];
    runHasGuardLine = false;
  };

  let inFence = false;
  for (const line of text.split("\n")) {
    const isFence = FENCE_RE.test(line);
    if (isFence) inFence = !inFence;
    if (!inFence && !isFence && line.trim() === "") {
      flushRun();
      chunks.push({ text: line, blank: true, guard: false });
      continue;
    }
    run.push(line);
    runHasGuardLine ||= GUARD_OPENER_RE.test(line);
  }
  flushRun();

  const dropped = new Set<number>();

  // A reflowed quote can put the guard's routing line in its own paragraph. That
  // paragraph is the tail of the notice already emitted above it, so it is
  // dropped rather than replaced, which would print the notice twice.
  let guardEnd = -1;
  chunks.forEach((chunk, i) => {
    if (chunk.blank) return;
    if (chunk.guard) {
      guardEnd = i;
      return;
    }
    if (guardEnd >= 0 && GUARD_CONTINUATION_RE.test(chunk.text)) {
      for (let k = guardEnd + 1; k <= i; k++) dropped.add(k);
      guardEnd = i;
      return;
    }
    guardEnd = -1;
  });

  chunks.forEach((chunk, i) => {
    if (!chunk.guard) return;
    let j = i - 1;
    while (j >= 0 && chunks[j].blank) j--;
    if (j < 0 || !chunks[j].text.trimEnd().endsWith(":")) return;
    for (let k = j; k < i; k++) dropped.add(k);
  });

  return chunks
    .filter((_, i) => !dropped.has(i))
    .map((chunk) => chunk.text)
    .join("\n");
}

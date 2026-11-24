/**
 * hybrid_dr_terminal_guard — don't re-run an already-COMPLETED hybrid deep
 * research in the same turn.
 *
 * The hybrid-deep-research root agent is a thin dispatcher: per user turn it
 * calls hybrid_dr_post_polish_processor, then emits one status line and stops
 * (see prompts/hybrid-dr-sidecar-primary.txt). The tool is async/resumable —
 * one call polls the sidecar for up to 8 min and returns a terminal envelope
 * ("ok" / "cancelled"), a non-terminal "running", or throws on a real/transient
 * error. A LATER call resumes the SAME sidecar run.
 *
 * Weak on-device driver models (the agent's `llmrouter/cloud-model` falls back
 * to the local ~35B model when no cloud is configured) ignore the "emit one
 * line and stop" contract and re-fire the tool AFTER it already returned "ok".
 * Each re-fire burns one of the agent's opencode `steps`; once the budget is
 * spent opencode forces a text-only turn end reported as "Max tool call
 * reached" — surfaced to the user as a failure even though the FIRST call
 * already published the report (issue #1576).
 *
 * This guard blocks ONLY the wasteful case — re-calling a run that already
 * reached a terminal status ("ok" / "cancelled" / "error") in this turn —
 * mirroring 93_protected_pipeline_terminal_guard's terminal gate:
 *   - tool.execute.after: fires on SUCCESSFUL returns only (opencode has no
 *     error hook — see anomalyco/opencode#10027). Mark the turn terminal ONLY
 *     when the returned status is "ok", "cancelled", or "error" (the last is a
 *     PERMANENT-failure envelope the tool returns instead of throwing).
 *   - tool.execute.before: once the turn is terminal, block further
 *     hybrid_dr_post_polish_processor calls with a status-aware directive to
 *     emit the correct one-line reply and stop.
 *   - chat.params: reset per-turn state at each new user message (so a genuine
 *     follow-up / cross-turn resume works), and inject a stop reminder once the
 *     run is terminal this turn.
 *   - experimental.chat.messages.transform: inject the SAME stop reminder into
 *     the outgoing message array once the run is terminal this turn. Unlike
 *     chat.params — whose `output` on opencode 1.17.11 exposes only sampling
 *     params ({temperature,topP,topK,maxOutputTokens,options}) and NOT
 *     `messages`, so appending there never reaches the model (verified against
 *     the container's llm-input.log: the injected reminder never appeared and
 *     messageCount never gained the extra entry) — this hook's `output.messages`
 *     IS the array sent to the LLM (it is where 52_superclaw_llm_logger records
 *     the prompt). Both hooks are kept: chat.params is a harmless no-op on
 *     versions without `messages`, and a live steer on any version that adds it.
 *   - event(session.idle): defensive cleanup at the turn boundary.
 *
 * RETRIES ARE NOT LIMITED. A thrown call never reaches tool.execute.after, so
 * the terminal flag is never set and the model may retry / resume freely. A
 * "running" result is non-terminal, so polling the same run again is allowed.
 * Runaway error-retry or poll loops remain bounded by the agent's `steps` and
 * the 91_step_horizon / 92_lineage_budget guards, exactly as before this guard.
 */
import type { Plugin } from "@opencode-ai/plugin";

const DR_TOOL = "hybrid_dr_post_polish_processor";
// "error" is a PERMANENT-failure envelope the tool returns (not a throw) for
// misconfiguration / a deterministically-failed run — treat it as terminal so a
// weak driver model can't re-call the tool into the same failure until Max Steps
// (issue #1633). Transient failures still throw and stay retryable (see below).
const TERMINAL_STATUSES = new Set(["ok", "cancelled", "error"]);

// Per-turn state, keyed by sessionID and reset at each new user turn.
const currentTurn = new Map<string, string>(); // sessionID -> latest user message id
const terminalStatus = new Map<string, string>(); // sessionID -> "ok" | "cancelled" this turn
const tripped = new Set<string>(); // sessionID -> already blocked once this turn

function asRecord(value: unknown): Record<string, any> | undefined {
  if (!value || typeof value !== "object") return undefined;
  return value as Record<string, any>;
}

/** Latest user-message id in the outgoing message list — our turn identity. */
function latestUserMessageID(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = asRecord(messages[i]);
    const info = asRecord(msg?.info);
    const role = info?.role ?? msg?.role;
    if (role !== "user") continue;
    const id = info?.id ?? msg?.id;
    if (typeof id === "string" && id) return id;
  }
  return undefined;
}

/** Parse the `status` field out of the tool's JSON result string. */
function parseStatus(output: unknown): string | undefined {
  const raw =
    typeof (output as any)?.output === "string"
      ? (output as any).output
      : typeof output === "string"
        ? output
        : "";
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    const status = asRecord(parsed)?.status;
    return typeof status === "string" ? status : undefined;
  } catch {
    return undefined;
  }
}

/** The single line the prompt requires for each terminal status. */
function replyLineFor(status: string | undefined): string | null {
  switch (status) {
    case "ok":
      return "Research complete. See the report panel below.";
    case "cancelled":
      return "Hybrid Deep Research was cancelled.";
    default:
      return null;
  }
}

function resetTurn(sessionID: string): void {
  terminalStatus.delete(sessionID);
  tripped.delete(sessionID);
}

/**
 * The stop reminder injected once this turn's run is terminal. Shared verbatim
 * by chat.params and experimental.chat.messages.transform so the two hooks
 * never disagree.
 */
function stopReminderText(line: string): string {
  return (
    "Hybrid deep research already finished in this turn and the report panel is rendered. " +
    "Do NOT call hybrid_dr_post_polish_processor again now — a re-call cannot change the outcome " +
    "within the same turn (the run resumes across later turns, not within one). Reply with EXACTLY " +
    "this line and nothing else, then stop:\n" +
    line
  );
}

// Tag stamped on the synthetic reminder we inject, so a later transform pass can
// recognise its own prior injection and stay idempotent.
const GUARD_TAG = "hybrid-dr-terminal-guard";
// Stable prefix of stopReminderText() — used to spot a chat.params-shaped
// ({ role, content }) reminder we may have injected on a version that DOES
// surface chat.params `messages`.
const REMINDER_PREFIX = "Hybrid deep research already finished in this turn";

/**
 * True when the outgoing message array ALREADY contains a stop reminder this
 * guard injected. Idempotency guard: if opencode persists a transform-appended
 * message back into the session history, the next request would otherwise get
 * a second (third, …) copy. We scan the WHOLE array — not just the last entry —
 * because a persisted reminder is followed by the model's reply/tool parts, so
 * our injection is not necessarily last. Matches both message shapes we emit:
 * the transform shape (info.synthetic === GUARD_TAG) and the chat.params shape
 * (role "system" whose content starts with REMINDER_PREFIX).
 */
function hasGuardReminder(messages: unknown): boolean {
  if (!Array.isArray(messages)) return false;
  return messages.some((raw) => {
    const msg = asRecord(raw);
    if (!msg) return false;
    if (asRecord(msg.info)?.synthetic === GUARD_TAG) return true;
    const role = msg.role ?? asRecord(msg.info)?.role;
    return role === "system" && typeof msg.content === "string" && msg.content.startsWith(REMINDER_PREFIX);
  });
}

export const HybridDrTerminalGuard: Plugin = async ({ client }) => {
  await client.app.log({
    body: {
      service: "hybrid-dr-terminal-guard",
      level: "info",
      message: `Plugin initialised — blocks re-calling a completed ${DR_TOOL} within a turn (retries/polls unaffected)`,
    },
  });

  return {
    /**
     * chat.params — fires before every LLM request.
     *   1. Detect a new user turn (latest user message id changed) and reset
     *      per-turn state so a follow-up / resume request works normally.
     *   2. Once this turn's run is terminal, inject a system reminder steering
     *      the model to emit the required line rather than re-call.
     */
    "chat.params": async (input: any, output: any) => {
      const sid = input?.sessionID;
      if (typeof sid !== "string" || !sid) return;

      const turnId = latestUserMessageID(output?.messages);
      if (turnId && currentTurn.get(sid) !== turnId) {
        currentTurn.set(sid, turnId);
        resetTurn(sid);
      }

      const status = terminalStatus.get(sid);
      if (!status) return;
      const line = replyLineFor(status);
      if (!line) return;
      const reminder = {
        role: "system",
        content: stopReminderText(line),
      };
      if (output && typeof output === "object") {
        if (hasGuardReminder(output.messages)) return; // idempotent: don't stack copies
        output.messages = Array.isArray(output.messages)
          ? [...output.messages, reminder]
          : [reminder];
      }
    },

    /**
     * experimental.chat.messages.transform — fires before each LLM request with
     * the FULL outgoing message array (the array actually sent to the model,
     * and where 52_superclaw_llm_logger records the prompt). Once this turn's
     * run is terminal, append the SAME stop reminder as a synthetic user message
     * so a weak driver model is steered to emit the one-line reply and stop
     * instead of burning steps re-calling the tool. This is the effective twin
     * of the chat.params injection above (which is a no-op on opencode versions
     * whose chat.params `output` has no `messages` field, e.g. 1.17.11).
     */
    "experimental.chat.messages.transform": async (_input: any, output: any) => {
      const messages = output?.messages;
      if (!Array.isArray(messages) || messages.length === 0) return;

      const sid: string | undefined = messages[messages.length - 1]?.info?.sessionID;
      if (typeof sid !== "string" || !sid) return;

      const status = terminalStatus.get(sid);
      if (!status) return;
      const line = replyLineFor(status);
      if (!line) return;

      // Idempotent: if opencode persisted a prior transform injection back into
      // the history, do not append another copy (scans the whole array, since a
      // persisted reminder is followed by later model/tool messages).
      if (hasGuardReminder(messages)) return;

      // Match the message shape opencode uses ({ info, parts:[{type:"text"}] }).
      // A synthetic user turn appended last carries the strongest steering
      // weight for a weak driver model.
      const reminderMessage = {
        info: {
          role: "user",
          sessionID: sid,
          synthetic: GUARD_TAG,
        },
        parts: [{ type: "text", text: stopReminderText(line) }],
      };
      output.messages = [...messages, reminderMessage];
    },

    /**
     * tool.execute.before — block re-calling the tool only after this turn's
     * run already reached a terminal status. Throws (transient errors) and
     * "running" polls fall through untouched, so retries/resumes are preserved.
     */
    "tool.execute.before": async (input: any) => {
      if (input == null || input.tool !== DR_TOOL) return;
      const sid = input.sessionID;
      const status = terminalStatus.get(sid);
      if (!status) return; // first call, a retry after a throw, or a running poll — allow.

      const line = replyLineFor(status);
      const directive = line
        ? `blocked: hybrid_dr_post_polish_processor already reached a terminal status "${status}" in this turn. ` +
          `Do NOT call it again now — the run is finished and resumes across later turns, not within one, so a ` +
          `re-call cannot change the result here. Reply with EXACTLY this line and nothing else, then stop:\n\n    ${line}`
        : `blocked: hybrid_dr_post_polish_processor already reached a terminal status "${status}" in this turn. ` +
          `Do NOT call it again now. Emit the tool's message for that status (for an error, the error message it ` +
          `returned) on one line, then stop.`;

      if (!tripped.has(sid)) {
        tripped.add(sid);
        await client.app.log({
          body: {
            service: "hybrid-dr-terminal-guard",
            level: "warn",
            message: `Short-circuited re-call of completed ${DR_TOOL} in sessionID=...${sid.slice(-12)} (status=${status}) — tool returns cached result, no re-run, no error`,
          },
        });
      }
      // PRE-VERIFY, do NOT throw (issue #1633): throwing here surfaced as
      // red TOOL_ERROR dots in the UI. The tool now pre-verifies an
      // already-terminal resumed run and returns the SAME cached "ok"
      // envelope fast (no wasteful re-run), so a post-terminal re-call
      // resolves as a SUCCESS. The chat.params reminder still steers the
      // model to emit the one-line reply and stop.
      void directive;
      return;
    },

    /**
     * tool.execute.after — runs on SUCCESSFUL returns only (no error hook in
     * opencode). Mark the turn terminal ONLY for a completed run so retries
     * after a throw and polls after "running" stay allowed.
     */
    "tool.execute.after": async (input: any, output: any) => {
      if (input == null || input.tool !== DR_TOOL) return;
      const status = parseStatus(output);
      if (status && TERMINAL_STATUSES.has(status)) {
        terminalStatus.set(input.sessionID, status);
      }
    },

    /**
     * event(session.idle) — turn boundary. Defensive cleanup in case a turn
     * ended without a following chat.params reset.
     */
    event: async (input: any) => {
      const e = input?.event as any;
      if (e?.type !== "session.idle") return;
      const sid = e?.properties?.sessionID;
      if (typeof sid === "string" && sid) {
        resetTurn(sid);
        currentTurn.delete(sid);
      }
    },
  };
};

// PATCH plugin-export-form: opencode SDK expects a direct function as default export.
export default HybridDrTerminalGuard;

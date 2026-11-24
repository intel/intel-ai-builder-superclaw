/**
 * superclaw_lineage_budget — cross-session step budget. Complements
 * plugin 91 (per-session budget) for the case where the parent agent
 * repeatedly spawns fresh subagent sessions to escape its per-session
 * cap, accumulating unbounded total work.
 *
 * Strategy:
 *   1. Listen on the `event` hook for `session.created`. Each event
 *      carries `info.id` (child) and `info.parentID` (parent or "").
 *      Build a child -> parent map.
 *   2. Track the active root-session user turn from chat messages. A
 *      subagent inherits the parent session's active turn when it is
 *      created.
 *   3. On `tool.execute.before`, walk parents up to the root session
 *      and bump that root+turn cumulative tool-call counter. Three tiers
 *      apply as the counter climbs: a non-blocking countdown appended to
 *      tool output starting at LINEAGE_SOFT_WARN_AT, a hard block on
 *      non-deliverable tools starting at LINEAGE_WRITE_ONLY_AT (=
 *      LINEAGE_BUDGET minus LINEAGE_WRITE_RESERVE, `write`/`edit`/`patch`
 *      still pass), and a final tier once the counter exceeds
 *      LINEAGE_BUDGET itself where every tool — including `write`/`edit`/
 *      `patch` — is rejected, forcing a plain-text final answer with no
 *      further tool calls of any kind.
 *
 * Historical 25-call eval threshold picked from iter-5 subset traces:
 *   - row 13 (clean pass): ~10 cumulative tool calls across lineage
 *   - row 18 (clean pass after iter-5): ~25 cumulative
 *   - row 5 (write-loop): >60 with per-session-budget-only enforcement
 * Those traces motivated the historical eval guardrail, not the current
 * 250-call fallback. Eval runs needing that guardrail must pin it explicitly.
 *
 * See FINDINGS.md F-007.
 */
import type { Plugin } from "@opencode-ai/plugin";

// The fallback is 250; the installed native runtime also injects 250 through
// SUPERCLAW_LINEAGE_BUDGET. Pin 25 explicitly for the historical eval guardrail.
// The interactive allowance should stay >=
// SUPERCLAW_STEP_BUDGET x expected subagent fan-out or coding sessions trip
// the lineage cap right after clearing the per-session one.
const LINEAGE_BUDGET = Number(process.env.SUPERCLAW_LINEAGE_BUDGET ?? "") || 250;

// Mirrors 91_superclaw_step_horizon.ts's SH_DELIVERABLE_TOOLS: once the budget is
// exhausted, still let the model save whatever it already found instead of losing
// the deliverable outright.
const LB_DELIVERABLE_TOOLS = new Set(["write", "edit", "patch"]);

// Hard-block threshold: past this call count, tool.execute.before rejects every
// non-deliverable tool outright (write/edit/patch still pass). This is a real
// block, not a message — the model cannot keep investigating past this point.
const LINEAGE_WRITE_RESERVE = Number(process.env.SUPERCLAW_LINEAGE_WRITE_RESERVE ?? "") || 2;
const LINEAGE_WRITE_ONLY_AT = Math.max(0, LINEAGE_BUDGET - LINEAGE_WRITE_RESERVE);

// Non-blocking early countdown, mirroring 92_superclaw_file_read_budget.ts's
// FRB_WARN_AT: appended to a tool's own successful output once the lineage is
// within this many calls of LINEAGE_BUDGET, so the model gets advance notice
// well before anything is actually rejected.
const LINEAGE_SOFT_WARN_RESERVE = Number(process.env.SUPERCLAW_LINEAGE_SOFT_WARN_RESERVE ?? "") || 5;
const LINEAGE_SOFT_WARN_AT = Math.max(0, LINEAGE_BUDGET - LINEAGE_SOFT_WARN_RESERVE);

const parentOf = new Map<string, string>();
const lineageCount = new Map<string, number>();
const trippedLineages = new Set<string>();
const activeTurnOfRoot = new Map<string, string>();
const turnOfSession = new Map<string, string>();

function getRoot(sid: string): string {
  let cur = sid;
  // Bounded walk to defend against accidental cycles.
  for (let i = 0; i < 64; i++) {
    const p = parentOf.get(cur);
    if (!p) return cur;
    cur = p;
  }
  return cur;
}

function asRecord(value: unknown): Record<string, any> | undefined {
  if (!value || typeof value !== "object") return undefined;
  return value as Record<string, any>;
}

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

function getBudgetKey(sessionID: string): { key: string; root: string; turn: string } {
  const root = getRoot(sessionID);
  const turn =
    turnOfSession.get(sessionID) ??
    activeTurnOfRoot.get(root) ??
    `session:${root}`;
  return { key: `${root}:${turn}`, root, turn };
}

export const SuperclawLineageBudget: Plugin = async ({ client }) => {
  await client.app.log({
    body: {
      service: "superclaw-lineage-budget",
      level: "info",
      message: `Plugin initialised; cross-session lineage budget=${LINEAGE_BUDGET}`,
    },
  });

  return {
    event: async (input) => {
      const e = input.event as any;
      if (e?.type !== "session.created") return;
      const info = e?.properties?.info ?? {};
      const sid = info.id;
      const parent = info.parentID;
      if (typeof sid === "string" && sid && typeof parent === "string" && parent) {
        parentOf.set(sid, parent);
        const parentTurn = turnOfSession.get(parent) ?? activeTurnOfRoot.get(getRoot(parent));
        if (parentTurn) turnOfSession.set(sid, parentTurn);
      }
    },

    "experimental.chat.messages.transform": async (_input, output) => {
      const messages = (output as any)?.messages;
      const turn = latestUserMessageID(messages);
      if (!turn) return;

      const last = Array.isArray(messages) ? asRecord(messages[messages.length - 1]) : undefined;
      const sessionID = asRecord(last?.info)?.sessionID;
      if (typeof sessionID !== "string" || !sessionID) return;

      const root = getRoot(sessionID);
      if (root !== sessionID && turnOfSession.has(sessionID)) return;

      activeTurnOfRoot.set(root, turn);
      turnOfSession.set(sessionID, turn);
    },

    "tool.execute.before": async (input) => {
      const { key, root, turn } = getBudgetKey(input.sessionID);

      const n = (lineageCount.get(key) ?? 0) + 1;
      lineageCount.set(key, n);

      // Below LINEAGE_WRITE_ONLY_AT: no restriction at all (soft warning, if any,
      // is a non-blocking message appended in tool.execute.after).
      if (n <= LINEAGE_WRITE_ONLY_AT) return;

      if (n <= LINEAGE_BUDGET) {
        // Hard tier: only deliverable tools pass. Every other tool is rejected
        // outright (not just warned) so the model can't keep investigating.
        if (LB_DELIVERABLE_TOOLS.has(input.tool)) return;
        throw new Error(
          `LINEAGE BUDGET NEARLY EXHAUSTED: ${LINEAGE_BUDGET - n + 1} call(s) remain across ` +
            `this request's session lineage. Stop investigating immediately — do not call ` +
            `search, read, grep, bash, or other exploratory tools (these are rejected from ` +
            `here on). Required next action: finalize using the information you already have. ` +
            `Use your remaining call(s) only for the final answer or a required ` +
            `write/edit/patch operation.`,
        );
      }

      // Final tier: LINEAGE_BUDGET itself is exceeded. No exemptions at all —
      // including write/edit/patch. The model already had a full hard-block window
      // to save its work; this tier exists to force a plain-text final answer with
      // no further tool calls of any kind.
      if (trippedLineages.has(key)) {
        throw new Error(
          `LINEAGE BUDGET ALREADY EXHAUSTED (call #${n} across this request's session lineage). ` +
            `No further tool calls of any kind — including write/edit/patch — will run. ` +
            `Provide your final answer as plain text now.`,
        );
      }
      trippedLineages.add(key);

      await client.app.log({
        body: {
          service: "superclaw-lineage-budget",
          level: "warn",
          message: `Lineage budget exhausted root=...${root.slice(-12)} turn=...${turn.slice(-12)} at call #${n} (tool=${input.tool}, sessionID=...${input.sessionID.slice(-12)}, callID=${input.callID.slice(0, 10)})`,
        },
      });

      throw new Error(
        `MAXIMUM STEPS REACHED: this request's session tree has fired ${n - 1} tool calls in ` +
          `total across the parent and all spawned subagents. The investigation and ` +
          `finalization phases are both now closed — do not call search, read, grep, bash, ` +
          `write, edit, patch, or any other tool: all tool calls are rejected from here on. ` +
          `Required next action: use the information already collected to produce the best ` +
          `possible final answer as plain text now. If a file was required but never saved, ` +
          `say so explicitly. Do not attempt any more tool calls, and do not spawn more ` +
          `subagents.`,
      );
    },

    "tool.execute.after": async (input, output) => {
      const { key } = getBudgetKey(input.sessionID);
      const n = lineageCount.get(key) ?? 0;

      const out = output as { output?: string };
      if (typeof out?.output !== "string") return;

      // Soft-warning band: non-blocking countdown for any tool.
      if (n >= LINEAGE_SOFT_WARN_AT && n <= LINEAGE_WRITE_ONLY_AT) {
        out.output +=
          `\n[LINEAGE BUDGET: ${n} of ${LINEAGE_BUDGET} calls used across the parent and all ` +
          `spawned subagents — ${LINEAGE_BUDGET - n} remaining. Tool-step budget is running low. ` +
          `Avoid unnecessary tool calls (read/search/grep/bash) or new investigations. Review the ` +
          `information you already have and focus on completing the task. If you have enough ` +
          `information, proceed to your final answer or write the requested output now.]`;
        return;
      }

      // Hard tier: only write/edit/patch can ever reach this hook here (every other
      // tool already threw in tool.execute.before), so this only fires on a
      // successful deliverable call — otherwise it would run silently with no
      // feedback at all on whether the call was actually needed.
      if (n > LINEAGE_WRITE_ONLY_AT && n <= LINEAGE_BUDGET) {
        out.output +=
          `\n[LINEAGE BUDGET: ${n} of ${LINEAGE_BUDGET} calls used across the parent and all ` +
          `spawned subagents — ${LINEAGE_BUDGET - n + 1} call(s) remain, reserved for finalizing. ` +
          `You have write/edit/patch available. Based on the information you already collected, ` +
          `check whether you still need to call these tools again — avoid unnecessary further ` +
          `edits or writes. If you already have enough, generate your final answer now.]`;
      }
    },
  };
};

// PATCH plugin-export-form: opencode SDK expects a direct function as default export.
export default SuperclawLineageBudget;

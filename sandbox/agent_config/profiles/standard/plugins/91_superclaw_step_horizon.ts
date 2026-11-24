/**
 * superclaw_step_horizon — per-turn tool-call budget. Forces graceful
 * termination when a single user turn keeps firing tool calls without
 * converging, instead of letting the eval hit the 600 s wall-clock wall.
 *
 * Applies to every session (parent and subagent) uniformly. The budget is
 * scoped to the active user turn: it resets on each new user message so a
 * follow-up interaction re-arms the full allowance (issue #1578). When a
 * session exceeds STEP_BUDGET unique tool calls within one turn, the next
 * `tool.execute.before` for that session+turn throws a machine-shaped
 * directive that tells the model to emit a final partial answer and stop.
 *
 * Turn tracking mirrors plugin 92 (lineage budget): the active turn is the
 * latest user message id, learned from `experimental.chat.messages.transform`,
 * and subagents inherit their parent session's active turn on `session.created`.
 * The user messages a compaction adds do not start a turn: opencode keeps
 * counting `steps` through a compaction, so the budget must too.
 *
 * Budgets are per-agent (SH_AGENT_BUDGET_SPECS) so this guard can trip BEFORE
 * opencode's own per-agent `steps` cap. When `steps` is the lower of the two,
 * opencode wins and the turn dies with a hard tools-disabled cutoff instead of
 * this plugin's directive. Past the horizon, write/edit/patch stay allowed so a
 * requested file can still be produced from what was already gathered.
 *
 * Each budget is the agent's live `steps` cap (from the opencode config) minus a
 * small reserve. A fixed number drifts from the profile: standard raised
 * superclaw-default to steps:60 (#3557) while this budget stayed 25, so every
 * call from 26 to 60 was blocked one at a time before opencode ended the turn.
 *
 * See FINDINGS.md F-007 — framework primitive #3.
 */
import type { Plugin } from "@opencode-ai/plugin";

// The fallback is 100; the installed native runtime also injects 100 through
// SUPERCLAW_STEP_BUDGET. Eval runs requiring the historical 20-call guardrail
// must pin that environment variable explicitly.
// Real coding sessions need far more than 20 calls (2026-06-12 dogfood:
// exploration alone used ~15), and this cap trips BEFORE opencode's own
// per-agent `steps` config — raising `steps` alone does nothing while this
// plugin fires first.
const STEP_BUDGET = Number(process.env.SUPERCLAW_STEP_BUDGET ?? "") || 100;

// Per-agent budgets. opencode's own `steps` cap fires first whenever it is
// lower than STEP_BUDGET (the container exports 100 while local-file-agent
// ships steps:30), which ends the turn with a hard tools-disabled cutoff and no
// chance to write the requested file. Each budget is the agent's `steps` minus
// `reserve`, so this plugin trips first and leaves room to finish the
// deliverable. `fallback` applies when the config cannot be read; the env
// variable pins the budget.
const SH_AGENT_BUDGET_SPECS: Record<string, { env: string; reserve: number; fallback: number }> = {
  // 5 calls held back for writing the deliverable.
  "local-file-agent": { env: "SUPERCLAW_STEP_BUDGET_LOCAL_FILE_AGENT", reserve: 5, fallback: 25 },
  // 5 calls held back for writing the deliverable. Previously had no override and rode the ambiguous
  // global STEP_BUDGET default (20 in eval, 100 in production).
  "superclaw-default": { env: "SUPERCLAW_STEP_BUDGET_DEFAULT", reserve: 5, fallback: 25 },
  // No write/edit/patch tool on this agent, so this is a grace buffer, not a deliverable reserve. pro
  // profile only; unused (harmless) on profiles that don't define this agent.
  "websearch-agent": { env: "SUPERCLAW_STEP_BUDGET_WEBSEARCH_AGENT", reserve: 3, fallback: 17 },
  // 10 calls held back for committing/finishing a coding task (write/edit/patch, git operations).
  "build": { env: "SUPERCLAW_STEP_BUDGET_BUILD", reserve: 10, fallback: 90 },
  // A fixed 4-step workflow that hands its deliverable to `build`, so no write/edit here; this is a grace
  // buffer, not a deliverable reserve.
  "protected-file-agent": { env: "SUPERCLAW_STEP_BUDGET_PROTECTED_FILE_AGENT", reserve: 4, fallback: 16 },
  // pro profile only. email_send/schedule_meeting are not exempt past the budget.
  "email-agent": { env: "SUPERCLAW_STEP_BUDGET_EMAIL_AGENT", reserve: 5, fallback: 25 },
};

// Env-pinned budgets, read once like STEP_BUDGET.
const SH_PINNED_BUDGETS: Record<string, number> = {};
for (const [agent, spec] of Object.entries(SH_AGENT_BUDGET_SPECS)) {
  const pinned = Number(process.env[spec.env] ?? "");
  if (pinned > 0) SH_PINNED_BUDGETS[agent] = pinned;
}

// The budget each agent gets when its `steps` cap is unknown; logged at init.
const SH_AGENT_STEP_BUDGETS: Record<string, number> = Object.fromEntries(
  Object.entries(SH_AGENT_BUDGET_SPECS).map(([agent, spec]) => [agent, SH_PINNED_BUDGETS[agent] ?? spec.fallback]),
);

// A config read that does not answer in time leaves the fallback budgets in place.
const SH_CONFIG_TIMEOUT_MS = 2000;

// Deliverable tools stay allowed past the horizon: the failure this guard
// exists to prevent is dying with the analysis done but the file never written.
const SH_DELIVERABLE_TOOLS = new Set(["write", "edit", "patch"]);

// Soft-warning tier: append a non-blocking countdown once a session is within
// SH_WARN_RATIO of its own budget, so the model gets advance notice instead of
// only discovering the cutoff by tripping it. tool.execute.before can only
// allow or throw, so a genuinely non-blocking notice needs a separate
// tool.execute.after hook — mirrors 92_superclaw_lineage_budget.ts's soft tier.
const SH_WARN_RATIO = Number(process.env.SUPERCLAW_STEP_WARN_RATIO ?? "") || 0.8;

// SUPERCLAW_STEP_STATUS: `late` (default) is the countdown above and nothing else; `off` drops it;
// `every` replaces it with a one-line status (step, trail, loop, written files) on every result.
type ShStatusMode = "off" | "late" | "every";
function shStatusMode(): ShStatusMode {
  const raw = (process.env.SUPERCLAW_STEP_STATUS ?? "").trim().toLowerCase();
  return raw === "off" || raw === "every" ? raw : "late";
}

// The status line is not appended to output that another plugin or the UI parses (the protected
// pipeline guard JSON.parses its result), nor to a value the model copies (parse_pdf returns a path).
const SH_STATUS_SKIP_TOOLS = new Set([
  "run_protected_file_pipeline",
  "task",
  "sc_search_web",
  "parse_pdf",
]);
const SH_STATUS_SKIP_PREFIXES = ["hybrid_dr_"];

function shStatusSkips(tool: string): boolean {
  return SH_STATUS_SKIP_TOOLS.has(tool) || SH_STATUS_SKIP_PREFIXES.some((p) => tool.startsWith(p));
}

// Same suffix list as the router's _SCRIPT_SUFFIXES (prompt_transform.py): a script only counts as
// progress once a later bash command names it.
const SH_SCRIPT_SUFFIXES = [".py", ".sh", ".js", ".rb", ".pl"];
const SH_TRAIL_WINDOW = 9;
const SH_TRAIL_SHOWN = 6;
const SH_MAX_STATUS_KEYS = 128;

interface ShStatusState {
  trail: string[];
  wrote: string[];
  pendingScripts: Set<string>;
  totalCalls: number;
  scanCalls: number;
  earlyFired: boolean;
  finalFired: boolean;
}

const SH_statusByKey = new Map<string, ShStatusState>();

function shStatusFor(key: string): ShStatusState {
  let st = SH_statusByKey.get(key);
  if (st) return st;
  st = {
    trail: [],
    wrote: [],
    pendingScripts: new Set(),
    totalCalls: 0,
    scanCalls: 0,
    earlyFired: false,
    finalFired: false,
  };
  SH_statusByKey.set(key, st);
  if (SH_statusByKey.size > SH_MAX_STATUS_KEYS) {
    const oldest = SH_statusByKey.keys().next().value;
    if (oldest !== undefined) SH_statusByKey.delete(oldest);
  }
  return st;
}

function shBasename(value: unknown): string {
  const parts = String(value ?? "").trim().split(/[\\/]/);
  return parts[parts.length - 1] ?? "";
}

function shNoteWrote(st: ShStatusState, name: string): void {
  st.wrote = st.wrote.filter((w) => w !== name);
  st.wrote.push(name);
  if (st.wrote.length > 2) st.wrote.shift();
}

function shRecordCompleted(st: ShStatusState, tool: string, args: any): void {
  st.totalCalls += 1;
  if (shIsScanCall(tool, args)) st.scanCalls += 1;
  st.trail.push(tool);
  if (st.trail.length > SH_TRAIL_WINDOW) st.trail.shift();

  if (SH_DELIVERABLE_TOOLS.has(tool)) {
    const file = shBasename(args?.filePath ?? args?.file_path ?? args?.file ?? args?.path);
    if (!file) {
      if (tool === "patch") shNoteWrote(st, "(patch)");
    } else if (SH_SCRIPT_SUFFIXES.some((s) => file.endsWith(s))) {
      st.pendingScripts.add(file);
    } else {
      shNoteWrote(st, file);
    }
    return;
  }

  if (tool === "bash" && st.pendingScripts.size > 0) {
    const command = String(args?.command ?? "");
    for (const name of [...st.pendingScripts]) {
      if (command.includes(name)) {
        st.pendingScripts.delete(name);
        shNoteWrote(st, name);
      }
    }
  }
}

function shTrailText(trail: string[]): string {
  const groups: { name: string; count: number }[] = [];
  for (const name of trail.slice(-SH_TRAIL_SHOWN)) {
    const last = groups[groups.length - 1];
    if (last && last.name === name) last.count += 1;
    else groups.push({ name, count: 1 });
  }
  return groups.map((g) => (g.count > 1 ? `${g.name} x${g.count}` : g.name)).join(" > ");
}

// A cycle of 2 or 3 different tools repeated at least 3 times at the end of the trail, with no
// producing call inside it: edit > bash > edit > bash is a normal fix-and-test loop, not a stall.
function shDetectLoop(trail: string[]): string | null {
  for (const k of [2, 3]) {
    if (trail.length < 3 * k) continue;
    const pattern = trail.slice(-k);
    if (new Set(pattern).size < 2) continue;
    if (pattern.some((t) => SH_DELIVERABLE_TOOLS.has(t))) continue;
    let repeats = 0;
    while ((repeats + 1) * k <= trail.length) {
      const chunk = trail.slice(trail.length - (repeats + 1) * k, trail.length - repeats * k);
      if (chunk.some((t, i) => t !== pattern[i])) break;
      repeats += 1;
    }
    if (repeats >= 3) return `${pattern.join(">")} x${repeats}`;
  }
  return null;
}

function shStatusLine(n: number, budget: number, st: ShStatusState): string {
  const parts = [`STEP ${n}/${Math.max(n, budget)}`, `${Math.max(0, budget - n)} left`, `trail: ${shTrailText(st.trail)}`];
  const loop = shDetectLoop(st.trail);
  if (loop) parts.push(`loop: ${loop}`);
  parts.push(st.wrote.length > 0 ? `wrote: ${st.wrote.join(", ")}` : "no file written yet");
  return `\n[${parts.join(" | ")}]`;
}

// SUPERCLAW_SCAN_NUDGE=on (default off): two one-shot warnings per turn while no file has been written — an
// early "change strategy" at SH_EARLY_RATIO of the budget when SH_SCAN_SHARE of the calls were scans, and a
// final "produce output now" at SH_WARN_RATIO. Neither throws; the hard tiers stay responsible for stopping.
function shNudgeOn(): boolean {
  return (process.env.SUPERCLAW_SCAN_NUDGE ?? "").trim().toLowerCase() === "on";
}

const SH_EARLY_RATIO = 0.5;
const SH_SCAN_SHARE = 0.6;

// Copy of the file-read budget plugin's scan class (92_superclaw_file_read_budget: FRB_TOOLS and
// FRB_SCAN_CMD_RE) because plugins cannot import each other; a test keeps the two in step.
const SH_SCAN_TOOLS = new Set([
  "read", "grep", "glob", "list", "ocr", "local_dr_query_table",
  "parse_pdf", "local_dr_read_csv_xlsx", "local_dr_read_docx", "local_dr_read_pptx",
]);
const SH_SCAN_CMD_RE =
  /(?<!\|\s{0,20})\b(?:head|tail)\s+(?:-\S+\s+)*(\S+\.\w+)\b|(?<!\|\s{0,20})\bsed\s+-n\s+'[^']*'\s+(\S+\.\w+)/;

function shIsScanCall(tool: string, args: any): boolean {
  return SH_SCAN_TOOLS.has(tool) || (tool === "bash" && SH_SCAN_CMD_RE.test(String(args?.command ?? "")));
}

function shNudgeFor(
  n: number,
  budget: number,
  st: ShStatusState,
): { kind: "early" | "final"; text: string } | null {
  if (st.wrote.length > 0) return null;
  const warnAt = Math.floor(budget * SH_WARN_RATIO);
  if (n >= warnAt) {
    if (st.finalFired || n > budget) return null;
    st.finalFired = true;
    return {
      kind: "final",
      text:
        `\n[STEP BUDGET ${n} of ${budget}: no output file has been written yet. Stop scanning and produce ` +
        `the requested output now from what you already collected; if it cannot be completed, write the ` +
        `best partial result and state what remains. After step ${budget}, every tool except write, edit ` +
        `and patch is blocked.]`,
    };
  }
  const earlyAt = Math.max(1, Math.floor(budget * SH_EARLY_RATIO));
  if (n < earlyAt || st.earlyFired || st.totalCalls === 0) return null;
  if (st.scanCalls / st.totalCalls < SH_SCAN_SHARE) return null;
  st.earlyFired = true;
  return {
    kind: "early",
    text:
      `\n[CHANGE STRATEGY: ${n} of ${budget} steps are used and most of them were reading or scanning; ` +
      `nothing has been written yet. Stop broad scanning. Use a targeted search for the exact ` +
      `information you need, or start writing a partial deliverable now.]`,
  };
}

// SH_-prefixed: opencode evaluates plugins in a shared top-level scope and
// `sessionAgent` is already declared by plugins 90 and 93.
const SH_sessionAgent = new Map<string, string>();

function shBudgetFor(sessionID: string, nativeSteps: Record<string, number>): number {
  const agent = SH_sessionAgent.get(sessionID);
  return agent ? shBudgetForAgent(agent, nativeSteps) : STEP_BUDGET;
}

function shBudgetForAgent(agent: string, nativeSteps: Record<string, number>): number {
  const spec = SH_AGENT_BUDGET_SPECS[agent];
  if (!spec) return STEP_BUDGET;
  const pinned = SH_PINNED_BUDGETS[agent];
  if (pinned !== undefined) return pinned;
  const steps = nativeSteps[agent];
  // A known cap at or below the reserve leaves no room: never return a budget above `steps`.
  return steps !== undefined ? Math.max(0, steps - spec.reserve) : spec.fallback;
}

// Each agent's `steps` cap from the live opencode config ({} when it cannot be read).
async function shReadNativeSteps(client: any): Promise<Record<string, number>> {
  const steps: Record<string, number> = {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), SH_CONFIG_TIMEOUT_MS);
    });
    const result: any = await Promise.race([client?.config?.get?.(), timeout]);
    const agents = !result?.error ? result?.data?.agent : undefined;
    if (agents && typeof agents === "object") {
      for (const [name, def] of Object.entries<any>(agents)) {
        const cap = def?.steps ?? def?.maxSteps;
        if (typeof cap === "number" && cap > 0) steps[name] = cap;
      }
    }
  } catch {
    // Fall back to the fixed budgets.
  } finally {
    if (timer) clearTimeout(timer);
  }
  return steps;
}

// Counters are keyed by `${sessionID}:${turn}` so a new user turn re-arms the
// full budget. `turnCount`/`turnTripped` replace the old session-lifetime maps.
const turnCount = new Map<string, number>();
const turnTripped = new Set<string>();

// Turn tracking, mirroring plugin 92. `parentOf` lets a subagent resolve its
// root session; `activeTurnOfRoot`/`turnOfSession` record the latest user turn.
const parentOf = new Map<string, string>();
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

// A compaction adds two user messages: the `compaction` marker and a synthetic
// "continue" text. opencode keeps counting `steps` across them, so they must
// not start a new turn here, or the budget re-arms and never trips before `steps`.
function shIsCompactionMessage(msg: Record<string, any> | undefined): boolean {
  const parts = Array.isArray(msg?.parts) ? msg.parts : [];
  return parts.some((p: any) => p?.type === "compaction" || p?.metadata?.compaction_continue === true);
}

function latestUserMessageID(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = asRecord(messages[i]);
    const info = asRecord(msg?.info);
    const role = info?.role ?? msg?.role;
    if (role !== "user") continue;
    if (shIsCompactionMessage(msg)) continue;
    const id = info?.id ?? msg?.id;
    if (typeof id === "string" && id) return id;
  }
  return undefined;
}

// Budget is per session (not per lineage like plugin 92), scoped to the active
// user turn. Subagents still resolve the turn via their root so a mid-turn
// subagent shares the turn rather than getting a spurious fresh budget.
function getBudgetKey(sessionID: string): { key: string; turn: string } {
  const turn =
    turnOfSession.get(sessionID) ??
    activeTurnOfRoot.get(getRoot(sessionID)) ??
    `session:${sessionID}`;
  return { key: `${sessionID}:${turn}`, turn };
}

export const SuperclawStepHorizon: Plugin = async ({ client }) => {
  const statusMode = shStatusMode();
  const nudgeOn = shNudgeOn();
  await client.app.log({
    body: {
      service: "superclaw-step-horizon",
      level: "info",
      message: `Plugin initialised; budget=${STEP_BUDGET} tool calls per user turn; per-agent overrides=${JSON.stringify(SH_AGENT_STEP_BUDGETS)}; step-status=${statusMode}; scan-nudge=${nudgeOn ? "on" : "off"}`,
    },
  });

  // Read on first use, not at init: the server may still be loading plugins then.
  let nativeStepsRead: Promise<Record<string, number>> | undefined;
  const nativeSteps = (): Promise<Record<string, number>> => {
    nativeStepsRead ??= shReadNativeSteps(client).then(async (steps) => {
      const budgets = Object.fromEntries(
        Object.entries(steps)
          .filter(([agent]) => agent in SH_AGENT_BUDGET_SPECS)
          .map(([agent, cap]) => [agent, `${cap}->${shBudgetForAgent(agent, steps)}`]),
      );
      try {
        await client.app.log({
          body: {
            service: "superclaw-step-horizon",
            level: "info",
            message: `Per-agent budgets from steps (steps->budget): ${Object.keys(steps).length > 0 ? JSON.stringify(budgets) : "config unavailable, fixed budgets apply"}`,
          },
        });
      } catch {
        // Best-effort: this promise is cached, so a failed log must not make every later tool call reject.
      }
      return steps;
    });
    return nativeStepsRead;
  };

  return {
    // Mirrors plugin 90: remember which agent owns this session so
    // `tool.execute.before` can select the right budget.
    "chat.params": async (input, _output) => {
      const ag = input.agent as any;
      const name =
        typeof ag === "string"
          ? ag
          : (ag?.name ?? ag?.id ?? ag?.type ?? ag?.agent ?? "");
      if (input.sessionID && name) SH_sessionAgent.set(input.sessionID, name);
    },

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
      const { key, turn } = getBudgetKey(input.sessionID);
      const sid = input.sessionID;
      const budget = shBudgetFor(sid, await nativeSteps());

      const n = (turnCount.get(key) ?? 0) + 1;
      turnCount.set(key, n);

      if (n <= budget) return;

      if (SH_DELIVERABLE_TOOLS.has(input.tool)) return;

      // Only emit the throw once per turn — after the first trip, subsequent
      // tool calls (if any) should already be blocked, but be defensive in case
      // the model retries despite the directive.
      if (turnTripped.has(key)) {
        throw new Error(
          `STEP BUDGET ALREADY EXHAUSTED (call #${n}). Stop investigating. ` +
            `If a file was requested, write it now with 'write'; otherwise emit your final partial answer.`,
        );
      }
      turnTripped.add(key);

      await client.app.log({
        body: {
          service: "superclaw-step-horizon",
          level: "warn",
          message: `Budget exhausted on sessionID=...${sid.slice(-12)} turn=...${turn.slice(-12)} at call #${n} (tool=${input.tool}, callID=${input.callID.slice(0, 10)})`,
        },
      });

      throw new Error(
        `STEP BUDGET EXHAUSTED: this turn has fired ${n - 1} tool calls without converging. ` +
          `Investigation tools are now closed, but 'write'/'edit' are still permitted. ` +
          `Required next action: if you were asked to produce a FILE, write it NOW from what you already have — ` +
          `a partial file beats no file. Otherwise emit a single final text response that ` +
          `(1) summarises what you found so far from the previous tool results, ` +
          `(2) explicitly flags any portion of the user's request that you could not complete within the budget, ` +
          `and (3) stops. Do not retry this call or any other investigation tool.`,
      );
    },

    "tool.execute.after": async (input, output) => {
      const { key } = getBudgetKey(input.sessionID);
      const budget = shBudgetFor(input.sessionID, await nativeSteps());
      const n = turnCount.get(key) ?? 0;

      const st = statusMode === "every" || nudgeOn ? shStatusFor(key) : undefined;
      if (st) shRecordCompleted(st, input.tool, input.args);

      const out = output as { output?: string };
      const append = (text: string): void => {
        if (typeof out?.output === "string") out.output += text;
      };
      const appendable = typeof out?.output === "string" && !shStatusSkips(input.tool);
      const nudge = st && nudgeOn && appendable ? shNudgeFor(n, budget, st) : null;

      if (statusMode === "off") {
        if (nudge) append(nudge.text);
        return;
      }
      if (statusMode === "every") {
        if (st && appendable) append(shStatusLine(n, budget, st) + (nudge?.text ?? ""));
        return;
      }

      const warnAt = Math.floor(budget * SH_WARN_RATIO);

      if (n < warnAt || n > budget) {
        if (nudge) append(nudge.text);
        return;
      }

      if (typeof out?.output !== "string") return;

      out.output += nudge
        ? nudge.text
        : `\n[STEP BUDGET: ${n} of ${budget} tool calls used in this session — ` +
          `${budget - n} remaining. Wrap up and produce your deliverable soon.]`;
    },
  };
};

// PATCH plugin-export-form: opencode SDK expects a direct function as default
// export, not a `{ server: fn }` wrapper.
export default SuperclawStepHorizon;

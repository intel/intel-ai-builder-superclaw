/**
 * superclaw_file_read_budget — per-turn budget on file-INSPECTION calls.
 *
 * Complements 93 (identity-keyed repeat guard) and 94 (size-keyed output cap):
 * neither can stop a weak local model from paging sequentially through a large
 * file, because every call is distinct and individually small. This guard counts
 * file-inspection calls with no identity or size logic at all.
 *
 * Escalates rather than cutting off: an advisory at FRB_WARN_AT, a one-line
 * countdown after that, and a hard block past FRB_BUDGET. A model that cannot
 * see a limit approaching cannot budget for it.
 *
 * Scan-shaped 'bash' calls (head/tail/sed -n paging over an actual file, not
 * piped from another command's output) count toward the same budget starting
 * from their SECOND occurrence per turn — otherwise 'bash' is an invisible
 * escape hatch: a model can launder the exact same offset-by-offset paging
 * loop this guard exists to stop through 'head -200 file' / 'head -400 file'
 * / ... and never be counted, since plain 'bash' calls are deliberately
 * excluded from FRB_TOOLS (bash also runs legitimate one-shot computation).
 * The first occurrence stays free so a single sanctioned peek (e.g. the
 * prompt's own "sed -n '42p' file" line-fetch) is never penalized.
 *
 * Every top-level identifier is FRB_-prefixed: OpenCode's plugin loader
 * evaluates plugins/*.ts in a shared top-level scope, and a duplicate
 * unprefixed name across files silently kills the later file's hooks.
 *
 * Env:
 *   SUPERCLAW_FILE_READ_BUDGET  hard block threshold (default 8)
 *   SUPERCLAW_FILE_READ_WARN_AT advisory threshold   (default 3)
 */
import type { Plugin } from "@opencode-ai/plugin";

const FRB_BUDGET = Number(process.env.SUPERCLAW_FILE_READ_BUDGET ?? "") || 8;
const FRB_WARN_AT = Number(process.env.SUPERCLAW_FILE_READ_WARN_AT ?? "") || 3;

const FRB_TOOLS = new Set([
  "read", "grep", "glob", "list", "ocr", "local_dr_query_table",
  "parse_pdf", "local_dr_read_csv_xlsx", "local_dr_read_docx", "local_dr_read_pptx",
]);

// Document-conversion tools. The agent prompt says to parse each PDF once and read each docx/pptx/xlsx once, so
// the FIRST call per distinct file is free and a normal document task is not pushed toward the block; a repeat of
// the same file counts. A call without a file path always counts.
const FRB_DOC_TOOLS = new Set([
  "parse_pdf", "local_dr_read_csv_xlsx", "local_dr_read_docx", "local_dr_read_pptx",
]);
const FRB_docSeen = new Map<string, Set<string>>();

function frbDocCounts(key: string, args: any): boolean {
  const file = String(args?.file_path ?? args?.filePath ?? args?.path ?? "").trim();
  if (!file) return true;
  const seen = FRB_docSeen.get(key) ?? new Set<string>();
  FRB_docSeen.set(key, seen);
  if (seen.has(file)) return true;
  seen.add(file);
  return false;
}

// Requires a real file-looking argument (has an extension) after the paging
// verb, so `python3 script.py | head -50` (peeking at a script's own output)
// and `git log | head` do not match — only `head`/`tail`/`sed -n` applied
// directly to a file. The negative lookbehind excludes anything preceded by
// a pipe within a short window, covering the piped-output cases above.
const FRB_SCAN_CMD_RE =
  /(?<!\|\s{0,20})\b(?:head|tail)\s+(?:-\S+\s+)*(\S+\.\w+)\b|(?<!\|\s{0,20})\bsed\s+-n\s+'[^']*'\s+(\S+\.\w+)/;

// Tracks how many times a scan-shaped bash command has been seen per budget
// key, independent of FRB_counts. The first sighting is a free pass; only a
// repeat starts consuming the shared budget — see file header.
const FRB_scanBashSeen = new Map<string, number>();

function frbIsScanBash(tool: string, args: any): boolean {
  if (tool !== "bash") return false;
  return FRB_SCAN_CMD_RE.test(String(args?.command ?? ""));
}

/** True once this key's scan-shaped bash calls should start counting toward the budget. */
function frbScanBashCounts(key: string): boolean {
  const seen = (FRB_scanBashSeen.get(key) ?? 0) + 1;
  FRB_scanBashSeen.set(key, seen);
  return seen > 1;
}

const FRB_MAX_TRACKED_KEYS = 128;

// Turn tracking mirrors plugins 91/92/93 so the budget resets on each new user
// message and a subagent inherits its parent's turn instead of a fresh budget.
const FRB_parentOf = new Map<string, string>();
const FRB_activeTurnOfRoot = new Map<string, string>();
const FRB_turnOfSession = new Map<string, string>();

const FRB_counts = new Map<string, number>();
const FRB_callLog = new Map<string, string[]>();
const FRB_warned = new Set<string>();

function frbGetRoot(sid: string): string {
  let cur = sid;
  for (let i = 0; i < 64; i++) {
    const p = FRB_parentOf.get(cur);
    if (!p) return cur;
    cur = p;
  }
  return cur;
}

function frbAsRecord(value: unknown): Record<string, any> | undefined {
  if (!value || typeof value !== "object") return undefined;
  return value as Record<string, any>;
}

function frbLatestUserMessageID(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = frbAsRecord(messages[i]);
    const info = frbAsRecord(msg?.info);
    const role = info?.role ?? msg?.role;
    if (role !== "user") continue;
    const id = info?.id ?? msg?.id;
    if (typeof id === "string" && id) return id;
  }
  return undefined;
}

function frbBudgetKey(sessionID: string): string {
  const turn =
    FRB_turnOfSession.get(sessionID) ??
    FRB_activeTurnOfRoot.get(frbGetRoot(sessionID)) ??
    `session:${sessionID}`;
  // Keyed on the ROOT session, not this one: a subagent that exhausts its
  // budget and dies must not hand the parent a fresh budget to repeat the
  // same work with.
  return `${frbGetRoot(sessionID)}:${turn}`;
}

// Human-readable log line per call — this becomes the model's only memory of
// what it already gathered when the block message fires.
function frbDescribe(tool: string, args: any): string {
  if (tool === "read") {
    const off = Number(args?.offset ?? 0);
    const lim = Number(args?.limit ?? 0);
    return lim
      ? `read ${args?.filePath} lines ${off}-${off + lim}`
      : `read ${args?.filePath}`;
  }
  if (tool === "grep") return `grep "${args?.pattern}" in ${args?.path ?? "workspace"}`;
  if (tool === "glob") return `glob "${args?.pattern}"`;
  if (tool === "list") return `list ${args?.path}`;
  if (tool === "ocr") return `ocr ${args?.file_path}`;
  if (FRB_DOC_TOOLS.has(tool)) return `${tool} ${args?.file_path ?? args?.filePath ?? ""}`;
  if (tool === "bash") {
    const cmd = String(args?.command ?? "").trim();
    return `scan-shaped bash: ${cmd.length > 80 ? cmd.slice(0, 80) + "..." : cmd}`;
  }
  return `${tool} ${args?.path ?? args?.pattern ?? ""}`;
}

function frbRecord(key: string, tool: string, args: any): void {
  const log = FRB_callLog.get(key) ?? [];
  log.push(frbDescribe(tool, args));
  FRB_callLog.set(key, log);
  if (FRB_callLog.size > FRB_MAX_TRACKED_KEYS) {
    const oldest = FRB_callLog.keys().next().value;
    if (oldest !== undefined) {
      FRB_callLog.delete(oldest);
      FRB_counts.delete(oldest);
      FRB_warned.delete(oldest);
      FRB_scanBashSeen.delete(oldest);
      FRB_docSeen.delete(oldest);
    }
  }
}

function frbAdvisory(n: number): string {
  return [
    ``,
    `[FILE-READ BUDGET: ${n} of ${FRB_BUDGET} used]`,
    `You are reading this file section by section. That is the slowest strategy and`,
    `will exhaust your budget before you can answer.`,
    `Instead: grep for the specific keyword you need, then read ONLY the lines around`,
    `each match. For counts/sums/filters over the whole file, write a python script`,
    `with 'bash' that prints ONLY the answer.`,
  ].join("\n");
}

function frbCountdown(n: number): string {
  return `\n[FILE-READ BUDGET: ${n} of ${FRB_BUDGET} used — ${FRB_BUDGET - n} remaining. Plan to answer soon.]`;
}

function frbExhausted(log: string[]): string {
  return [
    `FILE-INSPECTION BUDGET EXHAUSTED: you have already made ${log.length} file-inspection calls`,
    `in this task (limit ${FRB_BUDGET}). No further file-inspection calls covered by this`,
    `budget will run.`,
    ``,
    `This budget is shared across the entire task, including any subagents you dispatch.`,
    `Delegating the same file-inspection work to another subagent will NOT provide a fresh`,
    `budget. Do not delegate solely to repeat the blocked operation.`,
    ``,
    `Already gathered:`,
    ...log.map((entry, i) => `  ${i + 1}. ${entry}`),
    ``,
    `Now assess what is still required to complete the user's request:`,
    `  - If the information already gathered is sufficient, stop investigating and complete`,
    `    the task now using the available information.`,
    `  - If required information is still missing, do not guess, fabricate, or assume it does`,
    `    not exist. Determine whether it can be obtained through another available`,
    `    non-redundant method that is not covered by this budget.`,
    `  - If an appropriate alternative method exists, use it once and extract the remaining`,
    `    information efficiently rather than repeating the blocked file-inspection operation.`,
    `  - If no appropriate method remains, clearly state the limitation and provide the best`,
    `    result possible from the information already gathered.`,
    ``,
    `Prioritize completing the user's request. Do not continue exploratory investigation`,
    `when the available evidence is already sufficient.`,
  ].join("\n");
}

export const SuperclawFileReadBudget: Plugin = async ({ client }) => {
  await client.app.log({
    body: {
      service: "file-read-budget",
      level: "info",
      message: `Plugin initialised; warn at ${FRB_WARN_AT}, block above ${FRB_BUDGET} file-inspection calls per turn`,
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
        FRB_parentOf.set(sid, parent);
        const parentTurn =
          FRB_turnOfSession.get(parent) ?? FRB_activeTurnOfRoot.get(frbGetRoot(parent));
        if (parentTurn) FRB_turnOfSession.set(sid, parentTurn);
      }
    },

    "experimental.chat.messages.transform": async (_input, output) => {
      const messages = (output as any)?.messages;
      const turn = frbLatestUserMessageID(messages);
      if (!turn) return;
      const last = Array.isArray(messages)
        ? frbAsRecord(messages[messages.length - 1])
        : undefined;
      const sessionID = frbAsRecord(last?.info)?.sessionID;
      if (typeof sessionID !== "string" || !sessionID) return;

      const root = frbGetRoot(sessionID);
      if (root !== sessionID && FRB_turnOfSession.has(sessionID)) return;
      FRB_activeTurnOfRoot.set(root, turn);
      FRB_turnOfSession.set(sessionID, turn);
    },

    "tool.execute.before": async (input, output) => {
      const args = (output as { args?: any })?.args;
      const isScanBash = frbIsScanBash(input.tool, args);
      if (!FRB_TOOLS.has(input.tool) && !isScanBash) return;
      const key = frbBudgetKey(input.sessionID);
      if (isScanBash && !frbScanBashCounts(key)) return; // first sighting is free
      if (FRB_DOC_TOOLS.has(input.tool) && !frbDocCounts(key, args)) {
        frbRecord(key, input.tool, args); // listed under "already gathered" without using budget
        return;
      }

      const n = (FRB_counts.get(key) ?? 0) + 1;
      FRB_counts.set(key, n);

      if (n > FRB_BUDGET) {
        await client.app.log({
          body: {
            service: "file-read-budget",
            level: "warn",
            message: `tier=block n=${n}/${FRB_BUDGET} tool=${input.tool} sessionID=...${input.sessionID.slice(-12)}`,
          },
        });
        throw new Error(frbExhausted(FRB_callLog.get(key) ?? []));
      }

      frbRecord(key, input.tool, args);
    },

    "tool.execute.after": async (input, output) => {
      const args = (output as { args?: any })?.args;
      const isScanBash = frbIsScanBash(input.tool, args);
      if (!FRB_TOOLS.has(input.tool) && !isScanBash) return;
      const key = frbBudgetKey(input.sessionID);
      const n = FRB_counts.get(key) ?? 0;

      const out = output as { output?: string };
      if (typeof out?.output !== "string") return;

      // OpenCode's own truncation notice invites the exact sequential-paging
      // behavior this guard exists to stop ("Use offset=214 to continue").
      // Neutralize it unconditionally, before the warn/countdown gate below.
      out.output = out.output.replace(
        /Use offset=\d+ to continue\.?/g,
        "Do NOT continue with offset — locate the section you need with 'grep', " +
          "or write a python script via 'bash' if you need the whole file's content.",
      );

      if (n < FRB_WARN_AT) return;

      if (n === FRB_WARN_AT && !FRB_warned.has(key)) {
        FRB_warned.add(key);
        out.output += frbAdvisory(n);
        await client.app.log({
          body: {
            service: "file-read-budget",
            level: "info",
            message: `tier=warn n=${n}/${FRB_BUDGET} tool=${input.tool} sessionID=...${input.sessionID.slice(-12)}`,
          },
        });
        return;
      }

      out.output += frbCountdown(n);
    },
  };
};

export default SuperclawFileReadBudget;

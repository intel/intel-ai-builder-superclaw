/**
 * Prevents the model from re-running the same tool call repeatedly without
 * making progress. Complements 91_step_horizon / 92_lineage_budget, which cap
 * the total step count but can't stop the model from burning all those steps on
 * a single repeated command.
 *
 * Common failure patterns this addresses:
 *  (A) Bash loop — model runs a script, dislikes the output, and reruns the
 *      exact same command over and over instead of fixing the script.
 *  (B) Invalid-write loop — an oversized write fails and is routed to the
 *      `invalid` tool; model keeps retrying the same broken call.
 *  (C) Identical-edit loop — a weak model re-submits the SAME `edit` (same
 *      file + oldString + newString) after it fails ("oldString and newString
 *      are identical", or an oldString that never matches). Keyed on
 *      file+old+new so only truly identical retries trip; progressive edits pass.
 *  (D) Read/grep/glob loop — a weak model re-issues the IDENTICAL read window,
 *      grep pattern, or glob pattern instead of changing range/keyword. Does
 *      NOT catch sequential scanning (different windows each time) — that
 *      needs a separate total-call budget guard.
 *  (E) Identical-write loop — a weak model re-writes the SAME file with
 *      byte-identical content (typically a scratch script it never runs).
 *      Keyed on file + content hash, so rewrites with different content
 *      (progress, or the final deliverable) are never blocked.
 *
 * How it works: each tool call is identified by its command string (not its
 * output, since output can vary) within one user turn. Once the same call has
 * run SC_REPEAT_MAX times, the plugin blocks further retries with guidance.
 * The local ModelRouter independently removes a repeatedly ignored tool from
 * subsequent model requests, providing the hard boundary without translating
 * a guard trip into a user-initiated session abort. A new user turn starts with
 * fresh counters so normal interactive work is not penalized for re-running
 * the same test or build command later.
 *
 * A command is not "the same" once the file it runs has changed. A successful
 * write or edit of a file therefore clears the session's bash counters for
 * commands that name that file: the ordinary way to debug a generated script
 * (run it, fix it, run the same `python build_deck.py` again) is not a loop,
 * and without this the third run was blocked however much the script had
 * changed in between. A command that does not name the file (`true`, an
 * unrelated script) keeps its count, and a failed edit never reaches
 * tool.execute.after, so it re-arms nothing. A patch tool that names no single
 * file clears every bash counter. A model that keeps editing only to rerun the
 * same command is still bounded by the step and lineage budgets (91 / 92).
 *
 * SC_REPEAT_MAX defaults to 2 (one attempt + one retry). Set it higher to
 * loosen the guard, or to a very large number to disable it.
 */
import type { Plugin } from "@opencode-ai/plugin";
import { createHash as repeatGuardHash } from "node:crypto";

const DEFAULT_MAX = 2;
const MAX_TRACKED_KEYS = 256;
// Scheduler tools return a soft "not found" message that reads like an
// invitation to retry, so models often call them in a loop. Guard them too.
const SCHEDULER_TOOLS = new Set([
  "run_job",
  "schedule_job",
  "cancel_job",
  "update_job",
]);
// Tools that change files a bash command may run. Their success re-arms the commands that run that file.
const FILE_CHANGE_TOOLS = new Set(["write", "edit", "multiedit", "apply_patch", "patch"]);

function baseName(path: unknown): string {
  // split always returns at least one element, so pop() is never undefined.
  return normalize(path).split(/[\\/]/).pop()!.toLowerCase();
}

// True when the command names the file as a whole path component (`python ./build_deck.py`,
// `python "build deck.py"`, `python build_deck.py>out.log`), not as part of a longer name
// (`deck.py` in `build_deck.py`). A path component ends at whitespace, a quote, a slash or a shell operator.
function commandNamesFile(command: string, file: string): boolean {
  const name = file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[\\s"'\\\\/<>|&;(=])${name}(?:$|[\\s"'<>|&;)])`).test(command.toLowerCase());
}

// read/grep/glob loop the same way bash/edit do on a large file: a weak model
// re-issues the identical window/pattern instead of changing strategy. `list`
// is deliberately excluded — it's cheap and legitimately re-issued to check
// whether a file appeared after a write.
const READ_FAMILY_TOOLS = new Set(["read", "grep", "glob"]);
const GUARDED_TOOLS = new Set([
  "bash",
  "invalid",
  "edit",
  "write",
  ...READ_FAMILY_TOOLS,
  ...SCHEDULER_TOOLS,
  // Takes no arguments and returns the same server list within a turn.
  "get_mcp_status",
]);
// Tools whose last allowed identical attempt gets a reminder appended to its result (see tool.execute.after).
const REMIND_TOOLS = new Set(["write", "bash", "edit", "read"]);

function reminderText(tool: string, max: number): string {
  if (tool === "bash") {
    return (
      `\n[REPEAT GUARD: this exact command has now run ${max} times. Do not run it again — use the output ` +
      `you already have, or change the command. The next identical command will be blocked.]`
    );
  }
  if (tool === "edit") {
    return (
      `\n[REPEAT GUARD: this exact edit (same file, same oldString/newString) has now run ${max} times. Do not ` +
      `send it again — if the file already has what you need, move on; otherwise use a different oldString. ` +
      `The next identical edit will be blocked.]`
    );
  }
  if (tool === "read") {
    return (
      `\n[REPEAT GUARD: this exact read (same file, same offset/limit) has now run ${max} times. Use what you ` +
      `already have, or read a different range. The next identical read will be blocked.]`
    );
  }
  return (
    `\n[REPEAT GUARD: this exact write (same file, same content) has now run ${max} times and the file ` +
    `already exists with this content. Do not write it again — run it, or write the final deliverable. ` +
    `The next identical write will be blocked.]`
  );
}
// Shell paging primitives that scan a file the same way 'read' does, drawing
// from the same step budget — matched only to pick advice text below, never
// to decide whether to block.
const SCAN_CMD_RE = /\b(sed\s+-n|head\b|tail\b|awk\s+[^|]*NR\b|cat\s+[^|]*$)/;

function resolveMax(): number {
  const raw = process.env.SC_REPEAT_MAX;
  if (raw !== undefined) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 1) return n;
  }
  return DEFAULT_MAX;
}

function normalize(s: unknown): string {
  return String(s ?? "")
    .trim()
    .replace(/\s+/g, " ");
}

function asRecord(value: unknown): Record<string, any> | undefined {
  if (!value || typeof value !== "object") return undefined;
  return value as Record<string, any>;
}

function latestUserMessageID(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = asRecord(messages[i]);
    const info = asRecord(message?.info);
    const role = info?.role ?? message?.role;
    if (role !== "user") continue;
    const id = info?.id ?? message?.id;
    if (typeof id === "string" && id) return id;
  }
  return undefined;
}

/** Returns a stable string key for a tool call, or null if the tool is not guarded. */
function actionKey(tool: string, args: any): string | null {
  if (tool === "bash") {
    const cmd = normalize(args?.command);
    return cmd ? "bash:" + cmd : null;
  }
  if (tool === "invalid") {
    // Args shape: { tool: "<intended tool name>", error: "<parse error message>" }
    const intended = normalize(args?.tool);
    const err = normalize(args?.error).slice(0, 120);
    return `invalid:${intended}|${err}`;
  }
  if (tool === "edit") {
    // Identity = target file + the exact old/new strings. A weak model on a
    // failing edit (e.g. "oldString and newString are identical", or an
    // oldString that never matches) re-submits the IDENTICAL edit over and
    // over. Keying on file+old+new blocks only truly identical retries;
    // progressive edits (different old/new) get distinct keys and pass.
    const file = normalize(args?.filePath ?? args?.file ?? args?.path);
    const oldS = normalize(args?.oldString ?? args?.old_string).slice(0, 200);
    const newS = normalize(args?.newString ?? args?.new_string).slice(0, 200);
    return `edit:${file}|${oldS}|${newS}`;
  }
  if (tool === "write") {
    // File + content hash: only a byte-identical rewrite trips, so a real
    // deliverable (different path or content) always passes.
    const file = normalize(args?.filePath ?? args?.file ?? args?.path);
    if (!file) return null;
    const digest = repeatGuardHash("sha256")
      .update(String(args?.content ?? ""))
      .digest("hex")
      .slice(0, 16);
    return `write:${file}|${digest}`;
  }
  if (tool === "read") {
    // offset+limit make each window a distinct key, so sequential paging
    // through a large file passes; only re-reading the IDENTICAL window trips.
    const file = normalize(args?.filePath ?? args?.file_path ?? args?.path);
    if (!file) return null;
    return `read:${file}|${normalize(args?.offset)}|${normalize(args?.limit)}`;
  }
  if (tool === "grep") {
    const pattern = normalize(args?.pattern);
    if (!pattern) return null;
    return `grep:${pattern}|${normalize(args?.path)}|${normalize(args?.include)}`;
  }
  if (tool === "glob") {
    const pattern = normalize(args?.pattern);
    if (!pattern) return null;
    return `glob:${pattern}|${normalize(args?.path)}`;
  }
  if (SCHEDULER_TOOLS.has(tool)) {
    // Include the job identifier so different jobs get separate counters.
    // Calls with no identifier all collapse to the same key for that tool.
    const job = normalize(
      args?.name ?? args?.job ?? args?.id ?? args?.job_name,
    );
    return `${tool}:${job}`;
  }
  if (tool === "get_mcp_status") return tool;
  return null;
}

// A write invalidates prior reads of that file — the content genuinely
// changed, so re-reading it afterward is progress, not a loop, even if the
// offset/limit are identical to a pre-edit read.
function clearReadKeysForFile(counts: Map<string, number>, file: string): void {
  if (!file) return;
  const prefix = `read:${file}|`;
  for (const k of counts.keys()) if (k.startsWith(prefix)) counts.delete(k);
}

// A bash/grep/glob result is "stale" when it is empty or identical to an
// earlier result of the SAME tool this turn, even if the command/pattern
// differed. Two stale results in a row means the model is cycling without
// learning anything. Counters are per tool so an empty grep never trips bash.
const STALE_LIMIT = 2;
const STALE_TOOLS = new Set(["bash", "grep", "glob"]);
const MAX_HINT_TOOLS = 12;

const STALE_SUBJECT: Record<string, string> = {
  bash: "bash commands returned nothing new or made no progress",
  grep: "grep searches found nothing new — different keywords keep returning empty or identical results, so the term is probably not in the searched files",
  glob: "glob patterns found nothing new — they keep returning empty or identical file lists, so the files are probably not in the searched directory",
};

// `tools` is the set of tool IDs seen via tool.definition; empty until the
// first request, in which case the generic read/grep/glob/write list is used.
function staleHint(tool: string, tools: ReadonlySet<string>): string {
  const alternatives = [...tools].filter((t) => t !== tool && t !== "invalid");
  const shown = alternatives.slice(0, MAX_HINT_TOOLS).map((t) => `'${t}'`);
  const more = alternatives.length > MAX_HINT_TOOLS ? ", ..." : "";
  const list = shown.length
    ? `Available tools: [${shown.join(", ")}${more}]. `
    : `Use 'read' on a file you know, 'grep'/'glob' to locate files, or 'write' the deliverable. `;
  return (
    `\n[NO NEW INFORMATION: the last ${STALE_LIMIT} ${STALE_SUBJECT[tool]}. ` +
    `Stop repeating '${tool}'. Switch to another relevant tool and continue the task from the current status. ` +
    list +
    `If you already have enough, 'write' the deliverable now, stating what could not be found.]`
  );
}

function trackStaleness(counts: Map<string, number>, tool: string, rawOutput: string): number {
  // Step/budget trailers change every call and must not make outputs look new.
  const body = rawOutput
    .replace(/\n?\[(STEP|FILE-READ BUDGET|REPEAT GUARD|NO NEW INFORMATION)[^\]]*\]/g, "")
    .trim();
  const streakKey = `\0stale-streak:${tool}`;
  const key = `\0stale-out:${tool}:` + repeatGuardHash("sha256").update(body).digest("hex").slice(0, 16);
  const stale = body === "" || counts.has(key);
  const streak = stale ? (counts.get(streakKey) ?? 0) + 1 : 0;
  counts.set(streakKey, streak);
  if (body !== "") counts.set(key, 1);
  return streak;
}

export const SuperclawRepeatCommandGuard: Plugin = async ({ client }) => {
  const MAX = resolveMax();
  await client.app.log({
    body: {
      service: "repeat-command-guard",
      level: "info",
      message: `Plugin initialised — blocks identical bash/edit/write/invalid/read/grep/glob/get_mcp_status calls after ${MAX} repeats`,
    },
  });

  // Turn tracking mirrors plugins 91/92. Child sessions inherit the active
  // root turn when they are created, while retaining independent counters.
  const parentOf = new Map<string, string>();
  const activeTurnOfRoot = new Map<string, string>();
  const turnOfSession = new Map<string, string>();

  const getRoot = (sessionID: string): string => {
    let current = sessionID;
    for (let i = 0; i < 64; i++) {
      const parent = parentOf.get(current);
      if (!parent) return current;
      current = parent;
    }
    return current;
  };

  // Keep only the active turn's counters for each session. This preserves
  // session+turn scoping without retaining every historical turn forever.
  // The file each write/edit call targets, read in the before hook for the after hook.
  const changedFile = new Map<string, string>();

  const bySession = new Map<
    string,
    { turn: string; counts: Map<string, number> }
  >();
  const stateFor = (sid: string): Map<string, number> => {
    const turn =
      turnOfSession.get(sid) ??
      activeTurnOfRoot.get(getRoot(sid)) ??
      `session:${sid}`;
    const current = bySession.get(sid);
    if (current !== undefined && current.turn === turn) return current.counts;

    const counts = new Map<string, number>();
    bySession.set(sid, { turn, counts });
    return counts;
  };

  const clearSessionState = (sessionID: string): void => {
    const root = getRoot(sessionID);
    bySession.delete(sessionID);
    turnOfSession.delete(sessionID);
    parentOf.delete(sessionID);
    if (root === sessionID) activeTurnOfRoot.delete(sessionID);
  };

  // callIDs of writes that used their last allowed attempt; their result gets a reminder.
  const remindCallIDs = new Set<string>();
  const knownTools = new Set<string>();

  return {
    "tool.definition": async (input) => {
      if (typeof input?.toolID === "string" && input.toolID) knownTools.add(input.toolID);
    },

    event: async (input) => {
      const event = input.event as any;
      const info = event?.properties?.info ?? {};
      if (event?.type === "session.created") {
        const sessionID = info.id;
        const parentID = info.parentID;
        if (
          typeof sessionID === "string" &&
          sessionID &&
          typeof parentID === "string" &&
          parentID
        ) {
          parentOf.set(sessionID, parentID);
          const parentTurn =
            turnOfSession.get(parentID) ?? activeTurnOfRoot.get(getRoot(parentID));
          if (parentTurn) turnOfSession.set(sessionID, parentTurn);
        }
        return;
      }

      if (!["session.idle", "session.error", "session.deleted"].includes(event?.type)) return;
      const sessionID = event?.properties?.sessionID ?? info.id;
      if (typeof sessionID === "string" && sessionID) clearSessionState(sessionID);
    },

    "experimental.chat.messages.transform": async (_input, output) => {
      const messages = (output as any)?.messages;
      const turn = latestUserMessageID(messages);
      if (!turn) return;

      const last = Array.isArray(messages)
        ? asRecord(messages[messages.length - 1])
        : undefined;
      const sessionID = asRecord(last?.info)?.sessionID;
      if (typeof sessionID !== "string" || !sessionID) return;

      const root = getRoot(sessionID);
      if (root !== sessionID && turnOfSession.has(sessionID)) return;

      activeTurnOfRoot.set(root, turn);
      turnOfSession.set(sessionID, turn);
    },

    "tool.execute.before": async (input, output) => {
      const args = (output as { args?: any })?.args;
      if (FILE_CHANGE_TOOLS.has(input.tool)) {
        const target = asRecord(args);
        changedFile.set(input.callID, baseName(target?.filePath ?? target?.file ?? target?.path));
        if (changedFile.size > MAX_TRACKED_KEYS) {
          const oldest = changedFile.keys().next().value;
          if (oldest !== undefined) changedFile.delete(oldest);
        }
      }
      if (!GUARDED_TOOLS.has(input.tool)) return;
      const key = actionKey(input.tool, args);
      if (!key) return;

      const m = stateFor(input.sessionID);

      if (input.tool === "edit") {
        clearReadKeysForFile(m, normalize(args?.filePath ?? args?.file ?? args?.path));
      }

      const count = m.get(key) ?? 0;
      const attempt = count + 1;

      // Count blocked attempts too. Besides keeping diagnostics truthful, this
      // exposes repeated ignored blocks to diagnostics.
      if (m.has(key)) m.delete(key);
      m.set(key, attempt);
      if (m.size > MAX_TRACKED_KEYS) {
        const oldest = m.keys().next().value;
        if (oldest !== undefined) m.delete(oldest);
      }

      // MAX >= 2 so a first call is never flagged as "repeated".
      if (REMIND_TOOLS.has(input.tool) && attempt === MAX && attempt >= 2) {
        remindCallIDs.add(input.callID);
        if (remindCallIDs.size > MAX_TRACKED_KEYS) {
          const oldest = remindCallIDs.values().next().value;
          if (oldest !== undefined) remindCallIDs.delete(oldest);
        }
      }

      if (attempt > MAX) {
        if (SCHEDULER_TOOLS.has(input.tool)) {
          throw new Error(
            `blocked: '${input.tool}' was attempted ${attempt} times with the same job; ` +
              `only the first ${MAX} attempts were allowed — ` +
              `re-running it wastes turns and context.\n\n` +
              `Scheduler tools only trigger jobs the user registered in advance. They cannot read ` +
              `files, run analyses, or create results on demand.\n` +
              `1. If you are trying to analyze or compute something, use 'bash' with python3 instead.\n` +
              `2. If the job genuinely does not exist, say so and stop. Do NOT call any scheduler tool again.\n`,
          );
        }
        const isInvalid = input.tool === "invalid";
        const isEdit = input.tool === "edit";
        const isWrite = input.tool === "write";
        const isRead = input.tool === "read";
        const isGrep = input.tool === "grep";
        const isGlob = input.tool === "glob";
        const isMcpStatus = input.tool === "get_mcp_status";
        const isScanBash = input.tool === "bash" && SCAN_CMD_RE.test(normalize(args?.command));
        const what = isInvalid
          ? `this tool call has already FAILED ${MAX} times and was attempted ${attempt} times with the same error`
          : isEdit
            ? `this exact edit (same file, same oldString/newString) has already been attempted ${attempt} times; only the first ${MAX} attempts ran`
            : isWrite
              ? `this exact write (same file, same content) has already been attempted ${attempt} times; only the first ${MAX} attempts ran`
              : isRead
              ? `this exact 'read' (same file, same offset/limit) has been attempted ${attempt} times and returned identical content each time`
              : isGrep
                ? `this exact 'grep' (same pattern, same path) has been attempted ${attempt} times and returned the same result each time`
                : isGlob
                  ? `this exact 'glob' pattern has been attempted ${attempt} times and returned the same file list each time`
                  : isMcpStatus
                    ? `'get_mcp_status' has been called ${attempt} times this turn`
                    : `this exact command has already run ${MAX} times and was attempted ${attempt} times`;
        throw new Error(
          `blocked: ${what} — re-running it wastes turns and context.\n\n` +
            (isInvalid
              ? `The call keeps failing to parse (usually a write whose content is ` +
                `too long, so its JSON is truncated). Do NOT retry the same write:\n` +
                `1. Split the file into a FIRST small write, then APPEND the rest in ` +
                `follow-up writes (or have a Python script write it with encoding='utf-8').\n` +
                `2. If most of the work is already on disk, stop and finish.\n`
              : isEdit
                ? `Re-submitting the identical edit changes nothing. Do NOT send it again:\n` +
                  `1. If the file already contains what you need, STOP editing and finish the task.\n` +
                  `2. If the edit keeps failing, your oldString does not uniquely match the file ` +
                  `(or equals newString). Re-read the file, then use a DIFFERENT oldString that ` +
                  `appears verbatim, or write the whole file directly.\n`
                : isWrite
                  ? `Re-writing identical content changes nothing. Do NOT send it again:\n` +
                    `1. If the file already has what you need, STOP writing: run it with bash, or ` +
                    `write the final deliverable the task asks for.\n` +
                    `2. If you need different content, change the content (or the file) before ` +
                    `writing again.\n`
                  : isRead
                  ? `Re-reading the same location cannot produce new content. Do NOT send it again:\n` +
                    `1. If this section already answers the question, STOP reading and write your answer.\n` +
                    `2. If you need different content, change offset/limit to a DIFFERENT range, or ` +
                    `grep for a keyword to locate the right range first.\n` +
                    `3. Do NOT page through the file from beginning to end — that exhausts your step ` +
                    `budget before you can answer.\n`
                  : isGrep
                    ? `If a pattern returned nothing the first time, the term is not in the file — ` +
                      `re-running it will not change that. Do NOT send it again:\n` +
                      `1. Try a DIFFERENT keyword, or a broader/looser pattern.\n` +
                      `2. If two or three different keywords all returned nothing, the information ` +
                      `is not in this file. Say so explicitly and answer with what you have.\n` +
                      `3. Do NOT grep every line of the file sequentially — grep is for locating a ` +
                      `term, not for reading the document.\n`
                    : isGlob
                      ? `Do NOT send it again:\n` +
                        `1. If the files you need are already listed, proceed to reading them.\n` +
                        `2. If the list was empty, the pattern does not match anything — try a ` +
                        `different pattern or a different directory, or state that no matching ` +
                        `files exist.\n`
                      : isMcpStatus
                        ? `Checking again will not help this turn. Do NOT call it again:\n` +
                          `1. Answer with the list you already have.\n` +
                          `2. If a server you need is not listed, it is not available to you. Tell the ` +
                          `user so and continue without it.\n`
                      : isScanBash
                        ? `Note: sed/head/tail page through a file the same way 'read' does, and ` +
                          `they draw from the same step budget. Do NOT continue scanning the file ` +
                          `chunk by chunk:\n` +
                          `1. If you need a specific value, grep for it directly.\n` +
                          `2. If you need a computation over the whole file (count, sum, filter), ` +
                          `write a python script that opens the file, computes the result, and ` +
                          `PRINTS ONLY the answer — never a script that prints the file contents.\n`
                        : `Do NOT run this command again:\n` +
                          `1. If its output already has what you need, STOP running commands ` +
                          `and write the final deliverable file the task asks for.\n` +
                          `2. If the output is wrong/empty, YOUR SCRIPT is the problem — EDIT ` +
                          `the script (fix parsing/paths/logic) and run the CHANGED command. ` +
                          `Never re-run the identical command hoping for a different result.\n`),
        );
      }
    },

    "tool.execute.after": async (input, output) => {
      // Fires on successful returns only, so a rejected or failed edit re-arms nothing. Done before the check
      // below that skips a result which is not a string: the re-arm does not depend on the result.
      if (FILE_CHANGE_TOOLS.has(input.tool)) {
        const file = changedFile.get(input.callID) ?? "";
        changedFile.delete(input.callID);
        const counts = stateFor(input.sessionID);
        for (const key of [...counts.keys()]) {
          if (key.startsWith("bash:") && (!file || commandNamesFile(key.slice("bash:".length), file))) {
            counts.delete(key);
          }
        }
      }

      const remind = remindCallIDs.delete(input.callID);
      const out = output as { output?: unknown };
      if (typeof out?.output !== "string") return;
      if (STALE_TOOLS.has(input.tool)) {
        const stale = trackStaleness(stateFor(input.sessionID), input.tool, out.output);
        if (stale >= STALE_LIMIT) out.output += staleHint(input.tool, knownTools);
      }
      if (remind) out.output += reminderText(input.tool, MAX);
    },
  };
};

export default SuperclawRepeatCommandGuard;

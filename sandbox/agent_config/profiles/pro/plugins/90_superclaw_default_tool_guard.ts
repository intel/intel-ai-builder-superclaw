/**
 * Runtime safety guard for `superclaw-default` and `build`.
 *
 * Some opencode permission denies are not enforced for built-in tools, so this
 * plugin checks tool calls right before they run. If an agent tries to use a
 * tool or subagent it should not use directly, the plugin blocks the call and
 * tells the model which safer route to take instead.
 *
 * The important routing rules are:
 *   1. `superclaw-default` must not inspect protected file types directly.
 *      It must ask for file-protection approval first.
 *
 *   2. Local files are handled before web search. Once a file agent has looked
 *      at the local file, web search is allowed for the rest of the session.
 *
 *   3. Protected-capable file types go through `protected-file-agent` when the
 *      user approves protection. If the user declines, `local-file-agent` is
 *      allowed once as the explicit fallback.
 *
 *   4. `build` must analyze masked files directly. It may not re-enter the
 *      protection pipeline, read mask registries, or open raw protected files.
 *
 * Subagents run in their own sessions with their own agent names, so these
 * checks only apply to the sessions identified by `chat.params` below.
 */
import type { Plugin } from "@opencode-ai/plugin";
import {
  canonicalWindowsPath,
  createProtectedSourceAccess,
  hostPath,
  isDerivedOutputPath,
  isMissingFile,
  normalizeSlashes,
  protectionOff,
} from "../lib/protected-source-access";

declare const process: { env: Record<string, string | undefined>; platform: string };

const PROTECTED_AGENT = "superclaw-default";
const BUILD_AGENT = "build";
const PROTECTED_PIPELINE_TOOL = "run_protected_file_pipeline";
const PROTECTED_PIPELINE_AGENT = "protected-file-agent";

// Sessions where the user declined file-protection approval.
const DENIAL_KEY = "__sc_confirm_file_protection_denied";
function deniedSessions(): Set<string> {
  const g = globalThis as unknown as Record<string, Set<string> | undefined>;
  // Store this on globalThis so all hook calls see the same denial list.
  return (g[DENIAL_KEY] ??= new Set<string>());
}

// Sessions whose decline was used to dispatch local-file-agent. The decline token above is
// consumed on dispatch, so this records it for 93_protected_pipeline_terminal_guard.ts, which
// lets the child session read the sensitive/ folder (fully local). Cleared by confirm_file_protection.
const DECLINE_FALLBACK_KEY = "__sc_decline_fallback_parents";
function declineFallbackParents(): Set<string> {
  const g = globalThis as unknown as Record<string, Set<string> | undefined>;
  return (g[DECLINE_FALLBACK_KEY] ??= new Set<string>());
}

// Tool -> subagent the agent should delegate to instead.
const REDIRECT: Record<string, string> = {};

// Subagents that `superclaw-default` is allowed to call with task().
const ALLOWED_TASK_TARGETS = new Set([
  "local-file-agent",
  "websearch-agent",
  "protected-file-agent",
]);

// File types that can go through the protected masking pipeline.
// They require user approval before the non-protected fallback is allowed.
const PROTECTED_EXTS = new Set([
  "csv",
  "xlsx",
  "xls",
  "parquet", // tabular_redaction.py
  "txt",
  "md",
  "html",
  "htm",
  "docx", // document_redaction.py
]);

// Protected data formats that `build` must not read as raw files.
// Text-like formats are omitted because `build` may need to read them as code or config.
const BUILD_READ_BLOCKED_EXTS = new Set([
  "csv",
  "xlsx",
  "xls",
  "parquet",
  "docx",
]);

// opencode-scheduler tools are blocked ONLY inside a masked-file handoff action.
const SCHEDULER_TOOLS = new Set([
  "run_job",
  "list_jobs",
  "schedule_job",
  "cancel_job",
  "update_job",
]);

const MASKED_HANDOFF_MARKER =
  "This file has ALREADY been protected and masked by the pipeline";

// Registry paths contain or resolve to the original PII values.
// `build` must never read them directly; restore happens through the backend.
const REGISTRY_PATH_RE =
  /data_protection_workspace[/\\]mask_registries/i;

// Finds the masked output file path embedded in a task() handoff.
const MASKED_FILE_PATH_CAPTURE_RE =
  /[^\s"'`]*data_protection_workspace[/\\]masked_datasets[/\\][^\s"'`]*?_masked\.[A-Za-z0-9]+/i;

/** Extract the exact masked file path from handoff text, normalized to forward slashes. */
function extractMaskedFilePath(text: string): string | null {
  const m = MASKED_FILE_PATH_CAPTURE_RE.exec(text);
  return m ? m[0].replace(/\\/g, "/").replace(/[.,;:]+$/, "") : null;
}

function isMaskRegistryPath(s: string): boolean {
  return REGISTRY_PATH_RE.test(s);
}

// Masked files always live under masked_datasets. Checking the path is more
// reliable than expecting the model to repeat the handoff marker exactly.
const MASKED_OUTPUT_PATH_RE =
  /data_protection_workspace[\/\\]masked_datasets[\/\\]/i;

function hasMaskedFileHandoff(text: string): boolean {
  if (MASKED_OUTPUT_PATH_RE.test(text)) return true;
  return (
    text.includes(MASKED_HANDOFF_MARKER) && /\bmasked_file_path\s*:/i.test(text)
  );
}

/** Extract the file path argument from a read/edit tool call. opencode uses several arg-name shapes. */
function extractReadPath(args: Record<string, unknown>): string {
  return (
    (args.file_path ?? args.path ?? args.filePath ?? "") as string
  ).trim();
}

/** Return the lowercase file extension without the dot (e.g. "xlsx"). */
function fileExt(filePath: string): string {
  const i = filePath.lastIndexOf(".");
  return i === -1 ? "" : filePath.slice(i + 1).toLowerCase();
}

// ── Workspace write enforcement (#1617) ────────────────────────────────────────
const WORKSPACE_WRITE_TOOLS = new Set(["write", "edit", "patch"]);
const ALLOWED_WRITE_ROOT_RE = /^\/(?:workspace|tmp|config\/opencode)(?:\/|$)/;
const WINDOWS_ABSOLUTE_PATH_RE = /^[A-Za-z]:[\\/]/;

function nativeWorkspaceRoot(): string | null {
  const root = process.env.OPENCODE_DIRECTORY?.trim();
  if (!root || !WINDOWS_ABSOLUTE_PATH_RE.test(root)) return null;
  const normalized = root.replace(/\\/g, "/");
  return /^[A-Za-z]:\/$/.test(normalized) ? normalized : normalized.replace(/\/+$/, "");
}

function isWithinNativeWorkspace(path: string, root: string): boolean {
  const candidate = canonicalWindowsPath(path);
  const canonicalRoot = canonicalWindowsPath(root);
  return candidate === canonicalRoot || candidate.startsWith(`${canonicalRoot}/`);
}

// bash mutation verbs. Split by where the write target sits, so a legitimate
// read of a system path as a SOURCE (e.g. `cp /opt/readers/x.py /workspace/`)
// is not mistaken for a write to it.
//   all-args: every absolute path is a target
//   last-arg: only the final absolute path is the destination
const BASH_ALL_ARG_VERBS = /(?:^|[\s;&|(])(?:mkdir|touch|tee)\b([^;&|]*)/g;
const BASH_LAST_ARG_VERBS = /(?:^|[\s;&|(])(?:mv|cp|rsync|ln)\b([^;&|]*)/g;
// `>` / `>>` redirect; `2>` and friends are not file writes we care about.
const BASH_REDIRECT = /(?<![0-9&])>>?\s*(?:"((?:[A-Za-z]:[\\/]|\/)[^"]+)"|'((?:[A-Za-z]:[\\/]|\/)[^']+)'|((?:[A-Za-z]:[\\/]|\/)[^\s"';&|>]+))/g;
const ABS_PATH = /(["'])((?:[A-Za-z]:[\\/]|\/)[^"']+)\1|(?<![\w./"'`])(?:[A-Za-z]:[\\/]|\/)[\w./\\-]*/g;

/** Absolute paths appearing in a bash argument segment, in order. */
function absPathsIn(segment: string): string[] {
  return [...segment.matchAll(ABS_PATH)].map((match) => {
    const path = match[0];
    return path.startsWith("\"") || path.startsWith("'") ? path.slice(1, -1) : path;
  });
}

// Standard shell sinks. `cmd > /dev/null` suppresses output, it does not write a
// deliverable anywhere, so treating it as a violation blocks ordinary commands.
const SHELL_SINK_RE = /^\/dev\/(?:null|stdout|stderr|tty)$/;

/** First write target outside the allowed roots, or null when the command is clean. */
function bashWriteViolation(cmd: string): string | null {
  const check = (path: string): boolean => {
    if (WINDOWS_ABSOLUTE_PATH_RE.test(path)) {
      const root = nativeWorkspaceRoot();
      return root !== null && !isWithinNativeWorkspace(path, root);
    }
    if (nativeWorkspaceRoot() && path.startsWith("/workspace")) return true;
    return path.startsWith("/") &&
      !ALLOWED_WRITE_ROOT_RE.test(path) &&
      !SHELL_SINK_RE.test(path);
  };

  for (const m of cmd.matchAll(BASH_ALL_ARG_VERBS)) {
    for (const p of absPathsIn(m[1] ?? "")) if (check(p)) return p;
  }
  for (const m of cmd.matchAll(BASH_LAST_ARG_VERBS)) {
    const paths = absPathsIn(m[1] ?? "");
    const dest = paths[paths.length - 1];
    if (dest && check(dest)) return dest;
  }
  for (const m of cmd.matchAll(BASH_REDIRECT)) {
    const target = m[1] ?? m[2] ?? m[3];
    if (target && check(target)) return target;
  }
  return null;
}

function workspaceWriteViolation(
  tool: string,
  args: Record<string, unknown>,
): string | null {
  if (WORKSPACE_WRITE_TOOLS.has(tool)) {
    const p = extractReadPath(args).replace(/\\/g, "/");
    if (WINDOWS_ABSOLUTE_PATH_RE.test(p)) {
      const root = nativeWorkspaceRoot();
      return root && !isWithinNativeWorkspace(p, root) ? p : null;
    }
    if (nativeWorkspaceRoot() && (p === "/workspace" || p.startsWith("/workspace/"))) return p;
    if (p.startsWith("/") && !ALLOWED_WRITE_ROOT_RE.test(p)) return p;
    return null;
  }
  if (tool === "bash")
    return bashWriteViolation((args.command ?? "") as string);
  return null;
}

// Any reference to a protected data file inside a bash command line.
const BASH_PROTECTED_FILE_RE = /[\w./\\~-]*\.(?:csv|xlsx|xls|parquet|docx)\b/gi;

/**
 * Scans a bash command string for protected data file references and returns
 * the first path that violates the masking contract, or `null` if clean.
 *
 * Prevents the `build` agent from bypassing file protection by reading a raw
 * `.csv`, `.xlsx`, `.xls`, `.parquet`, or `.docx` file directly via bash — for example:
 *   python3 -c "import pandas as pd; df = pd.read_excel('/workspace/original.xlsx')"
 *
 * BLOCKED (returns the offending path):
 *   - Any protected-extension file that is not a pipeline output and not the
 *     exact masked file this session was handed.
 *
 * ALLOWED (skipped, returns null):
 *   - Pipeline outputs: files under `masked_datasets/` or with `_masked.<ext>` basename.
 *   - The exact masked file this session was handed (matched by full path or filename).
 *
 */
function bashRawProtectedFile(
  command: string,
  maskedPath: string | null,
): string | null {
  const maskedBasename = maskedPath ? (maskedPath.split("/").pop() ?? "") : "";
  for (const m of command.matchAll(BASH_PROTECTED_FILE_RE)) {
    const hit = m[0].replace(/\\/g, "/");
    if (isDerivedOutputPath(hit)) continue;
    if (maskedPath && (hit === maskedPath || hit === maskedBasename)) continue;
    return hit;
  }
  return null;
}

// Match local file paths only. URLs should not trigger the file-first rules.
const LOCAL_FILE_RE =
  /(?:^|[\s"'(])(?:\.{1,2}[\/\\]|~[\/\\]|[A-Za-z]:\\|\/)[\w./\\-]+\.([a-z0-9]+)\b/i;

/** Return true if the text contains a protected-capable local file path. */
function hasProtectedExt(text: string): boolean {
  const allPathRe =
    /(?:^|[\s"'(])(?:\.{1,2}[\/\\]|~[\/\\]|[A-Za-z]:\\|\/)[\w./\\-]+\.([a-z0-9]+)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = allPathRe.exec(text)) !== null) {
    if (PROTECTED_EXTS.has(m[1].toLowerCase())) return true;
  }
  return false;
}

// Verbs that mark the path AFTER them as somewhere to put a result, not a
// source to analyse: "save the report to /workspace/out.md". The path must
// follow a destination preposition, so "write a summary of /workspace/notes.md"
// and "create a report from /workspace/sales.csv" still count as inputs.
const OUTPUT_CONTEXT_RE =
  /\b(save|saves|saving|write|writes|writing|export|exports|output|outputs|store|stores|create|creates|generate|generates|put|place)\b[^.!?]{0,40}\b(to|into|as|at|in)\s*["'(]?$/i;

/**
 * Is this path a DESTINATION rather than a data source?
 *
 * The file-first gate exists to stop a session from shipping local data to the
 * web before the protected pipeline has seen it. A path the user names as the
 * place to WRITE the answer carries no such data — and gating on it is a
 * deadlock: web search is blocked until a file is read that does not exist yet.
 * Observed on a research task whose prompt ended "save the report to
 * /workspace/model-comparison.md": every websearch call was refused, and the
 * cloud model then hung on a confirmation nobody could answer.
 *
 * `missingPaths` holds the host paths this session already found missing. The
 * user text is rescanned before every LLM call, so without it a destination the
 * agent has since written would turn into an input mid-turn and close the gate.
 *
 * `truncated` marks a path the pattern cut short: a quoted path stops at a
 * space, an unquoted one at any character outside its class (`+`, `@`, `é`).
 * Its existence check would test a different path, so only the verb counts.
 */
async function isOutputTarget(
  text: string,
  matchIndex: number,
  path: string,
  missingPaths: Set<string>,
  directory: string,
  truncated: boolean,
): Promise<boolean> {
  if (OUTPUT_CONTEXT_RE.test(text.slice(0, matchIndex))) return true;
  if (truncated) return false;
  const resolved = hostPath(path, directory);
  // An unresolvable path cannot be shown to be missing; keep the gate closed.
  if (resolved === null) return false;
  if (missingPaths.has(resolved)) return true;
  if (!(await isMissingFile(resolved))) return false;
  missingPaths.add(resolved);
  return true;
}

// An unquoted path ends where the text after it is a run of closing delimiters
// and sentence punctuation, if any, then whitespace or end of text. A closer
// followed by more name (`report.v2's.csv`, `a)b.csv`) means the match was cut short.
const UNQUOTED_PATH_END_RE = /^[.,;:!?"')\]]*(?:\s|$)/;

/** Return true if the text references a local file to be READ as input. */
async function hasLocalInputFile(
  text: string,
  missingPaths: Set<string>,
  directory: string,
): Promise<boolean> {
  const allPathRe = new RegExp(LOCAL_FILE_RE.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = allPathRe.exec(text)) !== null) {
    // m[0] may carry the leading delimiter the pattern allows before the path.
    const path = m[0].replace(/^[\s"'(]+/, "");
    const quote = /^\s*(["'])/.exec(m[0])?.[1];
    const end = m.index + m[0].length;
    const truncated =
      quote !== undefined
        ? text[end] !== quote
        : !UNQUOTED_PATH_END_RE.test(text.slice(end));
    if (await isOutputTarget(text, m.index, path, missingPaths, directory, truncated)) continue;
    return true;
  }
  return false;
}

// Detects a `bash` command that is being used to fetch the WEB (i.e. as an
// unmanaged substitute for the sc_search_web / websearch-agent path), while
// deliberately NOT matching legitimate local bash use (ls, cat, find, grep,
// reading local files, or hitting localhost/internal services).
//
// Rule: a web-fetch client (curl/wget/http/https-get/python -m http, lynx, etc.)
// AND an external http(s) URL that is not localhost/loopback/RFC1918-internal.
const WEB_FETCH_CLIENT_RE =
  /\b(curl|wget|lynx|w3m|httpie|xh|aria2c|powershell[^|]*invoke-webrequest|iwr|invoke-restmethod|python[0-9.]*\s+-c[^|]*urllib|python[0-9.]*\s+-c[^|]*requests)\b/i;
// An http(s) URL whose host is NOT localhost / loopback / private LAN.
// The internal-host exclusion is anchored to a host terminator ([:/ ] end or
// quote) so a spoof like `https://10.0.0.0.evil.com/...` is NOT treated as
// internal (its host does not end after the 10.x octets) and is still caught
// as an external fetch.
const EXTERNAL_URL_RE =
  /https?:\/\/(?!(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|host\.docker\.internal|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(?:[:/?#]|["'\s`]|$))[^\s"'`]+/i;
// Known search-engine endpoints — treat as web search even if URL heuristics vary.
const SEARCH_ENGINE_RE =
  /\b(duckduckgo\.com|html\.duckduckgo|google\.com\/search|bing\.com\/search|search\.brave\.com|search\.marginalia|lite\.duckduckgo|www\.google\.com|api\.tavily)\b/i;

function isBashWebFetch(command: string): boolean {
  if (!command) return false;
  const hasClient = WEB_FETCH_CLIENT_RE.test(command);
  const hasSearchEngine = SEARCH_ENGINE_RE.test(command);
  const hasExternalUrl = EXTERNAL_URL_RE.test(command);
  // Search-engine host is a strong signal on its own (covers `curl duckduckgo…`).
  if (hasSearchEngine && hasClient) return true;
  // Otherwise require BOTH a fetch client AND an external URL, so local bash
  // (ls/cat/find/grep, localhost curl, internal APIs) is never blocked.
  return hasClient && hasExternalUrl;
}

const WEB_TARGET = "websearch-agent";
const FILE_FIRST_TARGET = "local-file-agent";
const PIPELINE_FIRST_TARGET = "protected-file-agent";

// Agent name for each session, populated by `chat.params`.
const sessionAgent = new Map<string, string>();

// "<providerID>/<model id>" of each session's latest request, populated by
// `chat.params`. The router only escalates `auto` requests to cloud
// (`allow_escalate = (model_alias_requested == "auto")` in
// llmrouter_manager/routing/proxy.py), so a request for llmrouter/local-model
// stays on the user's device (on an Edge machine, the Edge server). Only that
// pin skips the protected-file blocks; `auto` and `cloud-model` never do, and
// /v1/session/{id}/locality (the LAST request's route) is never consulted.
const sessionModel = new Map<string, string>();
const PINNED_LOCAL_MODEL = "llmrouter/local-model";

// The user-facing sensitive/ drop folder. Duplicated (not imported) from
// tools/confirm_file_protection.ts, which shows the dialog for it even on a
// local route; plugin 93 blocks every agent's direct access to it.
const SENSITIVE_FOLDER_PATH_RE = /(?:^|[\/\\\s'"=:(])sensitive(?=[\/\\'"\s;&|)]|$)/i;

function isPinnedLocal(sessionID: string): boolean {
  return sessionModel.get(sessionID) === PINNED_LOCAL_MODEL;
}

// Sessions where the user mentioned a local file. Web search waits until a file
// agent has looked at that file.
const sessionHasLocalFile = new Map<string, boolean>();

// Prompt paths each session found missing when it first saw them, i.e. places
// to write the answer. See isOutputTarget.
const sessionMissingPaths = new Map<string, Set<string>>();

// Sessions where the local file type is supported by the protection pipeline.
const sessionHasProtectedFile = new Map<string, boolean>();

// Build sessions that already received a masked file from protected-file-agent.
const sessionHasMaskedHandoff = new Map<string, boolean>();

// The exact masked file each build session may read.
// This prevents a masked-file exemption from becoming permission to open another
// protected file, including the original source file.
const sessionMaskedFilePath = new Map<string, string>();

// Sessions where a file agent has already been called.
const sessionFileConsulted = new Set<string>();

export const SuperclawDefaultToolGuard: Plugin = async ({ client, directory }) => {
  const sourceAccess = createProtectedSourceAccess(directory ?? "", false);
  await client.app.log({
    body: {
      service: "superclaw-default-guard",
      level: "info",
      message: `Plugin initialised; blocks ${Object.keys(REDIRECT).join(",")} for agent '${PROTECTED_AGENT}' and ${PROTECTED_PIPELINE_TOOL} for agent '${BUILD_AGENT}'`,
    },
  });

  return {
    /**
     * chat.params — fires before every LLM request.
     *
     * Remember which agent owns this session. Later, `tool.execute.before`
     * uses that session-to-agent mapping to decide which guard rules apply.
     * The agent value can arrive as either a string or an object, so the code
     * accepts the common object field names too.
     */
    "chat.params": async (input, _output) => {
      const ag = input.agent as any;
      // Support both string and object-shaped agent values.
      const name =
        typeof ag === "string"
          ? ag
          : (ag?.name ?? ag?.id ?? ag?.type ?? ag?.agent ?? "");
      if (input.sessionID && name) {
        sessionAgent.set(input.sessionID, name);
      }
      // Latest request's model; a missing model records "" (not pinned).
      const model = input.model as { id?: unknown; providerID?: unknown } | undefined;
      if (input.sessionID) {
        sessionModel.set(
          input.sessionID,
          typeof model?.id === "string" && typeof model.providerID === "string"
            ? `${model.providerID}/${model.id}`
            : "",
        );
      }
    },

    /**
     * experimental.chat.messages.transform — fires before each LLM call with
     * the full message history.
     *
     * Scan user messages before tools run. This gives the guard enough context
     * to know whether the session mentioned a local file, a protected file type,
     * or a masked-file handoff from the protection pipeline.
     */
    "experimental.chat.messages.transform": async (
      _input: any,
      output: any,
    ) => {
      const messages = output?.messages;
      if (!Array.isArray(messages) || messages.length === 0) return;

      // Use the latest message to identify the session being transformed.
      const sid = messages[messages.length - 1]?.info?.sessionID;
      if (!sid) return;

      // Scan all user text in the session, not just the most recent turn.
      let userText = "";
      for (const msg of messages) {
        if (msg?.info?.role !== "user") continue;
        for (const part of msg?.parts ?? []) {
          if (part?.type === "text" && typeof part.text === "string") {
            userText += " " + part.text;
          }
        }
      }

      // These flags are sticky for the session.

      // Flag 1: Did the user name a local file to READ? A path given only as
      // the place to save the answer must not gate web search (#3726).
      if (!sessionHasLocalFile.get(sid)) {
        let missingPaths = sessionMissingPaths.get(sid);
        if (!missingPaths) sessionMissingPaths.set(sid, (missingPaths = new Set<string>()));
        if (await hasLocalInputFile(userText, missingPaths, directory ?? "")) {
          sessionHasLocalFile.set(sid, true);
        }
      }

      // Flag 2: Did a masked file arrive from the protection pipeline?
      if (!sessionHasMaskedHandoff.get(sid) && hasMaskedFileHandoff(userText)) {
        sessionHasMaskedHandoff.set(sid, true);
        const maskedPath = extractMaskedFilePath(userText);
        if (maskedPath) sessionMaskedFilePath.set(sid, maskedPath);
      }

      // Flag 3: Is that local file a protected-capable type (.csv, .xlsx, .md, etc.)?
      if (!sessionHasProtectedFile.get(sid) && hasProtectedExt(userText)) {
        sessionHasProtectedFile.set(sid, true);
      }
    },

    /**
     * tool.execute.before — fires before EVERY tool call across all sessions.
     *
     * This is the actual enforcement point. Build-agent checks run first so
     * nested protected-file sessions cannot bypass masking. Then the
     * `superclaw-default` checks enforce the high-level routing contract:
     * approve protection before protected files, consult local files before web
     * search, and delegate only to allowed subagents.
     */
    "tool.execute.before": async (input, _output) => {
      const agent = sessionAgent.get(input.sessionID);

      // Enforce the host-visible workspace for every agent, including subagents.
      {
        const wArgs = ((_output as any).args ?? {}) as Record<string, unknown>;
        const violation = workspaceWriteViolation(input.tool, wArgs);
        if (violation) {
          await client.app.log({
            body: {
              service: "superclaw-default-guard",
              level: "warn",
              message: `Blocked non-workspace write tool='${input.tool}' agent='${agent ?? "?"}' target='${violation.slice(0, 120)}' sessionID=...${input.sessionID.slice(-12)}`,
            },
          });
          throw new Error(
            `BLOCKED: writing outside the workspace (target: ${violation.slice(0, 120)}).\n` +
              `Required next action: re-issue this operation with the file placed under ${nativeWorkspaceRoot() ?? "/workspace"}. ` +
              `Do not retry the blocked path with any other tool, and do not delegate the same path to a subagent.`,
          );
        }
      }

      // Build already has a masked file. It must analyze that file directly,
      // not send it back through protection or another file-analysis agent.
      if (
        agent === BUILD_AGENT &&
        sessionHasMaskedHandoff.get(input.sessionID)
      ) {
        const state = ((_output as any).args ?? {}) as Record<string, unknown>;
        const sub =
          (state.subagent_type as string) ?? (state.agent as string) ?? "";
        const isReentry =
          input.tool === "confirm_file_protection" ||
          input.tool === PROTECTED_PIPELINE_TOOL ||
          (input.tool === "task" &&
            [PIPELINE_FIRST_TARGET, FILE_FIRST_TARGET, BUILD_AGENT].includes(
              sub,
            ));
        if (isReentry) {
          await client.app.log({
            body: {
              service: "superclaw-default-guard",
              level: "warn",
              message: `Blocked build masked-file re-entry tool='${input.tool}' sub='${sub}' sessionID=...${input.sessionID.slice(-12)}`,
            },
          });
          throw new Error(
            "This file has ALREADY been protected and masked by the pipeline. " +
              "Do NOT call confirm_file_protection, run_protected_file_pipeline, or delegate to another file-analysis agent. " +
              "Analyze the provided masked_file_path directly with build's own tools and return the full response text.",
          );
        }
      }

      // Scheduler tools cannot read files. During a masked-file handoff they are
      // never the right call, but `run_job` scores high on "run the analysis" for
      // weak models, which then loop on a fabricated job name until the step
      // horizon fires. Redirect to the tool that actually works.
      if (
        agent === BUILD_AGENT &&
        sessionHasMaskedHandoff.get(input.sessionID) &&
        SCHEDULER_TOOLS.has(input.tool)
      ) {
        const maskedPath = sessionMaskedFilePath.get(input.sessionID);
        await client.app.log({
          body: {
            service: "superclaw-default-guard",
            level: "warn",
            message: `Blocked build scheduler tool='${input.tool}' during masked handoff sessionID=...${input.sessionID.slice(-12)}`,
          },
        });
        throw new Error(
          `BLOCKED: '${input.tool}' cannot analyze a file. Scheduler tools only trigger jobs the user registered in advance; no such job exists here.\n` +
            `Required next action: emit a single 'bash' call running python3, e.g. ` +
            `python3 -c "import pandas as pd; df = pd.read_excel('${maskedPath ?? "<masked_file_path>"}'); print(df.columns.tolist()); print(df.head())"\n` +
            `pandas and openpyxl are installed. Do NOT retry '${input.tool}' or any other scheduler tool for this task.`,
        );
      }

      // `build` cannot run the protection tool itself. It must delegate that
      // work to protected-file-agent so the full pipeline state is preserved.
      if (agent === BUILD_AGENT && input.tool === PROTECTED_PIPELINE_TOOL) {
        await client.app.log({
          body: {
            service: "superclaw-default-guard",
            level: "warn",
            message: `Blocked tool='${input.tool}' agent='${agent}' sessionID=...${input.sessionID.slice(-12)} callID=${input.callID.slice(0, 10)}`,
          },
        });
        throw new Error(
          `BLOCKED: '${PROTECTED_PIPELINE_TOOL}' is not callable from the build agent.\n` +
            `Required next action: emit a single tool call with name="task" and ` +
            `arguments {"subagent_type": "${PROTECTED_PIPELINE_AGENT}", "description": "Protected file processing", "prompt": "<the full original user request, verbatim>"}.\n` +
            `Do not retry '${PROTECTED_PIPELINE_TOOL}'. Do not emit reasoning or partial answers. ` +
            `Your immediate next output MUST be the task() call described above.`,
        );
      }

      // `build` should not bypass protection by sending protected files to
      // local-file-agent. The only exception is the user's explicit decline.
      if (agent === BUILD_AGENT && input.tool === "task") {
        const state = ((_output as any).args ?? {}) as Record<string, unknown>;
        const sub =
          (state.subagent_type as string) ?? (state.agent as string) ?? "";
        if (sub === FILE_FIRST_TARGET) {
          const denied = deniedSessions();
          // The decline is a one-time fallback token; consume it when used.
          if (denied.has(input.sessionID)) {
            denied.delete(input.sessionID);
            declineFallbackParents().add(input.sessionID);
            return;
          }

          await client.app.log({
            body: {
              service: "superclaw-default-guard",
              level: "warn",
              message: `Blocked build task('local-file-agent') before protected confirmation denial agent='${agent}' sessionID=...${input.sessionID.slice(-12)} callID=${input.callID.slice(0, 10)}`,
            },
          });
          throw new Error(
            `BLOCKED: build agent must not delegate to '${FILE_FIRST_TARGET}'.\n` +
              `Required next action — pick the one that matches this task:\n` +
              `  1. If you were handed a masked_file_path, analyze that file directly with your own tools and return the full response text.\n` +
              `  2. If this is a protected-capable file you have not yet gotten approval for, call confirm_file_protection first. If APPROVED → task('${PIPELINE_FIRST_TARGET}', ...). If ACTION_DENIED → task('${FILE_FIRST_TARGET}', ...) is allowed once as the fallback.\n` +
              `Do not retry task('${FILE_FIRST_TARGET}', ...) until one of those two conditions is met.`,
          );
        }
      }

      // Do not let `build` use bash to inspect the mask registry path. Those
      // files can reveal original PII values outside the restore backend.
      if (agent === BUILD_AGENT && input.tool === "bash") {
        const cmd =
          ((((_output as any).args ?? {}) as Record<string, unknown>)
            .command as string) ?? "";
        if (isMaskRegistryPath(cmd)) {
          await client.app.log({
            body: {
              service: "superclaw-default-guard",
              level: "warn",
              message: `Blocked build bash accessing mask_registries sessionID=...${input.sessionID.slice(-12)}`,
            },
          });
          throw new Error(
            "BLOCKED: build agent must not access the mask registry directory directly, via bash.\n" +
              "Required next action: continue analyzing only the masked file you were given, and keep every placeholder in <CATEGORY_N> form.\n" +
              "Do NOT retry this command against the mask registry path.",
          );
        }

        // A build session holding a masked file must analyze THAT file. `bash`
        // is not covered by read/external_directory denies, so this is the only
        // place a `python3 ... read_excel('/workspace/original.xlsx')` (or a
        // spreadsheet-skill recipe run against the original path carried in the
        // forwarded user request) is stopped.
        if (sessionHasMaskedHandoff.get(input.sessionID)) {
          const maskedPath = sessionMaskedFilePath.get(input.sessionID) ?? null;
          const rawFile = bashRawProtectedFile(cmd, maskedPath);
          if (rawFile) {
            await client.app.log({
              body: {
                service: "superclaw-default-guard",
                level: "warn",
                message: `Blocked build bash on raw protected file='${rawFile.slice(0, 120)}' during masked handoff sessionID=...${input.sessionID.slice(-12)}`,
              },
            });
            throw new Error(
              `BLOCKED: '${rawFile.slice(0, 120)}' is the ORIGINAL unmasked file, not the masked file you were given.\n` +
                (maskedPath
                  ? `Required next action: re-run this command against ${maskedPath} instead.\n`
                  : `Required next action: re-run this command against the masked_file_path from the handoff message instead.\n`) +
                `Do NOT open the original file by any path, and do NOT call confirm_file_protection or run_protected_file_pipeline. ` +
                `Keep every placeholder in <CATEGORY_N> form in your answer.`,
            );
          }
        }
      }

      // The same registry rule applies to structured read() calls.
      if (agent === BUILD_AGENT && input.tool === "read") {
        const rPath = extractReadPath(
          ((_output as any).args ?? {}) as Record<string, unknown>,
        );
        if (isMaskRegistryPath(rPath)) {
          await client.app.log({
            body: {
              service: "superclaw-default-guard",
              level: "warn",
              message: `Blocked build read(mask_registries) sessionID=...${input.sessionID.slice(-12)}`,
            },
          });
          throw new Error(
            "BLOCKED: build agent must not read the mask registry directory directly.\n" +
              "Required next action: continue analyzing only the masked file you were given, and keep every placeholder in <CATEGORY_N> form.\n" +
              "Do NOT retry 'read' against the mask registry path.",
          );
        }
      }

      // The same registry rule applies to structured glob() / list() / grep() calls.
      if (agent === BUILD_AGENT && ["glob", "list", "grep"].includes(input.tool)) {
        const gArgs = ((_output as any).args ?? {}) as Record<string, unknown>;
        const probe =
          input.tool === "glob"
            ? ((gArgs.pattern as string) ?? "")
            : extractReadPath(gArgs);
        if (probe && isMaskRegistryPath(probe)) {
          await client.app.log({
            body: {
              service: "superclaw-default-guard",
              level: "warn",
              message: `Blocked build ${input.tool}(mask_registries) sessionID=...${input.sessionID.slice(-12)}`,
            },
          });
          throw new Error(
            `BLOCKED: build agent must not access the mask registry directory directly, via ${input.tool}.\n` +
              "Required next action: continue analyzing only the masked file you were given, and keep every placeholder in <CATEGORY_N> form.\n" +
              `Do NOT retry '${input.tool}' against the mask registry path.`,
          );
        }
      }

      // `build` may read the exact masked file it was handed, but not another
      // raw protected data file from the workspace.
      if (agent === BUILD_AGENT && input.tool === "read") {
        const rArgs = ((_output as any).args ?? {}) as Record<string, unknown>;
        const rExt = fileExt(extractReadPath(rArgs));
        if (BUILD_READ_BLOCKED_EXTS.has(rExt)) {
          // The exemption is path-specific so the original file cannot slip
          // through just because it has the same protected extension.
          const maskedPath = sessionMaskedFilePath.get(input.sessionID);
          const requestedPath = extractReadPath(rArgs).replace(/\\/g, "/");
          if (maskedPath && requestedPath === maskedPath) return;
          // A multi-file handoff (one run_protected_file_pipeline call over
          // several source paths) only remembers the FIRST masked_file_path
          // above, so any other masked file must instead be recognized by
          // its masked_datasets/** location — same exemption bash already gets.
          if (isDerivedOutputPath(requestedPath)) return;

          await client.app.log({
            body: {
              service: "superclaw-default-guard",
              level: "warn",
              message: `Blocked build read(.${rExt}) agent='${agent}' sessionID=...${input.sessionID.slice(-12)}`,
            },
          });
          throw new Error(
            `BLOCKED: direct 'read' of a protected data file (.${rExt}).\n` +
              (maskedPath
                ? `Only the exact masked file you were given (${maskedPath}) may be read — this path does not match it.\n`
                : `If protected-file-agent provided a masked_file_path, use the appropriate analysis tool on it — not raw 'read'.\n`) +
              `If this is an original user file, call confirm_file_protection first, then task('${PIPELINE_FIRST_TARGET}', ...).\n` +
              `Do NOT retry 'read'. Follow the correct pipeline.`,
          );
        }
      }

      // The rest of the rules only apply to the primary routing agent.
      if (agent !== PROTECTED_AGENT) return;

      const sourceViolation = await sourceAccess.before(
        input, (_output.args ?? {}) as Record<string, unknown>, isPinnedLocal(input.sessionID),
      );
      if (sourceViolation) {
        await client.app.log({
          body: { service: "superclaw-default-guard", level: "warn", message: sourceViolation },
        });
        throw new Error(sourceViolation);
      }

      // superclaw-default must not reach the mask registry directly.
      // Registry entries are JSON, so the protected-extension checks below
      // (read, bash) never match them — this needs its own path-based check.
      // Also covers glob/list/grep, which otherwise have no guard at all for
      // this agent: a bare `list({path: ".../mask_registries"})`,
      // `glob({pattern: "**/mask_registries/**"})`, or
      // `grep({path: ".../mask_registries", pattern: "..."})` would currently
      // pass through.
      if (["bash", "read", "glob", "list", "grep"].includes(input.tool)) {
        const rArgs = ((_output as any).args ?? {}) as Record<string, unknown>;
        const probe =
          input.tool === "bash"
            ? ((rArgs.command as string) ?? "")
            : input.tool === "glob"
              ? ((rArgs.pattern as string) ?? "")
              : extractReadPath(rArgs);
        if (probe && isMaskRegistryPath(probe)) {
          await client.app.log({
            body: {
              service: "superclaw-default-guard",
              level: "warn",
              message: `Blocked mask_registries access via tool='${input.tool}' agent='${agent}' sessionID=...${input.sessionID.slice(-12)}`,
            },
          });
          throw new Error(
            "BLOCKED: superclaw-default must not access the mask registry directly, via bash, read, glob, list, or grep.\n" +
              "Required next action: if this request is about a protected file, call confirm_file_protection with the original user request. " +
              "Do NOT retry this tool call against the mask registry path.",
          );
        }
      }

      // superclaw-default has `bash` for LOCAL operations (listing files,
      // reading local paths, etc.) but has NO web access — web search must be
      // delegated to websearch-agent. Weak models sometimes bypass that by
      // running `curl`/`wget` against the open web (or a search engine),
      // which is unmanaged, hits CAPTCHAs, and returns junk. Block ONLY that
      // shape; legitimate local bash (ls/cat/find/grep, localhost curl,
      // internal APIs) is never matched by isBashWebFetch and passes through.
      if (input.tool === "bash") {
        const cmd =
          ((((_output as any).args ?? {}) as Record<string, unknown>)
            .command as string) ?? "";
        if (isBashWebFetch(cmd)) {
          await client.app.log({
            body: {
              service: "superclaw-default-guard",
              level: "warn",
              message: `Blocked superclaw-default bash web-fetch sessionID=...${input.sessionID.slice(-12)} callID=${input.callID.slice(0, 10)}`,
            },
          });
          throw new Error(
            `BLOCKED: fetching the web via 'bash' (curl/wget/etc.) is not allowed from this agent.\n` +
              `You have NO direct web access; unmanaged web fetches hit CAPTCHAs and return unreliable data.\n` +
              `Required next action: emit a single tool call with name="task" and ` +
              `arguments {"subagent_type": "${WEB_TARGET}", "description": "<short title>", "prompt": "<the full web question, verbatim>"}.\n` +
              `Do NOT retry 'bash' for this. Do NOT answer from memory or fabricate. ` +
              `Your immediate next output MUST be the task(subagent_type="${WEB_TARGET}") call. ` +
              `(Local bash for files — ls, cat, reading local paths — is still fine.)`,
          );
        }
      }

      // Redirect any primary-agent-only blocked tool to the subagent that is
      // allowed to perform that work.
      const redirectTo = REDIRECT[input.tool];
      if (redirectTo) {
        await client.app.log({
          body: {
            service: "superclaw-default-guard",
            level: "warn",
            message: `Blocked tool='${input.tool}' agent='${agent}' sessionID=...${input.sessionID.slice(-12)} callID=${input.callID.slice(0, 10)}`,
          },
        });
        throw new Error(
          `BLOCKED: '${input.tool}' is not callable from this agent.\n` +
            `Required next action: emit a single tool call with name="task" and ` +
            `arguments {"subagent_type": "${redirectTo}", "description": "<short title>", "prompt": "<the full original user request, verbatim>"}.\n` +
            `Do not retry '${input.tool}'. Do not emit reasoning or partial answers. ` +
            `Your immediate next output MUST be the task() call described above.`,
        );
      }

      // Only approved subagents may be called from superclaw-default.
      if (input.tool === "task") {
        const state = ((_output as any).args ?? {}) as Record<string, unknown>;
        const sub =
          (state.subagent_type as string) ?? (state.agent as string) ?? "";
        if (sub && !ALLOWED_TASK_TARGETS.has(sub)) {
          await client.app.log({
            body: {
              service: "superclaw-default-guard",
              level: "warn",
              message: `Blocked task subagent='${sub}' agent='${agent}' sessionID=...${input.sessionID.slice(-12)} callID=${input.callID.slice(0, 10)}`,
            },
          });
          throw new Error(
            `BLOCKED: task('${sub}', ...) is not in this agent's allow-list.\n` +
              `Allowed task subagents: ${[...ALLOWED_TASK_TARGETS].join(", ")}.\n` +
              `Required next action: re-emit the task call with name="task" and ` +
              `arguments {"subagent_type": "<one of the allowed names above>", ` +
              `"description": "<short title>", "prompt": "<same prompt>"}.\n` +
              `Do not retry with '${sub}'. Do not emit reasoning.`,
          );
        }

        // Protected-capable files cannot go straight to local-file-agent unless
        // the user has already declined protection for this session.
        if (
          sub === FILE_FIRST_TARGET &&
          sessionHasProtectedFile.get(input.sessionID) &&
          !(await protectionOff())
        ) {
          const denied = deniedSessions();
          if (denied.has(input.sessionID)) {
            // Use the decline once, then require confirmation again next time.
            denied.delete(input.sessionID);
            declineFallbackParents().add(input.sessionID);
          } else if (
            !isPinnedLocal(input.sessionID) ||
            SENSITIVE_FOLDER_PATH_RE.test(String(state.prompt ?? ""))
          ) {
            // Pinned to local-model, confirm_file_protection could only answer
            // PROTECTION_DISABLED, so the dispatch goes through without it,
            // except for sensitive/ files, which it still sends to the dialog.
            await client.app.log({
              body: {
                service: "superclaw-default-guard",
                level: "warn",
                message: `Blocked task('local-file-agent') before protected confirmation agent='${agent}' sessionID=...${input.sessionID.slice(-12)}`,
              },
            });
            throw new Error(
              `BLOCKED: task('${FILE_FIRST_TARGET}', ...) for a file type supported by the protected pipeline.\n` +
                `Files with extensions .csv, .xlsx, .xls, .parquet, .txt, .md, .html, .htm, .docx must request ` +
                `protected-pipeline approval before using the non-protected fallback.\n` +
                `Required next action:\n` +
                `  1. Call confirm_file_protection with the original user request.\n` +
                `  2. If approved, emit task(subagent_type="${PIPELINE_FIRST_TARGET}", ...).\n` +
                `  3. If declined, emit task(subagent_type="${FILE_FIRST_TARGET}", ...) as the fallback.\n` +
                `Do NOT call task('${FILE_FIRST_TARGET}', ...) before the user declines.`,
            );
          }
        }

        // Once a file agent has been called, web search is allowed later.
        if (sub === FILE_FIRST_TARGET || sub === PIPELINE_FIRST_TARGET) {
          sessionFileConsulted.add(input.sessionID);
        } else if (
          // A request with a local file must inspect that file before web search.
          sub === WEB_TARGET &&
          sessionHasLocalFile.get(input.sessionID) &&
          !sessionFileConsulted.has(input.sessionID)
        ) {
          await client.app.log({
            body: {
              service: "superclaw-default-guard",
              level: "warn",
              message: `Blocked premature websearch (file-first gate) agent='${agent}' sessionID=...${input.sessionID.slice(-12)} callID=${input.callID.slice(0, 10)}`,
            },
          });
          const fileAgent =
            sessionHasProtectedFile.get(input.sessionID) &&
            !deniedSessions().has(input.sessionID)
              ? PIPELINE_FIRST_TARGET
              : FILE_FIRST_TARGET;
          throw new Error(
            `BLOCKED: task('${WEB_TARGET}', ...) before the local file was read.\n` +
              `This request references a local data file. The PRIMARY data source is on disk and must be analysed first.\n` +
              `Required next action: emit a single tool call with name="task" and ` +
              `arguments {"subagent_type": "${fileAgent}", "description": ` +
              `"<short title>", "prompt": "<the full original user request, verbatim, including the file path>"}.\n` +
              `After ${fileAgent} returns, if (and only if) the file genuinely lacks the needed information, ` +
              `you may then task('${WEB_TARGET}', ...).\n` +
              `Do not retry ${WEB_TARGET} now. Do not emit reasoning.`,
          );
        }
      }
    },

    /**
     * tool.execute.after — fires after a tool call completed.
     *
     * Record the file a `superclaw-default` write/edit just produced, with its
     * on-disk stamp, so reading it back is not blocked by the shared source policy.
     */
    "tool.execute.after": async (input, _output) => {
      sourceAccess.after(input);
    },
  };
};

// opencode loads every export of this module as a plugin, so a bare helper export is invoked
// as a plugin factory and fails the whole file. The helpers ride on the plugin function
// instead; unit tests read them off the default export.
export default Object.assign(SuperclawDefaultToolGuard, { isBashWebFetch });

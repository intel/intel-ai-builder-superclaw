/**
 * Keeps `protected-file-agent` in the protected-file pipeline sequence.
 *
 * A protected-file request is expected to do one pass through this flow:
 *   1. Mask the source file with `run_protected_file_pipeline`.
 *   2. Send only the masked file to the `build` agent for analysis.
 *   3. Wrap the build result in a restore envelope.
 *   4. Stop the session once that result is ready.
 *
 * OpenCode only sees masked text, while the OpenWork `/message` overlay 
 * restores PII for display before the UI receives the response. 
 * The agent transcript is not rewritten with restored PII.
 *
 * If masking fails, the session becomes terminal immediately. The agent must
 * report the failure instead of delegating to build or trying another tool path.
 *
 * Guard summary:
 *   REENTRY. Nested build sessions may not re-enter protection or delegate the
 *     same file back to another file-analysis agent.
 *
 *   REGISTRY_ACCESS. NO agent may reach the mask registry through bash,
 *     read, glob, list, or grep. Agent-agnostic: the registry resolves to
 *     unmasked PII and has no legitimate in-agent reader.
 *
 *   SENSITIVE_FOLDER_ACCESS. NO agent may open any file under the
 *     user-facing `sensitive/` drop folder (SuperClawProjects/sensitive,
 *     mounted at /workspace/sensitive) through bash, read, glob, list, or
 *     grep. That folder is only reachable through protected-file-agent's
 *     masking pipeline. Mirrored by external_directory deny rules in
 *     opencode.jsonc.
 *
 *   ORIGINAL_FILE_ACCESS. Build sessions may not open the original (pre-mask)
 *     source file through bash, grep, or file tools. Fires for any
 *     agent='build' session against every source_file_path ever captured
 *     from a successful pipeline run, across all sessions.
 *
 *   FILE_TOO_LARGE_STOP. Once any session's task() to protected-file-agent
 *     comes back reporting the source file is too large for the pipeline,
 *     the raw-file fallback tools are blocked so the calling agent cannot
 *     fall back to bash/write/python on the raw file. Not permanent: a fresh
 *     protected-file request (a new task to protected-file-agent) in the same
 *     session clears the flag, so a later smaller file still works.
 *
 *   LOOP_BREAKER. Breaks a weak build model out of an identical-bash-command
 *     loop by forcing a final answer after too many repeats.
 *
 *   SKILL_FALLBACK. A build session that received a pipeline failure may not
 *     fall back to a skill. It must report the protected-pipeline failure.
 *
 *   SINGLE_PIPELINE_CALL. `protected-file-agent` may run the pipeline only
 *     once per request.
 *
 *   TERMINAL. Once the protected session is terminal, all later tool calls
 *     are blocked.
 *
 *   BUILD_HANDOFF. Build delegation is tracked, and the captured original
 *     user request — with any real entity values rewritten to their
 *     registry placeholders (e.g. "Alice" -> "<PERSON_1>") — is forwarded
 *     with the masked-file handoff.
 *
 *   OUTPUT_RESTORE. Any file under /workspace that changes while build holds
 *     a masked handoff is restored on disk (placeholders -> real values) once
 *     build's task() call has fully completed — never while build's own
 *     session is still active, so build itself never reads its own restored
 *     output back into agent context. Detected by modified-time, not by
 *     which tool wrote it, since build commonly writes output files via
 *     bash/python rather than the write/edit tools.
 */
import type { Plugin } from "@opencode-ai/plugin";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";

declare const process: { env: Record<string, string | undefined> };

const PIPELINE_AGENT = "protected-file-agent";
const PIPELINE_TOOL = "run_protected_file_pipeline";
const BUILD_AGENT = "build";
const MASKED_HANDOFF_MARKER = "This file has ALREADY been protected and masked by the pipeline.";
const MASKED_HANDOFF_MARKER_PLURAL = "These files have ALREADY been protected and masked by the pipeline.";

// Type marker for task results that need display-time PII restore.
// OpenCode keeps this envelope in the transcript; OpenWork restores it only
// on the response path to the UI.
const PROTECTED_PIPELINE_RESULT_TYPE = "protected_pipeline_result" as const;

// ── Session state ──────────────────────────────────────────────────────────────

// Maps sessionID → agent name, populated by `chat.params`.
const sessionAgent = new Map<string, string>();

// Build sessions where run_protected_file_pipeline returned { "success": false }.
// These sessions must not attempt any skill fallback.
const buildPipelineFailed = new Set<string>();

// callIDs of task('build') calls made by protected-file-agent.
// Used to correlate in `tool.execute.after` so we know when the build task finishes.
const buildTaskCalls = new Set<string>();

// task('build') callID -> the time the handoff was accepted. This is a fallback
// for OUTPUT_RESTORE when the runtime does not deliver the child session.created
// event that normally records the more precise child-session start time.
const buildTaskStartedAt = new Map<string, number>();

// Fallback correlation when a completed task loses the original call ID.
const sessionBuildStartedAt = new Map<string, number>();

// callIDs of task('protected-file-agent') calls made by any agent. The
// before-hook reliably receives task args; the after-hook only needs this ID
// to recognize an oversized protected-pipeline result.
const protectedPipelineTaskCalls = new Set<string>();

// Protected-file-agent sessions that completed the only trusted result path:
// successful protection, a guard-injected masked build handoff, then a
// completed build result wrapped for display restore. Parent task() results
// without this receipt are model prose, not verified file analysis.
const verifiedProtectedAnalysisSessions = new Set<string>();

// The exact envelope text written at buildDone, keyed by protected-file-agent
// session ID. If that session later burns its own step budget retrying tool
// calls after TERMINAL, OpenCode's step-limit handler overwrites its final
// message with generic "MAXIMUM STEPS REACHED" text -- losing the envelope
// this plugin already produced. The parent's task() after-hook re-injects
// this cached copy so the correct, already-restored result still reaches the
// user instead of a false failure report.
const sessionFinalEnvelope = new Map<string, string>();

// Restore identifiers plus source/masked paths captured from a successful
// run_protected_file_pipeline call (one entry per protected file, since a
// single call may cover several files via source_file_paths), keyed by the
// protected-file-agent session that owns them.
type ProtectedFileOperationInfo = {
  operationId: string;
  operationSessionId: string | null;
  sourceFilePath: string | null;
  maskedFilePath: string | null;
};
const sessionOperationInfo = new Map<string, ProtectedFileOperationInfo[]>();

type ToolExecutionHookInput = {
  sessionID: string;
  tool: string;
  callID: string;
  args?: unknown;
};

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Sessions that are fully done: restore envelope written, restore unavailable, or pipeline failed.
// Any further tool call by the agent is blocked.
const sessionTerminal = new Set<string>();

// Sessions that already received one "you are done" error but tried to call
// another tool anyway. The second block uses a harder error (no logging noise).
const sessionTripped = new Set<string>();

// Build sessions spawned via task(subagent_type='build') from a protected-file-agent
// session. These already received a masked file and must NOT re-enter the
// protection workflow (confirm_file_protection, or delegating back to
// protected-file-agent / local-file-agent / build for the same file).
const nestedBuildSessions = new Set<string>();

// Build session ID -> the epoch ms it was created. Guard OUTPUT_RESTORE scans
// /workspace for files modified after this timestamp once the session's
// task() call completes, rather than tracking specific tool calls — build
// commonly writes output files via bash/python, not the write/edit tools.
const nestedBuildSessionStartedAt = new Map<string, number>();

// Paths OUTPUT_RESTORE has scanned as build-authored deliverables (e.g. a
// synthesized report), keyed on globalThis so 90_superclaw_default_tool_guard.ts
// (a separate module instance in the same opencode process) can see them too.
// A file here was produced/modified during a completed build session, so it
// is never an original PII source file and must not be routed back through
// confirm_file_protection when the calling agent reads it back.
//
// Value is the epoch ms the path was recorded, not just presence: this map is
// never scoped to one session or cleared, so without an expiry a path stays
// "trusted" forever — a later, unrelated request could overwrite that exact
// filename with a genuinely raw sensitive file and still slip past the guard.
const OUTPUT_RESTORED_PATHS_KEY = "__sc_output_restored_paths";
const OUTPUT_RESTORED_PATH_TTL_MS =
  Number(process.env.SC_OUTPUT_RESTORED_PATH_TTL_MS) || 30 * 60 * 1000;
function outputRestoredPaths(): Map<string, number> {
  const g = globalThis as unknown as Record<string, Map<string, number> | undefined>;
  return (g[OUTPUT_RESTORED_PATHS_KEY] ??= new Map<string, number>());
}
/** Record a path as build-authored output now, pruning anything already past TTL. */
function markOutputRestoredPath(path: string): void {
  const paths = outputRestoredPaths();
  const now = Date.now();
  for (const [existing, addedAt] of paths) {
    if (now - addedAt >= OUTPUT_RESTORED_PATH_TTL_MS) paths.delete(existing);
  }
  paths.set(path, now);
}

// PERSISTENT generated-output registry. The in-memory map above only survives
// within one process lifetime (and expires by TTL), so a report generated in an
// earlier session/container is not recognized on read-back. This on-disk JSON
// list is the durable provenance record: a path here was PRODUCED by build, so
// it is a derived output — safe for any agent to read — regardless of age.
//
// Location deliberately sits under mask_registries/: that path segment is
// already blocked from ALL agents (bash/read/glob/list/grep in the
// REGISTRY_ACCESS guard below, now also write/edit/patch), so an agent cannot
// forge an entry to whitelist a raw sensitive file. Only this plugin, via a
// direct fs write (not an agent tool), can append to it. The list stores paths
// only (never PII), so its own contents are not sensitive.
const GENERATED_OUTPUTS_MAX = 1000;
function generatedOutputsRegistryPath(): string {
  const override = process.env.SC_GENERATED_OUTPUTS_REGISTRY?.trim();
  if (override) return override;
  return `${outputRestoreScanRoot()}/data_protection_workspace/mask_registries/.generated_outputs.json`;
}
/** Append a generated-output path to the persistent registry (best-effort, never throws). */
function recordGeneratedOutputPath(path: string): void {
  try {
    const registryPath = generatedOutputsRegistryPath();
    const dir = registryPath.slice(0, Math.max(registryPath.lastIndexOf("/"), registryPath.lastIndexOf("\\")));
    if (dir) mkdirSync(dir, { recursive: true });
    let paths: string[] = [];
    try {
      const parsed = JSON.parse(readFileSync(registryPath, "utf-8"));
      if (Array.isArray(parsed?.paths)) {
        paths = parsed.paths.filter((p: unknown): p is string => typeof p === "string");
      }
    } catch {
      // Missing or corrupt registry — start a fresh list.
    }
    if (paths.includes(path)) return;
    paths.push(path);
    if (paths.length > GENERATED_OUTPUTS_MAX) paths = paths.slice(-GENERATED_OUTPUTS_MAX);
    writeFileSync(registryPath, JSON.stringify({ paths }), "utf-8");
  } catch {
    // Registry is a best-effort convenience; a write failure just means a later
    // cross-session read falls back to the normal protection prompt.
  }
}

// protected-file-agent sessions that have already started the pipeline.
// Recording this before the tool runs lets us reject duplicate calls in the
// same model turn.
const sessionPipelineRan = new Set<string>();

// Tool-side rejections raised BEFORE any backend request: nothing was masked and
// no operation exists, so the corrected retry must not count as a duplicate.
// A timeout or network error is deliberately excluded — the backend may already
// be masking, so those still consume the single-call budget.
const PREFLIGHT_REJECTION_CODES = new Set(["empty_source_file_path", "source_is_derived_output"]);

// Sessions where a second run_protected_file_pipeline call was actually
// rejected. The reactive throw alone let a weak model retry the same blocked
// call every turn without ever calling task(build) — this drives the
// experimental.chat.system.transform nudge that tells it to stop and proceed.
const sessionDuplicatePipelineAttempted = new Set<string>();

// First user request seen in each protected-file-agent session. Guard BUILD_HANDOFF
// forwards this to build so the handoff preserves the user's wording.
const sessionOriginalRequest = new Map<string, string>();

// Every source_file_path ever passed to run_protected_file_pipeline, across
// ALL protected-file-agent sessions. Registered synchronously in
// tool.execute.before, the moment the call is made — BEFORE the pipeline
// resolves — not only after a successful result. This closes two gaps: (1) a
// parallel/same-turn task('build') call racing the pipeline's own (up to
// 4-minute) network round trip would otherwise reach build before the
// after-hook ever runs; (2) a pipeline call that fails or times out would
// otherwise never register the raw path at all, leaving it permanently
// unguarded for any later 'build' session. Guard ORIGINAL_FILE_ACCESS checks
// this set unconditionally for every 'build' session so an original file is
// never readable, independent of nested-session tracking or pipeline outcome.
// Entries are never removed: over-blocking a coincidental path match is the
// safe failure mode for a security boundary.
const knownSourceFilePaths = new Set<string>();

// Sessions (any agent) whose task() to protected-file-agent reported the
// source file was too large for the pipeline. While set, Guard
// FILE_TOO_LARGE_STOP blocks the raw-file fallback tools. Cleared when a fresh
// task(protected-file-agent) starts in the same session, so a later
// differently-sized file is not penalized for an earlier file's failure.
const sessionFileTooLarge = new Set<string>();

// Parent sessions whose protected-file-agent task returned without a verified
// completion receipt. Block all same-turn follow-up tools, including
// todowrite, until a fresh protected-file request begins.
const sessionUnverifiedProtectedAnalysis = new Set<string>();

// Parent sessions that received a VERIFIED protected-file result this user turn.
// The analysis and any output file are done, so the parent must present that
// result and stop — never re-run the pipeline or re-delegate. Reset on a new
// user turn or a new confirm_file_protection (a new request).
const parentProtectedResolved = new Set<string>();

// Exact masked build text for a parent session whose protected result is ready.
// This lets the final parent turn copy the result instead of echoing a generic
// present-and-stop instruction.
const parentProtectedResultText = new Map<string, string>();

// Last user-message id seen per parent session. A change means a NEW user turn,
// which clears the per-turn protected flags (resolved / unverified) so a later
// request is not blocked or nudged by the previous one.
const sessionLastUserMessageId = new Map<string, string>();

// Matches both the tool's own 413 message and a subagent's paraphrase of it,
// since a nested LLM step does not reliably echo the raw error text back.
const TOO_LARGE_RESULT_RE = /too large|file size limitation|\b413\b|max_source_bytes|source_too_large/i;

// Per nested build session: how many times each normalized bash command has
// already run. Guard LOOP_BREAKER uses this to break the weak-model loop where build
// re-runs the SAME analysis command forever without ever emitting a final
// answer, riding the step ceiling for minutes.
const nestedBuildBashCounts = new Map<string, Map<string, number>>();

// Number of prior identical bash runs tolerated in a nested build session
// before Guard LOOP_BREAKER forces a terminal answer. Three runs is already suspicious;
// block the fourth.
const MAX_IDENTICAL_BASH = 3;

// Matches the raw mask registry directory under data_protection_workspace.
// It holds or resolves to unmasked PII and must only ever be reached through
// the restore backend.
//
// Matches the bare `mask_registries` segment rather than the full
// `data_protection_workspace/mask_registries` path: for the `bash` tool the
// probe is the whole command string, so requiring the parent segment was
// defeated by `cd /workspace/data_protection_workspace && cat
// mask_registries/x.json`. The name is distinctive enough that a bare match
// carries no realistic false-positive cost.
const PROTECTED_STORE_PATH_RE = /mask_registries/i;

// Matches the user-facing "sensitive" drop folder (SuperClawProjects/sensitive,
// mounted at /workspace/sensitive). This folder is enforced here: files placed
// in it are never readable raw by any agent, only through
// protected-file-agent's masking pipeline.
//
// Matches `sensitive` as a whole path segment rather than requiring the full
// `/workspace/sensitive` prefix. For the `bash` tool the probe is the entire
// command string, so a prefix-anchored pattern was trivially defeated by
// changing directory first (`cd /workspace/sensitive && cat payroll.xlsx`) or
// by using a relative path (`cat sensitive/payroll.xlsx`). The leading and
// trailing character classes keep a sibling folder like
// `/workspace/sensitive-archive` from matching, because `-` is not a valid
// segment terminator here.
const SENSITIVE_FOLDER_PATH_RE = /(?:^|[\/\\\s'"=:(])sensitive(?=[\/\\'"\s;&|)]|$)/i;

// With data-protection mode "none" nothing is masked and nothing goes to the cloud:
// `local-file-agent` is pinned to the local model and may read the sensitive/ folder.
// Endpoint and response shape are duplicated from tools/confirm_file_protection.ts.
// FAIL-CLOSED: an unreachable or unparseable response counts as "protection on".
const MODE_PATH = "/llm-router/v1/data-protection/mode";
const SENSITIVE_LOCAL_AGENT = "local-file-agent";
const SENSITIVE_LOCAL_READ_TOOLS = new Set(["bash", "read", "glob", "list", "grep"]);

// Parent sessions where confirm_file_protection was declined (set by tools/confirm_file_protection.ts
// on the shared globalThis), parents whose decline 90_superclaw_default_tool_guard.ts already
// consumed on dispatch, and the child sessions spawned from them.
const DENIAL_KEY = "__sc_confirm_file_protection_denied";
const DECLINE_FALLBACK_KEY = "__sc_decline_fallback_parents";
function declinedSessions(): Set<string> {
  const g = globalThis as unknown as Record<string, Set<string> | undefined>;
  return (g[DENIAL_KEY] ??= new Set<string>());
}
function declineFallbackParents(): Set<string> {
  const g = globalThis as unknown as Record<string, Set<string> | undefined>;
  return (g[DECLINE_FALLBACK_KEY] ??= new Set<string>());
}
const declinedFallbackSessions = new Set<string>();

// The App opens the host's local-read grant under the session the user declined in, and the runtime
// cannot open one itself. tools/local_sensitive_read.ts runs in the local-file-agent CHILD session,
// so record which session's grant each child reads under; the tool sends that id.
const GRANT_SESSION_KEY = "__sc_local_read_grant_session";
function grantSessions(): Map<string, string> {
  const g = globalThis as unknown as Record<string, Map<string, string> | undefined>;
  return (g[GRANT_SESSION_KEY] ??= new Map<string, string>());
}

/** True when data-protection mode is "none". */
async function protectionOff(): Promise<boolean> {
  const apiKey = process.env.LRM_API_KEY?.trim();
  const bases = [
    process.env.LRM_API_BASE_URL,
    "http://127.0.0.1:18321",
  ].filter((value): value is string => Boolean(value?.trim()));
  for (const base of bases) {
    try {
      // egress-surface: lrm_data_protection_mode
      const response = await fetch(`${base.replace(/\/$/, "")}${MODE_PATH}`, {
        signal: AbortSignal.timeout(1_500),
        ...(apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : {}),
      });
      if (!response.ok) continue;
      const data = (await response.json()) as { applied?: unknown };
      if (typeof data.applied === "string") return data.applied.trim().toLowerCase() === "none";
    } catch {
      continue;
    }
  }
  return false;
}

/** Extract the probe string to scan for protected paths out of a tool call's args, by tool name. */
function extractProtectedPathProbe(tool: string, args: Record<string, unknown>): string {
  if (tool === "bash") return (args.command as string) ?? "";
  if (tool === "glob") return (args.pattern as string) ?? "";
  // grep searches a directory/file given by `path`, not by its search pattern
  // (that's the content regex, not a path) — same arg shape as read/list.
  if (tool === "grep") return (args.path as string) ?? "";
  return (args.file_path ?? args.path ?? args.filePath ?? "") as string;
}

/** Extract the concatenated text of the latest non-empty user-role message. */
function extractLatestUserRequest(messages: any[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.info?.role !== "user") continue;
    let text = "";
    for (const part of msg?.parts ?? []) {
      if (typeof part?.text === "string" && part.synthetic !== true) text += part.text;
    }
    if (text.trim().length > 0) return text.trim();
  }
  return "";
}

/** Return the id of the most recent user-role message, or "" when there is none. */
function latestUserMessageId(messages: any[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.info?.role === "user" && typeof msg?.info?.id === "string") return msg.info.id;
  }
  return "";
}

/** Extract explicitly labelled input paths from the original request, preserving order. */
function extractRequestedFilePaths(request: string): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  const protectedPathsBlock = Array.from(request.matchAll(
    /^\s*PROTECTED_FILE_PATHS(?:\s*\(\d+\))?\s*:\s*\r?\n((?:\s*-\s*(?:\/|[A-Za-z]:[\\/])[^\r\n]+\r?\n?)*)/gim,
  )).at(-1);
  if (protectedPathsBlock) {
    return Array.from(protectedPathsBlock[1].matchAll(/^\s*-\s*((?:\/|[A-Za-z]:[\\/])[^\r\n]+)$/gim), (match) => match[1].trim());
  }
  const patterns = [
    // The closing `]` is the first one followed by whitespace or the end, so `a[1].txt` survives.
    /\[Selected file:\s*(?:\[([^\]\r\n]+)\]\([^\r\n)]*\)|([^\r\n]+?))\](?=\s|$|\[Selected (?:file|folder):)/gi,
    /^\s*FILE\s+\d+\s*:\s*(\/[^\r\n]+)$/gim,
  ];
  for (const pattern of patterns) {
    for (const match of request.matchAll(pattern)) {
      const path = (match[1] ?? match[2] ?? "").trim();
      if (path && !seen.has(path)) {
        seen.add(path);
        paths.push(path);
      }
    }
  }
  return paths;
}

function selectPipelineSourcePaths(
  selectedPaths: string[],
  args: { source_file_path?: unknown; source_file_paths?: unknown },
): { source_file_path?: string; source_file_paths?: string[] } {
  if (selectedPaths.length > 1) return { source_file_paths: selectedPaths };
  if (selectedPaths.length === 1) return { source_file_path: selectedPaths[0] };
  return Array.isArray(args.source_file_paths)
    ? { source_file_paths: args.source_file_paths }
    : { source_file_path: args.source_file_path as string | undefined };
}

/** Return the basename of a path (last segment after / or \), or "" if the path is empty. */
function basename(filePath: string): string {
  if (!filePath) return "";
  const parts = filePath.split(/[\/\\]/);
  return parts[parts.length - 1] ?? "";
}

/** Prefix a build task with the non-negotiable handoff for one or more already-masked files. */
function prefixMaskedBuildHandoff(prompt: string, maskedFilePath: string | string[]): string {
  const maskedPaths = Array.isArray(maskedFilePath) ? maskedFilePath : [maskedFilePath];
  const marker = maskedPaths.length > 1 ? MASKED_HANDOFF_MARKER_PLURAL : MASKED_HANDOFF_MARKER;
  const prefix =
    `${marker} Do NOT call confirm_file_protection. ` +
    "Do NOT delegate to protected-file-agent, local-file-agent, or any other file-analysis subagent for this file. " +
    "Analyze it directly with your own tools.\n" +
    maskedPaths.map((path) => `masked_file_path: ${path}`).join("\n");
  return prompt.startsWith(prefix) ? prompt : `${prefix}\n\n${prompt}`;
}

function resolveQueryRewriteUrl(): string {
  const host = process.env.DATA_PROTECTION_HOST?.trim() || "127.0.0.1";
  const port = process.env.DATA_PROTECTION_PORT?.trim() || "18826";
  return `http://${host}:${port}/v1/session/query/rewrite`;
}

function resolveResponseRestoreUrl(): string {
  const host = process.env.DATA_PROTECTION_HOST?.trim() || "127.0.0.1";
  const port = process.env.DATA_PROTECTION_PORT?.trim() || "18826";
  return `http://${host}:${port}/v1/session/response/restore`;
}

function privacyAuthorizationHeader(): string | null {
  const apiKey = process.env.PRIVACY_API_KEY?.trim();
  return apiKey ? `Bearer ${apiKey}` : null;
}

/** Call the restore backend once, returning the input unchanged on any failure. */
async function restoreTextWithOperation(
  text: string,
  operationId: string,
  operationSessionId: string | null,
): Promise<string> {
  const authorization = privacyAuthorizationHeader();
  if (!authorization) return text;
  try {
    // egress-surface: data_protection_file_pipeline
    const res = await fetch(resolveResponseRestoreUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authorization },
      body: JSON.stringify({
        session_id: operationSessionId,
        operation_id: operationId,
        text,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return text;
    const result = (await res.json()) as { final_text?: string };
    return typeof result.final_text === "string" ? result.final_text : text;
  } catch {
    return text;
  }
}

/**
 * Chain a restore call across every protected-file operation in a session, in
 * order, feeding each call's output into the next. Needed because one file's
 * content can contain placeholders from several files in a batch request —
 * each operation's registry only resolves its own namespaced placeholders, so
 * the others pass through untouched at that step and get picked up later.
 */
async function restoreTextWithOperations(
  text: string,
  operations: ProtectedFileOperationInfo[],
): Promise<string> {
  let current = text;
  for (const op of operations) {
    current = await restoreTextWithOperation(current, op.operationId, op.operationSessionId);
  }
  return current;
}

// Root the guard scans for build's output files. Overridable via env var for tests.
function outputRestoreScanRoot(): string {
  const override = process.env.SC_OUTPUT_RESTORE_SCAN_ROOT?.trim();
  if (override) return override;
  const nativeRoot = process.env.OPENCODE_DIRECTORY?.trim();
  if (nativeRoot && /^[A-Za-z]:[\\/]/.test(nativeRoot)) {
    return nativeRoot.replace(/\\/g, "/").replace(/(?<!^[A-Za-z]:)\/+$/, "");
  }
  return "/workspace";
}
// Only text-based formats build plausibly writes reports/notes to; binary
// formats (.xlsx/.docx) would need format-aware editing, not a raw text swap.
const OUTPUT_RESTORE_SCAN_EXTENSIONS = new Set([".md", ".txt", ".csv", ".json", ".html", ".htm"]);
// Never descend into masked-output/registry storage or tooling directories —
// masked_datasets/mask_registries are the ONE place placeholders must stay
// exactly as masked, and the rest are irrelevant to build's own output.
const OUTPUT_RESTORE_SKIP_DIR_NAMES = new Set([
  "node_modules", ".git", ".opencode", "data_protection_workspace", "sensitive",
]);
const OUTPUT_RESTORE_MAX_FILES = 500;
const OUTPUT_RESTORE_MAX_FILE_BYTES = 5_000_000;
// Filesystem mtimes can lag a few ms behind Date.now() (observed even for a
// write that happens strictly after the timestamp was captured), so treat
// anything from just before session start as in-scope too, rather than
// risking a false negative on the exact file we're trying to catch.
const OUTPUT_RESTORE_CLOCK_SKEW_BUFFER_MS = 250;

// Cheap pre-check for "does this file contain any <CATEGORY_N> token at all"
// before spending a network round trip restoring it.
const ANY_PLACEHOLDER_RE = /<[A-Za-z_]+_\d+>/;

/** Depth/count-bounded walk for files under root modified at or after sinceMs. */
function findFilesModifiedSince(root: string, sinceMs: number): string[] {
  const found: string[] = [];
  const stack: string[] = [root];
  const threshold = sinceMs - OUTPUT_RESTORE_CLOCK_SKEW_BUFFER_MS;
  while (stack.length > 0 && found.length < OUTPUT_RESTORE_MAX_FILES) {
    const dir = stack.pop() as string;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (found.length >= OUTPUT_RESTORE_MAX_FILES) break;
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!OUTPUT_RESTORE_SKIP_DIR_NAMES.has(entry.name)) stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const dot = entry.name.lastIndexOf(".");
      const ext = dot === -1 ? "" : entry.name.slice(dot).toLowerCase();
      if (!OUTPUT_RESTORE_SCAN_EXTENSIONS.has(ext)) continue;
      try {
        const stat = statSync(full);
        if (stat.size > OUTPUT_RESTORE_MAX_FILE_BYTES) continue;
        if (stat.mtimeMs >= threshold) found.push(full);
      } catch {
        continue;
      }
    }
  }
  return found;
}

type QueryRewriteResult =
  | { success: true; query: string }
  | { success: false; message: string };

/**
 * Replace real entity values in the user's original request with their
 * registered placeholders (e.g. "Alice" -> "<PERSON_1>") before the request
 * text is forwarded to `build` alongside the masked file. Without this,
 * build sees a real name in its instructions but only placeholders in the
 * dataset, and cannot tell the two refer to the same entity. A failed rewrite
 * must block the handoff so real values never reach build with masked data.
 */
async function rewriteQueryForBuild(
  query: string,
  operationId: string,
  operationSessionId: string | null,
  client: any,
): Promise<QueryRewriteResult> {
  const url = resolveQueryRewriteUrl();
  const authorization = privacyAuthorizationHeader();
  if (!authorization) {
    return { success: false, message: "Privacy credential is unavailable" };
  }
  try {
    // egress-surface: data_protection_file_pipeline
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authorization },
      body: JSON.stringify({
        session_id: operationSessionId,
        operation_id: operationId,
        query,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      return {
        success: false,
        message: `query rewrite returned HTTP ${res.status}`,
      };
    }
    const result = (await res.json()) as { rewritten_query?: string; substitutions?: number };
    if (typeof result.rewritten_query !== "string") {
      return {
        success: false,
        message: "query rewrite returned no rewritten_query",
      };
    }
    const rewritten = result.rewritten_query;
    return { success: true, query: rewritten };
  } catch {
    return {
      success: false,
      message: "query rewrite request failed",
    };
  }
}

// OpenCode wraps every subagent result in this envelope, and litellm swaps an
// empty assistant text block for a protocol placeholder. Both are plumbing the
// user should never read, and both survive to the screen because everything
// downstream (model, router short-circuit, display overlay) renders masked_text.
const TASK_RESULT_WRAPPER_RE = /^\s*<task\b[^>]*>\s*<task_result>\s*([\s\S]*?)\s*<\/task_result>\s*<\/task>\s*$/;
const LITELLM_EMPTY_CONTENT_PLACEHOLDER = "[System: Empty message content sanitised to satisfy protocol]";

/** Reduce a build task result to the answer text the user should actually see. */
function normalizeBuildResultText(resultText: string): string {
  if (typeof resultText !== "string") return resultText;
  const unwrapped = resultText.match(TASK_RESULT_WRAPPER_RE)?.[1] ?? resultText;
  const withoutPlaceholder = unwrapped
    .split("\n")
    .filter((line) => line.trim() !== LITELLM_EMPTY_CONTENT_PLACEHOLDER)
    .join("\n");
  const cleaned = withoutPlaceholder.trim();
  // Never hand back an empty answer just because it was all plumbing.
  return cleaned.length > 0 ? cleaned : resultText;
}

/** Build the display-restore envelope written into the task tool-result output. */
function makeRestoreEnvelope(
  maskedText: string,
  operations: Array<{ operationId: string; operationSessionId: string | null }>,
): string {
  if (operations.length > 0) {
    return JSON.stringify({
      type: PROTECTED_PIPELINE_RESULT_TYPE,
      status: "needs_display_restore",
      // Kept singular for older overlay builds that only read one operation.
      operation_id: operations[0].operationId,
      operation_session_id: operations[0].operationSessionId,
      // Full list so the display-restore overlay can chain restore calls
      // across every file's registry for this one response.
      operations: operations.map((op) => ({
        operation_id: op.operationId,
        operation_session_id: op.operationSessionId,
      })),
      masked_text: maskedText,
    });
  }
  return JSON.stringify({
    type: PROTECTED_PIPELINE_RESULT_TYPE,
    status: "restore_unavailable",
    masked_text: maskedText,
  });
}

export const ProtectedPipelineTerminalGuard: Plugin = async ({ client }) => {
  await client.app.log({
    body: {
      service: "protected-pipeline-terminal-guard",
      level: "info",
      message: `Plugin initialized; guarding agent '${PIPELINE_AGENT}'`,
    },
  });

  return {
    /**
     * chat.params — fires before every LLM request.
     *
     * Records the agent name per session so the hooks below know which rules apply.
     */
    "chat.params": async (input: any, output: any) => {
      const ag = input.agent as any;
      const name =
        typeof ag === "string"
          ? ag
          : (ag?.name ?? ag?.id ?? ag?.type ?? ag?.agent ?? "");
      if (input.sessionID && name) sessionAgent.set(input.sessionID, name);
    },

    /**
     * event — fires on every OpenCode event, including `session.created`.
     *
     * Registers a newly created child session as nested (Guard REENTRY) the
     * moment it's spawned, not only once its parent's task() call eventually
     * completes (Transition 1, below). Guard OUTPUT_RESTORE's write/edit
     * recording checks `nestedBuildSessions` while build's session is still
     * live, so it must already be populated before build's own first tool
     * call — waiting for Transition 1 would always be too late, since that
     * only fires after the entire child session has finished running.
     */
    event: async (input: any) => {
      const event = input?.event as any;
      if (event?.type !== "session.created") return;
      const info = event?.properties?.info ?? {};
      const sid = typeof info.id === "string" ? info.id : "";
      const parentId = typeof info.parentID === "string" ? info.parentID : "";
      if (sid && parentId && sessionAgent.get(parentId) === PIPELINE_AGENT) {
        nestedBuildSessions.add(sid);
        nestedBuildSessionStartedAt.set(sid, Date.now());
      }
      // A child spawned after the user declined protection runs locally and may read sensitive/.
      if (sid && parentId && (declinedSessions().has(parentId) || declineFallbackParents().has(parentId))) {
        declinedFallbackSessions.add(sid);
        grantSessions().set(sid, grantSessions().get(parentId) ?? parentId);
      }
    },

    "experimental.chat.system.transform": async (input: any, output: any) => {
      if (!input.sessionID) return;
      if (sessionUnverifiedProtectedAnalysis.has(input.sessionID)) {
        output.system.push(
          "The protected-file result could not be verified, so the selected file was not analyzed. " +
            "Reply to the user now and tell them it was not analyzed. Do not call any tools or delegate to another agent.",
        );
        return;
      }
      if (parentProtectedResolved.has(input.sessionID)) {
        const finalAnswer = parentProtectedResultText.get(input.sessionID);
        if (!finalAnswer) return;
        output.system.push(finalAnswer);
        return;
      }
      if (sessionFileTooLarge.has(input.sessionID)) {
        output.system.push(
          "The protected file pipeline has stopped because the source file is too large. " +
            "Reply to the user now: ask them to choose a smaller file and retry through the protected file pipeline. " +
            "Do not call any tools or delegate to another agent.",
        );
        return;
      }
      // Without this nudge, a weak model that gets blocked calling the pipeline
      // a second time just retries the same blocked call every turn (build is
      // never reached), burning the step budget the same way TERMINAL's thrown
      // block alone does below.
      if (sessionDuplicatePipelineAttempted.has(input.sessionID) && !sessionTerminal.has(input.sessionID)) {
        output.system.push(
          "The protected file pipeline already ran successfully for this request. Do NOT call " +
            "run_protected_file_pipeline again. If you have not already, call task(subagent_type='build') now " +
            "with the masked_file_path you already received. If you already delegated to build, do not call any " +
            "other tool — wait for its result.",
        );
        return;
      }
      // Without this nudge, a weak model that receives the restore envelope keeps
      // retrying tool calls after TERMINAL's thrown block, burning through this
      // session's own step budget until OpenCode's step-limit handler overwrites
      // the plugin's envelope with a generic "MAXIMUM STEPS REACHED" message.
      // The cached envelope is included verbatim, not just described, so the
      // model can copy it instead of having to reconstruct or guess at it.
      if (!sessionTerminal.has(input.sessionID)) return;
      const finalAnswer = sessionFinalEnvelope.get(input.sessionID);
      output.system.push(
        "The protected-file task has already finished. Do not call any tools, and do not delegate to " +
          "another agent. Reply to the user now with exactly this text as your final answer, unchanged, " +
          "keeping every placeholder in <CATEGORY_N> form:\n\n" +
          (finalAnswer ?? "(the result you already produced)"),
      );
    },

    /**
     * experimental.chat.messages.transform — fires before each LLM call with the
     * full message history.
     *
    * Captures the first user-role message of each session as the original
     * request. For a protected-file-agent session this is the request handed
     * down by superclaw-default, which Guard BUILD_HANDOFF forwards verbatim to build so the
     * local model cannot paraphrase or narrow it before delegation.
     */
    "experimental.chat.messages.transform": async (_input: any, output: any) => {
      const messages = output?.messages;
      if (!Array.isArray(messages) || messages.length === 0) return;
      const sid = messages[messages.length - 1]?.info?.sessionID;
      if (!sid) return;
      // A new user message starts a new turn: clear the per-turn protected flags
      // so a resolved/unverified result from a prior request neither blocks nor
      // nudges the next one.
      const lastUserId = latestUserMessageId(messages);
      if (lastUserId && sessionLastUserMessageId.get(sid) !== lastUserId) {
        sessionLastUserMessageId.set(sid, lastUserId);
        parentProtectedResolved.delete(sid);
        parentProtectedResultText.delete(sid);
        sessionUnverifiedProtectedAnalysis.delete(sid);
        sessionOriginalRequest.delete(sid);
      }
      if (sessionOriginalRequest.has(sid)) return;
      const request = extractLatestUserRequest(messages);
      if (request) sessionOriginalRequest.set(sid, request);
    },

    /**
     * tool.execute.before — fires before EVERY tool call.
     *
     * Guard order:
     *   REENTRY. Nested-build re-entry block  (any session spawned by protected-file-agent)
     *   LOOP_BREAKER. Nested-build identical-command loop breaker
     *   REGISTRY_ACCESS. Registry access block  (any agent, any session)
     *   FILE_TOO_LARGE_STOP. Hard stop after an oversized-file pipeline failure  (any agent, only the session that hit it)
     *   ORIGINAL_FILE_ACCESS. Build original-file access block  (agent='build', any session)
     *   SKILL_FALLBACK. Build pipeline-failure skill block  (build agent, after pipeline failure)
    *   SINGLE_PIPELINE_CALL. Single pipeline-call gate  (protected-file-agent, block a 2nd pipeline call)
    *   TERMINAL. Terminal gate  (protected-file-agent, session already finished)
    *   BUILD_HANDOFF. Track task('build') callIDs + forward the original request in the build task
     */
    "tool.execute.before": async (rawInput: unknown, rawOutput: unknown) => {
      if (
        typeof rawInput !== "object" ||
        rawInput === null ||
        Array.isArray(rawInput) ||
        typeof rawOutput !== "object" ||
        rawOutput === null ||
        Array.isArray(rawOutput)
      ) {
        throw new Error("Protected pipeline guard rejected malformed tool execution input.");
      }
      const inputRecord = rawInput as Record<string, unknown>;
      const output = rawOutput as Record<string, unknown>;
      if (
        typeof inputRecord.sessionID !== "string" ||
        inputRecord.sessionID.trim().length === 0 ||
        typeof inputRecord.tool !== "string" ||
        inputRecord.tool.trim().length === 0 ||
        typeof inputRecord.callID !== "string" ||
        inputRecord.callID.trim().length === 0 ||
        !isObjectRecord(output.args)
      ) {
        throw new Error("Protected pipeline guard rejected malformed tool execution input.");
      }
      const input = inputRecord as ToolExecutionHookInput;
      const outputArgs = output.args;
      const agent = sessionAgent.get(input.sessionID);

      // A new confirm_file_protection marks a fresh user-approved request, so
      // the prior request's resolved/unverified state must not carry over.
      if (input.tool === "confirm_file_protection") {
        parentProtectedResolved.delete(input.sessionID);
        parentProtectedResultText.delete(input.sessionID);
        sessionUnverifiedProtectedAnalysis.delete(input.sessionID);
        const selectedPaths = extractRequestedFilePaths(
          sessionOriginalRequest.get(input.sessionID) ?? "",
        );
        if (selectedPaths.length > 0) {
          const selectedArgs = selectPipelineSourcePaths(selectedPaths, outputArgs);
          delete outputArgs.source_file_path;
          delete outputArgs.source_file_paths;
          Object.assign(outputArgs, selectedArgs);
        }
      }

      if (input.tool === "task") {
        const taskArgs = outputArgs;
        const taskSub =
          (taskArgs.subagent_type as string) ?? (taskArgs.agent as string) ?? "";
        if (taskSub === PIPELINE_AGENT) protectedPipelineTaskCalls.add(input.callID);
      }

      // ── Guard REENTRY: nested-build re-entry block ────────────────────────
      // This build session was spawned by protected-file-agent and has already
      // received a masked file. Block any attempt to re-enter the protection
      // workflow to prevent an infinite protect → build → protect loop.
      if (nestedBuildSessions.has(input.sessionID)) {
        const args = outputArgs;
        const sub =
          (args.subagent_type as string) ?? (args.agent as string) ?? "";
        const isReentry =
          input.tool === "confirm_file_protection" ||
          input.tool === PIPELINE_TOOL ||
          (input.tool === "task" &&
            ["protected-file-agent", "local-file-agent", "build"].includes(sub));
        if (isReentry) {
          await client.app.log({
            body: {
              service: "protected-pipeline-terminal-guard",
              level: "warn",
              message: `Blocked re-entry tool='${input.tool}' sub='${sub}' in nested build session=...${input.sessionID.slice(-12)}`,
            },
          });
          throw new Error(
            "This file has ALREADY been protected and masked by the pipeline. Do NOT call confirm_file_protection, " +
              "do NOT call run_protected_file_pipeline, " +
              "and do NOT delegate to protected-file-agent, local-file-agent, or build for this file. " +
              "Analyze the masked file directly with your own tools and return the full response.",
          );
        }

        // ── Guard LOOP_BREAKER: identical-command loop breaker ────────────
        // A weak local build model can get stuck re-running the SAME analysis
        // command without ever emitting a final answer (finish=stop). Each run
        // returns identical output, so nothing self-terminates and the session
        // rides the step ceiling for minutes. Detect a repeated identical bash
        // command and force the model to return the answer it already has.
        if (input.tool === "bash") {
          const command = typeof args.command === "string" ? args.command : "";
          const normalizedCommand = command.replace(/\s+/g, " ").trim();
          if (normalizedCommand) {
            let commandCounts = nestedBuildBashCounts.get(input.sessionID);
            if (!commandCounts) {
              commandCounts = new Map<string, number>();
              nestedBuildBashCounts.set(input.sessionID, commandCounts);
            }
            const priorRuns = commandCounts.get(normalizedCommand) ?? 0;
            if (priorRuns >= MAX_IDENTICAL_BASH) {
              await client.app.log({
                body: {
                  service: "protected-pipeline-terminal-guard",
                  level: "warn",
                  message: `Blocked repeated identical bash (already ran ${priorRuns}x) in nested build session=...${input.sessionID.slice(-12)}`,
                },
              });
              throw new Error(
                "You have ALREADY run this exact analysis command and received its output. " +
                  "Do NOT run it again. Return your final answer as plain text now, using the result " +
                  "you already have. Keep every placeholder in <CATEGORY_N> form.",
              );
            }
            commandCounts.set(normalizedCommand, priorRuns + 1);
          }
        }
      }

      // ── Guard REGISTRY_ACCESS: registry access block ───────────────────────
      // Blocks bash / read / glob / list / grep / write / edit / patch calls
      // that touch the mask registry under data_protection_workspace. It holds
      // or resolves to unmasked PII and must only be reached through the restore
      // backend, not by reading raw files directly. write/edit/patch are covered
      // too so an agent cannot forge or tamper with anything under this folder —
      // including the .generated_outputs.json provenance registry, which would
      // otherwise let a raw sensitive file be whitelisted as "derived output".
      //
      // Deliberately agent-agnostic: NO agent has a legitimate reason to read
      // the raw registry. Gating this on agent='build' left every other agent
      // (notably the default agent 'superclaw-default', which has bash+read
      // allowed) able to cat the registry and resolve placeholders back to
      // real PII — the exact leak this guard exists to prevent.
      if (["bash", "read", "glob", "list", "grep", "write", "edit", "patch"].includes(input.tool)) {
        const args = outputArgs;
        const probe = extractProtectedPathProbe(input.tool, args);
        if (probe && PROTECTED_STORE_PATH_RE.test(probe)) {
          await client.app.log({
            body: {
              service: "protected-pipeline-terminal-guard",
              level: "warn",
              message: `Blocked registry access via tool='${input.tool}' in agent='${agent ?? "-"}' session=...${input.sessionID.slice(-12)} (unconditional check)`,
            },
          });
          throw new Error(
            "BLOCKED: the mask registry must never be accessed directly, via bash, read, glob, list, grep, write, edit, or patch.\n" +
              "Continue analyzing only the masked file you were given, and keep every placeholder in <CATEGORY_N> form.",
          );
        }
      }

      // ── Guard SENSITIVE_FOLDER_ACCESS: sensitive-folder access block ───────
      // Blocks bash / read / glob / list / grep calls that reference the
      // user-facing `sensitive/` drop folder. Unlike the original-file guard
      // below (which keys off pipeline history), this one keys off location:
      // any path under /workspace/sensitive/ is blocked whether or not it has
      // ever been through the protection pipeline.
      //
      // Deliberately agent-agnostic: that folder is reachable ONLY through
      // protected-file-agent's masking pipeline, for every agent. Gating this
      // on agent='build' left the default agent able to read raw drops.
      // protected-file-agent itself is unaffected (it has bash/read denied and
      // reaches files through run_protected_file_pipeline, not these tools).
      // write/edit/patch are included too, the app-layer external_directory deny for sensitive/**
      // never matches on native
      // stopping an agent from writing/tampering with a file under sensitive/.
      if (["bash", "read", "glob", "list", "grep", "write", "edit", "patch"].includes(input.tool)) {
        const args = outputArgs;
        const probe = extractProtectedPathProbe(input.tool, args);
        const isSensitivePath = probe != null && SENSITIVE_FOLDER_PATH_RE.test(probe);
        const localAgentMayRead =
          isSensitivePath &&
          agent === SENSITIVE_LOCAL_AGENT &&
          SENSITIVE_LOCAL_READ_TOOLS.has(input.tool) &&
          (declinedFallbackSessions.has(input.sessionID) || (await protectionOff()));
        if (isSensitivePath && !localAgentMayRead) {
          await client.app.log({
            body: {
              service: "protected-pipeline-terminal-guard",
              level: "warn",
              message: `Blocked sensitive-folder access via tool='${input.tool}' in agent='${agent ?? "-"}' session=...${input.sessionID.slice(-12)} (unconditional check)`,
            },
          });
          throw new Error(
            "BLOCKED: files under the sensitive/ folder must not be accessed directly, via bash, read, glob, list, grep, write, edit, or patch.\n" +
              "This folder is only reachable through protected-file-agent's masking pipeline. Delegate to protected-file-agent instead.",
          );
        }
      }

      // ── Guard FILE_TOO_LARGE_STOP: hard stop after an oversized-file failure ──
      // Scoped only to sessions that already hit this specific failure — no
      // effect on any other agent or session. Blocks the raw-file fallback
      // tools, not just file-path-matching ones, since the model may retry via
      // a brand-new script path rather than the original file path.
      //
      // The system-transform hook directs the next model step to reply to the
      // user. This guard rejects any attempted fallback tool before it runs.
      //
      // NOT permanent: a legitimate new protected-file request in the SAME
      // session must recover. `confirm_file_protection` is let through (it only
      // pops a dialog), and a fresh `task(protected-file-agent)` both passes and
      // CLEARS the flag — so a later, smaller file gets a clean slate. If that
      // new file is also too large, the after-hook re-adds the flag.
      if (sessionFileTooLarge.has(input.sessionID)) {
        const tlArgs = outputArgs;
        const tlSub =
          (tlArgs.subagent_type as string) ?? (tlArgs.agent as string) ?? "";
        const isFreshPipelineAttempt =
          input.tool === "task" && tlSub === PIPELINE_AGENT;
        const isRestartTool =
          input.tool === "confirm_file_protection" || isFreshPipelineAttempt;
        if (isFreshPipelineAttempt) {
          sessionFileTooLarge.delete(input.sessionID);
        }
        if (!isRestartTool) {
          await client.app.log({
            body: {
              service: "protected-pipeline-terminal-guard",
              level: "warn",
              message: `Blocked tool='${input.tool}' after file-too-large pipeline failure in agent='${agent ?? "-"}' session=...${input.sessionID.slice(-12)}`,
            },
          });
          throw new Error(
            "The protected file pipeline failed because the source file is too large; there is no unprotected fallback for it.\n" +
              "Required next action: report the failure to the user and ask them to retry with a smaller file. " +
              "Do NOT retry with bash, a script, or any other tool. Stop here. " +
              "(If the user has since provided a DIFFERENT file, start over with confirm_file_protection for that file.)",
          );
        }
      }

      // ── Guard UNVERIFIED_PROTECTED_ANALYSIS: terminal parent block ───────
      // A protected-file-agent result is untrusted unless this plugin observed
      // the pipeline -> masked build -> restore sequence in the child session.
      // No automatic retry: block every same-turn follow-up tool. A genuinely
      // new request resets this via confirm_file_protection or a new user turn.
      if (sessionUnverifiedProtectedAnalysis.has(input.sessionID)) {
        await client.app.log({
          body: {
            service: "protected-pipeline-terminal-guard",
            level: "warn",
            message: `Blocked tool='${input.tool}' after unverified protected-file result session=...${input.sessionID.slice(-12)}`,
          },
        });
        throw new Error(
          "Protected-file analysis could not be verified. The selected file was not analyzed. " +
            "Report this to the user and stop. Do not call todowrite, fallback tools, or another agent. " +
            "If the user has provided a different file, start a new protected-file request.",
        );
      }

      // ── Guard PROTECTED_RESULT_READY: present-and-stop after success ──────
      // The protected-file analysis already completed (masked build produced
      // the result and any output file). The parent must present that result
      // and stop, not run the pipeline again or re-delegate. A new request
      // resets this via confirm_file_protection or a new user turn.
      if (parentProtectedResolved.has(input.sessionID)) {
        const readyArgs = outputArgs;
        const readySub =
          (readyArgs.subagent_type as string) ?? (readyArgs.agent as string) ?? "";
        const isProtectedRedispatch =
          input.tool === PIPELINE_TOOL ||
          (input.tool === "task" &&
            ["protected-file-agent", "local-file-agent", "build"].includes(readySub));
        if (isProtectedRedispatch) {
          await client.app.log({
            body: {
              service: "protected-pipeline-terminal-guard",
              level: "warn",
              message: `Blocked re-dispatch tool='${input.tool}' after a verified protected-file result session=...${input.sessionID.slice(-12)}`,
            },
          });
          throw new Error(
            "The protected-file analysis is already complete and its result is ready to present. " +
              "Present it to the user as your final answer now and stop. Do not run the pipeline again " +
              "or delegate to another agent.",
          );
        }
      }

      // ── Guard ORIGINAL_FILE_ACCESS: build original-file access block ──────
      // Blocks bash / read / glob / list / grep calls that reference any
      // original (pre-mask) source_file_path ever captured from a successful
      // pipeline run (knownSourceFilePaths), matched by full path or bare
      // basename. Applies to every agent='build' session.
      if (agent === BUILD_AGENT && ["bash", "read", "glob", "list", "grep"].includes(input.tool)) {
        const args = outputArgs;
        const probe = extractProtectedPathProbe(input.tool, args);
        if (probe) {
          for (const srcPath of knownSourceFilePaths) {
            const srcBasename = basename(srcPath);
            if (probe.includes(srcPath) || (!!srcBasename && probe.includes(srcBasename))) {
              await client.app.log({
                body: {
                  service: "protected-pipeline-terminal-guard",
                  level: "warn",
                  message: `Blocked original-file access via tool='${input.tool}' in build session=...${input.sessionID.slice(-12)} (unconditional check)`,
                },
              });
              throw new Error(
                "BLOCKED: build agent must not open the original (pre-mask) source file by any path, via bash, read, glob, list, or grep.\n" +
                  "Required next action: continue analyzing only the masked file you were given, and keep every placeholder in <CATEGORY_N> form. " +
                  "If the masked content or the request is unclear, ask the user for clarification instead of trying to read the original file.",
              );
            }
          }
        }
      }

      // ── Guard SKILL_FALLBACK: build pipeline-failure terminal block ────────
      // If the pipeline tool already reported failure in this build session,
      // the agent must report that failure and stop — not fall back to a
      // skill, and not retry the file another way (bash/read/glob/list/grep).
      if (agent === BUILD_AGENT && buildPipelineFailed.has(input.sessionID)) {
        if (["skill", "bash", "read", "glob", "list", "grep"].includes(input.tool)) {
          await client.app.log({
            body: {
              service: "protected-pipeline-terminal-guard",
              level: "warn",
              message: `Blocked tool='${input.tool}' after pipeline failure sessionID=...${input.sessionID.slice(-12)}`,
            },
          });
          throw new Error(
            "The protected file pipeline failed for this file. Do not process it another way. " +
              "Do not call any skill (e.g. the spreadsheet skill), and do not try bash, read, glob, list, or grep on it. " +
              "Report the pipeline failure to the user and ask them to retry the request. Stop here.",
          );
        }
      }

      // Only the remaining guards apply to protected-file-agent sessions.
      if (agent !== PIPELINE_AGENT) {
        // Guards SINGLE_PIPELINE_CALL, TERMINAL and BUILD_HANDOFF (which owns the
        // query rewrite) all sit behind this gate. If the agent name never
        // resolved, they are skipped silently.
        return;
      }

      // ── Guard SINGLE_PIPELINE_CALL: single pipeline-call gate ──────────────
      // run_protected_file_pipeline must run exactly once per request. The prose
      // rule in the agent prompt is not reliably obeyed by the local model, so
      // reject a second call here. The first call is recorded synchronously
      // (before the tool runs) so a duplicate emitted in the same turn is caught
      // even before the first call resolves.
      if (input.tool === PIPELINE_TOOL) {
        if (sessionPipelineRan.has(input.sessionID)) {
          sessionDuplicatePipelineAttempted.add(input.sessionID);
          await client.app.log({
            body: {
              service: "protected-pipeline-terminal-guard",
              level: "warn",
              message: `Blocked duplicate ${PIPELINE_TOOL} call sessionID=...${input.sessionID.slice(-12)}`,
            },
          });
          throw new Error(
            "The protected file pipeline has ALREADY run for this request. Do NOT call " +
              "run_protected_file_pipeline again. Proceed immediately to Step 3: task(subagent_type='build') " +
              "with the user's original request and the masked_file_path you already received.",
          );
        }

        const selectedFilePaths = extractRequestedFilePaths(
          sessionOriginalRequest.get(input.sessionID) ?? "",
        );
        if (selectedFilePaths.length > 0) {
          const selectedArgs = selectPipelineSourcePaths(selectedFilePaths, outputArgs);
          delete outputArgs.source_file_path;
          delete outputArgs.source_file_paths;
          Object.assign(outputArgs, selectedArgs);
        }
        if (selectedFilePaths.length > 1) {
          await client.app.log({
            body: {
              service: "protected-pipeline-terminal-guard",
              level: "info",
              message: `Upgraded first ${PIPELINE_TOOL} call to batch file_count=${selectedFilePaths.length} sessionID=...${input.sessionID.slice(-12)}`,
            },
          });
        }
        sessionPipelineRan.add(input.sessionID);

        // Register the raw source path(s) BEFORE the pipeline call resolves,
        // not only after it succeeds. See knownSourceFilePaths comment: this
        // closes the race where a same-turn task('build') call reaches build
        // while the pipeline request is still in flight (it can take up to 4
        // minutes), and the gap where a failed/timed-out call would otherwise
        // leave the raw path(s) permanently unguarded. Handles both the
        // single-file `source_file_path` arg and the batch `source_file_paths` arg.
        const callArgs = outputArgs;
        const rawSourcePaths: string[] = Array.isArray(callArgs.source_file_paths)
          ? (callArgs.source_file_paths as unknown[]).filter(
              (p): p is string => typeof p === "string",
            )
          : typeof callArgs.source_file_path === "string"
            ? [callArgs.source_file_path]
            : [];
        for (const rawPath of rawSourcePaths) {
          const trimmed = rawPath.trim();
          if (trimmed) knownSourceFilePaths.add(trimmed);
        }
      }

      // ── Guard TERMINAL: terminal gate ──────────────────────────────────────
      // The session is fully done (auto-restore completed, auto-restore failed, or pipeline failed).
      // First violation: log a warning and throw. Second violation (tripped):
      // throw immediately without logging to avoid spam. Both carry the cached
      // envelope verbatim -- a weak model given only an abstract "stop and
      // present it" instruction tends to just try another blocked tool instead
      // of reconstructing the answer, so the literal text to emit is included.
      if (sessionTerminal.has(input.sessionID)) {
        const cached = sessionFinalEnvelope.get(input.sessionID);
        const stopInstruction =
          "The task is already finished. Do not start any new tool call. Reply now with exactly this text " +
          "as your final answer, unchanged, keeping every placeholder in <CATEGORY_N> form:\n\n" +
          (cached ?? "(the result you already produced)");
        if (sessionTripped.has(input.sessionID)) {
          // Already warned once — hard stop, no log.
          throw new Error(stopInstruction);
        }
        // First attempt after terminal — log it, mark as tripped, then block.
        sessionTripped.add(input.sessionID);
        await client.app.log({
          body: {
            service: "protected-pipeline-terminal-guard",
            level: "warn",
            message: `Blocked post-terminal tool='${input.tool}' sessionID=...${input.sessionID.slice(-12)}`,
          },
        });
        throw new Error(stopInstruction);
      }

      // ── Guard BUILD_HANDOFF: track task('build') callIDs ───────────────────
      // Store the callID so tool.execute.after can identify when THIS specific
      // build task finishes.
      if (input.tool === "task") {
        const args = outputArgs;
        const sub =
          (args.subagent_type as string) ?? (args.agent as string) ?? "";
        if (sub === BUILD_AGENT) {
          const infos = (sessionOperationInfo.get(input.sessionID) ?? []).filter(
            (info) => !!info.maskedFilePath && !!info.operationId,
          );
          if (infos.length === 0) {
            sessionTerminal.add(input.sessionID);
            throw new Error(
              "PROTECTED FILE PIPELINE STOPPED: build cannot start without at least one verified operation_id and masked_file_path. " +
                "Report the pipeline failure to the user and stop.",
            );
          }
          {
            const modelPrompt = typeof args.prompt === "string" ? args.prompt : "";
            // Forward the captured original user request verbatim rather than the
            // model-authored prompt, which the local model may have paraphrased or
            // narrowed (e.g. rewriting "extract all content" into "write a python
            // script"). Fall back to the model prompt only if nothing was captured.
            const original = sessionOriginalRequest.get(input.sessionID)?.trim();
            const body = original && original.length > 0 ? original : modelPrompt;
            // Replace real entity values in `body` with their registry placeholders
            // (e.g. "Alice" -> "<PERSON_1>"), chaining across every protected file's
            // registry in this session so build's instructions and every masked
            // dataset it receives use the same tokens. A rewrite failure blocks build.
            let rewrittenBody = body;
            for (const info of infos) {
              const rewriteResult = await rewriteQueryForBuild(
                rewrittenBody,
                info.operationId,
                info.operationSessionId,
                client,
              );
              if (!rewriteResult.success) {
                sessionTerminal.add(input.sessionID);
                throw new Error(
                  "PROTECTED FILE PIPELINE STOPPED: query rewrite failed, so the masked file(s) cannot " +
                    `be sent to build. ${rewriteResult.message}. Retry the protected-file request.`,
                );
              }
              rewrittenBody = rewriteResult.query;
            }
            const maskedFilePaths = infos
              .map((info) => info.maskedFilePath)
              .filter((path): path is string => !!path);
            const nextPrompt = prefixMaskedBuildHandoff(rewrittenBody, maskedFilePaths);
            if (nextPrompt !== modelPrompt) {
              args.prompt = nextPrompt;
              await client.app.log({
                body: {
                  service: "protected-pipeline-terminal-guard",
                  level: "info",
                  message: `Injected masked-file handoff (${maskedFilePaths.length} file(s))${
                    original ? " with original request" : ""
                  } before build task sessionID=...${input.sessionID.slice(-12)}`,
                },
              });
            }
          }
          buildTaskCalls.add(input.callID);
          const startedAt = Date.now();
          buildTaskStartedAt.set(input.callID, startedAt);
          sessionBuildStartedAt.set(input.sessionID, startedAt);
        }
      }
    },

    /**
     * tool.execute.after — fires after a tool call completes.
     *
     * Manages session state transitions:
     *   1. When protected-file-agent's task('build') completes:
     *      - Record the child build sessionID in nestedBuildSessions (Guard REENTRY).
    *      - Auto-restore the build response, or return a terminal failure.
     *   2. When build agent's task to protected-file-agent returns failure:
     *      - Mark buildPipelineFailed so skill fallbacks are blocked (Guard SKILL_FALLBACK).
     *   2b. When ANY session's task to protected-file-agent reports the file was
     *      too large: mark that session for Guard FILE_TOO_LARGE_STOP.
     *   3. For protected-file-agent:
     *      - run_protected_file_pipeline failure → mark session terminal immediately.
     *      - task('build') done → write display-restore envelope, mark terminal.
     */
    "tool.execute.after": async (rawInput: unknown, rawOutput: unknown) => {
      if (
        typeof rawInput !== "object" ||
        rawInput === null ||
        Array.isArray(rawInput) ||
        typeof rawOutput !== "object" ||
        rawOutput === null ||
        Array.isArray(rawOutput)
      ) {
        throw new Error("Protected pipeline guard rejected malformed tool execution result.");
      }
      const inputRecord = rawInput as Record<string, unknown>;
      const output = rawOutput as Record<string, unknown>;
      if (
        typeof inputRecord.sessionID !== "string" ||
        inputRecord.sessionID.trim().length === 0 ||
        typeof inputRecord.tool !== "string" ||
        inputRecord.tool.trim().length === 0 ||
        typeof inputRecord.callID !== "string" ||
        inputRecord.callID.trim().length === 0 ||
        !(output.args === undefined || output.args === null || isObjectRecord(output.args))
      ) {
        throw new Error("Protected pipeline guard rejected malformed tool execution result.");
      }
      const input = inputRecord as ToolExecutionHookInput;
      const inputArgs = isObjectRecord(input.args) ? input.args : {};
      const outputArgs = isObjectRecord(output.args) ? output.args : {};
      const completedCallArgs = isObjectRecord(input.args) ? input.args : outputArgs;
      const outputMetadata = isObjectRecord(output.metadata) ? output.metadata : {};
      const agent = sessionAgent.get(input.sessionID);

      // ── Transition 2b: any agent — detect file-too-large pipeline failure ──
      // Scoped to the calling session only; does not touch any other agent's
      // guard behavior. Matches on the result text (raw tool JSON or a
      // subagent's paraphrase of it) rather than a specific caller agent, so
      // it fires the same way whether superclaw-default or build called
      // protected-file-agent directly.
      if (input.tool === "task") {
        // The after-hook SDK places the completed call's args on `input`;
        // `output` only contains title, output, and metadata.
        const taskArgs = inputArgs;
        const taskSub =
          (taskArgs.subagent_type as string) ?? (taskArgs.agent as string) ?? "";
        const taskResultText = typeof output.output === "string" ? output.output : "";
        const wasProtectedPipelineTask = protectedPipelineTaskCalls.delete(input.callID);
        const protectedTaskReportedTooLarge =
          (wasProtectedPipelineTask || taskSub === PIPELINE_AGENT) &&
          TOO_LARGE_RESULT_RE.test(taskResultText);
        if (protectedTaskReportedTooLarge) {
          sessionFileTooLarge.add(input.sessionID);
          output.output =
            "The protected file is too large for the protected file pipeline. " +
            "Please choose a smaller file and retry the request through the protected file pipeline.";
          await client.app.log({
            body: {
              service: "protected-pipeline-terminal-guard",
              level: "warn",
              message: `Marking session=...${input.sessionID.slice(-12)} agent='${agent ?? "-"}' file-too-large after protected-file-agent failure`,
            },
          });
        }

        if (
          !protectedTaskReportedTooLarge &&
          (wasProtectedPipelineTask || taskSub === PIPELINE_AGENT)
        ) {
          const childSessionId =
            typeof outputMetadata.sessionId === "string" ? outputMetadata.sessionId : undefined;
          const verified =
            typeof childSessionId === "string" &&
            verifiedProtectedAnalysisSessions.delete(childSessionId);
          if (!verified) {
            sessionUnverifiedProtectedAnalysis.add(input.sessionID);
            output.output =
              "Protected-file analysis could not be verified. The selected file was not analyzed.";
            await client.app.log({
              body: {
                service: "protected-pipeline-terminal-guard",
                level: "warn",
                message: `Rejected unverified protected-file result parent=...${input.sessionID.slice(-12)} child=${
                  childSessionId ? `...${childSessionId.slice(-12)}` : "missing"
                }`,
              },
            });
          } else {
            parentProtectedResolved.add(input.sessionID);
            // Verified only proves buildDone ran, not that the child's own final
            // message still carries that envelope by the time it reaches here --
            // force the cached copy back in so a step-limit overwrite downstream
            // of buildDone can never surface as a false failure to the user.
            const cachedEnvelope = childSessionId ? sessionFinalEnvelope.get(childSessionId) : undefined;
            if (cachedEnvelope !== undefined) {
              try {
                const parsed = JSON.parse(cachedEnvelope) as { masked_text?: unknown };
                if (typeof parsed.masked_text === "string") {
                  parentProtectedResultText.set(input.sessionID, parsed.masked_text);
                }
              } catch {
                // The typed envelope is produced by this module, so parsing failure
                // only suppresses the optional parent nudge; delivery still uses it.
              }
              if (childSessionId) sessionFinalEnvelope.delete(childSessionId);
              if (output.output !== cachedEnvelope) {
                output.output = cachedEnvelope;
                await client.app.log({
                  body: {
                    service: "protected-pipeline-terminal-guard",
                    level: "warn",
                    message: `Restored cached envelope over a corrupted protected-file result parent=...${input.sessionID.slice(-12)} child=...${childSessionId!.slice(-12)}`,
                  },
                });
              }
            }
          }
        }
      }

      // ── Transition 1: protected-file-agent's build task completed ──────────
      // Register the child session as nested so Guard REENTRY can block re-entry.
      if (agent === PIPELINE_AGENT && input.tool === "task") {
        const args = completedCallArgs;
        const sub =
          (args.subagent_type as string) ?? (args.agent as string) ?? "";
        if (sub === "build") {
          const childSessionId =
            typeof outputMetadata.sessionId === "string" ? outputMetadata.sessionId : undefined;
          if (childSessionId) {
            nestedBuildSessions.add(childSessionId);
            await client.app.log({
              body: {
                service: "protected-pipeline-terminal-guard",
                level: "info",
                message: `Tracking nested build session=...${childSessionId.slice(-12)} spawned by protected-file-agent`,
              },
            });
          }
        }
      }

      // ── Transition 2: build agent — detect pipeline failure in delegated task ──
      // If build tasked protected-file-agent and the result signals failure,
      // record the failure so Guard SKILL_FALLBACK blocks any skill fallback attempt.
      if (agent === BUILD_AGENT && input.tool === "task") {
        // skill calls surface either as tool "spreadsheet" or tool
        const args = outputArgs;
        const sub =
          (args.subagent_type as string) ?? (args.agent as string) ?? "";
        const resultText = typeof output.output === "string" ? output.output : "";
        if (sub === PIPELINE_AGENT && /"success":\s*false/.test(resultText)) {
          buildPipelineFailed.add(input.sessionID);
        }
      }
      // ── Transitions 3a / 3b / 3c: protected-file-agent state machine ────────
      if (agent !== PIPELINE_AGENT) {

        return;
      }

      const resultText = typeof output.output === "string" ? output.output : "";

      // 3d: capture operation_id/operation_session_id from a successful
      // run_protected_file_pipeline call so the buildDone auto-restore step
      // below has what it needs once build returns. Also capture
      // source_file_path/masked_file_path into knownSourceFilePaths so Guard
      // ORIGINAL_FILE_ACCESS can tell the raw original apart from the masked
      // file once build is tasked. Handles both the single-file result shape
      // ({success, operation_id, masked_file_path, ...}) and the batch shape
      // ({success, message, results: [...]}) from a source_file_paths call.
      let pipelinePreflightRejected = false;
      if (input.tool === PIPELINE_TOOL) {
        // The backend's JSON response does not reliably include
        // source_file_path on the single-file shape (confirmed absent in real
        // responses), so fall back to the call's own input args, which always
        // have it — that's the exact path(s) protected-file-agent passed in.
        const callArgs = (input.args ?? output.args ?? {}) as Record<string, unknown>;
        const argSourcePaths: string[] = Array.isArray(callArgs.source_file_paths)
          ? (callArgs.source_file_paths as unknown[]).filter(
              (p): p is string => typeof p === "string",
            )
          : typeof callArgs.source_file_path === "string"
            ? [callArgs.source_file_path]
            : [];
        try {
          const parsed = JSON.parse(resultText);
          pipelinePreflightRejected =
            typeof parsed?.error === "string" && PREFLIGHT_REJECTION_CODES.has(parsed.error);
          const rawResults: any[] = Array.isArray(parsed?.results) ? parsed.results : [parsed];
          const infos: ProtectedFileOperationInfo[] = [];
          rawResults.forEach((result, idx) => {
            if (!result?.success || !result?.operation_id) return;
            const sourceFilePath =
              (result.source_file_path as string | undefined) ?? argSourcePaths[idx] ?? null;
            const maskedFilePath = (result.masked_file_path as string | undefined) ?? null;
            if (sourceFilePath) knownSourceFilePaths.add(sourceFilePath);
            infos.push({
              operationId: result.operation_id as string,
              operationSessionId: (result.operation_session_id as string | undefined) ?? null,
              sourceFilePath,
              maskedFilePath,
            });
          });
          if (infos.length > 0) sessionOperationInfo.set(input.sessionID, infos);
        } catch {
          // Non-JSON or malformed response — leave uncaptured; buildDone below
          // causes buildDone below to return a terminal auto-restore failure.
        }
        if (pipelinePreflightRejected) {
          sessionPipelineRan.delete(input.sessionID);
          sessionDuplicatePipelineAttempted.delete(input.sessionID);
        }
      }

      // 3a: pipeline tool ran but produced zero usable masked files → mark
      // terminal immediately (skip build step). Covers both a fully failed
      // single-file call and a batch call where every file failed.
      const pipelineFailed =
        input.tool === PIPELINE_TOOL &&
        !pipelinePreflightRejected &&
        (sessionOperationInfo.get(input.sessionID)?.length ?? 0) === 0;

      // 3b: track whether THIS is the build task completing (matched by callID).
      const completedTaskArgs = (input.args ?? output.args ?? {}) as Record<string, unknown>;
      const completedTaskSub =
        (completedTaskArgs.subagent_type as string) ?? (completedTaskArgs.agent as string) ?? "";
      const buildDone =
        input.tool === "task" &&
        (buildTaskCalls.has(input.callID) ||
          (agent === PIPELINE_AGENT &&
            sessionBuildStartedAt.has(input.sessionID) &&
            (!completedTaskSub || completedTaskSub === BUILD_AGENT)));
      const buildStartedAt =
        buildTaskStartedAt.get(input.callID) ?? sessionBuildStartedAt.get(input.sessionID);
      if (buildDone) {
        buildTaskCalls.delete(input.callID);
        buildTaskStartedAt.delete(input.callID);
      }

      if (buildDone) {
        // Build returned. Wrap the masked response in a typed envelope so the
        // OpenWork /message overlay can perform restore in the display path.
        // The OpenCode agent transcript keeps the envelope — no PII is written
        // back into agent context. The model receives the envelope string and
        // presents it; the UI receives the restored text from the server overlay.
        const infos = sessionOperationInfo.get(input.sessionID) ?? [];
        const envelope = makeRestoreEnvelope(
          normalizeBuildResultText(resultText),
          infos.map((info) => ({
            operationId: info.operationId,
            operationSessionId: info.operationSessionId,
          })),
        );
        output.output = envelope;

        // Guard OUTPUT_RESTORE: build's own session is now finished, so any
        // file it produced can safely be restored to real values on disk —
        // build will never issue another tool call in this session to read
        // it back. Detected by scanning /workspace for files modified since
        // the session started, not by which tool wrote them — build commonly
        // writes report output via bash/python, not the write/edit tools.
        // Best-effort: a scan/read/write/restore failure just leaves that
        // file masked, it never blocks the envelope above.
        const childSessionId =
          typeof outputMetadata.sessionId === "string" ? outputMetadata.sessionId : undefined;
        const startedAt = childSessionId
          ? (nestedBuildSessionStartedAt.get(childSessionId) ?? buildStartedAt)
          : buildStartedAt;
        if (startedAt !== undefined && infos.length > 0) {
          let candidates: string[] = [];
          try {
            candidates = findFilesModifiedSince(outputRestoreScanRoot(), startedAt);
          } catch (exc) {
            await client.app.log({
              body: {
                service: "protected-pipeline-terminal-guard",
                level: "warn",
                message: `OUTPUT_RESTORE scan failed exc=${exc instanceof Error ? exc.message : String(exc)}`,
              },
            });
          }
          for (const filePath of candidates) {
            const normalizedPath = filePath.replace(/\\/g, "/");
            markOutputRestoredPath(normalizedPath);
            recordGeneratedOutputPath(normalizedPath);
            try {
              const current = readFileSync(filePath, "utf-8");
              if (!ANY_PLACEHOLDER_RE.test(current)) continue;
              const restored = await restoreTextWithOperations(current, infos);
              if (restored !== current) writeFileSync(filePath, restored, "utf-8");
            } catch (exc) {
              await client.app.log({
                body: {
                  service: "protected-pipeline-terminal-guard",
                  level: "warn",
                  message: `OUTPUT_RESTORE failed for file=${filePath} exc=${exc instanceof Error ? exc.message : String(exc)}`,
                },
              });
            }
          }
        }
        if (childSessionId) nestedBuildSessionStartedAt.delete(childSessionId);

        sessionOperationInfo.delete(input.sessionID);
        sessionDuplicatePipelineAttempted.delete(input.sessionID);
        sessionBuildStartedAt.delete(input.sessionID);
        verifiedProtectedAnalysisSessions.add(input.sessionID);
        sessionFinalEnvelope.set(input.sessionID, envelope);
        sessionTerminal.add(input.sessionID);
        await client.app.log({
          body: {
            service: "protected-pipeline-terminal-guard",
            level: "info",
            message: `Wrote display-restore envelope sessionID=...${input.sessionID.slice(-12)} status=${
              infos.length > 0 ? "needs_display_restore" : "restore_unavailable"
            } file_count=${infos.length}`,
          },
        });
        return;
      }

      // 3a (deferred): mark terminal after pipeline failure.
      if (pipelineFailed) {
        sessionTerminal.add(input.sessionID);
      }
    },
  };
};

// opencode loads every export of this module as a plugin, so a bare helper export is invoked
// as a plugin factory and fails the whole file. The helpers ride on the plugin function
// instead; unit tests read them off the default export.
export default Object.assign(ProtectedPipelineTerminalGuard, {
  prefixMaskedBuildHandoff,
  normalizeBuildResultText,
  selectPipelineSourcePaths,
  extractRequestedFilePaths,
  extractLatestUserRequest,
  outputRestoreScanRoot,
});

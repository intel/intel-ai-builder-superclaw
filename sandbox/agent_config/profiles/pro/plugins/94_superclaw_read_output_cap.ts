/**
 * superclaw_read_output_cap — bound the size of file-read tool output, with
 * TWO SELECTABLE STRATEGIES (A/B benchmarkable via LRM_BIG_READ_MODE):
 *
 *   * "block" (default; name kept for env compatibility) — in tool.execute.before,
 *     if the file exceeds a byte threshold, measure the REQUESTED slice
 *     (offset + limit). A slice that fits runs unchanged; one that does not is
 *     SHORTENED (args.limit lowered) to the lines that fit, and tool.execute.after
 *     appends a PARTIAL VIEW note with the next offset. The call always returns
 *     content instead of failing, so no tool call is wasted on a refusal. When
 *     paging the whole file would take more than LRM_BIG_READ_SEARCH_FIRST_READS
 *     reads, the note instead tells the model to stop paging and search
 *     (grep via bash) or script over the file. A session whose model can be
 *     served by the local llama-server (`auto`, `local-model`) always gets the
 *     search-first note and a PEEK_LINES sample: a file over the cap is more than
 *     half the local window, so paging it in overflows that window and moves the
 *     session to cloud. Other models (e.g. `cloud-model`) keep the paging note.
 *     For such a session a derived cap is compared with the file's estimated
 *     tokens (logs and CSV hold about twice as many tokens per byte as prose), so
 *     a file under the byte cap that still fills the window gets the same treatment.
 *   * "truncate" — let the read run, then in tool.execute.after cap the returned
 *     text at MAX_CHARS + a notice. The model sees the head and is told to
 *     re-read narrower / script for the rest. Non-destructive to the run (the
 *     call succeeds), destructive to the data (tail is dropped).
 *   * "off" — no cap (baseline arm; measures the cost of no guard).
 *
 * Motivation: the local model has a fixed context window a single large read can
 * blow past (400 ContextOverflow). Both modes bound the input at the source:
 * truncate after the read (drops the tail), block before it (reads fewer lines
 * and says where to continue). Both run through one flag so the pinchbench
 * harness can compare them.
 *
 * Threshold sizing (KEY): the cap is DERIVED from the LIVE local n_ctx, read from
 * the router control-plane endpoint GET {LRM_API_BASE_URL}/llm-router/v1/local/
 * ctx-size (`applied`). The user can change the context window from the GUI at
 * runtime; the derived cap auto-tracks it (short TTL cache) with no restart, and
 * uses the SAME window math as the router's compaction cap so the two agree. A
 * fixed cap sized for one window (the old 140k default) either overflows a small
 * window or needlessly clips a large one — hence the derivation.
 *
 * Per-threshold precedence: explicit env override > derived-from-n_ctx > static
 * default. The eval pins env for reproducible arms; interactive use auto-tracks.
 *
 * Scope: read-family tools (built-in read + the custom doc/table readers).
 * A header peek (read with a small limit) is left uncut in both modes.
 *
 * Images: in block and truncate mode, a built-in `read` of an image is refused
 * before it runs and the model is told to call `ocr` instead. The runtime returns
 * an image read as a base64 data URL, which the router counts as text: a 530 KB
 * photo became ~236k tokens against a 91k local window. No slice of an image
 * fits, so this is a refusal, not a shortened read.
 *
 * Env:
 *   LRM_BIG_READ_MODE        = truncate | block | off       (default: block)
 *   LRM_LOCAL_READ_MAX_CHARS = truncate char cap OVERRIDE   (unset → derive from n_ctx)
 *   LRM_BIG_READ_KB          = block file-size threshold KB OVERRIDE (unset → derive)
 *   LRM_BIG_READ_PEEK_LINES  = read limit treated as a header peek (default: 50)
 *   LRM_BIG_READ_SEARCH_FIRST_READS = reads-to-page-the-file above which the note
 *                              says search/script instead of page (default: 10)
 *   Derivation tunables: LRM_READ_OUTPUT_RESERVE (8192), LRM_READ_SAFETY (1024),
 *   LRM_READ_FRACTION (0.5 of usable window per single read),
 *   LRM_READ_BYTES_PER_TOKEN (3.7), LRM_READ_CTX_TTL_MS (30000).
 *   n_ctx source: LRM_API_BASE_URL (+ LRM_API_KEY if the endpoint is auth-gated).
 */
import { createReadStream, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Plugin } from "@opencode-ai/plugin";

// Tools whose output is raw file content and can be arbitrarily large.
// Built-in `read` plus the custom document/table readers shipped in
// .opencode/tools/. Keep in sync if new bulk readers are added.
const READ_TOOLS = new Set([
  "read",
  "parse_pdf",
  "ocr",
  "local_dr_read_pptx",
  "local_dr_read_docx",
  "local_dr_read_csv_xlsx",
  "local_dr_query_table",
]);

// Static fallback char cap, used only when neither an explicit env override nor
// a live n_ctx is available (~100k chars ≈ 25-30k tokens — a 140k-window default).
const DEFAULT_MAX_CHARS = 100_000;
// Static fallback block threshold (KB) with the same caveat.
const DEFAULT_MAX_KB = 100;

function _int(v: string | undefined, dflt: number): number {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}
function _intOrNull(v: string | undefined): number | null {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function _num(v: string | undefined, dflt: number): number {
  const n = Number.parseFloat(v ?? "");
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

// Default mode is BLOCK. Rationale: on a small local context window a single
// oversized data read hard-overflows llama-server (exceed_context_size_error).
// Block bounds every read of a large file BEFORE it runs, so it's the safe
// default for interactive GUI sessions where no env is injected. The eval
// overrides to truncate/off via run_arm_clean.sh when benchmarking those
// strategies.
const _MODE_RAW = (process.env.LRM_BIG_READ_MODE || "block").toLowerCase();
const MODE = _MODE_RAW === "truncate" || _MODE_RAW === "block" || _MODE_RAW === "off" ? _MODE_RAW : "block"; // truncate|block|off
const PEEK_LINES = _int(process.env.LRM_BIG_READ_PEEK_LINES, 50);
// Above this many reads to page the whole file, paging is not viable (it would
// also exhaust the per-turn step budget), so the note switches to search-first.
const SEARCH_FIRST_READS = _int(process.env.LRM_BIG_READ_SEARCH_FIRST_READS, 10);
// Only block-mode inspects file size on disk, and only for the built-in `read`
// (the custom readers take a path but the size check maps cleanly to a filePath).
// Includes .md: large meeting/document transcripts (e.g. a 267 KB NASA-hearing
// transcript.md ≈ 72K tokens) otherwise get paged whole into a small local
// window, overflow it, and trigger compaction that SUMMARIZES AWAY the very
// transcript the task needs — leaving the model with "I can't see the files"
// and a guaranteed ZERO. Bounding each read forces chunked/scripted
// processing, which survives the window. (meeting_analysis is all .md.)
const DATA_EXT = /\.(csv|tsv|log|json|ndjson|jsonl|txt|md|markdown)$/i;
// Data that should be computed over with a script, not eyeballed from a slice.
const STRUCTURED_EXT = /\.(csv|tsv|log|json|ndjson|jsonl)$/i;
// Images the `ocr` tool reads; a `read` of one would inline it as base64.
const IMAGE_EXT = /\.(jpe?g|png|gif|webp|bmp|tiff?)$/i;

function refuseImageRead(input: any, output: any, resolve: (fp: string) => string | undefined): void {
  if (input?.tool !== "read") return;
  const fp = output?.args?.filePath;
  if (typeof fp !== "string" || !IMAGE_EXT.test(fp)) return;
  // ocr requires an absolute path, so hand it the resolved one.
  const abs = resolve(fp) ?? fp;
  // Thrown so the read fails with this text instead of flooding the context window.
  throw new Error(
    `superclaw: the read tool cannot open the image "${fp}": it would be sent as base64 ` +
      `and overflow the context window. Call the ocr tool with file_path="${abs}" to get its text.`,
  );
}

// Mirrors the runtime read tool (opencode src/tool/read.ts): default line limit,
// per-line cut, per-read byte cap, and the "<n>: " prefix on every returned line.
// Staying at or under the runtime byte cap keeps our next-offset hint consistent
// with the runtime's own continuation footer.
const RUNTIME_DEFAULT_LIMIT = 2000;
const RUNTIME_MAX_LINE_CHARS = 2000;
const RUNTIME_MAX_BYTES = 50 * 1024;
const MAX_PENDING_NOTES = 256;
const MAX_TRACKED_SESSIONS = 1024;
// llmrouter model ids whose turns can be served by the local llama-server, so the
// local window bounds the session. A session not seen in chat.params yet counts too.
const LOCAL_SERVED_MODELS = new Set(["auto", "local-model"]);

// ── Threshold sizing: derive from the LIVE local n_ctx ──────────────────────
// The read cap must fit the CURRENT local context window, which the user can
// change from the GUI at runtime (local-ctx-size slider → PUT /llm-router/v1/
// local/ctx-size → llama-server restart → new n_ctx). A static env/const cap
// (sized for a 140k remote window) either overflows a small local window or
// needlessly clips a large one. So we read the applied n_ctx from the router's
// control-plane endpoint (reachable from the container via LRM_API_BASE_URL —
// the same value the router's own context-cap guard uses) and derive the cap
// with the SAME window math, so the read guard and the compaction guard agree.
//
// Precedence per threshold: explicit env override > derived-from-n_ctx > static
// default. Setting LRM_BIG_READ_KB / LRM_LOCAL_READ_MAX_CHARS pins that
// threshold (used by the eval for reproducible arms); leaving them unset lets it
// auto-track the GUI-configured context.
const ENV_MAX_KB = _intOrNull(process.env.LRM_BIG_READ_KB);
const ENV_MAX_CHARS = _intOrNull(process.env.LRM_LOCAL_READ_MAX_CHARS);
const OUTPUT_RESERVE = _int(process.env.LRM_READ_OUTPUT_RESERVE, 8192); // mirrors router cap
const SAFETY = _int(process.env.LRM_READ_SAFETY, 1024);                 // mirrors router cap
const READ_FRACTION = _num(process.env.LRM_READ_FRACTION, 0.5);         // of usable window per single read
const BYTES_PER_TOKEN = _num(process.env.LRM_READ_BYTES_PER_TOKEN, 3.7); // ~ASCII text/log; bytes≈chars
const CTX_TTL_MS = _int(process.env.LRM_READ_CTX_TTL_MS, 30_000);
// Under the local window a file's tokens are estimated from its characters, not
// from BYTES_PER_TOKEN: ASCII letters 1/4 each, digits and punctuation 1, whitespace
// 1/2, other characters 1, and a run of BLOB_RUN+ mixed letters and digits (base64,
// hashes) 1 per 1.3 characters. Measured with the router's tokenizer on 735
// workspace and pinchbench files, it was at most 6% under the real count (median
// 46% over), where 3.7 bytes/token was up to 3.7x under: a 96 KB log is 48.7k
// tokens, past a cap meant to hold 28k on the 4B. The estimate is of what `read`
// returns, so each line also costs its "<n>: " prefix: on a file of short lines
// the prefixes are more than half the output.
const BLOB_RUN = 24;

// Token estimate for text fed in pieces, with the weights above.
function tokenCounter(): { add: (text: string) => void; atLeast: () => number; total: () => number } {
  let tokens = 0;
  let run = 0;
  let runLetters = 0;
  let runDigits = 0;
  let runCost = 0;
  const endRun = () => {
    tokens += run >= BLOB_RUN && runLetters > 0 && runDigits > 0 ? run / 1.3 : runCost;
    run = runLetters = runDigits = runCost = 0;
  };
  return {
    add: (text) => {
      for (const character of text) {
        const code = character.codePointAt(0) ?? 0;
        const letter = (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
        const digit = code >= 48 && code <= 57;
        if (letter || digit || "+/=_-".includes(character)) {
          run += 1;
          if (letter) runLetters += 1;
          if (digit) runDigits += 1;
          runCost += letter ? 0.25 : 1;
          continue;
        }
        endRun();
        tokens += /\s/.test(character) ? 0.5 : 1;
      }
    },
    // An unfinished run only grows, so it costs at least the cheaper of its two rates so far.
    atLeast: () => tokens + Math.min(runCost, run / 1.3),
    total: () => {
      endRun();
      return tokens;
    },
  };
}

function estimateTextTokens(text: string): number {
  const counter = tokenCounter();
  counter.add(text);
  return counter.total();
}

// Estimated tokens of the "<n>: " prefix `read` puts on line n.
function linePrefixTokens(lineNo: number): number {
  return String(lineNo).length + 1.5;
}

async function estimateTokens(file: string, stopAbove: number): Promise<{ tokens: number; bytes: number }> {
  const stream = createReadStream(file, { encoding: "utf8", highWaterMark: 16 * 1024 });
  const counter = tokenCounter();
  let bytes = 0;
  let lineNo = 1;
  let prefixes = linePrefixTokens(1);
  // Line breaks as boundedLines splits them: \r\n, \n or a bare \r, also when a
  // \r\n pair straddles two chunks.
  let endsInCr = false;
  try {
    for await (const chunk of stream) {
      const text = chunk.toString();
      bytes += Buffer.byteLength(text, "utf8");
      counter.add(text);
      const breaks = (endsInCr && text.startsWith("\n") ? text.slice(1) : text).matchAll(/\r\n|\r|\n/g);
      for (const _ of breaks) {
        lineNo += 1;
        prefixes += linePrefixTokens(lineNo);
      }
      endsInCr = text.endsWith("\r");
      // Over budget: the rest of the file cannot change that.
      if (counter.atLeast() + prefixes > stopAbove) return { tokens: counter.atLeast() + prefixes, bytes };
    }
  } finally {
    stream.destroy();
  }
  return { tokens: counter.total() + prefixes, bytes };
}

let _ctxCache: { nctx: number | null; at: number } | null = null;
let _lastLoggedNctx: number | null = null;

async function _fetchLocalNctx(): Promise<number | null> {
  const base = (process.env.LRM_API_BASE_URL || "").replace(/\/+$/, "").replace(/\/v1$/, "");
  if (!base) return null;
  const url = `${base}/llm-router/v1/local/ctx-size`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const headers: Record<string, string> = {};
    const key = process.env.LRM_API_KEY;
    if (key) headers["Authorization"] = `Bearer ${key}`;
    // egress-surface: lrm_local_ctx_size
    const r = await fetch(url, { headers, signal: controller.signal });
    if (!r.ok) return null;
    const j: any = await r.json();
    // `applied` = ctx llama-server is actually running with; `ctx_size` is the
    // persisted override (may be null when running the registry default).
    const v = typeof j?.applied === "number" ? j.applied
      : typeof j?.ctx_size === "number" ? j.ctx_size : null;
    return typeof v === "number" && v > 0 ? v : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function _nctxCached(): Promise<number | null> {
  const now = Date.now();
  if (_ctxCache && now - _ctxCache.at < CTX_TTL_MS) return _ctxCache.nctx;
  const v = await _fetchLocalNctx();
  _ctxCache = { nctx: v, at: now };
  return v;
}

function _deriveReadTokens(nctx: number): number {
  const usable = Math.max(1, nctx - OUTPUT_RESERVE - SAFETY);
  return Math.max(1, Math.floor(usable * READ_FRACTION));
}

/**
 * Resolve the current thresholds: env override > derived-from-n_ctx > default.
 *
 * The n_ctx this derivation reads (GET /llm-router/v1/local/ctx-size) is a
 * local-llama-server-only signal — it is null for edge/cloud backends (no
 * local supervisor, no active-llm-tuning.json) as well as for a local server
 * that has not started yet. With no live n_ctx AND no explicit env pin, there
 * is no small-window signal to protect against, so this returns "unbounded"
 * (skip the cap) rather than falling back to a static small-local-window
 * guess that would needlessly throttle a large-context edge/cloud model. An
 * explicit env pin (either var) still wins, matching the precedence above —
 * that path exists for the eval harness's reproducible arms.
 */
async function resolveLimits(): Promise<{
  maxBytes: number;
  maxChars: number;
  // Token budget behind a derived maxBytes; null when maxBytes is pinned or a default.
  readTokens: number | null;
  source: string;
}> {
  if (ENV_MAX_KB !== null && ENV_MAX_CHARS !== null) {
    return { maxBytes: ENV_MAX_KB * 1024, maxChars: ENV_MAX_CHARS, readTokens: null, source: "env" };
  }
  const nctx = await _nctxCached();
  if (nctx !== null) {
    const readTokens = _deriveReadTokens(nctx);
    const derivedBytes = Math.ceil(readTokens * BYTES_PER_TOKEN);
    const derivedChars = Math.ceil(readTokens * BYTES_PER_TOKEN);
    return {
      maxBytes: ENV_MAX_KB !== null ? ENV_MAX_KB * 1024 : derivedBytes,
      maxChars: ENV_MAX_CHARS !== null ? ENV_MAX_CHARS : derivedChars,
      readTokens: ENV_MAX_KB !== null ? null : readTokens,
      source: `derived(n_ctx=${nctx})`,
    };
  }
  if (ENV_MAX_KB === null && ENV_MAX_CHARS === null) {
    return { maxBytes: Infinity, maxChars: Infinity, readTokens: null, source: "unbounded(no-local-n_ctx)" };
  }
  return {
    maxBytes: (ENV_MAX_KB ?? DEFAULT_MAX_KB) * 1024,
    maxChars: ENV_MAX_CHARS ?? DEFAULT_MAX_CHARS,
    readTokens: null,
    source: "default",
  };
}

function isHeaderPeek(args: any): boolean {
  const limit = typeof args?.limit === "number" ? args.limit : undefined;
  return limit !== undefined && limit <= PEEK_LINES;
}

function _posInt(v: unknown): number | undefined {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined;
}

async function* boundedLines(file: string): AsyncGenerator<string> {
  const stream = createReadStream(file, { encoding: "utf8", highWaterMark: 16 * 1024 });
  let prefix = "";
  let hasContent = false;
  let skipLf = false;
  try {
    for await (const chunk of stream) {
      for (const character of chunk.toString()) {
        if (skipLf && character === "\n") {
          skipLf = false;
          continue;
        }
        skipLf = character === "\r";
        if (character === "\r" || character === "\n") {
          yield prefix;
          prefix = "";
          hasContent = false;
        } else {
          hasContent = true;
          if (prefix.length < RUNTIME_MAX_LINE_CHARS) {
            prefix += character.slice(0, RUNTIME_MAX_LINE_CHARS - prefix.length);
          }
        }
      }
    }
    if (hasContent) yield prefix;
  } finally {
    stream.destroy();
  }
}

/**
 * Count how many lines starting at `offset` fit in `maxBytes` and `maxTokens`
 * (estimated) of read output, up to `limit`. `capped` is true only when a budget
 * (not EOF or the limit) stopped the count, i.e. the requested slice would not fit.
 */
async function linesThatFit(
  file: string,
  offset: number,
  limit: number,
  maxBytes: number,
  maxTokens = Infinity,
): Promise<{ lines: number; capped: boolean }> {
  let lineNo = 0;
  let lines = 0;
  let bytes = 0;
  let tokens = 0;
  let capped = false;
  for await (const text of boundedLines(file)) {
    lineNo += 1;
    if (lineNo < offset) continue;
    const cost = Buffer.byteLength(text, "utf8") + String(lineNo).length + 3;
    const tokenCost = maxTokens === Infinity ? 0 : estimateTextTokens(`${lineNo}: ${text}\n`);
    if (bytes + cost > maxBytes || tokens + tokenCost > maxTokens) {
      capped = true;
      break;
    }
    bytes += cost;
    tokens += tokenCost;
    lines += 1;
    if (lines >= limit) break;
  }
  return { lines, capped };
}

function partialViewNote(
  fp: string,
  kb: string,
  offset: number,
  limit: number,
  readsNeeded: number,
  localWindow: boolean,
): string {
  if (localWindow || readsNeeded > SEARCH_FIRST_READS) {
    const reason = localWindow
      ? `is ${kb} KB, more than the local model's context window can hold`
      : `is ${kb} KB; paging through it would take about ${readsNeeded} reads`;
    return (
      `\n\n[superclaw: PARTIAL VIEW. "${fp}" ${reason}, so this read was shortened to ${limit} ` +
      `line(s) starting at line ${offset} as a sample. Do not page through it. To find specific lines, use the bash tool: ` +
      `count matches first with grep -c PATTERN, then list a few with grep -n -m 50 PATTERN ` +
      `(put several greps in one bash call), then read around a match with offset and limit. ` +
      `For counts, totals or timelines, write a script that reads the whole file and prints only the result.]`
    );
  }
  const guidance = STRUCTURED_EXT.test(fp)
    ? "For counts, sums or filters over this data, compute over the whole file with a script; do not estimate from this slice."
    : "To cover the whole document, work through it section by section and keep notes as you go.";
  return (
    `\n\n[superclaw: PARTIAL VIEW. "${fp}" is ${kb} KB, more than one read can hold, so this read was ` +
    `shortened to ${limit} line(s) starting at line ${offset}. Continue with offset=${offset + limit}, ` +
    `or find what you need first with grep -n run through the bash tool. ${guidance}]`
  );
}

export const SuperclawReadOutputCap: Plugin = async ({ client, directory, worktree }) => {
  const _init = await resolveLimits();
  await client.app.log({
    body: {
      service: "superclaw-read-output-cap",
      level: "info",
      message: `Plugin initialised; mode=${MODE} maxChars=${_init.maxChars} blockKB=${Math.round(_init.maxBytes / 1024)} source=${_init.source} envKB=${ENV_MAX_KB ?? "-"} envChars=${ENV_MAX_CHARS ?? "-"} fraction=${READ_FRACTION} tools=[${[...READ_TOOLS].join(",")}]`,
    },
  });

  if (MODE === "off") return {};

  const baseDir = worktree || directory || process.cwd();
  const resolvePath = (fp: string | undefined): string | undefined => {
    if (!fp) return undefined;
    try {
      if (fp.startsWith("file://")) return fileURLToPath(fp);
    } catch {
      /* fall through */
    }
    return path.isAbsolute(fp) ? fp : path.resolve(baseDir, fp);
  };

  if (MODE === "block") {
    // callID -> PARTIAL VIEW note, appended to the read output after it runs.
    const notes = new Map<string, string>();
    // sessionID -> llmrouter model id, from chat.params (runs before the turn's tools).
    const sessionModels = new Map<string, string>();
    return {
      "chat.params": async (input) => {
        const sid = input?.sessionID;
        const modelID = input?.model?.id;
        if (typeof sid !== "string" || typeof modelID !== "string") return;
        sessionModels.delete(sid);
        if (sessionModels.size >= MAX_TRACKED_SESSIONS) {
          const oldest = sessionModels.keys().next().value;
          if (oldest !== undefined) sessionModels.delete(oldest);
        }
        sessionModels.set(sid, modelID);
      },
      "tool.execute.before": async (input: any, output: any) => {
        refuseImageRead(input, output, (fp) => resolvePath(fp));
        if (input.tool !== "read" || !output) return; // block-mode bounds the built-in read
        const args = output.args ?? {};
        const fp = args.filePath;
        const resolved = resolvePath(fp);
        if (!fp || !resolved || !DATA_EXT.test(resolved) || isHeaderPeek(args)) return;
        let size = 0;
        try {
          size = statSync(resolved).size;
        } catch {
          return; // can't stat -> let the read tool produce its own error
        }
        const limits = await resolveLimits();
        const modelID = sessionModels.get(String(input.sessionID ?? ""));
        const localWindow = modelID === undefined || LOCAL_SERVED_MODELS.has(modelID);
        let maxBytes = limits.maxBytes;
        let maxTokens = Infinity;
        // Under the local window a derived cap counts this file's tokens, and so does
        // the slice check, since one part of a file can be denser than another; the
        // density only sizes the logged cap. A pinned cap is used as given.
        if (localWindow && limits.readTokens !== null) {
          let estimate: { tokens: number; bytes: number };
          try {
            estimate = await estimateTokens(resolved, limits.readTokens);
          } catch {
            return;
          }
          if (estimate.tokens <= limits.readTokens) return;
          maxTokens = limits.readTokens;
          maxBytes = Math.floor((limits.readTokens * estimate.bytes) / estimate.tokens);
        }
        if (size <= maxBytes) return;

        const offset = _posInt(args.offset) ?? 1;
        const requested = _posInt(args.limit) ?? RUNTIME_DEFAULT_LIMIT;
        const budget = Math.min(maxBytes, RUNTIME_MAX_BYTES);
        let fit: { lines: number; capped: boolean };
        try {
          fit = await linesThatFit(
            resolved,
            offset,
            requested,
            maxTokens === Infinity ? budget : RUNTIME_MAX_BYTES,
            maxTokens,
          );
        } catch {
          return;
        }
        if (!fit.capped) return; // the requested slice fits: run it unchanged

        // A single line is always admitted: the runtime cuts it at 2000 chars.
        // Under the local window the slice is only a sample of the format.
        const limit = localWindow ? Math.min(Math.max(1, fit.lines), PEEK_LINES) : Math.max(1, fit.lines);
        args.limit = limit;
        output.args = args;

        const callID = String(input.callID ?? "");
        if (notes.size >= MAX_PENDING_NOTES) {
          const oldest = notes.keys().next().value;
          if (oldest !== undefined) notes.delete(oldest);
        }
        const readsNeeded = Math.ceil(size / budget);
        notes.set(callID, partialViewNote(fp, (size / 1024).toFixed(0), offset, limit, readsNeeded, localWindow));

        await client.app.log({
          body: {
            service: "superclaw-read-output-cap",
            level: "info",
            message: `Shortened read tool='read' size=${size} offset=${offset} limit=${requested}->${limit} readsNeeded=${readsNeeded} model=${modelID ?? "-"} localWindow=${localWindow} capKB=${Math.round(maxBytes / 1024)} callID=${callID.slice(0, 10)}`,
          },
        });
      },
      "tool.execute.after": async (input: any, output: any) => {
        const callID = String(input.callID ?? "");
        const note = notes.get(callID);
        if (note === undefined) return;
        notes.delete(callID);
        if (typeof output?.output === "string") output.output += note;
      },
    };
  }

  // MODE === "truncate" (block is the default; this branch handles the
  // explicit truncate override)
  return {
    "tool.execute.before": async (input: any, output: any) => refuseImageRead(input, output, (fp) => resolvePath(fp)),
    "tool.execute.after": async (input: any, output: any) => {
      if (!READ_TOOLS.has(input.tool)) return;

      const text = output?.output;
      if (typeof text !== "string") return;
      const { maxChars } = await resolveLimits();
      if (text.length <= maxChars) return;

      const originalLen = text.length;
      const head = text.slice(0, maxChars);
      output.output =
        head +
        `\n\n[superclaw: output truncated — ${originalLen} chars exceeded the ` +
        `${maxChars}-char cap; ${originalLen - maxChars} chars omitted. ` +
        `Re-run with a narrower scope (e.g. read with start_line/end_line, or tighten filters/limit) if you need more. Do not assume the file ends here.]`;

      await client.app.log({
        body: {
          service: "superclaw-read-output-cap",
          level: "warn",
          message: `Truncated tool='${input.tool}' ${originalLen}->${maxChars} chars sessionID=...${String(input.sessionID).slice(-12)} callID=${String(input.callID).slice(0, 10)}`,
        },
      });
    },
  };
};

// opencode SDK expects a direct function as the default export.
export default SuperclawReadOutputCap;

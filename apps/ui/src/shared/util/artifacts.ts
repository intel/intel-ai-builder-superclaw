import type { Part } from "@opencode-ai/sdk/v2/client";
import type {
  ArtifactItem,
  MessageWithParts,
} from "~/shared/types/session";
import { buildToolDetail, buildToolTitle, classifyTool, cleanReasoningText, normalizeStepText, truncateStepText } from "./tool-summary";

const ARTIFACT_PATH_PATTERN =
  /(?:^|[\s"'`([{])((?:[a-zA-Z]:[/\\]|\.{1,2}[/\\]|~[/\\]|[/\\])[\w\p{L}./\\\-]*\.[a-z][a-z0-9]{0,9}|[\w\p{L}.\-]+[/\\][\w\p{L}./\\\-]*\.[a-z][a-z0-9]{0,9})/giu;

const ARTIFACT_OUTPUT_SCAN_LIMIT = 4000;

const ARTIFACT_OUTPUT_SKIP_TOOLS = new Set([
  "webfetch",
  // Read-only / search tools — their output references files but does not create them
  "skill",
  "read",
  "grep",
  "glob",
  "search",
  "list",
  "list_files",
  // Document reader tools — read-only, output is file content, not new files
  "parse_pdf",
  "local_dr_read_csv_xlsx",
  "local_dr_read_pptx",
  "local_dr_read_docx",
  "local_dr_query_table",
  // Delegation / orchestration tools — subagent output contains internal paths
  "task",
  "todoread",
  "todowrite",
  // LSP tools — diagnostics, references, definitions are not artifacts
  "lsp_diagnostics",
  "lsp_find_references",
  "lsp_goto_definition",
  "lsp_symbols",
  "lsp_rename",
  "lsp_prepare_rename",
  // Deep research init — outputs directory paths, not user artifacts
  "deep_research_init_task",
  // Web search — outputs text summaries with URLs, not file paths
  "deep_research_search_web",
]);

// Tools whose state.input.filePath is a deterministic artifact path
const ARTIFACT_PRODUCING_TOOLS = new Set(["write", "edit"]);

// Heuristic: only scan bash command strings for paths when the command looks
// like it produces files.  Matches write-like keywords / operators so that
// pure read commands (`cat`, `head`, `grep`, etc.) don't inject their target
// files as artifacts.
// Note: `sed` is restricted to in-place edit (`-i`) to avoid false positives
// from read-only `sed -n '...' file`.  `awk` is omitted — it only writes via
// `>` redirection, which is already matched.
const BASH_WRITE_HEURISTIC =
  /(?:>|>>|\btee\b|\bsed\b\s+.*-i|\.save\b|\.write\b|\.to_csv\b|\.to_excel\b|\bsave\b|\bcreate\b|\btouch\b|\bmkdir\b|\bcp\b|\bmv\b|\binstall\b|\bbuild\b|\bwget\b|\bcurl\b.*-[oO]|--(?:out(?:put)?|dest(?:ination)?)\b|\bopen\(.*['"]w)/i;

// Heuristic: detect bash commands that delete files so their paths can be
// removed from the artifact list.  Matches rm, unlink, del, Remove-Item,
// shutil.rmtree, os.remove, os.unlink, and similar.
const BASH_DELETE_HEURISTIC =
  /(?:\brm\s|\brm\b.*-[rRf]|\bunlink\b|\bdel\b|\bRemove-Item\b|\bshutil\.rmtree\b|\bos\.remove\b|\bos\.unlink\b)/i;

// Patterns that indicate a path is a truncated system/absolute path rather than a workspace-relative path
const TRUNCATED_SYSTEM_PATH_PATTERNS = [
  /com\.[^/]+\.(openwork|opencode)/i, // macOS app bundle identifiers
  /\.openwork\.dev\//i, // OpenWork dev paths
  /Application Support\//i, // macOS Application Support
  /AppData[/\\]/i, // Windows AppData
  /\.local\/share\//i, // Linux XDG data
  /workspaces\/[^/]+\/workspaces\//i, // Nested workspaces paths (clearly malformed)
];

// Paths that are internal / intermediate and should never surface as user-facing artifacts
const ARTIFACT_INTERNAL_PATH_PATTERNS = [
  /^\.opencode\//i,
  /^\.config\//i,
  /^root\//i,
  /^home\//i,
  /^etc\//i,
  /^tmp\//i,
  /^temp\//i,
  /\/\.opencode\//i,
  /\/\.config\//i,
  /\/node_modules\//i,
  /^node_modules\//i, 
  /\/\.git\//i, 
  /\/subagent-outputs\//i, // sub-agent intermediate artifacts (mid-path)
  /^subagent-outputs\//i, // sub-agent intermediate artifacts (root-relative after prefix strip)
];

/**
 * Check if a cleaned path looks like a truncated regex false-positive.
 * Short path segments like "path/t" or "a/b.md" are likely noise.
 */
function looksLikeTruncatedPath(path: string): boolean {
  const segments = path.split("/").filter(Boolean);
  if (segments.length === 0) return true;
  // Single-segment paths are fine (e.g. "report.md", "slides.html")
  if (segments.length === 1) return false;
  // If any non-last segment is ≤ 1 char, it's likely a regex artifact (e.g. "a/report.md", "path/t.md")
  for (let i = 0; i < segments.length - 1; i++) {
    if (segments[i].length <= 1) return true;
  }
  // If the filename (last segment) has no proper extension or is ≤ 2 chars, reject
  const filename = segments[segments.length - 1];
  if (filename.length <= 2) return true;
  return false;
}

/**
 * Clean up an artifact path to extract the workspace-relative portion.
 * Returns null if the path should be rejected entirely.
 */
function cleanArtifactPath(rawPath: string): string | null {
  let normalized = rawPath.trim().replace(/[\\/]+/g, "/");
  if (!normalized) return null;

  // Check if this looks like a truncated system path
  for (const pattern of TRUNCATED_SYSTEM_PATH_PATTERNS) {
    if (pattern.test(normalized)) {
      // Try to extract just the relative part after "workspaces/<name>/"
      const workspacesMatch = normalized.match(/workspaces\/[^/]+\/(.+)$/i);
      if (workspacesMatch && workspacesMatch[1]) {
        const relative = workspacesMatch[1];
        // Validate the extracted path doesn't still contain system patterns
        if (!TRUNCATED_SYSTEM_PATH_PATTERNS.some((p) => p.test(relative))) {
          return relative;
        }
      }
      // Reject the path entirely if we can't extract a clean relative path
      return null;
    }
  }

  // Strip container/workspace directory prefix that appears in sandboxed setups
  // where the file-session root is the parent of the workspace directory.
  // e.g. "workspace/slides.html" → "slides.html", "/workspace/foo.md" → "foo.md"
  normalized = normalized.replace(/^\/?workspace\//i, "");

  // Strip leading slashes left over after prefix removal
  normalized = normalized.replace(/^\/+/, "");

  // Reject internal / intermediate paths that shouldn't surface as user artifacts
  for (const pattern of ARTIFACT_INTERNAL_PATH_PATTERNS) {
    if (pattern.test(normalized)) return null;
  }

  // Reject paths that look like truncated regex false-positives
  if (looksLikeTruncatedPath(normalized)) return null;

  return normalized || null;
}

type DeriveArtifactsOptions = {
  maxMessages?: number;
};

/** Fields read off tool parts. Wider than the SDK union so legacy path/file/size still type-check. */
type LooseToolState = {
  status?: unknown;
  input?: unknown;
  output?: unknown;
  title?: unknown;
  metadata?: { name?: unknown };
  path?: unknown;
  file?: unknown;
  files?: unknown;
  size?: unknown;
};

function looseToolPart(part: Part): { tool?: unknown; state?: LooseToolState } {
  return part as { tool?: unknown; state?: LooseToolState };
}

function toolInputRecord(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  return input as Record<string, unknown>;
}

export function summarizeStep(part: Part): {
  title: string;
  detail?: string;
  isSkill?: boolean;
  skillName?: string;
  toolCategory?: string;
  status?: string;
} {
  if (part.type === "tool") {
    const record = looseToolPart(part);
    const toolName = record.tool ? String(record.tool) : "Tool";
    const state = record.state ?? {};
    const title = buildToolTitle(state, toolName);
    const category = classifyTool(toolName);
    const status = state.status ? String(state.status) : undefined;
    const detail = buildToolDetail(state, toolName);
    const normalizedTitle = normalizeStepText(title).toLowerCase();
    const finalDetail =
      detail && normalizeStepText(detail).toLowerCase() !== normalizedTitle
        ? detail
        : undefined;

    // Detect skill trigger
    if (category === "skill") {
      const rawSkillName = state.metadata?.name;
      const skillName =
        typeof rawSkillName === "string" && rawSkillName
          ? rawSkillName
          : title.replace(/^(Loaded skill:\s*|Load skill\s+)/i, "");
      return {
        title,
        isSkill: true,
        skillName,
        detail: finalDetail,
        toolCategory: category,
        status,
      };
    }

    return { title, detail: finalDetail, toolCategory: category, status };
  }

  if (part.type === "reasoning") {
    const text =
      typeof part.text === "string" ? cleanReasoningText(part.text) : "";
    if (!text) return { title: "Thinking", toolCategory: "tool" };

    const lines = text
      .split(/\r?\n/)
      .map((line: string) => line.trim())
      .filter(Boolean);
    const compact = lines.join(" ");

    let headline = "";
    let detail = "";
    if (lines.length > 1) {
      headline = lines[0];
      detail = lines.slice(1).join("\n");
    } else {
      const sentenceBreak = compact.indexOf(". ");
      if (sentenceBreak > 18 && sentenceBreak < 120) {
        headline = compact.slice(0, sentenceBreak + 1).trim();
        detail = compact.slice(sentenceBreak + 2).trim();
      } else {
        headline = compact;
        detail = compact;
      }
    }

    headline = headline.replace(/^thinking[:\s-]*/i, "").trim();
    const title = `Thinking: ${truncateStepText(headline || "reviewing context", 96)}`;
    return { title, detail: detail || undefined, toolCategory: "tool" };
  }

  if (part.type === "step-start" || part.type === "step-finish") {
    const reason = part.type === "step-finish" ? part.reason : undefined;
    return {
      title: part.type === "step-start" ? "Step started" : "Step finished",
      detail: reason ? String(reason) : undefined,
      toolCategory: "tool",
    };
  }

  return { title: "Step", toolCategory: "tool" };
}

export function deriveArtifacts(
  list: MessageWithParts[],
  options: DeriveArtifactsOptions = {},
): ArtifactItem[] {
  const results = new Map<string, ArtifactItem>();
  const deletions = new Set<string>();
  const dirDeletions = new Set<string>(); // directory-level deletions (prefix match)
  const maxMessages =
    typeof options.maxMessages === "number" &&
    Number.isFinite(options.maxMessages) &&
    options.maxMessages > 0
      ? Math.floor(options.maxMessages)
      : null;
  const source =
    maxMessages && list.length > maxMessages
      ? list.slice(list.length - maxMessages)
      : list;

  source.forEach((message) => {
    const messageId = message.info.id;

    message.parts.forEach((part) => {
      if (part.type !== "tool") return;
      const record = looseToolPart(part);
      const state = record.state ?? {};
      const matches = new Set<string>();
      // Tracks matches from deterministic layers (1-4) whose writes should
      // override prior deletions (a re-create after rm).  Heuristic matches
      // (Layer 5/6 regex scans) do NOT clear deletions to avoid the race
      // where `rm old.md && cp new.md out.md` regex-matches old.md as both
      // a deletion and a write.
      const deterministicMatches = new Set<string>();

      const toolName =
        typeof record.tool === "string" && record.tool.trim()
          ? record.tool.trim().toLowerCase()
          : "";

      // ── Layer 1: Deterministic extraction from write/edit tools ────────
      if (ARTIFACT_PRODUCING_TOOLS.has(toolName)) {
        const input = toolInputRecord(state.input);
        const filePath =
          (typeof input.filePath === "string" ? input.filePath.trim() : "") ||
          (typeof input.path === "string" ? input.path.trim() : "") ||
          (typeof input.file === "string" ? input.file.trim() : "");
        if (filePath && filePath.length <= 500 && filePath.includes(".")) {
          matches.add(filePath);
          deterministicMatches.add(filePath);
        }
      }

      // ── Layer 2: Structured parse for apply_patch ──────────────────────
      if (toolName === "apply_patch") {
        const input = toolInputRecord(state.input);
        const patch = typeof input.patch === "string" ? input.patch : "";
        if (patch) {
          for (const m of patch.matchAll(
            /\*\*\*\s+(?:Update|Add)\s+File:\s*(\S+)/g,
          )) {
            if (m[1] && m[1].length <= 500) {
              matches.add(m[1]);
              deterministicMatches.add(m[1]);
            }
          }
          // Detect file deletions in apply_patch
          for (const m of patch.matchAll(/\*\*\*\s+Delete\s+File:\s*(\S+)/g)) {
            if (m[1] && m[1].length <= 500) {
              const cleaned = cleanArtifactPath(m[1]);
              if (cleaned) deletions.add(cleaned.toLowerCase());
            }
          }
        }
      }

      // ── Layer 4: Legacy explicit fields (custom tools with state.path/file/files)
      const explicit = [
        state.path,
        state.file,
        ...(Array.isArray(state.files) ? state.files : []),
      ];

      explicit.forEach((f: unknown) => {
        if (typeof f === "string") {
          const trimmed = f.trim();
          if (
            trimmed.length > 0 &&
            trimmed.length <= 500 &&
            trimmed.includes(".") &&
            !/^\.{2,}$/.test(trimmed)
          ) {
            matches.add(trimmed);
          }
        }
      });

      // ── Layer 5: Fallback regex scan for unknown tools ─────────────────
      // Skip scanning title/output for tools in the skip list and for tools
      // already handled deterministically above (write/edit/apply_patch).
      // Bash is skipped here because it has its own dedicated Layer 6/7
      // handling with write/delete heuristics — running Layer 5 on bash
      // would bypass those heuristics and add read-only paths as artifacts.
      if (
        !ARTIFACT_OUTPUT_SKIP_TOOLS.has(toolName) &&
        !ARTIFACT_PRODUCING_TOOLS.has(toolName) &&
        toolName !== "apply_patch" &&
        toolName !== "bash"
      ) {
        const titleText = typeof state.title === "string" ? state.title : "";
        const outputText =
          typeof state.output === "string"
            ? state.output.slice(0, ARTIFACT_OUTPUT_SCAN_LIMIT)
            : "";

        const text = [titleText, outputText]
          .filter((v): v is string => Boolean(v))
          .join(" ");

        if (text) {
          ARTIFACT_PATH_PATTERN.lastIndex = 0;
          Array.from(text.matchAll(ARTIFACT_PATH_PATTERN))
            .map((m) => m[1])
            .filter((f) => f && f.length <= 500)
            .forEach((f) => matches.add(f));
        }
      }

      // ── Layer 6 & 7: Bash command scan ────────────────────────────────
      // Layer 6: Scan the bash command string for file paths when the
      //   command looks like it produces files.  Pure read-only commands
      //   (cat, head, grep, etc.) are skipped via BASH_WRITE_HEURISTIC.
      // Layer 7: Detect deletion commands (rm, unlink, del, etc.) and
      //   record the deleted paths for removal at the end.
      if (toolName === "bash") {
        const input = toolInputRecord(state.input);
        const command: string =
          typeof input.command === "string"
            ? input.command.slice(0, ARTIFACT_OUTPUT_SCAN_LIMIT)
            : "";

        if (command) {
          // Layer 6: write-command scan
          if (BASH_WRITE_HEURISTIC.test(command)) {
            ARTIFACT_PATH_PATTERN.lastIndex = 0;
            Array.from(command.matchAll(ARTIFACT_PATH_PATTERN))
              .map((m) => m[1])
              .filter((f) => f && f.length <= 500)
              .forEach((f) => matches.add(f));
          }

          // Layer 7: delete-command detection
          if (BASH_DELETE_HEURISTIC.test(command)) {
            ARTIFACT_PATH_PATTERN.lastIndex = 0;
            for (const m of command.matchAll(ARTIFACT_PATH_PATTERN)) {
              const raw = m[1];
              if (!raw || raw.length > 500) continue;
              const cleaned = cleanArtifactPath(raw);
              if (cleaned) deletions.add(cleaned.toLowerCase());
            }
            // Also extract directory-like arguments (no extension) from
            // recursive delete commands (e.g. `rm -rf dist`) for prefix
            // matching against existing artifacts.
            for (const m of command.matchAll(
              /\brm\s+(?:-[rRf]+\s+)*([^\s;|&]+)/g,
            )) {
              const raw = (m[1] ?? "")
                .trim()
                .replace(/[\\/]+/g, "/")
                .replace(/\/+$/, "");
              if (!raw || raw.length > 500 || raw.includes(".")) continue; // skip files with extensions
              const cleaned = cleanArtifactPath(raw + "/placeholder.x"); // borrow cleanArtifactPath for prefix cleanup
              if (cleaned) {
                const dirPrefix = cleaned
                  .replace(/\/placeholder\.x$/, "")
                  .toLowerCase();
                if (dirPrefix) dirDeletions.add(dirPrefix);
              }
            }
          }
        }
      }

      if (matches.size === 0) return;

      matches.forEach((match) => {
        const cleanedPath = cleanArtifactPath(match);
        if (!cleanedPath) return;

        const key = cleanedPath.toLowerCase();
        const name = cleanedPath.split("/").pop() ?? cleanedPath;
        const id = `artifact-${encodeURIComponent(cleanedPath)}`;

        // A deterministic write after a deletion means the file was re-created.
        // Only clear deletions for deterministic layers (1-4), not for
        // heuristic regex matches (Layer 5/6) which may false-positive.
        if (deterministicMatches.has(match)) {
          deletions.delete(key);
        }

        // Delete and re-add to move to end (most recent)
        if (results.has(key)) results.delete(key);
        results.set(key, {
          id,
          name,
          path: cleanedPath,
          kind: "file" as const,
          size: state.size ? String(state.size) : undefined,
          messageId: messageId || undefined,
        });
      });
    });
  });

  // Remove artifacts whose files were deleted after creation
  for (const key of deletions) {
    results.delete(key);
  }

  // Remove artifacts under directories that were recursively deleted
  if (dirDeletions.size > 0) {
    for (const key of results.keys()) {
      for (const dir of dirDeletions) {
        if (key.startsWith(dir + "/")) {
          results.delete(key);
          break;
        }
      }
    }
  }

  return Array.from(results.values());
}

export function deriveWorkingFiles(items: ArtifactItem[]): string[] {
  const results: string[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    const rawKey = item.path ?? item.name;
    const normalizedPath = rawKey.trim().replace(/[\\/]+/g, "/");
    const normalizedKey = normalizedPath.toLowerCase();
    if (!normalizedPath || seen.has(normalizedKey)) continue;
    seen.add(normalizedKey);
    results.push(normalizedPath);
    if (results.length >= 5) break;
  }

  return results;
}

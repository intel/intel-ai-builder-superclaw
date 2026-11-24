import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const PROTECTED_EXTS = new Set(["csv", "xlsx", "xls", "parquet", "txt", "md", "html", "htm", "docx"]);
const WINDOWS_ABSOLUTE_PATH_RE = /^[A-Za-z]:[\\/]/;
const MASKED_OUTPUT_PATH_RE = /data_protection_workspace[\/\\]masked_datasets[\/\\]/i;
const MASKED_OUTPUT_BASENAME_RE = /_masked\.[A-Za-z0-9]+$/i;
const OUTPUT_RESTORED_PATHS_KEY = "__sc_output_restored_paths";
const OUTPUT_RESTORED_PATH_TTL_MS = 30 * 60 * 1000;
const MODE_PATH = "/llm-router/v1/data-protection/mode";
const MODE_FETCH_TIMEOUT_MS = 1_500;
const BASH_PROTECTED_EXT_RE =
  /(?:\b[A-Za-z]:(?=[\\/]))?[\w./\\~-]*\.(?:csv|xlsx|xls|parquet|txt|md|html|htm|docx)\b/gi;
const BASH_STANDALONE_METADATA_RE =
  /^[ \t]*(?:ls|dir|stat)(?:[ \t]+(?:"(?:[^"`$\\\r\n]|\\[^"`$\r\n])*"|'[^'\r\n]*'|[^\s"'`$&|;<>()]+))*[ \t]*$/i;

export function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
}

export function canonicalWindowsPath(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  const drive = normalized.slice(0, 2).toLowerCase();
  const segments: string[] = [];
  for (const segment of normalized.slice(2).split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return `${drive}/${segments.join("/")}`;
}

function canonicalPath(value: string): string {
  const normalized = normalizeSlashes(value);
  return WINDOWS_ABSOLUTE_PATH_RE.test(normalized) ? canonicalWindowsPath(normalized) : normalized;
}

/** Unavailable mode information must never open the source-file gate. */
export async function protectionOff(): Promise<boolean> {
  const apiKey = process.env.LRM_API_KEY?.trim();
  const bases = [
    process.env.LRM_API_BASE_URL,
    "http://127.0.0.1:18321",
    "http://host.docker.internal:18321",
  ].filter((value): value is string => Boolean(value?.trim()));
  for (const base of bases) {
    try {
      // egress-surface: lrm_data_protection_mode
      const response = await fetch(`${base.replace(/\/$/, "")}${MODE_PATH}`, {
        signal: AbortSignal.timeout(MODE_FETCH_TIMEOUT_MS),
        ...(apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : {}),
      });
      if (!response.ok) continue;
      const data = (await response.json()) as { applied?: unknown };
      if (typeof data.applied === "string") {
        return data.applied.trim().toLowerCase() === "none";
      }
    } catch {
      continue;
    }
  }
  return false;
}

function outputRestoreScanRoot(): string {
  const override = process.env.SC_OUTPUT_RESTORE_SCAN_ROOT?.trim();
  if (override) return override;
  const nativeRoot = process.env.OPENCODE_DIRECTORY?.trim();
  if (nativeRoot && WINDOWS_ABSOLUTE_PATH_RE.test(nativeRoot)) {
    return nativeRoot.replace(/\\/g, "/").replace(/(?<!^[A-Za-z]:)\/+$/, "");
  }
  return "/workspace";
}

function isFreshOutputRestoredPath(path: string): boolean {
  const g = globalThis as unknown as Record<string, Map<string, number> | undefined>;
  const restored = (g[OUTPUT_RESTORED_PATHS_KEY] ??= new Map<string, number>());
  const key = canonicalPath(path);
  for (const [recorded, addedAt] of restored) {
    if (canonicalPath(recorded) === key && Date.now() - addedAt < OUTPUT_RESTORED_PATH_TTL_MS) return true;
  }
  return false;
}

function isRegisteredGeneratedOutput(path: string): boolean {
  const registry = process.env.SC_GENERATED_OUTPUTS_REGISTRY?.trim() ||
    `${outputRestoreScanRoot()}/data_protection_workspace/mask_registries/.generated_outputs.json`;
  try {
    const parsed: { paths?: unknown } = JSON.parse(readFileSync(registry, "utf-8"));
    const key = canonicalPath(path);
    return Array.isArray(parsed?.paths) &&
      parsed.paths.some((p: unknown) => typeof p === "string" && canonicalPath(p) === key);
  } catch {
    return false;
  }
}

/** Provenance exceptions match the terminal guard's generated-output records. */
export function isDerivedOutputPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return MASKED_OUTPUT_PATH_RE.test(normalized) ||
    MASKED_OUTPUT_BASENAME_RE.test(normalized) ||
    isFreshOutputRestoredPath(normalized) ||
    isRegisteredGeneratedOutput(normalized);
}

/** Keep /workspace resolution aligned with plugin 04, including /cd-bound instances. */
export function hostPath(path: string, directory: string): string | null {
  if (path.startsWith("~")) return null;
  if (/^\.{1,2}[\/\\]/.test(path)) return directory.trim() ? resolve(directory.trim(), path) : null;
  const m = /^\/workspace(?=\/|$)/.exec(path);
  if (!m) return process.platform === "win32" && path.startsWith("/") ? null : path;
  const root = normalizeSlashes(
    process.env.SUPERCLAW_PATH?.trim() || process.env.OPENCODE_DIRECTORY?.trim() || "",
  ).replace(/\/$/, "");
  if (!root || root === "/workspace") return process.platform === "win32" ? null : path;
  const dir = normalizeSlashes(directory.trim()).replace(/\/$/, "");
  const fold = (s: string) => (WINDOWS_ABSOLUTE_PATH_RE.test(root) ? s.toLowerCase() : s);
  const target = dir && fold(dir).startsWith(`${fold(root)}/`) ? `${root}${dir.slice(root.length)}` : root;
  return target + path.slice(m[0].length);
}

export async function isMissingFile(path: string | null): Promise<boolean> {
  if (path === null) return false;
  try {
    const bun = (globalThis as unknown as { Bun?: { file: (path: string) => { exists: () => Promise<boolean> } } }).Bun;
    if (bun?.file) return !(await bun.file(path).exists());
  } catch {
    // An existence-check failure cannot establish that a path is a write destination.
  }
  return false;
}

function fileStamp(path: string): string | null {
  try {
    const st = statSync(path);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return null;
  }
}

function readPath(args: Record<string, unknown>): string {
  const path = args.file_path ?? args.path ?? args.filePath;
  return typeof path === "string" ? path.trim() : "";
}

function includeMayMatchProtectedFile(include: unknown): boolean {
  if (typeof include !== "string" || !include.trim()) return true;
  const pattern = include.trim();
  if (/[!\[\]{},;|\r\n]/.test(pattern)) return true;
  const extension = /\.([A-Za-z0-9]+)$/.exec(pattern)?.[1];
  return !extension || PROTECTED_EXTS.has(extension.toLowerCase());
}

function grepMayReadProtectedSource(
  args: Record<string, unknown>,
  directory: string,
  sessionID: string,
  isSelfWritten: (sessionID: string, path: string) => boolean,
): boolean {
  const path = readPath(args);
  if (!path) return true;
  if (isDerivedOutputPath(path) || isSelfWritten(sessionID, path)) return false;

  const extension = /\.([A-Za-z0-9]+)$/.exec(path)?.[1];
  if (extension && PROTECTED_EXTS.has(extension.toLowerCase())) return true;

  const target = hostPath(path, directory);
  if (!target) return true;
  try {
    const stats = statSync(target);
    if (stats.isFile()) return false;
    return !stats.isDirectory() || includeMayMatchProtectedFile(args.include);
  } catch {
    return true;
  }
}

type ToolCall = { sessionID: string; callID: string; tool: string };

/** Shared raw-source policy for the built-in coordinator and opted-in custom agents. */
export function createProtectedSourceAccess(directory: string, guardGrep = true) {
  const selfWritten = new Map<string, Map<string, string>>();
  const pendingWrites = new Map<string, { sessionID: string; path: string; before: string | null }>();
  const isSelfWritten = (sessionID: string, path: string): boolean => {
    const stamp = selfWritten.get(sessionID)?.get(canonicalPath(path));
    return stamp !== undefined && fileStamp(path) === stamp;
  };

  return {
    async before(input: ToolCall, args: Record<string, unknown>, pinnedLocal: boolean): Promise<string | null> {
      const { sessionID, callID, tool } = input;
      const path = readPath(args);
      if ((tool === "write" || tool === "edit") && path &&
          (tool === "write" || isSelfWritten(sessionID, path))) {
        pendingWrites.set(callID, { sessionID, path, before: fileStamp(path) });
      }
      if (pinnedLocal) return null;
      let violation: string | null = null;
      if (tool === "bash" && typeof args.command === "string" && !BASH_STANDALONE_METADATA_RE.test(args.command)) {
        for (const match of args.command.matchAll(BASH_PROTECTED_EXT_RE)) {
          const hit = normalizeSlashes(match[0]);
          if (isDerivedOutputPath(hit) || isSelfWritten(sessionID, hit)) continue;
          violation = `'${hit.slice(0, 120)}' is a protected-capable file type opened via 'bash' instead of 'read'.`;
          break;
        }
      }
      if (tool === "read") {
        const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
        if (PROTECTED_EXTS.has(ext) && !isDerivedOutputPath(path) &&
            !isSelfWritten(sessionID, path) && !(await isMissingFile(hostPath(path, directory)))) {
          violation = `direct 'read' of a protected file type (.${ext}).`;
        }
      }
      if (guardGrep && tool === "grep" &&
          grepMayReadProtectedSource(args, directory, sessionID, isSelfWritten)) {
        violation = "content search may read a protected-capable source file.";
      }
      if (!violation || await protectionOff()) return null;
      return `BLOCKED: ${violation}\nRequired next action:\n` +
        "  1. Call confirm_file_protection with the original user request.\n" +
        '  2. If APPROVED → task(subagent_type="protected-file-agent", ...).\n' +
        '  3. If ACTION_DENIED or PROTECTION_DECLINED → task(subagent_type="local-file-agent", ...).\n' +
        `Do NOT retry '${tool}' on this file. Your next output MUST be the confirm_file_protection call.`;
    },
    after(input: ToolCall): void {
      const pending = pendingWrites.get(input.callID);
      if (!pending) return;
      pendingWrites.delete(input.callID);
      const stamp = fileStamp(pending.path);
      if (!stamp || stamp === pending.before) return;
      const paths = selfWritten.get(input.sessionID) ?? new Map<string, string>();
      paths.set(canonicalPath(pending.path), stamp);
      selfWritten.set(input.sessionID, paths);
    },
    clear(sessionID: string): void {
      selfWritten.delete(sessionID);
      for (const [callID, pending] of pendingWrites) {
        if (pending.sessionID === sessionID) pendingWrites.delete(callID);
      }
    },
  };
}

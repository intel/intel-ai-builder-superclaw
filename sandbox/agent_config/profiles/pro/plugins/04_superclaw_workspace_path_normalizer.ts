/**
 * workspace_path_normalizer — map the logical `/workspace` root to the real
 * workspace directory in tool arguments, at the tool boundary.
 *
 * Why: prompts, skills, and the model's own habits all speak in `/workspace/...`
 * (the container mount point). On the Windows-native backend the real workspace
 * is `%USERPROFILE%\SuperClawProjects` (SUPERCLAW_PATH / OPENCODE_DIRECTORY), so
 * every `/workspace/...` path the agent emits misses — `ls`, `read`, `glob`,
 * `bash` all fail and the model burns tool calls probing for the real root
 * (agent-suite finding from the native move; Kimi harness feedback #1/#2). Rather than edit
 * ~143 `/workspace` literals across prompts/plugins/tools, converge the mapping
 * to ONE function here: the model keeps writing one path form, and the tool layer
 * rewrites it.
 *
 * Runs FIRST (04, before 05/08/90) so downstream guards and tools see real paths.
 * Container-safe: when the root is unset or already `/workspace`, this is a no-op,
 * so behaviour is identical in the container.
 *
 * Mutates `output.args` in place (same contract as 05_file_path_arg_rename.ts).
 */
import type { Plugin } from "@opencode-ai/plugin";
import { existsSync } from "node:fs";
import { win32 } from "node:path";

// Path-bearing string args, by tool. bash `command` is handled specially
// (multiple occurrences inside a shell string).
const PATH_ARG_KEYS = ["filePath", "file_path", "path", "pattern", "workdir"];
// Args that are always filesystem paths (unlike `pattern`, which may be a regex).
const FS_PATH_ARG_KEYS = ["filePath", "file_path", "path", "workdir"];
// Args naming what a read-type tool opens. glob `pattern` counts only when absolute;
// grep `pattern` is a regex.
const FILE_ARGS = ["filePath", "file_path", "path"];
const SOURCE_ARGS = ["source_file_path", "source_file_paths"];
const READ_ARG_KEYS = new Map<string, string[]>([
  ["read", FILE_ARGS], ["list", FILE_ARGS], ["glob", ["path", "pattern"]], ["grep", ["path"]],
  ["parse_pdf", ["file_path"]], ["ocr", ["file_path"]],
  ["local_dr_read_docx", ["file_path"]], ["local_dr_read_pptx", ["file_path"]],
  ["local_dr_read_csv_xlsx", ["path"]], ["local_dr_query_table", ["path"]],
  ["confirm_file_protection", SOURCE_ARGS], ["run_protected_file_pipeline", SOURCE_ARGS],
]);

/**
 * Forward-slashed real readers-venv interpreter, or "" if not resolvable.
 * Inlined (not imported from ../tools/_python_env) so the plugin has no
 * cross-directory import — a bad import silently fails the whole plugin load.
 * Mirrors tools/_python_env.ts resolveReadersPython().
 */
function readersPython(): string {
  const venv = process.env.READERS_VENV?.trim();
  if (venv) {
    const win = `${venv}/Scripts/python.exe`.replace(/\\/g, "/");
    if (existsSync(win)) return win;
    const posix = `${venv}/bin/python`.replace(/\\/g, "/");
    if (existsSync(posix)) return posix;
  }
  const agent = process.env.OPENCODE_PYTHON?.trim();
  if (agent) return agent.replace(/\\/g, "/");
  return "";
}

/** Forward-slashed real readers script dir (the native payload's READERS_DIR). */
function readersDir(): string {
  const dir = process.env.READERS_DIR?.trim();
  if (!dir) return "";
  return dir.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** Real workspace root, forward-slashed, no trailing slash. Empty if not native. */
function workspaceRoot(): string {
  const raw =
    process.env.SUPERCLAW_PATH?.trim() ||
    process.env.OPENCODE_DIRECTORY?.trim() ||
    "";
  if (!raw) return "";
  const fwd = raw.replace(/\\/g, "/").replace(/\/+$/, "");
  // Container already mounts the workspace at /workspace — nothing to map.
  if (fwd === "/workspace") return "";
  return fwd;
}

/**
 * Where `/workspace` maps for this OpenCode instance. A chat bound with `/cd <subdir>`
 * runs in an instance whose directory is that subdirectory, and OpenCode resolves
 * relative paths against it; map `/workspace` there too so both agree. Any other
 * directory (unset, the root itself, or outside the root) keeps the root.
 */
function workspaceTarget(root: string, directory: string | undefined): string {
  const dir = directory?.trim().replace(/\\/g, "/").replace(/\/+$/, "") ?? "";
  // A drive-letter root follows Windows path rules on any host (e.g. Linux CI).
  const fold = (s: string) => (/^[A-Za-z]:\//.test(root) ? s.toLowerCase() : s);
  return dir && fold(dir).startsWith(`${fold(root)}/`) ? `${root}${dir.slice(root.length)}` : root;
}

/**
 * `/workspace` target for a shell command. A bound subdirectory is used only when
 * every character is shell-inert; otherwise the command keeps the root, unchanged
 * from a root session. No quoting is ever inserted into a command.
 */
function shellTarget(root: string, target: string): string {
  return /^[A-Za-z0-9._\/:-]+$/.test(target) ? target : root;
}

/**
 * Replace `/workspace` path segments with the real root. Anchored to path
 * boundaries so a substring like `/workspaces/x` or prose is left alone.
 * Handles bare paths, quoted paths, and occurrences inside shell commands.
 */
function mapWorkspace(value: string, root: string): string {
  let out = value.replace(
    /(^|[\s"'`=(:,])\/workspace(?=$|[\/\s"'`),;|&])/g,
    (_m, pre) => `${pre}${root}`,
  );

  // Also map the container readers paths the skill docs still reference
  // (docx/pptx/spreadsheet SKILL.md). Order matters: rewrite the venv
  // interpreter BEFORE the bare /opt/readers dir so the two don't collide.
  const py = readersPython();
  if (py) {
    out = out.replace(/\/opt\/readers-venv\/bin\/python3?\b/g, py);
  }
  const rdir = readersDir();
  if (rdir) {
    // /opt/readers (dir) but NOT /opt/readers-venv (already handled above).
    out = out.replace(/\/opt\/readers(?=$|[\/\s"'`),;|&])/g, rdir);
  }
  return out;
}

/** Real temp dir, forward-slashed; empty unless it is a Windows path. */
function tempDir(): string {
  const raw = process.env.TMPDIR?.trim() || process.env.TEMP?.trim() || "";
  const fwd = raw.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[A-Za-z]:\//.test(fwd) ? fwd : "";
}

/** The published Profile's skills directory, forward-slashed; empty if unset. */
function configSkillsDir(): string {
  const dir = process.env.OPENCODE_CONFIG_DIR?.trim();
  if (!dir) return "";
  return `${dir.replace(/\\/g, "/").replace(/\/+$/, "")}/skills`;
}

/** OpenCode's truncated tool-output directory, forward-slashed; empty if unset. */
function toolOutputDir(): string {
  const dir = process.env.XDG_DATA_HOME?.trim();
  if (!dir) return "";
  return `${dir.replace(/\\/g, "/").replace(/\/+$/, "")}/opencode/tool-output`;
}

/**
 * OpenCode describes the bash tool as "Shell: bash" on win32, so models write Git-Bash
 * (`/c/Users`), `/mnt/c/Users` and `/tmp` paths. The pinned shell maps
 * none of them; rewrite them to real Windows paths.
 */
function mapPosixWindowsPaths(value: string): string {
  const toDrive = (m: string, pre: string, drive: string) =>
    existsSync(`${drive}:/`) && !existsSync(`/${drive}`) ? `${pre}${drive.toUpperCase()}:` : m;
  let out = value
    .replace(/(^|[\s"'`=(,;|&<>])\/mnt\/([A-Za-z])(?=$|[\/\s"'`),;|&<>])/g, toDrive)
    .replace(/(^|[\s"'`=(,;|&<>])\/([A-Za-z])(?=\/)/g, toDrive);
  const tmp = tempDir();
  if (tmp) {
    out = out.replace(
      /(^|[\s"'`=(,;|&<>])\/tmp(?=$|[\/\s"'`),;|&<>])/g,
      (_m, pre: string) => `${pre}${tmp}`,
    );
  }
  return out;
}

/**
 * An unquoted backslash is an escape in sh, so `C:\Users\x` reaches the program as
 * `C:Usersx`. Forward-slash unquoted drive paths; quoted text and heredocs are left alone.
 */
function forwardSlashUnquotedDrivePaths(cmd: string): string {
  let out = "";
  let i = 0;
  while (i < cmd.length) {
    if (cmd.startsWith("<<", i)) return out + cmd.slice(i);
    const c = cmd[i];
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < cmd.length && cmd[j] !== c) j += c === '"' && cmd[j] === "\\" ? 2 : 1;
      out += cmd.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    const path = /^[A-Za-z]:\\[^\s"'`;|&<>()]*/.exec(cmd.slice(i))?.[0];
    // A trailing backslash may be escaping a space (`C:\Program\ Files`); leave those.
    if (path && !path.endsWith("\\") && (i === 0 || /[\s=(;|&<>]/.test(cmd[i - 1]))) {
      out += path.replace(/\\/g, "/");
      i += path.length;
      continue;
    }
    const step = c === "\\" ? 2 : 1;
    out += cmd.slice(i, i + step);
    i += step;
  }
  return out;
}

/** True if the resolved Windows `target` is one of the non-empty `roots` or inside one. */
function isInside(target: string, roots: string[]): boolean {
  return roots.filter(Boolean).some((allowed) => {
    const relative = win32.relative(win32.resolve(allowed), target);
    return relative === "" || (!win32.isAbsolute(relative) && relative !== ".." && !relative.startsWith("..\\"));
  });
}

function rejectExternalWrite(tool: string, args: Record<string, unknown>, root: string, directory: string): void {
  if (!/^[A-Za-z]:\//.test(root) || (tool !== "write" && tool !== "edit")) return;
  const value = args.filePath ?? args.file_path ?? args.path;
  if (typeof value !== "string" || !value.trim()) return;

  const target = win32.resolve(directory || root, value);
  if (isInside(target, [root, tempDir()])) return;

  throw new Error(
    `SANDBOX_FOLDER_NOT_AUTHORIZED: Cannot ${tool} "${target}". ` +
    `Writing outside the workspace and runtime temporary directory is not supported by this native runtime. ` +
    `Once / Allow for session and Authorized folders settings do not grant Windows filesystem access. ` +
    `Use a file under "${win32.resolve(root)}" instead. Do not retry through another tool or report success.`,
  );
}

// Mirrors the prefix mapping of resolve_workspace_path_to_host() in protection_service/io/workspace_paths.py; keep them in sync.
function protectionServicePath(value: string, root: string): string {
  const normalized = value.replace(/\\/g, "/").trim();
  if (normalized === "/workspace") return root;
  for (const prefix of ["/workspace/", "workspace/"]) {
    if (normalized.startsWith(prefix)) return win32.resolve(root, normalized.slice(prefix.length));
  }
  return value;
}

function rejectExternalRead(tool: string, args: Record<string, unknown>, root: string, directory: string): void {
  const keys = READ_ARG_KEYS.get(tool);
  if (!/^[A-Za-z]:\//.test(root) || !keys) return;
  const allowedRoots = [root, tempDir(), configSkillsDir(), readersDir(), toolOutputDir()];
  for (const key of keys) {
    for (const raw of [args[key]].flat()) {
      const value = typeof raw === "string" ? raw.trim() : "";
      if (!value) continue;
      if (tool === "glob" && key === "pattern" && !/^([A-Za-z]:[\\/]|\\\\|\/\/)/.test(value)) continue;
      // Root-session source_file_path(s) are left for the protection service; map them as it will, for the check only.
      const path = PATH_ARG_KEYS.includes(key) ? value : protectionServicePath(value, root);
      const target = win32.resolve(directory || root, path);
      if (isInside(target, allowedRoots)) continue;
      throw new Error(
        `SANDBOX_FOLDER_NOT_AUTHORIZED: Cannot read "${target}". ` +
        `SuperClaw can only open files inside "${win32.resolve(root)}". ` +
        `Do not search the workspace for this file or a substitute, and do not retry through another tool or a subagent. ` +
        `Reply to the user now: say the file is outside the workspace and ask them to attach it in the chat or copy it into that folder.`,
      );
    }
  }
}

export const WorkspacePathNormalizer: Plugin = async ({ client, directory }) => {
  const root = workspaceRoot();
  await client.app.log({
    body: {
      service: "workspace-path-normalizer",
      level: "info",
      message: root
        ? `Plugin initialised; mapping /workspace -> ${workspaceTarget(root, directory)}`
        : "Plugin inactive (root unset or already /workspace — container/no-op)",
    },
  });

  return {
    config: async (config) => {
      if (!/^[A-Za-z]:\//.test(workspaceRoot())) return;
      const temporary = tempDir();
      const skills = configSkillsDir();
      for (const agent of Object.values(config.agent ?? {})) {
        const permission = agent.permission;
        if (!permission || typeof permission !== "object") continue;
        const external = permission.external_directory;
        if (!external || typeof external !== "object") continue;
        if (temporary && external["/tmp/*"] === "allow") {
          external[`${temporary}/*`] = "allow";
        }
        // The runtime allows skill directories before agent rules, so an agent-level
        // "*": "deny" (last match wins) would otherwise hide the Profile's own skills.
        if (skills && external["*"] === "deny") {
          external[`${skills}/*`] = "allow";
        }
      }
    },
    "tool.execute.before": async (input, output) => {
      const r = workspaceRoot();
      if (!r) return; // container / not native — no-op
      const target = workspaceTarget(r, directory);
      const args = (output.args ?? {}) as Record<string, unknown>;
      let changed = false;

      const needsMap = (s: string) => s.includes("/workspace") || s.includes("/opt/readers");

      for (const key of PATH_ARG_KEYS) {
        const v = args[key];
        if (typeof v === "string" && needsMap(v)) {
          const mapped = mapWorkspace(v, target);
          if (mapped !== v) {
            args[key] = mapped;
            changed = true;
          }
        }
      }

      // The protection service maps source_file_path(s) against the root; in a bound
      // subdirectory, resolve the /workspace alias here so it selects the file `read` would.
      if (target !== r) {
        const toTarget = (v: unknown) => {
          if (typeof v !== "string") return v;
          const mapped = protectionServicePath(v, target);
          return mapped === v ? v : mapped.replace(/\\/g, "/");
        };
        for (const key of SOURCE_ARGS) {
          const v = args[key];
          const mapped = Array.isArray(v) ? v.map(toTarget) : toTarget(v);
          if (JSON.stringify(mapped) !== JSON.stringify(v)) {
            args[key] = mapped;
            changed = true;
          }
        }
      }

      // bash: rewrite /workspace and /opt/readers tokens inside the shell command.
      if (input.tool === "bash" && typeof args.command === "string") {
        let mapped = mapPosixWindowsPaths(forwardSlashUnquotedDrivePaths(args.command));
        if (needsMap(mapped)) mapped = mapWorkspace(mapped, shellTarget(r, target));
        if (mapped !== args.command) {
          args.command = mapped;
          changed = true;
        }
      }

      for (const key of FS_PATH_ARG_KEYS) {
        const v = args[key];
        if (typeof v === "string") {
          const mapped = mapPosixWindowsPaths(v);
          if (mapped !== v) {
            args[key] = mapped;
            changed = true;
          }
        }
      }

      rejectExternalWrite(input.tool, args, r, directory);
      rejectExternalRead(input.tool, args, r, directory);

      if (changed) {
        output.args = args;
        await client.app.log({
          body: {
            service: "workspace-path-normalizer",
            level: "info",
            message: `Mapped paths tool='${input.tool}' callID=${input.callID.slice(0, 10)}`,
          },
        });
      }
    },
  };
};

export default WorkspacePathNormalizer;

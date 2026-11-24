// Removes the upstream opencode line:
//   "You are powered by the model named ${model.api.id}.
//    The exact model ID is ${model.providerID}/${model.api.id}"
// from the system prompt before it reaches the LLM.
//
// Upstream source: opencode v1.2.26 packages/opencode/src/session/system.ts.
// The hook fires from session/llm.ts (and agent/agent.ts) before each chat
// turn. opencode passes a fresh wrapper `{ system }` whose `system` field
// points to its own local array, then keeps using that LOCAL array after
// the trigger returns — it does NOT re-read `output.system`. Therefore
// reassigning `output.system = newArray` would leave opencode's local
// reference unchanged and the strip would silently no-op. We must mutate
// the array IN PLACE instead.
//
// It also renders {{SUPERCLAW_ENVIRONMENT}} for the Windows-native backend; the router
// carries the <superclaw_environment> block over when it swaps the prompt.

import type { Plugin } from "@opencode-ai/plugin";

const MODEL_ID_LINE_RE =
  /^You are powered by the model named[^\n]*?\.\s*(?:\r?\n\s*)?The exact model ID is[^\n]+\r?\n?/gm;

const ENVIRONMENT_PLACEHOLDER = "{{SUPERCLAW_ENVIRONMENT}}";

function nativeEnvironment(root: string): string {
  const location = root.endsWith("/") ? root.slice(0, -1) : root;
  return [
    "You run natively on Windows inside the SuperClaw sandbox, not in Linux and not in a container. Knowing the layout below saves tool calls — do not spend steps rediscovering it:",
    `- The user's files are under ${root}, the current working directory (paths the user mentions usually live there).`,
    `- ${root} is the ONLY folder the user can see. Write every deliverable (new files, generated code, reports) directly at its final path under it, for example ${location}/code. Never write user-facing output elsewhere, and never stage a file elsewhere and copy it into place. If a write outside the workspace is denied, rewrite the file under ${root} — do not retry the denied path with another tool. When telling the user where a file is, give its real Windows path.`,
    "- Use Windows filesystem paths in tool calls (forward slashes are fine). /workspace, /home, /opt and /tmp do not exist here.",
    "- The `bash` tool runs a POSIX `sh` (brush), not Linux bash: ls, cat, grep, sed, awk, find, xargs and tar (which also extracts .zip) work; unzip, wget, apt-get, sudo and Linux-only paths do not. find and grep -r print backslash paths, so use `find -print0 | xargs -0` or `find -exec ... {} +`, and `command -v` instead of `which`. The shell is not interactive.",
    "- Python: `python` and `python3` are the packaged, read-only agent environment with openai, requests, numpy, pandas, scipy, scikit-learn, matplotlib, seaborn, openpyxl, python-docx, python-pptx and pytest preinstalled. Run tests with `python -m pytest`. `pip install` cannot modify it, so work with these packages instead of installing new ones.",
    "- git, node, gh and curl are not bundled; they work only if installed on the user's machine. Outbound network may go through a preconfigured proxy.",
  ].join("\n");
}

function withEnvironment(prompt: string, root: string | null): string {
  if (!prompt.includes(ENVIRONMENT_PLACEHOLDER)) return prompt;
  const block = root ? `<superclaw_environment>\n${nativeEnvironment(root)}\n</superclaw_environment>` : "";
  return prompt.replace(ENVIRONMENT_PLACEHOLDER, () => block);
}

function nativeWorkspaceRoot(): string | null {
  const root = process.env.OPENCODE_DIRECTORY?.trim();
  if (!root || !/^[A-Za-z]:[\\/]/.test(root)) return null;
  const normalized = root.replace(/\\/g, "/");
  return /^[A-Za-z]:\/$/.test(normalized) ? normalized : normalized.replace(/\/+$/, "");
}

// A chat bound with `/cd <subdir>` runs in an instance whose directory is that
// subdirectory; name it instead of the root (same rule as 04's workspaceTarget).
function sessionWorkspace(root: string, directory: string | undefined): string {
  const base = root.replace(/\/+$/, "");
  const dir = directory?.trim().replace(/\\/g, "/").replace(/\/+$/, "") ?? "";
  // The root is always a Windows path here; compare with Windows rules on any host.
  const fold = (s: string) => s.toLowerCase();
  return dir && fold(dir).startsWith(`${fold(base)}/`) ? `${base}${dir.slice(base.length)}` : root;
}

function nativeWorkspaceInstructions(prompt: string, root: string): string {
  const location = root.endsWith("/") ? root.slice(0, -1) : root;
  const outputLocation =
    `# Output File Location\n` +
    `The user's workspace is ${root}. Create deliverables directly under it, ` +
    `resolve bare filenames and subfolders against it, and report the actual Windows path. ` +
    `Never write to /workspace, which is not mounted in this mode. ` +
    `Do not stage deliverables outside the workspace or delegate a blocked write.\n\n`;
  return prompt.replace(/\/workspace(?=\/|\b)/g, location)
    .replace(/# Output File Location\r?\n[\s\S]*?(?=# Evidence, Grounding & Citation)/, outputLocation);
}

export const StripModelIdPrompt: Plugin = async (context) => ({
  "experimental.chat.system.transform": async (_input, output) => {
    const arr = output.system as unknown[];
    const nativeRoot = nativeWorkspaceRoot();
    const root = nativeRoot && sessionWorkspace(nativeRoot, context?.directory);
    // 1. strip the model-id line from each string entry, in place
    for (let i = 0; i < arr.length; i++) {
      const entry = arr[i];
      if (typeof entry === "string") {
        const stripped = entry.replace(MODEL_ID_LINE_RE, "");
        arr[i] = withEnvironment(root ? nativeWorkspaceInstructions(stripped, root) : stripped, root);
      }
    }
    // 2. drop entries that became empty (or were empty strings to begin with),
    //    walking backwards so splice indices stay valid
    for (let i = arr.length - 1; i >= 0; i--) {
      const entry = arr[i];
      if (typeof entry === "string" && entry.trim().length === 0) {
        arr.splice(i, 1);
      }
    }
  },
});

// PATCH plugin-export-form: opencode SDK expects the default export to be
// the plugin function itself, not a `{ server: fn }` wrapper. The wrapper
// form silently fails at load with "Path plugin ... must export id" thrown
// from resolvePluginId() — opencode catches and logs the error, and the
// plugin never registers a single hook (same failure mode documented in
// plugins 90/91/92).
export default StripModelIdPrompt;

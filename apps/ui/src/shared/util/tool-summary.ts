/** Classify a tool name into a semantic category for icon selection */
export function classifyTool(
  toolName: string,
):
  | "read"
  | "edit"
  | "write"
  | "search"
  | "terminal"
  | "glob"
  | "task"
  | "skill"
  | "tool" {
  const lower = toolName.toLowerCase();
  if (lower === "skill") return "skill";
  if (
    lower.includes("read") ||
    lower.includes("cat") ||
    lower.includes("fetch")
  )
    return "read";
  if (lower === "apply_patch") return "write";
  if (
    lower.includes("edit") ||
    lower.includes("replace") ||
    lower.includes("update")
  )
    return "edit";
  if (
    lower.includes("write") ||
    lower.includes("create") ||
    lower.includes("patch")
  )
    return "write";
  if (
    lower.includes("grep") ||
    lower.includes("search") ||
    lower.includes("find")
  )
    return "search";
  if (
    lower.includes("bash") ||
    lower.includes("shell") ||
    lower.includes("exec") ||
    lower.includes("command") ||
    lower.includes("run")
  )
    return "terminal";
  if (lower.includes("glob") || lower.includes("list") || lower.includes("ls"))
    return "glob";
  if (
    lower.includes("task") ||
    lower.includes("agent") ||
    lower.includes("todo")
  )
    return "task";
  return "tool";
}

/** Extract a clean filename from a file path */
function extractFilename(filePath: string): string {
  const parts = filePath.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || filePath;
}

export function normalizeStepText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim();
}

export function cleanReasoningText(value: string): string {
  return value
    .replace(/\[REDACTED\]/g, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

export function truncateStepText(value: string, max = 80): string {
  return value.length > max
    ? `${value.slice(0, Math.max(0, max - 3))}...`
    : value;
}

function isPathLike(value: string): boolean {
  return (
    /^(?:[A-Za-z]:[\\/]|~[\\/]|\/|\.\.?[\\/])/.test(value) ||
    /[\\/]/.test(value)
  );
}

function normalizePathToken(value: string): string {
  const clean = value.trim().replace(/^[`'"([{]+|[`'"\])},.;:]+$/g, "");
  if (!isPathLike(clean)) return clean;
  return extractFilename(clean);
}

function formatAgentLabel(value: string): string {
  const clean = value.trim().replace(/[_-]+/g, " ");
  if (!clean) return "";
  return clean
    .split(/\s+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function getToolInput(state: any): Record<string, unknown> {
  const input = state?.input;
  if (input && typeof input === "object")
    return input as Record<string, unknown>;
  return {};
}

function pickInputText(input: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = input[key];
    const text = normalizeStepText(value);
    if (text) return text;
  }
  return "";
}

function getTodoToolCount(state: any): number | undefined {
  const input = getToolInput(state);
  const candidates = [input.todos, state?.todos, input.items, state?.items];

  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    const count = candidate.filter(
      (item) => item && typeof item === "object",
    ).length;
    return count;
  }

  return undefined;
}

export function buildToolTitle(state: any, toolName: string): string {
  const lower = toolName.toLowerCase();
  const input = getToolInput(state);
  const pick = (...keys: string[]) => pickInputText(input, keys);
  const file = (...keys: string[]) => {
    const value = pick(...keys);
    if (!value) return "";
    return normalizePathToken(value);
  };

  if (lower === "read") {
    const target = file("filePath", "path", "file");
    return target ? `Read ${target}` : "Read file";
  }

  if (lower === "edit") {
    const target = file("filePath", "path", "file");
    return target ? `Edit ${target}` : "Edit file";
  }

  if (lower === "write") {
    const target = file("filePath", "path", "file");
    return target ? `Write ${target}` : "Write file";
  }

  if (lower === "apply_patch") {
    return "Apply patch";
  }

  if (lower === "list" || lower === "list_files") {
    const target = file("path");
    return target ? `List ${target}` : "List files";
  }

  if (lower === "grep" || lower === "glob" || lower === "search") {
    const pattern = pick("pattern", "query");
    return pattern ? `Search ${truncateStepText(pattern, 44)}` : "Search code";
  }

  if (lower === "bash") {
    const description = pick("description");
    if (description) return truncateStepText(description, 56);
    const command = pick("command", "cmd");
    if (command) return truncateStepText(`Run ${command}`, 56);
    return "Run command";
  }

  if (lower === "task") {
    const agent = formatAgentLabel(pick("subagent_type"));
    if (agent) return `${agent} task`;
    return "Task";
  }

  if (lower === "webfetch") {
    const url = pick("url");
    return url ? `Fetch ${truncateStepText(url, 44)}` : "Fetch web page";
  }

  if (lower === "skill") {
    const name = pick("name");
    return name ? `Load skill ${name}` : "Load skill";
  }

  if (lower === "todowrite" || lower === "todoread") {
    const count = getTodoToolCount(state);
    const status = normalizeStepText(state?.status).toLowerCase();
    const isComplete = status === "completed" || status === "done";

    if (typeof count === "number" && count > 0 && isComplete) {
      return `${count} todo${count === 1 ? "" : "s"}`;
    }

    return isComplete ? "Updated task list" : "Updating task list";
  }

  const stateTitle = normalizeStepText(state?.title);
  if (stateTitle) {
    return truncateStepText(
      isPathLike(stateTitle) ? normalizePathToken(stateTitle) : stateTitle,
      56,
    );
  }

  const fallback = normalizeStepText(toolName).replace(/[_-]+/g, " ");
  return fallback || "Tool";
}

/** Build a concise detail line for a tool call — avoids dumping raw output */
export function buildToolDetail(state: any, toolName: string): string | undefined {
  const lower = toolName.toLowerCase();
  const input = getToolInput(state);
  const pick = (...keys: string[]) => pickInputText(input, keys);

  if (lower === "read") {
    const chunks: string[] = [];
    const offset = input.offset;
    const limit = input.limit;
    if (typeof offset === "number") chunks.push(`offset ${offset}`);
    if (typeof limit === "number") chunks.push(`limit ${limit}`);
    if (chunks.length > 0) return chunks.join(" - ");
    return undefined;
  }

  if (lower === "bash") {
    const command = pick("command", "cmd");
    if (command) return truncateStepText(command, 80);
  }

  if (lower === "grep" || lower === "glob" || lower === "search") {
    const root = pick("path");
    if (root) return `in ${normalizePathToken(root)}`;
  }

  if (lower === "task") {
    const description = pick("description");
    if (description) return truncateStepText(description, 80);
    const agent = formatAgentLabel(pick("subagent_type"));
    if (agent) return `${agent} agent`;
  }

  if (lower === "webfetch") {
    const url = pick("url");
    if (url) return truncateStepText(url, 80);
  }

  if (lower === "todowrite" || lower === "todoread") {
    const count = getTodoToolCount(state);
    if (typeof count === "number" && count > 0) {
      return `${count} todo${count === 1 ? "" : "s"}`;
    }
    return undefined;
  }

  // For file operations, show the filename
  const filePath = state?.path ?? state?.file;
  if (typeof filePath === "string" && filePath.trim()) {
    return extractFilename(filePath.trim());
  }

  // For edits that report updated files, show filename(s)
  const files = state?.files;
  if (Array.isArray(files) && files.length > 0) {
    const names = files
      .filter((f: any) => typeof f === "string")
      .map(extractFilename);
    if (names.length === 1) return names[0];
    if (names.length > 1) return `${names[0]} +${names.length - 1} more`;
  }

  // For bash/terminal commands, show the command
  const command = state?.command ?? state?.cmd;
  if (typeof command === "string" && command.trim()) {
    const clean = command.trim();
    return clean.length > 80 ? `${clean.slice(0, 77)}...` : clean;
  }

  // For search/grep, show the pattern
  const pattern = state?.pattern ?? state?.query;
  if (typeof pattern === "string" && pattern.trim()) {
    return `"${pattern.trim().length > 60 ? pattern.trim().slice(0, 57) + "..." : pattern.trim()}"`;
  }

  // Subtitle/detail from state as fallback
  const subtitle = state?.subtitle ?? state?.detail ?? state?.summary;
  if (typeof subtitle === "string" && subtitle.trim()) {
    const clean = subtitle.trim();
    return clean.length > 80 ? `${clean.slice(0, 77)}...` : clean;
  }

  // For completed tools with output, show a very short summary
  const outputRaw =
    typeof state?.output === "string" ? state.output.trim() : "";
  if (outputRaw) {
    if (lower === "read") return undefined;

    const output =
      outputRaw.length > 3000 ? outputRaw.slice(0, 3000) : outputRaw;

    // Extract just the first meaningful line (skip line numbers and raw file markers)
    const lines = output.split("\n").filter((l: string) => {
      const trimmed = l.trim();
      return (
        trimmed &&
        !trimmed.startsWith("<file>") &&
        !trimmed.startsWith("<path>") &&
        !trimmed.startsWith("<type>") &&
        !trimmed.startsWith("<content>") &&
        !trimmed.startsWith("</content>") &&
        !/^\d{5}\|/.test(trimmed) &&
        !/^\d+:\s/.test(trimmed)
      );
    });
    if (lines.length > 0) {
      const first = lines[0].trim();
      if (first.startsWith("Success")) {
        // "Success. Updated the following files: M foo.ts" -> "foo.ts"
        const match = first.match(/:\s*[MADR]\s+(.+)/);
        if (match) return extractFilename(match[1].trim());
        return "Done";
      }
      // Skip when the first line is just a JSON / XML / quote opener.
      // Tools that return structured payloads (JSON object, JSON array,
      // XML / HTML tag, or a quoted string) often format the opener on
      // its own line, so the "first meaningful line" extraction lands
      // on a lone delimiter that carries no information. The full
      // payload is still visible when the user expands the tool card.
      if (/^[{[(<"']$/.test(first)) return undefined;
      return first.length > 80 ? `${first.slice(0, 77)}...` : first;
    }
  }

  return undefined;
}

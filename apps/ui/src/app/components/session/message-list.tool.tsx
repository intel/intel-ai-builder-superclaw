import type { Part } from "@opencode-ai/sdk/v2/client";
import { isWebSearchToolOutput, summarizeStep } from "../../utils";
import { isGuardErrorText, sanitizeGuardErrors } from "~/shared/util/guard-messages";
import { sanitizeProtectionMessages } from "~/shared/util/protection-messages";
import type { ToolStepGroup } from "~/shared/util/turn-blocks";
import { formatExplorationSummary, summarizeExploration } from "./message-list.exploration";
import {
  HDR_TOOL,
  hdrActivityText,
  hdrProgress,
  hdrWebSearches,
  hdrWebSearchText,
} from "./message-list.hdr-progress";

export type StepTone = "running" | "done" | "error" | "cancelled" | "idle";

export type StepDisplayLabel = {
  primary: string;
  secondary?: string;
};

type ToolPartRecord = {
  tool?: unknown;
  state?: unknown;
};

type ActionFamily =
  | "webFetch"
  | "webSearch"
  | "read"
  | "edit"
  | "update"
  | "codeSearch"
  | "list"
  | "command"
  | "readPlan"
  | "updatePlan"
  | "question"
  | "subagent"
  | "skill"
  | "pdf"
  | "document"
  | "presentation"
  | "spreadsheet"
  | "spreadsheetQuery"
  | "scan"
  | "fileProtection"
  | "protectedFile"
  | "prepareEmail"
  | "sendEmail"
  | "replyEmail"
  | "scheduleMeeting"
  | "deepResearch"
  | "connectedTools"
  | "externalTool";

type DisplayKind =
  | "webFetch"
  | "webSearch"
  | "read"
  | "edit"
  | "update"
  | "codeSearch"
  | "list"
  | "command"
  | "readPlan"
  | "updatePlan"
  | "question"
  | "subagent"
  | "skill"
  | "pdf"
  | "document"
  | "presentation"
  | "spreadsheet"
  | "spreadsheetQuery"
  | "scan"
  | "fileProtection"
  | "protectedFile"
  | "prepareEmail"
  | "sendEmail"
  | "replyEmail"
  | "scheduleMeeting"
  | "deepResearch"
  | "connectedTools";

const TOOL_DISPLAY_KIND_MAP: Record<string, DisplayKind> = {
  webfetch: "webFetch",
  websearch: "webSearch",
  sc_search_web: "webSearch",
  read: "read",
  edit: "edit",
  multiedit: "edit",
  write: "update",
  apply_patch: "update",
  patch: "update",
  grep: "codeSearch",
  glob: "codeSearch",
  search: "codeSearch",
  codesearch: "codeSearch",
  list: "list",
  list_files: "list",
  bash: "command",
  todoread: "readPlan",
  todowrite: "updatePlan",
  question: "question",
  task: "subagent",
  skill: "skill",
  parse_pdf: "pdf",
  local_dr_read_docx: "document",
  local_dr_read_pptx: "presentation",
  local_dr_read_csv_xlsx: "spreadsheet",
  local_dr_query_table: "spreadsheetQuery",
  ocr: "scan",
  confirm_file_protection: "fileProtection",
  run_protected_file_pipeline: "protectedFile",
  run_email_pipeline: "prepareEmail",
  email_send: "sendEmail",
  email_reply: "replyEmail",
  schedule_meeting: "scheduleMeeting",
  hybrid_dr_post_polish_processor: "deepResearch",
  get_mcp_status: "connectedTools",
};

const ACTION_WORDING: Record<ActionFamily, Record<StepTone, string>> = {
  webFetch: {
    idle: "Fetch web page",
    running: "Fetching web page",
    done: "Fetched web page",
    error: "Web page fetch failed",
    cancelled: "Web page fetch cancelled",
  },
  webSearch: {
    idle: "Search the web",
    running: "Searching the web",
    done: "Searched the web",
    error: "Web search failed",
    cancelled: "Web search cancelled",
  },
  read: {
    idle: "Read file",
    running: "Reading file",
    done: "Read file",
    error: "File read failed",
    cancelled: "File read cancelled",
  },
  edit: {
    idle: "Edit file",
    running: "Editing file",
    done: "Edited file",
    error: "File edit failed",
    cancelled: "File edit cancelled",
  },
  update: {
    idle: "Update file",
    running: "Updating file",
    done: "Updated file",
    error: "File update failed",
    cancelled: "File update cancelled",
  },
  codeSearch: {
    idle: "Search code",
    running: "Searching code",
    done: "Searched code",
    error: "Code search failed",
    cancelled: "Code search cancelled",
  },
  list: {
    idle: "List files",
    running: "Listing files",
    done: "Listed files",
    error: "File listing failed",
    cancelled: "File listing cancelled",
  },
  command: {
    idle: "Run command",
    running: "Running command",
    done: "Ran command",
    error: "Command failed",
    cancelled: "Command cancelled",
  },
  readPlan: {
    idle: "Read plan",
    running: "Reading plan",
    done: "Read plan",
    error: "Plan read failed",
    cancelled: "Plan read cancelled",
  },
  updatePlan: {
    idle: "Update plan",
    running: "Updating plan",
    done: "Updated plan",
    error: "Plan update failed",
    cancelled: "Plan update cancelled",
  },
  question: {
    idle: "Ask a question",
    running: "Wait for input",
    done: "Asked a question",
    error: "Question failed",
    cancelled: "Question cancelled",
  },
  subagent: {
    idle: "Run sub-agent",
    running: "Running sub-agent",
    done: "Ran sub-agent",
    error: "Sub-agent failed",
    cancelled: "Sub-agent cancelled",
  },
  skill: {
    idle: "Load skill",
    running: "Loading skill",
    done: "Loaded skill",
    error: "Skill load failed",
    cancelled: "Skill load cancelled",
  },
  pdf: {
    idle: "Read PDF",
    running: "Reading PDF",
    done: "Read PDF",
    error: "PDF read failed",
    cancelled: "PDF read cancelled",
  },
  document: {
    idle: "Read document",
    running: "Reading document",
    done: "Read document",
    error: "Document read failed",
    cancelled: "Document read cancelled",
  },
  presentation: {
    idle: "Read presentation",
    running: "Reading presentation",
    done: "Read presentation",
    error: "Presentation read failed",
    cancelled: "Presentation read cancelled",
  },
  spreadsheet: {
    idle: "Read spreadsheet",
    running: "Reading spreadsheet",
    done: "Read spreadsheet",
    error: "Spreadsheet read failed",
    cancelled: "Spreadsheet read cancelled",
  },
  spreadsheetQuery: {
    idle: "Query spreadsheet",
    running: "Querying spreadsheet",
    done: "Queried spreadsheet",
    error: "Spreadsheet query failed",
    cancelled: "Spreadsheet query cancelled",
  },
  scan: {
    idle: "Scan document",
    running: "Scanning document",
    done: "Scanned document",
    error: "Document scan failed",
    cancelled: "Document scan cancelled",
  },
  fileProtection: {
    idle: "Check file protection",
    running: "Checking file protection",
    done: "Checked file protection",
    error: "File protection check failed",
    cancelled: "File protection check cancelled",
  },
  protectedFile: {
    idle: "Process protected file",
    running: "Processing protected file",
    done: "Processed protected file",
    error: "Protected file processing failed",
    cancelled: "Protected file processing cancelled",
  },
  prepareEmail: {
    idle: "Prepare email",
    running: "Preparing email",
    done: "Prepared email",
    error: "Email preparation failed",
    cancelled: "Email preparation cancelled",
  },
  sendEmail: {
    idle: "Send email",
    running: "Sending email",
    done: "Sent email",
    error: "Email send failed",
    cancelled: "Email send cancelled",
  },
  replyEmail: {
    idle: "Reply to email",
    running: "Replying to email",
    done: "Replied to email",
    error: "Email reply failed",
    cancelled: "Email reply cancelled",
  },
  scheduleMeeting: {
    idle: "Schedule meeting",
    running: "Scheduling meeting",
    done: "Scheduled meeting",
    error: "Meeting scheduling failed",
    cancelled: "Meeting scheduling cancelled",
  },
  deepResearch: {
    idle: "Hybrid Deep Research",
    running: "Hybrid Deep Research",
    done: "Hybrid Deep Research",
    error: "Hybrid Deep Research failed",
    cancelled: "Hybrid Deep Research cancelled",
  },
  connectedTools: {
    idle: "Check connected tools",
    running: "Checking connected tools",
    done: "Checked connected tools",
    error: "Connected tools check failed",
    cancelled: "Connected tools check cancelled",
  },
  externalTool: {
    idle: "Use external tool",
    running: "Using external tool",
    done: "Used external tool",
    error: "External tool failed",
    cancelled: "External tool cancelled",
  },
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function toolPartRecord(part: Part): ToolPartRecord | undefined {
  return part.type === "tool" ? (part as unknown as ToolPartRecord) : undefined;
}

function toolState(part: Part): Record<string, unknown> | undefined {
  return asRecord(toolPartRecord(part)?.state);
}

function toolInput(part: Part): Record<string, unknown> {
  return asRecord(toolState(part)?.input) ?? {};
}

function toolName(part: Part): string {
  const value = toolPartRecord(part)?.tool;
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function inputText(input: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const text = textValue(input[key]);
    if (text) return text;
  }
  return "";
}

function compactInput(
  input: Record<string, unknown>,
  keys: string[],
  max = 80,
): string | undefined {
  const value = compactText(inputText(input, ...keys), max);
  return value || undefined;
}

function compactPathInput(
  input: Record<string, unknown>,
  keys = ["filePath", "path", "file", "filename"],
): string | undefined {
  const value = inputText(input, ...keys);
  if (!value) return undefined;
  return compactText(compactPathToken(value));
}

function stateTitle(part: Part): string | undefined {
  const state = toolState(part);
  const directTitle = textValue(state?.title);
  if (directTitle) return compactText(directTitle);

  const metadata = asRecord(state?.metadata);
  const metadataTitle = textValue(metadata?.title);
  return metadataTitle ? compactText(metadataTitle) : undefined;
}

function stripWebResultPrefix(value: string): string {
  return value
    .replace(/^web search results for query:\s*/i, "")
    .replace(/^web search results:\s*/i, "")
    .trim();
}

function humanizeToolIdentifier(value: string): string | undefined {
  const humanized = compactText(
    value.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim(),
  );
  return humanized || undefined;
}

function actionLabel(
  family: ActionFamily,
  tone: StepTone,
  secondary?: string,
): StepDisplayLabel {
  return secondary
    ? { primary: ACTION_WORDING[family][tone], secondary }
    : { primary: ACTION_WORDING[family][tone] };
}

function recipientSummary(input: Record<string, unknown>): string | undefined {
  const direct = compactInput(input, ["to", "recipient", "recipients"]);
  if (direct) return direct;

  const recipients = input.to;
  if (!Array.isArray(recipients) || recipients.length === 0) return undefined;
  const first = textValue(recipients[0]);
  if (!first) return undefined;
  return recipients.length === 1
    ? compactText(first)
    : `${compactText(first, 56)} +${recipients.length - 1}`;
}

function todoUpdateSummary(input: Record<string, unknown>): string | undefined {
  const title = compactInput(input, ["title", "name", "description"]);
  if (title) return title;

  const todos = input.todos;
  if (!Array.isArray(todos) || todos.length === 0) return undefined;
  return `${todos.length} todo update${todos.length === 1 ? "" : "s"}`;
}

function reasoningDisplayLabel(part: Part): StepDisplayLabel {
  const summary = summarizeStep(part);
  const thought = compactText(
    summary.title.replace(/^thinking:\s*/i, "").trim(),
    96,
  );
  if (!thought || thought.toLowerCase() === "thinking") {
    return { primary: "Thinking" };
  }
  return { primary: "Thinking", secondary: thought };
}

export function stepTone(status?: string): StepTone {
  switch (status) {
    case "running":
    case "pending":
      return "running";
    case "completed":
    case "done":
      return "done";
    case "error":
    case "failed":
      return "error";
    case "cancelled":
      return "cancelled";
    default:
      return "idle";
  }
}

export function toolStepStatus(part: Part): string | undefined {
  const status = toolState(part)?.status;
  return typeof status === "string" ? status : undefined;
}

export function toolStepOutput(part: Part): string {
  const output = toolState(part)?.output;
  return typeof output === "string" ? output : "";
}

/** Failure text opencode stores on `state.error` when a tool throws and leaves `output` empty. */
function toolStepErrorText(part: Part): string {
  const error = toolState(part)?.error;
  return typeof error === "string" ? error.trim() : "";
}

function hdrResultText(output: string): string {
  try {
    const parsed = JSON.parse(output);
    if (parsed && typeof parsed.summary === "string") return parsed.summary.trim();
    if (parsed && typeof parsed.message === "string") return parsed.message.trim();
  } catch {
    // Non-JSON output is shown as-is.
  }
  return "";
}

/** HDR's own result line (summary, status message or failure), without its web searches. */
export function hdrStepResultText(part: Part): string {
  const output = toolStepOutput(part).trim();
  const metaSummary = asRecord(toolState(part)?.metadata)?.summary;
  if (typeof metaSummary === "string" && metaSummary.trim()) return metaSummary.trim();
  return (output && hdrResultText(output)) || toolStepFallbackText(part, output);
}

/** True once the post-polish tool published a report path, which is exactly when
 * the final-summary card renders under the turn. */
function hasPublishedReportPath(part: Part): boolean {
  const metadata = asRecord(toolState(part)?.metadata) ?? {};
  let parsed: Record<string, unknown> = {};
  try {
    parsed = asRecord(JSON.parse(toolStepOutput(part))) ?? {};
  } catch {
    // Non-JSON output never carries a report path.
  }
  return [
    parsed.deliverable_path,
    parsed.ui_summary_path,
    metadata.deliverable_path,
    metadata.ui_summary_path,
  ].some((value) => typeof value === "string" && value.trim().length > 0);
}

export function visibleToolStepOutput(part: Part): string {
  if (part.type !== "tool") return "";
  const tool = typeof part.tool === "string" ? part.tool : "";
  const output = toolStepOutput(part).trim();
  if (tool === HDR_TOOL) {
    const searches = hdrWebSearches(part);
    const progress = hdrProgress(part);
    const activity = progress ? hdrActivityText(progress, searches) : hdrWebSearchText(searches);
    // The final-summary card under the turn renders the same summary with the
    // "Open final report" button, and it appears exactly when a report path is
    // published. Repeating the summary here showed the report twice, so keep
    // the activity text and drop only the result line whenever the card exists.
    const result = hasPublishedReportPath(part) ? "" : hdrStepResultText(part);
    return [activity, result].filter(Boolean).join("\n\n");
  }
  if (tool.toLowerCase() === "run_protected_file_pipeline" && output) {
    try {
      const parsed = JSON.parse(output) as Record<string, unknown>;
      if (parsed && typeof parsed === "object") {
        const internalFields = ["message", "operation_id", "operation_session_id"];
        if (internalFields.some((field) => field in parsed)) {
          for (const field of internalFields) delete parsed[field];
          return JSON.stringify(parsed, null, 2);
        }
      }
    } catch {
      // Non-JSON output is shown as-is.
    }
  }
  return toolStepFallbackText(part, output);
}

function toolStepFallbackText(part: Part, output: string): string {
  if (output) return sanitizeProtectionMessages(output);
  return sanitizeProtectionMessages(sanitizeGuardErrors(toolStepErrorText(part)));
}

const EMAIL_ACTION_TOOLS = new Set([
  "email_send",
  "email_reply",
  "schedule_meeting",
]);

export function stepToneForPart(part: Part): StepTone {
  const frameworkTone = stepTone(toolStepStatus(part));
  if (part.type !== "tool") return frameworkTone;

  if (EMAIL_ACTION_TOOLS.has(toolName(part))) {
    const output = toolStepOutput(part).trimStart();
    if (output.startsWith("ACTION_DENIED:")) return "cancelled";
    if (output.startsWith("ACTION_FAILED:")) return "error";
  }

  // The guard's throw is model steering, not a crash. opencode still marks the
  // tool error, which would paint "Sub-agent failed" in red (#3633).
  if (
    frameworkTone === "error" &&
    isGuardErrorText(toolStepErrorText(part) || toolStepOutput(part))
  ) {
    return "cancelled";
  }

  return frameworkTone;
}

function toolStepTiming(
  part: Part,
): { start: number; end: number } | undefined {
  const time = asRecord(toolState(part)?.time);
  const start = time?.start;
  const end = time?.end;
  if (
    typeof start !== "number" ||
    typeof end !== "number" ||
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    end < start
  ) {
    return undefined;
  }
  return { start, end };
}

/** Milliseconds a tool step took, or null while it is still running / has no timing. */
export function stepDurationMs(part: Part): number | null {
  if (part.type !== "tool") return null;
  const timing = toolStepTiming(part);
  return timing ? timing.end - timing.start : null;
}

/** Returns the group's wall-clock span once every visible tool has completed. */
export function stepGroupDurationMs(parts: Part[]): number | null {
  let earliestStart: number | undefined;
  let latestEnd: number | undefined;
  let sawTool = false;

  for (const part of parts) {
    if (part.type !== "tool") continue;
    sawTool = true;
    if (stepTone(toolStepStatus(part)) === "running") return null;

    const timing = toolStepTiming(part);
    if (!timing) return null;

    earliestStart =
      earliestStart === undefined
        ? timing.start
        : Math.min(earliestStart, timing.start);
    latestEnd =
      latestEnd === undefined ? timing.end : Math.max(latestEnd, timing.end);
  }

  if (!sawTool || earliestStart === undefined || latestEnd === undefined) {
    return null;
  }

  const duration = latestEnd - earliestStart;
  return Number.isFinite(duration) && duration >= 0 ? duration : null;
}

export function latestStepPart(toolSteps: ToolStepGroup[]): Part | undefined {
  for (
    let groupIndex = toolSteps.length - 1;
    groupIndex >= 0;
    groupIndex -= 1
  ) {
    const parts = toolSteps[groupIndex]?.parts ?? [];
    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = parts[partIndex];
      if (part.type === "tool" || part.type === "reasoning") {
        return part;
      }
    }
  }
  return undefined;
}

export function countVisibleSteps(parts: Part[]) {
  return parts.filter(
    (part) => part.type === "tool" || part.type === "reasoning",
  ).length;
}

function unifiedSummary(toolSteps: ToolStepGroup[]): string {
  const allParts = toolSteps.flatMap((group) => group.parts);
  const explorationParts = toolSteps
    .filter((group) => group.mode === "exploration")
    .flatMap((group) => group.parts);
  const explorationSummary = summarizeExploration(explorationParts);
  const standaloneCount = toolSteps.filter(
    (group) => group.mode !== "exploration",
  ).length;
  const summary = formatExplorationSummary(explorationSummary);

  if (summary !== "context activity" && standaloneCount > 0) {
    return `${summary} · ${standaloneCount} update${standaloneCount === 1 ? "" : "s"}`;
  }

  if (summary !== "context activity") return summary;

  const visibleStepCount = countVisibleSteps(allParts);
  return `${visibleStepCount} step${visibleStepCount === 1 ? "" : "s"}`;
}

export function unifiedStepDisplayLabel(
  toolSteps: ToolStepGroup[],
  tone: StepTone,
): StepDisplayLabel {
  const primary =
    tone === "running"
      ? "Working"
      : tone === "error"
        ? "Activity failed"
        : tone === "cancelled"
          ? "Activity cancelled"
          : tone === "done"
            ? "Completed activity"
            : "Activity";
  return { primary, secondary: unifiedSummary(toolSteps) };
}

export function explorationStepDisplayLabel(
  parts: Part[],
  status: "exploring" | "explored",
): StepDisplayLabel {
  const summary = summarizeExploration(parts);
  const activeBuckets = [
    summary.files,
    summary.searches,
    summary.lists,
    summary.webPages,
    summary.commands,
    summary.todoUpdates,
  ].filter((count) => count > 0).length;

  if (summary.webPages > 0 && activeBuckets === 1) {
    return {
      primary: status === "exploring" ? "Searching the web" : "Searched the web",
      secondary: `${summary.webPages} page${summary.webPages === 1 ? "" : "s"} reviewed`,
    };
  }

  if (summary.todoUpdates > 0 && activeBuckets === 1) {
    return {
      primary: status === "exploring" ? "Updating plan" : "Updated plan",
      secondary: `${summary.todoUpdates} todo update${summary.todoUpdates === 1 ? "" : "s"}`,
    };
  }

  return {
    primary: status === "exploring" ? "Working" : "Completed activity",
    secondary: formatExplorationSummary(summary),
  };
}

export type TaskStepInfo = {
  isTask: boolean;
  agentType?: string;
  sessionId?: string;
  description?: string;
};

export function formatAgentType(agentType: string): string {
  const clean = agentType.trim().replace(/[_-]+/g, " ");
  if (!clean) return "";
  return clean
    .split(/\s+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

export function getTaskStepInfo(part: Part): TaskStepInfo {
  if (part.type !== "tool" || toolName(part) !== "task") {
    return { isTask: false };
  }

  const state = toolState(part) ?? {};
  const input = asRecord(state.input) ?? {};
  const metadata = asRecord(state.metadata) ?? {};

  const rawAgentType = textValue(input.subagent_type);
  const agentType = rawAgentType ? formatAgentType(rawAgentType) : undefined;
  const rawSessionId =
    metadata.sessionId ??
    metadata.sessionID ??
    state.sessionId ??
    state.sessionID;
  const description = textValue(input.description);
  const sessionId = textValue(rawSessionId);

  return {
    isTask: true,
    agentType,
    sessionId: sessionId || undefined,
    description: description || undefined,
  };
}

export function compactPathToken(value: string) {
  const token = value.trim().replace(/^[`'"([{]+|[`'"\])},.;:]+$/g, "");
  const segments = token.split(/[\\/]/).filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : token;
}

export function compactText(value: string, max = 80) {
  const singleLine = value.replace(/\s+/g, " ").trim();
  if (!singleLine) return "";
  return singleLine.length > max
    ? `${singleLine.slice(0, Math.max(0, max - 3))}...`
    : singleLine;
}

export function searchableStepLabel(part: Part): string[] {
  const label = stepDisplayLabel(part, stepToneForPart(part));
  return [label.primary, label.secondary ?? ""]
    .map(sanitizeProtectionMessages)
    .filter(Boolean);
}

export function stepDisplayLabel(
  part: Part,
  tone: StepTone = stepToneForPart(part),
): StepDisplayLabel {
  if (part.type === "reasoning") {
    return reasoningDisplayLabel(part);
  }

  if (part.type !== "tool") {
    return { primary: "Updates progress" };
  }

  const input = toolInput(part);
  const name = toolName(part);
  const webResult = isWebSearchToolOutput(toolStepOutput(part));
  if (webResult) {
    const query =
      compactInput(input, ["query", "q"]) ??
      (() => {
        const title = stateTitle(part);
        return title ? compactText(stripWebResultPrefix(title)) || undefined : undefined;
      })();
    return actionLabel("webSearch", tone, query);
  }

  const kind = Object.prototype.hasOwnProperty.call(TOOL_DISPLAY_KIND_MAP, name)
    ? TOOL_DISPLAY_KIND_MAP[name]
    : undefined;
  if (!kind) {
    return actionLabel(
      "externalTool",
      tone,
      stateTitle(part) ?? humanizeToolIdentifier(name),
    );
  }

  switch (kind) {
    case "webFetch":
      return actionLabel("webFetch", tone, compactInput(input, ["url"]));
    case "webSearch":
      return actionLabel("webSearch", tone, compactInput(input, ["query", "q"]));
    case "read":
      return actionLabel("read", tone, compactPathInput(input));
    case "edit":
      return actionLabel("edit", tone, compactPathInput(input));
    case "update":
      return actionLabel("update", tone, compactPathInput(input));
    case "codeSearch":
      return actionLabel(
        "codeSearch",
        tone,
        compactInput(input, ["pattern", "query"]),
      );
    case "list":
      return actionLabel("list", tone, compactPathInput(input, ["path", "dir"]));
    case "command":
      return actionLabel(
        "command",
        tone,
        compactInput(input, ["description"]) ??
          compactInput(input, ["command", "cmd"]),
      );
    case "readPlan":
      return actionLabel(
        "readPlan",
        tone,
        compactInput(input, ["title", "name", "description", "list"]),
      );
    case "updatePlan":
      return actionLabel("updatePlan", tone, todoUpdateSummary(input));
    case "question":
      return actionLabel(
        "question",
        tone,
        compactInput(input, ["question", "header"]),
      );
    case "subagent": {
      const task = getTaskStepInfo(part);
      return actionLabel(
        "subagent",
        tone,
        task.description
          ? compactText(task.description)
          : task.agentType
            ? compactText(task.agentType)
            : undefined,
      );
    }
    case "skill":
      return actionLabel("skill", tone, compactInput(input, ["name", "skill"]));
    case "pdf":
      return actionLabel("pdf", tone, compactPathInput(input));
    case "document":
      return actionLabel("document", tone, compactPathInput(input));
    case "presentation":
      return actionLabel("presentation", tone, compactPathInput(input));
    case "spreadsheet":
      return actionLabel("spreadsheet", tone, compactPathInput(input));
    case "spreadsheetQuery":
      return actionLabel(
        "spreadsheetQuery",
        tone,
        compactInput(input, ["query", "table"]) ?? compactPathInput(input),
      );
    case "scan":
      return actionLabel("scan", tone, compactPathInput(input));
    case "fileProtection":
      return actionLabel("fileProtection", tone, compactPathInput(input));
    case "protectedFile":
      return actionLabel("protectedFile", tone, compactPathInput(input));
    case "prepareEmail":
      return actionLabel(
        "prepareEmail",
        tone,
        compactInput(input, ["subject", "request", "description"]) ??
          recipientSummary(input),
      );
    case "sendEmail":
      return actionLabel(
        "sendEmail",
        tone,
        compactInput(input, ["subject"]) ?? recipientSummary(input),
      );
    case "replyEmail":
      return actionLabel(
        "replyEmail",
        tone,
        compactInput(input, ["subject"]) ?? recipientSummary(input),
      );
    case "scheduleMeeting":
      return actionLabel(
        "scheduleMeeting",
        tone,
        compactInput(input, ["title", "subject", "name"]),
      );
    case "deepResearch":
      return actionLabel("deepResearch", tone, stateTitle(part));
    case "connectedTools":
      return actionLabel("connectedTools", tone, stateTitle(part));
  }
}

import type { Part } from "@opencode-ai/sdk/v2/client";
import type { MessageGroup } from "~/shared/types/session";
import { LITELLM_EMPTY_CONTENT_PLACEHOLDER, stripModelPrefix } from "./model-ref";
import {
  isToolRejectText,
  sanitizeToolRejectMessages,
} from "./tool-reject-messages";

// Hide placeholder-only text parts. Strip any LRM model prefix first because
// stored text can look like `[model] [System: Empty message content ...]`.

function isPlaceholderOnlyTextPart(part: Part): boolean {
  if (part.type !== "text") return false;
  const text = (part as { text?: string }).text;
  if (typeof text !== "string") return false;
  return stripModelPrefix(text).trim() === LITELLM_EMPTY_CONTENT_PLACEHOLDER;
}

// Hide a text part that is nothing but a llmrouter_manager "Tool call rejected"
// notice (see tool-reject-messages.ts): it carries no information the user needs,
// only the model's own self-correction, so unlike the placeholder above there is no
// friendly copy to show in its place — the whole part just doesn't render. A notice
// mixed into real prose is NOT dropped here: sanitizeToolRejectMessages leaves the
// real prose behind, so the part stays visible and part-view.tsx renders that prose.
function isToolRejectOnlyTextPart(part: Part): boolean {
  if (part.type !== "text") return false;
  const text = (part as { text?: string }).text;
  if (typeof text !== "string") return false;
  const stripped = stripModelPrefix(text);
  if (!isToolRejectText(stripped)) return false;
  return sanitizeToolRejectMessages(stripped).trim() === "";
}

// `opts` is an options object, not a bare boolean, on purpose: Array.prototype.filter
// calls its callback as (element, index, array), and a bare second boolean parameter
// would silently bind to the numeric index for anyone tempted to pass either
// predicate point-free (`.filter(isVisibleTextPart)`) — `opts?.isUserMessage` reading
// off a stray number is just `undefined` (safe), where a bare `isUserMessage: boolean`
// parameter would have been truthy for every index past 0. TypeScript's structural
// check rejects a point-free pass anyway (a `number` shares no properties with this
// all-optional-properties type, so it won't typecheck as `Part[]["filter"]`'s
// callback), which is why every call site below wraps it: `.filter((part) =>
// isVisibleTextPart(part))`. Keep wrapping it that way in new call sites too.
export interface PartVisibilityOptions {
  /** The notice-removal filter only ever applies to the MODEL's own output: it is
   * the proxy's self-correction text leaking into an assistant part, never
   * something the user is expected to have typed. A user who pastes that same
   * text (e.g. "what does this error mean: Tool call rejected: ...") must still
   * see their own message. */
  isUserMessage?: boolean;
}

export function isUserVisiblePart(part: Part, opts?: PartVisibilityOptions) {
  const flags = part as { synthetic?: boolean; ignored?: boolean };
  if (flags.synthetic || flags.ignored) return false;
  if (isPlaceholderOnlyTextPart(part)) return false;
  if (opts?.isUserMessage) return true;
  return !isToolRejectOnlyTextPart(part);
}

export function isVisibleTextPart(part: Part, opts?: PartVisibilityOptions) {
  return part.type === "text" && isUserVisiblePart(part, opts);
}

export const EXPLORATION_TOOL_NAMES = new Set([
  "read",
  "glob",
  "grep",
  "search",
  "list",
  "list_files",
  "webfetch",
  "bash",
  "todoread",
  "todowrite",
]);

// Output prefix emitted by every SuperClaw search backend (Tavily, DuckDuckGo, future APIs).
// Any tool whose output starts with this prefix is treated as a web search for exploration grouping and favicon extraction.
const WEB_SEARCH_OUTPUT_PREFIX = "Web search results for query:";

export function isWebSearchToolOutput(output: string): boolean {
  return output.trimStart().startsWith(WEB_SEARCH_OUTPUT_PREFIX);
}

export function isExplorationToolPart(part: Part) {
  if (part.type !== "tool") return false;
  const record = part as { tool?: unknown; state?: { output?: unknown } };
  const tool = typeof record.tool === "string" ? record.tool.toLowerCase() : "";
  if (EXPLORATION_TOOL_NAMES.has(tool)) return true;
  const output = typeof record.state?.output === "string" ? record.state.output : "";
  return isWebSearchToolOutput(output);
}

export function coalesceExplorationGroups(groups: MessageGroup[]): MessageGroup[] {
  const nextGroups: MessageGroup[] = [];
  let changed = false;

  for (const group of groups) {
    const previous = nextGroups[nextGroups.length - 1];
    if (
      group.type === "tool-steps" &&
      group.mode === "exploration" &&
      previous?.type === "tool-steps" &&
      previous.mode === "exploration"
    ) {
      previous.parts = [...previous.parts, ...group.parts];
      changed = true;
      continue;
    }
    nextGroups.push(group);
  }

  return changed ? nextGroups : groups;
}

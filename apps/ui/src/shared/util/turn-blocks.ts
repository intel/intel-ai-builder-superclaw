/**
 * The one processing file between raw backend parts and the rendered session
 * timeline. Everything here is pure; rendering lives in
 * `app/components/session/message-list*.tsx`.
 *
 * Pipeline, in order:
 *
 *   Part[] (one message — MessageList calls this for both user and assistant
 *   messages; groupMessageParts's `isUserMessage` flag is what keeps a
 *   user-authored part from being swept up by a model-output-only filter, e.g.
 *   isToolRejectOnlyTextPart in part-visibility.ts)
 *     → groupMessageParts()   — parts → MessageGroup[] (text / tool-steps)
 *     → splitTurnGroups()     — toolSteps (narration + tools) vs answer
 *     → MessageList builds blocks: a "tool-steps" block per message with tool
 *       steps (narration rides inside the timeline as "note" items) and a
 *       "message" block for the answer
 *     → mergeToolStepsBlocks() — fuses neighbouring tool-steps blocks across
 *       messages into the single collapsed "Activity" row
 *
 * `<For>` diffs by object identity, so block identity *is* DOM identity: a new
 * object for the same content remounts the row and destroys everything the DOM
 * owns — most visibly the Activity timeline's scroll offset. Everything in this
 * module is therefore pure and must stay pure; the two render caches in
 * `MessageList` depend on it.
 */
import type { Part } from "@opencode-ai/sdk/v2/client";

import type {
  MessageGroup,
  MessageWithParts,
  ToolStepMode,
} from "~/shared/types/session";
import { stripEmptyContentPlaceholder, stripModelPrefix } from "./model-ref";
import {
  coalesceExplorationGroups,
  isExplorationToolPart,
  isVisibleTextPart,
} from "./part-visibility";

// ── Stage 1: parts → groups ────────────────────────────────────────────────

export function groupMessageParts(
  parts: Part[],
  messageId: string,
  isUserMessage = false,
): MessageGroup[] {
  const groups: MessageGroup[] = [];
  const explorationSteps: Part[] = [];
  const pendingReasoning: Part[] = [];
  let textBuffer = "";
  let textPartId: string | undefined;
  let toolStepsIndex = 0;

  const flushText = () => {
    if (!textBuffer) return;
    groups.push({
      type: "text",
      part: {
        type: "text",
        text: textBuffer,
        ...(textPartId ? { id: textPartId } : {}),
      } as unknown as Part,
    });
    textBuffer = "";
    textPartId = undefined;
  };

  const pushToolSteps = (stepParts: Part[], mode: ToolStepMode) => {
    if (!stepParts.length) return;
    groups.push({
      type: "tool-steps",
      id: `steps-${messageId}-${toolStepsIndex}`,
      parts: stepParts,
      mode,
    });
    toolStepsIndex += 1;
  };

  const flushExplorationSteps = () => {
    if (!explorationSteps.length) return;
    pushToolSteps(
      explorationSteps.splice(0, explorationSteps.length),
      "exploration",
    );
  };

  const flushPendingReasoning = () => {
    if (!pendingReasoning.length) return;
    pushToolSteps(
      pendingReasoning.splice(0, pendingReasoning.length),
      "standalone",
    );
  };

  parts.forEach((part) => {
    if (part.type === "text") {
      if (!isVisibleTextPart(part, { isUserMessage })) {
        return;
      }
      const rawText = (part as { text?: string }).text ?? "";
      flushPendingReasoning();
      flushExplorationSteps();
      // Agentic turns can prefix each text part and leave a leading litellm placeholder.
      if (!textBuffer) textPartId = part.id;
      textBuffer += stripEmptyContentPlaceholder(stripModelPrefix(rawText));
      return;
    }

    if (part.type === "agent") {
      flushPendingReasoning();
      flushExplorationSteps();
      const name = (part as { name?: string }).name ?? "";
      textPartId = undefined;
      textBuffer += name ? `@${name}` : "@agent";
      return;
    }

    if (part.type === "file") {
      flushPendingReasoning();
      flushExplorationSteps();
      flushText();
      groups.push({ type: "text", part });
      return;
    }

    if (part.type === "step-start" || part.type === "step-finish") {
      return;
    }

    flushText();

    if (part.type === "reasoning") {
      if (explorationSteps.length > 0) {
        explorationSteps.push(part);
      } else {
        pendingReasoning.push(part);
      }
      return;
    }

    if (isExplorationToolPart(part)) {
      if (pendingReasoning.length > 0) {
        explorationSteps.push(
          ...pendingReasoning.splice(0, pendingReasoning.length),
        );
      }
      explorationSteps.push(part);
      return;
    }

    flushPendingReasoning();
    flushExplorationSteps();
    pushToolSteps([part], "standalone");
  });

  flushText();

  flushPendingReasoning();
  flushExplorationSteps();

  return coalesceExplorationGroups(groups);
}

// ── Stage 2: split a message's groups into tool steps vs answer ────────────

export type TurnSplit = {
  /**
   * Everything up to and including the last tool-steps group. Rendered as one
   * collapsible row; narration text in here is dropped from the UI entirely.
   * Empty when the message ran no tools.
   */
  toolSteps: MessageGroup[];
  /** Groups after the last tool-steps group — the reply. */
  answer: MessageGroup[];
};

/**
 * The agent loop only ends when the model replies *without* calling a tool, so
 * position — not content — decides what a text group is: text at or before the
 * last tool-steps group is narration; text after it is the reply. No length
 * thresholds, no tool-name allowlists, no content sniffing.
 */
export function splitTurnGroups(groups: MessageGroup[]): TurnSplit {
  let lastToolStepsIndex = -1;
  for (let index = 0; index < groups.length; index += 1) {
    if (groups[index].type === "tool-steps") lastToolStepsIndex = index;
  }
  return {
    toolSteps: groups.slice(0, lastToolStepsIndex + 1),
    answer: groups.slice(lastToolStepsIndex + 1),
  };
}

// ── Block model ────────────────────────────────────────────────────────────

export type DeepResearchReportSummaryBlock = {
  id: string;
  afterMessageId: string;
  path: string;
  summaryPath: string;
  displayPath: string;
  summary: string | null;
  loading: boolean;
  error: string | null;
};

export type ToolStepGroup = {
  id: string;
  parts: Part[];
  mode: ToolStepMode;
};

export type ToolStepsBlock = {
  type: "tool-steps";
  id: string;
  toolSteps: ToolStepGroup[];
  messageIds: string[];
  isUser: boolean;
};

export type ReportSummaryBlock = {
  type: "report-summary";
  summary: DeepResearchReportSummaryBlock;
  isUser: false;
};

export type MessageBlock = {
  type: "message";
  message: MessageWithParts;
  renderableParts: Part[];
  attachments: Array<{
    url: string;
    filename: string;
    mime: string;
  }>;
  groups: MessageGroup[];
  isUser: boolean;
  messageId: string;
};

export type MessageBlockItem = MessageBlock | ToolStepsBlock | ReportSummaryBlock;

function partToPlainText(part: Part): string {
  if (part.type !== "text") return "";
  return String((part as { text?: string }).text ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function isToolStepsBlock(
  block: MessageBlockItem,
): block is ToolStepsBlock {
  return block.type === "tool-steps" && block.toolSteps.length > 0;
}

function isShortAssistantNote(
  block: MessageBlockItem,
): block is MessageBlock {
  if (block.type !== "message" || block.isUser) return false;
  if (block.attachments.length > 0) return false;
  if (block.groups.length !== 1) return false;

  const [group] = block.groups;
  if (!group || group.type !== "text") return false;

  const text = partToPlainText(group.part);
  if (!text) return false;
  if (text.length > 120) return false;
  if (/\n/.test(text)) return false;

  return true;
}

export function getBlockMessageIds(block: MessageBlockItem): string[] {
  if (block.type === "tool-steps") return block.messageIds;
  if (block.type === "message") return [block.messageId];
  return [];
}

export function isAssistantMessageStreaming(
  message: MessageWithParts,
): boolean {
  const info = message.info as {
    role?: string;
    time?: { completed?: number };
  };
  return info.role === "assistant" && !info.time?.completed;
}

/** Streaming blocks hold replacement part snapshots and cannot safely reuse a cached block. */
export function toolStepsContainStreamingAssistant(
  block: ToolStepsBlock,
  streamingAssistantMessageIds: ReadonlySet<string>,
): boolean {
  return block.messageIds.some((id) => streamingAssistantMessageIds.has(id));
}

export function shouldUseInnerTimelineScroll(
  isActiveStream: boolean,
  hasTaskChildSession: boolean,
): boolean {
  return !isActiveStream || hasTaskChildSession;
}

/** Deep-clone a block for use in a frozen display snapshot. */
export function deepCloneMessageBlock(
  block: MessageBlockItem,
): MessageBlockItem {
  try {
    return structuredClone(block);
  } catch {
    try {
      return JSON.parse(JSON.stringify(block)) as MessageBlockItem;
    } catch {
      // Cloning failed entirely. Fall back to the live block reference.
      return block;
    }
  }
}

// ── Stage 3: fuse tool-steps blocks across messages ────────────────────────

/**
 * Appends onto a tool-steps block without mutating it. `messageBlocks()` feeds
 * the merge pass blocks straight out of its level-1 render cache, and those
 * objects are still referenced by mounted `<For>` rows — mutating them would
 * both corrupt the cache and render stale, because a block is a plain object
 * and therefore not reactive.
 */
function concatToolStepsBlock(
  previous: ToolStepsBlock,
  toolSteps: ToolStepGroup[],
  messageIds: string[],
): ToolStepsBlock {
  return {
    ...previous,
    toolSteps: [...previous.toolSteps, ...toolSteps],
    messageIds: [...previous.messageIds, ...messageIds],
  };
}

/**
 * Fuses runs of adjacent tool-steps blocks into one block, optionally hopping
 * over a single short assistant sentence between them (narration — dropped
 * from the UI, but its message id is kept for cache keys and summary splicing).
 * Pure: input blocks are never mutated.
 */
export function mergeToolStepsBlocks(
  blocks: MessageBlockItem[],
): MessageBlockItem[] {
  const merged: MessageBlockItem[] = [];

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    const previous = merged[merged.length - 1];
    if (
      previous &&
      isToolStepsBlock(previous) &&
      isToolStepsBlock(block) &&
      previous.isUser === block.isUser
    ) {
      merged[merged.length - 1] = concatToolStepsBlock(
        previous,
        block.toolSteps,
        block.messageIds,
      );
      continue;
    }

    const next = blocks[index + 1];
    if (
      previous &&
      isToolStepsBlock(previous) &&
      isShortAssistantNote(block) &&
      next &&
      isToolStepsBlock(next) &&
      previous.isUser === block.isUser &&
      previous.isUser === next.isUser
    ) {
      merged[merged.length - 1] = concatToolStepsBlock(
        previous,
        next.toolSteps,
        [block.messageId, ...next.messageIds],
      );
      index += 1;
      continue;
    }

    merged.push(block);
  }

  return merged;
}

// ── Render-cache fingerprints ──────────────────────────────────────────────

/**
 * Fingerprint of the *mutable* tool state that tool-steps classification
 * depends on.
 *
 * `groupMessageParts` labels a tool-steps group `exploration` or `standalone`
 * through `isExplorationToolPart`, which falls back to sniffing `state.output`
 * for the web-search prefix when the tool name is not a known exploration tool.
 * `sc_search_web` — the only live web-search tool — is absent from that name
 * list, so its group mode flips from `standalone` to `exploration` only once the
 * output lands. That flip changes no part count, so `MessageList`'s level-1
 * reuse gate needs this to notice it; keyed on part count alone it would serve a
 * permanently mis-grouped block.
 *
 * Tool output is delivered whole on completion rather than streamed, so each
 * part's `state.status` is a faithful and cheap stand-in for "output is final".
 * Hashing the status keeps the outputs themselves untouched — they run to tens
 * of kilobytes and would otherwise be re-scanned on every recompute.
 */
export function toolClassificationSignature(parts: Part[]): string {
  let signature = "";
  for (const part of parts) {
    if (part.type !== "tool") continue;
    const record = part as { id?: string; state?: { status?: unknown } };
    const status =
      typeof record.state?.status === "string" ? record.state.status : "";
    signature += `${record.id ?? ""}:${status};`;
  }
  return signature;
}

/**
 * `toolClassificationSignature` plus the message's part ids. The real user part
 * replaces the pending-message placeholder one-for-one, after a reply has already
 * made the message non-last, and its text can differ (an expanded skill).
 */
export function messageReuseSignature(parts: Part[]): string {
  return `${parts.map((part) => part.id).join("|")}#${toolClassificationSignature(parts)}`;
}

/**
 * Structural fingerprint of a tool-steps block.
 *
 * Two blocks with the same fingerprint render identically for the same store
 * state, so `messageBlocks()` can hand `<For>` the previous object and keep the
 * mounted row — and the Activity timeline's scroll offset — alive.
 *
 * Streamed part updates replace a `Part` object, so a cached block can retain
 * an old proxy and miss a completed task or task-thread content. Keyed full
 * refreshes instead patch matching parts in place, preserving their proxies and
 * allowing unchanged blocks to observe poll updates. The scroll-position cache
 * restores the Activity offset when a changed status deliberately rebuilds a
 * row. `renderKey` is folded in so a developerMode / showThinking
 * toggle can never serve a block built under the other setting.
 */
export function toolStepsSignature(
  block: ToolStepsBlock,
  renderKey: string,
): string {
  const items = block.toolSteps.map((group) => {
    const partIds = group.parts
      .map((part) => (part as { id?: string }).id || part.type)
      .join(",");
    return `s:${group.id}:${group.mode}:${partIds}:${toolClassificationSignature(group.parts)}`;
  });
  return `${renderKey}:${block.isUser ? "u" : "a"}:${block.messageIds.join("|")}#${items.join(";")}`;
}

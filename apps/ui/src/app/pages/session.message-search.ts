/** Message text extraction for the Session view's in-thread search and prompt
 * navigation: turns a message into the text each feature matches against, scans
 * the thread for hits, and builds the prompt jump list. Pure - unit-testable.
 *
 * In-thread search match counting/navigation is otherwise rendered-DOM-first
 * (check `message-list.search-nav.ts`): this module's `collectSearchHits` is a
 * boolean per-message hint only, used to flag which messages contain a match
 * and is never cross-checked occurrence-for-occurrence against the highlighter. */

import type { MessageWithParts } from "../types";
import { marked } from "marked";
import { isUserVisiblePart } from "../utils";
import { parseComposerInboxUploadPath } from "../components/session/composer.attachments";
import { fileCardInfo } from "../components/part-view.file-info";
import {
  searchableStepLabel,
  visibleToolStepOutput,
} from "../components/session/message-list.tool";
import { stripSelectedFileAnnotations } from "../components/session/message-attachments";
import {
  MAX_PROMPT_NAVIGATION_LABEL_CHARS,
  MAX_SEARCH_HITS,
  MAX_SEARCH_MESSAGE_CHARS,
} from "./session.view-tuning";

export type SearchHit = { messageId: string };


export type PromptNavigationItem = { id: string; label: string };

/** Message ids arrive as strings, but tolerate a numeric id rather than
 * silently dropping the message from search and navigation. */
export const messageIdFromInfo = (message: MessageWithParts) => {
  const id = (message.info as { id?: string | number }).id;
  if (typeof id === "string") return id;
  if (typeof id === "number") return String(id);
  return "";
};

/** The haystack for in-thread search: every user-visible part flattened to text,
 * capped so one huge tool output cannot dominate the scan. */
export const messageTextForSearch = (message: MessageWithParts) => {
  const chunks: string[] = [];
  let used = 0;
  const push = (value: string) => {
    const next = value.trim();
    if (!next) return;
    if (used >= MAX_SEARCH_MESSAGE_CHARS) return;
    const remaining = MAX_SEARCH_MESSAGE_CHARS - used;
    if (next.length > remaining) {
      chunks.push(next.slice(0, Math.max(0, remaining)));
      used = MAX_SEARCH_MESSAGE_CHARS;
      return;
    }
    chunks.push(next);
    used += next.length;
  };

  const isUserMessage = message.info.role === "user";
  for (const part of message.parts) {
    if (!isUserVisiblePart(part, { isUserMessage })) {
      continue;
    }
    if (part.type === "text") {
      const text = (part as { text?: string }).text ?? "";
      push(isUserMessage ? stripSelectedFileAnnotations(text) : text);
      continue;
    }
    if (part.type === "agent") {
      const name = (part as { name?: string }).name ?? "";
      push(name ? `@${name}` : "");
      continue;
    }
    if (part.type === "file") {
      const file = part as {
        label?: string;
        path?: string;
        filename?: string;
        url?: string;
      };
      const label = file.label ?? file.path ?? file.filename ?? file.url ?? "";
      push(parseComposerInboxUploadPath(label)?.filename ?? label);
      continue;
    }
    if (part.type === "tool") {
      const state = (
        part as {
          state?: { title?: string; output?: string; error?: string };
        }
      ).state;
      push(state?.title ?? "");
      push(state?.output ?? "");
      push(state?.error ?? "");
    }
  }
  return chunks.join("\n");
};

const markdownVisibleTextForSearch = (text: string) => {
  const html = marked.parse(text, { async: false });
  if (typeof html !== "string") return text;
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
};

const messageHasSearchCandidate = (
  message: MessageWithParts,
  needle: string,
) => {
  const rawSearchText = messageTextForSearch(message);
  if (rawSearchText.toLowerCase().includes(needle)) return true;
  if (rawSearchText.length >= MAX_SEARCH_MESSAGE_CHARS) return false;

  const isUserMessage = message.info.role === "user";
  return message.parts.some((part) => {
    if (!isUserVisiblePart(part, { isUserMessage })) return false;
    if (part.type === "text") {
      return markdownVisibleTextForSearch(
        (part as { text?: string }).text ?? "",
      )
        .toLowerCase()
        .includes(needle);
    }
    if (part.type === "tool") {
      return [
        ...searchableStepLabel(part),
        visibleToolStepOutput(part),
      ].some((text) => text.toLowerCase().includes(needle));
    }
    if (part.type === "file") {
      const info = fileCardInfo(part);
      return [info?.title, info?.detail, info?.mime].some(
        (text) => text?.toLowerCase().includes(needle) ?? false,
      );
    }
    return false;
  });
};

/** Navigation labels show what the user typed, so only text and agent mentions
 * count - a turn that was purely an attachment has no label to show. */
const messageTextForPromptNavigation = (message: MessageWithParts) =>
  message.parts
    .filter((part) =>
      isUserVisiblePart(part, { isUserMessage: message.info.role === "user" }),
    )
    .flatMap((part) => {
      if (part.type === "text") {
        const text = (part as { text?: string }).text ?? "";
        const visibleText = stripSelectedFileAnnotations(text).trim();
        return visibleText ? [visibleText] : [];
      }
      if (part.type === "agent") {
        const name = (part as { name?: string }).name ?? "";
        return name ? [`@${name}`] : [];
      }
      return [];
    })
    .join("\n");

/** Scans the thread for `query`, which the caller has already trimmed and
 * lowercased. Reports `capped` so the caller can log a truncated scan: the hit
 * list stops at `MAX_SEARCH_HITS` rather than walking the whole thread. */
/** Scans the thread for `query`, which the caller has already trimmed and
 * lowercased. One hit per matching message, not per occurrence - this is a
 * presence hint for flagging matching rows, never cross-checked against what
 * the highlighter actually paints. Reports `capped` so the caller can log a
 * truncated scan: the hit list stops at `MAX_SEARCH_HITS` messages. */
export const collectSearchHits = (
  messages: MessageWithParts[],
  query: string,
  getMessagesBySessionId?: (
    sessionId: string,
  ) => MessageWithParts[] | undefined,
): { hits: SearchHit[]; capped: boolean } => {
  const hits: SearchHit[] = [];
  let capped = false;
  const needle = query.trim().toLowerCase();
  if (!needle) return { hits, capped };

  const messageHasQuery = (
    message: MessageWithParts,
    visitedSessions: Set<string>,
  ): boolean => {
    if (messageHasSearchCandidate(message, needle)) return true;
    if (!getMessagesBySessionId) return false;

    for (const part of message.parts) {
      if (part.type !== "tool") continue;
      const taskPart = part as {
        tool?: string;
        state?: {
          sessionId?: string;
          sessionID?: string;
          metadata?: { sessionId?: string; sessionID?: string };
        };
      };
      if (taskPart.tool?.toLowerCase() !== "task") continue;
      const sessionId =
        taskPart.state?.metadata?.sessionId ??
        taskPart.state?.metadata?.sessionID ??
        taskPart.state?.sessionId ??
        taskPart.state?.sessionID;
      if (!sessionId || visitedSessions.has(sessionId)) continue;
      visitedSessions.add(sessionId);
      if (
        getMessagesBySessionId(sessionId)?.some((child) =>
          messageHasQuery(child, visitedSessions),
        )
      ) {
        return true;
      }
    }
    return false;
  };

  for (const message of messages) {
    const messageId = messageIdFromInfo(message);
    if (!messageId) continue;
    if (!messageHasQuery(message, new Set())) continue;

    hits.push({ messageId });
    if (hits.length >= MAX_SEARCH_HITS) {
      capped = true;
      break;
    }
  }

  return { hits, capped };
};


export const buildPromptNavigationItems = (
  messages: MessageWithParts[],
): PromptNavigationItem[] => {
  const items = messages.flatMap((message) => {
    if ((message.info as { role?: string }).role !== "user") return [];
    const id = messageIdFromInfo(message);
    if (!id) return [];
    const label = messageTextForPromptNavigation(message)
      .replace(/\s+/g, " ")
      .trim();
    // A user turn with no user-visible part renders no row, so there is nothing to scroll to.
    if (!label) return [];
    return [
      {
        id,
        label:
          label.length > MAX_PROMPT_NAVIGATION_LABEL_CHARS
            ? `${label.slice(0, MAX_PROMPT_NAVIGATION_LABEL_CHARS)}...`
            : label,
      },
    ];
  });
  return items.length > 3 ? items : [];
};

/** Streaming rebuilds the list on every token. `<For>` reconciles by reference,
 * so the caller reuses the previous array when nothing changed - returning fresh
 * objects would unmount the row under the cursor mid-click. */
export const promptNavigationItemsEqual = (
  a: PromptNavigationItem[],
  b: PromptNavigationItem[],
) =>
  a.length === b.length &&
  a.every((item, index) => {
    const candidate = b[index];
    return (
      candidate !== undefined &&
      item.id === candidate.id &&
      item.label === candidate.label
    );
  });

import type { Part } from "@opencode-ai/sdk/v2/client";

import { sanitizeGuardErrors } from "~/shared/util/guard-messages";
import { sanitizeToolRejectMessages } from "~/shared/util/tool-reject-messages";
import type { MessageBlock } from "~/shared/util/turn-blocks";
import { stripEmptyContentPlaceholder, stripModelPrefix } from "../../utils";
import { stripSelectedFileAnnotations } from "./message-attachments";

/** Plain-text rendering of a single message part, for copy, read-aloud and edit. */
export const partToText = (part: Part, stripPrefix = true): string => {
  if (part.type === "text") {
    const raw = String((part as { text?: string }).text ?? "");
    return stripPrefix ? stripEmptyContentPlaceholder(stripModelPrefix(raw)) : raw;
  }
  if (part.type === "agent") {
    const name = (part as { name?: string }).name ?? "";
    return name ? `@${name}` : "@agent";
  }
  if (part.type === "file") {
    const record = part as {
      label?: string;
      path?: string;
      filename?: string;
    };
    const label = record.label ?? record.path ?? record.filename ?? "";
    return label ? `@${label}` : "@file";
  }
  return "";
};

/**
 * Model output goes through the guard and tool-reject sanitizers: hiding a quoted
 * guard error or a llmrouter_manager rejection notice on screen is pointless if
 * copying the same message still reproduces it verbatim. User text is left alone so
 * a pasted log is copied back as written.
 */
export const copyTextForMessageBlock = (block: MessageBlock) => {
  const text = block.groups
    .filter((group) => group.type === "text")
    .map((group) => {
      const partText = partToText(group.part, !block.isUser);
      return block.isUser
        ? stripSelectedFileAnnotations(partText)
        : partText;
    })
    .filter(Boolean)
    .join("\n")
    .trim();
  return block.isUser
    ? text
    : sanitizeToolRejectMessages(sanitizeGuardErrors(text));
};

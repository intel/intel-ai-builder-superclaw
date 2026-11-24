import type { Message, Part } from "@opencode-ai/sdk/v2/client";

import {
  PENDING_USER_MESSAGE_PREFIX,
  type MessageWithParts,
  type PlaceholderAssistantMessage,
  type SessionClassifierUserTurn,
} from "~/shared/types/session";

type CreatePendingUserMessageInput = {
  sessionID: string;
  submissionID: string;
  text: string;
  afterMessageID: string | null;
  createdAt: number;
  attachments?: Array<{ url: string; mime: string; filename: string }>;
};

export function createPendingUserMessage(
  input: CreatePendingUserMessageInput,
): MessageWithParts {
  const id = `${PENDING_USER_MESSAGE_PREFIX}${input.submissionID}`;
  const info: PlaceholderAssistantMessage = {
    id,
    sessionID: input.sessionID,
    role: "user",
    time: { created: input.createdAt, completed: input.createdAt },
    parentID: input.afterMessageID ?? "",
    modelID: "",
    providerID: "",
    mode: "",
    agent: "",
    path: { cwd: "", root: "" },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  };
  const part = {
    id: `${id}:text`,
    sessionID: input.sessionID,
    messageID: id,
    type: "text",
    text: input.text,
  } as Part;
  const attachmentParts = (input.attachments ?? []).map(
    (attachment, index) =>
      ({
        id: `${id}:attachment:${index}`,
        sessionID: input.sessionID,
        messageID: id,
        type: "file",
        url: attachment.url,
        mime: attachment.mime,
        filename: attachment.filename,
      }) as Part,
  );

  return { info, parts: [part, ...attachmentParts] };
}

export function shouldReconcilePendingUserMessage(
  pending: MessageWithParts,
  authoritative: Message,
  knownMessageIDs: ReadonlySet<string>,
): boolean {
  if (authoritative.role !== "user") return false;
  if (authoritative.sessionID !== pending.info.sessionID) return false;
  if (authoritative.id.startsWith(PENDING_USER_MESSAGE_PREFIX)) return false;
  const afterMessageID = "parentID" in pending.info
    ? pending.info.parentID ?? ""
    : "";
  if (
    afterMessageID &&
    authoritative.id.localeCompare(afterMessageID) <= 0
  ) {
    return false;
  }
  return !knownMessageIDs.has(authoritative.id);
}

export function pendingUserMessageToClassifierTurn(
  pending: MessageWithParts,
): SessionClassifierUserTurn {
  const textPart = pending.parts.find(
    (part): part is Part & { type: "text"; text: string } =>
      part.type === "text" && typeof part.text === "string",
  );

  return {
    id: pending.info.id,
    text: textPart?.text ?? "",
    afterMessageID:
      "parentID" in pending.info && pending.info.parentID
        ? pending.info.parentID
        : null,
    time: pending.info.time.created,
  };
}

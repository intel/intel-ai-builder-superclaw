/**
 * Synthetic transcript entries: the error, compact and intent-classifier turns
 * OpenWork renders inline with the OpenCode message log. The builders shape a
 * turn into a `MessageWithParts`; the `insert*` helpers place it against its
 * anchor message, falling back to time order when the anchor is gone.
 *
 * Pure — no signals, no store access — so the ordering rules are unit-testable.
 */
import type { Part } from "@opencode-ai/sdk/v2/client";
import type {
  MessageWithParts,
  PlaceholderAssistantMessage,
  SessionClassifierTurn,
  SessionClassifierUserTurn,
  SessionCompactTurn,
  SessionErrorTurn,
} from "~/shared/types/session";
import { SYNTHETIC_SESSION_CLASSIFIER_USER_MESSAGE_PREFIX } from "~/shared/types/session";

export const messageIdFromInfo = (message: MessageWithParts) => {
  const id = (message.info as { id?: string | number }).id;
  if (typeof id === "string") return id;
  if (typeof id === "number") return String(id);
  return "";
};

export const messageCreatedAt = (message: MessageWithParts) => {
  const created = (message.info as { time?: { created?: unknown } }).time
    ?.created;
  return typeof created === "number" ? created : null;
};

export const createSyntheticSessionErrorMessage = (
  sessionID: string,
  errorTurn: SessionErrorTurn,
): MessageWithParts => {
  const info: PlaceholderAssistantMessage = {
    id: errorTurn.id,
    sessionID,
    role: "assistant",
    time: { created: errorTurn.time, completed: errorTurn.time },
    parentID: errorTurn.afterMessageID ?? "",
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
    errorKind: errorTurn.kind,
  };

  return {
    info,
    parts: [
      {
        id: `${errorTurn.id}:text`,
        sessionID,
        messageID: errorTurn.id,
        type: "text",
        text: errorTurn.text,
      } as Part,
    ],
  };
};

const createSyntheticSessionCompactMessage = (
  sessionID: string,
  compactTurn: SessionCompactTurn,
): MessageWithParts => {
  const info: PlaceholderAssistantMessage = {
    id: compactTurn.id,
    sessionID,
    role: "assistant",
    time: { created: compactTurn.time, completed: compactTurn.time },
    parentID: compactTurn.afterMessageID ?? "",
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

  return {
    info,
    parts: [
      {
        id: `${compactTurn.id}:text`,
        sessionID,
        messageID: compactTurn.id,
        type: "text",
        text: compactTurn.text,
      } as Part,
    ],
  };
};

const createSyntheticSessionClassifierMessage = (
  sessionID: string,
  classifierTurn: SessionClassifierTurn,
): MessageWithParts => {
  const info: PlaceholderAssistantMessage = {
    id: classifierTurn.id,
    sessionID,
    role: "assistant",
    time: { created: classifierTurn.time, completed: classifierTurn.time },
    parentID: classifierTurn.afterMessageID ?? "",
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

  return {
    info,
    parts: [
      {
        id: `${classifierTurn.id}:text`,
        sessionID,
        messageID: classifierTurn.id,
        type: "text",
        text: classifierTurn.text,
      } as Part,
    ],
  };
};

export const createSyntheticSessionClassifierUserMessage = (
  sessionID: string,
  userTurn: SessionClassifierUserTurn,
): MessageWithParts => {
  const info: PlaceholderAssistantMessage = {
    id: userTurn.id,
    sessionID,
    role: "user",
    time: { created: userTurn.time, completed: userTurn.time },
    parentID: userTurn.afterMessageID ?? "",
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

  return {
    info,
    parts: [
      {
        id: `${userTurn.id}:text`,
        sessionID,
        messageID: userTurn.id,
        type: "text",
        text: userTurn.text,
      } as Part,
    ],
  };
};

export const insertSyntheticSessionErrors = (
  list: MessageWithParts[],
  sessionID: string | null,
  errorTurns: SessionErrorTurn[],
  hiddenByRevertIds?: Set<string>,
) => {
  if (!sessionID || errorTurns.length === 0) return list;

  const next = list.slice();
  errorTurns.forEach((errorTurn) => {
    if (next.some((message) => messageIdFromInfo(message) === errorTurn.id))
      return;
    const syntheticMessage = createSyntheticSessionErrorMessage(
      sessionID,
      errorTurn,
    );
    const anchorIndex = errorTurn.afterMessageID
      ? next.findIndex(
        (message) =>
          messageIdFromInfo(message) === errorTurn.afterMessageID,
      )
      : -1;

    if (anchorIndex === -1) {
      // The anchor exists but is currently hidden behind a revert boundary:
      // skip rendering rather than stranding the turn at the end. It reappears
      // once the anchor is visible again (e.g. Redo), since the turn is kept
      // in the store (see reconcileSessionErrorTurns in session.ts).
      if (errorTurn.afterMessageID && hiddenByRevertIds?.has(errorTurn.afterMessageID)) {
        return;
      }
      next.push(syntheticMessage);
      return;
    }

    next.splice(anchorIndex + 1, 0, syntheticMessage);
  });

  return next;
};

export const insertSyntheticSessionClassifiers = (
  list: MessageWithParts[],
  sessionID: string | null,
  classifierTurns: SessionClassifierTurn[],
) => {
  if (!sessionID || classifierTurns.length === 0) return list;

  const next = list.slice();
  classifierTurns.forEach((classifierTurn) => {
    if (
      next.some((message) => messageIdFromInfo(message) === classifierTurn.id)
    )
      return;
    const syntheticMessage = createSyntheticSessionClassifierMessage(
      sessionID,
      classifierTurn,
    );
    const anchorIndex = classifierTurn.afterMessageID
      ? next.findIndex(
        (message) =>
          messageIdFromInfo(message) === classifierTurn.afterMessageID,
      )
      : -1;

    if (anchorIndex === -1) {
      const timeIndex = next.findIndex((message) => {
        const created = messageCreatedAt(message);
        return created !== null && created > classifierTurn.time;
      });
      if (timeIndex !== -1) {
        next.splice(timeIndex, 0, syntheticMessage);
        return;
      }
      next.push(syntheticMessage);
      return;
    }

    next.splice(anchorIndex + 1, 0, syntheticMessage);
  });

  return next;
};

export const insertSyntheticSessionClassifierUsers = (
  list: MessageWithParts[],
  sessionID: string | null,
  userTurns: SessionClassifierUserTurn[],
) => {
  if (!sessionID || userTurns.length === 0) return list;

  const next = list.slice();
  userTurns.forEach((userTurn) => {
    if (next.some((message) => messageIdFromInfo(message) === userTurn.id))
      return;
    const syntheticMessage = createSyntheticSessionClassifierUserMessage(
      sessionID,
      userTurn,
    );
    const anchorIndex = userTurn.afterMessageID
      ? next.findIndex(
        (message) => messageIdFromInfo(message) === userTurn.afterMessageID,
      )
      : -1;

    if (anchorIndex === -1) {
      const timeIndex = next.findIndex((message) => {
        const created = messageCreatedAt(message);
        return created !== null && created > userTurn.time;
      });
      if (timeIndex !== -1) {
        next.splice(timeIndex, 0, syntheticMessage);
        return;
      }
      next.push(syntheticMessage);
      return;
    }

    let insertIndex = anchorIndex + 1;
    while (insertIndex < next.length) {
      const id = messageIdFromInfo(next[insertIndex]);
      const created = messageCreatedAt(next[insertIndex]);
      if (!id.startsWith(SYNTHETIC_SESSION_CLASSIFIER_USER_MESSAGE_PREFIX))
        break;
      if (created !== null && created > userTurn.time) break;
      insertIndex += 1;
    }
    next.splice(insertIndex, 0, syntheticMessage);
  });

  return next;
};

export const insertSyntheticSessionCompacts = (
  list: MessageWithParts[],
  sessionID: string | null,
  compactTurns: SessionCompactTurn[],
) => {
  if (!sessionID || compactTurns.length === 0) return list;

  const next = list.slice();
  compactTurns.forEach((compactTurn) => {
    if (next.some((message) => messageIdFromInfo(message) === compactTurn.id))
      return;
    const syntheticMessage = createSyntheticSessionCompactMessage(
      sessionID,
      compactTurn,
    );
    const anchorIndex = compactTurn.afterMessageID
      ? next.findIndex(
        (message) =>
          messageIdFromInfo(message) === compactTurn.afterMessageID,
      )
      : -1;

    if (anchorIndex === -1) {
      next.push(syntheticMessage);
      return;
    }

    next.splice(anchorIndex + 1, 0, syntheticMessage);
  });

  return next;
};

/**
 * Per-session synthetic turn bookkeeping and the visible transcript it feeds.
 *
 * OpenCode's message log is not what the user sees. Three kinds of turn exist
 * only on the desktop side — compaction markers, intent-classifier answers, and
 * the user prompts that produced them — and they have to be woven back into the
 * log at the right position. This module owns that state and the single memo
 * that merges it, so `app.tsx` consumes an already-correct transcript.
 */
import { createMemo, createSignal } from "solid-js";
import type { Accessor } from "solid-js";

import type { SessionStore } from "~/features/session";

import {
  insertSyntheticSessionClassifiers,
  insertSyntheticSessionClassifierUsers,
  insertSyntheticSessionCompacts,
  insertSyntheticSessionErrors,
  messageIdFromInfo,
} from "./app.synthetic-messages";
import {
  SYNTHETIC_SESSION_CLASSIFIER_MESSAGE_PREFIX,
  SYNTHETIC_SESSION_CLASSIFIER_USER_MESSAGE_PREFIX,
  SYNTHETIC_SESSION_COMPACT_MESSAGE_PREFIX,
  SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX,
} from "./types";
import type { SessionClassifierUserTurn, SessionCompactTurn } from "./types";

/**
 * Adds a compaction marker unless the previous one for that session already sits
 * at the same position with the same text, which happens whenever the effect that
 * drives compaction re-runs. Returns `current` unchanged in that case so the
 * signal write is a no-op.
 */
export const nextCompactTurnsById = (
  current: Record<string, SessionCompactTurn[]>,
  sessionID: string,
  afterMessageID: string | null,
  text: string,
): Record<string, SessionCompactTurn[]> => {
  const existing = current[sessionID] ?? [];
  const previous = existing[existing.length - 1];
  if (
    previous &&
    previous.text === text &&
    previous.afterMessageID === afterMessageID
  ) {
    return current;
  }

  return {
    ...current,
    [sessionID]: existing.concat({
      id: `${SYNTHETIC_SESSION_COMPACT_MESSAGE_PREFIX}${sessionID}:${Date.now()}:${existing.length}`,
      text,
      afterMessageID,
      time: Date.now(),
    }),
  };
};

export type SessionTurnsDeps = {
  selectedSessionId: Accessor<string | null>;
  sessionStore: SessionStore;
};

export const createSessionTurns = (deps: SessionTurnsDeps) => {
  const { selectedSessionId, sessionStore } = deps;
  const { messages, selectedSession } = sessionStore;

  const [sessionCompactTurnsById, setSessionCompactTurnsById] = createSignal<
    Record<string, SessionCompactTurn[]>
  >({});
  const [sessionClassifierUserTurnsById, setSessionClassifierUserTurnsById] =
    createSignal<Record<string, SessionClassifierUserTurn[]>>({});

  const selectedSessionCompactTurns = createMemo(() => {
    const sessionID = selectedSessionId();
    return sessionID ? (sessionCompactTurnsById()[sessionID] ?? []) : [];
  });

  const selectedSessionClassifierUserTurns = createMemo(() => {
    const sessionID = selectedSessionId();
    return sessionID ? (sessionClassifierUserTurnsById()[sessionID] ?? []) : [];
  });

  const appendSessionClassifierUserTurn = (
    sessionID: string,
    text: string,
    existingTurn?: SessionClassifierUserTurn,
    classifierText?: string,
  ) => {
    const trimmed = text.trim();
    if (!sessionID || (!trimmed && !existingTurn?.text.trim())) return null;
    const messageList = messages();
    const lastMessage = messageList.length > 0 ? messageList[messageList.length - 1] : null;
    const afterMessageID = lastMessage ? messageIdFromInfo(lastMessage) : null;
    const stored = sessionClassifierUserTurnsById()[sessionID] ?? [];
    const previous = existingTurn
      ? stored.find((turn) => turn.id === existingTurn.id)
      : undefined;
    const turn: SessionClassifierUserTurn = previous
      ? {
          ...previous,
          text: trimmed || previous.text,
          classifierText: classifierText ?? previous.classifierText,
        }
      : {
          ...(existingTurn ?? {
            id: `${SYNTHETIC_SESSION_CLASSIFIER_USER_MESSAGE_PREFIX}${sessionID}:${Date.now()}:${stored.length}`,
            afterMessageID,
            time: Date.now(),
          }),
          text: existingTurn?.text.trim() || trimmed,
          classifierText,
        };

    setSessionClassifierUserTurnsById((current) => {
      const existing = current[sessionID] ?? [];
      const index = existing.findIndex((item) => item.id === turn.id);
      if (index === -1) {
        return { ...current, [sessionID]: existing.concat(turn) };
      }
      const next = existing.slice();
      next[index] = turn;
      return { ...current, [sessionID]: next };
    });
    return turn;
  };

  const appendSessionCompactTurn = (
    sessionID: string,
    afterMessageID: string | null,
    text = "Context compacted here",
  ) => {
    const trimmed = text.trim();
    if (!sessionID || !trimmed) return;

    setSessionCompactTurnsById((current) =>
      nextCompactTurnsById(current, sessionID, afterMessageID, trimmed),
    );
  };

  // OpenCode keeps reverted messages in the log and uses `session.revert.messageID`
  // as the visibility boundary. OpenWork mirrors that behavior by filtering the
  // displayed transcript.
  const visibleMessages = createMemo(() => {
    const sessionID = selectedSessionId();
    const errorTurns = sessionStore.selectedSessionErrorTurns();
    const classifierUserTurns = selectedSessionClassifierUserTurns();
    const classifierTurns = sessionStore.selectedSessionClassifierTurns();
    const compactTurns = selectedSessionCompactTurns();
    const list = messages().filter((message) => {
      const id = messageIdFromInfo(message);
      return (
        !id.startsWith(SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX) &&
        !id.startsWith(SYNTHETIC_SESSION_CLASSIFIER_MESSAGE_PREFIX) &&
        !id.startsWith(SYNTHETIC_SESSION_CLASSIFIER_USER_MESSAGE_PREFIX) &&
        !id.startsWith(SYNTHETIC_SESSION_COMPACT_MESSAGE_PREFIX)
      );
    });
    const revert = selectedSession()?.revert?.messageID ?? null;
    const visible = !revert
      ? list
      : list.filter((message) => {
        const id = messageIdFromInfo(message);
        return Boolean(id) && id < revert;
      });
    const hiddenByRevertIds = revert
      ? new Set(
        list
          .filter((message) => {
            const id = messageIdFromInfo(message);
            return Boolean(id) && id >= revert;
          })
          .map((message) => messageIdFromInfo(message)),
      )
      : undefined;
    return insertSyntheticSessionCompacts(
      insertSyntheticSessionClassifiers(
        insertSyntheticSessionClassifierUsers(
          insertSyntheticSessionErrors(visible, sessionID, errorTurns, hiddenByRevertIds),
          sessionID,
          classifierUserTurns,
        ),
        sessionID,
        classifierTurns,
      ),
      sessionID,
      compactTurns,
    );
  });

  return {
    appendSessionClassifierUserTurn,
    appendSessionCompactTurn,
    sessionClassifierUserTurnsById,
    setSessionClassifierUserTurnsById,
    visibleMessages,
  };
};

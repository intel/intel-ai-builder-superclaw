/**
 * Session run controls: the imperative actions a user takes against a run that
 * is already in flight or already finished — stop it, retry the last prompt,
 * compact the context, or resend an edited message. They share the selected
 * session, its model and the message list, so they move as one controller
 * rather than five loose functions.
 *
 * Everything reactive is injected. `App()` declares these accessors at widely
 * separated points in its body, so the factory call has to sit below the last
 * of them; the bodies only read an accessor when the user invokes them.
 */
import type { Accessor, Setter } from "solid-js";
import type { Session } from "@opencode-ai/sdk/v2/client";

import {
  abortSession as abortSessionTyped,
  abortSessionSafe,
  compactSession as compactSessionTyped,
  revertSession,
  unrevertSession,
} from "./lib/opencode-session";
import { finishPerf, perfNow, recordPerfLog } from "./lib/perf-log";
import { safeStringify } from "./utils";
import { messageIdFromInfo } from "./app.synthetic-messages";
import {
  PENDING_USER_MESSAGE_PREFIX,
  SYNTHETIC_SESSION_CLASSIFIER_USER_MESSAGE_PREFIX,
} from "./types";
import type {
  Client,
  ComposerAttachment,
  ComposerDraft,
  ComposerPart,
  MessageWithParts,
  ModelRef,
  SessionClassifierUserTurn,
} from "./types";

export type SendPrompt = (
  draft?: ComposerDraft,
  options?: {
    validateAutoRoutedAgent?: (agent: string) => Promise<boolean> | boolean;
    onAccepted?: () => void;
    submittedAt?: number;
    optimisticUserMessage?: boolean;
    rethrowOnError?: boolean;
  },
) => Promise<boolean | undefined>;

export type SessionRunControlsDeps = {
  appendSessionCompactTurn: (
    sessionID: string,
    afterMessageID: string | null,
  ) => void;
  autoCompactContext: Accessor<boolean>;
  autoCompactingSessionId: Accessor<string | null>;
  client: Accessor<Client | null>;
  developerMode: Accessor<boolean>;
  lastPromptSent: Accessor<string>;
  messages: Accessor<MessageWithParts[]>;
  modelVariant: Accessor<string | null>;
  selectedSession: Accessor<Session | null>;
  selectedSessionId: Accessor<string | null>;
  selectedSessionModel: Accessor<ModelRef>;
  sendPrompt: SendPrompt;
  sessionStore: {
    clearPendingUserMessage: (sessionID: string, messageID: string) => void;
    removeSessionClassifierTurnsByAfterMessageID: (
      sessionID: string,
      messageID: string,
    ) => void;
  };
  setAutoCompactingSessionId: Setter<string | null>;
  setMessages: (next: MessageWithParts[]) => void;
  setSessionClassifierUserTurnsById: Setter<
    Record<string, SessionClassifierUserTurn[]>
  >;
  upsertLocalSession: (next: Session | null | undefined) => void;
  visibleMessages: Accessor<MessageWithParts[]>;
  workspaceSdkDir: Accessor<string>;
};

export const createSessionRunControls = (deps: SessionRunControlsDeps) => {
  // `deps` is a plain object of accessors built once by `App()`, not a Solid
  // props proxy, so destructuring it copies function references without
  // collapsing any reactivity — and keeps the bodies below byte-identical to
  // the ones that lived in `App()`.
  const {
    appendSessionCompactTurn,
    autoCompactContext,
    autoCompactingSessionId,
    client,
    developerMode,
    lastPromptSent,
    messages,
    modelVariant,
    selectedSession,
    selectedSessionId,
    selectedSessionModel,
    sendPrompt,
    sessionStore,
    setAutoCompactingSessionId,
    setMessages,
    setSessionClassifierUserTurnsById,
    upsertLocalSession,
    visibleMessages,
    workspaceSdkDir,
  } = deps;

  async function abortSession(sessionID?: string) {
    const c = client();
    if (!c) return;
    const id = (sessionID ?? selectedSessionId() ?? "").trim();
    if (!id) return;
    // OpenCode exposes session.abort which interrupts the active prompt/run.
    // We intentionally don't mutate global busy state here; the SessionView
    // provides local UX (button disabled + toast) for cancellation.
    await abortSessionTyped(c, id);
  }

  function retryLastPrompt() {
    const text = lastPromptSent().trim();
    if (!text) return;
    void sendPrompt({
      mode: "prompt",
      text,
      parts: [{ type: "text", text }],
      attachments: [],
    });
  }

  async function compactCurrentSession(
    sessionIdOverride?: string,
    options?: { marker?: "visible" | "none" },
  ) {
    const c = client();
    if (!c) {
      throw new Error("Not connected to a server");
    }

    const sessionID = (sessionIdOverride ?? selectedSessionId() ?? "").trim();
    if (!sessionID) {
      throw new Error("Select a session before compacting.");
    }

    const visible = messages();
    if (!visible.length) {
      throw new Error("Nothing to compact yet.");
    }
    const transcript = visibleMessages();
    const anchorMessageID =
      transcript.length > 0
        ? messageIdFromInfo(transcript[transcript.length - 1]) || null
        : null;

    const model = selectedSessionModel();
    const startedAt = perfNow();
    const modelLabel = `${model.providerID}/${model.modelID}`;
    recordPerfLog(developerMode(), "session.compact", "start", {
      sessionID,
      messageCount: visible.length,
      model: modelLabel,
      variant: modelVariant() ?? null,
    });

    try {
      await compactSessionTyped(c, sessionID, model, {
        directory: workspaceSdkDir() || undefined,
      });
      if (options?.marker !== "none") {
        appendSessionCompactTurn(sessionID, anchorMessageID);
      }
      finishPerf(developerMode(), "session.compact", "done", startedAt, {
        sessionID,
        messageCount: visible.length,
        model: modelLabel,
      });
    } catch (error) {
      finishPerf(developerMode(), "session.compact", "error", startedAt, {
        sessionID,
        messageCount: visible.length,
        model: modelLabel,
        error: error instanceof Error ? error.message : safeStringify(error),
      });
      throw error;
    }
  }

  const triggerAutoCompaction = async (sessionID: string) => {
    if (!autoCompactContext()) return;
    if (autoCompactingSessionId() === sessionID) return;

    setAutoCompactingSessionId(sessionID);
    try {
      await compactCurrentSession(sessionID, { marker: "none" });
    } catch {
      // ignore auto-compaction failures; manual compact remains available
    } finally {
      setAutoCompactingSessionId((current) =>
        current === sessionID ? null : current,
      );
    }
  };

  // Edit a previously-sent user message in place. When called for a retry (same text,
  // not an actual edit), pass `optimisticHide: false` to keep the user message and
  // stale assistant reply on screen until the real revert lands.
  async function submitEditedUserMessage(
    messageID: string,
    text: string,
    options?: { optimisticHide?: boolean },
  ) {
    const optimisticHide = options?.optimisticHide ?? true;
    const c = client();
    const sessionID = (selectedSessionId() ?? "").trim();
    if (!c || !sessionID) return;

    const trimmed = text.trim();
    if (!trimmed) return;

    const isPendingUserMessage = messageID.startsWith(
      PENDING_USER_MESSAGE_PREFIX,
    );
    const isSyntheticClassifierTurn =
      messageID.startsWith(SYNTHETIC_SESSION_CLASSIFIER_USER_MESSAGE_PREFIX) ||
      isPendingUserMessage;

    // Guard: this resubmit path is text-only; reject messages with attachments/files.
    if (!isSyntheticClassifierTurn) {
      const targetMessage = messages().find(
        (message) => messageIdFromInfo(message) === messageID,
      );
      const hasNonTextParts = targetMessage?.parts.some(
        (part) =>
          part.type !== "text" &&
          part.type !== "step-start" &&
          part.type !== "step-finish",
      );
      if (hasNonTextParts) {
        throw new Error(
          "This message includes attachments and can't be edited yet.",
        );
      }
    }

    // Snapshot so we can roll back if the resend fails.
    const priorRevertMessageID = selectedSession()?.revert?.messageID;
    const replacedMessageIDs = new Set(
      messages()
        .map(messageIdFromInfo)
        .filter((id) => Boolean(id) && id >= messageID),
    );

    // Optimistically hide the edited message (and everything after it, including the
    // stale assistant response) the instant the edit is confirmed — synchronously,
    // before any network round-trip. Without this, the old assistant answer stays
    // on screen for the duration of the abort+revert calls and then vanishes abruptly
    // once the real revert lands, producing a visible flicker.
    if (!isSyntheticClassifierTurn && optimisticHide) {
      const currentSession = selectedSession();
      if (currentSession && currentSession.id === sessionID) {
        upsertLocalSession({
          ...currentSession,
          revert: { messageID },
        } as Session);
      }
    }

    await abortSessionSafe(c, sessionID);

    // Synthetic classifier user turns (greetings intercepted by the intent classifier)
    // never reached the OpenCode backend, so there is nothing to revert on the backend.
    let didBackendRevert = false;
    if (!isSyntheticClassifierTurn) {
      try {
        const next = await revertSession(c, sessionID, messageID);
        upsertLocalSession(next);
        didBackendRevert = true;
      } catch (error) {
        // Restore the optimistic revert marker to its previous state before re-throwing.
        const current = selectedSession();
        if (current && current.id === sessionID) {
          upsertLocalSession({
            ...current,
            revert: priorRevertMessageID
              ? { messageID: priorRevertMessageID }
              : undefined,
          } as Session);
        }
        throw error;
      }
    }

    try {
      const result = await sendPrompt(
        {
          mode: "prompt",
          parts: [{ type: "text", text: trimmed } as ComposerPart],
          attachments: [] as ComposerAttachment[],
          text: trimmed,
        },
        { rethrowOnError: true, optimisticUserMessage: false },
      );
      if (result === false) {
        throw new Error("The edited message could not be sent.");
      }

      if (isPendingUserMessage) {
        sessionStore.clearPendingUserMessage(sessionID, messageID);
      }

      // Drop the original synthetic user/classifier turns as soon as the resend lands successfully, even if the classifier intercepted the new text and didn't dispatch to the backend.
      if (isSyntheticClassifierTurn) {
        setSessionClassifierUserTurnsById((current) => {
          const existing = current[sessionID];
          if (!existing) return current;
          const filtered = existing.filter((turn) => turn.id !== messageID);
          if (filtered.length === existing.length) return current;
          return { ...current, [sessionID]: filtered };
        });

        sessionStore.removeSessionClassifierTurnsByAfterMessageID(
          sessionID,
          messageID,
        );
      }

      // Keep the revert marker. The new message (and its assistant reply) has a fresher ID than the revert boundary.
      if (result !== true) {
        return;
      }

      setMessages(
        messages().filter(
          (message) => !replacedMessageIDs.has(messageIdFromInfo(message)),
        ),
      );

      // The new message (and its assistant reply) has a fresher ID than the revert boundary.
      // Sending a new prompt supersedes the reverted branch for good, so drop the local revert marker now.
      const current = selectedSession();
      if (current && current.id === sessionID && current.revert) {
        upsertLocalSession({ ...current, revert: undefined } as Session);
      }
    } catch (error) {
      // Roll back so the transcript reflects reality rather than a half-applied edit.
      if (didBackendRevert) {
        try {
          if (priorRevertMessageID) {
            // Restore to the pre-edit revert boundary
            const restored = await revertSession(
              c,
              sessionID,
              priorRevertMessageID,
            );
            upsertLocalSession(restored);
          } else {
            const restored = await unrevertSession(c, sessionID);
            upsertLocalSession(restored);
          }
        } catch { }
      } else {
        const current = selectedSession();
        if (current && current.id === sessionID) {
          upsertLocalSession({
            ...current,
            revert: priorRevertMessageID
              ? { messageID: priorRevertMessageID }
              : undefined,
          } as Session);
        }
      }
      throw error;
    }
  }

  return {
    abortSession,
    compactCurrentSession,
    retryLastPrompt,
    submitEditedUserMessage,
    triggerAutoCompaction,
  };
};

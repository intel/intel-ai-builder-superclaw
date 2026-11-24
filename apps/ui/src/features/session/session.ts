import { batch, createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js";
import { createStore, produce, reconcile } from "solid-js/store";

import type { Message, Part, Session } from "@opencode-ai/sdk/v2/client";

import type { Client } from "~/shared/platform/transport/opencode";
import type {
  MessageInfo,
  MessageWithParts,
  PendingPermission,
  PendingQuestion,
  SessionClassifierTurn,
  SessionErrorTurn,
  TodoItem,
} from "~/shared/types/session";
import type { ModelRef } from "~/shared/types/models";
import type {
  OpencodeEvent,
  ReloadReason,
  ReloadTrigger,
} from "~/shared/types/opencode-connection";
import {
  addOpencodeCacheHint,
  normalizeDirectoryQueryPath,
  normalizeEvent,
  safeStringify,
} from "~/shared/util/format";
import {
  modelFromUserMessage,
  normalizeSessionStatus,
} from "~/shared/util/session-collections";
import { normalizeDirectoryPath } from "~/shared/platform/directory-path";
import { stripModelPrefix } from "~/shared/util/model-ref";
import { uiLogInfo, uiLogWarn } from "~/shared/platform/log/log";
import { unwrap } from "~/shared/platform/transport/opencode";
import { finishPerf, perfNow, recordPerfLog } from "~/shared/platform/log/perf-log";
import {
  createPendingUserMessage,
  shouldReconcilePendingUserMessage,
} from "~/shared/util/pending-user-message";
import {
  SYNTHETIC_SESSION_CLASSIFIER_MESSAGE_PREFIX,
  SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX,
} from "~/shared/types/session";
import {
  appendPartDelta,
  createPlaceholderMessage,
  mergeStreamingMessageSnapshot,
  removeMessageInfo,
  removePartInfo,
  removeSession,
  shouldPreserveStreamingCache,
  sortById,
  sortSessionsByActivity,
  upsertMessageInfo,
  upsertPartInfo,
  upsertSession,
} from "./session-store-collections";
import {
  blobUrlsForParts,
  isReconciledPendingPart,
  pendingAttachmentUrls,
  remapPendingPartsToMessage,
  revokePendingAttachmentUrls,
  shouldDropReconciledPendingPart,
} from "./session-pending-parts";
import {
  formatSessionError,
  invalidToolNextStepHint,
  isInvalidToolError,
  isPreventiveLocalCompaction,
  notConfiguredKind,
  truncateErrorField,
} from "./session-errors";
import { detectReloadFromPart, detectWrittenReloadTargets } from "./session-reload-detection";

// `session.streaming-snapshot.test.ts` covers the merge through this module.
export { mergeStreamingMessageSnapshot };

export type SessionModelState = {
  overrides: Record<string, ModelRef>;
  resolved: Record<string, ModelRef>;
};

export type SessionStore = ReturnType<typeof createSessionStore>;

type StoreState = {
  sessions: Session[];
  sessionInfoById: Record<string, Session>;
  sessionStatus: Record<string, string>;
  sessionErrorTurns: Record<string, SessionErrorTurn[]>;
  sessionClassifierTurns: Record<string, SessionClassifierTurn[]>;
  messages: Record<string, MessageInfo[]>;
  parts: Record<string, Part[]>;
  pendingUserMessages: Record<string, MessageWithParts | undefined>;
  todos: Record<string, TodoItem[]>;
  pendingPermissions: PendingPermission[];
  pendingQuestions: PendingQuestion[];
  events: OpencodeEvent[];
};

const normalizeMessageSnapshot = (list: MessageWithParts[]) => {
  let changed = false;
  const normalized = list.map((message) => {
    if (Array.isArray(message.parts)) return message;
    changed = true;
    return { ...message, parts: [] };
  });
  return changed ? normalized : list;
};
const SYNTHETIC_CONTINUE_CONTROL_PATTERN =
  /^\s*continue if you have next steps,\s*or stop and ask for clarification if you are unsure how to proceed\.?\s*$/i;
const COMPACTION_DIAGNOSTIC_WINDOW_MS = 60_000;
const COMPACTION_LOOP_WARN_THRESHOLD = 3;
const COMPACTION_LOOP_WARN_MIN_INTERVAL_MS = 10_000;
const INITIAL_SESSION_MESSAGE_LIMIT = 140;
const SESSION_MESSAGE_LOAD_CHUNK = 120;

export function createSessionStore(options: {
  client: () => Client | null;
  activeWorkspaceRoot: () => string;
  selectedSessionId: () => string | null;
  setSelectedSessionId: (id: string | null) => void;
  sessionModelState: () => SessionModelState;
  setSessionModelState: (updater: (current: SessionModelState) => SessionModelState) => SessionModelState;
  lastUserModelFromMessages: (messages: MessageWithParts[]) => ModelRef | null;
  /** A session's server messages were loaded on select (synthetic UI turns excluded). */
  onSessionMessagesLoaded?: (sessionID: string, messages: MessageWithParts[], session: { parentID?: string } | null) => void;
  developerMode: () => boolean;
  setError: (message: string | null) => void;
  setSseConnected: (connected: boolean) => void;
  markReloadRequired?: (reason: ReloadReason, trigger?: ReloadTrigger) => void;
  onHotReloadApplied?: () => void;
  /** Called once per skill or agent a tool call wrote, after the call has finished. */
  onReloadTargetWritten?: (trigger: ReloadTrigger) => void;
  /** Called when an automation session completes (goes idle) */
  onAutomationCompleted?: (sessionId: string, sessionTitle: string) => void;
  /** Called when a session is deleted (for cleanup like token cache) */
  onSessionDeleted?: (sessionId: string) => void;
}) {

  const sessionDebugEnabled = () => options.developerMode();

  const sessionDebug = (label: string, payload?: unknown) => {
    if (!sessionDebugEnabled()) return;
    try {
      if (payload === undefined) {
        console.log(`[WSDBG] ${label}`);
      } else {
        console.log(`[WSDBG] ${label}`, payload);
      }
    } catch {
      // ignore
    }
  };

  const sessionWarn = (label: string, payload?: unknown) => {
    if (!sessionDebugEnabled()) return;
    try {
      if (payload === undefined) {
        console.warn(`[WSWARN] ${label}`);
      } else {
        console.warn(`[WSWARN] ${label}`, payload);
      }
    } catch {
      // ignore
    }
  };
  const MAX_RELOAD_DETECTION_KEYS = 5000;

  const [store, setStore] = createStore<StoreState>({
    sessions: [],
    sessionInfoById: {},
    sessionStatus: {},
    sessionErrorTurns: {},
    sessionClassifierTurns: {},
    messages: {},
    parts: {},
    pendingUserMessages: {},
    todos: {},
    pendingPermissions: [],
    pendingQuestions: [],
    events: [],
  });
  const [permissionReplyBusy, setPermissionReplyBusy] = createSignal(false);
  const [messageLimitBySession, setMessageLimitBySession] = createSignal<Record<string, number>>({});
  const [messageCompleteBySession, setMessageCompleteBySession] = createSignal<Record<string, boolean>>({});
  const [messageLoadBusyBySession, setMessageLoadBusyBySession] = createSignal<Record<string, boolean>>({});
  const reloadDetectionSet = new Set<string>();
  const writtenReloadTargetSet = new Set<string>();
  const invalidToolDetectionSet = new Set<string>();
  const syntheticContinueEventTimesBySession = new Map<string, number[]>();
  const syntheticContinueLoopLastWarnAtBySession = new Map<string, number>();

  const maybeNotifyReloadTargetWritten = (part: Part, key: string) => {
    if (!options.onReloadTargetWritten || writtenReloadTargetSet.has(key)) return;
    const targets = detectWrittenReloadTargets(part);
    if (targets.length === 0) return;
    writtenReloadTargetSet.add(key);
    for (const trigger of targets) options.onReloadTargetWritten(trigger);
  };

  const maybeMarkReloadRequired = (part: Part) => {
    if (!options.markReloadRequired && !options.onReloadTargetWritten) return;
    if (!part?.id || !part.messageID) return;

    const root = normalizeDirectoryPath(options.activeWorkspaceRoot());
    if (root) {
      const session = sessionById(part.sessionID);
      const sessionRoot = normalizeDirectoryPath(session?.directory ?? "");
      if (!sessionRoot || sessionRoot !== root) {
        return;
      }
    }

    const key = `${part.messageID}:${part.id}`;
    maybeNotifyReloadTargetWritten(part, key);
    if (reloadDetectionSet.has(key)) return;
    const detection = detectReloadFromPart(part);
    if (!detection) return;
    reloadDetectionSet.add(key);
    options.markReloadRequired?.(detection.reason, detection.trigger);
  };

  const maybeHandleInvalidToolError = (part: Part) => {
    if (!options.setError) return;
    if (!isInvalidToolError(part)) return;
    if (!part?.id || !part.messageID) return;

    const key = `${part.messageID}:${part.id}`;
    if (invalidToolDetectionSet.has(key)) return;
    invalidToolDetectionSet.add(key);

    // Ensure the UI doesn't get stuck in a "Responding" state when the model
    // tries to call a tool that isn't available.
    if (part.sessionID) {
      setStore("sessionStatus", part.sessionID, "idle");
    }

    const record = part as any;
    const tool = typeof record.tool === "string" && record.tool.trim() ? record.tool.trim() : "(unknown tool)";

    // Ignore OpenCode's internal "invalid" sentinel for malformed tool-call JSON to avoid showing an unactionable backend parsing error in the OpenWork UI.
    if (tool.toLowerCase() === "invalid") return;

    const hint = invalidToolNextStepHint();
    options.setError(`Invalid tool call: ${tool}.\n\n${hint}`);
  };

  const isSyntheticContinueControlPart = (part: Part) => {
    if (part.type !== "text") return false;
    const record = part as Part & { text?: unknown; synthetic?: unknown; ignored?: unknown };
    if (record.synthetic !== true) return false;
    if (record.ignored === true) return false;
    const text = typeof record.text === "string" ? record.text.trim() : "";
    if (!text) return false;
    return SYNTHETIC_CONTINUE_CONTROL_PATTERN.test(text);
  };

  const recordSyntheticContinueDiagnostic = (part: Part) => {
    if (!isSyntheticContinueControlPart(part)) return;
    const sessionID = part.sessionID;
    const now = Date.now();
    const windowStart = now - COMPACTION_DIAGNOSTIC_WINDOW_MS;
    const previous = syntheticContinueEventTimesBySession.get(sessionID) ?? [];
    const next = previous.filter((timestamp) => timestamp >= windowStart);
    next.push(now);
    syntheticContinueEventTimesBySession.set(sessionID, next);

    const countInWindow = next.length;
    recordPerfLog(sessionDebugEnabled(), "session.compaction", "synthetic-continue", {
      sessionID,
      messageID: part.messageID,
      partID: part.id,
      countPerMinute: countInWindow,
      windowMs: COMPACTION_DIAGNOSTIC_WINDOW_MS,
    });

    if (countInWindow < COMPACTION_LOOP_WARN_THRESHOLD) return;

    const lastWarnAt = syntheticContinueLoopLastWarnAtBySession.get(sessionID) ?? 0;
    if (now - lastWarnAt < COMPACTION_LOOP_WARN_MIN_INTERVAL_MS) return;
    syntheticContinueLoopLastWarnAtBySession.set(sessionID, now);
    sessionWarn("compaction:synthetic-continue-loop", {
      sessionID,
      countPerMinute: countInWindow,
    });
    recordPerfLog(sessionDebugEnabled(), "session.compaction", "synthetic-continue-loop-suspected", {
      sessionID,
      countPerMinute: countInWindow,
      threshold: COMPACTION_LOOP_WARN_THRESHOLD,
      windowMs: COMPACTION_DIAGNOSTIC_WINDOW_MS,
    });
  };

  const addError = (error: unknown, fallback = "Unknown error") => {
    const message = error instanceof Error ? error.message : fallback;
    if (!message) return;
    options.setError(addOpencodeCacheHint(message));
  };

  const appendSessionErrorTurn = (
    sessionID: string,
    message: string | null,
    afterMessageIDOverride?: string,
    kind?: SessionErrorTurn["kind"],
  ) => {
    const text = message?.trim() ?? "";
    if (!sessionID || !text) return false;

    const list = store.messages[sessionID] ?? [];
    const pendingMessage = store.pendingUserMessages[sessionID]?.info;
    const lastMessage =
      pendingMessage ?? (list.length > 0 ? list[list.length - 1] : null);
    const afterMessageID = afterMessageIDOverride ?? lastMessage?.id ?? null;
    let added = false;

    setStore("sessionErrorTurns", sessionID, (current) => {
      const existing = current ?? [];
      // Same text against the same anchor is one failure delivered more than
      // once (a session.error event plus the assistant message that carries the
      // same error, or a message reload), not a repeated failure. A genuine
      // repeat lands after a newer message, so it gets a different anchor.
      if (
        existing.some(
          (turn) => turn.text === text && turn.afterMessageID === afterMessageID,
        )
      ) {
        return existing;
      }

      added = true;
      return existing.concat({
        id: `${SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX}${sessionID}:${Date.now()}:${existing.length}`,
        text,
        kind,
        afterMessageID,
        sourceMessageID: afterMessageIDOverride ?? afterMessageID,
        time: Date.now(),
      });
    });
    return added;
  };

  const appendSessionClassifierTurn = (
    sessionID: string,
    message: string | null,
    kind: SessionClassifierTurn["kind"] = "generic",
    afterMessageIDOverride?: string | null,
  ) => {
    const text = message?.trim() ?? "";
    if (!sessionID || !text) return;

    const list = store.messages[sessionID] ?? [];
    const lastMessage = list.length > 0 ? list[list.length - 1] : null;
    const afterMessageID = afterMessageIDOverride !== undefined ? afterMessageIDOverride : (lastMessage?.id ?? null);

    setStore("sessionClassifierTurns", sessionID, (current) => {
      const existing = current ?? [];
      return existing.concat({
        id: `${SYNTHETIC_SESSION_CLASSIFIER_MESSAGE_PREFIX}${kind}:${sessionID}:${Date.now()}:${existing.length}`,
        text,
        kind,
        afterMessageID,
        time: Date.now(),
      });
    });
  };

  // Remove synthetic classifier turns linked to a specific message.
  // Used when that message is edited or removed so stale classifier output does not remain in the transcript.
  const removeSessionClassifierTurnsByAfterMessageID = (sessionID: string, afterMessageID: string) => {
    if (!sessionID || !afterMessageID) return;
    const existing = store.sessionClassifierTurns[sessionID];
    if (!existing?.length) return;
    setStore("sessionClassifierTurns", sessionID, (current) => {
      const safe = current ?? [];
      const filtered = safe.filter((turn) => turn.afterMessageID !== afterMessageID);
      return filtered.length === safe.length ? safe : filtered;
    });
  };

  // Synthetic error turns are append-only, so they must be pruned when their
  // source message leaves the authoritative transcript — otherwise a Revert,
  // message deletion, or backend refresh that drops the failed message leaves a
  // stale error (and its "Go to Settings" CTA) stranded at the end. A turn is
  // dropped only when its `sourceMessageID` is no longer in the message
  // snapshot at all. A source hidden behind the session's revert boundary is
  // NOT pruned here — Redo only moves the boundary back without reloading
  // messages, so a store-level delete would be permanent and the turn could
  // never reappear; that visibility is instead handled at render time (see
  // `insertSyntheticSessionErrors` in app.tsx). Turns with no source message
  // are session-level and only cleared on session deletion.
  const reconcileSessionErrorTurns = (sessionID: string) => {
    if (!sessionID) return;
    const turns = store.sessionErrorTurns[sessionID];
    if (!turns?.length) return;
    const liveMessageIDs = new Set(
      (store.messages[sessionID] ?? []).map((message) => message.id),
    );
    const pendingID = store.pendingUserMessages[sessionID]?.info.id;
    if (pendingID) liveMessageIDs.add(pendingID);
    setStore("sessionErrorTurns", sessionID, (current) => {
      const safe = current ?? [];
      const filtered = safe.filter((turn) => {
        const source = turn.sourceMessageID ?? null;
        if (source === null) return true;
        return liveMessageIDs.has(source);
      });
      return filtered.length === safe.length ? safe : filtered;
    });
  };

  // A pending-user placeholder id (e.g. "pending-user:<submissionID>") is
  // ephemeral: it disappears the moment the real message it stands in for arrives.
  // Called at every site that clears `pendingUserMessages` for a reconciled placeholder.
  // Retargets both id fields together: appendSessionErrorTurn always creates them
  // equal, and afterMessageID (not sourceMessageID) is what insertSyntheticSessionErrors
  // uses to place the turn — left on the dead placeholder id it would never match a
  // real message and the turn would render pinned to the end of the transcript.
  const retargetSessionErrorTurnsSourceMessageID = (
    sessionID: string,
    oldMessageID: string,
    newMessageID: string,
  ) => {
    if (!sessionID || !oldMessageID || oldMessageID === newMessageID) return;
    const existing = store.sessionErrorTurns[sessionID];
    if (!existing?.length) return;
    setStore("sessionErrorTurns", sessionID, (current) => {
      const safe = current ?? [];
      let changed = false;
      const next = safe.map((turn) => {
        if (turn.sourceMessageID !== oldMessageID) return turn;
        changed = true;
        return {
          ...turn,
          sourceMessageID: newMessageID,
          afterMessageID:
            turn.afterMessageID === oldMessageID ? newMessageID : turn.afterMessageID,
        };
      });
      return changed ? next : safe;
    });
  };

  // opencode records a failed turn on the assistant message itself
  // (`AssistantMessage.error`) as well as publishing `session.error`. We used to
  // read only the event, so any failure that arrived without one — an upstream
  // provider 502, for example — left an empty assistant turn and no explanation.
  // Reading the message covers the event being absent, and covers reopening a
  // session later, since events are not replayed.
  const surfaceAssistantMessageError = (info: MessageInfo) => {
    if (info.role !== "assistant") return;
    const errorObj = (info as { error?: unknown }).error;
    if (!errorObj || typeof errorObj !== "object") return;
    const record = errorObj as Record<string, unknown>;
    if (isPreventiveLocalCompaction(record)) return;
    if (record.name === "MessageAbortedError") return;
    const addedErrorTurn = appendSessionErrorTurn(
      info.sessionID,
      addOpencodeCacheHint(formatSessionError(record)),
      info.id,
      notConfiguredKind(record),
    );
    // Mirror the session.error path: a failed turn with a persisted message error
    // must not leave the run indicator spinning when status events were missed.
    if (addedErrorTurn) {
      setStore("sessionStatus", info.sessionID, "idle");
    }
  };

  const withTimeout = async <T,>(promise: Promise<T>, ms: number, label: string) => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), ms);
    });
    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  };

  let selectRunCounter = 0;
  let selectVersion = 0;
  const selectInFlightBySession = new Map<string, Promise<void>>();
  const ensureInFlightBySession = new Map<string, Promise<void>>();

  const rememberSession = (session: Session) => {
    setStore("sessionInfoById", session.id, {
      ...session,
      title: session.title ? stripModelPrefix(session.title) : session.title,
    });
  };

  const rememberSessions = (list: Session[]) => {
    if (!list.length) return;
    batch(() => {
      list.forEach((session) => {
        setStore("sessionInfoById", session.id, {
          ...session,
          title: session.title ? stripModelPrefix(session.title) : session.title,
        });
      });
    });
  };

  const sessionById = (id: string | null) => {
    if (!id) return null;
    return store.sessionInfoById[id] ?? store.sessions.find((session) => session.id === id) ?? null;
  };

  const messagesBySessionId = (id: string | null): MessageWithParts[] => {
    if (!id) return [];
    const list = store.messages[id] ?? [];
    const messages = list.map((info) => ({
      info,
      parts: store.parts[info.id] ?? [],
    }));
    const pending = store.pendingUserMessages[id];
    return pending ? messages.concat(pending) : messages;
  };

  const appendPendingUserMessage = (input: {
    sessionID: string;
    submissionID: string;
    text: string;
    createdAt: number;
    attachments?: Array<{ url: string; mime: string; filename: string }>;
  }): MessageWithParts => {
    const list = store.messages[input.sessionID] ?? [];
    const lastMessage = list.length > 0 ? list[list.length - 1] : null;
    const pending = createPendingUserMessage({
      ...input,
      afterMessageID: lastMessage?.id ?? null,
    });
    const previousUrls = pendingAttachmentUrls(
      store.pendingUserMessages[input.sessionID],
    );
    setStore("pendingUserMessages", input.sessionID, pending);
    revokePendingAttachmentUrls(previousUrls);
    return pending;
  };

  const takePendingUserMessage = (
    sessionID: string,
  ): MessageWithParts | null => {
    const pending = store.pendingUserMessages[sessionID] ?? null;
    if (pending) {
      const pendingUrls = pendingAttachmentUrls(pending);
      setStore("pendingUserMessages", sessionID, undefined);
      revokePendingAttachmentUrls(pendingUrls);
    }
    return pending;
  };

  const clearPendingUserMessage = (
    sessionID: string,
    expectedMessageID?: string,
  ): void => {
    const pending = store.pendingUserMessages[sessionID];
    if (!pending) return;
    if (expectedMessageID && pending.info.id !== expectedMessageID) return;
    const pendingUrls = pendingAttachmentUrls(pending);
    setStore("pendingUserMessages", sessionID, undefined);
    revokePendingAttachmentUrls(pendingUrls);
  };

  const sessions = () => store.sessions;
  const sessionStatusById = () => store.sessionStatus;
  const pendingPermissions = () => store.pendingPermissions;
  const pendingQuestions = () => store.pendingQuestions;
  const events = () => store.events;

  async function refreshSessionStatus(scopeRoot?: string) {
    const c = options.client();
    if (!c) return;
    try {
      const queryDirectory = normalizeDirectoryQueryPath(scopeRoot ?? options.activeWorkspaceRoot()) || undefined;
      const statuses = unwrap(await withTimeout(c.session.status({ directory: queryDirectory }), 8000, "session.status"));
      const normalized: Record<string, string> = {};
      for (const [sessionID, status] of Object.entries(statuses)) {
        normalized[sessionID] = normalizeSessionStatus(status);
      }
      setStore("sessionStatus", normalized);
    } catch (error) {
      sessionWarn("session.status.failed", {
        error: error instanceof Error ? error.message : safeStringify(error),
      });
    }
  }

  const selectedSession = createMemo(() => {
    return sessionById(options.selectedSessionId());
  });

  const selectedSessionStatus = createMemo(() => {
    const id = options.selectedSessionId();
    if (!id) return "idle";
    return store.sessionStatus[id] ?? "idle";
  });

  const messages = createMemo<MessageWithParts[]>(() => {
    return messagesBySessionId(options.selectedSessionId());
  });

  const todos = createMemo<TodoItem[]>(() => {
    const id = options.selectedSessionId();
    if (!id) return [];
    return store.todos[id] ?? [];
  });

  const selectedSessionHasEarlierMessages = createMemo(() => {
    const id = options.selectedSessionId();
    if (!id) return false;
    return !messageCompleteBySession()[id];
  });

  const selectedSessionLoadingEarlierMessages = createMemo(() => {
    const id = options.selectedSessionId();
    if (!id) return false;
    return Boolean(messageLoadBusyBySession()[id]);
  });

  async function loadSessions(scopeRoot?: string) {
    const c = options.client();
    if (!c) return;

    // IMPORTANT: OpenCode's session.list() supports server-side filtering by directory.
    // Use it to avoid fetching every session across every workspace root.
    //
    // Note: We intentionally normalize slashes + trailing separators but do NOT
    // lowercase on Windows for the query value because the server does strict
    // string equality against the stored session.directory.
    const queryDirectory = normalizeDirectoryQueryPath(scopeRoot) || undefined;

    const start = Date.now();
    sessionDebug("sessions:load:start", { scopeRoot: scopeRoot ?? null, queryDirectory: queryDirectory ?? null });
    const list = unwrap(await c.session.list({ directory: queryDirectory, roots: true }));
    sessionDebug("sessions:load:raw", { count: list.length, ms: Date.now() - start });

    // Defensive client-side filter in case the server returns sessions spanning
    // multiple roots (e.g. older servers or proxies).
    const root = normalizeDirectoryPath(scopeRoot);
    const filtered = root
      ? list.filter((session) => normalizeDirectoryPath(session.directory) === root)
      : list;
    sessionDebug("sessions:load:filtered", { root: root || null, count: filtered.length });
    rememberSessions(filtered);
    setStore("sessions", reconcile(sortSessionsByActivity(filtered), { key: "id" }));
    void refreshSessionStatus(scopeRoot);
  }

  async function renameSession(sessionID: string, title: string) {
    const c = options.client();
    if (!c) return;
    const trimmed = title.trim();
    if (!trimmed) {
      throw new Error("Session name is required");
    }
    const next = unwrap(await c.session.update({ sessionID, title: trimmed }));
    rememberSession(next);
    setStore("sessions", (current) => {
      const tracked = current.some((session) => session.id === next.id);
      if (next.parentID && !tracked) return current;
      return upsertSession(current, next);
    });
  }

  async function refreshPendingPermissions() {
    const c = options.client();
    if (!c) return;
    const list = unwrap(await c.permission.list());
    const now = Date.now();
    const byId = new Map(store.pendingPermissions.map((perm) => [perm.id, perm] as const));
    const next = list.map((perm) => ({ ...perm, receivedAt: byId.get(perm.id)?.receivedAt ?? now }));
    setStore("pendingPermissions", next);
  }

  async function refreshPendingQuestions() {
    const c = options.client();
    if (!c) return;
    const list = unwrap(await c.question.list());
    const now = Date.now();
    const byId = new Map(store.pendingQuestions.map((q) => [q.id, q] as const));
    const next = list.map((q) => ({ ...q, receivedAt: byId.get(q.id)?.receivedAt ?? now }));
    setStore("pendingQuestions", next);
  }

  function setMessagesForSession(
    sessionID: string,
    list: MessageWithParts[],
    options?: { preserveStreamingCache?: boolean },
  ) {
    const normalizedList = normalizeMessageSnapshot(list);
    const nextList = options?.preserveStreamingCache
      ? mergeStreamingMessageSnapshot(
          normalizedList,
          store.messages[sessionID] ?? [],
          store.parts,
        )
      : normalizedList;
    const infos = nextList
      .map((msg) => msg.info)
      .filter((info) => !!info?.id)
      .map((info) => info as MessageInfo);
    const pending = store.pendingUserMessages[sessionID];
    const knownMessageIDs = new Set(
      (store.messages[sessionID] ?? []).map((message) => message.id),
    );
    // The specific real message that stands in for the pending placeholder, if
    // any — needed (not just a boolean) to retarget error turns anchored to it.
    const reconcilingMessage = pending
      ? infos.find((info) =>
          shouldReconcilePendingUserMessage(
            pending,
            info as Message,
            knownMessageIDs,
          ),
        )
      : undefined;
    const reconcilesPending = Boolean(reconcilingMessage);
    const reconcilingMessageParts = reconcilingMessage
      ? (nextList.find((message) => message.info.id === reconcilingMessage.id)?.parts ?? [])
      : [];
    const shouldSeedPendingParts = Boolean(
      pending &&
        reconcilingMessage &&
        !reconcilingMessageParts.some(
          (part) => !isReconciledPendingPart(part),
        ),
    );
    const pendingUrls = reconcilesPending && !shouldSeedPendingParts
      ? pendingAttachmentUrls(pending)
      : [];
    const seededUrlsToRevoke: string[] = [];

    batch(() => {
      if (reconcilesPending) {
        setStore("pendingUserMessages", sessionID, undefined);
      }
      setStore("messages", sessionID, reconcile(sortById(infos), { key: "id" }));
      for (const message of nextList) {
        const messageParts = message.parts.filter((part) => !!part?.id);
        const existingParts = store.parts[message.info.id] ?? [];
        const authoritativeParts = messageParts.filter(
          (part) => !isReconciledPendingPart(part),
        );
        const parts = messageParts.filter(
          (part) =>
            !isReconciledPendingPart(part) ||
            !authoritativeParts.some((realPart) =>
              shouldDropReconciledPendingPart(part, realPart),
            ),
        );
        const retainedPartIds = new Set(parts.map((part) => part.id));
        seededUrlsToRevoke.push(
          ...blobUrlsForParts([
            ...existingParts.filter(
              (part) =>
                isReconciledPendingPart(part) &&
                !retainedPartIds.has(part.id),
            ),
            ...messageParts.filter(
              (part) =>
                isReconciledPendingPart(part) &&
                !retainedPartIds.has(part.id),
            ),
          ]),
        );
        const nextParts = shouldSeedPendingParts && message.info.id === reconcilingMessage?.id && pending
          ? remapPendingPartsToMessage(pending, message.info.id)
          : parts;
        setStore("parts", message.info.id, reconcile(sortById(nextParts), { key: "id" }));
      }
    });
    revokePendingAttachmentUrls(seededUrlsToRevoke);
    if (reconcilesPending) {
      revokePendingAttachmentUrls(pendingUrls);
    }

    if (pending && reconcilingMessage) {
      retargetSessionErrorTurnsSourceMessageID(sessionID, pending.info.id, reconcilingMessage.id);
    }

    for (const info of infos) {
      surfaceAssistantMessageError(info);
    }

    // Prune error turns whose source message the new snapshot no longer carries
    // at all (backend refresh). Runs after surfacing so a turn for a message
    // still present in the snapshot is kept.
    reconcileSessionErrorTurns(sessionID);
  }

  function hasRunningHybridDrTool(sessionID: string) {
    const messages = store.messages[sessionID] ?? [];
    for (const message of messages) {
      const parts = store.parts[message.id] ?? [];
      for (const part of parts) {
        if (part.type !== "tool") continue;
        const record = part as Part & { tool?: unknown; state?: Record<string, unknown> };
        if (record.tool !== "hybrid_dr_post_polish_processor") continue;
        const status = typeof record.state?.status === "string" ? record.state.status : "";
        if (status === "running" || status === "pending") return true;
        const output = typeof record.state?.output === "string" ? record.state.output.trim() : "";
        if (output) {
          try {
            const parsed = JSON.parse(output) as { status?: unknown };
            if (parsed.status === "running") return true;
          } catch {
            // Non-JSON output is not a resumable HDR status envelope.
          }
        }
      }
    }
    return false;
  }

  createEffect(() => {
    const sessionID = options.selectedSessionId();
    if (!sessionID || !hasRunningHybridDrTool(sessionID)) return;
    let busy = false;
    const refresh = async () => {
      if (busy) return;
      const c = options.client();
      if (!c || options.selectedSessionId() !== sessionID) return;
      busy = true;
      try {
        const limit = Math.max(INITIAL_SESSION_MESSAGE_LIMIT, messageLimitBySession()[sessionID] ?? 0);
        const msgs = unwrap(await withTimeout(c.session.messages({ sessionID, limit }), 12000, "session.messages"));
        if (options.selectedSessionId() === sessionID) {
          setMessagesForSession(sessionID, msgs, {
            preserveStreamingCache: shouldPreserveStreamingCache(store.sessionStatus[sessionID]),
          });
        }
      } catch (error) {
        sessionWarn("hybrid-dr.progress-refresh.failed", {
          sessionID,
          error: error instanceof Error ? error.message : safeStringify(error),
        });
      } finally {
        busy = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 2000);
    onCleanup(() => window.clearInterval(timer));
  });

  // A session opened from search can be older than the loaded list; the session
  // route and the sidebar only know about sessions in that list.
  const trackRootSession = (session: Session) => {
    if (session.parentID || store.sessions.some((item) => item.id === session.id)) return;
    setStore("sessions", (current) => upsertSession(current, session));
  };

  async function ensureSessionLoaded(sessionID: string) {
    const id = sessionID.trim();
    if (!id) return;
    const known = sessionById(id);
    if (known && (store.messages[id]?.length ?? 0) > 0) {
      trackRootSession(known);
      return;
    }

    const existing = ensureInFlightBySession.get(id);
    if (existing) return existing;

    const c = options.client();
    if (!c) return;

    const run = (async () => {
      setMessageLoadBusyBySession((prev) => ({ ...prev, [id]: true }));
      try {
        const [info, msgs] = await Promise.all([
          withTimeout(c.session.get({ sessionID: id }), 8000, "session.get"),
          withTimeout(c.session.messages({ sessionID: id, limit: INITIAL_SESSION_MESSAGE_LIMIT }), 12000, "session.messages"),
        ]);
        const nextSession = unwrap(info);
        const nextMessages = unwrap(msgs);
        rememberSession(nextSession);
        trackRootSession(nextSession);
        setMessagesForSession(id, nextMessages);
        setMessageLimitBySession((prev) => ({ ...prev, [id]: INITIAL_SESSION_MESSAGE_LIMIT }));
        setMessageCompleteBySession((prev) => ({ ...prev, [id]: nextMessages.length < INITIAL_SESSION_MESSAGE_LIMIT }));
        void refreshSessionStatus(nextSession.directory);
      } catch (error) {
        sessionWarn("session.ensure.failed", {
          sessionID: id,
          error: error instanceof Error ? error.message : safeStringify(error),
        });
      } finally {
        setMessageLoadBusyBySession((prev) => ({ ...prev, [id]: false }));
      }
    })();

    ensureInFlightBySession.set(id, run);
    try {
      await run;
    } finally {
      if (ensureInFlightBySession.get(id) === run) {
        ensureInFlightBySession.delete(id);
      }
    }
  }

  async function selectSession(sessionID: string) {
    const c = options.client();
    if (!c) return;

    const perfEnabled = options.developerMode();
    options.setSelectedSessionId(sessionID);
    options.setError(null);
    setMessageLoadBusyBySession((prev) => ({ ...prev, [sessionID]: true }));

    const existing = selectInFlightBySession.get(sessionID);
    if (existing) {
      recordPerfLog(perfEnabled, "session.select", "dedupe join", {
        sessionID,
      });
      return existing;
    }

    const runId = ++selectRunCounter;
    const version = ++selectVersion;
    const startedAt = perfNow();
    const mark = (event: string, payload?: Record<string, unknown>) => {
      const elapsedMs = Math.round((perfNow() - startedAt) * 100) / 100;
      recordPerfLog(perfEnabled, "session.select", event, {
        runId,
        sessionID,
        elapsedMs,
        ...(payload ?? {}),
      });
    };
    const isStale = () => version !== selectVersion || options.selectedSessionId() !== sessionID;
    const abortIfStale = (reason: string) => {
      if (!isStale()) return false;
      mark(`aborting: ${reason}`);
      return true;
    };

    const run = (async () => {
      mark("start");

      mark("checking health");
      try {
        await withTimeout(c.global.health(), 3000, "health");
        mark("health ok");
      } catch (error) {
        mark("health FAILED", {
          error: error instanceof Error ? error.message : safeStringify(error),
        });
        throw new Error("Server connection lost. Please reload.");
      }
      if (abortIfStale("selection changed after health")) return;

      const existingLimit = messageLimitBySession()[sessionID] ?? 0;
      const requestLimit = Math.max(INITIAL_SESSION_MESSAGE_LIMIT, existingLimit);
      mark("calling session.messages", { limit: requestLimit });
      const msgs = unwrap(
        await withTimeout(c.session.messages({ sessionID, limit: requestLimit }), 12000, "session.messages"),
      );
      mark("session.messages done", { limit: requestLimit, count: msgs.length });
      setMessageLoadBusyBySession((prev) => ({ ...prev, [sessionID]: false }));
      if (abortIfStale("selection changed before messages applied")) return;
      setMessagesForSession(sessionID, msgs, {
        preserveStreamingCache: shouldPreserveStreamingCache(store.sessionStatus[sessionID]),
      });
      setMessageLimitBySession((prev) => ({ ...prev, [sessionID]: requestLimit }));
      setMessageCompleteBySession((prev) => ({ ...prev, [sessionID]: msgs.length < requestLimit }));
      void refreshSessionStatus(options.activeWorkspaceRoot());
      options.onSessionMessagesLoaded?.(sessionID, msgs, sessionById(sessionID));

      const model = options.lastUserModelFromMessages(msgs);
      if (model) {
        if (abortIfStale("selection changed before model applied")) return;
        // Only apply the model from messages if the user has not already made an
        // explicit selection for this session (e.g. via the model picker or a
        // prompt). This prevents the backend's actual model (which may differ due
        // to agent model pinning) from overwriting the user's chosen model in the UI.
        options.setSessionModelState((current) => {
          if (current.resolved[sessionID]) return current;
          return { ...current, resolved: { ...current.resolved, [sessionID]: model } };
        });

        options.setSessionModelState((current) => {
          if (!current.overrides[sessionID]) return current;
          const copy = { ...current.overrides };
          delete copy[sessionID];
          return { ...current, overrides: copy };
        });
      }

      try {
        mark("calling session.todo");
        const list = unwrap(await withTimeout(c.session.todo({ sessionID }), 8000, "session.todo"));
        mark("session.todo done");
        if (abortIfStale("selection changed before todos applied")) return;
        setStore("todos", sessionID, list);
      } catch (error) {
        mark("session.todo failed/timeout", {
          error: error instanceof Error ? error.message : safeStringify(error),
        });
        if (abortIfStale("selection changed before todo fallback")) return;
        setStore("todos", sessionID, []);
      }

      try {
        mark("calling permission.list");
        await withTimeout(refreshPendingPermissions(), 6000, "permission.list");
        mark("permission.list done");
        if (abortIfStale("selection changed before permissions applied")) return;
      } catch (error) {
        mark("permission.list failed/timeout", {
          error: error instanceof Error ? error.message : safeStringify(error),
        });
        if (abortIfStale("selection changed after permission failure")) return;
      }

      finishPerf(perfEnabled, "session.select", "complete", startedAt, {
        runId,
        sessionID,
        messageCount: msgs.length,
        todoCount: (store.todos[sessionID] ?? []).length,
      });
      setMessageLoadBusyBySession((prev) => ({ ...prev, [sessionID]: false }));
    })();

    selectInFlightBySession.set(sessionID, run);
    try {
      await run;
    } finally {
      setMessageLoadBusyBySession((prev) => ({ ...prev, [sessionID]: false }));
      if (selectInFlightBySession.get(sessionID) === run) {
        selectInFlightBySession.delete(sessionID);
      }
    }
  }

  async function loadEarlierMessages(sessionID: string, chunk = SESSION_MESSAGE_LOAD_CHUNK) {
    const c = options.client();
    if (!c) return;
    if (!sessionID) return;
    if (messageLoadBusyBySession()[sessionID]) return;
    if (messageCompleteBySession()[sessionID]) return;

    const currentLimit = Math.max(INITIAL_SESSION_MESSAGE_LIMIT, messageLimitBySession()[sessionID] ?? 0);
    const nextLimit = currentLimit + Math.max(1, chunk);

    setMessageLoadBusyBySession((prev) => ({ ...prev, [sessionID]: true }));
    try {
      const msgs = unwrap(await withTimeout(c.session.messages({ sessionID, limit: nextLimit }), 12000, "session.messages"));
      setMessagesForSession(sessionID, msgs, {
        preserveStreamingCache: shouldPreserveStreamingCache(store.sessionStatus[sessionID]),
      });
      setMessageLimitBySession((prev) => ({ ...prev, [sessionID]: nextLimit }));
      setMessageCompleteBySession((prev) => ({ ...prev, [sessionID]: msgs.length < nextLimit }));
    } catch (error) {
      addError(error);
    } finally {
      setMessageLoadBusyBySession((prev) => ({ ...prev, [sessionID]: false }));
    }
  }

  async function respondPermission(requestID: string, reply: "once" | "always" | "reject") {
    const c = options.client();
    if (!c || permissionReplyBusy()) return;

    setPermissionReplyBusy(true);
    options.setError(null);

    try {
      unwrap(await c.permission.reply({ requestID, reply }));
      await refreshPendingPermissions();
    } catch (e) {
      addError(e);
    } finally {
      setPermissionReplyBusy(false);
    }
  }

  async function respondQuestion(requestID: string, answers: string[][]) {
    const c = options.client();
    if (!c || questionReplyBusy()) return;

    setQuestionReplyBusy(true);
    options.setError(null);

    try {
      unwrap(await c.question.reply({ requestID, answers }));
      await refreshPendingQuestions();
    } catch (e) {
      addError(e);
    } finally {
      setQuestionReplyBusy(false);
    }
  }

  async function rejectQuestion(requestID: string) {
    const c = options.client();
    if (!c || questionReplyBusy()) return;

    setQuestionReplyBusy(true);
    options.setError(null);

    try {
      unwrap(await c.question.reject({ requestID }));
      await refreshPendingQuestions();
    } catch (e) {
      addError(e);
    } finally {
      setQuestionReplyBusy(false);
    }
  }

  const setSessions = (next: Session[]) => {
    rememberSessions(next);
    setStore("sessions", reconcile(sortSessionsByActivity(next), { key: "id" }));
  };

  const setSessionStatusById = (next: Record<string, string>) => {
    setStore("sessionStatus", next);
  };

  const setMessages = (next: MessageWithParts[]) => {
    const id = options.selectedSessionId();
    if (!id) return;
    setMessagesForSession(id, next);
  };

  const setTodos = (next: TodoItem[]) => {
    const id = options.selectedSessionId();
    if (!id) return;
    setStore("todos", id, next);
  };

  const setPendingPermissions = (next: PendingPermission[]) => {
    setStore("pendingPermissions", next);
  };

  const setPendingQuestions = (next: PendingQuestion[]) => {
    setStore("pendingQuestions", next);
  };

  // The masking review is raised by the protected-file subagent, whose session the user is not
  // viewing; surface it on the parent session the user is actually in.
  // Build can itself delegate to the protected-file agent, so the chain is followed to the root.
  const [reviewParents, setReviewParents] = createSignal<Record<string, string | null>>({});
  const reviewAncestors = (sessionID: string): Set<string> => {
    const parents = reviewParents();
    const chain = new Set<string>();
    let current = parents[sessionID];
    while (current && !chain.has(current)) {
      chain.add(current);
      current = parents[current];
    }
    return chain;
  };
  const resolveParent = (c: NonNullable<ReturnType<typeof options.client>>, sessionID: string) => {
    if (sessionID in untrack(reviewParents)) return;
    setReviewParents((prev) => ({ ...prev, [sessionID]: null }));
    void c.session
      .get({ sessionID })
      .then((res) => {
        const parentID = unwrap(res).parentID ?? null;
        setReviewParents((prev) => ({ ...prev, [sessionID]: parentID }));
      })
      .catch(() => undefined);
  };
  createEffect(() => {
    const c = options.client();
    if (!c) return;
    const sessionIDs = [
      ...store.pendingPermissions.filter((perm) => perm.permission === "review_masked_entities").map((perm) => perm.sessionID),
      ...store.pendingQuestions.map((q) => q.sessionID),
    ];
    for (const sessionID of sessionIDs) {
      resolveParent(c, sessionID);
      // Each resolved parent triggers this effect again, walking one level up per pass.
      let current = reviewParents()[sessionID];
      while (current) {
        resolveParent(c, current);
        current = reviewParents()[current];
      }
    }
  });

  const activePermission = createMemo(() => {
    const id = options.selectedSessionId();
    if (!id) return null;
    const pending = store.pendingPermissions;
    return (
      pending.find(
        (perm) =>
          perm.sessionID === id ||
          (perm.permission === "review_masked_entities" && reviewAncestors(perm.sessionID).has(id)),
      ) ?? null
    );
  });

  const activeQuestion = createMemo(() => {
    const id = options.selectedSessionId();
    if (!id) return null;
    const pending = store.pendingQuestions;
    // A subagent's question is shown in the session the user is in, like the masking review.
    return (
      pending.find((q) => q.sessionID === id) ??
      pending.find((q) => reviewAncestors(q.sessionID).has(id)) ??
      null
    );
  });

  const [questionReplyBusy, setQuestionReplyBusy] = createSignal(false);
  let lastPartDebugEventAt = 0;
  let suppressedPartDebugEvents = 0;

  const appendDebugEvent = (event: { type: string; properties?: unknown }) => {
    setStore("events", (current) => {
      const next = [event, ...current];
      return next.slice(0, 150);
    });
  };

  const compactDebugEvent = (event: OpencodeEvent) => {
    if (event.type === "message.part.updated") {
      const record = event.properties as Record<string, unknown> | undefined;
      const part = record?.part as Part | undefined;
      const delta = typeof record?.delta === "string" ? record.delta : "";
      const textLength =
        part?.type === "text" && typeof (part as { text?: unknown }).text === "string"
          ? String((part as { text?: string }).text).length
          : null;
      return {
        type: event.type,
        properties: {
          sessionID: part?.sessionID ?? null,
          messageID: part?.messageID ?? null,
          partID: part?.id ?? null,
          partType: part?.type ?? null,
          deltaLength: delta.length,
          textLength,
        },
      };
    }

    if (event.type === "message.part.delta") {
      const record = event.properties as Record<string, unknown> | undefined;
      const delta = typeof record?.delta === "string" ? record.delta : "";
      return {
        type: event.type,
        properties: {
          sessionID: typeof record?.sessionID === "string" ? record.sessionID : null,
          messageID: typeof record?.messageID === "string" ? record.messageID : null,
          partID: typeof record?.partID === "string" ? record.partID : null,
          field: typeof record?.field === "string" ? record.field : null,
          deltaLength: delta.length,
        },
      };
    }

    return {
      type: event.type,
      properties: event.properties,
    };
  };

  const applyEvent = async (event: OpencodeEvent) => {
    if (event.type === "server.connected") {
      options.setSseConnected(true);
      uiLogInfo("runtime.sse", "server.connected event received");
    }

    if (options.developerMode()) {
      const compact = compactDebugEvent(event);
      if (event.type === "message.part.updated" || event.type === "message.part.delta") {
        const now = Date.now();
        if (now - lastPartDebugEventAt < 250) {
          suppressedPartDebugEvents += 1;
        } else {
          lastPartDebugEventAt = now;
          if (suppressedPartDebugEvents > 0) {
            compact.properties = {
              ...(compact.properties ?? {}),
              suppressed: suppressedPartDebugEvents,
            };
            suppressedPartDebugEvents = 0;
          }
          appendDebugEvent(compact);
        }
      } else {
        if (suppressedPartDebugEvents > 0) {
          appendDebugEvent({
            type: "message.part.stream.sample",
            properties: { suppressed: suppressedPartDebugEvents },
          });
          suppressedPartDebugEvents = 0;
        }
        appendDebugEvent(compact);
      }
    }

    if (event.type === "session.updated" || event.type === "session.created") {
      if (event.properties && typeof event.properties === "object") {
        const record = event.properties as Record<string, unknown>;
        if (record.info && typeof record.info === "object") {
          const info = record.info as Session;
          rememberSession(info);
          setStore("sessions", (current) => {
            const tracked = current.some((session) => session.id === info.id);
            if (info.parentID && !tracked) return current;
            return upsertSession(current, info);
          });
        }
      }
    }

    if (event.type === "session.deleted") {
      if (event.properties && typeof event.properties === "object") {
        const record = event.properties as Record<string, unknown>;
        const info = record.info as Session | undefined;
        if (info?.id) {
          const pendingUrls = pendingAttachmentUrls(
            store.pendingUserMessages[info.id],
          );
          // Notify listeners (e.g., token usage cache) before cleanup
          options.onSessionDeleted?.(info.id);
          syntheticContinueEventTimesBySession.delete(info.id);
          syntheticContinueLoopLastWarnAtBySession.delete(info.id);
          setStore(
            produce((draft: StoreState) => {
              delete draft.sessionInfoById[info.id];
              delete draft.pendingUserMessages[info.id];
            }),
          );
          revokePendingAttachmentUrls(pendingUrls);
          setStore("sessions", (current) => removeSession(current, info.id));
          setStore(
            produce((draft: StoreState) => {
              delete draft.sessionErrorTurns[info.id];
              delete draft.sessionClassifierTurns[info.id];
            }),
          );
        }
      }
    }

    if (event.type === "session.status") {
      if (event.properties && typeof event.properties === "object") {
        const record = event.properties as Record<string, unknown>;
        const sessionID = typeof record.sessionID === "string" ? record.sessionID : null;
        if (sessionID) {
          const normalized = normalizeSessionStatus(record.status);
          setStore("sessionStatus", sessionID, normalized);
          if (sessionID === options.selectedSessionId() && normalized !== "idle") {
            options.setError(null);
          }
        }
      }
    }

    if (event.type === "session.idle") {
      if (event.properties && typeof event.properties === "object") {
        const record = event.properties as Record<string, unknown>;
        const sessionID = typeof record.sessionID === "string" ? record.sessionID : null;
        if (sessionID) {
          setStore("sessionStatus", sessionID, "idle");
          const c = options.client();
          if (c) {
            try {
              const latest = unwrap(await c.session.get({ sessionID }));
              rememberSession(latest);
              setStore("sessions", (current) => {
                const tracked = current.some((session) => session.id === latest.id);
                if (latest.parentID && !tracked) return current;
                return upsertSession(current, latest);
              });

              // Detect automation completion by checking the session title
              const title = typeof latest.title === "string" ? latest.title : "";
              if (title.startsWith("Automation: ") && options.onAutomationCompleted) {
                options.onAutomationCompleted(sessionID, title);
              }

              // Reload through OpenWork after streaming completes so display-only
              // overlays can replace masked placeholders generated during streaming from the protected-file-agent.
              if (sessionID === options.selectedSessionId()) {
                try {
                  const limit = Math.max(INITIAL_SESSION_MESSAGE_LIMIT, messageLimitBySession()[sessionID] ?? 0);
                  const messages = unwrap(
                    await withTimeout(c.session.messages({ sessionID, limit }), 12000, "session.messages"),
                  );
                  if (options.selectedSessionId() === sessionID) {
                    setMessagesForSession(sessionID, messages);
                    setMessageCompleteBySession((prev) => ({
                      ...prev,
                      [sessionID]: messages.length < limit,
                    }));
                  }
                } catch (error) {
                  sessionWarn("session.idle.message-refresh.failed", {
                    sessionID,
                    error: error instanceof Error ? error.message : safeStringify(error),
                  });
                }
              }
            } catch {
              // ignore
            }
          }
        }
      }
    }

    if (event.type === "opencode.hotreload.applied") {
      options.onHotReloadApplied?.();
    }

    if (event.type === "session.error") {
      if (event.properties && typeof event.properties === "object") {
        const record = event.properties as Record<string, unknown>;
        const sessionID = typeof record.sessionID === "string" ? record.sessionID : null;
        const errorObj = record.error as Record<string, unknown> | undefined;
        // Preventive local-compaction signal: opencode compacts + retries to
        // success, so this is recoverable control flow, not an error. Suppress it
        // entirely — no idle flip (the session is still working the retry) and no
        // error turn — mirroring the MessageAbortedError exemption below.
        if (errorObj && isPreventiveLocalCompaction(errorObj)) {
          return;
        }
        if (sessionID) {
          setStore("sessionStatus", sessionID, "idle");
        }
        if (errorObj) {
          const errorName = typeof errorObj.name === "string" ? errorObj.name : "UnknownError";
          if (errorName === "MessageAbortedError") {
            // Cancellation is a user-driven control flow. Don't treat it as a
            // fatal error banner; the session UI already provides local UX.
            if (!sessionID) {
              options.setError(null);
            }
            return;
          }
          if (sessionID) {
            appendSessionErrorTurn(
              sessionID,
              addOpencodeCacheHint(formatSessionError(errorObj)),
              undefined,
              notConfiguredKind(errorObj),
            );
          } else {
            options.setError(addOpencodeCacheHint(formatSessionError(errorObj)));
          }
          return;
        }

        const fallback = truncateErrorField(record.error, 700) ?? "An unexpected error occurred";
        if (sessionID) {
          appendSessionErrorTurn(sessionID, addOpencodeCacheHint(fallback));
        } else {
          options.setError(addOpencodeCacheHint(fallback));
        }
      }
    }

    if (event.type === "message.updated") {
      if (event.properties && typeof event.properties === "object") {
        const record = event.properties as Record<string, unknown>;
        if (record.info && typeof record.info === "object") {
          const info = record.info as Message;
          const model = modelFromUserMessage(info as MessageInfo);
          if (model) {
            options.setSessionModelState((current) => ({
              overrides: current.overrides,
              resolved: { ...current.resolved, [info.sessionID]: model },
            }));
          }

          const pending = store.pendingUserMessages[info.sessionID];
          const knownMessageIDs = new Set(
            (store.messages[info.sessionID] ?? []).map(
              (message) => message.id,
            ),
          );
          const reconcilesPending = Boolean(
            pending &&
              shouldReconcilePendingUserMessage(
                pending,
                info,
                knownMessageIDs,
              ),
          );
          const existingRealParts = store.parts[info.id] ?? [];
          // Match the snapshot path's check: only a genuinely authoritative part
          // (not a previously-seeded reconciled-pending placeholder) means the
          // preview is safe to revoke, otherwise a still-displayed blob URL gets
          // revoked before its real file part has arrived.
          const shouldSeedPendingParts = Boolean(
            pending &&
              reconcilesPending &&
              !existingRealParts.some((part) => !isReconciledPendingPart(part)),
          );
          const pendingUrls = reconcilesPending && !shouldSeedPendingParts
            ? pendingAttachmentUrls(pending)
            : [];
          batch(() => {
            if (reconcilesPending) {
              setStore("pendingUserMessages", info.sessionID, undefined);
            }
            setStore("messages", info.sessionID, (current = []) =>
              upsertMessageInfo(current, info),
            );
            if (pending && shouldSeedPendingParts) {
              setStore("parts", info.id, remapPendingPartsToMessage(pending, info.id));
            }
          });
          if (reconcilesPending) {
            revokePendingAttachmentUrls(pendingUrls);
          }
          surfaceAssistantMessageError(info as MessageInfo);
          if (pending && reconcilesPending) {
            retargetSessionErrorTurnsSourceMessageID(info.sessionID, pending.info.id, info.id);
            recordPerfLog(
              sessionDebugEnabled(),
              "session.submit",
              "user-authoritative",
              {
                sessionID: info.sessionID,
                pendingMessageID: pending.info.id,
                messageID: info.id,
                ms: Date.now() - pending.info.time.created,
              },
            );
          }
        }
      }
    }

    if (event.type === "message.removed") {
      if (event.properties && typeof event.properties === "object") {
        const record = event.properties as Record<string, unknown>;
        const sessionID = typeof record.sessionID === "string" ? record.sessionID : null;
        const messageID = typeof record.messageID === "string" ? record.messageID : null;
        if (sessionID && messageID) {
          setStore("messages", sessionID, (current = []) => removeMessageInfo(current, messageID));
          setStore("parts", messageID, []);
          reconcileSessionErrorTurns(sessionID);
        }
      }
    }

    if (event.type === "message.part.updated") {
      if (event.properties && typeof event.properties === "object") {
        const record = event.properties as Record<string, unknown>;
        if (record.part && typeof record.part === "object") {
          const part = record.part as Part;
          const delta = typeof record.delta === "string" ? record.delta : null;
          const partUpdatedStartedAt = perfNow();

          setStore(
            produce((draft: StoreState) => {
              const list = draft.messages[part.sessionID] ?? [];
              if (!list.find((message) => message.id === part.messageID)) {
                draft.messages[part.sessionID] = upsertMessageInfo(list, createPlaceholderMessage(part));
              }

              const parts = draft.parts[part.messageID] ?? [];
              const replacedPendingParts = parts.filter((item) =>
                shouldDropReconciledPendingPart(item, part),
              );
              const baseParts = replacedPendingParts.length > 0
                ? parts.filter((item) => !shouldDropReconciledPendingPart(item, part))
                : parts;
              const existingIndex = baseParts.findIndex((item) => item.id === part.id);

              if (delta && part.type === "text" && existingIndex !== -1) {
                const existing = baseParts[existingIndex] as Part & { text?: string };
                if (typeof existing.text === "string" && !existing.text.endsWith(delta)) {
                  const next = { ...existing, text: `${existing.text}${delta}` } as Part;
                  baseParts[existingIndex] = next;
                  draft.parts[part.messageID] = baseParts;
                  return;
                }
              }

              draft.parts[part.messageID] = upsertPartInfo(baseParts, part);
              revokePendingAttachmentUrls(blobUrlsForParts(replacedPendingParts));
            }),
          );
          const resolvedPart =
            store.parts[part.messageID]?.find((item) => item.id === part.id) ??
            part;
          recordSyntheticContinueDiagnostic(resolvedPart);
          const partUpdatedMs = Math.round((perfNow() - partUpdatedStartedAt) * 100) / 100;
          if (sessionDebugEnabled() && (partUpdatedMs >= 8 || (delta?.length ?? 0) >= 120)) {
            const textLength =
              part.type === "text" && typeof (part as { text?: unknown }).text === "string"
                ? String((part as { text?: string }).text).length
                : null;
            recordPerfLog(true, "session.event", "message.part.updated", {
              sessionID: part.sessionID,
              messageID: part.messageID,
              partID: part.id,
              partType: part.type,
              deltaLength: delta?.length ?? 0,
              textLength,
              ms: partUpdatedMs,
            });
          }
          maybeMarkReloadRequired(part);
          maybeHandleInvalidToolError(part);
        }
      }
    }

    if (event.type === "message.part.delta") {
      if (event.properties && typeof event.properties === "object") {
        const record = event.properties as Record<string, unknown>;
        const messageID = typeof record.messageID === "string" ? record.messageID : null;
        const partID = typeof record.partID === "string" ? record.partID : null;
        const field = typeof record.field === "string" ? record.field : null;
        const delta = typeof record.delta === "string" ? record.delta : null;
        const partDeltaStartedAt = perfNow();

        if (messageID && partID && field && delta) {
          setStore("parts", messageID, (current = []) => appendPartDelta(current, partID, field, delta));
          const partDeltaMs = Math.round((perfNow() - partDeltaStartedAt) * 100) / 100;
          if (sessionDebugEnabled() && (partDeltaMs >= 8 || delta.length >= 120)) {
            recordPerfLog(true, "session.event", "message.part.delta", {
              messageID,
              partID,
              field,
              deltaLength: delta.length,
              ms: partDeltaMs,
            });
          }
        }
      }
    }

    if (event.type === "message.part.removed") {
      if (event.properties && typeof event.properties === "object") {
        const record = event.properties as Record<string, unknown>;
        const messageID = typeof record.messageID === "string" ? record.messageID : null;
        const partID = typeof record.partID === "string" ? record.partID : null;
        if (messageID && partID) {
          setStore("parts", messageID, (current = []) => removePartInfo(current, partID));
        }
      }
    }

    if (event.type === "todo.updated") {
      if (event.properties && typeof event.properties === "object") {
        const record = event.properties as Record<string, unknown>;
        const sessionID = typeof record.sessionID === "string" ? record.sessionID : null;
        if (sessionID && Array.isArray(record.todos)) {
          setStore("todos", sessionID, record.todos as TodoItem[]);
        }
      }
    }

    if (event.type === "permission.asked" || event.type === "permission.replied") {
      try {
        await refreshPendingPermissions();
      } catch {
        // ignore
      }
    }

    if (
      event.type === "question.asked" ||
      event.type === "question.replied" ||
      event.type === "question.rejected"
    ) {
      try {
        await refreshPendingQuestions();
      } catch {
        // ignore
      }
    }
  };

  createEffect(() => {
    const c = options.client();
    if (!c) return;

    let cancelled = false;
    let reconnectAttempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    let queue: Array<OpencodeEvent | undefined> = [];
    const coalesced = new Map<string, number>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let last = 0;
    let queueStartedAt = 0;
    let peakQueueDepth = 0;
    let queueHasPartUpdates = false;
    let coalescedReplaced = 0;

    const keyForEvent = (event: OpencodeEvent) => {
      if (event.type === "session.status" || event.type === "session.idle") {
        const record = event.properties as Record<string, unknown> | undefined;
        const sessionID = typeof record?.sessionID === "string" ? record.sessionID : "";
        return sessionID ? `${event.type}:${sessionID}` : undefined;
      }
      if (event.type === "message.part.updated") {
        const record = event.properties as Record<string, unknown> | undefined;
        const part = record?.part as Part | undefined;
        if (part?.messageID && part.id) {
          return `message.part.updated:${part.messageID}:${part.id}`;
        }
      }
      if (event.type === "todo.updated") {
        const record = event.properties as Record<string, unknown> | undefined;
        const sessionID = typeof record?.sessionID === "string" ? record.sessionID : "";
        return sessionID ? `todo.updated:${sessionID}` : undefined;
      }
      return undefined;
    };

    const flush = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;

      const eventsToApply = queue;
      queue = [];
      coalesced.clear();
      if (eventsToApply.length === 0) return;

      const queueWaitMs = queueStartedAt > 0 ? Date.now() - queueStartedAt : 0;
      queueStartedAt = 0;
      const peakDepth = peakQueueDepth;
      peakQueueDepth = 0;
      queueHasPartUpdates = false;
      const replaced = coalescedReplaced;
      coalescedReplaced = 0;

      last = Date.now();
      const startedAt = perfNow();
      let applied = 0;
      let partUpdates = 0;
      let messageUpdates = 0;
      batch(() => {
        for (const event of eventsToApply) {
          if (!event) continue;
          if (event.type === "message.part.updated" || event.type === "message.part.delta") partUpdates += 1;
          if (event.type === "message.updated") messageUpdates += 1;
          applied += 1;
          void applyEvent(event);
        }
      });

      const elapsedMs = Math.round((perfNow() - startedAt) * 100) / 100;
      const dropped = eventsToApply.length - applied;
      if (
        sessionDebugEnabled() &&
        (elapsedMs >= 10 || queueWaitMs >= 40 || peakDepth >= 25 || applied >= 30 || dropped >= 12)
      ) {
        recordPerfLog(true, "session.sse", "flush", {
          queued: eventsToApply.length,
          applied,
          dropped,
          queueWaitMs,
          peakQueueDepth: peakDepth,
          coalescedReplaced: replaced,
          messageUpdates,
          partUpdates,
          ms: elapsedMs,
        });
      }
    };

    const schedule = () => {
      if (timer) return;
      const elapsed = Date.now() - last;
      const interval = queueHasPartUpdates ? 48 : 16;
      timer = setTimeout(flush, Math.max(0, interval - elapsed));
    };

    const connectSse = async (controller: AbortController) => {
      const attemptForThisConnect = reconnectAttempt;
      let connectedAt: number | null = null;
      try {
        const sub = await c.event.subscribe(undefined, { signal: controller.signal });
        connectedAt = Date.now();
        let yielded = connectedAt;
        let lastArrivalAt = connectedAt;

        // Reset reconnect counter on successful connection
        reconnectAttempt = 0;
        recordPerfLog(sessionDebugEnabled(), "session.sse", "connected");
        uiLogInfo("runtime.sse", "SSE stream connected", { attempt: attemptForThisConnect });

        for await (const raw of sub.stream) {
          if (cancelled) break;

          const event = normalizeEvent(raw);
          if (!event) continue;

          const arrivedAt = Date.now();
          const arrivalGapMs = arrivedAt - lastArrivalAt;
          lastArrivalAt = arrivedAt;
          if (sessionDebugEnabled() && arrivalGapMs >= 220) {
            recordPerfLog(true, "session.sse", "arrival-gap", {
              ms: arrivalGapMs,
              type: event.type,
            });
          }

          const key = keyForEvent(event);
          if (key) {
            const existing = coalesced.get(key);
            if (existing !== undefined) {
              if (queue[existing] !== undefined) {
                coalescedReplaced += 1;
              }
              queue[existing] = undefined;
            }
            coalesced.set(key, queue.length);
          }

          if (queue.length === 0) {
            queueStartedAt = Date.now();
          }
          if (event.type === "message.part.updated" || event.type === "message.part.delta") {
            queueHasPartUpdates = true;
          }
          queue.push(event);
          if (queue.length > peakQueueDepth) {
            peakQueueDepth = queue.length;
          }
          schedule();

          if (Date.now() - yielded < 8) continue;
          yielded = Date.now();
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }

        // Stream ended normally - attempt reconnect unless cancelled
        if (!cancelled) {
          options.setSseConnected(false);
          recordPerfLog(sessionDebugEnabled(), "session.sse", "stream-ended");
          uiLogWarn("runtime.sse", "SSE stream ended without error", {
            connectedForMs: connectedAt !== null ? Date.now() - connectedAt : null,
            attempt: attemptForThisConnect,
          });
          scheduleReconnect(controller);
        }
      } catch (e) {
        if (cancelled) return;

        const message = e instanceof Error ? e.message : String(e);
        if (message.toLowerCase().includes("abort")) return;

        // Mark SSE as disconnected and schedule reconnect
        options.setSseConnected(false);
        recordPerfLog(sessionDebugEnabled(), "session.sse", "stream-error", {
          error: message,
        });
        uiLogWarn("runtime.sse", "SSE stream error", {
          error: message,
          connectedForMs: connectedAt !== null ? Date.now() - connectedAt : null,
          attempt: attemptForThisConnect,
        });
        scheduleReconnect(controller);
      }
    };

    const scheduleReconnect = (oldController: AbortController) => {
      if (cancelled) return;
      oldController.abort();

      // Exponential backoff: 1s, 2s, 4s, 8s, 16s, max 30s
      reconnectAttempt++;
      const delay = Math.min(1000 * Math.pow(2, reconnectAttempt - 1), 30000);
      recordPerfLog(sessionDebugEnabled(), "session.sse", "reconnect-scheduled", {
        attempt: reconnectAttempt,
        delayMs: delay,
      });
      uiLogInfo("runtime.sse", "SSE reconnect scheduled", {
        attempt: reconnectAttempt,
        delayMs: delay,
      });

      reconnectTimer = setTimeout(() => {
        if (cancelled) return;
        const newController = new AbortController();
        void connectSse(newController);
      }, delay);
    };

    const controller = new AbortController();
    void connectSse(controller);

    onCleanup(() => {
      cancelled = true;
      controller.abort();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      flush();
    });
  });

  return {
    sessions,
    sessionById,
    sessionErrorTurnsById: (sessionID: string | null) => (sessionID ? store.sessionErrorTurns[sessionID] ?? [] : []),
    sessionClassifierTurnsById: (sessionID: string | null) => (sessionID ? store.sessionClassifierTurns[sessionID] ?? [] : []),
    selectedSessionErrorTurns: createMemo(() => {
      const sessionID = options.selectedSessionId();
      return sessionID ? store.sessionErrorTurns[sessionID] ?? [] : [];
    }),
    selectedSessionClassifierTurns: createMemo(() => {
      const sessionID = options.selectedSessionId();
      return sessionID ? store.sessionClassifierTurns[sessionID] ?? [] : [];
    }),
    sessionStatusById,
    selectedSession,
    selectedSessionStatus,
    messages,
    messagesBySessionId,
    todos,
    pendingPermissions,
    permissionReplyBusy,
    pendingQuestions,
    activeQuestion,
    questionReplyBusy,
    events,
    activePermission,
    loadSessions,
    ensureSessionLoaded,
    refreshPendingPermissions,
    refreshPendingQuestions,
    selectSession,
    loadEarlierMessages,
    renameSession,
    respondPermission,
    respondQuestion,
    rejectQuestion,
    appendSessionErrorTurn,
    appendSessionClassifierTurn,
    removeSessionClassifierTurnsByAfterMessageID,
    appendPendingUserMessage,
    takePendingUserMessage,
    clearPendingUserMessage,
    setSessions,
    setSessionStatusById,
    setMessages,
    setTodos,
    setPendingPermissions,
    setPendingQuestions,
    selectedSessionHasEarlierMessages,
    selectedSessionLoadingEarlierMessages,
    sessionLoadingById: (sessionID: string | null) => (sessionID ? Boolean(messageLoadBusyBySession()[sessionID]) : false),
    sessionMessageHistoryComplete: (sessionID: string) =>
      Boolean(messageCompleteBySession()[sessionID.trim()]),
  };
}

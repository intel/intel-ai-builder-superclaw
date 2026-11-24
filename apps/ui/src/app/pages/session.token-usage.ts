import { createEffect, createMemo, createSignal, on } from "solid-js";
import {
  formatInternalProviderModelLabel, formatModelRouteLabel, isInternalProviderID,
} from "~/shared/util/model-ref";
import type {
  LlmRouterClient,
  LlmRouterUsageEvent,
} from "../lib/llmrouter-client";
import { aggregateLrmUsageEvents } from "../lib/lrm-token-usage";
import {
  computeActivityModelExecutions,
  taskChildSessionId,
  type ActivitySessionTranscript,
} from "../lib/activity-model-executions";
import { computeTurnTokenTotals } from "~/shared/util/turn-token-totals";
import { computeTurnServedModelLabels } from "~/shared/util/turn-served-models";
import type { ModelBadgeDescriptor } from "~/shared/util/model-ref";
import type { ProviderListItem } from "~/shared/types/models";
import type { MessageWithParts } from "../types";
import MODEL_ROUTING from "@different-ai/openwork-contracts/data/model-routing.json";

/** Token usage breakdown by model */
type ModelTokenStats = {
  modelID: string;
  providerID: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  isLocal: boolean;
  hasTokenData: boolean; // true if at least one message had token data
};

/**
 * Reactive inputs arrive as thunks so the controller reads them in its
 * caller's tracking scope instead of capturing a value at setup time.
 */
type TokenUsageDeps = {
  messages: () => MessageWithParts[];
  selectedSessionId: () => string | null;
  llmRouterClient: () => LlmRouterClient | null;
  sessionStatus: () => string;
  getMessagesBySessionId?: (sessionId: string | null) => MessageWithParts[];
  providers?: () => ProviderListItem[];
};

type TokenUsageController = {
  currentSessionTokenTotals: () => {
    inputTokens: number;
    outputTokens: number;
    totalCost: number;
  } | null;
  tokensByMessageId: () => ReturnType<typeof computeTurnTokenTotals>;
  servedModelLabelByMessageId: () => Record<string, ModelBadgeDescriptor>;
  sessionTokensByModel: () => ModelTokenStats[] | null;
  activityModelExecutions: () => ReturnType<typeof computeActivityModelExecutions>;
  formatTokens: (count: number) => string;
  formatModelLabel: (providerID: string, modelID: string) => string;
};

/**
 * Local provider classification. Tables come from the wire-schema spine
 * (Seam A): shared/contracts/src/model-routing.ts.
 * Determines if a provider runs locally (data stays on-premise).
 *
 * Runtime backends can still arrive as "llama" and "edge" even when the
 * canonical router table only names the shared local-provider family.
 */
const LOCAL_PROVIDER_IDS = new Set([
  ...MODEL_ROUTING.local_provider_ids,
  "local",
  "llama",
  "edge",
]);

const isLocalProvider = (providerID: string, modelID?: string): boolean => {
  const id = providerID.trim().toLowerCase();
  if (LOCAL_PROVIDER_IDS.has(id)) return true;
  if (id === "superrouter") {
    const model = (modelID ?? "").trim().toLowerCase();
    if (MODEL_ROUTING.cloud_model_prefixes.some((p) => model.startsWith(p)))
      return false;
    if (MODEL_ROUTING.superrouter_local_models.some((p) => model.includes(p)))
      return true;
    return true; // Default to local for SuperRouter
  }
  return false;
};

/** Format token count compactly: 1234 → "1.2k", 123456 → "123k" */
const formatTokens = (count: number): string => {
  if (count < 1000) return String(count);
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${(count / 1000).toFixed(1)}k`;
  return `${(count / 1000000).toFixed(2)}M`;
};

/** Format model label for display */
const formatModelLabel = (providerID: string, modelID: string): string => {
  const trimmedProviderID = providerID.trim();
  const trimmedModelID = modelID.trim();

  if (!trimmedModelID) return trimmedProviderID || "Unknown";
  if (!trimmedProviderID) return trimmedModelID;
  if (isInternalProviderID(trimmedProviderID)) {
    return formatInternalProviderModelLabel(trimmedProviderID, trimmedModelID);
  }
  // Local backends such as "llama" and "edge" still represent on-device usage;
  // they should show the model name without leaking the provider prefix.
  if (LOCAL_PROVIDER_IDS.has(trimmedProviderID.toLowerCase())) {
    return formatModelRouteLabel(trimmedModelID) ?? trimmedModelID;
  }
  // If modelID already includes provider info, just return it.
  if (
    trimmedModelID.includes("/") ||
    trimmedModelID.toLowerCase().startsWith(trimmedProviderID.toLowerCase())
  ) {
    return trimmedModelID;
  }
  return `${trimmedProviderID}/${trimmedModelID}`;
};

const REFETCH_OVERLAP_MS = 5_000;

export function createTokenUsage(deps: TokenUsageDeps): TokenUsageController {
  const [sessionUsageEventsBySessionId, setSessionUsageEventsBySessionId] =
    createSignal<Record<string, LlmRouterUsageEvent[]>>({});

  const taskChildIdsOf = (messages: MessageWithParts[]): string[] => {
    const ids = new Set<string>();
    for (const message of messages) {
      for (const part of message.parts ?? []) {
        const childId = taskChildSessionId(part);
        if (childId) ids.add(childId);
      }
    }
    return Array.from(ids);
  };

  const taskChildSessionIds = createMemo(() => taskChildIdsOf(deps.messages()));

  const reachableActivitySessions = createMemo<ActivitySessionTranscript[]>(() => {
    const sessionId = deps.selectedSessionId();
    if (!sessionId) return [];

    const sessions: ActivitySessionTranscript[] = [];
    const visited = new Set<string>();
    const visit = (id: string, messages: MessageWithParts[]) => {
      if (visited.has(id)) return;
      visited.add(id);
      sessions.push({ sessionId: id, messages });
      for (const childId of taskChildIdsOf(messages)) {
        if (visited.has(childId)) continue;
        const childMessages = deps.getMessagesBySessionId?.(childId);
        if (childMessages && childMessages.length > 0) visit(childId, childMessages);
      }
    };

    visit(sessionId, deps.messages());
    return sessions;
  });

  const taskChildSessionIdsBySessionId = createMemo(() => {
    const childrenBySessionId: Record<string, string[]> = {};
    for (const session of reachableActivitySessions()) {
      childrenBySessionId[session.sessionId] = taskChildIdsOf(session.messages);
    }
    return childrenBySessionId;
  });

  // Every reachable session plus the sub-agents it launched, even when a
  // sub-agent's transcript is not loaded: its row is labeled from its records.
  const activityFetchSessionIds = createMemo(() => {
    const ids = new Set(taskChildSessionIds());
    for (const session of reachableActivitySessions()) {
      ids.add(session.sessionId);
      for (const childId of taskChildIdsOf(session.messages)) ids.add(childId);
    }
    return Array.from(ids);
  });

  // Per-session fetch bookkeeping, deliberately not reactive. Each session has
  // at most one fetch in flight; a trigger that lands meanwhile queues a single
  // rerun instead of starting a parallel download whose result would race.
  const latestOccurredAtBySessionId = new Map<string, number>();
  const inFlightBySessionId = new Map<string, Promise<void>>();
  const rerunRequested = new Set<string>();
  const latestClientBySessionId = new Map<string, LlmRouterClient>();

  const fetchEventPages = async (
    sessionId: string,
    client: LlmRouterClient,
    sinceMs: number | undefined,
  ): Promise<LlmRouterUsageEvent[]> => {
    const events: LlmRouterUsageEvent[] = [];
    let cursor = sinceMs;
    for (let page = 0; page < 100; page += 1) {
      const response = await client.getUsageEvents({
        sessionId,
        sinceMs: cursor,
        limit: 1000,
      });
      events.push(...response.events);
      if (response.next_since_ms === undefined) break;
      if (response.next_since_ms === cursor) break;
      cursor = response.next_since_ms;
    }
    return events;
  };

  const fetchNewEventsForSession = async (
    sessionId: string,
    client: LlmRouterClient,
  ) => {
    const latest = latestOccurredAtBySessionId.get(sessionId);
    // The router pages with `occurred_at > since`, so re-read a short window
    // to catch records that share or slightly precede the newest timestamp.
    const sinceMs =
      latest === undefined ? undefined : Math.max(0, latest - REFETCH_OVERLAP_MS);
    let events = await fetchEventPages(sessionId, client, sinceMs);
    let replace = sinceMs === undefined;

    if (!replace) {
      // A held record inside the re-read window that the router no longer
      // returns means usage was cleared; start over from a full read.
      const returned = new Set(events.map((event) => event.event_id));
      const held = sessionUsageEventsBySessionId()[sessionId] ?? [];
      if (held.some((event) => event.occurred_at > (sinceMs ?? 0) && !returned.has(event.event_id))) {
        events = await fetchEventPages(sessionId, client, undefined);
        replace = true;
      }
    }

    const newest = events.reduce(
      (max, event) => Math.max(max, event.occurred_at),
      replace ? -Infinity : latest ?? -Infinity,
    );
    if (Number.isFinite(newest)) latestOccurredAtBySessionId.set(sessionId, newest);
    else latestOccurredAtBySessionId.delete(sessionId);

    setSessionUsageEventsBySessionId((prev) => {
      const byId = new Map<string, LlmRouterUsageEvent>();
      if (!replace) for (const event of prev[sessionId] ?? []) byId.set(event.event_id, event);
      for (const event of events) byId.set(event.event_id, event);
      return { ...prev, [sessionId]: Array.from(byId.values()) };
    });
  };

  const refreshSession = (sessionId: string, client: LlmRouterClient) => {
    // A queued rerun uses the client of the latest trigger, not the first.
    latestClientBySessionId.set(sessionId, client);
    const running = inFlightBySessionId.get(sessionId);
    if (running) {
      rerunRequested.add(sessionId);
      return running;
    }
    const run = (async () => {
      try {
        do {
          rerunRequested.delete(sessionId);
          try {
            await fetchNewEventsForSession(
              sessionId,
              latestClientBySessionId.get(sessionId) ?? client,
            );
          } catch (error) {
            console.debug("Failed to fetch current-session LRM usage events", {
              sessionId,
              error,
            });
          }
        } while (rerunRequested.has(sessionId));
      } finally {
        // Cleared in the same step as the last rerun check; a `.finally()`
        // handler would run a microtask later, and a trigger landing in that
        // gap would queue a rerun nobody picks up.
        inFlightBySessionId.delete(sessionId);
      }
    })();
    inFlightBySessionId.set(sessionId, run);
    return run;
  };

  const refreshSessions = async (sessionIds: Iterable<string>, client: LlmRouterClient) => {
    await Promise.all(Array.from(new Set(sessionIds), (id) => refreshSession(id, client)));
  };

  // A router record lands when a model call ends, which a loaded transcript
  // shows as a new `step-finish` part. Sessions whose transcript is not loaded
  // cannot be observed, so they are re-read whenever any loaded one advances.
  const UNLOADED = "unloaded";
  const refreshSignatures = createMemo(() => {
    const signatures = new Map<string, string>();
    for (const session of reachableActivitySessions()) {
      let stepFinishes = 0;
      for (const message of session.messages) {
        for (const part of message.parts ?? []) {
          if (part.type === "step-finish") stepFinishes += 1;
        }
      }
      signatures.set(session.sessionId, `steps:${stepFinishes}`);
    }
    for (const id of activityFetchSessionIds()) {
      if (!signatures.has(id)) signatures.set(id, UNLOADED);
    }
    const selected = deps.selectedSessionId();
    if (selected && !signatures.has(selected)) signatures.set(selected, UNLOADED);
    return signatures;
  });

  let previousSignatures = new Map<string, string>();

  createEffect(
    on(
      () => [deps.selectedSessionId(), deps.llmRouterClient(), refreshSignatures()] as const,
      ([sessionId, client, signatures], previous) => {
        // Switching session or router client starts from a full read.
        if (!previous || previous[0] !== sessionId || previous[1] !== client) {
          latestOccurredAtBySessionId.clear();
          previousSignatures = new Map();
        }
        if (!sessionId || !client) return;
        const changed: string[] = [];
        let loadedAdvanced = false;
        for (const [id, signature] of signatures) {
          if (previousSignatures.get(id) === signature) continue;
          changed.push(id);
          if (signature !== UNLOADED) loadedAdvanced = true;
        }
        if (loadedAdvanced) {
          for (const [id, signature] of signatures) {
            if (signature === UNLOADED) changed.push(id);
          }
        }
        previousSignatures = signatures;
        if (changed.length > 0) void refreshSessions(changed, client);
      },
    ),
  );

  // The HDR sidecar/task subagents can keep writing usage events after the
  // last step finishes, so a status transition into "idle" is its own
  // one-shot re-read of every tracked session (not a polling interval).
  // `defer: true` so this only fires on a real transition: without it the
  // effect also runs at mount with `prevStatus === undefined`, which for an
  // already-idle session duplicates the refresh the effect above just started.
  createEffect(
    on(
      () => deps.sessionStatus(),
      (status, prevStatus) => {
        if (status !== "idle" || prevStatus === "idle") return;
        const sessionId = deps.selectedSessionId();
        const client = deps.llmRouterClient();
        if (!sessionId || !client) return;
        void refreshSessions([sessionId, ...activityFetchSessionIds()], client);
      },
      { defer: true },
    ),
  );

  const currentSessionLrmUsage = createMemo(() => {
    const sessionId = deps.selectedSessionId();
    if (!sessionId) return null;
    const allEvents = sessionUsageEventsBySessionId();
    const eventsBySession: Record<string, LlmRouterUsageEvent[]> = {};
    for (const id of [sessionId, ...activityFetchSessionIds()]) {
      eventsBySession[id] = allEvents[id] ?? [];
    }
    const aggregate = aggregateLrmUsageEvents(eventsBySession);
    if (
      aggregate.total.input === 0 &&
      aggregate.total.output === 0 &&
      aggregate.total.cost === 0
    )
      return null;
    return aggregate;
  });

  const currentSessionTokenTotals = createMemo(() => {
    const lrmUsage = currentSessionLrmUsage();
    if (!lrmUsage) return null;
    return {
      inputTokens: lrmUsage.total.input,
      outputTokens: lrmUsage.total.output,
      totalCost: lrmUsage.total.cost,
    };
  });

  // Per-turn input/output totals keyed by the final assistant reply's
  // `message.info.id` (== `X-Opencode-Message-Id` header LRM records on each
  // dispatch). Rolls up a turn's LLM calls — direct replies, tool loops,
  // delegated `task` subagents and their known descendants, and HDR runs —
  // into one flat number. Bucketing is scoped to the selected session and its
  // reachable task-child sessions so stale events from previously-viewed
  // sessions cached in `sessionUsageEventsBySessionId` don't leak in.
  const tokensByMessageId = createMemo(() => {
    const sessionId = deps.selectedSessionId();
    if (!sessionId) return {};
    return computeTurnTokenTotals({
      sessionId,
      messages: deps.messages(),
      eventsBySessionId: sessionUsageEventsBySessionId(),
      taskChildSessionIds: taskChildSessionIds(),
      taskChildSessionIdsBySessionId: taskChildSessionIdsBySessionId(),
    });
  });

  const servedModelLabelByMessageId = createMemo(() => {
    const sessionId = deps.selectedSessionId();
    if (!sessionId) return {};
    return computeTurnServedModelLabels({
      sessionId,
      messages: deps.messages(),
      eventsBySessionId: sessionUsageEventsBySessionId(),
      taskChildSessionIds: taskChildSessionIds(),
      taskChildSessionIdsBySessionId: taskChildSessionIdsBySessionId(),
      providers: deps.providers?.() ?? [],
    });
  });

  const activityModelExecutions = createMemo(() =>
    computeActivityModelExecutions({
      sessions: reachableActivitySessions(),
      eventsBySessionId: sessionUsageEventsBySessionId(),
      providers: deps.providers?.() ?? [],
    }),
  );

  const sessionTokensByModel = createMemo((): ModelTokenStats[] | null => {
    const lrmUsage = currentSessionLrmUsage();
    if (!lrmUsage) return null;
    return lrmUsage.modelStats.map((model) => ({
      modelID: model.modelID,
      providerID: model.providerID,
      inputTokens: model.input,
      outputTokens: model.output,
      cost: model.cost,
      isLocal: isLocalProvider(model.providerID, model.modelID),
      hasTokenData: true,
    }));
  });

  return {
    currentSessionTokenTotals,
    tokensByMessageId,
    servedModelLabelByMessageId,
    sessionTokensByModel,
    activityModelExecutions,
    formatTokens,
    formatModelLabel,
  };
}

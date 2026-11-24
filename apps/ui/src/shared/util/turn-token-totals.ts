import type { LlmRouterUsageEvent } from "~/shared/platform/transport/llmrouter-client";
import type { MessageWithParts } from "~/shared/types/session";

export type TurnTokenBucket = { input: number; output: number; local: number; cloud: number };

/**
 * One user message plus every assistant reply that follows it before the
 * next user message. Normally exactly one assistant id; a retry/regenerate
 * leaves multiple assistant ids in the same turn (the stale replies plus the
 * fresh one), all sharing the same `userMessageId`.
 */
export type Turn = {
  userMessageId: string | null;
  assistantMessageIds: string[];
  /** Child session ids spawned by a `task` tool call anywhere in this turn. */
  childSessionIds: string[];
  /** Epoch-millisecond bounds used to scope resumed child-session events. */
  startedAt?: number;
  endedAt?: number;
};

function messageRole(message: MessageWithParts): string {
  return (message.info as { role?: string }).role ?? "";
}

function messageId(message: MessageWithParts): string {
  return String((message.info as { id?: string }).id ?? "");
}

function messageCreatedAt(message: MessageWithParts): number | undefined {
  const created = (message.info as { time?: { created?: unknown } }).time?.created;
  return typeof created === "number" ? created : undefined;
}

/** Mirrors the `task` tool child-session extraction in session.tsx. */
function extractTaskChildSessionId(part: MessageWithParts["parts"][number]): string | null {
  if ((part as { type?: string }).type !== "tool") return null;
  const toolPart = part as { tool?: string; state?: Record<string, unknown> };
  if (toolPart.tool !== "task") return null;
  const state = toolPart.state ?? {};
  const metadata = (state.metadata ?? {}) as Record<string, unknown>;
  return (
    (metadata.sessionId as string) ??
    (metadata.sessionID as string) ??
    (state.sessionId as string) ??
    (state.sessionID as string) ??
    null
  );
}

export function buildTurns(messages: MessageWithParts[], allowedChildSessionIds: Set<string>): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | null = null;

  for (const message of messages) {
    const role = messageRole(message);
    if (role === "user") {
      const createdAt = messageCreatedAt(message);
      if (current && createdAt !== undefined) current.endedAt = createdAt;
      current = {
        userMessageId: messageId(message),
        assistantMessageIds: [],
        childSessionIds: [],
        startedAt: createdAt,
      };
      turns.push(current);
    } else if (role === "assistant") {
      if (!current) {
        current = {
          userMessageId: null,
          assistantMessageIds: [],
          childSessionIds: [],
          startedAt: messageCreatedAt(message),
        };
        turns.push(current);
      } else if (current.startedAt === undefined) {
        current.startedAt = messageCreatedAt(message);
      }
      current.assistantMessageIds.push(messageId(message));
    }
    if (!current) continue;
    for (const part of message.parts ?? []) {
      const childSessionId = extractTaskChildSessionId(part);
      if (childSessionId && allowedChildSessionIds.has(childSessionId)) {
        current.childSessionIds.push(childSessionId);
      }
    }
  }

  return turns;
}

/** Union of the events stamped on a turn's messages and on its task spawned child sessions */
export function collectTurnEvents(
  turn: Turn,
  eventsByMessageId: Map<string, LlmRouterUsageEvent[]>,
  eventsBySessionId: Record<string, LlmRouterUsageEvent[]>,
  taskChildSessionIdsBySessionId: Record<string, string[]> = {},
): LlmRouterUsageEvent[] {
  const seen = new Set<string>();
  const events: LlmRouterUsageEvent[] = [];
  const add = (list: LlmRouterUsageEvent[]) => {
    for (const event of list) {
      if (seen.has(event.event_id)) continue;
      seen.add(event.event_id);
      events.push(event);
    }
  };
  const addChildSessionEvents = (list: LlmRouterUsageEvent[]) => {
    const startedAt = turn.startedAt;
    if (startedAt === undefined) return;
    add(
      list.filter(
        (event) =>
          event.occurred_at >= startedAt &&
          (turn.endedAt === undefined || event.occurred_at < turn.endedAt),
      ),
    );
  };
  const messageIds = [...(turn.userMessageId ? [turn.userMessageId] : []), ...turn.assistantMessageIds];
  for (const id of messageIds) add(eventsByMessageId.get(id) ?? []);
  const visitedSessions = new Set<string>();
  const pendingSessions = [...turn.childSessionIds];
  while (pendingSessions.length > 0) {
    const childSessionId = pendingSessions.pop();
    if (!childSessionId || visitedSessions.has(childSessionId)) continue;
    visitedSessions.add(childSessionId);
    addChildSessionEvents(eventsBySessionId[childSessionId] ?? []);
    pendingSessions.push(...(taskChildSessionIdsBySessionId[childSessionId] ?? []));
  }
  return events;
}

export function groupEventsByMessageId(events: LlmRouterUsageEvent[]): Map<string, LlmRouterUsageEvent[]> {
  const byMessageId = new Map<string, LlmRouterUsageEvent[]>();
  for (const event of events) {
    if (!event.message_id) continue;
    const bucket = byMessageId.get(event.message_id) ?? [];
    bucket.push(event);
    byMessageId.set(event.message_id, bucket);
  }
  return byMessageId;
}

function addEvent(bucket: TurnTokenBucket, event: LlmRouterUsageEvent): void {
  const input = event.prompt_tokens || 0;
  const output = event.completion_tokens || 0;
  bucket.input += input;
  bucket.output += output;

  const total = input + output || event.total_tokens || 0;

  // `event.source` is the backend's own authoritative record of how this
  // specific call was dispatched (`Source = Literal["cloud", "local",
  // "edge"]` in llmrouter_manager/common/usage.py), set once at the actual
  // routing decision — not a guess derived from provider/model name strings.
  // The router itself treats "local" and "edge" as one non-cloud bucket
  // (`proxy.py`: `if source_kind in ("local", "edge")`), so mirror that here
  // instead of re-deriving locality client-side.
  if (event.source === "local" || event.source === "edge") {
    bucket.local += total;
  } else {
    bucket.cloud += total;
  }
}

/**
 * Rolls up the LLM calls attributable to a single turn (user message →
 * direct replies → delegated `task` subagents/HDR runs → final assistant
 * reply) into one flat `{input, output, local, cloud}` total, keyed by the
 * turn's final assistant message id. `local`/`cloud` split each event's
 * tokens by the backend's own `event.source` field (authoritative — set at
 * dispatch time, not inferred from provider/model name strings), so a turn
 * that mixed local and cloud calls (e.g. an HDR run) reports its actual
 * local/cloud share instead of an aggregate that hides it.
 *
 * Attribution takes the union of: the bucket under the turn's user-message
 * id (where the request-header plugin stamps normal calls), the bucket under
 * every assistant-message id in the turn (where an HDR run stamps its own
 * calls), and every event from the turn's task-spawned child sessions. An
 * event carries a single `message_id`, so the message-id pass cannot
 * double-count; the `event_id` guard exists for the child-session pass,
 * where the same child session id may be reached more than once.
 *
 * Task-child events are followed through the known session relationship map.
 * Descendant sessions without a loaded transcript still contribute their own
 * events, but their undiscovered children cannot be attributed.
 */
export function computeTurnTokenTotals(params: {
  sessionId: string;
  messages: MessageWithParts[];
  eventsBySessionId: Record<string, LlmRouterUsageEvent[]>;
  taskChildSessionIds: Iterable<string>;
  taskChildSessionIdsBySessionId?: Record<string, string[]>;
}): Record<string, TurnTokenBucket> {
  const { sessionId, messages, eventsBySessionId } = params;
  const allowedChildSessionIds = new Set(params.taskChildSessionIds);
  const turns = buildTurns(messages, allowedChildSessionIds);

  const eventsByMessageId = groupEventsByMessageId(eventsBySessionId[sessionId] ?? []);

  const totals: Record<string, TurnTokenBucket> = {};

  for (const turn of turns) {
    const finalAssistantId = turn.assistantMessageIds[turn.assistantMessageIds.length - 1];
    if (!finalAssistantId) continue;

    const bucket: TurnTokenBucket = { input: 0, output: 0, local: 0, cloud: 0 };
    for (const event of collectTurnEvents(
      turn,
      eventsByMessageId,
      eventsBySessionId,
      params.taskChildSessionIdsBySessionId,
    )) {
      addEvent(bucket, event);
    }

    // local/cloud (not input/output) is the has-usage check: an event with only
    // `total_tokens` (no prompt/completion split) still lands in local or cloud.
    if (bucket.local === 0 && bucket.cloud === 0) continue;
    totals[finalAssistantId] = bucket;
  }

  return totals;
}

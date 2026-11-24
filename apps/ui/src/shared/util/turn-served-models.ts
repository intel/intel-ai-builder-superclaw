import type { LlmRouterUsageEvent } from "~/shared/platform/transport/llmrouter-client";
import type { ProviderListItem } from "~/shared/types/models";
import {
  SYNTHETIC_SESSION_CLASSIFIER_MESSAGE_PREFIX,
  SYNTHETIC_SESSION_COMPACT_MESSAGE_PREFIX,
  SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX,
  type MessageWithParts,
} from "~/shared/types/session";
import type { ModelBadgeDescriptor } from "./model-ref";
import { buildTurns, collectTurnEvents, groupEventsByMessageId } from "./turn-token-totals";

const SYNTHETIC_ASSISTANT_MESSAGE_PREFIXES = [
  SYNTHETIC_SESSION_CLASSIFIER_MESSAGE_PREFIX,
  SYNTHETIC_SESSION_COMPACT_MESSAGE_PREFIX,
  SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX,
];

function isSyntheticAssistantMessage(messageId: string): boolean {
  return SYNTHETIC_ASSISTANT_MESSAGE_PREFIXES.some((prefix) =>
    messageId.startsWith(prefix),
  );
}

function eventSide(event: LlmRouterUsageEvent): "local" | "cloud" | null {
  if (event.source === "local" || event.source === "edge") return "local";
  if (event.source === "cloud") return "cloud";
  return null;
}

// Catalog display name, else the raw id
export function servedModelName(event: LlmRouterUsageEvent, providers: ProviderListItem[]): string {
  const id = event.underlying_model.trim();
  const catalog = providers.find((p) => p.id === event.provider)?.models?.[id]?.name;
  return catalog?.trim() || id;
}

/**
 * Label for the models that served each turn, keyed by its final real
 * assistant message id. Synthetic compaction markers are not badge recipients.
 * A turn with no router records gets no entry.
 */
export function computeTurnServedModelLabels(params: {
  sessionId: string;
  messages: MessageWithParts[];
  eventsBySessionId: Record<string, LlmRouterUsageEvent[]>;
  taskChildSessionIds: Iterable<string>;
  taskChildSessionIdsBySessionId?: Record<string, string[]>;
  providers: ProviderListItem[];
}): Record<string, ModelBadgeDescriptor> {
  const { sessionId, messages, eventsBySessionId, providers } = params;
  const turns = buildTurns(messages, new Set(params.taskChildSessionIds));
  const eventsByMessageId = groupEventsByMessageId(eventsBySessionId[sessionId] ?? []);
  const labels: Record<string, ModelBadgeDescriptor> = {};

  for (const turn of turns) {
    const finalAssistantId = turn.assistantMessageIds
      .filter((id) => !isSyntheticAssistantMessage(id))
      .at(-1);
    if (!finalAssistantId) continue;

    const sides = new Set<"local" | "cloud">();
    const models = new Map<string, string>();
    let unnamed = false;
    for (const event of collectTurnEvents(
      turn,
      eventsByMessageId,
      eventsBySessionId,
      params.taskChildSessionIdsBySessionId,
    )) {
      const side = eventSide(event);
      if (!side) continue;
      sides.add(side);
      const name = servedModelName(event, providers);
      if (name) {
        const identity = JSON.stringify([event.provider, event.underlying_model.trim()]);
        models.set(identity, name);
      } else {
        unnamed = true;
      }
    }
    if (sides.size === 0) continue;

    if (sides.size > 1) {
      labels[finalAssistantId] = { kind: "source", source: "hybrid" };
    } else if (models.size === 1 && !unnamed) {
      labels[finalAssistantId] = {
        kind: "model",
        value: [...models.values()][0],
        source: sides.has("local") ? "local" : "cloud",
      };
    } else {
      labels[finalAssistantId] = {
        kind: "source",
        source: sides.has("local") ? "local" : "cloud",
      };
    }
  }

  return labels;
}

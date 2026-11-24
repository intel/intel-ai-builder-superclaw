import type { LlmRouterUsageEvent } from "./llmrouter-client";
import type { MessageWithParts } from "../types";
import type { ProviderListItem } from "~/shared/types/models";
import { servedModelName } from "~/shared/util/turn-served-models";

type Part = MessageWithParts["parts"][number];

export type ActivityModelSource = "local" | "cloud" | "hybrid";

export type ActivityModelExecution = {
  source: ActivityModelSource;
  modelLabel?: string;
  /** Provider/model identity is distinct from a potentially shared catalog name. */
  modelIdentity?: string;
};

export type ActivitySessionTranscript = {
  sessionId: string;
  messages: MessageWithParts[];
};

function stringField(part: Part, key: "id" | "callID"): string | null {
  const value = (part as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value : null;
}

/** The child session a `task` (sub-agent) tool part launched, if known. */
export function taskChildSessionId(part: Part): string | null {
  if (part.type !== "tool") return null;
  const toolPart = part as { tool?: unknown; state?: Record<string, unknown> };
  if (toolPart.tool !== "task") return null;
  const state = toolPart.state ?? {};
  const metadata =
    typeof state.metadata === "object" && state.metadata !== null
      ? (state.metadata as Record<string, unknown>)
      : {};
  const id = [metadata.sessionId, metadata.sessionID, state.sessionId, state.sessionID].find(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  return id ?? null;
}

/** One label for several model calls: Hybrid when local and cloud mix. */
export function combineExecutions(
  executions: ActivityModelExecution[],
): ActivityModelExecution | undefined {
  if (executions.length === 0) return undefined;
  const sources = new Set(executions.map((execution) => execution.source));
  const identities = new Set(
    executions.map((execution) => execution.modelIdentity ?? execution.modelLabel),
  );
  const source = sources.size === 1 ? executions[0].source : "hybrid";
  const sameModel = identities.size === 1;
  const label = sameModel ? executions[0].modelLabel : undefined;
  const modelIdentity = sameModel ? executions[0].modelIdentity : undefined;
  return label
    ? { source, modelLabel: label, ...(modelIdentity ? { modelIdentity } : {}) }
    : { source };
}

function normalizeSource(source: string): ActivityModelSource | null {
  if (source === "local" || source === "edge") return "local";
  if (source === "cloud") return "cloud";
  return null;
}


function toExecution(event: LlmRouterUsageEvent, providers: ProviderListItem[],): ActivityModelExecution | null {
  const source = normalizeSource(event.source);
  if (!source) return null;
  const label = servedModelName(event, providers);
  const modelIdentity = JSON.stringify([event.provider, event.underlying_model.trim()]);
  return label ? { source, modelLabel: label, modelIdentity } : { source, modelIdentity };
}

/**
 * Labels each tool step with the model call that emitted it. The router
 * records the ids of the tool calls each completion produced, and a tool part
 * keeps that same id as `callID`, so the match is exact. A step whose call is
 * not (yet) in the router's records gets no label rather than a guess.
 *
 * A sub-agent (`task`) step is labeled from the child session's own calls,
 * never from the parent call that launched it.
 */
export function computeActivityModelExecutions(params: {
  sessions: ActivitySessionTranscript[];
  eventsBySessionId: Record<string, LlmRouterUsageEvent[]>;
  providers: ProviderListItem[];
}): Record<string, ActivityModelExecution> {
  const executions: Record<string, ActivityModelExecution> = {};

  for (const session of params.sessions) {
    const eventByCallId = new Map<string, LlmRouterUsageEvent>();
    for (const event of params.eventsBySessionId[session.sessionId] ?? []) {
      if (event.session_id !== session.sessionId) continue;
      for (const callId of event.tool_call_ids ?? []) {
        if (!eventByCallId.has(callId)) eventByCallId.set(callId, event);
      }
    }

    for (const message of session.messages) {
      for (const part of message.parts ?? []) {
        if (part.type !== "tool") continue;
        const partId = stringField(part, "id");
        if (!partId) continue;
        const childId = taskChildSessionId(part);
        if (childId) {
          const childExecution = combineExecutions(
            (params.eventsBySessionId[childId] ?? [])
              .filter((event) => event.session_id === childId)
              .map((event) => toExecution(event, params.providers))
              .filter((execution): execution is ActivityModelExecution => execution !== null),
          );
          if (childExecution) executions[partId] = childExecution;
          continue;
        }
        const callId = stringField(part, "callID");
        if (!callId) continue;
        const event = eventByCallId.get(callId);
        const execution = event ? toExecution(event, params.providers) : null;
        if (execution) executions[partId] = execution;
      }
    }
  }
  return executions;
}